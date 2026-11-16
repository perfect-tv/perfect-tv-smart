import { describe, it, expect } from 'vitest';
import { useNativeHls } from '../src/core/player/hlsmode';

describe('Выбор HLS на webOS', () => {
  it('авто — эфир через плеер телевизора', () => expect(useNativeHls(2, false, false, false)).toBe(true));
  it('авто — архив через hls.js с PROGRAM-DATE-TIME', () => expect(useNativeHls(2, true, false, false)).toBe(false));
  it('авто — после ошибки native один раз через hls.js', () => expect(useNativeHls(2, false, false, true)).toBe(false));
  it('явный hls.js не изменяется', () => expect(useNativeHls(0, false, false, false)).toBe(false));
  it('явный плеер телевизора не изменяется', () => expect(useNativeHls(1, true, false, false)).toBe(true));
  it('сохранённое исправление канала имеет приоритет', () => expect(useNativeHls(0, false, true, false)).toBe(true));
});
