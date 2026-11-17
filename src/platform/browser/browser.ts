import { RtcQr, rtcAvailable } from '../../core/qrrtc';
import { PlatformApi } from '../../core/platform';
import { IdbDb } from '../../core/data/idb';
import { BrowserKv } from './kv';
import { makeProxy } from './proxy';
import { Cursor } from './cursor';
import { browserName, WEB_LABELS, webStorageBytes } from './web';

/**
 * Обычный браузер и ТВ, где приложение — страница по адресу (VIDAA, Titan OS, MSX; docs/TZ.md,
 * §2 «Ядро и платформы»). Своего сервиса нет: настройки — localStorage, записи — IndexedDB,
 * программа разбирается здесь же (Loaders), прокси — только внешний (?proxy=; без адреса — строка
 * «не задан» в настройках и подсказка в ошибке).
 */
const proxy = makeProxy();

export const Browser: PlatformApi = {
  id: 'browser',
  label: browserName,
  boot: function () {
    return proxy.check().then(function () { /* */ });
  },
  // Выход — в начало истории вкладки: там то, откуда приложение открыли (меню MSX по link:, страница
  // ТВ). Само приложение историю не пишет. Открыто первым во вкладке — закрыть её
  exit: function () {
    try {
      if (history.length > 1) { history.go(1 - history.length); return; }
    } catch (e) { /* */ }
    try { window.close(); } catch (e) { /* */ }
  },
  cursorVisible: Cursor.visible,
  onCursor: Cursor.on,
  // нет MSE (Safari на iPhone, часть ТВ) — HLS играет сам элемент video
  defaultHlsEngine: typeof window !== 'undefined' && ((window as any).MediaSource || (window as any).WebKitMediaSource) ? 0 : 2,
  kv: BrowserKv,
  db: IdbDb,
  proxy: proxy,
  epg: null,
  // QR — через WebRTC (страница perfect-tv.github.io/send/), если он есть
  qr: rtcAvailable() ? RtcQr : null,
  nativePlayer: null,
  storageBytes: webStorageBytes,
  labels: WEB_LABELS,
  code: null,
};
