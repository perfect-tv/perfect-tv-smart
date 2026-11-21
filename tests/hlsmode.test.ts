import { describe, it, expect } from 'vitest';
import { hevcCodec, hevcSupport, useNativeHls } from '../src/core/player/hlsmode';

describe('Выбор HLS на webOS', () => {
  it('авто — эфир через плеер телевизора', () => expect(useNativeHls(2, false, false, false)).toBe(true));
  it('авто — архив через hls.js с PROGRAM-DATE-TIME', () => expect(useNativeHls(2, true, false, false)).toBe(false));
  it('авто — после ошибки native один раз через hls.js', () => expect(useNativeHls(2, false, false, true)).toBe(false));
  it('явный hls.js не изменяется', () => expect(useNativeHls(0, false, false, false)).toBe(false));
  it('явный плеер телевизора не изменяется', () => expect(useNativeHls(1, true, false, false)).toBe(true));
  it('сохранённое исправление канала имеет приоритет', () => expect(useNativeHls(0, false, true, false)).toBe(true));
});

import { headersForNative } from '../src/core/player/hlsmode';

describe('заголовки канала и встроенный плеер', () => {
  const avplay = ['user-agent', 'cookie'];
  it('User-Agent или Cookie — встроенным плеером', () => {
    expect(headersForNative({ 'User-Agent': 'x' }, avplay)).toEqual({ native: true, lost: [] });
    expect(headersForNative({ Cookie: 'a=1' }, avplay)).toEqual({ native: true, lost: [] });
  });
  it('Referer он не ставит — в потерянные, но UA всё равно им', () => {
    expect(headersForNative({ 'User-Agent': 'x', Referer: 'r' }, avplay)).toEqual({ native: true, lost: ['Referer'] });
  });
  it('только Referer, без заголовков или без встроенного плеера — как обычно', () => {
    expect(headersForNative({ Referer: 'r' }, avplay).native).toBe(false);
    expect(headersForNative(null, avplay).native).toBe(false);
    expect(headersForNative({ 'User-Agent': 'x' }, []).native).toBe(false);
  });
});

describe('HEVC в hls.js и MSE', () => {
  it('кодек HEVC ищется в CODECS варианта', () => {
    expect(hevcCodec('hvc1.2.4.L153.B0,mp4a.40.2')).toBe('hvc1.2.4.L153.B0');
    expect(hevcCodec('hev1.1.6.L120.90')).toBe('hev1.1.6.L120.90');
    expect(hevcCodec('avc1.640028,mp4a.40.2')).toBe('');
  });
  it('есть HEVC, MSE принимает — остаёмся на hls.js', () => {
    const levels = [{ videoCodec: 'avc1.640028' }, { attrs: { CODECS: 'hvc1.2.4.L153.B0,mp4a.40.2', RESOLUTION: '3840x2160' } }];
    expect(hevcSupport(levels, function (c) { return c === 'hvc1.2.4.L153.B0'; })).toEqual({ found: true, supported: true, codec: 'hvc1.2.4.L153.B0' });
  });
  it('есть HEVC, MSE не принимает — нужен встроенный плеер', () => {
    const levels = [{ videoCodec: 'hev1.1.6.L120.90' }];
    expect(hevcSupport(levels, function () { return false; })).toEqual({ found: true, supported: false, codec: 'hev1.1.6.L120.90' });
  });
  it('без HEVC — встроенный плеер не нужен', () => {
    expect(hevcSupport([{ videoCodec: 'avc1.640028' }], function () { return false; })).toEqual({ found: false, supported: false, codec: '' });
  });
});
