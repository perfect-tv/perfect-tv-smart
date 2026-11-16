/**
 * Потоковый разборщик XMLTV на уровне байтов (docs/TZ.md, §5). Куски Uint8Array любой длины
 * подаются в push(): элемент на границе кусков доклеивается. У <programme> сначала читается
 * открывающий тег; канал сравнивается побайтно с каналом предыдущей передачи (XMLTV идёт по
 * каналам подряд), ненужная передача пропускается поиском «</programme>» без декодирования.
 * Нужные элементы декодируются (UTF-8 или кодировка пролога) и разбираются по строке.
 */
export interface EpgChannelRaw { id: string; names: string[]; icon: string }
export interface EpgProgramme {
  channel: string; start: number; stop: number;
  title: string; subTitle: string; desc: string; category: string; icon: string;
}

const LT = 60, GT = 62, SLASH = 47, BANG = 33, QM = 63, QUOT = 34, APOS = 39, EQ = 61;

function bytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
const B_CHANNEL = bytes('channel');
const B_PROGRAMME = bytes('programme');
const B_CHANNEL_END = bytes('</channel>');
const B_PROGRAMME_END = bytes('</programme>');
const B_COMMENT = bytes('<!--');
const B_COMMENT_END = bytes('-->');
const B_PI_END = bytes('?>');
const B_CHANNEL_ATTR = bytes('channel');

function isSpace(c: number) { return c === 32 || c === 10 || c === 13 || c === 9; }
function isNameEnd(c: number) { return c === GT || c === SLASH || isSpace(c); }

/** Позиция p в b начиная с from (или −1) */
export function indexOfBytes(b: Uint8Array, p: Uint8Array, from: number, to?: number): number {
  const end = (to === undefined ? b.length : to) - p.length;
  const c0 = p[0];
  const n = p.length;
  outer: for (let i = from; i <= end; i++) {
    if (b[i] !== c0) continue;
    for (let k = 1; k < n; k++) if (b[i + k] !== p[k]) continue outer;
    return i;
  }
  return -1;
}

function equalsAt(b: Uint8Array, from: number, to: number, name: Uint8Array): boolean {
  if (to - from !== name.length) return false;
  for (let k = 0; k < name.length; k++) if (b[from + k] !== name[k]) return false;
  return true;
}

const ENT: { [k: string]: string } = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (m, e: string) {
    if (e.charAt(0) === '#') {
      const code = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
      if (!isFinite(code) || code <= 0) return m;
      if (code > 0xffff) { const c = code - 0x10000; return String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff)); }
      return String.fromCharCode(code);
    }
    const r = ENT[e];
    return r !== undefined ? r : m;
  });
}

/** Текст элемента: CDATA как есть, вложенные теги убираются, сущности раскрываются */
export function textOf(s: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const c = s.indexOf('<![CDATA[', i);
    const part = c < 0 ? s.substring(i) : s.substring(i, c);
    out += unescapeXml(part.replace(/<[^>]*>/g, ''));
    if (c < 0) break;
    const e = s.indexOf(']]>', c + 9);
    if (e < 0) { out += s.substring(c + 9); break; }
    out += s.substring(c + 9, e);
    i = e + 3;
  }
  return out;
}

function attr(tag: string, name: string): string {
  const re = new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')');
  const m = re.exec(tag);
  if (!m) return '';
  return unescapeXml(m[2] !== undefined ? m[2] : m[3] || '');
}

/** Дни от 1970-01-01 (алгоритм Howard Hinnant) */
function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Время XMLTV «yyyyMMddHHmmss ±hhmm»; секунд, минут и смещения может не быть (тогда UTC). 0 — не разобрано */
export function parseTime(s0: string | null | undefined): number {
  if (!s0) return 0;
  const s = s0.trim();
  let i = 0;
  function num(len: number): number {
    if (i + len > s.length) return -1;
    let v = 0;
    for (let k = 0; k < len; k++) {
      const c = s.charCodeAt(i + k) - 48;
      if (c < 0 || c > 9) return -1;
      v = v * 10 + c;
    }
    i += len;
    return v;
  }
  const y = num(4), mo = num(2), d = num(2);
  if (y < 0 || mo < 1 || d < 1) return 0;
  const h = Math.max(0, num(2)), mi = Math.max(0, num(2)), se = Math.max(0, num(2));
  while (i < s.length && s.charAt(i) === ' ') i++;
  let offset = 0;
  if (i < s.length && (s.charAt(i) === '+' || s.charAt(i) === '-')) {
    const sign = s.charAt(i) === '-' ? -1 : 1;
    i++;
    const oh = num(2);
    if (i < s.length && s.charAt(i) === ':') i++;
    const om = num(2);
    if (oh >= 0) offset = sign * (oh * 3600 + Math.max(0, om) * 60);
  }
  return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se - offset;
}

/** Выбор значения по языку: языки по приоритету, иначе первое */
class Pick {
  value = '';
  private rank = 1 << 30;
  constructor(private langs: string[]) {}
  offer(lang: string, text: string) {
    let r = lang ? this.langs.indexOf(lang.toLowerCase()) : -1;
    if (r < 0) r = this.langs.length;
    // при равном приоритете остаётся первое
    if (r < this.rank) { this.rank = r; this.value = text; }
  }
}

const CHILD_RE = /<(title|sub-title|desc|category|icon|display-name)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/g;

/**
 * Байты [from, to) без копии. Сервис на webOS 3–5 — Node 0.12: там Buffer (кусок от распаковщика)
 * ещё не наследник Uint8Array и subarray у него нет — только slice (тоже без копии).
 */
function view(b: Uint8Array, from: number, to: number): Uint8Array {
  return typeof b.subarray === 'function' ? b.subarray(from, to) : (b as any).slice(from, to);
}

export class XmltvParser {
  channels = 0;
  programmes = 0;
  skipped = 0;

  private buf: Uint8Array = new Uint8Array(0);
  private len = 0;
  private decoder: TextDecoder;
  private enc = 'utf-8';
  private programmesStarted = false;
  private channelsDirty = false;
  private noStop: { [ch: string]: EpgProgramme } = {};
  private lastBytes = new Uint8Array(64);
  private lastLen = -1;
  private lastId = '';
  private lastWanted = false;
  /** Начатый элемент, которому не хватило данных: искать конец с этого места */
  private resumeAt = -1;

  constructor(
    private langs: string[],
    private onChannel: (c: EpgChannelRaw) => void,
    private beforeProgrammes: () => void,
    private wanted: (id: string) => boolean,
    private onProgramme: (p: EpgProgramme) => void,
  ) {
    this.decoder = new TextDecoder('utf-8');
  }

  private decode(from: number, to: number): string {
    return this.decoder.decode(view(this.buf, from, to));
  }

  /** Очередной кусок данных */
  push(chunk: Uint8Array) {
    if (this.len === 0) {
      this.buf = chunk;
      this.len = chunk.length;
    } else {
      const nb = new Uint8Array(this.len + chunk.length);
      nb.set(view(this.buf, 0, this.len), 0);
      nb.set(chunk, this.len);
      this.buf = nb;
      this.len = nb.length;
    }
    const used = this.run(false);
    this.keepTail(used);
  }

  /** Конец потока */
  end() {
    this.run(true);
    this.buf = new Uint8Array(0);
    this.len = 0;
    // хвосты без stop: до следующей передачи не дошли — час
    for (const ch in this.noStop) {
      const pr = this.noStop[ch];
      pr.stop = pr.start + 3600;
      this.emit(pr);
    }
    this.noStop = {};
  }

  private keepTail(used: number) {
    if (used >= this.len) { this.buf = new Uint8Array(0); this.len = 0; return; }
    if (used > 0) {
      // копия хвоста, не .slice(): у Uint8Array его нет в Node 0.12 (сервис на webOS 3–5)
      const tail = new Uint8Array(this.len - used);
      tail.set(view(this.buf, used, this.len));
      this.buf = tail;
      this.len = tail.length;
      if (this.resumeAt >= 0) this.resumeAt -= used;
    }
  }

  /** Разобрать, что возможно; вернуть, сколько байтов израсходовано */
  private run(final: boolean): number {
    const b = this.buf;
    const n = this.len;
    let pos = 0;
    while (pos < n) {
      let lt = pos;
      while (lt < n && b[lt] !== LT) lt++;
      if (lt >= n) return n;
      pos = lt;
      if (lt + 1 >= n) return final ? n : lt;
      const c = b[lt + 1];
      if (c === QM) {
        const e = indexOfBytes(b, B_PI_END, lt + 2, n);
        if (e < 0) return final ? n : lt;
        this.prolog(this.latin1(lt, e));
        pos = e + 2;
        continue;
      }
      if (c === BANG) {
        if (lt + 4 > n) return final ? n : lt;
        if (equalsAt(b, lt, lt + 4, B_COMMENT)) {
          const e = indexOfBytes(b, B_COMMENT_END, lt + 4, n);
          if (e < 0) return final ? n : lt;
          pos = e + 3;
        } else {
          let e = lt + 2;
          while (e < n && b[e] !== GT) e++;
          if (e >= n) return final ? n : lt;
          pos = e + 1;
        }
        continue;
      }
      // открывающий тег целиком
      const te = this.tagEnd(lt + 1, n);
      if (te < 0) return final ? n : lt;
      let ne = lt + 1;
      while (ne < te && !isNameEnd(b[ne])) ne++;
      const selfClosed = b[te - 1] === SLASH;
      if (equalsAt(b, lt + 1, ne, B_CHANNEL)) {
        let end = te + 1;
        if (!selfClosed) {
          const e = indexOfBytes(b, B_CHANNEL_END, this.resumeAt > te ? this.resumeAt : te + 1, n);
          if (e < 0) { this.resumeAt = Math.max(te + 1, n - B_CHANNEL_END.length); return final ? n : lt; }
          end = e + B_CHANNEL_END.length;
        }
        this.resumeAt = -1;
        const s = this.decode(lt, end);
        const id = attr(this.decode(lt, te + 1), 'id');
        if (id) {
          this.channels++;
          this.onChannel(this.channelOf(id, s));
          if (this.programmesStarted) this.channelsDirty = true;
        }
        pos = end;
        continue;
      }
      if (equalsAt(b, lt + 1, ne, B_PROGRAMME)) {
        // конец элемента
        let end = te + 1;
        if (!selfClosed) {
          const e = indexOfBytes(b, B_PROGRAMME_END, this.resumeAt > te ? this.resumeAt : te + 1, n);
          if (e < 0) { this.resumeAt = Math.max(te + 1, n - B_PROGRAMME_END.length); return final ? n : lt; }
          end = e + B_PROGRAMME_END.length;
        }
        this.resumeAt = -1;
        if (!this.programmesStarted || this.channelsDirty) {
          this.programmesStarted = true;
          this.channelsDirty = false;
          this.lastLen = -1;
          this.beforeProgrammes();
        }
        const r = this.attrRange(ne, te, B_CHANNEL_ATTR);
        if (r === null) { this.skipped++; pos = end; continue; }
        const vs = r[0], ve = r[1];
        if (!this.sameAsLast(vs, ve)) {
          this.lastLen = ve - vs;
          if (this.lastBytes.length < this.lastLen) this.lastBytes = new Uint8Array(this.lastLen * 2);
          this.lastBytes.set(view(b, vs, ve), 0);
          this.lastId = unescapeXml(this.decode(vs, ve));
          this.lastWanted = this.lastId.length > 0 && this.wanted(this.lastId);
        }
        if (!this.lastWanted) { this.skipped++; pos = end; continue; }
        const open = this.decode(lt, te + 1);
        this.programme(this.lastId, attr(open, 'start'), attr(open, 'stop'), selfClosed ? '' : this.decode(te + 1, end));
        pos = end;
        continue;
      }
      // <tv>, </tv> и прочее верхнего уровня
      pos = te + 1;
    }
    return n;
  }

  private latin1(from: number, to: number): string {
    let s = '';
    for (let i = from; i < to; i++) s += String.fromCharCode(this.buf[i]);
    return s;
  }

  /** Конец открывающего тега ('>') с учётом кавычек; −1 — данных не хватает */
  private tagEnd(from: number, n: number): number {
    const b = this.buf;
    let q = 0;
    for (let i = from; i < n; i++) {
      const c = b[i];
      if (q) { if (c === q) q = 0; }
      else if (c === QUOT || c === APOS) q = c;
      else if (c === GT) return i;
    }
    return -1;
  }

  /** Диапазон значения атрибута name в открывающем теге [from, to) */
  private attrRange(from: number, to: number, name: Uint8Array): number[] | null {
    const b = this.buf;
    let i = from;
    while (i < to) {
      while (i < to && isSpace(b[i])) i++;
      const ns = i;
      while (i < to && b[i] !== EQ && !isSpace(b[i]) && b[i] !== GT && b[i] !== SLASH) i++;
      const nameEnd = i;
      while (i < to && isSpace(b[i])) i++;
      if (i >= to || b[i] !== EQ) { i++; continue; }
      i++;
      while (i < to && isSpace(b[i])) i++;
      const q = b[i];
      if (q !== QUOT && q !== APOS) { i++; continue; }
      const vs = i + 1;
      let ve = vs;
      while (ve < to && b[ve] !== q) ve++;
      if (equalsAt(b, ns, nameEnd, name)) return [vs, ve];
      i = ve + 1;
    }
    return null;
  }

  private sameAsLast(vs: number, ve: number): boolean {
    if (ve - vs !== this.lastLen) return false;
    const b = this.buf;
    for (let k = 0; k < this.lastLen; k++) if (b[vs + k] !== this.lastBytes[k]) return false;
    return true;
  }

  private prolog(s: string) {
    const m = /encoding\s*=\s*["']([^"']+)["']/.exec(s);
    if (!m) return;
    const enc = m[1].toLowerCase();
    if (enc === this.enc) return;
    try {
      this.decoder = new TextDecoder(enc);
      this.enc = enc;
    } catch (e) { /* неизвестная — остаёмся на UTF-8 */ }
  }

  private channelOf(id: string, s: string): EpgChannelRaw {
    const names: string[] = [];
    let icon = '';
    CHILD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CHILD_RE.exec(s)) !== null) {
      if (m[1] === 'display-name') {
        const t = textOf(m[4] || '').trim();
        if (t && names.indexOf(t) < 0) names.push(t);
      } else if (m[1] === 'icon' && !icon) icon = attr(' ' + m[2], 'src');
    }
    return { id: id, names: names, icon: icon };
  }

  private programme(ch: string, startAttr: string, stopAttr: string, inner: string) {
    const start = parseTime(startAttr);
    if (start <= 0) return;
    const stop = stopAttr ? parseTime(stopAttr) : 0;
    const title = new Pick(this.langs), sub = new Pick(this.langs), desc = new Pick(this.langs), cat = new Pick(this.langs);
    let icon = '';
    if (inner) {
      CHILD_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CHILD_RE.exec(inner)) !== null) {
        const name = m[1];
        if (name === 'icon') { if (!icon) icon = attr(' ' + m[2], 'src'); continue; }
        const lang = attr(' ' + m[2], 'lang');
        const text = m[4] !== undefined ? textOf(m[4]) : '';
        if (name === 'title') title.offer(lang, text);
        else if (name === 'sub-title') sub.offer(lang, text);
        else if (name === 'desc') desc.offer(lang, text);
        else if (name === 'category') cat.offer(lang, text);
      }
    }
    const pr: EpgProgramme = {
      channel: ch, start: start, stop: stop,
      title: title.value.trim(), subTitle: sub.value.trim(), desc: desc.value.trim(), category: cat.value.trim(), icon: icon,
    };
    const prev = this.noStop[ch];
    if (prev) {
      delete this.noStop[ch];
      prev.stop = Math.max(start, prev.start + 60);
      this.emit(prev);
    }
    if (stop <= start) this.noStop[ch] = pr; else this.emit(pr);
  }

  private emit(pr: EpgProgramme) {
    this.programmes++;
    this.onProgramme(pr);
  }
}
