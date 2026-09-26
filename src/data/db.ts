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
    req.onerror = function  { reject(req.error); };
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

export const Db = {
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
