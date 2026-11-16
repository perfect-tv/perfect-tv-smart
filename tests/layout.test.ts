import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** Ядро (src/core) не знает о платформах: только через PlatformApi (src/core/platform.ts) */
function files(dir: string, out: string[] = []): string[] {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) files(p, out); else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('Ядро и платформы', () => {
  it('src/core не импортирует src/platform', () => {
    const root = path.join(__dirname, '../src/core');
    const plat = path.join(__dirname, '../src/platform');
    const bad: string[] = [];
    for (const f of files(root)) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const spec = m[1] || m[2];
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(path.dirname(f), spec);
        if (target.startsWith(plat)) bad.push(path.relative(root, f) + ' → ' + spec);
      }
    }
    expect(bad).toEqual([]);
  });
});
