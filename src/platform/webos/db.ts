import { FileDb } from './filedb';
import { SocketDb } from './socketdb';
import { KeyRange, RecordDb, recordKey } from '../../core/data/db';
import { IdbDb } from '../../core/data/idb';

/**
 * Хранилище записей webOS — файлы JS-сервиса через WebSocket (SocketDb). Сервис недоступен —
 * только чтение старых данных (IndexedDB и файлы через HTTP версий до 1.0.7), запись — отказ.
 */
function sqliteRecords(store: string, values: any[]): { key: any; value: any }[] {
  return values.map(function (v) { return { key: recordKey(store, v), value: v }; });
}

/*
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
      IdbDb.all<any>(store).catch(function (e) { console.warn('legacy IndexedDB unreadable', store, e); return [] as any[]; }),
      FileDb.active().then(function (active) {
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
      return SocketDb.put(store, newRecords).then(function () {
        return SocketDb.put('settings', [{ key: marker, value: '1' }]);
      });
    });
  });
}

export const WebosDb: RecordDb & { migrate(): Promise<void> } = {
  /** Один раз до интерфейса (WebOS.boot) */
  migrate(): Promise<void> {
    if (migrating) return migrating;
    migrating = SocketDb.available().then(function (ok) {
      if (!ok) { console.warn('SQLite websocket unavailable: legacy database only'); return; }
      let chain: Promise<void> = Promise.resolve();
      migrationStores.forEach(function (store) {
        chain = chain.then(function () { return migrateStore(store); });
      });
      return chain;
    }).catch(function (e) {
      console.error('SQLite migration interrupted:', e);
      migrating = null; // next startup/call may safely retry
    });
    return migrating;
  },
  get<T>(store: string, key: any): Promise<T | undefined> {
    return SocketDb.available().then(function (ok) {
      if (ok) return SocketDb.get<T>(store, key).then(function (r) { return r.present ? r.value : undefined; });
      return FileDb.active().then(function (active) {
        if (!active) return IdbDb.get<T>(store, key);
        return FileDb.get<T>(store, key).then(function (r) { return r.present ? r.value : IdbDb.get<T>(store, key); });
      });
    });
  },
  put(store: string, value: any): Promise<void> {
    return SocketDb.available().then(function (ok) {
      if (ok) return SocketDb.put(store, [{ key: recordKey(store, value), value: value }]);
      throw new Error('SQLite WebSocket offline: write rejected (' + store + ')');
    });
  },
  putAll(store: string, values: any[]): Promise<void> {
    if (!values.length) return Promise.resolve();
    return SocketDb.available().then(function (ok) {
      if (ok) return SocketDb.put(store, sqliteRecords(store, values));
      throw new Error('SQLite WebSocket offline: write rejected (' + store + ')');
    });
  },
  delete(store: string, key: any): Promise<void> {
    return SocketDb.available().then(function (ok) {
      if (!ok) throw new Error('SQLite WebSocket offline: delete rejected (' + store + ')');
      return SocketDb.delete(store, [key]);
    });
  },
  all<T>(store: string, range?: KeyRange): Promise<T[]> {
    return SocketDb.available().then(function (ok) {
      if (ok) return SocketDb.all<T>(store, range).then(function (rows) {
        return rows.map(function (r) { return r.value; });
      });
      return FileDb.active().then(function (active) {
        if (!active) return IdbDb.all<T>(store, range);
        return Promise.all([IdbDb.all<T>(store, range), FileDb.list<T>(store, range)]).then(function (both) {
          const map: { [key: string]: T } = {};
          for (let i = 0; i < both[0].length; i++) map[JSON.stringify(recordKey(store, both[0][i]))] = both[0][i];
          for (let i = 0; i < both[1].length; i++) map[JSON.stringify(both[1][i].key)] = both[1][i].value;
          return Object.keys(map).map(function (k) { return map[k]; });
        });
      });
    });
  },
  deleteWhere(store: string, range: KeyRange | null, filter: (v: any) => boolean): Promise<number> {
    return SocketDb.available().then(function (ok) {
      if (!ok) throw new Error('SQLite WebSocket offline: delete rejected (' + store + ')');
      return SocketDb.all<any>(store, range || undefined).then(function (rows) {
        const keys = rows.filter(function (r) { return filter(r.value); }).map(function (r) { return r.key; });
        return SocketDb.delete(store, keys).then(function () { return keys.length; });
      });
    });
  },
  deleteRange(store: string, range: KeyRange): Promise<void> {
    return SocketDb.available().then(function (ok) {
      if (ok) return SocketDb.deleteRange(store, range);
      throw new Error('SQLite WebSocket offline: delete rejected (' + store + ')');
    });
  },
  drop(): Promise<void> {
    return SocketDb.available().then(function (ok) {
      if (!ok) throw new Error('SQLite WebSocket offline: reset rejected');
      // В первую очередь очищаем старое хранилище, чтобы после сброса не произошёл импорт.
      return Promise.all([
        IdbDb.drop().catch(function (e) { console.warn('legacy IndexedDB drop', e); }),
        FileDb.active().then(function (active) { return active ? FileDb.reset() : Promise.resolve(); }).catch(function () { /* */ }),
      ]).then(function () {
        return ok ? SocketDb.reset().then(function () {
          migrating = null;
          return SocketDb.put('settings', migrationStores.map(function (s) {
            return { key: 'migrated:' + s, value: '1' };
          }));
        }) : Promise.resolve();
      });
    });
  },
};
