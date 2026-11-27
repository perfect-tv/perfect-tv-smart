import { checkStatus, fetchStream, hasStreams, NetError, Resp, sleep, StreamOpts, xhr } from '../../core/net';
import { ProxyApi } from '../../core/platform';
import { Luna } from './luna';

/**
 * Прокси webOS — JS-сервис (service/proxy.js): HTTP на 127.0.0.1:47380, а если webOS не дал
 * открыть порт — потоки по системной шине Luna (streamOpen/streamRead). Через него — запросы
 * с заголовками плейлиста, обход CORS, плеер с заголовками.
 */
export const PROXY_PORT = 47380;
export const PROXY = 'http://127.0.0.1:' + PROXY_PORT;

let proxyOk = false;
let proxyChecked = false;
let lunaOk = false;
/** Версия API сервиса (service/service.js, SERVICE_API): с ней сверяется код с сайта; 0 — неизвестно */
let serviceApi = 0;

/** Сервис может работать по Luna, даже если webOS заблокировал HTTP listen(). */
function checkLuna(): Promise<boolean> {
  if (!Luna.isWebOS) return Promise.resolve(false);
  return Luna.requestService('ping', {}, 9000).then(function (r: any) {
    lunaOk = !!r.returnValue;
    if (lunaOk && r.api) serviceApi = r.api;
    if (lunaOk) console.log('Luna data transport available, Node', r.node || '?',
      r.proxyReady ? 'HTTP listener ready' : 'HTTP listener not ready');
    else console.warn('Luna ping failed', r.errorText || r.error || JSON.stringify(r));
    return lunaOk;
  }, function (e: any) {
    lunaOk = false;
    console.warn('Luna service unavailable', e && (e.message || e));
    return false;
  });
}

function check(): Promise<boolean> {
  if (Luna.isWebOS) Luna.startService();
  const tries = Luna.isWebOS ? 12 : 1;
  let i = 0;
  function attempt(): Promise<boolean> {
    return xhr('GET', PROXY + '/ping', { timeout: 1500 }).then(function (x) {
      proxyOk = x.status === 200 && x.responseText.indexOf('"ok":true') >= 0;
      if (proxyOk) { try { serviceApi = JSON.parse(x.responseText).api || 0; } catch (e) { /* */ } }
      console.log('proxy', proxyOk ? 'ok' : 'bad answer ' + x.status);
      // UA браузера ТВ — сервису: им он подписывает запросы, которые делает сам (программа, Luna-поток)
      if (proxyOk && typeof navigator !== 'undefined') xhr('GET', PROXY + '/ua?v=' + encodeURIComponent(navigator.userAgent), { timeout: 3000 }).then(null, function () { /* */ });
      proxyChecked = true;
      if (proxyOk) return true;
      return checkLuna().then(function () { return false; });
    }, function () {
      if (++i < tries) {
        if (Luna.isWebOS && i === 4 && (Luna as any).ensureService) (Luna as any).ensureService();
        return sleep(500).then(attempt);
      }
      proxyOk = false;
      proxyChecked = true;
      console.warn('HTTP proxy absent; checking Luna transport');
      return checkLuna().then(function () { return false; });
    });
  }
  return attempt();
}

function url(u: string, headers?: { [k: string]: string } | null): string {
  // User-Agent — тот же, что у прямых запросов браузера ТВ (провайдеры считают устройства по UA);
  // свой UA канала из плейлиста важнее
  const h: { [k: string]: string } = {};
  let hasUa = false;
  if (headers) for (const k in headers) { h[k] = headers[k]; if (k.toLowerCase() === 'user-agent') hasUa = true; }
  if (!hasUa && typeof navigator !== 'undefined' && navigator.userAgent) h['User-Agent'] = navigator.userAgent;
  let q = PROXY + '/p?u=' + encodeURIComponent(u);
  if (Object.keys(h).length) q += '&h=' + encodeURIComponent(JSON.stringify(h));
  return q;
}

function stream(u: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
  // На LG локальный TCP-порт может быть запрещён: используем системную шину,
  // которой для передачи M3U/XMLTV не нужен HTTP-сервер на телевизоре.
  if (!proxyOk) {
    if (typeof document === 'undefined') return Promise.reject(new NetError('need_service'));
    if (lunaOk) return streamLuna(u, opts, onChunk);
    if (Luna.isWebOS) return checkLuna().then(function (ok) {
      if (!ok) throw new NetError('need_service');
      return streamLuna(u, opts, onChunk);
    });
    return check().then(function (ok) {
      if (!ok) throw new NetError('need_service');
      return stream(u, opts, onChunk);
    });
  }
  if (hasStreams) {
    const h: { [k: string]: string } = {};
    if (opts.etag) h['If-None-Match'] = opts.etag;
    if (opts.lastModified) h['If-Modified-Since'] = opts.lastModified;
    return fetchStream(url(u, opts.headers), h, true, opts, onChunk);
  }
  return sessionStream(u, opts, onChunk);
}

export const WebosProxy: ProxyApi & { readonly luna: boolean; readonly api: number } = {
  get available() { return proxyOk; },
  get checked() { return proxyChecked; },
  get base() { return proxyOk ? PROXY : ''; },
  /** HTTP нет, но сервис отвечает по Luna */
  get luna() { return lunaOk; },
  get api() { return serviceApi; },
  state: function () { return proxyOk ? 'proxy_running' : lunaOk ? 'proxy_luna' : 'proxy_absent'; },
  check: check,
  url: url,
  stream: stream,
};

/** Бинарный ответ Node-сервиса по Luna; base64 блоками до 32 КБ. */
function streamLuna(url: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
  console.log('net luna', url.slice(0, 160));
  let session = '';
  let read = 0;
  function close() {
    if (!session) return;
    const id = session;
    session = '';
    Luna.requestService('streamClose', { id: id }, 5000).then(function () { /* */ }, function () { /* */ });
  }
  return Luna.requestService('streamOpen', {
    url: url, headers: opts.headers || {}, etag: opts.etag || '', lastModified: opts.lastModified || '',
  }, 35000).then(function (o: any): Promise<Resp> {
    if (!o.returnValue || !o.id) {
      console.warn('Luna streamOpen failed', o.error || o.errorText || JSON.stringify(o));
      throw new NetError('network');
    }
    session = String(o.id);
    const hd: { [k: string]: string } = o.headers || {};
    const response: Resp = {
      status: o.status || 0, url: o.url || url, proxied: true,
      header: function (name) { return hd[name.toLowerCase()] || ''; },
    };
    checkStatus(response, opts);
    if (response.status === 304 || o.end) return Promise.resolve(response);
    const total = parseInt(hd['content-length'] || '0', 10) || 0;
    function next(): Promise<Resp> {
      if (opts.cancelled && opts.cancelled()) return Promise.resolve(response);
      return Luna.requestService('streamRead', { id: session }, 60000).then(function (part: any) {
        if (!part.returnValue) {
          console.warn('Luna streamRead failed', part.error || part.errorText || 'unknown');
          throw new NetError('network');
        }
        const binary = atob(part.data || '');
        const chunk = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) chunk[j] = binary.charCodeAt(j);
        read += chunk.length;
        if (opts.onProgress) opts.onProgress(read, total);
        return Promise.resolve(chunk.length ? onChunk(chunk) : undefined).then(function () {
          if (part.end) {
            if (part.error) { console.warn('Luna upstream error', part.error); throw new NetError('network'); }
            return response;
          }
          return next();
        });
      });
    }
    return next();
  }).then(function (r) {
    close();
    return r;
  }, function (e: any) {
    close();
    if (e instanceof NetError) throw e;
    console.warn('Luna transfer error', e && (e.message || e));
    throw new NetError('network');
  });
}


/** Сессия прокси: /s/open, затем /s/read кусками (webOS 3 через JS-сервис) */
function sessionStream(url: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
  let q = PROXY + '/s/open?u=' + encodeURIComponent(url);
  if (opts.headers && Object.keys(opts.headers).length) q += '&h=' + encodeURIComponent(JSON.stringify(opts.headers));
  if (opts.etag) q += '&etag=' + encodeURIComponent(opts.etag);
  if (opts.lastModified) q += '&lm=' + encodeURIComponent(opts.lastModified);
  return xhr('GET', q, { timeout: 40000 }).then(function (x) {
    const o = JSON.parse(x.responseText || '{}');
    if (!o.id && !o.status) throw new NetError('network', 0);
    const hd: { [k: string]: string } = o.headers || {};
    const r: Resp = { status: o.status, url: o.url || url, proxied: true, header: function (n) { return hd[n.toLowerCase()] || ''; } };
    checkStatus(r, opts);
    if (r.status === 304 || !o.id) return r;
    const total = parseInt(hd['content-length'] || '0', 10) || 0;
    let read = 0;
    function next(): Promise<Resp> {
      if (opts.cancelled && opts.cancelled()) { xhr('GET', PROXY + '/s/close?id=' + o.id, {}).then(null, function () { /* */ }); return Promise.resolve(r); }
      return xhr('GET', PROXY + '/s/read?id=' + o.id + '&max=' + (2 * 1024 * 1024), { type: 'arraybuffer', timeout: 60000 }).then(function (y) {
        if (y.status !== 200) throw new NetError('network', 0);
        const buf = new Uint8Array(y.response as ArrayBuffer);
        const end = y.getResponseHeader('X-End') === '1';
        const err = y.getResponseHeader('X-Error');
        read += buf.length;
        if (opts.onProgress) opts.onProgress(read, total);
        return Promise.resolve(buf.length ? onChunk(buf) : undefined).then(function () {
          if (end) { if (err) throw new NetError('network', 0); return r; }
          return next();
        });
      });
    }
    return next();
  });
}
