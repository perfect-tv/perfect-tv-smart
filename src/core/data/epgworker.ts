import { Clock } from '../clock';
import { NetError } from '../net';
import { platform } from '../platform';
import { Prefs } from '../prefs';
import { EpgBatch, EpgRequest, EpgResult } from './loaders';

/**
 * Клиент воркера программы (src/core/worker/epg.ts): сеть, распаковка и разбор XMLTV — вне потока
 * интерфейса, база — здесь (IndexedDB внутри воркера есть не везде: старый WebKit, Safari до 10).
 * Код воркера встроен в бандл (EPG_WORKER_SRC, tools/build.mjs) и запускается из Blob — так он
 * работает и у приложения с file://, где Worker по адресу файла запрещён; не вышло — файл
 * epg-worker.js рядом с index.html; не ответил за 8 с — разбор в основном потоке (Loaders.parseEpg).
 *
 * Основной поток → воркер:
 *   {type:'ping'}
 *   {type:'load', id, req: EpgRequest, proxyMode, proxyBase, clock}
 *   {type:'ack', id}                                  пачка записана — разбирать дальше
 * Воркер → основной поток:
 *   {type:'pong'}
 *   {type:'progress', id, read, total, programmes}
 *   {type:'batch', id, batch: EpgBatch}               буферы пачек передаются без копирования
 *   {type:'done', id, result: EpgResult}
 *   {type:'fail', id, code, status, message}
 *   {type:'log', level, args}
 */
declare const EPG_WORKER_SRC: string;

interface Job {
  sink: (b: EpgBatch) => Promise<void>;
  onProgress: (read: number, total: number, n: number) => void;
  resolve: (r: EpgResult) => void;
  reject: (e: any) => void;
}

let worker: Worker | null = null;
let state: 0 | 1 | 2 | 3 = 0;          // 0 — не пробовали, 1 — запускаем, 2 — работает, 3 — нельзя
let waiters: ((ok: boolean) => void)[] = [];
const jobs: { [id: number]: Job } = {};
let nextId = 1;

function finish(ok: boolean) {
  state = ok ? 2 : 3;
  const w = waiters;
  waiters = [];
  for (let i = 0; i < w.length; i++) w[i](ok);
}

/** Способы запуска по порядку: встроенный код из Blob, затем файл */
function candidates(): (() => Worker)[] {
  const out: (() => Worker)[] = [];
  const src = typeof EPG_WORKER_SRC === 'string' ? EPG_WORKER_SRC : '';
  if (src) out.push(function () {
    const w: any = window;
    const U = w.URL || w.webkitURL;
    return new Worker(U.createObjectURL(new Blob([src], { type: 'application/javascript' })));
  });
  out.push(function () { return new Worker('epg-worker.js'); });
  return out;
}

function onMessage(e: MessageEvent) {
  const m = e.data;
  if (m.type === 'log') {
    const c: any = console;
    (c[m.level] || c.log).apply(console, m.args);
    return;
  }
  const j = jobs[m.id];
  if (!j) return;
  if (m.type === 'progress') j.onProgress(m.read, m.total, m.programmes);
  else if (m.type === 'batch') {
    j.sink(m.batch).then(function () { worker!.postMessage({ type: 'ack', id: m.id }); }, function (err) {
      delete jobs[m.id];
      worker!.postMessage({ type: 'cancel', id: m.id });
      j.reject(err);
    });
  } else if (m.type === 'done') { delete jobs[m.id]; j.resolve(m.result); }
  else if (m.type === 'fail') {
    delete jobs[m.id];
    j.reject(m.code ? new NetError(m.code, m.status || 0) : new Error(m.message || 'epg worker'));
  }
}

function start(list: (() => Worker)[], i: number) {
  if (i >= list.length) { console.warn('epg worker: unavailable, parsing on the main thread'); finish(false); return; }
  let w: Worker;
  try { w = list[i](); } catch (e) {
    console.warn('epg worker: cannot start', i, e && ((e as any).message || e));
    start(list, i + 1);
    return;
  }
  let settled = false;
  const next = function (why: string) {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    console.warn('epg worker:', why, i);
    try { w.terminate(); } catch (e) { /* */ }
    start(list, i + 1);
  };
  const t = setTimeout(function () { next('no answer'); }, 8000);
  w.onerror = function (e: any) {
    if (!settled) { next('error ' + (e && e.message || '')); return; }
    console.error('epg worker error', e && (e.message || e));
  };
  w.onmessage = function (e: MessageEvent) {
    if (!settled) {
      if (e.data && e.data.type === 'pong') {
        settled = true;
        clearTimeout(t);
        worker = w;
        w.onmessage = onMessage;
        console.log('epg worker ok', i === 0 && list.length > 1 ? 'blob' : 'file');
        finish(true);
      }
      return;
    }
  };
  w.postMessage({ type: 'ping' });
}

export const EpgWorker = {
  /** Воркер готов (первый вызов запускает и проверяет его) */
  available(): Promise<boolean> {
    if (state === 2) return Promise.resolve(true);
    if (state === 3 || typeof Worker === 'undefined' || typeof window === 'undefined') return Promise.resolve(false);
    return new Promise<boolean>(function (resolve) {
      waiters.push(resolve);
      if (state === 0) { state = 1; start(candidates(), 0); }
    });
  },

  parse(req: EpgRequest, sink: (b: EpgBatch) => Promise<void>, onProgress: (read: number, total: number, n: number) => void): Promise<EpgResult> {
    const id = nextId++;
    const proxy = platform().proxy;
    return new Promise<EpgResult>(function (resolve, reject) {
      jobs[id] = { sink: sink, onProgress: onProgress, resolve: resolve, reject: reject };
      worker!.postMessage({
        type: 'load', id: id, req: req, proxyMode: Prefs.proxyMode,
        proxyBase: proxy ? proxy.base : '', clock: Clock.offset,
      });
    });
  },
};
