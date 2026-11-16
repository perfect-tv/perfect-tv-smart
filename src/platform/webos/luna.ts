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
  try { b.call(uri, JSON.stringify(params || {})); }
  catch (e) { if (cb) cb({ returnValue: false, errorText: String(e) }); }
  return function () {
    try { b.cancel(); } catch (e) { /* */ }
    const i = bridges.indexOf(b);
    if (i >= 0) bridges.splice(i, 1);
  };
}

/** Однократный запрос к своему Node-сервису по системной шине webOS. */
function requestService(method: string, params: any, timeoutMs = 45000): Promise<any> {
  return new Promise<any>(function (resolve, reject) {
    if (typeof w.PalmServiceBridge === 'undefined') {
      reject(new Error('PalmServiceBridge unavailable'));
      return;
    }
    let bridge: any;
    try { bridge = new w.PalmServiceBridge(); }
    catch (e) { reject(e); return; }
    bridges.push(bridge);
    let finished = false;
    const timer = setTimeout(function () { finish(new Error('Luna timeout: ' + method), null); }, timeoutMs);
    function finish(error: any, response: any) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { bridge.cancel(); } catch (e) { /* */ }
      const i = bridges.indexOf(bridge);
      if (i >= 0) bridges.splice(i, 1);
      if (error) reject(error);
      else resolve(response);
    }
    bridge.onservicecallback = function (raw: string) {
      let result: any;
      try { result = JSON.parse(raw); }
      catch (e) { finish(new Error('Invalid Luna response: ' + method), null); return; }
      finish(null, result);
    };
    try { bridge.call('luna://' + SERVICE_ID + '/' + method, JSON.stringify(params || {})); }
    catch (e) { finish(e, null); }
  });
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
  requestService: requestService,

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
    luna('luna://' + SERVICE_ID + '/start', { subscribe: true, ua: typeof navigator !== 'undefined' ? navigator.userAgent : '' }, function (r) {
      // ответ сервиса: порт прокси или ошибка (нет сервиса, не открылся порт)
      if (r.returnValue) {
        console.log('service: Luna started, Node', r.node || '?', 'HTTP', r.proxyReady ? 'ready' : 'unavailable');
        if (r.proxyError) console.warn('service: TCP listener failed', r.proxyError);
      }
      else {
        serviceStarted = false; // следующий Net.checkProxy сможет повторить запуск
        console.warn('service: failed', r.errorCode || '', r.errorText || r.error || JSON.stringify(r));
      }
    });
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
