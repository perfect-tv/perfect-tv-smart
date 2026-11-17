import { CodeManifest, compareVersions, manifestVerdict } from './codever';
import { platform } from './platform';
import { Prefs } from './prefs';

/**
 * Обновление кода без переустановки (docs/TZ.md, «Обновление без переустановки»): версия с сайта
 * (https://perfect-tv.github.io/<платформа>/version.json) скачивается в фоне и применяется при
 * следующем запуске — его делает загрузчик оболочки (src/loader/run.ts, window.ptvLoader). Нет
 * загрузчика (старый пакет, браузер) или у платформы нет канала — ничего не делаем.
 */
export const CODE_SITE = 'https://perfect-tv.github.io/';

/** Первая проверка — через минуту после старта, дальше — раз в 12 ч (ТВ бывает включён сутками) */
const FIRST_MS = 60000;
const EVERY_MS = 12 * 3600 * 1000;

export interface LoaderApi { shell: number; builtin: string; version: string; source: string; ok(): void; bad(): string[] }

export function loader(): LoaderApi | null {
  const l = typeof window !== 'undefined' ? (window as any).ptvLoader : null;
  return l && typeof l.shell === 'number' ? l : null;
}

/**
 * Состояние: idle — не проверяли; checking / downloading; latest — новее нет; ready — скачана
 * version (применится при перезапуске); shell / service — на сайте version, но нужен новый пакет;
 * error — не удалось (сеть, сайт, проверка файлов); off — нет загрузчика.
 */
export type CodeStatus = 'off' | 'idle' | 'checking' | 'downloading' | 'latest' | 'ready' | 'shell' | 'service' | 'error';

let status: CodeStatus = 'idle';
let found = '';
let busy = false;
let timer = 0;
const listeners: ((s: CodeStatus) => void)[] = [];

function set(s: CodeStatus, v?: string) {
  status = s;
  if (v !== undefined) found = v;
  for (let i = 0; i < listeners.length; i++) { try { listeners[i](s); } catch (e) { /* */ } }
}

function getJson(url: string): Promise<any> {
  return new Promise(function (resolve, reject) {
    const x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = 20000;
    x.onload = function () {
      if (x.status !== 200) { reject(new Error('HTTP ' + x.status)); return; }
      try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); }
    };
    x.onerror = function () { reject(new Error('network')); };
    x.ontimeout = function () { reject(new Error('timeout')); };
    x.send();
  });
}

export const CodeUpdate = {
  /** Есть ли что обновлять (загрузчик и канал платформы) */
  get available(): boolean { return !!loader() && !!platform().code; },
  get status(): CodeStatus { return CodeUpdate.available ? status : 'off'; },
  /** Версия с сайта (скачанная или которую не поставить) */
  get found(): string { return found; },
  /** Запущенная версия кода и встроенная в пакет */
  get running(): string { const l = loader(); return l ? l.version : ''; },
  get builtin(): string { const l = loader(); return l ? l.builtin : ''; },
  get downloaded(): boolean { const l = loader(); return !!l && l.source === 'downloaded'; },

  onChange(l: (s: CodeStatus) => void) { listeners.push(l); },

  /** Начало работы: метка загрузчику и фоновые проверки */
  start() {
    const l = loader();
    if (l) l.ok();
    if (!CodeUpdate.available) return;
    console.log('code', l!.version, '(' + l!.source + ', built-in ' + l!.builtin + ', shell ' + l!.shell + ')');
    clearTimeout(timer);
    const tick = function (ms: number) {
      timer = window.setTimeout(function () {
        if (Prefs.codeAuto && status !== 'ready') CodeUpdate.check().then(null, function () { /* */ });
        tick(EVERY_MS);
      }, ms);
    };
    tick(FIRST_MS);
  },

  /** Проверить и скачать; результат — статус */
  check(): Promise<CodeStatus> {
    const l = loader(), ch = platform().code;
    if (!l || !ch) return Promise.resolve<CodeStatus>('off');
    if (busy) return Promise.resolve(status);
    busy = true;
    set('checking');
    // window.ptvCodeSite — свой адрес сайта для проверки (DevTools), иначе perfect-tv.github.io
    const base = ((window as any).ptvCodeSite || CODE_SITE) + ch.dir + '/';
    return getJson(base + 'version.json?t=' + Date.now()).then(function (m: CodeManifest) {
      // уже скачанная (ждёт перезапуска) считается своей: заново не качаем
      const have = status === 'ready' && found && compareVersions(found, l.version) > 0 ? found : l.version;
      const v = manifestVerdict(m, have, l.shell, ch.serviceApi(), l.bad());
      console.log('code update: site', m.version, 'running', l.version, v || 'download');
      if (v === 'same' || v === 'bad') { if (have !== l.version) { set('ready'); return status; } set('latest', m.version); return status; }
      if (v === 'shell' || v === 'service') { set(v, m.version); return status; }
      set('downloading', m.version);
      return ch.install(base, m).then(function () {
        console.log('code update: saved', m.version);
        set('ready', m.version);
        return status;
      });
    }).then(function (s: CodeStatus) { busy = false; return s; }, function (e: any) {
      busy = false;
      console.warn('code update failed', e && (e.message || e));
      set('error');
      return status;
    });
  },

  /** Перезапуск страницы: загрузчик возьмёт скачанную версию */
  restart() { location.reload(); },

  /** Вернуться к встроенной версии (при следующем запуске) */
  reset(): Promise<void> {
    const ch = platform().code;
    if (!ch) return Promise.resolve();
    return ch.clear().then(function () { set('idle', ''); });
  },
};
