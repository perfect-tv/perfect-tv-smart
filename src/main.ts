import './core/polyfills';
import { Log } from './core/log';
import { Net } from './core/net';
import { Platform } from './core/platform';
import { css } from './ui/style';
import { Tv } from './ui/tv';
import { U } from './ui/u';

/**
 * Запуск: стили, масштаб (1 em = высота / 48), видео и слои, клавиши пульта, колесо
 * и курсор Magic Remote, прокси (JS-сервис). Клавиши идут в Tv мимо фокуса браузера —
 * кроме полей ввода форм (там своя экранная клавиатура системы).
 */
function boot() {
  Log.install();
  console.log('webOS', Platform.isWebOS ? Platform.version() || '?' : '-', 'screen', window.innerWidth + 'x' + window.innerHeight);
  U.init();
  const style = document.createElement('style');
  style.textContent = css();
  document.head.appendChild(style);
  const video = document.getElementById('video') as HTMLVideoElement;
  const ui = document.getElementById('ui') as HTMLElement;
  const tv = new Tv(video, ui);
  (window as any).tv = tv;

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
  // колесо Magic Remote: по шагу на «щелчок»
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
  // курсор Magic Remote: пока виден — мышь; стрелки его скрывают
  Platform.onCursor(function (v) { document.body.className = v ? '' : 'nocursor'; });
  window.addEventListener('resize', function () { U.init(); tv.relabel(); });
  // webOS: приложение ушло в фон — пауза, вернулось — продолжить
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) tv.playback.pause(); else if (tv.hasVideo()) tv.playback.resume();
  });
  document.addEventListener('webOSRelaunch', function () { /* повторный запуск из лаунчера — остаёмся где были */ });

  Net.init().then(function (ok) {
    console.log('proxy', ok ? 'ok' : 'absent');
    tv.start();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
