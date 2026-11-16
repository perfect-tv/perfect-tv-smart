import { Clock } from './clock';
import { Prefs } from './prefs';
import { platform } from './platform';

/**
 * Сеть (docs/TZ.md, §2 «Сеть»). Прямой запрос — fetch с потоком (Chromium 43+) или куски Range
 * через XHR (webOS 3). Через прокси платформы (PlatformApi.proxy; на webOS — JS-сервис) — если
 * у запроса свои заголовки, если прямой запрос упал на CORS или если так выбрано в настройках.
 */
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
  cancelled?: () => boolean;
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

export const hasStreams = typeof ReadableStream !== 'undefined' && typeof fetch !== 'undefined' && typeof Response !== 'undefined' && 'body' in Response.prototype;

export function sleep(ms: number) { return new Promise<void>(function (r) { setTimeout(r, ms); }); }

export function xhr(method: string, url: string, opts: { type?: XMLHttpRequestResponseType; headers?: { [k: string]: string }; timeout?: number }): Promise<XMLHttpRequest> {
  return new Promise(function (resolve, reject) {
    const x = new XMLHttpRequest();
    x.open(method, url, true);
    if (opts.type) x.responseType = opts.type;
    x.timeout = opts.timeout || 30000;
    const h = opts.headers || {};
    for (const k in h) { try { x.setRequestHeader(k, h[k]); } catch (e) { /* запрещённый заголовок */ } }
    x.onload = function () { resolve(x); };
    x.onerror = function () { reject(new NetError('network', 0)); };
    x.ontimeout = function () { reject(new NetError('timeout', 0)); };
    x.send();
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

/** Адрес через HTTP-прокси с протоколом сервиса webOS (service/proxy.js): base/p?u=&h= */
export function proxyPath(base: string, url: string, headers?: { [k: string]: string } | null): string {
  let q = base + '/p?u=' + encodeURIComponent(url);
  if (headers && Object.keys(headers).length) q += '&h=' + encodeURIComponent(JSON.stringify(headers));
  return q;
}

export const Net = {
  /** HTTP-прокси платформы работает (адреса proxyUrl годятся) */
  get proxyAvailable() { const p = platform().proxy; return !!p && p.available; },
  /** Проверка прокси уже была (или прокси нет вовсе) */
  get checked() { const p = platform().proxy; return !p || p.checked; },
  /** Ключ строки состояния прокси для настроек; '' — у платформы прокси нет */
  proxyState(): string { const p = platform().proxy; return p ? p.state() : ''; },

  checkProxy(): Promise<boolean> {
    const p = platform().proxy;
    return p ? p.check() : Promise.resolve(false);
  },

  /** Адрес через прокси с заголовками */
  proxyUrl(url: string, headers?: { [k: string]: string } | null): string {
    const p = platform().proxy;
    return p ? p.url(url, headers) : url;
  },

  /** Нужен ли прокси запросу с такими заголовками */
  wantProxy(headers?: { [k: string]: string } | null): boolean {
    if (!Net.proxyAvailable) return false;
    const m = Prefs.proxyMode;
    if (m === 1) return true;
    if (m === 2) return false;
    return !!headers && Object.keys(headers).length > 0;
  },

  /**
   * Прочитать ответ потоком: onChunk получает куски, может вернуть Promise (ждём — так разбор
   * не копит данные). Ответ 304 — без кусков. Ошибки — NetError(network | http_<код> | need_service).
   */
  stream(url: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
    const via = Net.wantProxy(opts.headers);
    const first = via ? Net.streamProxy(url, opts, onChunk) : Net.streamDirect(url, opts, onChunk);
    return first.then(null, function (e: any) {
      // CORS и прочие сетевые ошибки прямого запроса — второй заход через прокси (он перепроверит сервис)
      if (!via && Prefs.proxyMode !== 2 && platform().proxy && e instanceof NetError && (e.code === 'network' || e.code === 'need_service')) {
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
    const p = platform().proxy;
    if (!p) return Promise.reject(new NetError('need_service'));
    return p.stream(url, opts, onChunk);
  },

  /** Небольшой текст целиком */
  text(url: string, headers?: { [k: string]: string }): Promise<string> {
    const via = Net.wantProxy(headers);
    const go = function (p: boolean) {
      return xhr('GET', p ? Net.proxyUrl(url, headers) : url, { headers: p ? {} : headers }).then(function (x) {
        if (x.status >= 400 || x.status === 0) throw new NetError(x.status ? 'http_' + x.status : 'network', x.status);
        Clock.syncWith(x.getResponseHeader('Date'));
        return x.responseText;
      });
    };
    return go(via).then(null, function (e) {
      if (!via && Net.proxyAvailable && Prefs.proxyMode !== 2 && e instanceof NetError && e.code === 'network') return go(true);
      throw e;
    });
  },
};

export function checkStatus(r: Resp, opts: StreamOpts) {
  Clock.syncWith(r.header('Date'));
  if (r.status === 304) return;
  if (r.status === 0) throw new NetError('network', 0);
  if (r.status >= 400) throw new NetError('http_' + r.status, r.status);
  if (opts.onResponse) opts.onResponse(r);
}

/** Promise с пределом времени: не уложился — NetError('timeout') */
export function within<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>(function (resolve, reject) {
    const t = setTimeout(function () { if (onTimeout) onTimeout(); reject(new NetError('timeout')); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

/** fetch с потоком (Chromium 43+): ответ — не дольше 30 с, пауза в данных — не дольше 60 с */
export function fetchStream(url: string, headers: { [k: string]: string }, proxied: boolean, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
  console.log('net', proxied ? 'proxy' : 'direct', url.slice(0, 160));
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
    if (st === 304 || !res.body) return r;
    const total = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
    const reader = res.body.getReader();
    let read = 0;
    function pump(): Promise<Resp> {
      if (opts.cancelled && opts.cancelled()) { try { reader.cancel(); } catch (e) { /* */ } return Promise.resolve(r); }
      return within(reader.read(), 60000, function () { try { reader.cancel(); } catch (e) { /* */ } }).then(function (x) {
        if (x.done) return r;
        const v = x.value as Uint8Array;
        read += v.length;
        if (opts.onProgress) opts.onProgress(read, total);
        return Promise.resolve(onChunk(v)).then(pump);
      });
    }
    return pump();
  }, function (e) {
    console.warn('net error', url.slice(0, 120), e && (e.code || e.message || e));
    if (e instanceof NetError) throw e;
    throw new NetError('network', 0);
  });
}

const RANGE = 2 * 1024 * 1024;
const WHOLE_MAX = 64 * 1024 * 1024;

/** Куски Range (webOS 3 без потоков): сервер без Range — ответ целиком (до 64 МБ); Range запрещён (CORS) — progressiveStream */
export function rangeStream(url: string, headers: { [k: string]: string }, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
  let off = 0;
  let total = -1;
  let resp: Resp | null = null;
  function next(): Promise<Resp> {
    if (opts.cancelled && opts.cancelled()) return Promise.resolve(resp!);
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
        return Promise.resolve(onChunk(buf)).then(function () { return resp!; });
      }
      if (x.status !== 206) throw new NetError('http_' + x.status, x.status);
      const cr = x.getResponseHeader('Content-Range') || '';
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) total = parseInt(m[1], 10);
      off += buf.length;
      if (opts.onProgress) opts.onProgress(off, total > 0 ? total : 0);
      return Promise.resolve(onChunk(buf)).then(function () {
        if (buf.length === 0 || (total >= 0 && off >= total) || buf.length < RANGE) return resp!;
        return next();
      });
    });
  }
  return next().then(null, function (e) {
    // Range и условные заголовки под CORS — «непростые»: браузер сначала шлёт OPTIONS, а многие
    // серверы его не умеют (так в воркере из Blob на webOS 3: там CORS действует, в странице file:// — нет).
    // Первый кусок не пришёл — один простой запрос, читаемый по ходу загрузки (без 304)
    if (resp || !(e instanceof NetError) || e.code !== 'network') throw e;
    console.log('net range refused, progressive', url.slice(0, 120));
    return progressiveStream(url, opts, onChunk);
  });
}

const PROGRESSIVE_MAX = 128 * 1024 * 1024;
const PROGRESSIVE_PIECE = 512 * 1024;

/**
 * Поток без fetch и без Range: XHR с текстом в «x-user-defined» — каждый байт ответа становится
 * символом (код & 0xFF), а responseText растёт по ходу загрузки, так что разбор идёт параллельно.
 * Только простой GET (без своих заголовков) — проходит CORS без OPTIONS. Цена — весь ответ копится
 * строкой (сжатый файл, ~2 байта на байт), поэтому предел — PROGRESSIVE_MAX.
 */
export function progressiveStream(url: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
  return new Promise<Resp>(function (resolve, reject) {
    const x = new XMLHttpRequest();
    let resp: Resp | null = null;
    let pos = 0, total = 0, loaded = false, busy = false, over = false, last = Date.now();
    function fail(e: any) {
      if (over) return;
      over = true;
      clearInterval(watch);
      try { x.abort(); } catch (er) { /* */ }
      reject(e);
    }
    function head(): boolean {
      if (resp) return true;
      if (x.readyState < 2) return false;
      resp = respOfXhr(x, url, false);
      total = parseInt(x.getResponseHeader('Content-Length') || '0', 10) || 0;
      try { checkStatus(resp, opts); } catch (e) { fail(e); return false; }
      return true;
    }
    function pump() {
      if (busy || over || !head()) return;
      if (opts.cancelled && opts.cancelled()) { over = true; clearInterval(watch); try { x.abort(); } catch (e) { /* */ } resolve(resp!); return; }
      const t = x.responseText || '';
      if (t.length > PROGRESSIVE_MAX) { fail(new NetError('need_service')); return; }
      if (pos >= t.length) {
        if (loaded) { over = true; clearInterval(watch); resolve(resp!); }
        return;
      }
      const end = Math.min(t.length, pos + PROGRESSIVE_PIECE);
      const buf = new Uint8Array(end - pos);
      for (let i = pos; i < end; i++) buf[i - pos] = t.charCodeAt(i) & 0xff;
      pos = end;
      last = Date.now();
      if (opts.onProgress) opts.onProgress(pos, total);
      busy = true;
      Promise.resolve(onChunk(buf)).then(function () { busy = false; pump(); }, function (e) { busy = false; fail(e); });
    }
    // пауза в данных — не дольше 60 с (как у fetchStream)
    const watch = setInterval(function () { if (!loaded && Date.now() - last > 60000) fail(new NetError('timeout')); }, 5000);
    x.open('GET', url, true);
    x.overrideMimeType('text/plain; charset=x-user-defined');
    x.onreadystatechange = function () { if (x.readyState >= 2) head(); };
    x.onprogress = function () { last = Date.now(); pump(); };
    x.onload = function () {
      loaded = true;
      // 304 и пустой ответ — без кусков
      if (!head()) return;
      if (x.status === 304 || x.status === 0) { if (x.status === 0) fail(new NetError('network', 0)); else { over = true; clearInterval(watch); resolve(resp!); } return; }
      pump();
    };
    x.onerror = function () { fail(new NetError('network', 0)); };
    x.send();
  });
}

