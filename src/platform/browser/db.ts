import { KeyRange, RecordDb, recordKey } from '../../core/data/db';
import { IdbDb } from '../../core/data/idb';
import { Playlist } from '../../core/data/models';

/**
 * IndexedDB для browser/VIDAA/Titan, но плейлисты дополнительно — в localStorage.
 * На VIDAA 4 IndexedDB не переживает обесточивание ТВ, а localStorage — да; плейлисты
 * маленькие (id, имя, адрес, источники EPG), каналы и программа при потере скачаются заново.
 */
const MIRROR = 'ptvdb:playlists';

function readMirror(): Playlist[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const text = localStorage.getItem(MIRROR);
    if (!text) return [];
    const list = JSON.parse(text);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('playlist mirror read failed', e);
    return [];
  }
}

function writeMirror(list: Playlist[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(MIRROR, JSON.stringify(list));
  } catch (e) {
    console.warn('playlist mirror save failed', e);
  }
}

function clearMirror(): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(MIRROR); } catch (e) { /* */ }
}

function sameId(a: any, b: any): boolean { return String(a) === String(b); }

/** Запись плейлиста в зеркало (остальные значения не трогаем) */
function mirrorPut(p: Playlist): void {
  const list = readMirror();
  const id = recordKey('playlists', p);
  let replaced = false;
  for (let i = 0; i < list.length; i++) {
    if (sameId(list[i].id, id)) { list[i] = p; replaced = true; break; }
  }
  if (!replaced) list.push(p);
  writeMirror(list);
}

function mirrorRemove(id: any): void {
  writeMirror(readMirror().filter(function (p) { return !sameId(p.id, id); }));
}

function isPlaylists(store: string): boolean { return store === 'playlists'; }

export const BrowserDb: RecordDb = {
  get<T>(store: string, key: any): Promise<T | undefined> {
    if (!isPlaylists(store)) return IdbDb.get<T>(store, key);
    return IdbDb.get<T>('playlists', key).then(function (v) {
      if (v !== undefined) return v;
      const mirror = readMirror();
      for (let i = 0; i < mirror.length; i++) if (sameId(mirror[i].id, key)) return mirror[i] as any;
      return undefined;
    }, function () {
      const mirror = readMirror();
      for (let i = 0; i < mirror.length; i++) if (sameId(mirror[i].id, key)) return mirror[i] as any;
      return undefined;
    });
  },

  put(store: string, value: any): Promise<void> {
    if (!isPlaylists(store)) return IdbDb.put(store, value);
    return IdbDb.put('playlists', value).then(function () {
      mirrorPut(value);
    }, function (e) {
      // VIDAA: IndexedDB может не пережить обесточивание; плейлист всё равно сохраняем
      console.warn('indexedDB playlists write failed, mirror only', e);
      mirrorPut(value);
    });
  },

  putAll(store: string, values: any[]): Promise<void> {
    if (!isPlaylists(store)) return IdbDb.putAll(store, values);
    return IdbDb.putAll('playlists', values).then(function () {
      writeMirror(values);
    }, function (e) {
      console.warn('indexedDB playlists write failed, mirror only', e);
      writeMirror(values);
    });
  },

  delete(store: string, key: any): Promise<void> {
    if (!isPlaylists(store)) return IdbDb.delete(store, key);
    mirrorRemove(key);
    return IdbDb.delete('playlists', key).then(null, function (e) {
      console.warn('indexedDB playlists delete failed, mirror removed', e);
    });
  },

  all<T>(store: string, range?: KeyRange): Promise<T[]> {
    if (!isPlaylists(store)) return IdbDb.all<T>(store, range);
    return IdbDb.all<Playlist>('playlists').then(function (list) {
      if (list.length) {
        writeMirror(list);
        return list as any;
      }
      const mirror = readMirror();
      if (!mirror.length) return list as any;
      console.log('playlists restored from localStorage', mirror.length);
      return IdbDb.putAll('playlists', mirror).then(function () {
        return mirror as any;
      }, function (e) {
        console.warn('indexedDB playlists restore failed, use mirror', e);
        return mirror as any;
      });
    }, function (e) {
      const mirror = readMirror();
      if (!mirror.length) throw e;
      console.warn('indexedDB playlists unavailable, use mirror', e);
      return mirror as any;
    });
  },

  deleteWhere(store: string, range: KeyRange | null, filter: (v: any) => boolean): Promise<number> {
    if (!isPlaylists(store)) return IdbDb.deleteWhere(store, range, filter);
    return IdbDb.deleteWhere('playlists', range || null, filter).then(function (n) {
      writeMirror(readMirror().filter(function (p) { return !filter(p); }));
      return n;
    }, function (e) {
      const before = readMirror();
      writeMirror(before.filter(function (p) { return !filter(p); }));
      throw e;
    });
  },

  deleteRange(store: string, range: KeyRange): Promise<void> {
    if (!isPlaylists(store)) return IdbDb.deleteRange(store, range);
    return IdbDb.deleteRange('playlists', range).then(function () {
      clearMirror();
    }, function (e) {
      clearMirror();
      throw e;
    });
  },

  drop(): Promise<void> {
    clearMirror();
    return IdbDb.drop();
  },
};
