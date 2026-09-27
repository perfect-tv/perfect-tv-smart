import { Clock } from '../core/clock';
import { lang, str } from '../core/lang';
import { Prefs } from '../core/prefs';
import { Bus } from './bus';
import { Catalog } from './catalog';
import { Db, prefixRange } from './db';
import { EpgWorker } from './epgworker';
import { errorCode, Loaders, MapRecord, SourceMeta, SRC_ERROR, SRC_READY, WantedSet } from './loaders';
import { RawChannel } from './m3u';
import { Channel, epgUrlsOf, Playlist, Programme } from './models';
import { UserData } from './userdata';
import { Names } from './names';

interface CachedEpg { s: string; list: Programme[]; loading: boolean }

/** Прогресс загрузки программы для строки в гиде */
export interface EpgProgress { url: string; read: number; total: number; programmes: number }

const CACHE_MAX = 300;

/**
 * Данные для интерфейса: плейлисты, каталог, обновление, программа каналов.
 * Программа читается из IndexedDB асинхронно: programmes(ch) отдаёт то, что уже в кэше
 * (пустой список — ещё нет), и запрашивает недостающее; по готовности — событие Bus 'epg'.
 */
export class Repo {
  private playlistsCache: Playlist[] = [];
  /** ключ канала → [источник, xml_id, иконка] по плейлистам; источники — по приоритету */
  private mapFor: { [pid: number]: { [key: string]: [string, string, string] } } = {};
  private mapLoading: { [pid: number]: boolean } = {};
  private cache: { [ck: string]: CachedEpg } = {};
  private cacheOrder: string[] = [];
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
    return Db.get<{ pid: number; list: RawChannel[] }>('channels', p.id).then(function (rec) {
      const raw = rec ? rec.list : [];
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
      self.channelsOf[p.id] = res.list;
      return Db.put('channels', { pid: p.id, list: res.list }).then(function () { return Db.put('playlists', p); }).then(function () {
        // сопоставление с уже загруженными источниками — по новым каналам
        const urls = epgUrlsOf(p);
        return Promise.all(urls.map(function (u) { return Loaders.rematch(u, self.wantedFor(u)); }));
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
      Db.put('playlists', p);
      return code;
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
          // в воркере (основной поток свободен для гида и плеера); нельзя — здесь же
          return EpgWorker.available().then(function (ok) {
            if (ok) return EpgWorker.load(url, self.wantedFor(url), self.maxArchiveDays, self.langs(), force, onProgress, onPack);
            return Loaders.loadEpg(url, self.wantedFor(url), self.maxArchiveDays, self.langs(), force, onProgress, onPack);
          }).then(function () {
            delete self.queued[url];
            self.progress = null;
            self.invalidate(url, true);
            Bus.emit('progress', null);
          });
        });
        self.runQueue();
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
      return Db.get<{ pid: number; list: RawChannel[] }>('channels', p.id).then(function (r) { self.channelsOf[p.id] = r ? r.list : []; });
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

  private touch(ck: string) {
    const i = this.cacheOrder.indexOf(ck);
    if (i >= 0) this.cacheOrder.splice(i, 1);
    this.cacheOrder.push(ck);
    while (this.cacheOrder.length > CACHE_MAX) delete this.cache[this.cacheOrder.shift()!];
  }

  /**
   * Программа канала по возрастанию, без перекрытий, со сдвигом tvg-shift. Пустой список —
   * программы нет или ещё не прочитана (тогда чтение запущено и придёт событие 'epg').
   */
  programmes(ch: Channel): Programme[] {
    const ck = ch.playlistId + ':' + ch.key;
    const c = this.cache[ck];
    if (c) return c.list;
    const m = this.mapping(ch.playlistId);
    if (!m) return [];
    const e = m[ch.key];
    if (!e) { this.cache[ck] = { s: '', list: [], loading: false }; this.touch(ck); return []; }
    if (e[2] && !ch.epgIcon) ch.epgIcon = e[2];
    const entry: CachedEpg = { s: e[0], list: [], loading: true };
    this.cache[ck] = entry;
    this.touch(ck);
    const shift = Math.round(ch.tvgShift * 3600);
    const self = this;
    Db.all<any>('prog', prefixRange([e[0], e[1]])).then(function (packs) {
      entry.list = merge(packs, shift);
      entry.loading = false;
      if (self.cache[ck] === entry) Bus.emit('epg', ch.key);
    }, function () { entry.loading = false; });
    return entry.list;
  }

  /** Программа читается (ещё не готова) */
  isLoading(ch: Channel): boolean {
    const c = this.cache[ch.playlistId + ':' + ch.key];
    return c ? c.loading : this.mapFor[ch.playlistId] === undefined;
  }

  /** Передача в момент t */
  at(ch: Channel, t: number): Programme | null {
    const list = this.programmes(ch);
    let lo = 0, hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = list[mid];
      if (t < p.start) hi = mid - 1;
      else if (t >= p.stop) lo = mid + 1;
      else return p;
    }
    return null;
  }

  /** Первая передача, начинающаяся не раньше t */
  after(ch: Channel, t: number): Programme | null {
    const list = this.programmes(ch);
    for (let i = 0; i < list.length; i++) if (list[i].start >= t) return list[i];
    return null;
  }

  /** Передачи, пересекающие [from, to) */
  range(ch: Channel, from: number, to: number): Programme[] {
    return this.programmes(ch).filter(function (p) { return p.stop > from && p.start < to; });
  }

  /**
   * Сброс кэша после пачки (done = false: только пустые записи — готовые списки не перечитываем
   * на каждую пачку) или после загрузки источника (done = true).
   */
  invalidate(url: string, done: boolean) {
    for (const ck in this.cache) {
      const c = this.cache[ck];
      if (c.loading) continue;
      if ((c.s === url || c.s === '') && (done || c.list.length === 0)) {
        delete this.cache[ck];
        const i = this.cacheOrder.indexOf(ck);
        if (i >= 0) this.cacheOrder.splice(i, 1);
      }
    }
    // сопоставление могло дополниться
    for (const pid in this.mapFor) {
      if (done || Object.keys(this.mapFor[pid]).length === 0) delete this.mapFor[pid];
    }
    Bus.emit('epg', null);
  }

  invalidateAll() {
    this.cache = {};
    this.cacheOrder = [];
    this.mapFor = {};
    Bus.emit('epg', null);
  }

  // ================================================================ поиск

  /**
   * Передачи каналов по словам названия: идущие, будущие на неделю, прошедшие в пределах архива.
   * Читает пачки каналов по одному, сравнение без учёта регистра.
   */
  searchProgrammes(channels: Channel[], words: string[], now: number, cancelled: () => boolean): Promise<{ channel: Channel; p: Programme }[]> {
    const out: { channel: Channel; p: Programme }[] = [];
    const self = this;
    let i = 0;
    const seen: { [k: string]: true } = {};
    function next(): Promise<{ channel: Channel; p: Programme }[]> {
      if (cancelled() || i >= channels.length || out.length >= 400) return Promise.resolve(out);
      const ch = channels[i++];
      if (seen[ch.key]) return next();
      seen[ch.key] = true;
      const m = self.mapping(ch.playlistId);
      const e = m ? m[ch.key] : null;
      if (!e) return next();
      const ck = ch.playlistId + ':' + ch.key;
      const cached = self.cache[ck];
      const get = cached && !cached.loading ? Promise.resolve(cached.list) : Db.all<any>('prog', prefixRange([e[0], e[1]])).then(function (packs) { return merge(packs, Math.round(ch.tvgShift * 3600)); });
      return get.then(function (list) {
        const from = now - ch.archiveDays * 86400;
        const to = now + 7 * 86400;
        for (let k = 0; k < list.length; k++) {
          const p = list[k];
          if (p.stop < from || p.start > to) continue;
          if (p.stop <= now && !ch.hasArchive) continue;
          const t = p.title.toLowerCase();
          let ok = true;
          for (let w = 0; w < words.length; w++) if (t.indexOf(words[w]) < 0) { ok = false; break; }
          if (ok) out.push({ channel: ch, p: p });
        }
        return i % 20 === 0 ? new Promise<void>(function (r) { setTimeout(r, 0); }).then(next) : next();
      });
    }
    return next();
  }
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
    const p = pk.p as any[];
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
