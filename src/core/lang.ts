import { LANGS } from './langs';
import { Prefs } from './prefs';

/**
 * Строки интерфейса: strings/<код>.json, зарегистрированные в core/langs.ts; английский — основа
 * (недостающая строка перевода берётся из него). Подстановки — %1$s / %1$d, счётные — объекты
 * {one, few, many, other} по правилу языка ("_plural" в файле). Язык меняется на ходу: строки не
 * кэшировать в полях модулей — брать str(...) при каждом показе. Как перевести — docs/translating.md.
 */
type Entry = string | { [q: string]: string };
const TABLES: { [lang: string]: { [k: string]: Entry } } = LANGS as any;

/** Похожие языки без своего перевода: интерфейс на «соседнем» (украинский → русский и т. п.) */
const NEAR: { [code: string]: string } = { uk: 'ru', be: 'ru', kk: 'ru', ky: 'ru', uz: 'ru', tg: 'ru', hy: 'ru', az: 'ru', ka: 'ru' };

let sysLang = 'en';
try {
  const nav: any = typeof navigator !== 'undefined' ? navigator : null;
  const l = nav ? String(nav.language || (nav.languages && nav.languages[0]) || 'en').toLowerCase() : 'en';
  sysLang = detect(l);
} catch (e) { /* Node */ }

/** Язык интерфейса по языку системы («de-DE» → de, если есть перевод) */
export function detect(locale: string): string {
  const code = locale.toLowerCase().split(/[-_]/)[0];
  if (TABLES[code]) return code;
  const near = NEAR[code];
  return near && TABLES[near] ? near : 'en';
}

let forced: string | null = null;

export function lang(): string {
  if (forced) return forced;
  const p = Prefs.language;
  return p && TABLES[p] ? p : sysLang;
}

/** Языки для выбора: код и название на самом языке (английский — первым, дальше по коду) */
export function languages(): { code: string; name: string }[] {
  const codes = Object.keys(TABLES).sort(function (a, b) { return a === 'en' ? -1 : b === 'en' ? 1 : a < b ? -1 : 1; });
  return codes.map(function (c) { return { code: c, name: String(TABLES[c]._name || c) }; });
}

/** Для тестов */
export function setLangForTest(l: string | null) { forced = l; }

function fmt(s: string, args: any[]): string {
  return s.replace(/%(\d+)\$([sd])/g, function (_m, i, t) {
    const v = args[Number(i) - 1];
    return v === undefined ? '' : t === 'd' ? String(Math.round(Number(v))) : String(v);
  });
}

export function str(key: string, ...args: any[]): string {
  let e = TABLES[lang()][key];
  if (e === undefined) e = TABLES.en[key];
  if (e === undefined) return key;
  if (typeof e !== 'string') e = e.other || '';
  return args.length ? fmt(e, args) : e;
}

/**
 * Форма числа по правилу языка ("_plural" в strings/<код>.json; правила CLDR для целых):
 *   en — one (1) / other: английский, немецкий, испанский, итальянский, шведский, турецкий…
 *   fr — one (0, 1) / other: французский, португальский (Бразилия)
 *   ru — one / few / many: русский, украинский, белорусский
 *   pl — one / few / many: польский
 *   cs — one / few / other: чешский, словацкий
 *   lt — one / few / other: литовский
 *   lv — zero / one / other: латышский
 *   ro — one / few / other: румынский
 *   other — только other: китайский, японский, корейский, вьетнамский, тайский, индонезийский
 */
export function quantity(rule: string, n: number): string {
  n = Math.abs(Math.floor(n));
  const m10 = n % 10, m100 = n % 100;
  switch (rule) {
    case 'ru':
      if (m10 === 1 && m100 !== 11) return 'one';
      if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
      return 'many';
    case 'pl':
      if (n === 1) return 'one';
      if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
      return 'many';
    case 'cs': return n === 1 ? 'one' : n >= 2 && n <= 4 ? 'few' : 'other';
    case 'lt':
      if (m10 === 1 && (m100 < 11 || m100 > 19)) return 'one';
      if (m10 >= 2 && (m100 < 11 || m100 > 19)) return 'few';
      return 'other';
    case 'lv':
      if (m10 === 0 || (m100 >= 11 && m100 <= 19)) return 'zero';
      if (m10 === 1 && m100 !== 11) return 'one';
      return 'other';
    case 'ro': return n === 1 ? 'one' : n === 0 || (m100 >= 2 && m100 <= 19) ? 'few' : 'other';
    case 'fr': return n <= 1 ? 'one' : 'other';
    case 'other': return 'other';
    default: return n === 1 ? 'one' : 'other';
  }
}
export const PLURAL_RULES = ['en', 'fr', 'ru', 'pl', 'cs', 'lt', 'lv', 'ro', 'other'];

export function plural(key: string, n: number, ...args: any[]): string {
  const l = lang();
  let table = TABLES[l];
  let e = table[key];
  if (e === undefined) { table = TABLES.en; e = table[key]; }
  if (e === undefined) return key;
  if (typeof e === 'string') return fmt(e, [n].concat(args));
  const q = quantity(String(table._plural || 'en'), n);
  const s = e[q] || e.other || e.many || '';
  return fmt(s, [n].concat(args));
}

export function hasKey(key: string): boolean { return TABLES.en[key] !== undefined; }
export const LANG_TABLES = TABLES;
