/**
 * Нормализация названий каналов: ключ канала для пользовательских данных, короткое имя
 * и транслит для сопоставления с EPG (§6).
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
const R_SIGNS = /([!\s.,–-]+|ⓢ|ⓖ|ⓥ|ⓞ|Ⓢ|Ⓖ|Ⓥ|Ⓞ)/g;
const R_KANAL = /\s(канал|тв)(\s.+|\s*)$/;
const R_ORIG = /\s(50|orig|original)$/;
const R_NUM = /\s(\d+)/g;
/** Буква или цифра (латиница, кириллица, греческий, расширенная латиница) */
const LETTER = /[0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
const DIGIT = /[0-9]/;

export const Names = {
  /** Ключ канала для избранного, истории, скрытого и напоминаний */
  key(name: string): string { return name.toLowerCase.replace(KEY_RE, ''); },

  /** «Короткое имя» для сопоставления с EPG */
  short(name: string): string {
    return name.toLowerCase.replace(R_ARCHIVE, '').replace(R_PLUS, ' $1').replace(R_TELE, '').replace(R_SIGNS, ' ').trim.replace(R_KANAL, '$2').replace(R_ORIG, '').replace(R_NUM, '$1');
  },

  /** Похожие кириллические буквы → латиница/цифры («нтв» и «HTB» совпадут) */
  translit(s: string): string {
    let r = '';
    for (let i = 0; i < s.length; i++) { const c = s.charAt(i); r += TR[c]!== undefined? TR[c]: c; }
    return r;
  },

  matchKey(name: string): string { return Names.translit(Names.short(name)); },

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
      while (i < n &&!LETTER.test(name.charAt(i))) i++;
      const s = i;
      while (i < n && LETTER.test(name.charAt(i))) i++;
      if (i === s) break;
      if (words++ === 0) first = name.substring(s, i);
      if (sb.length >= 3) continue;
      if (DIGIT.test(name.charAt(s))) sb += name.substring(s, Math.min(i, s + 3 - sb.length));
      else sb += name.charAt(s);
    }
    if (words === 0) return '?';
    if (words === 1) return (first.length <= 3? first: first.substring(0, 2)).toUpperCase;
    return sb.toUpperCase;
  },
};
