import { PlatformApi } from '../../core/platform';
import { IdbDb } from '../../core/data/idb';
import { BrowserKv } from './kv';
import { makeProxy } from './proxy';

/**
 * Обычный браузер и ТВ, где приложение — страница по адресу (VIDAA, Titan OS, MSX; docs/TZ.md,
 * §2 «Ядро и платформы»). Своего сервиса нет: настройки — localStorage, записи — IndexedDB,
 * программа разбирается здесь же (Loaders), прокси — только внешний (?proxy=; без адреса — строка
 * «не задан» в настройках и подсказка в ошибке).
 */
const proxy = makeProxy();

let cursor = false;
let cursorTimer = 0;
const cursorListeners: ((v: boolean) => void)[] = [];
function setCursor(v: boolean) {
  if (v === cursor) return;
  cursor = v;
  for (let i = 0; i < cursorListeners.length; i++) cursorListeners[i](v);
}
if (typeof document !== 'undefined') {
  // курсор (мышь, указка пульта) — пока ею двигают и 3 с после
  document.addEventListener('mousemove', function () {
    setCursor(true);
    clearTimeout(cursorTimer);
    cursorTimer = window.setTimeout(function () { setCursor(false); }, 3000);
  }, false);
  document.addEventListener('keydown', function () { clearTimeout(cursorTimer); setCursor(false); }, true);
}

function browserName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const m = /(VIDAA|Titan|Tizen|Web0S|Firefox|Edg|OPR|YaBrowser|Chrome|Chromium|Safari)\/?\s?([\d.]*)/.exec(ua);
  return m ? m[1] + (m[2] ? ' ' + m[2] : '') : ua.slice(0, 40);
}

export const Browser: PlatformApi = {
  id: 'browser',
  label: browserName,
  boot: function () {
    return proxy.check().then(function () { /* */ });
  },
  exit: function () {
    try { window.close(); } catch (e) { /* */ }
    try { history.back(); } catch (e) { /* */ }
  },
  cursorVisible: function () { return cursor; },
  onCursor: function (l) { cursorListeners.push(l); },
  // нет MSE (Safari на iPhone, часть ТВ) — HLS играет сам элемент video
  defaultHlsEngine: typeof window !== 'undefined' && ((window as any).MediaSource || (window as any).WebKitMediaSource) ? 0 : 2,
  kv: BrowserKv,
  db: IdbDb,
  proxy: proxy,
  epg: null,
  qr: null,
  storageBytes: function () {
    const n: any = typeof navigator !== 'undefined' ? navigator : null;
    if (n && n.storage && n.storage.estimate) return n.storage.estimate().then(function (e: any) { return typeof e.usage === 'number' ? e.usage : -1; }, function () { return -1; });
    return Promise.resolve(-1);
  },
  labels: {
    proxy: 'web_proxy', proxySub: 'web_proxy_sub', proxyMode: 'web_proxy_mode',
    storage: 'web_storage', storageSub: 'web_storage_sub', needProxy: 'web_need_proxy',
  },
};
