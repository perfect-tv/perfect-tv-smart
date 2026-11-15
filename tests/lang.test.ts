import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LANGS } from '../src/core/langs';
import { detect, quantity, PLURAL_RULES } from '../src/core/lang';

const STRINGS = path.join(__dirname, '../strings');
const files = fs.readdirSync(STRINGS).filter(f => f.endsWith('.json'));
const table = (f: string) => JSON.parse(fs.readFileSync(path.join(STRINGS, f), 'utf8'));
const en = table('en.json');

/** Ключи строк, которые использует код: str('…') / plural('…') */
function usedKeys(): string[] {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('prefs.ts')) {
        const s = fs.readFileSync(p, 'utf8');
        const re = /\b(?:str|plural)\('([a-z0-9_]+)'/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(s)) !== null) out.add(m[1]);
      }
    }
  };
  walk(path.join(__dirname, '../src'));
  return Array.from(out);
}

const subs = (v: any) => (JSON.stringify(v).match(/%\d\$[sd]/g) ?? []).filter((x, i, a) => a.indexOf(x) === i).sort();

describe('Строки', () => {
  it('все ключи кода есть в английском (основа) и русском (поддерживается вместе с кодом)', () => {
    const ru = table('ru.json');
    expect(usedKeys().filter(k => !(k in en) || !(k in ru))).toEqual([]);
  });

  it('каждый strings/*.json зарегистрирован в core/langs.ts', () => {
    expect(files.map(f => f.replace(/\.json$/, '')).sort()).toEqual(Object.keys(LANGS).sort());
  });

  for (const f of files) {
    describe(f, () => {
      const t = table(f);
      it('есть _name и известное правило _plural', () => {
        expect(typeof t._name).toBe('string');
        expect(PLURAL_RULES).toContain(t._plural);
      });
      it('нет ключей, которых нет в английском (опечатка или устаревшая строка)', () => {
        expect(Object.keys(t).filter(k => !k.startsWith('_') && !(k in en))).toEqual([]);
      });
      it('подстановки (%1$s, %1$d…) — как в английском', () => {
        expect(Object.keys(t).filter(k => k in en && JSON.stringify(subs(t[k])) !== JSON.stringify(subs(en[k])))).toEqual([]);
      });
      it('у счётных строк — формы по правилу языка', () => {
        const need = new Set([0, 1, 2, 3, 5, 11, 21, 22, 25, 101, 111].map(n => quantity(t._plural, n)));
        const bad = Object.keys(t).filter(k => typeof t[k] === 'object' && !(k.startsWith('_')) && Array.from(need).some(q => !(q in t[k]) && !('other' in t[k])));
        expect(bad).toEqual([]);
      });
    });
  }

  it('формы чисел', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 112].map(n => quantity('ru', n))).toEqual(['one', 'few', 'many', 'many', 'one', 'few', 'many', 'many']);
    expect([1, 2].map(n => quantity('en', n))).toEqual(['one', 'other']);
    expect([1, 2, 5, 22, 25].map(n => quantity('pl', n))).toEqual(['one', 'few', 'many', 'few', 'many']);
    expect([0, 1, 2].map(n => quantity('fr', n))).toEqual(['one', 'one', 'other']);
    expect([1, 3, 7].map(n => quantity('cs', n))).toEqual(['one', 'few', 'other']);
    expect([1, 5].map(n => quantity('other', n))).toEqual(['other', 'other']);
  });

  it('язык по системе', () => {
    expect(detect('ru-RU')).toBe('ru');
    expect(detect('en-US')).toBe('en');
    expect(detect('uk-UA')).toBe('uk' in LANGS ? 'uk' : 'ru');
    expect(detect('de-DE')).toBe('de' in LANGS ? 'de' : 'en');
  });
});
