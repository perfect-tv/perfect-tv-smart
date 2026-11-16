import { describe, it, expect } from 'vitest';
import { qrMatrix } from '../src/core/ui/qrcode';

describe('QR ввода плейлиста', function () {
  it('версия 5-L, позиции искателей и формат', function () {
    const m = qrMatrix('http://192.168.1.42:47381/q/0123456789abcdef0123456789abcdef');
    expect(m.length).toBe(37);
    expect(m.every(function (r) { return r.length === 37; })).toBe(true);
    expect(m[0].slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
    expect(m[6].slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
    expect(m[3][3]).toBe(true);
    expect(m[33][33]).toBe(true); // выравнивание
    expect(m[29][8]).toBe(true); // dark module
    expect(m.reduce(function (n, row) { return n + row.filter(Boolean).length; }, 0)).toBe(728);
  });
  it('ошибки при слишком длинном URL и не-ASCII', function () {
    expect(function () { qrMatrix('x'.repeat(107)); }).toThrow();
    expect(function () { qrMatrix('русский'); }).toThrow();
  });
});
