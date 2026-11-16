import { KeyRange, RecordDb } from './db';

/**
 * IndexedDB — хранилище записей для платформ без своего (браузер; на webOS — только чтение данных
 * версий до 1.0.7 при переносе). Схема — src/core/data/db.ts. Только API, которое есть
 * в Chromium 38 (без getAll — курсоры).
 */
const NAME = 'perfecttv';
const VERSION = 1;

let dbp: Promise<IDBDatabase> | null = null;

function idb(): IDBFactory {
  const g: any = typeof indexedDB !== 'undefined' ? indexedDB : (typeof window !== 'undefined' ? (window as any).webkitIndexedDB : null);
  if (!g) throw new Error('no indexedDB');
  return g;
}

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise(function (resolve, reject) {
    const req = idb().open(NAME, VERSION);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('channels')) db.createObjectStore('channels', { keyPath: 'pid' });
      if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('epgch')) db.createObjectStore('epgch', { keyPath: ['s', 'id'] });
      if (!db.objectStoreNames.contains('prog')) db.createObjectStore('prog', { keyPath: ['s', 'x', 'l', 'n'] });
      if (!db.objectStoreNames.contains('map')) db.createObjectStore('map', { keyPath: ['pid', 's'] });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { console.error('indexedDB open', req.error); reject(req.error); };
    (req as any).onblocked = function () { console.warn('indexedDB blocked'); };
    setTimeout(function () { reject(new Error('indexedDB open timeout')); }, 15000);
  });
  return dbp;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise(function (resolve, reject) {
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
    tx.onabort = function () { reject(tx.error || new Error('abort')); };
  });
}

function reqP<T>(r: IDBRequest): Promise<T> {
  return new Promise(function (resolve, reject) {
    r.onsuccess = function () { resolve(r.result as T); };
    r.onerror = function () { reject(r.error); };
  });
}

/** KeyRange → IDBKeyRange */
function idbRange(r?: KeyRange | null): IDBKeyRange | undefined {
  if (!r) return undefined;
  const lo = r.lower !== undefined, hi = r.upper !== undefined;
  if (lo && hi) return IDBKeyRange.bound(r.lower, r.upper, !!r.lowerOpen, !!r.upperOpen);
  if (lo) return IDBKeyRange.lowerBound(r.lower, !!r.lowerOpen);
  if (hi) return IDBKeyRange.upperBound(r.upper, !!r.upperOpen);
  return undefined;
}

export const IdbDb: RecordDb = {
  get<T>(store: string, key: any): Promise<T | undefined> {
    return open().then(function (db) {
      return reqP<T>(db.transaction(store, 'readonly').objectStore(store).get(key));
    });
  },

  put(store: string, value: any): Promise<void> {
    return open().then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      return done(tx);
    });
  },

  putAll(store: string, values: any[]): Promise<void> {
    if (!values.length) return Promise.resolve();
    return open().then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      for (let i = 0; i < values.length; i++) s.put(values[i]);
      return done(tx);
    });
  },

  delete(store: string, key: any): Promise<void> {
    return open().then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      return done(tx);
    });
  },

  all<T>(store: string, range?: KeyRange): Promise<T[]> {
    return open().then(function (db) {
      return new Promise<T[]>(function (resolve, reject) {
        const out: T[] = [];
        const ir = idbRange(range);
        const os = db.transaction(store, 'readonly').objectStore(store);
        const r = ir ? os.openCursor(ir) : os.openCursor();
        r.onsuccess = function () {
          const c = r.result as IDBCursorWithValue | null;
          if (!c) { resolve(out); return; }
          out.push(c.value as T);
          c.continue();
        };
        r.onerror = function () { reject(r.error); };
      });
    });
  },

  deleteWhere(store: string, range: KeyRange | null, filter: (v: any) => boolean): Promise<number> {
    return open().then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      let n = 0;
      const ir = idbRange(range);
      const r = ir ? tx.objectStore(store).openCursor(ir) : tx.objectStore(store).openCursor();
      r.onsuccess = function () {
        const c = r.result as IDBCursorWithValue | null;
        if (!c) return;
        if (filter(c.value)) { c.delete(); n++; }
        c.continue();
      };
      return done(tx).then(function () { return n; });
    });
  },

  deleteRange(store: string, range: KeyRange): Promise<void> {
    return open().then(function (db) {
      const tx = db.transaction(store, 'readwrite');
      const ir = idbRange(range);
      if (ir) tx.objectStore(store).delete(ir); else tx.objectStore(store).clear();
      return done(tx);
    });
  },

  drop(): Promise<void> {
    const p = dbp;
    dbp = null;
    return (p ? p.then(function (db) { db.close(); }, function () { /* */ }) : Promise.resolve()).then(function () {
      return new Promise<void>(function (resolve) {
        const r = idb().deleteDatabase(NAME);
        r.onsuccess = r.onerror = function () { resolve(); };
      });
    });
  },
};
