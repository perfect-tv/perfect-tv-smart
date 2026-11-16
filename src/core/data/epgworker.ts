import { Clock } from '../core/clock';
import { Net } from '../core/net';
import { Prefs } from '../core/prefs';
import { SourceMeta, WantedSet } from './loaders';
import { FileDb } from './filedb';

/**
 * Клиент воркера программы (src/worker/epg.ts). Воркер запускается из файла epg-worker.js
 * рядом с index.html; не вышло (file:// без воркеров, нет WebSocket в воркере на старых webOS) —
 * available() отвечает false, и загрузка идёт в основном потоке.
 */
interface Job { onProgress: (read: number, total: number, n: number) => void; onPack: () => void; resolve: (m: SourceMeta | null) => void }

let worker: Worker | null = null;
let state: 0 | 1 | 2 | 3 = 0;          // 0 — не пробовали, 1 — проверяем, 2 — работает, 3 — нельзя
let waiters: ((ok: boolean) => void)[] = [];
const jobs: { [id: number]: Job } = {};
let nextId = 1;

function finish(ok: boolean) {
  state = ok ? 2 : 3;
  const w = waiters;
  waiters = [];
  for (let i = 0; i < w.length; i++) w[i](ok);
}

function start() {
  state = 1;
  try {
    worker = new Worker('epg-worker.js');
  } catch (e) {
    console.warn('epg worker: cannot start', e);
    finish(false);
    return;
  }
  const t = setTimeout(function () { console.warn('epg worker: no answer'); finish(false); }, 8000);
  worker.onerror = function (e: any) {
    console.error('epg worker error', e && (e.message || e));
    if (state === 1) { clearTimeout(t); finish(false); }
  };
  worker.onmessage = function (e: MessageEvent) {
    const m = e.data;
    if (m.type === 'pong') {
      clearTimeout(t);
      if (!m.ok) console.warn('epg worker: no SQLite WebSocket', m.error);
      else console.log('epg worker ok');
      finish(!!m.ok);
      return;
    }
    if (m.type === 'log') {
      const c: any = console;
      (c[m.level] || c.log).apply(console, m.args);
      return;
    }
    const j = jobs[m.id];
    if (!j) return;
    if (m.type === 'progress') j.onProgress(m.read, m.total, m.programmes);
    else if (m.type === 'pack') { FileDb.resetStatus(); j.onPack(); }
    else if (m.type === 'done') { FileDb.resetStatus(); delete jobs[m.id]; j.resolve(m.meta); }
  };
  worker.postMessage({ type: 'ping' });
}

export const EpgWorker = {
  /** Воркер готов (первый вызов запускает и проверяет его) */
  available(): Promise<boolean> {
    if (state === 2) return Promise.resolve(true);
    if (state === 3 || typeof Worker === 'undefined') return Promise.resolve(false);
    return new Promise<boolean>(function (resolve) {
      waiters.push(resolve);
      if (state === 0) start();
    });
  },

  load(url: string, wanted: WantedSet[], maxArchiveDays: number, langs: string[], force: boolean,
    onProgress: (read: number, total: number, n: number) => void, onPack: () => void): Promise<SourceMeta | null> {
    const id = nextId++;
    return new Promise<SourceMeta | null>(function (resolve) {
      jobs[id] = { onProgress: onProgress, onPack: onPack, resolve: resolve };
      worker!.postMessage({
        type: 'load', id: id, url: url, wanted: wanted, maxArchiveDays: maxArchiveDays, langs: langs, force: force,
        prefs: Prefs.all(), proxyOk: Net.proxyAvailable, clock: Clock.offset,
      });
    });
  },
};
