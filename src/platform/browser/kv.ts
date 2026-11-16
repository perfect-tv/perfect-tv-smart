import { KvBackend } from '../../core/platform';

/**
 * Настройки в браузере — localStorage, ключи с префиксом (на одном адресе может жить что-то ещё).
 * Нет localStorage (приватный режим, запрет сайта) — только память, Storage2 об этом знает.
 */
const PREFIX = 'ptv:';

function ls(): Storage | null {
  try {
    const s = window.localStorage;
    s.setItem(PREFIX + '_', '1');
    s.removeItem(PREFIX + '_');
    return s;
  } catch (e) { return null; }
}

export const BrowserKv: KvBackend = {
  load() {
    const s = ls();
    const values: { [k: string]: string } = {};
    if (!s) return Promise.resolve({ values: values, persistent: false });
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k === null || k.indexOf(PREFIX) !== 0) continue;
      const v = s.getItem(k);
      if (v !== null) values[k.slice(PREFIX.length)] = v;
    }
    return Promise.resolve({ values: values, persistent: true });
  },
  save(put, del) {
    const s = ls();
    if (!s) return Promise.reject(new Error('localStorage unavailable'));
    try {
      for (let i = 0; i < put.length; i++) s.setItem(PREFIX + put[i].key, put[i].value);
      for (let i = 0; i < del.length; i++) s.removeItem(PREFIX + del[i]);
    } catch (e) { return Promise.reject(e); }
    return Promise.resolve();
  },
  reset(rows) {
    const s = ls();
    if (!s) return Promise.resolve();
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k !== null && k.indexOf(PREFIX) === 0) keys.push(k); }
    for (let i = 0; i < keys.length; i++) s.removeItem(keys[i]);
    return BrowserKv.save(rows, []);
  },
};
