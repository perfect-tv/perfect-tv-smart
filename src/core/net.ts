import { Clock } from './clock';
import { Prefs } from './prefs';
import { Platform } from './platform';

/**
 * Сеть (§2 «Сеть»). Прямой запрос — fetch с потоком (webOS 4+) или куски Range
 * через XHR (webOS 3). Через локальный прокси (JS-сервис) — если у запроса свои заголовки,
 * если прямой запрос упал на CORS или если так выбрано в настройках.
 */
export const PROXY_PORT = 47380;
export const PROXY = 'http://127.0.0.1:' + PROXY_PORT;

export interface Resp {
  status: number;
  url: string;
  header(name: string): string;
  /** Через прокси */
  proxied: boolean;
}

export interface StreamOpts {
  headers?: { [k: string]: string };
  etag?: string;
  lastModified?: string;
  /** Вызывается до первого куска; можно бросить ошибку, чтобы прервать */
  onResponse?: (r: Resp) => void;
  /** Прогресс: прочитано байтов (сжатых) и всего (если известно) */
  onProgress?: (read: number, total: number) => void;
  cancelled?:  => boolean;
}

export class NetError extends Error {
  constructor(public code: string, public status = 0) {
    super(code);
    // наследование от Error после перевода в ES5 теряет прототип — без этого instanceof не работает
    Object.setPrototypeOf(this, NetError.prototype);
    this.code = code;
    this.status = status;
  }
}

let proxyOk = false;
let proxyChecked = false;
const hasStreams = typeof ReadableStream!== 'undefined' && typeof fetch!== 'undefined' && typeof Response!== 'undefined' && 'body' in Response.prototype;

function sleep(ms: number) { return new Promise<void>(function (r) { setTimeout(r, ms); }); }

function xhr(method: string, url: string, opts: { type?: XMLHttpRequestResponseType; headers?: { [k: string]: string }; timeout?: number }): Promise<XMLHttpRequest> {
  return new Promise(function (resolve, reject) {
    const x = new XMLHttpRequest;
    x.open(method, url, true);
    if (opts.type) x.responseType = opts.type;
    x.timeout = opts.timeout || 30000;
    const h = opts.headers || {};
    for (const k in h) { try { x.setRequestHeader(k, h[k]); } catch (e) { /* запрещённый заголовок */ } }
    x.onload = function  { resolve(x); };
    x.onerror = function  { reject(new NetError('network', 0)); };
    x.ontimeout = function  { reject(new NetError('timeout', 0)); };
    x.send;
  });
}

function respOfXhr(x: XMLHttpRequest, url: string, proxied: boolean): Resp {
  return {
    status: x.status, url: x.responseURL || url, proxied: proxied,
    header: function (n) { return x.getResponseHeader(n) || ''; },
  };
}

function respOfFetch(r: Response, url: string, proxied: boolean): Resp {
  return { status: r.status, url: r.url || url, proxied: proxied, header: function (n) { return r.headers.get(n) || ''; } };
}

export const Net = {
  get proxyAvailable { return proxyOk; },

  /** Разбудить JS-сервис (на ТВ) и проверить прокси */
  init: Promise<boolean> {
    Platform.startService;
    return Net.checkProxy;
  },

  checkProxy: Promise<boolean> {
    const tries = Platform.isWebOS? 6: 1;
    let i = 0;
    function attempt: Promise<boolean> {
      return xhr('GET', PROXY + '/ping', { timeout: 1500 }).then(function (x) {
        proxyOk = x.status === 200 && x.responseText.indexOf('"ok":true') >= 0;
        console.log('proxy', proxyOk? 'ok': 'bad answer ' + x.status);
        proxyChecked = true;
        return proxyOk;
      }, function  {
        if (++i < tries) return sleep(500).then(attempt);
        proxyOk = false;
        proxyChecked = true;
        console.warn('proxy absent');
        return false;
      });
    }
    return attempt;
  },

  /** Адрес через прокси с заголовками */
  proxyUrl(url: string, headers?: { [k: string]: string } | null): string {
    let u = PROXY + '/p?u=' + encodeURIComponent(url);
    if (headers && Object.keys(headers).length) u += '&h=' + encodeURIComponent(JSON.stringify(headers));
    return u;
  },

  /** Нужен ли прокси запросу с такими заголовками */
  wantProxy(headers?: { [k: string]: string } | null): boolean {
    if (!proxyOk) return false;
    const m = Prefs.proxyMode;
    if (m === 1) return true;
    if (m === 2) return false;
    return!!headers && Object.keys(headers).length > 0;
  },

  /**
   * Прочитать ответ потоком: onChunk получает куски, может вернуть Promise (ждём — так разбор
   * не копит данные). Ответ 304 — без кусков. Ошибки — NetError(network | http_<код> | need_service).
   */
  stream(url: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
    const via = Net.wantProxy(opts.headers);
    const first = via? Net.streamProxy(url, opts, onChunk): Net.streamDirect(url, opts, onChunk);
    return first.then(null, function (e: any) {
      // CORS и прочие сетевые ошибки прямого запроса — второй заход через прокси (он перепроверит сервис)
      if (!via && Prefs.proxyMode!== 2 && e instanceof NetError && (e.code === 'network' || e.code === 'need_service')) {
        return Net.streamProxy(url, opts, onChunk);
      }
      throw e;
    });
  },

  streamDirect(url: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
    const h: { [k: string]: string } = Object.assign({}, opts.headers || {});
    if (opts.etag) h['If-None-Match'] = opts.etag;
    if (opts.lastModified) h['If-Modified-Since'] = opts.lastModified;
    if (hasStreams) return fetchStream(url, h, false, opts, onChunk);
    return rangeStream(url, h, opts, onChunk);
  },

  streamProxy(url: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
    // сервис мог подняться позже первой проверки (Node на слабом ТВ стартует долго) — проверить ещё раз
    if (!proxyOk) {
      if (typeof document === 'undefined') return Promise.reject(new NetError('need_service'));
      return Net.checkProxy.then(function (ok) {
        if (!ok) throw new NetError('need_service');
        return Net.streamProxy(url, opts, onChunk);
      });
    }
    if (hasStreams) {
      const h: { [k: string]: string } = {};
      if (opts.etag) h['If-None-Match'] = opts.etag;
      if (opts.lastModified) h['If-Modified-Since'] = opts.lastModified;
      return fetchStream(Net.proxyUrl(url, opts.headers), h, true, opts, onChunk);
    }
    return sessionStream(url, opts, onChunk);
  },

  /** Небольшой текст целиком */
  text(url: string, headers?: { [k: string]: string }): Promise<string> {
    const via = Net.wantProxy(headers);
    const go = function (p: boolean) {
      return xhr('GET', p? Net.proxyUrl(url, headers): url, { headers: p? {}: headers }).then(function (x) {
        if (x.status >= 400 || x.status === 0) throw new NetError(x.status? 'http_' + x.status: 'network', x.status);
        Clock.syncWith(x.getResponseHeader('Date'));
        return x.responseText;
      });
    };
    return go(via).then(null, function (e) {
      if (!via && proxyOk && Prefs.proxyMode!== 2 && e instanceof NetError && e.code === 'network') return go(true);
      throw e;
    });
  },

  get checked { return proxyChecked; },

  /** Воркер: состояние прокси — от основного потока */
  setProxy(ok: boolean) { proxyOk = ok; proxyChecked = true; },
};

function checkStatus(r: Resp, opts: StreamOpts) {
  Clock.syncWith(r.header('Date'));
  if (r.status === 304) return;
  if (r.status === 0) throw new NetError('network', 0);
  if (r.status >= 400) throw new NetError('http_' + r.status, r.status);
  if (opts.onResponse) opts.onResponse(r);
}

/** Promise с пределом времени: не уложился — NetError('timeout') */
function within<T>(p: Promise<T>, ms: number, onTimeout?:  => void): Promise<T> {
  return new Promise<T>(function (resolve, reject) {
    const t = setTimeout(function  { if (onTimeout) onTimeout; reject(new NetError('timeout')); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

/** fetch с потоком (Chromium 43+): ответ — не дольше 30 с, пауза в данных — не дольше 60 с */
function fetchStream(url: string, headers: { [k: string]: string }, proxied: boolean, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
  console.log('net', proxied? 'proxy': 'direct', url.slice(0, 160));
  return within(fetch(url, { headers: headers, cache: 'no-store' }), 30000).then(function (res) {
    let st = res.status;
    // прокси возвращает статус сервера как есть; X-Status — для ответов, которые браузер мог бы подменить
    const xs = res.headers.get('X-Status');
    if (proxied && xs) st = parseInt(xs, 10) || st;
    const r = respOfFetch(res, url, proxied);
    r.status = st;
    const xu = res.headers.get('X-Url');
    if (xu) r.url = xu;
    checkStatus(r, opts);
    if (st === 304 ||!res.body) return r;
    const total = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
    const reader = res.body.getReader;
    let read = 0;
    function pump: Promise<Resp> {
      if (opts.cancelled && opts.cancelled) { try { reader.cancel; } catch (e) { /* */ } return Promise.resolve(r); }
      return within(reader.read, 60000, function  { try { reader.cancel; } catch (e) { /* */ } }).then(function (x) {
        if (x.done) return r;
        const v = x.value as Uint8Array;
        read += v.length;
        if (opts.onProgress) opts.onProgress(read, total);
        return Promise.resolve(onChunk(v)).then(pump);
      });
    }
    return pump;
  }, function (e) {
    console.warn('net error', url.slice(0, 120), e && (e.code || e.message || e));
    if (e instanceof NetError) throw e;
    throw new NetError('network', 0);
  });
}

const RANGE = 2 * 1024 * 1024;
const WHOLE_MAX = 64 * 1024 * 1024;

/** Куски Range (webOS 3 без потоков): сервер без Range — ответ целиком (до 64 МБ) */
function rangeStream(url: string, headers: { [k: string]: string }, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
  let off = 0;
  let total = -1;
  let resp: Resp | null = null;
  function next: Promise<Resp> {
    if (opts.cancelled && opts.cancelled) return Promise.resolve(resp!);
    const h = Object.assign({}, headers);
    h['Range'] = 'bytes=' + off + '-' + (off + RANGE - 1);
    return xhr('GET', url, { type: 'arraybuffer', headers: h, timeout: 60000 }).then(function (x) {
      const r = respOfXhr(x, url, false);
      if (!resp) {
        resp = r;
        checkStatus(r, opts);
        if (r.status === 304) return r;
      }
      if (x.status === 416) return resp;
      const buf = new Uint8Array(x.response as ArrayBuffer);
      if (x.status === 200) {
        // Range не поддерживается — пришёл весь файл
        if (buf.length > WHOLE_MAX) throw new NetError('need_service');
        if (opts.onProgress) opts.onProgress(buf.length, buf.length);
        return Promise.resolve(onChunk(buf)).then(function  { return resp!; });
      }
      if (x.status!== 206) throw new NetError('http_' + x.status, x.status);
      const cr = x.getResponseHeader('Content-Range') || '';
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) total = parseInt(m[1], 10);
      off += buf.length;
      if (opts.onProgress) opts.onProgress(off, total > 0? total: 0);
      return Promise.resolve(onChunk(buf)).then(function  {
        if (buf.length === 0 || (total >= 0 && off >= total) || buf.length < RANGE) return resp!;
        return next;
      });
    });
  }
  return next;
}

/** Сессия прокси: /s/open, затем /s/read кусками (webOS 3 через JS-сервис) */
function sessionStream(url: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
  let q = PROXY + '/s/open?u=' + encodeURIComponent(url);
  if (opts.headers && Object.keys(opts.headers).length) q += '&h=' + encodeURIComponent(JSON.stringify(opts.headers));
  if (opts.etag) q += '&etag=' + encodeURIComponent(opts.etag);
  if (opts.lastModified) q += '&lm=' + encodeURIComponent(opts.lastModified);
  return xhr('GET', q, { timeout: 40000 }).then(function (x) {
    const o = JSON.parse(x.responseText || '{}');
    if (!o.id &&!o.status) throw new NetError('network', 0);
    const hd: { [k: string]: string } = o.headers || {};
    const r: Resp = { status: o.status, url: o.url || url, proxied: true, header: function (n) { return hd[n.toLowerCase] || ''; } };
    checkStatus(r, opts);
    if (r.status === 304 ||!o.id) return r;
    const total = parseInt(hd['content-length'] || '0', 10) || 0;
    let read = 0;
    function next: Promise<Resp> {
      if (opts.cancelled && opts.cancelled) { xhr('GET', PROXY + '/s/close?id=' + o.id, {}).then(null, function  { /* */ }); return Promise.resolve(r); }
      return xhr('GET', PROXY + '/s/read?id=' + o.id + '&max=' + (2 * 1024 * 1024), { type: 'arraybuffer', timeout: 60000 }).then(function (y) {
        if (y.status!== 200) throw new NetError('network', 0);
        const buf = new Uint8Array(y.response as ArrayBuffer);
        const end = y.getResponseHeader('X-End') === '1';
        const err = y.getResponseHeader('X-Error');
        read += buf.length;
        if (opts.onProgress) opts.onProgress(read, total);
        return Promise.resolve(buf.length? onChunk(buf): undefined).then(function  {
          if (end) { if (err) throw new NetError('network', 0); return r; }
          return next;
        });
      });
    }
    return next;
  });
}
