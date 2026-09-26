import { Clock } from '../core/clock';
import { Net, NetError } from '../core/net';
import { Db, prefixRange } from './db';
import { M3uParser, RawChannel, epgUrls } from './m3u';
import { EpgMatcher } from './matcher';
import { Playlist } from './models';
import { Unpacker } from './streams';
import { EpgChannelRaw, EpgProgramme, XmltvParser } from './xmltv';

/** Уступить интерфейсу между кусками */
function yieldUi: Promise<void> { return new Promise(function (r) { setTimeout(r, 0); }); }

export interface SourceMeta {
  url: string;
  loadedAt: number;
  loadId: number;
  etag: string;
  lastModified: string;
  error: string;
  count: number;
  /** 0 — не загружался, 1 — загружается, 2 — готов, 3 — ошибка */
  status: number;
}
export const SRC_NONE = 0, SRC_LOADING = 1, SRC_READY = 2, SRC_ERROR = 3;

/** Канал плейлиста для сопоставления с EPG */
export interface Wanted { key: string; tvgId: string; tvgName: string; name: string }
export interface WantedSet { pid: number; channels: Wanted[] }

/** Запись сопоставления: ключ канала → [xml_id, иконка] */
export interface MapRecord { pid: number; s: string; m: { [key: string]: [string, string] } }

export function errorCode(e: any): string {
  if (e instanceof NetError) return e.code;
  if (e && e.message === 'format_xz') return 'format';
  return 'network';
}

export const Loaders = {
  /**
   * Плейлист потоком: каналы копятся в памяти (onPartial — каждые 500 для первой загрузки),
   * по окончании — одна запись в IndexedDB. Ошибки — код (no_url, network, http_404, format, empty, need_service).
   */
  loadPlaylist(p: Playlist, force: boolean, onPartial?: (list: RawChannel[], header: { [k: string]: string }) => void, onProgress?: (read: number, channels: number) => void): Promise<{ list: RawChannel[]; header: { [k: string]: string }; notModified: boolean }> {
    if (!p.url) return Promise.reject(new NetError('no_url'));
    const list: RawChannel[] = [];
    const parser = new M3uParser(function (c) {
      list.push(c);
      if (onPartial && list.length % 500 === 0) onPartial(list, parser.header);
    }, '');
    const dec = new TextDecoder('utf-8');
    const unp = new Unpacker(function (b) { parser.push(dec.decode(b, { stream: true })); });
    let etag = '', lm = '';
    return Net.stream(p.url, {
      etag: force? undefined: p.etag || undefined,
      lastModified: force? undefined: p.lastModified || undefined,
      onResponse: function (r) { etag = r.header('ETag'); lm = r.header('Last-Modified'); console.log('playlist', r.status, r.proxied? 'proxy': 'direct'); },
      onProgress: function (read) { if (onProgress) onProgress(read, list.length); },
    }, function (chunk) {
      unp.push(chunk);
      if (parser.rejected) throw new NetError('format');
      return list.length % 2000 < 50? yieldUi: undefined;
    }).then(function (r) {
      if (r.status === 304) return { list: [], header: {}, notModified: true };
      unp.end;
      parser.push(dec.decode);
      parser.end;
      if (!parser.isM3u) throw new NetError('format');
      if (!list.length) throw new NetError('empty');
      console.log('playlist parsed', list.length, 'channels');
      p.etag = etag;
      p.lastModified = lm;
      return { list: list, header: parser.header, notModified: false };
    });
  },

  /** Заголовок → источники программы плейлиста */
  headerEpg(header: { [k: string]: string }): string[] { return epgUrls(header); },

  /**
   * Программа одного источника (§5) для всех плейлистов, где он указан.
   * Пачки по каналу пишутся в IndexedDB по ходу разбора; после успеха старые пачки удаляются.
   */
  loadEpg(url: string, wanted: WantedSet[], maxArchiveDays: number, langs: string[], force: boolean,
    onProgress: (read: number, total: number, programmes: number) => void, onPack:  => void): Promise<SourceMeta> {
    let meta: SourceMeta;
    const now = Clock.now;
    const lo = now - (maxArchiveDays + 1) * 86400;
    const hi = now + 8 * 86400;
    const loadId = Date.now;
    const matcher = new EpgMatcher;
    const icons: { [id: string]: string } = {};
    const epgChannels: any[] = [];
    let want: { [id: string]: true } = {};
    let maps: MapRecord[] = [];
    let packs: any[] = [];
    let pending = 0;
    const seq: { [x: string]: number } = {};
    let curX = '';
    let cur: any[] = [];
    let total = 0;
    let read = 0, size = 0;

    function flushCur {
      if (!cur.length) return;
      const n = seq[curX] || 0;
      seq[curX] = n + 1;
      packs.push({ s: url, x: curX, l: loadId, n: n, p: cur });
      pending += cur.length;
      cur = [];
    }

    function rebuildWanted {
      want = {};
      maps = [];
      for (let i = 0; i < wanted.length; i++) {
        const m: { [key: string]: [string, string] } = {};
        const chs = wanted[i].channels;
        for (let j = 0; j < chs.length; j++) {
          const c = chs[j];
          const x = matcher.match(c.tvgId, c.tvgName, c.name);
          if (x!== null) { m[c.key] = [x, icons[x] || '']; want[x] = true; }
        }
        maps.push({ pid: wanted[i].pid, s: url, m: m });
      }
    }

    const parser = new XmltvParser(langs,
      function (c: EpgChannelRaw) {
        matcher.addChannel(c);
        if (c.icon) icons[c.id] = c.icon;
        epgChannels.push({ s: url, id: c.id, names: c.names, icon: c.icon });
      },
      rebuildWanted,
      function (id) { return want[id] === true; },
      function (pr: EpgProgramme) {
        if (pr.stop < lo || pr.start > hi) return;
        if (pr.channel!== curX) { flushCur; curX = pr.channel; }
        cur.push([pr.start, pr.stop, pr.title, pr.subTitle, pr.desc, pr.category, pr.icon]);
        total++;
        if (cur.length >= 2000) flushCur;
      });
    const unp = new Unpacker(function (b) { parser.push(b); });

    function writePending(final: boolean): Promise<void> {
      if (final) flushCur;
      const tasks: Promise<void>[] = [];
      if (epgChannels.length) { tasks.push(Db.putAll('epgch', epgChannels.splice(0, epgChannels.length))); }
      if (packs.length && (final || pending >= 3000)) {
        tasks.push(Db.putAll('prog', packs));
        packs = [];
        pending = 0;
        tasks.push(Promise.all(maps.map(function (m) { return Db.put('map', m); })).then(function  { /* */ }));
      }
      if (!tasks.length) return yieldUi;
      return Promise.all(tasks).then(function  { onPack; return yieldUi; });
    }

    console.log('epg start', url);
    return Db.get<SourceMeta>('sources', url).then(function (old) {
      meta = old || { url: url, loadedAt: 0, loadId: 0, etag: '', lastModified: '', error: '', count: 0, status: SRC_NONE };
      meta.status = SRC_LOADING;
      let etag = '', lm = '';
      return Net.stream(url, {
        etag: force ||!meta.etag || meta.status === SRC_ERROR? undefined: meta.etag,
        lastModified: force ||!meta.lastModified? undefined: meta.lastModified,
        onResponse: function (r) { etag = r.header('ETag'); lm = r.header('Last-Modified'); },
        onProgress: function (r, t) { read = r; size = t; },
      }, function (chunk) {
        unp.push(chunk);
        onProgress(read, size, total);
        return writePending(false);
      }).then(function (r) {
        if (r.status === 304) {
          meta.loadedAt = Clock.now;
          meta.status = SRC_READY;
          meta.error = '';
          return Db.put('sources', meta).then(function  { return Loaders.rematch(url, wanted); }).then(function  { return meta; });
        }
        unp.end;
        parser.end;
        if (!maps.length) rebuildWanted;
        return writePending(true).then(function  {
          // старые загрузки источника и всё, что вне окна хранения
          return Db.deleteWhere('prog', prefixRange([url]), function (v) { return v.l!== loadId; });
        }).then(function  {
          return Promise.all(maps.map(function (m) { return Db.put('map', m); }));
        }).then(function  {
          meta.loadedAt = Clock.now;
          meta.loadId = loadId;
          meta.etag = etag;
          meta.lastModified = lm;
          meta.error = '';
          meta.count = total;
          meta.status = SRC_READY;
          console.log('epg done', url, total, 'programmes', parser.channels, 'channels');
          return Db.put('sources', meta);
        }).then(function  { return meta; });
      });
    }).then(null, function (e) {
      const code = errorCode(e);
      console.warn('EPG', url, code, e);
      if (!meta) meta = { url: url, loadedAt: 0, loadId: 0, etag: '', lastModified: '', error: code, count: 0, status: SRC_ERROR };
      meta.error = code;
      meta.status = SRC_ERROR;
      // данные этой загрузки остаются (часть программы лучше, чем ничего), старые не удаляются
      return Db.put('sources', meta).then(function  { return meta; });
    });
  },

  /** Пересопоставить каналы плейлистов с уже загруженным источником (плейлист перезагружен, 304) */
  rematch(url: string, wanted: WantedSet[]): Promise<void> {
    return Db.all<any>('epgch', prefixRange([url])).then(function (list) {
      if (!list.length) return;
      const matcher = new EpgMatcher;
      const icons: { [id: string]: string } = {};
      for (let i = 0; i < list.length; i++) {
        matcher.addChannel({ id: list[i].id, names: list[i].names, icon: list[i].icon });
        if (list[i].icon) icons[list[i].id] = list[i].icon;
      }
      const recs: MapRecord[] = [];
      for (let i = 0; i < wanted.length; i++) {
        const m: { [key: string]: [string, string] } = {};
        const chs = wanted[i].channels;
        for (let j = 0; j < chs.length; j++) {
          const c = chs[j];
          const x = matcher.match(c.tvgId, c.tvgName, c.name);
          if (x!== null) m[c.key] = [x, icons[x] || ''];
        }
        recs.push({ pid: wanted[i].pid, s: url, m: m });
      }
      return Db.putAll('map', recs);
    });
  },
};
