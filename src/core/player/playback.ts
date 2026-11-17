import { platform } from '../platform';

/**
 * Воспроизведение (docs/TZ.md, §8): один <video> на всё время; HLS — hls.js (MSE), остальное
 * и запасной вариант — встроенный плеер телевизора: video.src или свой плеер платформы
 * (PlatformApi.nativePlayer — на Tizen AVPlay), тогда engine === 'native' и всё идёт в него.
 *
 * Время: «окно» — доступный для перемотки отрезок потока (seekable). Для HLS с
 * #EXT-X-PROGRAM-DATE-TIME известна эпоха медиа-времени 0 (pdtBase, мс): время кадра —
 * pdtBase + currentTime. Позиции в seekTo — миллисекунды от начала окна, как в Android-версии.
 */
declare const Hls: any;

export interface PlayOpts {
  /** Начать с начала окна (архив; иначе hls.js начнёт «растущий» плейлист у края) */
  fromStart: boolean;
  /** Встроенный плеер вместо hls.js */
  native: boolean;
  /** Тип: 'hls' — заведомо HLS (ссылка без расширения) */
  forceHls?: boolean;
  /** Заголовки канала, если ссылка не через прокси (их умеет поставить только плеер платформы) */
  headers?: { [k: string]: string } | null;
}

/** Встроенный плеер платформы вместо video.src (AVPlay на Tizen): рисует видео сам, под интерфейсом */
export interface NativeEngine {
  play(url: string, opts: PlayOpts, audioLang: string): void;
  stop(): void;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  /** Медиа-время, мс */
  readonly positionMs: number;
  readonly height: number;
  readonly live: boolean;
  tracks(): Track[];
  selectTrack(t: Track | null, kind: 'audio' | 'text'): void;
  setAspect(mode: number): void;
}

export interface Track { id: number; kind: 'audio' | 'text'; lang: string; label: string; selected: boolean }

export interface PlaybackListener {
  onState(playing: boolean, buffering: boolean): void;
  /** Первые данные ссылки (можно ставить позицию) */
  onReady(): void;
  onEnded(): void;
  /** Фатальная ошибка: network — сеть / CORS, media — декодер / формат, live — отстали от окна эфира */
  onError(kind: 'network' | 'media' | 'live', detail: string): void;
  onVideoSize(w: number, h: number): void;
  onTracks(): void;
}

export function isHlsUrl(url: string): boolean {
  const path = url.split('?')[0].split('#')[0];
  return /\.m3u8?$/i.test(path) || /\/(index|playlist|mono|video)(-[^\/]*)?\.m3u8/i.test(url) || /[?&](type|format)=m3u8/i.test(url);
}

export class Playback {
  readonly video: HTMLVideoElement;
  private hls: any = null;
  private l: PlaybackListener;
  private readyFired = false;
  private fromStart = false;
  private startSeekDone = false;
  private pdtBaseMs: number | null = null;
  private isLive = false;
  private recovered = 0;
  private stallTimer = 0;
  /** Свой плеер платформы (null — встроенный — это video.src) */
  private ext: NativeEngine | null = null;
  url = '';
  engine: 'hls' | 'native' | '' = '';
  /** Звук и субтитры выбранные пользователем */
  audioLang = '';
  subtitleLang = '';

  constructor(video: HTMLVideoElement, l: PlaybackListener) {
    this.video = video;
    this.l = l;
    const np = platform().nativePlayer;
    this.ext = np ? np(l) : null;
    const v = video;
    const self = this;
    v.addEventListener('playing', function () { self.l.onState(true, false); self.fireReady(); });
    v.addEventListener('waiting', function () { self.l.onState(!v.paused, true); });
    v.addEventListener('pause', function () { self.l.onState(false, false); });
    v.addEventListener('canplay', function () { self.fireReady(); });
    v.addEventListener('loadedmetadata', function () { self.l.onVideoSize(v.videoWidth, v.videoHeight); });
    v.addEventListener('resize', function () { self.l.onVideoSize(v.videoWidth, v.videoHeight); });
    v.addEventListener('ended', function () { self.l.onEnded(); });
    v.addEventListener('error', function () {
      if (self.engine !== 'native') return;
      const e = v.error;
      self.l.onError(e && e.code === 2 ? 'network' : 'media', e ? 'code ' + e.code : '');
    });
  }

  static hlsSupported(): boolean {
    return typeof Hls !== 'undefined' && Hls.isSupported();
  }

  play(url: string, opts: PlayOpts) {
    this.stop();
    this.url = url;
    this.fromStart = opts.fromStart;
    this.readyFired = false;
    this.startSeekDone = false;
    this.pdtBaseMs = null;
    this.isLive = false;
    this.recovered = 0;
    const v = this.video;
    const hlsUrl = opts.forceHls || isHlsUrl(url);
    if (hlsUrl && !opts.native && Playback.hlsSupported()) {
      this.engine = 'hls';
      this.startHls(url, opts.fromStart);
    } else if (this.ext) {
      this.engine = 'native';
      this.ext.play(url, opts, this.audioLang);
      return;
    } else {
      this.engine = 'native';
      v.src = url;
      v.load();
    }
    const p: any = v.play();
    if (p && p.catch) p.catch(function () { /* автозапуск без звука — не наш случай; ошибки придут событием */ });
    this.l.onState(false, true);
  }

  private startHls(url: string, fromStart: boolean) {
    const self = this;
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      // архив: с начала окна; эфир — у края (по умолчанию)
      startPosition: fromStart ? 0 : -1,
      maxBufferLength: 20,
      maxMaxBufferLength: 40,
      backBufferLength: 30,
      maxBufferSize: 40 * 1000 * 1000,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 5,
      liveDurationInfinity: true,
      capLevelToPlayerSize: false,
    });
    this.hls = hls;
    hls.on(Hls.Events.LEVEL_LOADED, function (_e: any, data: any) {
      if (self.hls !== hls) return;
      const d = data.details;
      self.isLive = !!d.live;
      const f = d.fragments && d.fragments[0];
      if (f && f.programDateTime) self.pdtBaseMs = f.programDateTime - f.start * 1000;
      // «растущий» плейлист: hls.js мог начать у края, хотя просили начало окна
      if (self.fromStart && !self.startSeekDone && f) {
        self.startSeekDone = true;
        if (self.video.currentTime > f.start + 5) self.video.currentTime = f.start;
      }
    });
    hls.on(Hls.Events.MANIFEST_PARSED, function () { self.l.onTracks(); });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function () { self.applyLangs(); self.l.onTracks(); });
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, function () { self.applyLangs(); self.l.onTracks(); });
    hls.on(Hls.Events.ERROR, function (_e: any, data: any) {
      if (self.hls !== hls || !data.fatal) return;
      console.warn('hls fatal', data.type, data.details);
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && self.recovered < 1) {
        self.recovered++;
        hls.recoverMediaError();
        return;
      }
      const kind = data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'network' : 'media';
      self.l.onError(kind, data.details || '');
    });
    hls.loadSource(url);
    hls.attachMedia(this.video);
  }

  private fireReady() {
    if (this.readyFired) return;
    this.readyFired = true;
    this.l.onReady();
  }

  /** Играет свой плеер платформы */
  private get extOn(): boolean { return this.engine === 'native' && !!this.ext; }

  stop() {
    clearTimeout(this.stallTimer);
    if (this.ext) this.ext.stop();
    if (this.hls) {
      try { this.hls.destroy(); } catch (e) { /* */ }
      this.hls = null;
    }
    const v = this.video;
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch (e) { /* */ }
    this.engine = '';
  }

  get paused(): boolean { return this.extOn ? this.ext!.paused : this.video.paused; }
  pause() { if (this.extOn) this.ext!.pause(); else this.video.pause(); }
  resume() {
    if (this.extOn) { this.ext!.resume(); return; }
    const p: any = this.video.play(); if (p && p.catch) p.catch(function () { /* */ });
  }

  /** Медиа-время, мс */
  get positionMs(): number { return this.extOn ? this.ext!.positionMs : this.video.currentTime * 1000; }

  get bufferedAheadMs(): number {
    const v = this.video, b = v.buffered, t = v.currentTime;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return (b.end(i) - t) * 1000;
    return 0;
  }

  /** Есть окно для перемотки */
  get seekable(): boolean {
    const s = this.video.seekable;
    return s.length > 0 && s.end(s.length - 1) - s.start(0) > 10;
  }
  /** Начало окна в медиа-времени, мс */
  get windowOffsetMs(): number { const s = this.video.seekable; return s.length ? s.start(0) * 1000 : 0; }
  get windowDurationMs(): number { const s = this.video.seekable; return s.length ? (s.end(s.length - 1) - s.start(0)) * 1000 : 0; }
  /** Поток «живой» (EVENT / эфир): плейлист дописывается */
  get live(): boolean { return this.extOn ? this.ext!.live : this.engine === 'hls' ? this.isLive : !isFinite(this.video.duration); }

  /** Время кадра по PROGRAM-DATE-TIME, мс (null — нет) */
  get wallClockMs(): number | null {
    if (this.pdtBaseMs === null) return null;
    return this.pdtBaseMs + this.video.currentTime * 1000;
  }
  /** Время (по PROGRAM-DATE-TIME) начала окна, мс */
  get windowStartTimeMs(): number | null {
    if (this.pdtBaseMs === null) return null;
    return this.pdtBaseMs + this.windowOffsetMs;
  }

  /** Перемотка: мс от начала окна */
  seekTo(ms: number) {
    this.video.currentTime = (this.windowOffsetMs + ms) / 1000;
  }

  // ---------------------------------------------------------------- дорожки

  /** Сколько дорожек вида kind (без подписей — дёшево, для бейджей инфопанели) */
  trackCount(kind: 'audio' | 'text'): number {
    if (this.extOn) { let n = 0; const t = this.ext!.tracks(); for (let i = 0; i < t.length; i++) if (t[i].kind === kind) n++; return n; }
    const h = this.hls;
    if (!h) return 0;
    const list = kind === 'audio' ? h.audioTracks : h.subtitleTracks;
    return list ? list.length : 0;
  }

  tracks(): Track[] {
    if (this.extOn) return this.ext!.tracks();
    const out: Track[] = [];
    const h = this.hls;
    if (!h) return out;
    const a = h.audioTracks || [];
    for (let i = 0; i < a.length; i++) out.push({ id: i, kind: 'audio', lang: a[i].lang || '', label: a[i].name || a[i].lang || String(i + 1), selected: h.audioTrack === i });
    const s = h.subtitleTracks || [];
    for (let i = 0; i < s.length; i++) out.push({ id: i, kind: 'text', lang: s[i].lang || '', label: s[i].name || s[i].lang || String(i + 1), selected: h.subtitleTrack === i });
    return out;
  }

  selectTrack(t: Track | null, kind: 'audio' | 'text') {
    if (kind === 'audio' && t) this.audioLang = t.lang;
    if (kind === 'text') this.subtitleLang = t ? t.lang : '';
    if (this.extOn) { this.ext!.selectTrack(t, kind); return; }
    const h = this.hls;
    if (!h) return;
    if (kind === 'audio' && t) { h.audioTrack = t.id; this.audioLang = t.lang; }
    if (kind === 'text') { h.subtitleTrack = t ? t.id : -1; h.subtitleDisplay = !!t; this.subtitleLang = t ? t.lang : ''; }
  }

  private applyLangs() {
    const h = this.hls;
    if (!h) return;
    if (this.audioLang) {
      const a = h.audioTracks || [];
      for (let i = 0; i < a.length; i++) if (a[i].lang === this.audioLang && h.audioTrack !== i) { h.audioTrack = i; break; }
    }
    if (this.subtitleLang) {
      const s = h.subtitleTracks || [];
      for (let i = 0; i < s.length; i++) if (s[i].lang === this.subtitleLang) { h.subtitleTrack = i; h.subtitleDisplay = true; break; }
    }
  }

  /** Формат кадра: 0 — вписать, 1 — растянуть, 2 — увеличить */
  setAspect(mode: number) {
    if (this.ext) this.ext.setAspect(mode);
    const st: any = this.video.style;
    st.objectFit = mode === 1 ? 'fill' : mode === 2 ? 'cover' : 'contain';
  }

  get height(): number { return this.extOn ? this.ext!.height : this.video.videoHeight || 0; }
}
