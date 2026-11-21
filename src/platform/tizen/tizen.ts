import { RtcQr, rtcAvailable } from '../../core/qrrtc';
import { PlatformApi } from '../../core/platform';
import { IdbDb } from '../../core/data/idb';
import { BrowserKv } from '../browser/kv';
import { Cursor } from '../browser/cursor';
import { browserName, WEB_LABELS, webStorageBytes } from '../browser/web';
import { avplayAvailable, createAvplay } from './avplay';
import { screenSaver } from './saver';
import { clearTizenCode, installTizenCode } from './codestore';

/**
 * Samsung Tizen TV 3.0+ (2017+, Chromium 47+; docs/TZ.md, §2 «Ядро и платформы»). Упакованное
 * веб-приложение (.wgt, config.xml): чужие серверы доступны без CORS (`<access origin="*">`),
 * своего сервиса нет — настройки в localStorage, записи в IndexedDB, программа — в воркере ядра.
 * Прокси нет: заголовки канала (User-Agent, Referer) плеер в браузере поставить не может.
 * Клавиши пульта сверх стрелок, OK и «Назад» нужно зарегистрировать (tvinputdevice), иначе их
 * забирает система; «Exit» — выход. Заставку на время просмотра выключает webapis.appcommon.
 * «Плеер телевизора» — AVPlay (avplay.ts).
 */
const w: any = typeof window !== 'undefined' ? window : {};

/** Клавиши пульта, которые приложение берёт себе (имена — tizen.tvinputdevice) */
const KEYS = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'ChannelUp', 'ChannelDown', 'ChannelList', 'PreviousChannel',
  'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
  'MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaRewind', 'MediaFastForward',
  'Info', 'Guide', 'Tools', 'Search', 'Exit',
];
const EXIT = 10182;

function registerKeys() {
  const input = w.tizen && w.tizen.tvinputdevice;
  if (!input) return;
  let supported: { [name: string]: boolean } | null = null;
  try {
    supported = {};
    const list = input.getSupportedKeys();
    for (let i = 0; i < list.length; i++) supported[list[i].name] = true;
  } catch (e) { supported = null; }
  const names = KEYS.filter(function (k) { return !supported || supported[k]; });
  try {
    if (input.registerKeyBatch) { input.registerKeyBatch(names); return; }
  } catch (e) { /* по одной ниже */ }
  for (let i = 0; i < names.length; i++) { try { input.registerKey(names[i]); } catch (e) { /* нет на этом пульте */ } }
}

function exit() {
  try { w.tizen.application.getCurrentApplication().exit(); return; } catch (e) { /* */ }
  try { window.close(); } catch (e) { /* */ }
}

function label(): string {
  let v = '', model = '';
  try { v = w.tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version') || ''; } catch (e) { /* */ }
  try { model = w.webapis.productinfo.getModel() || ''; } catch (e) { /* */ }
  return v ? 'Tizen ' + v + (model ? ' · ' + model : '') : browserName();
}

export const Tizen: PlatformApi = {
  id: 'tizen',
  label: label,
  boot: function () {
    registerKeys();
    document.addEventListener('keydown', function (e) { if (e.keyCode === EXIT) { e.preventDefault(); exit(); } }, true);
    const video = document.getElementById('video');
    if (video) {
      video.addEventListener('playing', function () { screenSaver(true); }, false);
      video.addEventListener('pause', function () { screenSaver(false); }, false);
      video.addEventListener('ended', function () { screenSaver(false); }, false);
      video.addEventListener('emptied', function () { screenSaver(false); }, false);
    }
    console.log('tizen', label(), w.tizen ? 'api' : 'no tizen api', w.webapis ? 'webapis' : 'no webapis');
    return Promise.resolve();
  },
  exit: exit,
  cursorVisible: Cursor.visible,
  onCursor: Cursor.on,
  // AVPlay есть — «авто»: эфир им (AC-3, I-кадры без IDR, свой User-Agent), архив — hls.js
  get defaultHlsEngine() { return avplayAvailable() ? 2 : 0; },
  get nativeHls() { return avplayAvailable(); },
  kv: BrowserKv,
  db: IdbDb,
  proxy: null,
  epg: null,
  // QR — через WebRTC (страница perfect-tv.github.io/send/)
  qr: rtcAvailable() ? RtcQr : null,
  get nativePlayer() { return avplayAvailable() ? createAvplay : null; },
  // AVPlay: setStreamingProperty USER_AGENT и COOKIE; Referer и прочие заголовки он не ставит
  get nativeHeaders() { return avplayAvailable() ? ['user-agent', 'cookie'] : []; },
  storageBytes: webStorageBytes,
  labels: WEB_LABELS,
  code: { dir: 'tizen', serviceApi: function () { return 0; }, install: installTizenCode, clear: clearTizenCode },
};
