import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { compareVersions, manifestVerdict, useDownloaded, CodeRecord } from '../src/core/codever';
import { sha256 } from '../src/core/sha256';

const rec = (version: string, shell = 1): CodeRecord => ({ version, shell, service: 1, files: { 'hls.min.js': 'h', 'app.js': 'a' }, saved: 0 });

describe('обновление кода', () => {
  it('сравнение версий', () => {
    expect(compareVersions('1.1.10', '1.1.9')).toBe(1);
    expect(compareVersions('1.1.9', '1.1.10')).toBe(-1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });
  it('скачанный код — только новее встроенного, подходящий и не сбойный', () => {
    expect(useDownloaded(rec('1.1.18'), 1, '1.1.17', [])).toBe(true);
    expect(useDownloaded(rec('1.1.17'), 1, '1.1.17', [])).toBe(false);   // пакет того же возраста
    expect(useDownloaded(rec('1.1.18'), 1, '1.1.19', [])).toBe(false);   // пакет переустановили новее
    expect(useDownloaded(rec('1.1.18', 2), 1, '1.1.17', [])).toBe(false); // нужна новая оболочка
    expect(useDownloaded(rec('1.1.18'), 1, '1.1.17', ['1.1.18'])).toBe(false);
    const broken = rec('1.1.18'); delete broken.files['app.js'];
    expect(useDownloaded(broken, 1, '1.1.17', [])).toBe(false);
    expect(useDownloaded(null, 1, '1.1.17', [])).toBe(false);
  });
  it('версия с сайта: можно / не новее / нужен пакет / сбойная', () => {
    const m = (version: string, shell = 1, service = 1) => ({ version, shell, service, files: {} });
    expect(manifestVerdict(m('1.1.18'), '1.1.17', 1, 1, [])).toBe('');
    expect(manifestVerdict(m('1.1.17'), '1.1.17', 1, 1, [])).toBe('same');
    expect(manifestVerdict(m('1.1.18', 2), '1.1.17', 1, 1, [])).toBe('shell');
    expect(manifestVerdict(m('1.1.18', 1, 2), '1.1.17', 1, 1, [])).toBe('service');
    expect(manifestVerdict(m('1.1.18'), '1.1.17', 1, 1, ['1.1.18'])).toBe('bad');
  });
  it('sha256 совпадает с crypto', () => {
    for (const s of ['', 'abc', 'Привет, мир — «ТВ» 📺', 'x'.repeat(1000), 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)]) {
      expect(sha256(s)).toBe(crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
});
