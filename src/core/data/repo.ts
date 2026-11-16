import { Clock } from '../clock';
import { lang, str } from '../lang';
import { platform } from '../platform';
import { Prefs } from '../prefs';
import { Bus } from './bus';
import { Catalog } from './catalog';
import { ChannelRecord, packChannels, unpackChannels, unpackProgramme } from './compact';
import { Db, prefixRange } from './db';
import { errorCode, Loaders, MapRecord, SourceMeta, SRC_ERROR, SRC_READY, WantedSet } from './loaders';
import { RawChannel } from './m3u';
import { Channel, epgUrlsOf, Playlist, Programme } from './models';
import { UserData } from './userdata';
import { Names } from './names';

/** Кусок программы: сутки канала */
interface Chunk { s: string; list: Programme[]; loading: boolean; used: number }

/** Прогресс загрузки программы для строки в гиде */
export interface EpgProgress { url: string; read: number; total: number; programmes: number }

/** Предел передач в памяти браузера (все куски вместе) */
const PROG_MAX = 40000;
const DAY = 86400;

/**
 * Данные для интерфейса: плейлисты, каталог, обновление, программа каналов.
 * Программа читается у сервиса асинхронно, по суткам: range(ch, from, to) отдаёт то, что уже
 * в кэше (пустой список — ещё нет), и запрашивает недостающее; по готовности — событие Bus 'epg'.
 */
export class Repo {
  private playlistsCache: Playlist[] = [];
  /** ключ канала → [источник, xml_id, иконка] по плейлистам; источники — по приоритету */
  private mapFor: { [pid: number]: { [key: string]: [string, string, string] } } = {};
  private mapLoading: { [pid: number]: boolean } = {};
  /** «pid:ключ|сутки» → кусок */
  private chunks: { [k: string]: Chunk } = {};
  private loadingOf: { [ck: string]: number } = {};
  private rev: { [ck: string]: number } = {};
  private tick = 0;
  /** оглавление суток канала (daysOf) */
  private dayIndex: { [ck: string]: number[][] } = {};
  private dayIndexLoading: { [ck: string]: boolean } = {};
  /** передач во всех кусках */
  private total = 0;
  private queued: { [url: string]: boolean } = {};
  private epgQueue: (() => Promise<void>)[] = [];
  private epgRunning = false;
  progress: EpgProgress | null = null;
  /** Каналы всех загруженных плейлистов (для сопоставления с источниками) */
  private channelsOf: { [pid: number]: RawChannel[] } = {};
  maxArchiveDays = 7;

  // ================================================================ плейлисты

  loadPlaylists(): Promise<Playlist[]> {
    const self = this;
    return Db.all<Playlist>('playlists').then(function (list) {
      list.sort(function (a, b) { return a.sort - b.sort || a.id - b.id; });
      self.playlistsCache = list;
      return list;
    });
  }

  playlists(): Playlist[] { return this.playlistsCache; }
  playlist(id: number): Playlist | null {
    for (let i = 0; i < this.playlistsCache.length; i++) if (this.playlistsCache[i].id === id) return this.playlistsCache[i];
    return null;
  }

  addPlaylist(name: string, url: string): Promise<Playlist> {
    let id = 1, sort = 0;
    for (let i = 0; i < this.playlistsCache.length; i++) {
      id = Math.max(id, this.playlistsCache[i].id + 1);
      sort = Math.max(sort, this.playlistsCache[i].sort + 1);
    }
    const p: Playlist = { id: id, name: name, url: url, epgMode: 0, userEpg: [], headerEpg: [], loadedAt: 0, channelsCount: 0, error: '', sort: sort };
    this.playlistsCache.push(p);
    return Db.put('playlists', p).then(function () { return p; });
  }

  savePlaylist(p: Playlist): Promise<void> {
    delete this.mapFor[p.id];
    return Db.put('playlists', p);
  }

  movePlaylist(id: number, dir: number): Promise<void> {
    const l = this.playlistsCache;
    const i = l.findIndex(function (p) { return p.id === id; });
    const j = i + dir;
    if (i < 0 || j < 0 || j >= l.length) return Promise.resolve();
    const t = l[i]; l[i] = l[j]; l[j] = t;
    for (let k = 0; k < l.length; k++) l[k].sort = k;
    return Db.putAll('playlists', l);
  }

  deletePlaylist(id: number): Promise<void> {
    this.playlistsCache = this.playlistsCache.filter(function (p) { return p.id !== id; });
    UserData.dropPlaylist(id);
    delete this.channelsOf[id];
    return Promise.all([Db.delete('playlists', id), Db.delete('channels', id), Db.deleteRange('map', prefixRange([id]))]).then(function () { /* */ });
  }

  /** Каналы плейлиста из базы → каталог */
  loadCatalog(p: Playlist): Promise<Catalog> {
    const self = this;
    return Db.get<ChannelRecord>('channels', p.id).then(function (rec) {
      const raw = unpackChannels(rec);
      self.channelsOf[p.id] = raw;
      return self.catalogOf(p, raw);
    });
  }

  catalogOf(p: Playlist, raw: RawChannel[]): Catalog {
    const def = Prefs.archiveDays;
    const list: Channel[] = [];
    let maxDays = 0;
    for (let i = 0; i < raw.length; i++) {
      const c = new Channel(i, p.id, raw[i], def);
      if (!c.group) { c.group = '—'; c.groupKey = '—'; }
      if (c.archiveDays > maxDays) maxDays = c.archiveDays;
      list.push(c);
    }
    this.maxArchiveDays = Math.max(this.maxArchiveDays, maxDays);
    delete this.mapFor[p.id];
    this.loadMapping(p.id);
    return new Catalog(p, list, function () { return str('favourites'); }, function () { return str('all_channels'); });
  }

  /** Устарел ли плейлист (перекачать при запуске) */
  isStale(p: Playlist): boolean { return p.channelsCount === 0 || Clock.now() - p.loadedAt > Prefs.playlistRefreshHours * 3600; }

  /**
   * Обновить плейлист, затем его программу. onPartial — каналы по ходу первой загрузки.
   * Результат — null (успех) или код ошибки.
   */
  refresh(p: Playlist, force: boolean, onPartial?: (raw: RawChannel[]) => void, onProgress?: (read: number, channels: number) => void): Promise<string | null> {
    const self = this;
    console.log('refresh playlist', p.id, force ? 'force' : '');
    return Loaders.loadPlaylist(p, force, onPartial ? function (l) { onPartial(l.slice()); } : undefined, onProgress).then(function (res) {
      if (res.notModified) {
        p.loadedAt = Clock.now();
        p.error = '';
        return Db.put('playlists', p);
      }
      p.headerEpg = Loaders.headerEpg(res.header);
      p.loadedAt = Clock.now();
      p.channelsCount = res.list.length;
      p.error = '';
      // Сжимаем и сохраняем. Если IndexedDB заполнена, Db переключится
      // на файловое хранилище Node-сервиса без удаления сохранённой EPG.
      const record = packChannels(p.id, res.list);
      return Db.put('channels', record).then(function () {
        self.channelsOf[p.id] = res.list;
        return Db.put('playlists', p);
      }).then(function () {
        // сопоставление с уже загруженными источниками — по новым каналам
        const urls = epgUrlsOf(p);
        return Promise.all(urls.map(function (u) { return rematch(u, self.wantedFor(u)); }));
      }).then(function () {
        delete self.mapFor[p.id];
        self.invalidateAll();
        Bus.emit('channels', p.id);
      });
    }).then(function () {
      self.refreshEpg(p, force);
      return null;
    }, function (e) {
      const code = errorCode(e);
      console.error('playlist failed', code, e);
      p.error = code;
      // Сохранение ошибки само может упасть из-за квоты: не оставляем
      // неперехваченный promise и не маскируем исходную проблему.
      return Db.put('playlists', p).then(function () { return code; }, function (writeErr) {
        console.warn('playlist error state not saved', writeErr);
        return code;
      });
    });
  }

  // ================================================================ программа: загрузка

  /** Источники плейлиста: устаревшие (или все при force) — в очередь загрузки */
  refreshEpg(p: Playlist, force: boolean) {
    const self = this;
    const urls = epgUrlsOf(p);
    const maxAge = Prefs.epgRefreshHours * 3600;
    urls.forEach(function (url) {
      if (self.queued[url]) return;
      self.queued[url] = true;
      Db.get<SourceMeta>('sources', url).then(function (m) {
        const fresh = m && m.status === SRC_READY && Clock.now() - m.loadedAt < maxAge;
        if (fresh && !force) { delete self.queued[url]; return; }
        self.epgQueue.push(function () {
          const onProgress = function (read: number, total: number, n: number) {
            self.progress = { url: url, read: read, total: total, programmes: n };
            Bus.emit('progress', self.progress);
          };
          const onPack = function () { self.invalidate(url, false); };
          // Своя загрузка платформы (webOS — в JS-сервисе) или разбор здесь, в браузере
          const wanted = self.wantedFor(url);
          const epg = platform().epg;
          const load = epg ? epg.load(url, wanted, self.maxArchiveDays, self.langs(), force, onProgress, onPack)
            : Loaders.loadEpg(url, wanted, self.maxArchiveDays, self.langs(), force, onProgress, onPack);
          return load.then(function () {
            delete self.queued[url];
            self.progress = null;
            self.invalidate(url, true);
            Bus.emit('progress', null);
          }, function (err) {
            delete self.queued[url];
            self.progress = null;
            Bus.emit('progress', null);
            throw err;
          });
        });
        self.runQueue();
      }, function (err) {
        delete self.queued[url];
        console.warn('EPG source metadata read', err);
      });
    });
  }

  private runQueue() {
    if (this.epgRunning) return;
    const job = this.epgQueue.shift();
    if (!job) return;
    this.epgRunning = true;
    const self = this;
    job().then(null, function (e) { console.warn('epg job', e); }).then(function () {
      self.epgRunning = false;
      self.runQueue();
    });
  }

  epgLoading(): boolean { return this.epgRunning || this.epgQueue.length > 0; }

  sources(): Promise<SourceMeta[]> { return Db.all<SourceMeta>('sources'); }

  private wantedFor(url: string): WantedSet[] {
    const out: WantedSet[] = [];
    for (let i = 0; i < this.playlistsCache.length; i++) {
      const p = this.playlistsCache[i];
      if (epgUrlsOf(p).indexOf(url) < 0) continue;
      const raw = this.channelsOf[p.id] || [];
      const seen: { [k: string]: true } = {};
      const chs = [];
      for (let j = 0; j < raw.length; j++) {
        const r = raw[j];
        const key = Names.key(r.name);
        if (seen[key]) continue;
        seen[key] = true;
        chs.push({ key: key, tvgId: r.tvgId, tvgName: r.tvgName, name: r.name });
      }
      out.push({ pid: p.id, channels: chs });
    }
    return out;
  }

  /** Каналы плейлиста для сопоставления подгрузить заранее (плейлисты, кроме открытого) */
  preloadChannels(): Promise<void> {
    const self = this;
    return Promise.all(this.playlistsCache.map(function (p) {
      if (self.channelsOf[p.id]) return Promise.resolve();
      return Db.get<ChannelRecord>('channels', p.id).then(function (r) { self.channelsOf[p.id] = unpackChannels(r); });
    })).then(function () { /* */ });
  }

  private langs(): string[] {
    const l = [lang(), 'ru', 'en'];
    return l.filter(function (x, i) { return l.indexOf(x) === i; });
  }

  // ================================================================ программа: чтение

  private loadMapping(pid: number) {
    if (this.mapLoading[pid]) return;
    const p = this.playlist(pid);
    if (!p) return;
    this.mapLoading[pid] = true;
    const self = this;
    const urls = epgUrlsOf(p);
    Promise.all(urls.map(function (u) { return Db.get<MapRecord>('map', [pid, u]); })).then(function (recs) {
      const out: { [key: string]: [string, string, string] } = {};
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (!r) continue;
        for (const k in r.m) if (!out[k]) out[k] = [r.s, r.m[k][0], r.m[k][1]];
      }
      self.mapFor[pid] = out;
      self.mapLoading[pid] = false;
      self.gen++;
      Bus.emit('epg', null);
    }, function () { self.mapLoading[pid] = false; });
  }

  private mapping(pid: number): { [key: string]: [string, string, string] } | null {
    const m = this.mapFor[pid];
    if (m) return m;
    this.loadMapping(pid);
    return null;
  }

  /** Иконка канала из программы */
  epgIcon(ch: Channel): string {
    if (ch.epgIcon) return ch.epgIcon;
    const m = this.mapping(ch.playlistId);
    const e = m ? m[ch.key] : null;
    if (e && e[2]) ch.epgIcon = e[2];
    return ch.epgIcon;
  }

  /** Есть ли у канала сопоставление с программой (null — ещё не известно) */
  hasEpg(ch: Channel): boolean | null {
    const m = this.mapping(ch.playlistId);
    return m ? !!m[ch.key] : null;
  }

  /**
   * Куски программы «канал + сутки» (сутки источника, UTC, по началу передачи). Канал целиком
   * в памяти не держим: в среднем 650 передач, бывает 13 тысяч — на старых ТВ узкое место браузер.
   * Недостающие сутки запрашиваются одним запросом на непрерывный отрезок; по готовности — 'epg'.
   */
  private chunk(ck: string, d: number): Chunk | undefined { return this.chunks[ck + '|' + d]; }

  private request(ch: Channel, e: [string, string, string], ck: string, a: number, b: number) {
    const shift = Math.round(ch.tvgShift * 3600);
    const self = this;
    const made: Chunk[] = [];
    for (let d = a; d <= b; d++) {
      const c: Chunk = { s: e[0], list: [], loading: true, used: ++this.tick };
      this.chunks[ck + '|' + d] = c;
      made.push(c);
    }
    this.loadingOf[ck] = (this.loadingOf[ck] || 0) + 1;
    fetchQueued(function () { return programmePacks(e[0], e[1], a, b); }).then(function (packs) {
      const all = merge(packs, shift);
      let n = 0;
      for (let i = 0; i < all.length; i++) {
        let d = Math.floor((all[i].start - shift) / DAY);
        // начавшаяся накануне и идущая в начале суток a (сервис кладёт её и в a) — в кусок a
        if (d < a && all[i].stop - shift > a * DAY) d = a;
        if (d < a || d > b) continue;
        made[d - a].list.push(all[i]);
        n++;
      }
      done(n);
    }, function (e) {
      if (e !== DROPPED) { done(0); return; }
      // выброшен из очереди (строку пролистали) — сутки не помечать пустыми: запросятся снова
      for (let d = a; d <= b; d++) if (self.chunks[ck + '|' + d] === made[d - a]) delete self.chunks[ck + '|' + d];
      self.loadingOf[ck]--;
    });
    function done(n: number) {
      for (let i = 0; i < made.length; i++) made[i].loading = false;
      self.loadingOf[ck]--;
      self.rev[ck] = (self.rev[ck] || 0) + 1;
      self.total += n;
      if (self.total > PROG_MAX) self.evict();
      Bus.emit('epg', ch.key);
    }
  }

  /** Выбросить давно не нужные куски, пока передач в памяти не станет 70% предела */
  private evict() {
    const keys: string[] = [];
    for (const k in this.chunks) if (!this.chunks[k].loading) keys.push(k);
    const self = this;
    keys.sort(function (x, y) { return self.chunks[x].used - self.chunks[y].used; });
    for (let i = 0; i < keys.length && this.total > PROG_MAX * 0.7; i++) {
      this.total -= this.chunks[keys[i]].list.length;
      delete this.chunks[keys[i]];
    }
  }

  /** Передачи канала, пересекающие [from, to), по возрастанию; недостающие сутки — запросить */
  range(ch: Channel, from: number, to: number): Programme[] {
    const m = this.mapping(ch.playlistId);
    const e = m ? m[ch.key] : null;
    if (!e) return [];
    if (e[2] && !ch.epgIcon) ch.epgIcon = e[2];
    const ck = ch.playlistId + ':' + ch.key;
    const shift = Math.round(ch.tvgShift * 3600);
    // передача, начавшаяся накануне и идущая в начале суток, лежит и в их куске (сервис) — накануне
    // не запрашиваем: одни сутки сервис отдаёт gzip-куском как есть
    const d0 = Math.floor((from - shift) / DAY), d1 = Math.floor((to - 1 - shift) / DAY);
    const out: Programme[] = [];
    let lastStart = -Infinity;
    let miss = -1;
    for (let d = d0; d <= d1 + 1; d++) {
      const c = d <= d1 ? this.chunk(ck, d) : undefined;
      if (!c && d <= d1) { if (miss < 0) miss = d; continue; }
      if (miss >= 0) { this.request(ch, e, ck, miss, d - 1); miss = -1; }
      if (!c) continue;
      c.used = ++this.tick;
      const list = c.list;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        // передача через полночь — в двух кусках подряд: вторую копию пропускаем
        if (p.stop > from && p.start < to && p.start > lastStart) { out.push(p); lastStart = p.start; }
      }
    }
    return out;
  }

  /**
   * Сутки источника с программой канала: [[сутки UTC, передач], …] — для вкладок дат (сами
   * сутки грузятся по мере листания). null — ещё не известно (запрос пошёл, придёт 'epg').
   */
  daysOf(ch: Channel): number[][] | null {
    const m = this.mapping(ch.playlistId);
    const e = m ? m[ch.key] : null;
    if (!e) return [];
    const ck = ch.playlistId + ':' + ch.key;
    const known = this.dayIndex[ck];
    if (known !== undefined) return known;
    if (this.dayIndexLoading[ck]) return null;
    this.dayIndexLoading[ck] = true;
    const self = this;
    const done = function (list: number[][] | null) {
      delete self.dayIndexLoading[ck];
      if (list) self.dayIndex[ck] = list;
      self.rev[ck] = (self.rev[ck] || 0) + 1;
      Bus.emit('epg', ch.key);
    };
    const epg = platform().epg;
    (epg ? epg.days(e[0], e[1]) : localDays(e[0], e[1])).then(done, function () { done(null); });
    return null;
  }

  /**
   * Выбросить куски канала вне [from, to) (закрыли расписание, ушли с канала в гиде): сутки
   * архива, догруженные при листании, больше не держат память.
   */
  release(ch: Channel, from: number, to: number) {
    const ck = ch.playlistId + ':' + ch.key;
    const shift = Math.round(ch.tvgShift * 3600);
    const d0 = Math.floor((from - shift) / DAY) - 1, d1 = Math.floor((to - 1 - shift) / DAY);
    const prefix = ck + '|';
    for (const k in this.chunks) {
      if (k.indexOf(prefix) !== 0) continue;
      const d = +k.slice(prefix.length);
      const c = this.chunks[k];
      if (c.loading || (d >= d0 && d <= d1)) continue;
      this.total -= c.list.length;
      delete this.chunks[k];
    }
  }

  /** Номер изменения программы канала (растёт, когда пришли его сутки) — перестроить списки */
  /**
   * Номер изменения программы канала (растёт, когда пришли его сутки, а также при сбросе программы и
   * загрузке сопоставления — gen): по нему гид перестраивает списки и кэш ячеек строк.
   */
  revOf(ch: Channel): number { return (this.rev[ch.playlistId + ':' + ch.key] || 0) + this.gen * 1000000; }
  private gen = 0;

  /** Программа читается (ещё не готова) */
  isLoading(ch: Channel): boolean {
    if (this.mapFor[ch.playlistId] === undefined) return true;
    return (this.loadingOf[ch.playlistId + ':' + ch.key] || 0) > 0;
  }

  /** Передача в момент t */
  at(ch: Channel, t: number): Programme | null {
    const list = this.range(ch, t, t + 1);
    return list.length ? list[list.length - 1] : null;
  }

  /** Первая передача, начинающаяся не раньше t (в пределах двух суток) */
  after(ch: Channel, t: number): Programme | null {
    const list = this.range(ch, t, t + 2 * DAY);
    for (let i = 0; i < list.length; i++) if (list[i].start >= t) return list[i];
    return null;
  }

  /** Передачи, начинающиеся не раньше t: до n штук (в пределах двух суток) */
  upcoming(ch: Channel, t: number, n: number): Programme[] {
    return this.range(ch, t, t + 2 * DAY).filter(function (p) { return p.start >= t; }).slice(0, n);
  }

  /** Передачи вокруг t (±1 сутки) — для Cells.at при перемещении по сетке */
  around(ch: Channel, t: number): Programme[] { return this.range(ch, t - DAY, t + DAY); }

  /**
   * Сброс кэша после пачки (done = false: только пустые куски — готовые не перечитываем
   * на каждую пачку) или после загрузки источника (done = true).
   */
  invalidate(url: string, done: boolean) {
    for (const k in this.chunks) {
      const c = this.chunks[k];
      if (c.loading) continue;
      if (c.s === url && (done || c.list.length === 0)) { this.total -= c.list.length; delete this.chunks[k]; }
    }
    // оглавление суток — перечитать (по каналу на запрос, только у открытых расписаний); пока
    // загрузка идёт — только пустые
    for (const k in this.dayIndex) if (done || !this.dayIndex[k].length) delete this.dayIndex[k];
    this.gen++;
    // сопоставление могло дополниться
    for (const pid in this.mapFor) {
      if (done || Object.keys(this.mapFor[pid]).length === 0) delete this.mapFor[pid];
    }
    Bus.emit('epg', null);
  }

  invalidateAll() {
    this.chunks = {};
    this.dayIndex = {};
    this.total = 0;
    this.gen++;
    this.mapFor = {};
    Bus.emit('epg', null);
  }

  // ================================================================ поиск

  /**
   * Передачи каналов по словам названия: идущие, будущие на неделю, прошедшие в пределах архива.
   * Ищет сервис (/progsearch) — браузер не читает программу всех каналов; без сервиса — по
   * каналу за раз из базы. Сравнение без учёта регистра.
   */
  searchProgrammes(channels: Channel[], words: string[], now: number, cancelled: () => boolean): Promise<{ channel: Channel; p: Programme }[]> {
    const out: { channel: Channel; p: Programme }[] = [];
    const self = this;
    const seen: { [k: string]: true } = {};
    const list: Channel[] = [];
    const items: any[] = [];
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      if (seen[ch.key]) continue;
      seen[ch.key] = true;
      const m = self.mapping(ch.playlistId);
      const e = m ? m[ch.key] : null;
      if (!e) continue;
      const shift = Math.round(ch.tvgShift * 3600);
      const from = now - (ch.hasArchive ? ch.archiveDays * DAY : 0) - shift, to = now + 7 * DAY - shift;
      items.push([e[0], e[1], Math.floor(from / DAY) - 1, Math.floor(to / DAY), list.length]);
      list.push(ch);
    }
    function add(ch: Channel, packs: any[]) {
      const progs = merge(packs, Math.round(ch.tvgShift * 3600));
      const from = now - ch.archiveDays * DAY, to = now + 7 * DAY;
      for (let k = 0; k < progs.length && out.length < 400; k++) {
        const p = progs[k];
        if (p.stop < from || p.start > to) continue;
        if (p.stop <= now && !ch.hasArchive) continue;
        const t = p.title.toLowerCase();
        let ok = true;
        for (let w = 0; w < words.length; w++) if (t.indexOf(words[w]) < 0) { ok = false; break; }
        if (ok) out.push({ channel: ch, p: p });
      }
    }
    function local(): Promise<{ channel: Channel; p: Programme }[]> {
      let i = 0;
      function next(): Promise<{ channel: Channel; p: Programme }[]> {
        if (cancelled() || i >= items.length || out.length >= 400) return Promise.resolve(out);
        const it = items[i++];
        return programmePacks(it[0], it[1], it[2], it[3]).then(function (packs) {
          add(list[it[4]], packs);
          return i % 20 === 0 ? new Promise<void>(function (r) { setTimeout(r, 0); }).then(next) : next();
        });
      }
      return next();
    }
    const epg = platform().epg;
    if (!epg || !items.length) return local();
    return epg.search(words, items, 2000, cancelled).then(function (hits) {
      if (cancelled()) return out;
      // [[i, {l, p}], …] — по каналам, в порядке списка
      const by: { [i: number]: any[] } = {};
      const order: number[] = [];
      for (let k = 0; k < hits.length; k++) {
        const i = hits[k][0];
        if (!by[i]) { by[i] = []; order.push(i); }
        by[i].push(hits[k][1]);
      }
      order.sort(function (x, y) { return x - y; });
      for (let k = 0; k < order.length && out.length < 400; k++) add(list[order[k]], by[order[k]]);
      return out;
    }, function (e) { console.warn('progsearch', e && e.message); return local(); });
  }
}

/**
 * Не больше 4 запросов программы одновременно; ждущие — новые первыми: при листании гида
 * с удержанием ↑/↓ сначала приходят строки, на которых остановились, а не пролистанные.
 */
const fetchWaiting: (() => void)[] = [];
let fetchActive = 0;
function fetchQueued<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>(function (resolve, reject) {
    const run: any = function () {
      fetchActive++;
      job().then(function (v) { fetchActive--; pump(); resolve(v); }, function (e) { fetchActive--; pump(); reject(e); });
    };
    run.drop = function () { reject(DROPPED); };
    fetchWaiting.push(run);
    trimQueue();
    pump();
  });
}
const DROPPED = new Error('dropped');
function pump() { while (fetchActive < 4 && fetchWaiting.length) fetchWaiting.pop()!(); }
/** Ждущих — не больше 12: при быстром листании гида старые запросы (пролистанные строки) выбрасываются */
const FETCH_WAIT_MAX = 12;
function trimQueue() {
  while (fetchWaiting.length > FETCH_WAIT_MAX) {
    const drop = fetchWaiting.shift()! as any;
    if (drop.drop) drop.drop();
  }
}

/**
 * Пачки программы канала за сутки a…b (UTC источника): у сервиса — HTTP /prog (одни сутки —
 * gzip-поток с Content-Encoding: gzip, браузер ТВ распаковывает сам); не вышло — из базы
 * (WebSocket / IndexedDB) весь канал и отбор по суткам здесь.
 */
function programmePacks(s: string, x: string, a: number, b: number): Promise<any[]> {
  const fallback = function () {
    return Db.all<any>('prog', prefixRange([s, x])).then(function (packs) {
      const out: any[] = [];
      for (let i = 0; i < packs.length; i++) {
        const p = unpackProgramme(packs[i]).filter(function (r: any[]) { const d = Math.floor(r[0] / DAY); return d >= a && d <= b; });
        if (p.length) out.push({ s: packs[i].s, x: packs[i].x, l: packs[i].l, n: packs[i].n, p: p });
      }
      return out;
    });
  };
  const epg = platform().epg;
  if (!epg) return fallback();
  return epg.packs(s, x, a, b).then(null, function (e) { console.warn('prog', e && e.message); return fallback(); });
}

/** Оглавление суток канала по базе (у платформы нет своего): [[сутки UTC, передач], …] */
function localDays(s: string, x: string): Promise<number[][]> {
  return Db.all<any>('prog', prefixRange([s, x])).then(function (packs) {
    const by: { [d: number]: number } = {};
    for (let i = 0; i < packs.length; i++) {
      const p = unpackProgramme(packs[i]);
      for (let j = 0; j < p.length; j++) { const d = Math.floor(p[j][0] / DAY); by[d] = (by[d] || 0) + 1; }
    }
    return Object.keys(by).map(function (d) { return [+d, by[+d]]; }).sort(function (a, b) { return a[0] - b[0]; });
  });
}

/** Сопоставление каналов с уже загруженным источником: у платформы, не вышло — здесь, по базе */
function rematch(url: string, wanted: WantedSet[]): Promise<void> {
  const epg = platform().epg;
  if (!epg) return Loaders.rematch(url, wanted);
  return epg.rematch(url, wanted).then(null, function () { return Loaders.rematch(url, wanted); });
}

/**
 * Пачки → список передач: дубли по началу — из более новой загрузки, по возрастанию,
 * перекрытия обрезаются по началу следующей.
 */
export function merge(packs: any[], shift: number): Programme[] {
  packs.sort(function (a, b) { return b.l - a.l || a.n - b.n; });
  const byStart: { [t: number]: true } = {};
  const all: any[] = [];
  const newest = packs.length ? packs[0].l : 0;
  // если новая загрузка уже покрыла канал — старые пачки только дополняют дырами вне её диапазона
  let nLo = Infinity, nHi = -Infinity;
  for (let i = 0; i < packs.length; i++) {
    const pk = packs[i];
    const p = unpackProgramme(pk);
    for (let j = 0; j < p.length; j++) {
      const r = p[j];
      if (pk.l === newest) { if (r[0] < nLo) nLo = r[0]; if (r[1] > nHi) nHi = r[1]; }
      else if (r[0] >= nLo && r[0] < nHi) continue;
      if (byStart[r[0]]) continue;
      byStart[r[0]] = true;
      all.push(r);
    }
  }
  all.sort(function (a, b) { return a[0] - b[0]; });
  const list: Programme[] = [];
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    const p: Programme = { start: r[0] + shift, stop: r[1] + shift, title: r[2] || '', subTitle: r[3] || '', desc: r[4] || '', category: r[5] || '', icon: r[6] || '' };
    const prev = list.length ? list[list.length - 1] : null;
    if (prev && prev.stop > p.start) prev.stop = p.start;
    if (p.stop > p.start) list.push(p);
  }
  if (list.length && list[list.length - 1].stop <= list[list.length - 1].start) list.pop();
  return list;
}

export { SRC_ERROR, SRC_READY };
