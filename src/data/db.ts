import { FileDb, asRange } from './filedb';
import { SocketDb } from './socketdb';
/**
 * IndexedDB (§2 «Хранение»):
 *   playlists  id                    Playlist (без каналов)
 *   channels   pid                   {pid, list: RawChannel[]}
 *   sources    url                   источник EPG: loadedAt, loadId, etag, lastModified, error, count
 *   epgch      [s, id]               канал XMLTV: names, icon
 *   prog       [s, x, l, n]          пачка передач канала x источника s загрузки l: p = [[start, stop, title, sub, desc, cat, icon]]
 *   map        [pid, s]              сопоставление каналов плейлиста с источником: m = {ключ канала: xml_id}
 * Только API, которое есть в Chromium 38 (без getAll, курсоры).
 */
const NAME = 'perfecttv';
const VERSION = 1;

let dbp: Promise<IDBDatabase> | null = null;

function idb: IDBFactory {
  const g: any = typeof indexedDB!== 'undefined'? indexedDB: (typeof window!== 'undefined'? (window as any).webkitIndexedDB: null);
  if (!g) throw new Error('no indexedDB');
  return g;
}

export function open: Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise(function (resolve, reject) {
    const req = idb.open(NAME, VERSION);
    req.onupgradeneeded = function  {
      const db = req.result;
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('channels')) db.createObjectStore('channels', { keyPath: 'pid' });
      if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('epgch')) db.createObjectStore('epgch', { keyPath: ['s', 'id'] });
      if (!db.objectStoreNames.contains('prog')) db.createObjectStore('prog', { keyPath: ['s', 'x', 'l', 'n'] });
      if (!db.objectStoreNames.contains('map')) db.createObjectStore('map', { keyPath: ['pid', 's'] });
    };
    req.onsuccess = function  { resolve(req.result); };
    req.onerror = function  { console.error('indexedDB open', req.error); reject(req.error); };
    (req as any).onblocked = function  { console.warn('indexedDB blocked'); };
    setTimeout(function  { reject(new Error('indexedDB open timeout')); }, 15000);
  });
  return dbp;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise(function (resolve, reject) {
    tx.oncomplete = function  { resolve; };
    tx.onerror = function  { reject(tx.error); };
    tx.onabort = function  { reject(tx.error || new Error('abort')); };
  });
}

function reqP<T>(r: IDBRequest): Promise<T> {
  return new Promise(function (resolve, reject) {
    r.onsuccess = function  { resolve(r.result as T); };
    r.onerror = function  { reject(r.error); };
  });
}

/** Верхняя граница диапазона по префиксу ключа-массива: [a, b, []] больше любых [a, b, …] */
export function prefixRange(prefix: any[]): IDBKeyRange {
  return IDBKeyRange.bound(prefix, prefix.concat([[]]));
}

const NativeDb = {
  get<T>(store: string, key: any): Promise<T | undefined> {
    return open.then(function (db) {
      return reqP<T>(db.transaction(store, 'readonly').objectStore(store).get(key));
    });
  },

  put(store: string, value: any): Promise<void> {
    return open.then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      return done(tx);
    });
  },

  /** Несколько записей в одной транзакции */
  putAll(store: string, values: any[]): Promise<void> {
    if (!values.length) return Promise.resolve;
    return open.then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      for (let i = 0; i < values.length; i++) s.put(values[i]);
      return done(tx);
    });
  },

  delete(store: string, key: any): Promise<void> {
    return open.then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      return done(tx);
    });
  },

  /** Все записи (или в диапазоне) курсором */
  all<T>(store: string, range?: IDBKeyRange): Promise<T[]> {
    return open.then(function (db) {
      return new Promise<T[]>(function (resolve, reject) {
        const out: T[] = [];
        const r = range? db.transaction(store, 'readonly').objectStore(store).openCursor(range): db.transaction(store, 'readonly').objectStore(store).openCursor;
        r.onsuccess = function  {
          const c = r.result as IDBCursorWithValue | null;
          if (!c) { resolve(out); return; }
          out.push(c.value as T);
          c.continue;
        };
        r.onerror = function  { reject(r.error); };
      });
    });
  },

  /** Обойти записи курсором; filter(value) → true — удалить */
  deleteWhere(store: string, range: IDBKeyRange | null, filter: (v: any) => boolean): Promise<number> {
    return open.then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      let n = 0;
      const r = range? tx.objectStore(store).openCursor(range): tx.objectStore(store).openCursor;
      r.onsuccess = function  {
        const c = r.result as IDBCursorWithValue | null;
        if (!c) return;
        if (filter(c.value)) { c.delete; n++; }
        c.continue;
      };
      return done(tx).then(function  { return n; });
    });
  },

  deleteRange(store: string, range: IDBKeyRange): Promise<void> {
    return open.then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(range);
      return done(tx);
    });
  },

  /** Удалить базу целиком (сброс данных) */
  drop: Promise<void> {
    const p = dbp;
    dbp = null;
    return (p? p.then(function (db) { db.close; }, function  { /* */ }): Promise.resolve).then(function  {
      return new Promise<void>(function (resolve) {
        const r = idb.deleteDatabase(NAME);
        r.onsuccess = r.onerror = function  { resolve; };
      });
    });
  },
};


/** Индексные ключи прежней IndexedDB и новой SQLite3. */
export function recordKey(store: string, v: any): any {
  if (store === 'playlists') return v.id;
  if (store === 'channels') return v.pid;
  if (store === 'sources') return v.url;
  if (store === 'epgch') return [v.s, v.id];
  if (store === 'prog') return [v.s, v.x, v.l, v.n];
  if (store === 'map') return [v.pid, v.s];
  throw new Error('unknown store: ' + store);
}

function sqliteRecords(store: string, values: any[]): { key: any; value: any }[] {
  return values.map(function (v) { return { key: recordKey(store, v), value: v }; });
}

/**
 * Переход 1.0.2–1.0.6: данные IndexedDB и Node-файлов остаются доступными.
 * Миграция делается один раз ПЕРЕД запуском интерфейса, с SQLite-приоритетом.
 * Старые данные не удаляются, чтобы не рисковать избранным при обновлении IPK.
 * Веб-приложение и воркер больше не пишут в IndexedDB, если SQLite доступна.
 */
let migrating: Promise<void> | null = null;
const migrationStores = ['playlists', 'channels', 'sources', 'map', 'epgch', 'prog'];
function migrateStore(store: string): Promise<void> {
  const marker = 'migrated:' + store;
  return SocketDb.get<string>('settings', marker).then(function (m) {
    if (m.present) return;
    console.log('sqlite migration start', store);
    return Promise.all([
      NativeDb.all<any>(store).catch(function (e) { console.warn('legacy IndexedDB unreadable', store, e); return [] as any[]; }),
      FileDb.active.then(function (active) {
        if (!active) return [] as { key: any; value: any }[];
        return FileDb.list<any>(store).catch(function (e) { console.warn('legacy files unreadable', store, e); return [] as { key: any; value: any }[]; });
      }),
      SocketDb.all<any>(store),
    ]).then(function (all) {
      const existing: { [k: string]: boolean } = {};
      const newest: { [k: string]: { key: any; value: any } } = {};
      const native = sqliteRecords(store, all[0]);
      for (let i = 0; i < native.length; i++) newest[JSON.stringify(native[i].key)] = native[i];
      for (let i = 0; i < all[1].length; i++) newest[JSON.stringify(all[1][i].key)] = all[1][i];
      for (let i = 0; i < all[2].length; i++) existing[JSON.stringify(all[2][i].key)] = true;
      const newRecords: { key: any; value: any }[] = [];
      for (const key in newest) if (!existing[key]) newRecords.push(newest[key]);
      console.log('sqlite migration', store, 'old', native.length + all[1].length, 'copy', newRecords.length);
      return SocketDb.put(store, newRecords).then(function  {
        return SocketDb.put('settings', [{ key: marker, value: '1' }]);
      });
    });
  });
}

export const Db = {
  /** Только основное окно запускает миграцию, прежде чем создавать EPG Worker. */
  migrate: Promise<void> {
    if (migrating) return migrating;
    migrating = SocketDb.available.then(function (ok) {
      if (!ok) { console.warn('SQLite websocket unavailable: legacy database only'); return; }
      let chain: Promise<void> = Promise.resolve;
      migrationStores.forEach(function (store) {
        chain = chain.then(function  { return migrateStore(store); });
      });
      return chain;
    }).catch(function (e) {
      console.error('SQLite migration interrupted:', e);
      migrating = null; // next startup/call may safely retry
    });
    return migrating;
  },
  get<T>(store: string, key: any): Promise<T | undefined> {
    return SocketDb.available.then(function (ok) {
      if (ok) return SocketDb.get<T>(store, key).then(function (r) { return r.present? r.value: undefined; });
      return FileDb.active.then(function (active) {
        if (!active) return NativeDb.get<T>(store, key);
        return FileDb.get<T>(store, key).then(function (r) { return r.present? r.value: NativeDb.get<T>(store, key); });
      });
    });
  },
  put(store: string, value: any): Promise<void> {
    return SocketDb.available.then(function (ok) {
      if (ok) return SocketDb.put(store, [{ key: recordKey(store, value), value: value }]);
      throw new Error('SQLite WebSocket offline: write rejected (' + store + ')');
    });
  },
  putAll(store: string, values: any[]): Promise<void> {
    if (!values.length) return Promise.resolve;
    return SocketDb.available.then(function (ok) {
      if (ok) return SocketDb.put(store, sqliteRecords(store, values));
      throw new Error('SQLite WebSocket offline: write rejected (' + store + ')');
    });
  },
  delete(store: string, key: any): Promise<void> {
    return SocketDb.available.then(function (ok) {
      if (!ok) throw new Error('SQLite WebSocket offline: delete rejected (' + store + ')');
      return SocketDb.delete(store, [key]);
    });
  },
  all<T>(store: string, range?: IDBKeyRange): Promise<T[]> {
    return SocketDb.available.then(function (ok) {
      if (ok) return SocketDb.all<T>(store, asRange(range)).then(function (rows) {
        return rows.map(function (r) { return r.value; });
      });
      return FileDb.active.then(function (active) {
        if (!active) return NativeDb.all<T>(store, range);
        return Promise.all([NativeDb.all<T>(store, range), FileDb.list<T>(store, asRange(range))]).then(function (both) {
          const map: { [key: string]: T } = {};
          for (let i = 0; i < both[0].length; i++) map[JSON.stringify(recordKey(store, both[0][i]))] = both[0][i];
          for (let i = 0; i < both[1].length; i++) map[JSON.stringify(both[1][i].key)] = both[1][i].value;
          return Object.keys(map).map(function (k) { return map[k]; });
        });
      });
    });
  },
  deleteWhere(store: string, range: IDBKeyRange | null, filter: (v: any) => boolean): Promise<number> {
    return SocketDb.available.then(function (ok) {
      if (!ok) throw new Error('SQLite WebSocket offline: delete rejected (' + store + ')');
      return SocketDb.all<any>(store, asRange(range || undefined)).then(function (rows) {
        const keys = rows.filter(function (r) { return filter(r.value); }).map(function (r) { return r.key; });
        return SocketDb.delete(store, keys).then(function  { return keys.length; });
      });
    });
  },
  deleteRange(store: string, range: IDBKeyRange): Promise<void> {
    return SocketDb.available.then(function (ok) {
      if (ok) return SocketDb.deleteRange(store, asRange(range)!);
      throw new Error('SQLite WebSocket offline: delete rejected (' + store + ')');
    });
  },
  drop: Promise<void> {
    return SocketDb.available.then(function (ok) {
      if (!ok) throw new Error('SQLite WebSocket offline: reset rejected');
      // В первую очередь очищаем старое хранилище, чтобы после сброса не произошёл импорт.
      return Promise.all([
        NativeDb.drop.catch(function (e) { console.warn('legacy IndexedDB drop', e); }),
        FileDb.active.then(function (active) { return active? FileDb.reset: Promise.resolve; }).catch(function  { /* */ }),
      ]).then(function  {
        return ok? SocketDb.reset.then(function  {
          migrating = null;
          return SocketDb.put('settings', migrationStores.map(function (s) {
            return { key: 'migrated:' + s, value: '1' };
          }));
        }): Promise.resolve;
      });
    });
  },
};
