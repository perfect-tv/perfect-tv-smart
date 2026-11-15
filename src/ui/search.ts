import { Clock } from '../core/clock';
import { lang, str } from '../core/lang';
import { Prefs } from '../core/prefs';
import { Channel, Programme } from '../data/models';
import { Cell } from './cells';
import { Anim, el, icon, setText, toggle } from './dom';
import { Fmt } from './fmt';
import { Layer } from './layer';
import { Logos } from './logos';
import { Scroller } from './popups';
import type { Tv } from './tv';
import { U } from './u';
import { hintRow } from './widgets';

const RU = 0, EN = 1, SYM = 2;
const TYPE = 0, DEL = 1, TO_RU = 2, TO_EN = 3, TO_SYM = 4;
const MAX_QUERY = 40, MAX_RECENT = 8, MAX_SUGS = 5, MAX_PART = 30, MAX_CHANNELS = 30, DELAY = 300;

interface Key { label: string; text: string; span: number; action: number; col: number; el?: HTMLElement }
interface Item { kind: 'head' | 'channel' | 'live' | 'soon' | 'arch'; title: string; channel?: Channel; start?: number; stop?: number; time?: string; side?: string; el?: HTMLElement }
const enum Zone { KEYS, QUERIES, RESULTS }

/**
 * Поиск по каналам и программе (docs/controls.md, «Поиск»): слева — поле, своя клавиатура 11 × 5
 * и запросы (недавние и подсказки), справа — результаты: каналы, сейчас в эфире, скоро, в архиве.
 * Каналы ищутся сразу, передачи — через 0,3 с после набора (от двух букв).
 */
export class SearchLayer implements Layer {
  el: HTMLElement;
  private query = '';
  private kbLang: number;
  private textLang: number;
  private rows: Key[][] = [];
  private kr = 1;
  private kc = 1;
  private zone = Zone.KEYS;
  private items: Item[] = [];
  private ri = -1;
  private sugs: { text: string; recent: boolean }[] = [];
  private si = 0;
  private found: { channel: Channel; p: Programme }[] = [];
  private gen = 0;
  private timer = 0;
  private searching = false;
  private qEl: HTMLElement;
  private kbEl: HTMLElement;
  private sugEl: HTMLElement;
  private resScroller: Scroller;
  private hints: HTMLElement;
  private status: HTMLElement;

  constructor(private tv: Tv, query: string, private onClose: () => void) {
    this.el = el('div', 'search', null, tv.ui);
    this.kbLang = lang() === 'en' ? EN : RU;
    this.textLang = this.kbLang;
    const left = el('div', 'abs', null, this.el);
    const keyW = 3.2, gap = 0.3;
    const leftW = U.px(11 * keyW + 11 * gap);
    left.style.cssText = 'left:4rem;top:2.4rem;bottom:2.4rem;width:' + leftW + 'px';
    const h = el('div', 'row', null, left);
    h.style.cssText = 'font-size:1.7rem;font-weight:700;margin-bottom:1rem';
    h.appendChild(icon('search'));
    el('span', '', str('search'), h).style.marginLeft = '0.8rem';
    this.qEl = el('div', 'q', null, left);
    this.kbEl = el('div', 'kb', null, left);
    this.sugEl = el('div', 'list', null, left);
    this.sugEl.style.marginTop = '1rem';
    const right = el('div', 'abs', null, this.el);
    right.style.cssText = 'left:' + (U.px(4 + 2.4) + leftW) + 'px;right:4rem;top:2.4rem;bottom:5rem';
    this.status = el('div', 't60', '', right);
    this.status.style.cssText = 'font-size:1.2rem;height:2.2rem';
    this.resScroller = new Scroller(right, U.h - U.px(2.4 + 5 + 2.2), 'rgba(12,13,14,.97)');
    this.hints = el('div', 'hints abs', null, this.el);
    this.hints.style.cssText = 'left:4rem;bottom:2.4rem';
    this.setLang(this.kbLang);
    this.query = query.substring(0, MAX_QUERY);
    this.changed();
    Anim.show(this.el);
  }

  private letters(l: number): string[] {
    const abc = Prefs.keyboardAbc;
    if (l === RU) return abc ? ['абвгдеёжзий', 'клмнопрстуф', 'хцчшщъыьэюя'] : ['йцукенгшщзх', 'фывапролджэ', 'ячсмитьбюъё'];
    if (l === EN) return abc ? ['abcdefghijk', 'lmnopqrstuv', "wxyz+',.?*;"] : ['qwertyuiop+', "asdfghjkl';", 'zxcvbnm,.?*'];
    return ['@#$%&()<>*"', '_/\\:;+=?!,.'];
  }

  private setLang(l: number) {
    this.kbLang = l;
    if (l !== SYM) this.textLang = l;
    const out: Key[][] = [];
    const mk = function (label: string, text: string, span = 1, action = TYPE): Key { return { label: label, text: text, span: span, action: action, col: 0 }; };
    const ls = this.letters(l);
    for (let i = 0; i < ls.length; i++) out.push(ls[i].split('').map(function (ch) { return mk(ch, ch); }));
    if (l === SYM) out.push([mk('http://', 'http://', 3), mk('https://', 'https://', 3), mk('.m3u8', '.m3u8', 2), mk('.xml.gz', '.xml.gz', 3)]);
    out.push('1234567890-'.split('').map(function (ch) { return mk(ch, ch); }));
    const tail = [mk(str('key_space'), ' ', 5), mk('⌫', '', 2, DEL)];
    out.push((l === SYM ? [mk('RU', '', 2, TO_RU), mk('EN', '', 2, TO_EN)] : [mk('#&', '', 2, TO_SYM), l === RU ? mk('EN', '', 2, TO_EN) : mk('RU', '', 2, TO_RU)]).concat(tail));
    for (let r = 0; r < out.length; r++) { let c = 0; for (let k = 0; k < out[r].length; k++) { out[r][k].col = c; c += out[r][k].span; } }
    this.rows = out;
    this.kr = Math.max(0, Math.min(this.kr, out.length - 1));
    this.kc = Math.max(0, Math.min(this.kc, out[this.kr].length - 1));
    this.renderKeys();
  }

  private renderKeys() {
    const kb = this.kbEl;
    while (kb.firstChild) kb.removeChild(kb.firstChild);
    const self = this;
    for (let r = 0; r < this.rows.length; r++) {
      for (let k = 0; k < this.rows[r].length; k++) {
        const key = this.rows[r][k];
        const b = el('b', key.action !== TYPE || key.span > 1 ? 'fn' : '', key.label, kb);
        b.style.width = U.px(key.span * 3.2 + (key.span - 1) * 0.3) + 'px';
        key.el = b;
        (function (rr, kk) { b.addEventListener('click', function () { self.zone = Zone.KEYS; self.kr = rr; self.kc = kk; self.press(self.rows[rr][kk]); self.render(); }); })(r, k);
      }
    }
    this.render();
  }

  private keyAt(r: number, center: number): number {
    const row = this.rows[r];
    for (let i = 0; i < row.length; i++) if (center >= row[i].col && center < row[i].col + row[i].span) return i;
    return row.length - 1;
  }

  private press(k: Key) {
    if (k.action === TYPE) { if (this.query.length < MAX_QUERY) { this.query += k.text; this.changed(); } }
    else if (k.action === DEL) { if (this.query) { this.query = this.query.substring(0, this.query.length - 1); this.changed(); } }
    else if (k.action === TO_RU) this.setLang(RU);
    else if (k.action === TO_EN) this.setLang(EN);
    else if (k.action === TO_SYM) this.setLang(SYM);
  }

  private words(): string[] { return this.query.trim().toLowerCase().split(' ').filter(function (w) { return w.length > 0; }); }

  private changed() {
    this.gen++;
    this.found = [];
    clearTimeout(this.timer);
    this.searching = this.words().some(function (w) { return w.length >= 2; });
    const self = this;
    if (this.searching) this.timer = window.setTimeout(function () { self.searchProgrammes(); }, DELAY);
    this.update();
  }

  private searchProgrammes() {
    const g = this.gen;
    const self = this;
    this.tv.repo.searchProgrammes(this.tv.allChannels(), this.words(), Clock.now(), function () { return g !== self.gen; }).then(function (hits) {
      if (g !== self.gen) return;
      self.found = hits;
      self.searching = false;
      self.update();
    });
  }

  private whenText(t: number) { return Fmt.dayLabel(t).toLowerCase() + ' ' + Fmt.hhmm(t); }

  private update() {
    const w = this.words();
    const now = Clock.now();
    const out: Item[] = [];
    const q = w.join(' ');
    const num = /^\d+$/.test(q) ? parseInt(q, 10) : -1;
    let chans: Channel[] = [];
    if (w.length) {
      chans = this.tv.allChannels().filter(function (ch) {
        if (ch.num === num) return true;
        const n = ch.name.toLowerCase();
        for (let i = 0; i < w.length; i++) if (n.indexOf(w[i]) < 0) return false;
        return true;
      });
      const rank = function (c: Channel) { return c.num === num ? 0 : c.name.toLowerCase().indexOf(q) === 0 ? 1 : 2; };
      chans.sort(function (a, b) { return rank(a) - rank(b); });
      chans = chans.slice(0, MAX_CHANNELS);
    }
    const repo = this.tv.repo;
    if (chans.length) {
      out.push({ kind: 'head', title: str('found_channels', chans.length) });
      for (let i = 0; i < chans.length; i++) { const p = repo.at(chans[i], now); out.push({ kind: 'channel', title: chans[i].name, channel: chans[i], time: String(chans[i].num), side: p ? p.title : '' }); }
    }
    const live = this.found.filter(function (h) { return h.p.start <= now && now < h.p.stop; }).slice(0, MAX_PART);
    const soon = this.found.filter(function (h) { return h.p.start > now; }).sort(function (a, b) { return a.p.start - b.p.start; }).slice(0, MAX_PART);
    const arch = this.found.filter(function (h) { return h.p.stop <= now; }).sort(function (a, b) { return b.p.start - a.p.start; }).slice(0, MAX_PART);
    const self = this;
    const add = function (kind: Item['kind'], head: string, list: { channel: Channel; p: Programme }[], time: (h: { channel: Channel; p: Programme }) => string) {
      if (!list.length) return;
      out.push({ kind: 'head', title: head });
      for (let i = 0; i < list.length; i++) out.push({ kind: kind, title: list[i].p.title, channel: list[i].channel, start: list[i].p.start, stop: list[i].p.stop, time: time(list[i]), side: list[i].channel.name });
    };
    add('live', str('found_live', live.length), live, function (h) { return str('until_x', Fmt.hhmm(h.p.stop)); });
    add('soon', str('found_soon', soon.length), soon, function (h) { return self.whenText(h.p.start); });
    add('arch', str('found_archive', arch.length), arch, function (h) { return self.whenText(h.p.start); });
    this.items = out;
    this.ri = this.next(-1, 1);
    if (!out.length && this.zone === Zone.RESULTS) this.zone = Zone.KEYS;
    const qq = this.query.trim().toLowerCase();
    const s: { text: string; recent: boolean }[] = [];
    const rec = Prefs.searchRecent;
    for (let i = 0; i < rec.length && s.length < MAX_SUGS; i++) if (rec[i].toLowerCase() !== qq && (!qq || rec[i].toLowerCase().indexOf(qq) >= 0)) s.push({ text: rec[i], recent: true });
    if (qq) {
      const titles = chans.map(function (c) { return c.name; }).concat(live.map(function (h) { return h.p.title; }), soon.map(function (h) { return h.p.title; }), arch.map(function (h) { return h.p.title; }));
      for (let i = 0; i < titles.length && s.length < MAX_SUGS; i++) {
        const t = titles[i];
        if (t.toLowerCase() !== qq && !s.some(function (x) { return x.text.toLowerCase() === t.toLowerCase(); })) s.push({ text: t, recent: false });
      }
    }
    this.sugs = s;
    this.si = Math.max(0, Math.min(this.si, s.length - 1));
    if (!s.length && this.zone === Zone.QUERIES) this.zone = Zone.KEYS;
    this.renderResults();
    this.render();
  }

  private next(from: number, dir: number): number {
    let i = from + dir;
    while (i >= 0 && i < this.items.length) { if (this.items[i].kind !== 'head') return i; i += dir; }
    return -1;
  }

  private renderResults() {
    const inner = this.resScroller.inner;
    while (inner.firstChild) inner.removeChild(inner.firstChild);
    const self = this;
    const list = el('div', 'list', null, inner);
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.kind === 'head') { it.el = el('div', 'gl', it.title, list); continue; }
      const r = el('div', 'it', null, list);
      r.style.height = '4rem';
      if (it.channel) r.appendChild(Logos.el(it.channel));
      const t = el('div', 'grow', null, r);
      el('div', 'el', it.title, t);
      if (it.side) el('div', 'el t60', it.side, t).style.fontSize = '1.15rem';
      if (it.time) el('span', 'v', it.time, r);
      it.el = r;
      (function (k) { r.addEventListener('click', function () { self.zone = Zone.RESULTS; self.ri = k; self.enter(); }); })(i);
    }
    const w = this.words();
    setText(this.status, !w.length ? str('search_start_typing') : this.searching ? str('searching') : !this.items.length ? str('nothing_found') : '');
    this.resScroller.scrollTo(0);
  }

  private render() {
    setText(this.qEl, this.query + (this.zone === Zone.KEYS ? '|' : ''));
    for (let r = 0; r < this.rows.length; r++) for (let k = 0; k < this.rows[r].length; k++) {
      const e = this.rows[r][k].el;
      if (!e) continue;
      toggle(e, 'f', this.zone === Zone.KEYS && r === this.kr && k === this.kc);
      toggle(e, 'r', this.zone !== Zone.KEYS && r === this.kr && k === this.kc);
    }
    const sg = this.sugEl;
    while (sg.firstChild) sg.removeChild(sg.firstChild);
    if (this.sugs.length) el('div', 'gl', str('queries'), sg).style.paddingLeft = '0';
    // запросов — сколько помещается над строкой подсказок
    const room = U.h - U.px(2.4 + (Prefs.keyHints ? 2.6 : 0) + 3.2) - sg.getBoundingClientRect().top;
    const fit = Math.max(1, Math.floor(room / U.px(3)));
    if (this.sugs.length > fit) this.sugs.length = fit;
    if (this.si >= this.sugs.length) this.si = this.sugs.length - 1;
    for (let i = 0; i < this.sugs.length; i++) {
      const r = el('div', 'it', null, sg);
      r.style.height = '3rem';
      r.appendChild(icon(this.sugs[i].recent ? 'hist' : 'search'));
      el('span', 'el grow', this.sugs[i].text, r).style.marginLeft = '0.8rem';
      toggle(r, 'f', this.zone === Zone.QUERIES && i === this.si);
    }
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.kind !== 'head' && it.el) toggle(it.el, 'f', this.zone === Zone.RESULTS && i === this.ri);
    }
    const f = this.items[this.ri];
    if (this.zone === Zone.RESULTS && f && f.el) this.resScroller.reveal(f.el.offsetTop - U.px(3), f.el.offsetTop + f.el.offsetHeight, U.px(1));
    const h: [string, string][] = this.zone === Zone.RESULTS ? [['OK', str('watch')], [str('key_hold_ok'), str('hint_programme')], ['←', str('hint_keyboard')]]
      : this.zone === Zone.QUERIES ? [['OK', str('hint_select')], ['↑', str('hint_keyboard')], ['→', str('hint_results')]]
        : [['OK', str('hint_type')], ['→', str('hint_results')], [str('key_back'), str('close')]];
    hintRow(this.hints, h);
  }

  private remember() {
    const q = this.query.trim();
    if (q.length < 2) return;
    Prefs.searchRecent = [q].concat(Prefs.searchRecent.filter(function (r) { return r.toLowerCase() !== q.toLowerCase(); })).slice(0, MAX_RECENT);
  }

  key(name: string, _long: boolean, digit: number) {
    if (name === 'digit') { if (this.query.length < MAX_QUERY) { this.query += digit; this.changed(); } return; }
    if (this.zone === Zone.KEYS) {
      const k = this.rows[this.kr][this.kc];
      const center = k.col + k.span / 2;
      if (name === 'left') { if (this.kc > 0) this.kc--; }
      else if (name === 'right') { if (this.kc < this.rows[this.kr].length - 1) this.kc++; else if (this.ri >= 0) this.zone = Zone.RESULTS; }
      else if (name === 'up') { if (this.kr > 0) { this.kr--; this.kc = this.keyAt(this.kr, center); } }
      else if (name === 'down') { if (this.kr < this.rows.length - 1) { this.kr++; this.kc = this.keyAt(this.kr, center); } else if (this.sugs.length) { this.zone = Zone.QUERIES; this.si = 0; } }
    } else if (this.zone === Zone.QUERIES) {
      if (name === 'up') { if (this.si > 0) this.si--; else this.zone = Zone.KEYS; }
      else if (name === 'down') { if (this.si < this.sugs.length - 1) this.si++; }
      else if (name === 'right') { if (this.ri >= 0) this.zone = Zone.RESULTS; }
    } else {
      const step = (d: number) => { const j = this.next(this.ri, d); if (j >= 0) this.ri = j; };
      if (name === 'up') step(-1);
      else if (name === 'down') step(1);
      else if (name === 'pgup') for (let i = 0; i < 6; i++) step(-1);
      else if (name === 'pgdown') for (let i = 0; i < 6; i++) step(1);
      else if (name === 'left') this.zone = Zone.KEYS;
    }
    this.render();
  }

  wheel(dy: number) { if (this.zone === Zone.RESULTS) this.key(dy > 0 ? 'down' : 'up', false, 0); else this.resScroller.by(dy > 0 ? U.px(4) : -U.px(4)); }

  enter() {
    if (this.zone === Zone.KEYS) { this.press(this.rows[this.kr][this.kc]); this.render(); return; }
    if (this.zone === Zone.QUERIES) {
      const s = this.sugs[this.si];
      if (!s) return;
      this.query = s.text.substring(0, MAX_QUERY);
      this.zone = Zone.KEYS;
      this.changed();
      return;
    }
    const it = this.items[this.ri];
    if (!it || !it.channel) return;
    this.remember();
    const ch = it.channel;
    if (it.kind === 'channel') { this.onClose(); this.tv.closeGuide(true); this.tv.playChannel(ch); return; }
    const now = Clock.now();
    const p = this.tv.repo.range(ch, it.start!, it.stop!)[0] || null;
    if (it.start! <= now && now < it.stop!) { this.onClose(); this.tv.closeGuide(true); this.tv.playChannel(ch); }
    else if (it.stop! <= now && ch.hasArchive) { this.onClose(); this.tv.closeGuide(true); this.tv.playArchive(ch, it.start!, it.stop!); }
    else this.tv.openDetails(ch, new Cell(it.start!, it.stop!, p));
  }

  long() {
    if (this.zone === Zone.KEYS) {
      const k = this.rows[this.kr][this.kc];
      if (k.action === DEL && this.query) { this.query = ''; this.changed(); } else this.press(k);
      this.render();
    } else if (this.zone === Zone.QUERIES) {
      const s = this.sugs[this.si];
      if (s && s.recent) { Prefs.searchRecent = Prefs.searchRecent.filter(function (r) { return r !== s.text; }); this.update(); }
    } else {
      const it = this.items[this.ri];
      if (it && it.channel) this.tv.openSchedule(it.channel, 0);
    }
  }

  back() {
    if (this.zone === Zone.KEYS) this.onClose(); else { this.zone = Zone.KEYS; this.render(); }
  }

  destroy() { this.gen++; clearTimeout(this.timer); }
}
