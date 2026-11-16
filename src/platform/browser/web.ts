import { PlatformLabels } from '../../core/platform';

/* Общее для платформ без своего сервиса (browser, tizen) — без побочных действий при импорте */

/** Подписи страницы «Сеть» и ошибки «нужен прокси» для платформ без сервиса */
export const WEB_LABELS: PlatformLabels = {
  proxy: 'web_proxy', proxySub: 'web_proxy_sub', proxyMode: 'web_proxy_mode',
  storage: 'web_storage', storageSub: 'web_storage_sub', needProxy: 'web_need_proxy',
};

/** Сколько занимают данные страницы (IndexedDB, localStorage), байт; −1 — неизвестно */
export function webStorageBytes(): Promise<number> {
  const n: any = typeof navigator !== 'undefined' ? navigator : null;
  if (n && n.storage && n.storage.estimate) return n.storage.estimate().then(function (e: any) { return typeof e.usage === 'number' ? e.usage : -1; }, function () { return -1; });
  return Promise.resolve(-1);
}

export function browserName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const m = /(VIDAA|Titan|Tizen|Web0S|Firefox|Edg|OPR|YaBrowser|Chrome|Chromium|Safari)\/?\s?([\d.]*)/.exec(ua);
  return m ? m[1] + (m[2] ? ' ' + m[2] : '') : ua.slice(0, 40);
}
