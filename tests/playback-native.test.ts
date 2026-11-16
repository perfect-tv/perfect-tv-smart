import { describe, expect, it } from 'vitest';
import { usePlatform, platform } from '../src/core/platform';
import { NativeEngine, Playback, PlaybackListener } from '../src/core/player/playback';

/** Свой плеер платформы (AVPlay на Tizen): «плеер телевизора» идёт в него, hls.js — как раньше */
function fakeVideo(): any {
  return {
    addEventListener: function () { /* */ }, pause: function () { /* */ }, removeAttribute: function () { /* */ },
    load: function () { /* */ }, play: function () { return Promise.resolve(); }, style: {}, paused: true, currentTime: 0,
    videoHeight: 0, seekable: { length: 0 }, buffered: { length: 0 },
  };
}
const quiet: PlaybackListener = { onState: function () { /* */ }, onReady: function () { /* */ }, onEnded: function () { /* */ }, onError: function () { /* */ }, onVideoSize: function () { /* */ }, onTracks: function () { /* */ } };

describe('Playback и плеер платформы', () => {
  it('встроенный режим — в плеер платформы, с заголовками канала и языком звука', () => {
    const calls: string[] = [];
    let opened: any = null;
    const engine: NativeEngine = {
      play: function (url, opts, lang) { opened = { url: url, headers: opts.headers, lang: lang }; calls.push('play'); },
      stop: function () { calls.push('stop'); }, pause: function () { calls.push('pause'); }, resume: function () { calls.push('resume'); },
      paused: false, positionMs: 1234, height: 720, live: true,
      tracks: function () { return [{ id: 3, kind: 'audio', lang: 'ru', label: 'ru', selected: true }]; },
      selectTrack: function (t) { calls.push('track ' + (t ? t.id : '-')); }, setAspect: function (m) { calls.push('aspect ' + m); },
    };
    const base = platform();
    usePlatform(Object.assign({}, base, { nativePlayer: function () { return engine; } }));
    try {
      const pb = new Playback(fakeVideo(), quiet);
      pb.audioLang = 'ru';
      pb.play('http://x/live.ts', { fromStart: false, native: true, headers: { 'User-Agent': 'UA1' } });
      expect(pb.engine).toBe('native');
      expect(opened).toEqual({ url: 'http://x/live.ts', headers: { 'User-Agent': 'UA1' }, lang: 'ru' });
      expect(pb.positionMs).toBe(1234);
      expect(pb.height).toBe(720);
      expect(pb.tracks()[0].id).toBe(3);
      pb.pause(); pb.resume(); pb.setAspect(2);
      pb.selectTrack({ id: 5, kind: 'audio', lang: 'en', label: 'en', selected: false }, 'audio');
      expect(pb.audioLang).toBe('en');
      pb.stop();
      expect(calls).toEqual(['stop', 'play', 'pause', 'resume', 'aspect 2', 'track 5', 'stop']);
      expect(pb.engine).toBe('');
    } finally { usePlatform(base); }
  });
});
