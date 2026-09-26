import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import en from '../strings/en.json';
import ru from '../strings/ru.json';
import { quantity } from '../src/core/lang';

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

const subs = (v: any) => JSON.stringify(v).match(/%\d\$[sd]/g)?.sort() ?? [];

describe('Строки', () => {
  it('все ключи кода есть в обоих языках', () => {
    const miss = usedKeys().filter(k => !(k in en) || !(k in ru));
    expect(miss).toEqual([]);
  });
  it('подстановки совпадают', () => {
    const bad = Object.keys(en).filter(k => k in ru && JSON.stringify(subs((en as any)[k]).filter((x, i, a) => a.indexOf(x) === i)) !== JSON.stringify(subs((ru as any)[k]).filter((x, i, a) => a.indexOf(x) === i)));
    expect(bad).toEqual([]);
  });
  it('формы чисел', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 112].map(n => quantity('ru', n))).toEqual(['one', 'few', 'many', 'many', 'one', 'few', 'many', 'many']);
    expect([1, 2].map(n => quantity('en', n))).toEqual(['one', 'other']);
  });
});
