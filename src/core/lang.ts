import en from '../../strings/en.json';
import ru from '../../strings/ru.json';
import { Prefs } from './prefs';

/**
 * Строки интерфейса: strings/en.json (по умолчанию) и strings/ru.json. Подстановки — %1$s / %1$d,
 * счётные — объекты {one, few, many, other}. Язык меняется на ходу: строки не кэшировать
 * в полях модулей — брать str(...) при каждом показе.
 */
type Entry = string | { [q: string]: string };
const TABLES: { [lang: string]: { [k: string]: Entry } } = { en: en as any, ru: ru as any };

let sysLang = 'en';
try {
  const nav: any = typeof navigator!== 'undefined'? navigator: null;
  const l = nav? String(nav.language || (nav.languages && nav.languages[0]) || 'en').toLowerCase: 'en';
  sysLang = /^(ru|uk|be|kk)/.test(l)? 'ru': 'en';
} catch (e) { /* Node */ }

let forced: string | null = null;

export function lang: string {
  if (forced) return forced;
  const p = Prefs.language;
  return p === 'ru' || p === 'en'? p: sysLang;
}

/** Для тестов */
export function setLangForTest(l: string | null) { forced = l; }

function fmt(s: string, args: any[]): string {
  return s.replace(/%(\d+)\$([sd])/g, function (_m, i, t) {
    const v = args[Number(i) - 1];
    return v === undefined? '': t === 'd'? String(Math.round(Number(v))): String(v);
  });
}

export function str(key: string,...args: any[]): string {
  let e = TABLES[lang][key];
  if (e === undefined) e = TABLES.en[key];
  if (e === undefined) return key;
  if (typeof e!== 'string') e = e.other || '';
  return args.length? fmt(e, args): e;
}

/** Форма числа: ru — one/few/many, en — one/other */
export function quantity(l: string, n: number): string {
  n = Math.abs(Math.floor(n));
  if (l === 'ru') {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100!== 11) return 'one';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
    return 'many';
  }
  return n === 1? 'one': 'other';
}

export function plural(key: string, n: number,...args: any[]): string {
  const l = lang;
  let e = TABLES[l][key];
  if (e === undefined) e = TABLES.en[key];
  if (e === undefined) return key;
  if (typeof e === 'string') return fmt(e, [n].concat(args));
  const q = quantity(l, n);
  const s = e[q] || e.other || e.many || '';
  return fmt(s, [n].concat(args));
}

export function hasKey(key: string): boolean { return TABLES.en[key]!== undefined; }
export const LANG_TABLES = TABLES;
