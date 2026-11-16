import { NativeEngine, PlaybackListener, PlayOpts, Track } from '../../core/player/playback';
import { screenSaver } from './saver';

/**
 * AVPlay — встроенный плеер Samsung (webapis.avplay): HLS и MPEG-TS с тем, чего не умеет hls.js
 * в браузере ТВ (AC-3/MP2, I-кадры без IDR, телетекст в потоке), и свой User-Agent. Видео рисуется
 * на отдельной плоскости под страницей: элемент <object type="application/avplayer"> — «окно»
 * в неё, он стоит на месте <video> (под интерфейсом). Координаты setDisplayRect — в пикселях
 * экрана 1920×1080 при любом размере страницы. Заголовки канала: только User-Agent (без него —
 * UA браузера ТВ); Referer и прочие AVPlay не ставит — для них нужен прокси, на Tizen его нет.
 */
const w: any = typeof window !== 'undefined' ? window : {};

export function avplayAvailable(): boolean {
  return !!(w.webapis && w.webapis.avplay);
}

function av(): any { return w.webapis.avplay; }

function extra(t: any): any {
  try { return typeof t.extra_info === 'string' ? JSON.parse(t.extra_info) : t.extra_info || {}; } catch (e) { return {}; }
}

export function createAvplay(l: PlaybackListener): NativeEngine {
  let obj: HTMLElement | null = null;
  let active = false;
  let ready = false;
  let gen = 0;
  let height = 0;
  let aspect = 0;
  let isLive = false;

  function ensureObject() {
    if (obj) return;
    obj = document.createElement('object');
    obj.setAttribute('type', 'application/avplayer');
    obj.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:none';
    const video = document.getElementById('video');
    if (video && video.parentNode) video.parentNode.insertBefore(obj, video.nextSibling);
    else document.body.insertBefore(obj, document.body.firstChild);
  }

  function rect() {
    // страница может быть меньше экрана (масштаб) — AVPlay считает в пикселях 1920×1080
    try { av().setDisplayRect(0, 0, 1920, 1080); } catch (e) { /* */ }
  }

  function applyAspect() {
    const m = aspect === 1 ? 'PLAYER_DISPLAY_MODE_FULL_SCREEN' : aspect === 2 ? 'PLAYER_DISPLAY_MODE_CROPPED_FULL' : 'PLAYER_DISPLAY_MODE_LETTER_BOX';
    try { av().setDisplayMethod(m); } catch (e) {
      try { av().setDisplayMethod(aspect === 1 ? 'PLAYER_DISPLAY_MODE_FULL_SCREEN' : 'PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e2) { /* */ }
    }
  }

  function sizeFromInfo() {
    try {
      const info = av().getCurrentStreamInfo() || [];
      for (let i = 0; i < info.length; i++) {
        if (info[i].type !== 'VIDEO') continue;
        const x = extra(info[i]);
        const wd = parseInt(x.Width || x.width || '0', 10), ht = parseInt(x.Height || x.height || '0', 10);
        if (ht) { height = ht; l.onVideoSize(wd, ht); }
      }
    } catch (e) { /* */ }
  }

  function state(): string { try { return av().getState(); } catch (e) { return 'NONE'; } }

  function closePlayer() {
    try { const s = state(); if (s === 'PLAYING' || s === 'PAUSED' || s === 'READY') av().stop(); } catch (e) { /* */ }
    try { av().close(); } catch (e) { /* */ }
  }

  function errorKind(e: any): 'network' | 'media' {
    const s = String(e && (e.name || e.message || e) || '');
    return /CONNECTION|NETWORK|TIMEOUT|INVALID_URI|NOT_CONNECTED|FILE_NOT|STREAMING/i.test(s) ? 'network' : 'media';
  }

  function selectAudio(lang: string) {
    if (!lang) return;
    try {
      const all = av().getTotalTrackInfo() || [];
      for (let i = 0; i < all.length; i++) {
        if (all[i].type !== 'AUDIO') continue;
        const x = extra(all[i]);
        if ((x.language || '') === lang) { av().setSelectTrack('AUDIO', all[i].index); return; }
      }
    } catch (e) { /* */ }
  }

  const engine: NativeEngine = {
    play(url: string, opts: PlayOpts, audioLang: string) {
      ensureObject();
      engine.stop();
      const my = ++gen;
      active = true;
      ready = false;
      height = 0;
      isLive = true;
      obj!.style.display = 'block';
      const video = document.getElementById('video');
      if (video) video.style.visibility = 'hidden';
      l.onState(false, true);
      try {
        av().open(url);
        rect();
        applyAspect();
        // User-Agent канала, иначе — браузера ТВ, как у прямых запросов и hls.js (провайдеры считают
        // устройства по UA; свой «samsung-agent/1.1» AVPlay кое-где не пускают)
        const h = opts.headers || {};
        let ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
        for (const k in h) if (k.toLowerCase() === 'user-agent') ua = h[k];
        if (ua) { try { av().setStreamingProperty('USER_AGENT', ua); } catch (e) { /* */ } }
        av().setListener({
          onbufferingstart: function () { if (my === gen) l.onState(true, true); },
          onbufferingprogress: function () { /* */ },
          onbufferingcomplete: function () { if (my === gen) l.onState(state() === 'PLAYING', false); },
          oncurrentplaytime: function () {
            if (my !== gen || ready) return;
            ready = true;
            screenSaver(true);
            sizeFromInfo();
            l.onState(true, false);
            l.onReady();
          },
          onstreamcompleted: function () { if (my === gen) { screenSaver(false); l.onEnded(); } },
          onerror: function (e: any) { if (my === gen) { console.warn('avplay error', e); l.onError(errorKind(e), String(e)); } },
          onevent: function (type: any, data: any) { if (my === gen) console.log('avplay event', type, data); },
          onsubtitlechange: function () { /* субтитры AVPlay — позже */ },
          ondrmevent: function () { /* */ },
        });
        av().prepareAsync(function () {
          if (my !== gen) return;
          try {
            const d = av().getDuration();
            isLive = !(d > 0);
          } catch (e) { /* */ }
          selectAudio(audioLang);
          l.onTracks();
          try { av().play(); } catch (e) { l.onError('media', String(e)); }
        }, function (e: any) {
          if (my !== gen) return;
          console.warn('avplay prepare', e);
          l.onError(errorKind(e), 'prepare ' + String(e && (e.name || e)));
        });
      } catch (e) {
        console.warn('avplay open', e);
        l.onError(errorKind(e), 'open ' + String((e as any) && ((e as any).name || e)));
      }
    },

    stop() {
      if (!active) return;
      gen++;
      active = false;
      closePlayer();
      screenSaver(false);
      if (obj) obj.style.display = 'none';
      const video = document.getElementById('video');
      if (video) video.style.visibility = '';
    },

    pause() { try { av().pause(); screenSaver(false); l.onState(false, false); } catch (e) { /* */ } },
    resume() { try { av().play(); screenSaver(true); l.onState(true, false); } catch (e) { /* */ } },

    get paused() { return active && state() === 'PAUSED'; },
    get positionMs() { try { return active ? av().getCurrentTime() : 0; } catch (e) { return 0; } },
    get height() { return height; },
    get live() { return isLive; },

    tracks(): Track[] {
      const out: Track[] = [];
      if (!active) return out;
      try {
        const all = av().getTotalTrackInfo() || [];
        let cur = -1;
        try {
          const info = av().getCurrentStreamInfo() || [];
          for (let i = 0; i < info.length; i++) if (info[i].type === 'AUDIO') cur = info[i].index;
        } catch (e) { /* */ }
        for (let i = 0; i < all.length; i++) {
          if (all[i].type !== 'AUDIO') continue;
          const x = extra(all[i]);
          const lang = x.language || '';
          out.push({ id: all[i].index, kind: 'audio', lang: lang, label: lang || String(out.length + 1), selected: all[i].index === cur });
        }
      } catch (e) { /* */ }
      return out;
    },

    selectTrack(t: Track | null, kind: 'audio' | 'text') {
      if (kind === 'audio' && t) { try { av().setSelectTrack('AUDIO', t.id); } catch (e) { console.warn('avplay track', e); } }
    },

    setAspect(mode: number) {
      aspect = mode;
      if (active) applyAspect();
    },
  };
  return engine;
}
