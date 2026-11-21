import '../polyfills';
import { Clock } from '../clock';
import { fetchStream, hasStreams, NetError, proxyPath, Resp, StreamOpts } from '../net';
import { platform, ProxyApi, usePlatform } from '../platform';
import { Prefs } from '../prefs';
import { Storage2 } from '../storage';
import { EpgBatch, Loaders } from '../data/loaders';

/**
 * Воркер программы (docs/TZ.md, §5): сеть, распаковка и разбор XMLTV вне потока интерфейса.
 * Базы здесь нет — пачки уходят в основной поток (src/core/data/epgworker.ts, там же протокол),
 * следующая разбирается после подтверждения записи. Прокси — HTTP по адресу из основного потока.
 * Сборка — отдельный бандл (tools/build.mjs), встраивается в app.js строкой.
 */
const ctx: any = self;

function post(m: any, transfer?: any[]) { if (transfer && transfer.length) ctx.postMessage(m, transfer); else ctx.postMessage(m); }

// журнал воркера — в журнал приложения
const c: any = console;
['log', 'warn', 'error'].forEach(function (k) {
  c[k] = function () {
    const args = Array.prototype.slice.call(arguments).map(function (a: any) {
      if (a instanceof Error) return a.name + ': ' + a.message;
      if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a).slice(0, 300); } catch (e) { return String(a); } }
      return String(a);
    });
    post({ type: 'log', level: k, args: ['[epg]'].concat(args) });
  };
});

let proxyBase = '';
const workerProxy: ProxyApi = {
  get available() { return !!proxyBase; },
  checked: true,
  get base() { return proxyBase; },
  state: function () { return ''; },
  check: function () { return Promise.resolve(!!proxyBase); },
  url: function (u, h) { return proxyPath(proxyBase, u, h); },
  stream: function (u: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
    if (!proxyBase || !hasStreams) return Promise.reject(new NetError('need_service'));
    const h: { [k: string]: string } = {};
    if (opts.etag) h['If-None-Match'] = opts.etag;
    if (opts.lastModified) h['If-Modified-Since'] = opts.lastModified;
    return fetchStream(proxyPath(proxyBase, u, opts.headers), h, true, opts, onChunk);
  },
};
// настройки воркера — только в памяти (режим прокси приходит с каждой загрузкой)
const base = platform();
usePlatform({
  id: 'epg-worker', label: base.label, boot: base.boot, exit: base.exit, cursorVisible: base.cursorVisible,
  onCursor: base.onCursor, defaultHlsEngine: 0, db: base.db, proxy: workerProxy, epg: null,
  qr: null, nativePlayer: null, nativeHeaders: [], nativeHls: false, storageBytes: base.storageBytes, labels: base.labels, code: null,
  kv: {
    load: function () { return Promise.resolve({ values: {}, persistent: true }); },
    save: function () { return Promise.resolve(); },
    reset: function () { return Promise.resolve(); },
  },
});
Storage2.bootstrap();

const acks: { [id: number]: () => void } = {};
const cancelled: { [id: number]: true } = {};

/** Буферы пачек — без копирования (каждый один раз: повтор в списке — ошибка DataCloneError) */
function transfers(b: EpgBatch): any[] {
  const out: any[] = [];
  for (let i = 0; i < b.packs.length; i++) {
    const d = b.packs[i].data;
    if (d && d.buffer && out.indexOf(d.buffer) < 0) out.push(d.buffer);
  }
  return out;
}

ctx.onmessage = function (e: MessageEvent) {
  const m = e.data;
  if (m.type === 'ping') { post({ type: 'pong' }); return; }
  if (m.type === 'ack') { const a = acks[m.id]; if (a) { delete acks[m.id]; a(); } return; }
  if (m.type === 'cancel') { cancelled[m.id] = true; const a = acks[m.id]; if (a) { delete acks[m.id]; a(); } return; }
  if (m.type === 'load') {
    proxyBase = m.proxyBase || '';
    Prefs.proxyMode = m.proxyMode || 0;
    Clock.setOffset(m.clock || 0);
    const id: number = m.id;
    Loaders.parseEpg(m.req, function (b) {
      if (cancelled[id]) return Promise.reject(new Error('cancelled'));
      return new Promise<void>(function (resolve) {
        acks[id] = resolve;
        post({ type: 'batch', id: id, batch: b }, transfers(b));
      });
    }, function (read, total, programmes) {
      post({ type: 'progress', id: id, read: read, total: total, programmes: programmes });
    }).then(function (result) {
      post({ type: 'done', id: id, result: result });
    }, function (err: any) {
      if (!cancelled[id]) post({ type: 'fail', id: id, code: err instanceof NetError ? err.code : '', status: err && err.status || 0, message: String(err && err.message || err) });
      delete cancelled[id];
    });
  }
};
