import { describe, it, expect } from 'vitest';
import { CatchupUrl, TzFn } from '../src/core/data/catchup';

const MSK: TzFn = () => 180;
const UTC: TzFn = () => 0;

describe('CatchupUrl', () => {
  it('shift', () => {
    expect(CatchupUrl.template('http://h/ch/index.m3u8', 'shift', '')).toBe('http://h/ch/index.m3u8?utc=${start}&lutc=${timestamp}');
    expect(CatchupUrl.template('http://h/ch/index.m3u8?a=1', '', '')).toBe('http://h/ch/index.m3u8?a=1&utc=${start}&lutc=${timestamp}');
  });
  it('flussonic', () => {
    expect(CatchupUrl.template('http://h/ch/index.m3u8?token=1', 'flussonic', '')).toBe('http://h/ch/archive-${start}-${duration}.m3u8?token=1');
    expect(CatchupUrl.template('http://h/ch/mpegts?token=1', 'fs', '')).toBe('http://h/ch/timeshift_abs-${start}.ts?token=1');
    expect(CatchupUrl.template('http://h/325/mono.m3u8?token=s', 'flussonic-hls', '')).toBe('http://h/325/mono-${start}-${duration}.m3u8?token=s');
    expect(CatchupUrl.template('http://h/325/video.ts', 'flussonic-ts', '')).toBe('http://h/325/video-${start}-${duration}.ts');
    expect(CatchupUrl.template('http://h/325/playlist.m3u8', 'Flussonic', '')).toBe('http://h/325/archive-${start}-${duration}.m3u8');
  });
  it('flussonic: начало и длительность в секундах, EVENT-ссылка', () => {
    const tpl = CatchupUrl.template('http://h/ch/index.m3u8?token=1', 'flussonic', '')!;
    expect(CatchupUrl.prepare(tpl, 1700000000, 5400, 1700003000, UTC)).toBe('http://h/ch/archive-1700000000-5400.m3u8?token=1');
    expect(CatchupUrl.prepare(CatchupUrl.flussonicNow(tpl), 1700000000, 5400, 1700003000, UTC)).toBe('http://h/ch/archive-1700000000-now.m3u8?token=1');
  });
  it('flussonic EVENT — только HLS-окно START-DURATION', () => {
    expect(CatchupUrl.flussonicHls('flussonic', CatchupUrl.template('http://h/ch/index.m3u8?token=1', 'flussonic', '')!)).toBe(true);
    expect(CatchupUrl.flussonicHls('fs', CatchupUrl.template('http://h/ch/mono.m3u8', 'fs', '')!)).toBe(true);
    expect(CatchupUrl.flussonicHls('flussonic', CatchupUrl.template('http://h/ch/mpegts', 'flussonic', '')!)).toBe(false);
    expect(CatchupUrl.flussonicHls('shift', CatchupUrl.template('http://h/ch/index.m3u8', 'shift', '')!)).toBe(false);
  });
  it('xc', () => {
    expect(CatchupUrl.template('http://h:8080/live/u/p/1477.m3u8', 'xc', '')).toBe('http://h:8080/timeshift/u/p/${(d)M}/${(b)yyyy-MM-dd:HH-mm}/1477.m3u8');
  });
  it('append и disabled', () => {
    expect(CatchupUrl.template('http://h/ch.m3u8', 'append', '?s=${start}')).toBe('http://h/ch.m3u8?s=${start}');
    expect(CatchupUrl.template('http://h/ch.m3u8', 'disabled', '')).toBeNull();
  });
  it('подстановки', () => {
    const url = CatchupUrl.prepare('http://h/archive-${start}-${duration}.m3u8?d=${(d)M}&b=${(bu)yyyy-MM-dd:HH-mm}', 1700000000, 3600, 1700010000, MSK);
    expect(url).toBe('http://h/archive-1700000000-3600.m3u8?d=60&b=2023-11-14%3A22-13');
    const msk = CatchupUrl.prepare('${(b)HH:mm}|${(b+1)HH}|${offset}|${timestamp}', 1700000000, 3600, 1700010000, MSK);
    expect(msk).toBe('01%3A13|02|10000|1700010000');
  });
});
