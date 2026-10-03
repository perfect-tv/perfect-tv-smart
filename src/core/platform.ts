/**
 * Платформа webOS: Luna (через PalmServiceBridge — то же, что делает webOSTV.js), JS-сервис,
 * выход в лаунчер, курсор Magic Remote. В браузере — заглушки.
 */
declare const PalmSystem: any;
declare const PalmServiceBridge: any;

const w: any = typeof window !== 'undefined' ? window : {};
const isWebOS = typeof w.PalmSystem !== 'undefined' || typeof w.PalmServiceBridge !== 'undefined';

export const APP_ID = 'top.rootu.perfecttv';
export const SERVICE_ID = 'top.rootu.perfecttv.service';

const bridges: any[] = [];

/** Вызов Luna; subscribe — callback вызывается на каждый ответ. Возвращает функцию отмены */
function luna(uri: string, params: any, cb?: (r: any) => void): () => void {
  if (typeof w.PalmServiceBridge === 'undefined') { if (cb) cb({ returnValue: false, errorText: 'no bridge' }); return function () { /* */ }; }
  const b = new w.PalmServiceBridge();
  bridges.push(b); // держим ссылку: иначе подписку соберёт сборщик мусора
  b.onservicecallback = function (msg: string) {
    let r: any;
    try { r = JSON.parse(msg); } catch (e) { r = { returnValue: false }; }
    if (cb) cb(r);
  };
  b.call(uri, JSON.stringify(params || {}));
  return function () {
    try { b.cancel(); } catch (e) { /* */ }
    const i = bridges.indexOf(b);
    if (i >= 0) bridges.splice(i, 1);
  };
}

let cursorVisible = false;
const cursorListeners: ((v: boolean) => void)[] = [];
if (typeof document !== 'undefined') {
  document.addEventListener('cursorStateChange', function (e: any) {
    cursorVisible = !!(e.detail && e.detail.visibility);
    for (let i = 0; i < cursorListeners.length; i++) cursorListeners[i](cursorVisible);
  }, false);
}

let serviceStarted = false;

export const Platform = {
  isWebOS: isWebOS,
  luna: luna,

  /** Версия webOS ('6.0.0'…) или '' */
  version(): string {
    try {
      if (typeof w.PalmSystem !== 'undefined' && w.PalmSystem.deviceInfo) {
        const d = JSON.parse(w.PalmSystem.deviceInfo);
        return d.platformVersion || '';
      }
    } catch (e) { /* */ }
    return '';
  },

  /** Поднять JS-сервис с прокси; подписка держит его живым, пока открыто приложение */
  startService() {
    if (serviceStarted || !isWebOS) return;
    serviceStarted = true;
    console.log('service: luna start');
    luna('luna://' + SERVICE_ID + '/start', { subscribe: true }, function (r) {
      // ответ сервиса: порт прокси или ошибка (нет сервиса, не открылся порт)
      if (r.returnValue) console.log('service: started, port', r.port);
      else console.warn('service: failed', r.errorCode || '', r.errorText || r.error || JSON.stringify(r));
    });
    // в журнал: отвечает ли сервис без подписки; модель и версия webOS
    luna('luna://' + SERVICE_ID + '/ping', {}, function (r) { console.log('service: ping', JSON.stringify(r)); });
    luna('luna://com.webos.service.tv.systemproperty/getSystemInfo', { keys: ['modelName', 'sdkVersion', 'firmwareVersion'] }, function (r) { console.log('system', JSON.stringify(r)); });
  },

  /** Выход: на ТВ — в лаунчер, в браузере — закрыть вкладку */
  exit() {
    try {
      if (typeof w.PalmSystem !== 'undefined' && w.PalmSystem.platformBack) { w.PalmSystem.platformBack(); return; }
    } catch (e) { /* */ }
    try { window.close(); } catch (e) { /* */ }
  },

  get cursorVisible() { return cursorVisible; },
  onCursor(l: (v: boolean) => void) { cursorListeners.push(l); },

  /** Не гасить экран во время просмотра (на ТВ — держит сама система при играющем видео) */
  keepAwake(_on: boolean) { /* */ },
};
