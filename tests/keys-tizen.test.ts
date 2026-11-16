import { describe, expect, it } from 'vitest';
import { isBack, Keys, media, Scheduler } from '../src/core/ui/keys';

/** Пульт Samsung (Tizen): коды клавиш, которые приложение регистрирует (src/platform/tizen/tizen.ts) */
const s: Scheduler = { set: function () { return 0; }, clear: function () { /* */ }, now: function () { return 0; } };

describe('Клавиши Samsung', () => {
  it('Назад, медиа и служебные', () => {
    expect(isBack(10009)).toBe(true);
    expect(media(10252)).toBe('playpause');
    expect(media(10135)).toBe('menu');     // Tools
    expect(media(10073)).toBe('guide');    // Channel List
    expect(media(10190)).toBe('history');  // Previous Channel
    expect(media(10225)).toBe('search');
  });
  it('CH+ / CH− — как PageUp / PageDown', () => {
    const got: string[] = [];
    const k = new Keys(function () { return { key: function (n: string) { got.push(n); }, holdRepeat: false } as any; }, s);
    k.onKeyDown(427, false); k.onKeyUp(427);
    k.onKeyDown(428, false); k.onKeyUp(428);
    expect(got).toEqual(['pgup', 'pgdown']);
  });
});
