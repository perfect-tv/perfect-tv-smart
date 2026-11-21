import { describe, it, expect } from 'vitest';
import { Playback, PlaybackListener } from '../src/core/player/playback';

const quiet: PlaybackListener = {
  onState: function () { /* */ }, onReady: function () { /* */ }, onEnded: function () { /* */ },
  onError: function () { /* */ }, onVideoSize: function () { /* */ }, onTracks: function () { /* */ },
};

/** video, который сначала не даёт автозапуск со звуком (Firefox), затем играет без звука */
function blockedVideo(): any {
  return {
    addEventListener: function () { /* */ }, removeEventListener: function () { /* */ },
    pause: function () { this.paused = true; }, removeAttribute: function () { /* */ }, load: function () { /* */ },
    play: function () {
      this.playCalls++;
      if (this.playCalls === 1) return Promise.reject({ name: 'NotAllowedError' });
      this.paused = false;
      return Promise.resolve();
    },
    style: {}, paused: true, muted: false, currentTime: 0, videoHeight: 0, playCalls: 0,
    seekable: { length: 0 }, buffered: { length: 0 },
  };
}

describe('автозапуск со звуком запрещён', () => {
  it('повторяет play без звука, а не оставляет вечную загрузку', async () => {
    const video = blockedVideo();
    const pb = new Playback(video, quiet);
    pb.play('http://x/live.ts', { fromStart: false, native: true });
    await new Promise(function (r) { setTimeout(r, 0); });
    expect(video.playCalls).toBe(2);
    expect(video.muted).toBe(true);
    expect(video.paused).toBe(false);
  });
});
