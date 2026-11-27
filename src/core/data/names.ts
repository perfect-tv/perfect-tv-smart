/**
 * Нормализация названий каналов: ключ канала для пользовательских данных, короткое имя
 * и транслит для сопоставления с EPG (docs/TZ.md, §6).
 */
const KEY_RE = /[\s!-\/:-@\[-`\{-~]+/g;

const TR: { [c: string]: string } = {
  'ё': 'e', 'у': 'y', 'к': 'k', 'е': 'e', 'н': 'h', 'ш': 'w', 'з': '3', 'х': 'x',
  'ы': 'bl', 'в': 'b', 'а': 'a', 'р': 'p', 'о': 'o', 'ч': '4', 'с': 'c', 'м': 'm',
  'т': 't', 'ь': 'b', 'б': '6',
};

const R_ARCHIVE = /\s+\(архив\)$/;
const R_PLUS = /\s+\((\+\d+)\)/g;
const R_TELE = /^телеканал\s+/;
const R_SIGNS = /([!\s.,()–-]+|ⓢ|ⓖ|ⓥ|ⓞ|Ⓢ|Ⓖ|Ⓥ|Ⓞ)/g;
const R_KANAL = /\s(канал|тв)(\s.+|\s*)$/;
const R_ORIG = /\s(50|orig|original)$/;
const R_NUM = /\s(\d+)/g;
/** Качество в конце имени: «Первый HD», «Первый (FHD)», «Первый 1080p». */
const R_QUALITY = /(?:[\s._-]*[\[(]?(?:SD|HD|FHD|UHD|4K|8K|HEVC|HDR(?:10)?|H\.?265|H\.?264|AVC|FULL[\s._-]*HD|1080[PI]|720[PI]|576[PI]|480[PI]|2160[PI]|4320[PI]|ORIG|ORIGINAL|ORG)[\])]?)\s*$/i;
/** Буква или цифра (латиница, кириллица, греческий, расширенная латиница) */
const LETTER = /[0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
const DIGIT = /[0-9]/;

export const Names = {
  /** Ключ канала для избранного, истории, скрытого и напоминаний */
  key(name: string): string { return name.toLowerCase().replace(KEY_RE, ''); },

  /** «Короткое имя» для сопоставления с EPG */
  short(name: string): string {
    return name.toLowerCase()
      .replace(R_ARCHIVE, '')
      .replace(R_PLUS, ' $1')
      .replace(R_TELE, '')
      .replace(R_SIGNS, ' ').trim()
      .replace(R_KANAL, '$2')
      .replace(R_ORIG, '')
      .replace(R_NUM, '$1');
  },

  /** Похожие кириллические буквы → латиница/цифры («нтв» и «HTB» совпадут) */
  translit(s: string): string {
    let r = '';
    for (let i = 0; i < s.length; i++) { const c = s.charAt(i); r += TR[c] !== undefined ? TR[c] : c; }
    return r;
  },

  matchKey(name: string): string { return Names.translit(Names.short(name)); },

  /** Имя для сравнения версий: без качества и хвоста «канал/тв», но с пробелами между словами */
  groupCompare(name: string): string {
    return Names.short(Names.qualityBase(name)).replace(/\s+/g, ' ').trim();
  },

  /**
   * Ключ объединения версий канала: без качества и хвоста «канал/тв», без знаков.
   * «Матч! ТВ», «Матч! ТВ HD» и «Матч! HD orig» дают один ключ; «Кино 2» и «Кино 3» — разные.
   */
  groupBase(name: string): string { return Names.key(Names.groupCompare(name)); },

  /**
   * Одно имя — часть другого по границе слова: «NHL» и «NHL Network», «Action IL» и «YES Action IL».
   * «Кино 2» и «Кино 20», «Musicbox 80s» и «Musicbox 90s» — не считаются (цифра/слово в продолжении).
   */
  related(a: string, b: string): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    const s = a.length <= b.length ? a : b;
    const l = a.length <= b.length ? b : a;
    if (l.length === s.length) return false;
    if (l.indexOf(s) === 0) return l.charAt(s.length) === ' ';
    const at = l.length - s.length;
    return l.lastIndexOf(s) === at && l.charAt(at - 1) === ' ';
  },

  /** Имя без обозначения качества в конце — для объединения SD/HD/FHD/4K */
  qualityBase(name: string): string {
    let s = name.trim();
    for (let guard = 0; guard < 4; guard++) {
      const n = s.replace(R_QUALITY, '').trim();
      if (n === s) break;
      s = n;
    }
    return s;
  },

  /**
   * Монограмма для плашки без логотипа: до трёх знаков. Одно слово — целиком, если не длиннее
   * трёх знаков («НТВ»), иначе две первые буквы; несколько слов — первые буквы, число — целиком,
   * пока есть место («Россия 24» → «Р24», «Матч! ТВ» → «МТ»).
   */
  monogram(name: string): string {
    let sb = '';
    let words = 0;
    let first = '';
    let i = 0;
    const n = name.length;
    while (i < n) {
      while (i < n && !LETTER.test(name.charAt(i))) i++;
      const s = i;
      while (i < n && LETTER.test(name.charAt(i))) i++;
      if (i === s) break;
      if (words++ === 0) first = name.substring(s, i);
      if (sb.length >= 3) continue;
      if (DIGIT.test(name.charAt(s))) sb += name.substring(s, Math.min(i, s + 3 - sb.length));
      else sb += name.charAt(s);
    }
    if (words === 0) return '?';
    if (words === 1) return (first.length <= 3 ? first : first.substring(0, 2)).toUpperCase();
    return sb.toUpperCase();
  },
};
