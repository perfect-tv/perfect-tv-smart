import { SocketDb } from '../data/socketdb';
/**
 * Синхронный кэш настроек / избранного для старого интерфейса.
 * Источник истины в версии 1.0.7 — SQLite3 в Node-сервисе через WebSocket.
 * localStorage старой версии читается только при первичной миграции.
 * Сохранение в SQLite асинхронное; ошибки пишем в журнал, а не выбрасываем
 * из обработчиков кнопок пульта.
 */
let mem: { [k: string]: string } = {};
let sqliteReady = false;
let booting: Promise<boolean> | null = null;
let pendingWrites: { [k: string]: string | null } = {};
let flushScheduled = false;
let flushing = false;
let idleWaiters: { resolve: () => void; reject: (e: any) => void }[] = [];
function signalIdle(error?: any) {
  if (!error && (flushing || Object.keys(pendingWrites).length)) return;
  const q = idleWaiters; idleWaiters = [];
  for (let i = 0; i < q.length; i++) { if (error) q[i].reject(error); else q[i].resolve(); }
}

function ls(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}
function schedule() {
  if (flushScheduled || flushing || !sqliteReady) return;
  flushScheduled = true;
  setTimeout(function () {
    flushScheduled = false;
    if (flushing) return;
    flushing = true;
    const batch = pendingWrites;
    pendingWrites = {};
    const put: { key: any; value: any }[] = [], del: any[] = [];
    for (const k in batch) {
      if (batch[k] === null) del.push(k);
      else put.push({ key: k, value: batch[k] });
    }
    SocketDb.put('settings', put).then(function () { return SocketDb.delete('settings', del); }).then(function () {
      flushing = false; if (Object.keys(pendingWrites).length) schedule(); else signalIdle();
    }, function (e) {
      flushing = false;
      console.error('SQLite settings write failed', e);
      // Не перетираем более новые значения из очереди.
      for (const k in batch) if (!Object.prototype.hasOwnProperty.call(pendingWrites, k)) pendingWrites[k] = batch[k];
      signalIdle(e);
      // Повтор только при следующей записи; постоянный цикл ошибок исключён.
    });
  }, 30);
}

export const Storage2 = {
  /** Должно завершиться до Tv.start(), чтобы Prefs и избранное были готовы. */
  bootstrap(): Promise<boolean> {
    if (booting) return booting;
    booting = SocketDb.available().then(function (ok) {
      if (!ok) return false;
      return SocketDb.all<string>('settings').then(function (list) {
        const old = ls(), existing: { [k: string]: boolean } = {};
        const values: { [k: string]: string } = {};
        let alreadyMigrated = false;
        for (let i = 0; i < list.length; i++) {
          const k = list[i].key;
          if (k === 'migrated:settings') { alreadyMigrated = true; continue; }
          if (k.indexOf('migrated:') === 0) continue;
          existing[k] = true;
          values[k] = list[i].value;
        }
        const importRows: { key: any; value: any }[] = [];
        // Локальное хранилище читаем лишь один раз. Иначе удалённые в SQLite
        // настройки будут воскресать при каждом перезапуске из localStorage.
        if (!alreadyMigrated && old) {
          try {
            for (let i = 0; i < old.length; i++) {
              const key = old.key(i);
              if (!key || key === 'logo_failed' || existing[key]) continue;
              const value = old.getItem(key);
              if (value !== null) { values[key] = value; importRows.push({ key: key, value: value }); }
            }
          } catch (e) { console.warn('SQLite legacy settings migration read', e); }
        }
        if (!alreadyMigrated) importRows.push({ key: 'migrated:settings', value: '1' });
        return SocketDb.put('settings', importRows).then(function () {
          mem = values; sqliteReady = true;
          console.log('SQLite settings ready', Object.keys(values).length, 'legacy import', importRows.length);
          return true;
        });
      });
    }).catch(function (e) { console.error('SQLite settings bootstrap', e); return false; });
    return booting;
  },
  sqliteActive(): boolean { return sqliteReady; },
  /** Дождаться записи кэша настроек на диск перед резервной копией/сбросом. */
  flush(): Promise<void> {
    if (!sqliteReady) return Promise.resolve();
    if (!flushing && !Object.keys(pendingWrites).length) return Promise.resolve();
    return new Promise<void>(function (resolve, reject) {
      idleWaiters.push({ resolve: resolve, reject: reject });
      schedule();
    });
  },
  /** Используется после полного сброса БД, когда там сохранены лишь маркеры миграции. */
  resetRuntime(backup: string | null): Promise<void> {
    mem = {}; pendingWrites = {};
    // Полный сброс также очищает старое localStorage. Оно больше никогда
    // не используется для записи и не должно заново импортироваться.
    const old = ls();
    if (old) try { old.clear(); } catch (e) { console.warn('SQLite reset legacy settings', e); }
    const rows: { key: any; value: any }[] = [{ key: 'migrated:settings', value: '1' }];
    if (backup !== null) {
      mem.backup = backup;
      rows.push({ key: 'backup', value: backup });
    }
    return SocketDb.put('settings', rows);
  },
  get(key: string): string | null {
    if (sqliteReady) return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
    const old = ls();
    if (old) { try { return old.getItem(key); } catch (e) { return null; } }
    return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
  },
  set(key: string, value: string) {
    if (sqliteReady) { mem[key] = value; pendingWrites[key] = value; schedule(); return; }
    // При недоступном WebSocket не пытаемся снова заполнить квоту webOS.
    // Чтение старых настроек остаётся доступным, новые значения — лишь в RAM.
    mem[key] = value;
    console.warn('SQLite storage unavailable, setting not persisted', key);
  },
  remove(key: string) {
    if (sqliteReady) { delete mem[key]; pendingWrites[key] = null; schedule(); return; }
    delete mem[key];
    console.warn('SQLite storage unavailable, removal not persisted', key);
  },
  keys(): string[] {
    if (sqliteReady) return Object.keys(mem);
    const old = ls();
    if (!old) return Object.keys(mem);
    const keys: string[] = [];
    for (let i = 0; i < old.length; i++) { const k = old.key(i); if (k !== null) keys.push(k); }
    return keys;
  },
  json<T>(key: string, def: T): T {
    const v = Storage2.get(key);
    if (v === null) return def;
    try { return JSON.parse(v) as T; } catch (e) { return def; }
  },
  setJson(key: string, value: any) { Storage2.set(key, JSON.stringify(value)); },
};
