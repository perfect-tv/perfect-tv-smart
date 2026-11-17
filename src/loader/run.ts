import { CODE_FILES, CodeRecord, SHELL, useDownloaded } from '../core/codever';

/**
 * Загрузчик оболочки webOS / Tizen (docs/TZ.md, «Обновление без переустановки»). Лежит в пакете
 * и сам не обновляется: запускает скачанный с сайта код, если он подходит, иначе — встроенный в
 * пакет. Сайт для запуска не нужен: проверка и скачивание — в самом приложении
 * (core/codeupdate.ts), в фоне после старта.
 *
 * Где лежит скачанный код — у платформы (CodeStore): webOS — файлы сервиса (браузерное хранилище
 * там переполняется), Tizen — IndexedDB.
 *
 * Защита от сбоев: перед запуском скачанной версии — метка «запускается X»; код снимает её в
 * начале работы (ptvLoader.ok()). Ошибка до этого — X в сбойные и перезапуск на встроенном;
 * метка осталась с прошлого раза (завис, упал) — то же при следующем старте.
 */
declare const APP_VERSION: string;

export interface CodeStore {
  /** Скачанный код без файлов (null — нет), метка запуска, сбойные версии */
  meta(): Promise<{ rec: CodeRecord | null; boot: string; bad: string[] }>;
  /** Файлы скачанной версии */
  files(rec: CodeRecord): Promise<{ [name: string]: string }>;
  /** Метка запуска ('' — снять) и/или сбойная версия */
  state(boot: string | null, bad: string | null): Promise<void>;
}

/** Сколько ждать хранилище, прежде чем запуститься встроенным */
const META_TIMEOUT = 6000;

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

export function runLoader(store: CodeStore) {
  const builtin = typeof APP_VERSION === 'string' ? APP_VERSION : '0';
  let confirmed = false;
  let bad: string[] = [];

  /** API для кода приложения (window.ptvLoader); менять — вместе с SHELL */
  const api = {
    shell: SHELL,
    builtin: builtin,
    /** Версия запущенного кода и откуда он: 'builtin' | 'downloaded' */
    version: builtin,
    source: 'builtin',
    /** Код поднялся: снять метку */
    ok: function () {
      if (confirmed) return;
      confirmed = true;
      if (api.source === 'downloaded') store.state('', null).then(null, function () { /* */ });
    },
    /** Сбойные версии (их не ставить снова) */
    bad: function () { return bad.slice(); },
  };
  (window as any).ptvLoader = api;

  function runBuiltin() {
    api.version = builtin;
    api.source = 'builtin';
    let i = 0;
    const next = function () {
      if (i >= CODE_FILES.length) return;
      const s = document.createElement('script');
      s.src = CODE_FILES[i++];
      s.onload = next;
      document.body.appendChild(s);
    };
    next();
  }

  function runDownloaded(rec: CodeRecord, files: { [name: string]: string }) {
    api.version = rec.version;
    api.source = 'downloaded';
    // ошибка до ok() — код не поднялся: в сбойные и заново на встроенном
    const prev = window.onerror;
    window.onerror = function () {
      if (!confirmed) {
        confirmed = true;
        console.error('downloaded code ' + rec.version + ' failed, back to built-in ' + builtin);
        const reload = function () { location.reload(); };
        timeout(store.state('', rec.version), 3000).then(reload, reload);
        return true;
      }
      return prev ? (prev as any).apply(window, arguments) : false;
    };
    for (let i = 0; i < CODE_FILES.length; i++) {
      const s = document.createElement('script');
      s.text = files[CODE_FILES[i]];
      document.body.appendChild(s);
    }
  }

  function start() {
    timeout(store.meta(), META_TIMEOUT).then(function (m) {
      bad = m.bad || [];
      // метка с прошлого запуска не снята — та версия не поднялась
      if (m.boot) {
        if (bad.indexOf(m.boot) < 0) bad.push(m.boot);
        return timeout(store.state('', m.boot), 3000).then(null, function () { /* */ }).then(function () { return m.rec; });
      }
      return m.rec;
    }).then(function (rec) {
      if (!rec || !useDownloaded(rec, SHELL, builtin, bad)) return runBuiltin();
      const r = rec;
      return timeout(store.files(r), 15000).then(function (files) {
        const full: CodeRecord = { version: r.version, shell: r.shell, service: r.service, files: files, saved: r.saved };
        if (!useDownloaded(full, SHELL, builtin, bad)) return runBuiltin();
        return timeout(store.state(r.version, null), 3000).then(function () { runDownloaded(r, files); });
      });
    }).then(null, function (e) {
      console.warn('loader: built-in code', e && (e.message || e));
      if (api.source !== 'downloaded') runBuiltin();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}
