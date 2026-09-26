/**
 * Обёртка localStorage: настройки и пользовательские данные (маленькие JSON).
 * В тестах (Node) — память.
 */
const mem: { [k: string]: string } = {};

function ls(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

export const Storage2 = {
  get(key: string): string | null {
    const s = ls();
    if (s) return s.getItem(key);
    return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
  },
  set(key: string, v: string) {
    const s = ls();
    if (s) { try { s.setItem(key, v); } catch (e) { console.warn('localStorage', e); } } else mem[key] = v;
  },
  remove(key: string) {
    const s = ls();
    if (s) s.removeItem(key); else delete mem[key];
  },
  keys(): string[] {
    const s = ls();
    if (!s) return Object.keys(mem);
    const r: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k != null) r.push(k); }
    return r;
  },
  json<T>(key: string, def: T): T {
    const v = Storage2.get(key);
    if (v == null) return def;
    try { return JSON.parse(v) as T; } catch (e) { return def; }
  },
  setJson(key: string, v: any) { Storage2.set(key, JSON.stringify(v)); },
};
