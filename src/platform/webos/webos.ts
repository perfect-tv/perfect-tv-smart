import { PlatformApi, SERVICE_LABELS } from '../../core/platform';
import { WebosDb } from './db';
import { WebosEpg } from './epg';
import { WebosKv } from './kv';
import { Luna } from './luna';
import { WebosProxy } from './proxy';
import { WebosQr } from './qr';
import { SocketDb } from './socketdb';

/**
 * LG webOS 3+ (docs/TZ.md, §2). Рядом с приложением — JS-сервис на Node (service/): прокси,
 * хранилище в файлах, разбор программы, страница для телефона. Без сервиса (сборка в обычном
 * браузере, `npm run dev`) — то же, если запущен `npm run proxy`; иначе только прямые запросы.
 */
export const WebOS: PlatformApi = {
  id: 'webos',
  label: function () {
    return Luna.isWebOS ? 'webOS ' + (Luna.version() || '')
      : typeof navigator !== 'undefined' ? navigator.userAgent.replace(/^.*(Chrom(e|ium)\/[\d.]+).*$/, '$1') : '';
  },
  boot: function () {
    Luna.startService();
    return WebosProxy.check().then(function (ok) {
      console.log('service transport', ok ? 'HTTP localhost' : WebosProxy.luna ? 'Luna streaming' : 'unavailable');
      return WebosDb.migrate();
    });
  },
  exit: function () { Luna.exit(); },
  cursorVisible: function () { return Luna.cursorVisible; },
  onCursor: function (l) { Luna.onCursor(l); },
  // встроенный плеер webOS сам играет HLS и MPEG-TS; в браузере для проверки — hls.js
  defaultHlsEngine: Luna.isWebOS ? 2 : 0,
  kv: WebosKv,
  db: WebosDb,
  proxy: WebosProxy,
  epg: WebosEpg,
  qr: WebosQr,
  nativePlayer: null,
  storageBytes: function () {
    return SocketDb.available().then(function (ok) { return ok ? SocketDb.storageBytes() : -1; });
  },
  labels: SERVICE_LABELS,
};
