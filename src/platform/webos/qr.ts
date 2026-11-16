import { str } from '../../core/lang';
import { QrInbox } from '../../core/platform';
import { PROXY, WebosProxy } from './proxy';

/**
 * Плейлист с телефона: JS-сервис открывает временную страницу (service/proxy.js, /qr/) —
 * телефон в той же сети открывает её по QR и присылает ссылку. Нужен HTTP-порт сервиса.
 */
interface QrResponse { returnValue?: boolean; url?: string; token?: string; name?: string; ready?: boolean; error?: string }

function get(path: string): Promise<QrResponse> {
  return new Promise<QrResponse>(function (resolve, reject) {
    const x = new XMLHttpRequest();
    x.open('GET', PROXY + '/qr/' + path, true);
    x.timeout = 6000;
    x.onload = function () {
      if (x.status !== 200) { reject(new Error('HTTP ' + x.status)); return; }
      try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(new Error('Invalid response')); }
    };
    x.onerror = function () { reject(new Error('Connection failed')); };
    x.ontimeout = function () { reject(new Error('Timeout')); };
    x.send();
  });
}

export const WebosQr: QrInbox = {
  open(kind) {
    return WebosProxy.check().then(function (ok) {
      // по Luna страница для телефона не работает — ей нужен HTTP-порт
      if (!ok && WebosProxy.luna) { const e: any = new Error(str('playlist_qr_no_http')); e.whole = true; throw e; }
      if (!ok) throw new Error(str('proxy_absent'));
      return get(kind === 'epg' ? 'new?kind=epg' : 'new');
    }).then(function (d) {
      if (!d.returnValue || !d.url || !d.token) throw new Error(d.error || 'service unavailable');
      return { url: d.url, token: d.token };
    });
  },
  poll(token) {
    return get('status?token=' + encodeURIComponent(token)).then(function (d) {
      if (!d.returnValue) throw new Error(d.error || 'expired');
      return d.ready && d.url ? { url: d.url, name: d.name || '' } : null;
    });
  },
  cancel(token) {
    get('cancel?token=' + encodeURIComponent(token)).then(null, function () { /* */ });
  },
};
