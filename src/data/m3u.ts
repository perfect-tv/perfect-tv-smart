/**
 * Потоковый разбор M3U/M3U8 (§4): куски текста подаются в push, строки
 * разбираются по мере поступления, каналы отдаются по одному. Весь файл в памяти не держится.
 */
export interface Catchup { type: string; source: string; days: number }

export interface RawChannel {
  num: number;
  name: string;
  url: string;
  group: string;
  logo: string;
  tvgId: string;
  tvgName: string;
  tvgShift: number;
  catchup: Catchup | null;
  userAgent: string;
  referrer: string;
  headersJson: string;
}

interface Pending { name: string; attrs: { [k: string]: string }; options: { [k: string]: string }; headersJson: string | null }

const URL_RE = /^(https?|rtmpe?|rtsp|udp|rtp|mms):\/\/.+/i;
const YOUTUBE_RE = /^https?:\/\/(www\.)?youtube\.com/i;
const ATTR_RE = /([^\s=]+)=(("|')(.*?)\3|\S+)/g;
const DURATION_RE = /^\s*-?\d+(\.\d+)?/;
const BADGES_RE = /\s+(\s|ⓢ|ⓖ|ⓥ|ⓞ|Ⓢ|Ⓖ|Ⓥ|Ⓞ)/g;

export function parseAttrs(s: string): { [k: string]: string } {
  const out: { [k: string]: string } = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))!== null) {
    const quoted =!!m[3];
    out[m[1].toLowerCase] = quoted? m[4]: m[2];
  }
  return out;
}

/** «-1 attr="..."...,Название»: название — после первой запятой вне кавычек значений */
export function parseExtinf(rest: string): Pending | null {
  const d = DURATION_RE.exec(rest);
  if (!d) return null;
  const s = rest.substring(d[0].length);
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (quote) { if (c === quote) quote = ''; }
    else if ((c === '"' || c === "'") && i > 0 && s.charAt(i - 1) === '=') quote = c;
    else if (c === ',') return { name: s.substring(i + 1).trim, attrs: parseAttrs(s.substring(0, i)), options: {}, headersJson: null };
  }
  return null;
}

export function cleanName(name: string): string { return name.replace(BADGES_RE, ' ').trim; }

/** URL программы из заголовка: в url-tvg бывает несколько адресов через запятую или пробел */
export function epgUrls(header: { [k: string]: string }): string[] {
  const out: string[] = [];
  const src = [header['url-tvg'], header['x-tvg-url'], header['tvg-url']];
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!v) continue;
    const parts = v.split(/[, ]/);
    for (let j = 0; j < parts.length; j++) {
      const u = parts[j].trim;
      if (/^https?:\/\//i.test(u) && out.indexOf(u) < 0) out.push(u);
    }
  }
  return out;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseFloat(v);
  return isFinite(n)? n: null;
}

function first(...vals: (string | undefined)[]): string | undefined {
  for (let i = 0; i < vals.length; i++) if (vals[i]!== undefined) return vals[i];
  return undefined;
}

export class M3uParser {
  header: { [k: string]: string } = {};
  isM3u = false;
  count = 0;
  /** Разбор окончен досрочно: первая строка не #EXTM3U */
  rejected = false;

  private rest = '';
  private firstLine = true;
  private group: string;
  private pending: Pending | null = null;

  constructor(private onChannel: (c: RawChannel) => void, defaultGroup = '') {
    this.group = defaultGroup;
  }

  /** Кусок текста (может обрываться посреди строки) */
  push(text: string) {
    if (this.rejected) return;
    let s = this.rest + text;
    let from = 0;
    for (;;) {
      const nl = s.indexOf('\n', from);
      if (nl < 0) break;
      this.line(s.substring(from, nl));
      if (this.rejected) return;
      from = nl + 1;
    }
    this.rest = s.substring(from);
  }

  /** Конец потока */
  end {
    if (this.rest) { this.line(this.rest); this.rest = ''; }
  }

  private line(raw: string) {
    let line = raw;
    if (line.length && line.charAt(line.length - 1) === '\r') line = line.substring(0, line.length - 1);
    if (this.firstLine) {
      if (line.charCodeAt(0) === 0xfeff) line = line.substring(1);
      if (!line.trim) return;
      this.firstLine = false;
      const t = line.trim;
      if (t.substring(0, 7).toUpperCase!== '#EXTM3U') { this.rejected = true; return; }
      this.isM3u = true;
      this.header = parseAttrs(t.substring(7));
      return;
    }
    line = line.trim;
    if (!line) return;
    if (line.charAt(0) === '#') {
      const up = line.substring(0, 11).toUpperCase;
      if (up.indexOf('#EXTINF:') === 0) this.pending = parseExtinf(line.substring(8));
      else if (up.indexOf('#EXTGRP:') === 0) { const g = line.substring(8).trim; if (g) this.group = g; }
      else if (up.indexOf('#EXTVLCOPT:') === 0) {
        const opt = line.substring(11);
        const eq = opt.indexOf('=');
        if (eq > 0 && this.pending) this.pending.options[opt.substring(0, eq).trim.toLowerCase] = opt.substring(eq + 1).trim;
      } else if (up.indexOf('#EXTHTTP:') === 0) { if (this.pending) this.pending.headersJson = line.substring(9).trim; }
      return;
    }
    if (!URL_RE.test(line)) return;
    const p = this.pending || { name: '', attrs: {}, options: {}, headersJson: null };
    this.pending = null;
    if (YOUTUBE_RE.test(line)) return;
    this.count++;
    this.onChannel(this.build(this.count, line, p));
  }

  private build(n: number, url: string, p: Pending): RawChannel {
    const a = p.attrs;
    const h = this.header;
    const name = cleanName(p.name) || 'Ch ' + n;
    const shift = num(a['tvg-shift']);
    const hshift = num(h['tvg-shift']);
    return {
      num: n,
      name: name,
      url: url,
      group: a['group-title']? a['group-title']: this.group,
      logo: first(a['tvg-logo'], a['logo']) || '',
      tvgId: a['tvg-id'] || '',
      tvgName: a['tvg-name'] || '',
      tvgShift: shift!== null? shift: hshift!== null? hshift: 0,
      catchup: this.catchupOf(a),
      userAgent: first(p.options['http-user-agent'], a['http-user-agent'], a['user-agent']) || '',
      referrer: first(p.options['http-referrer'], p.options['http-referer'], a['http-referrer'], a['http-referer'], a['referer']) || '',
      headersJson: p.headersJson || '',
    };
  }

  /** Архив канала. days = 0 — «по умолчанию из настроек» */
  private catchupOf(a: { [k: string]: string }): Catchup | null {
    const h = this.header;
    const d = (first(a['catchup-days'], a['tvg-rec'], a['timeshift'], h['catchup-days'], h['tvg-rec'], h['timeshift']) || '0').trim;
    let days = /^-?\d+$/.test(d)? parseInt(d, 10): 0;
    let enabled: boolean;
    if (a['catchup-enable']!== undefined) enabled = (parseInt(a['catchup-enable'], 10) || 0) > 0;
    else enabled = days > 0 ||!!first(a['catchup'], a['catchup-type'], a['catchup-source']);
    const type = first(a['catchup'], a['catchup-type'], h['catchup'], h['catchup-type']) || '';
    if (!enabled || type.toLowerCase === 'disabled') return null;
    if (days < 0) days = 0;
    return { type: type, source: first(a['catchup-source'], h['catchup-source']) || '', days: days };
  }
}
