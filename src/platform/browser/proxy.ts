import { fetchStream, hasStreams, NetError, proxyPath, Resp, StreamOpts, xhr } from '../../core/net';
import { ProxyApi } from '../../core/platform';

/**
 * Внешний прокси для браузера — тот же протокол, что у JS-сервиса webOS (service/proxy.js:
 * /ping, /p?u=&h=): `npm run proxy` на ПК или свой сервер. Адрес — параметр страницы
 * `?proxy=http://host:port` (для страницы на ТВ — в ссылке запуска); запоминается в браузере.
 * Без адреса — только прямые запросы (серверы без CORS недоступны); прокси всё равно есть
 * в настройках («не задан») и в тексте ошибки — чтобы было видно, что делать.
 */
const KEY = 'ptv-proxy';

function configured(): string {
  let v = '';
  try {
    const m = /[?&]proxy=([^&#]*)/.exec(location.search);
    if (m) {
      v = decodeURIComponent(m[1]);
      try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* */ }
    } else {
      try { v = localStorage.getItem(KEY) || ''; } catch (e) { /* */ }
    }
  } catch (e) { /* */ }
  return v.replace(/\/+$/, '');
}

export function makeProxy(): ProxyApi {
  const base = typeof location !== 'undefined' ? configured() : '';
  let ok = false, checked = !base;
  function url(u: string, headers?: { [k: string]: string } | null): string { return proxyPath(base, u, headers); }
  const proxy: ProxyApi = {
    get available() { return ok; },
    get checked() { return checked; },
    get base() { return ok ? base : ''; },
    state: function () { return !base ? 'web_proxy_not_set' : ok ? 'proxy_running' : 'web_proxy_unavailable'; },
    check: function () {
      if (!base) return Promise.resolve(false);
      return xhr('GET', base + '/ping', { timeout: 3000 }).then(function (x) {
        ok = x.status === 200 && x.responseText.indexOf('"ok":true') >= 0;
        return ok;
      }, function () { ok = false; return false; }).then(function (r) {
        checked = true;
        console.log('proxy', base, r ? 'ok' : 'unavailable');
        return r;
      });
    },
    url: url,
    stream: function (u: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp> {
      if (!ok) return Promise.reject(new NetError('need_service'));
      if (!hasStreams) return Promise.reject(new NetError('need_service'));
      const h: { [k: string]: string } = {};
      if (opts.etag) h['If-None-Match'] = opts.etag;
      if (opts.lastModified) h['If-Modified-Since'] = opts.lastModified;
      return fetchStream(url(u, opts.headers), h, true, opts, onChunk);
    },
  };
  return proxy;
}
