import './polyfills';
import { CodeUpdate } from './codeupdate';
import { str } from './lang';
import { Log } from './log';
import { platform } from './platform';
import { Prefs } from './prefs';
import { Storage2 } from './storage';
import { restyle } from './ui/style';
import { Tv } from './ui/tv';
import { U } from './ui/u';

/** Интерфейс — после подготовки платформы и чтения настроек */
function initUi() {
  // настройки прочитаны: размер и «Облегчённый интерфейс» — уже свои
  U.init();
  restyle();
  const video = document.getElementById('video') as HTMLVideoElement;
  const ui = document.getElementById('ui') as HTMLElement;
  const tv = new Tv(video, ui);
  (window as any).tv = tv;
  CodeUpdate.onChange(function (s) { if (s === 'ready') tv.toast.show(str('code_ready_toast', CodeUpdate.found)); });

  document.addEventListener('keydown', function (e) {
    const t = e.target as HTMLElement;
    if (t && t.tagName === 'INPUT') return;
    if (tv.keyDown(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('keyup', function (e) {
    const t = e.target as HTMLElement;
    if (t && t.tagName === 'INPUT') return;
    if (tv.keyUp(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('blur', function () { tv.keys.reset(); });
  let wheelAcc = 0, wheelAt = 0;
  document.addEventListener('wheel', function (e) {
    e.preventDefault();
    const now = Date.now();
    if (now - wheelAt > 250) wheelAcc = 0;
    wheelAt = now;
    wheelAcc += e.deltaY || 0;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { tv.wheel(0, e.deltaX); return; }
    if (Math.abs(wheelAcc) >= 40 || e.deltaMode === 1) { tv.wheel(wheelAcc > 0 ? 1 : -1, 0); wheelAcc = 0; }
  }, { passive: false } as any);
  platform().onCursor(function (v) { document.body.className = v ? '' : 'nocursor'; });
  window.addEventListener('resize', function () { U.init(); tv.relabel(); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) tv.playback.pause(); else if (tv.hasVideo()) tv.playback.resume();
  });
  tv.start();
}

/**
 * Запуск приложения — из точки входа платформы (src/platform/<имя>/main.ts) после usePlatform:
 * платформа готовит сервис и данные, затем настройки, затем интерфейс.
 */
export function startApp() {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}

function boot() {
  // загрузчику оболочки — код поднялся (иначе откат на встроенный), затем фоновые проверки обновлений
  CodeUpdate.start();
  Log.install();
  console.log('platform', platform().label(), 'screen', window.innerWidth + 'x' + window.innerHeight);
  U.init();
  restyle();
  platform().boot().then(null, function (e) { console.error('platform boot', e); }).then(function () {
    return Storage2.bootstrap();
  }).then(function () {
    Prefs.reload();
    initUi();
  }, function (e) {
    console.error('storage startup', e);
    initUi();
  });
}
