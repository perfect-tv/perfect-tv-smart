import { platform } from './platform';

/**
 * Настройки, избранное, история — синхронный кэш в памяти поверх хранилища платформы
 * (PlatformApi.kv). Читается целиком до Tv.start(); запись — пачкой через 30 мс после изменения.
 * Ошибки записи — в журнал, а не исключением в обработчик кнопки пульта.
 */
let mem: { [k: string]: string } = {};
let persistent = false;
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

function schedule() {
  if (flushScheduled || flushing || !persistent) return;
  flushScheduled = true;
  setTimeout(function () {
    flushScheduled = false;
    if (flushing) return;
    flushing = true;
    const batch = pendingWrites;
    pendingWrites = {};
    const put: { key: string; value: string }[] = [], del: string[] = [];
    for (const k in batch) {
      const v = batch[k];
      if (v === null) del.push(k);
      else put.push({ key: k, value: v });
    }
    platform().kv.save(put, del).then(function () {
      flushing = false; if (Object.keys(pendingWrites).length) schedule(); else signalIdle();
    }, function (e) {
      flushing = false;
      console.error('settings write failed', e);
      // Не перетираем более новые значения из очереди.
      for (const k in batch) if (!Object.prototype.hasOwnProperty.call(pendingWrites, k)) pendingWrites[k] = batch[k];
      signalIdle(e);
      // Повтор только при следующей записи; постоянный цикл ошибок исключён.
    });
  }, 30);
}

export const Storage2 = {
  /** Должно завершиться до Tv.start(), чтобы Prefs и избранное были готовы. Ответ — пишется ли на диск */
  bootstrap(): Promise<boolean> {
    if (booting) return booting;
    booting = platform().kv.load().then(function (r) {
      mem = r.values;
      persistent = r.persistent;
      console.log('settings', persistent ? 'ready' : 'in memory only', Object.keys(mem).length);
      return persistent;
    }, function (e) { console.error('settings bootstrap', e); return false; });
    return booting;
  },
  /** Настройки сохраняются (хранилище платформы доступно) */
  persistent(): boolean { return persistent; },
  /** Дождаться записи кэша настроек на диск перед резервной копией/сбросом. */
  flush(): Promise<void> {
    if (!persistent) return Promise.resolve();
    if (!flushing && !Object.keys(pendingWrites).length) return Promise.resolve();
    return new Promise<void>(function (resolve, reject) {
      idleWaiters.push({ resolve: resolve, reject: reject });
      schedule();
    });
  },
  /** После полного сброса данных: остаётся только резервная копия (если была) */
  resetRuntime(backup: string | null): Promise<void> {
    mem = {}; pendingWrites = {};
    const rows: { key: string; value: string }[] = [];
    if (backup !== null) {
      mem.backup = backup;
      rows.push({ key: 'backup', value: backup });
    }
    return platform().kv.reset(rows);
  },
  get(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
  },
  set(key: string, value: string) {
    mem[key] = value;
    if (persistent) { pendingWrites[key] = value; schedule(); return; }
    console.warn('storage unavailable, setting not persisted', key);
  },
  remove(key: string) {
    delete mem[key];
    if (persistent) { pendingWrites[key] = null; schedule(); return; }
    console.warn('storage unavailable, removal not persisted', key);
  },
  keys(): string[] { return Object.keys(mem); },
  json<T>(key: string, def: T): T {
    const v = Storage2.get(key);
    if (v === null) return def;
    try { return JSON.parse(v) as T; } catch (e) { return def; }
  },
  setJson(key: string, value: any) { Storage2.set(key, JSON.stringify(value)); },
};
