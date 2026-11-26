import { Clock } from '../clock';
import { str } from '../lang';
import { Prefs } from '../prefs';
import { Channel, Programme } from '../data/models';
import { Anim, el, icon, setText, visible } from './dom';
import { Fmt } from './fmt';
import { hintRow } from './widgets';
import { Logos } from './logos';
import { DomMarquee } from './marquee';
import { C, lite, roundRect, U } from './u';
import type { InfoView } from './views';

export interface InfoModel {
  channel: Channel;
  program: Programme | null;
  next: Programme | null;
  next2: Programme | null;
  archive: boolean;
  position: number;
  ahead: number;
  seek: number | null;
  height: number;
  paused: boolean;
  error: boolean;
  /** Встроенный плеер вместо hls.js («NAT») */
  engine: string;
  /** Звуковых дорожек (бейдж, если больше одной) и дорожек субтитров (бейдж, если есть) */
  audios: number;
  subtitles: number;
}

const SLOT = 1800;

function hhmmss(sec: number): string {
  const s = Math.floor(sec) % 60;
  return Fmt.hhmm(sec) + ':' + (s < 10 ? '0' + s : s);
}

/**
 * Инфопанель (docs/design.md, «Инфопанель»): затемнение во всю ширину, логотип, канал и бейджи,
 * передача, шкала с буфером и «ещё N мин» (в архиве — время кадра), «Далее» — две передачи
 * (при перемотке — пузырь), часы; ↓ — закрепить (подсказки), ↓↓ — описание и «Далее на канале».
 */
export class InfoPanel implements InfoView {
  readonly el: HTMLElement;
  visible = false;
  sticky = false;
  more = false;
  onHide: (() => void) | null = null;

  private channel: Channel | null = null;
  private logo: HTMLElement;
  private chName: HTMLElement;
  private badges: HTMLElement;
  private clock: HTMLElement;
  private title: HTMLElement;
  private titleMq: DomMarquee;
  private tStart: HTMLElement;
  private tEnd: HTMLElement;
  private barBox: HTMLElement;
  private bar: HTMLCanvasElement;
  private remain: HTMLElement;
  private next: HTMLElement;
  private seekB: HTMLElement;
  private liveL: HTMLElement;
  private moreBox: HTMLElement;
  private banner: HTMLElement;
  private tags: HTMLElement;
  private desc: HTMLElement;
  private upnext: HTMLElement;
  private hints: HTMLElement;
  private hideTimer = 0;
  private badgesKey = '';
  private barState = { v: 0, b: 0, s: -1, arch: false, live: -1 };
  /** Положение «эфира» на шкале в архиве (0..1), -1 — нет: красная черта, при перемотке — метка «Эфир» */
  private liveAt = -1;
  private hintKey = '';
  private hintArchive = false;
  private hintPaused = false;

  constructor(parent: HTMLElement) {
    const root = el('div', '', null, parent);
    root.id = 'info';
    root.style.display = 'none';
    this.el = root;
    this.paintBackground();

    const top = el('div', 'top', null, root);
    this.logo = el('div', 'logo', null, top);
    const body = el('div', 'body', null, top);
    const l1 = el('div', 'row l1', null, body);
    this.chName = el('div', 'chname el', null, l1);
    this.badges = el('div', 'badges row', null, l1);
    this.title = el('div', 'title el', null, body);
    this.titleMq = new DomMarquee(this.title);
    const l3 = el('div', 'row l3', null, body);
    this.tStart = el('div', 'ts', null, l3);
    this.barBox = el('div', 'bar', null, l3);
    this.bar = document.createElement('canvas');
    this.barBox.appendChild(this.bar);
    this.tEnd = el('div', 'ts', null, l3);
    this.remain = el('div', 'remain', null, l3);
    const l4 = el('div', 'l4', null, body);
    this.next = el('div', 'next el', null, l4);
    // метка «Эфир» под красной чертой; пузырь перемотки (он позже в разметке) перекрывает её
    this.liveL = el('div', 'seekb livel', str('live'), l4);
    this.liveL.style.visibility = 'hidden';
    this.seekB = el('div', 'seekb', null, l4);
    this.seekB.style.visibility = 'hidden';
    this.clock = el('div', 'clock', null, top);

    this.moreBox = el('div', 'more', null, root);
    this.moreBox.style.display = 'none';
    el('div', 'sep', null, this.moreBox);
    const mrow = el('div', 'mrow', null, this.moreBox);
    this.banner = el('div', 'banner', null, mrow);
    const mid = el('div', 'grow', null, mrow);
    this.tags = el('div', 'tags', null, mid);
    this.desc = el('div', 'desc', null, mid);
    this.upnext = el('div', 'upnext', null, mrow);
    this.hints = el('div', 'hints', null, root);
    this.layout();
  }

  /** Колонки «О передаче» — долями ширины: картинка 25% (16:9), «Далее на канале» 27% */
  layout() {
    const cw = U.w - 2 * U.px(4);
    this.banner.style.width = Math.round(cw * 0.25) + 'px';
    this.banner.style.height = Math.round(cw * 0.25 * 9 / 16) + 'px';
    this.upnext.style.width = Math.round(cw * 0.27) + 'px';
    // описание не выше картинки: строк столько, сколько помещается рядом с одной строкой тегов
    // (число зависит от размера интерфейса, высота панели не прыгает от длины текста)
    const lh = U.px(1.85);
    const lines = Math.max(2, Math.floor((cw * 0.25 * 9 / 16 - U.px(1.6) - U.px(0.6)) / lh));
    this.desc.style.maxHeight = Math.round(lines * lh) + 'px';
  }

  update(m: InfoModel) {
    const ch = m.channel;
    if (this.channel !== ch) {
      this.channel = ch;
      Logos.fill(this.logo, ch);
    }
    setText(this.chName, ch.title());
    setText(this.clock, Fmt.hhmm(Clock.now()));
    this.setBadges(m);
    const p = m.program;
    const ref = m.seek !== null ? m.seek : m.position;
    this.titleMq.set(p ? p.title : (m.archive || m.seek !== null ? str('archive') + Fmt.hhmm(ref) : str('no_programme')));
    const from = p ? p.start : ref - ref % SLOT;
    const to = p ? p.stop : from + SLOT;
    setText(this.tStart, Fmt.hhmm(from));
    setText(this.tEnd, Fmt.hhmm(to));
    const f = function (x: number) { return Fmt.progress(from, to, x); };
    const v = f(m.position);
    const b = m.ahead > 0 ? Math.max(f(m.position + m.ahead), v + 0.01) : v;
    // архив идущей передачи (или слота около эфира): красная черта «эфир» — там, куда дойдёт архив
    const now = Clock.now();
    this.liveAt = m.archive && to > from && now >= from && now <= to ? (now - from) / (to - from) : -1;
    this.drawBar(v, b, m.seek !== null ? f(m.seek) : -1, m.archive);
    let rem = '';
    if (m.seek === null) {
      if (m.archive) rem = hhmmss(m.position);
      else if (p) rem = this.remainText(p.stop - m.position);
    }
    setText(this.remain, rem);
    if (m.seek !== null) {
      const diff = m.seek - Clock.now();
      setText(this.seekB, hhmmss(m.seek) + '   ' + (diff < 0 ? '−' : '+') + Fmt.duration(Math.abs(diff)));
      this.next.style.visibility = 'hidden';
      this.seekB.style.visibility = 'visible';
      this.placeSeek(f(m.seek));
      this.placeLive();
    } else {
      this.seekB.style.visibility = 'hidden';
      this.liveL.style.visibility = 'hidden';
      this.next.style.visibility = 'visible';
      this.setNext(m);
    }
    this.hintArchive = m.archive;
    this.hintPaused = m.paused;
    this.updateHints();
  }

  private remainText(sec: number): string {
    if (sec <= 0) return '';
    const min = Math.floor((sec + 59) / 60);
    if (min < 60) return str('x_min_left', min);
    const mm = min % 60;
    return str('x_h_x_min_left', Math.floor(min / 60), mm < 10 ? '0' + mm : String(mm));
  }

  private nextKey = '';
  private setNext(m: InfoModel) {
    const n = m.next;
    const k = n ? n.start + n.title + (m.next2 ? m.next2.start + m.next2.title : '') : '';
    if (k === this.nextKey && this.next.firstChild) return;
    this.nextKey = k;
    while (this.next.firstChild) this.next.removeChild(this.next.firstChild);
    el('span', 'lbl', str('next'), this.next);
    let s = n ? Fmt.hhmm(n.start) + ' ' + n.title : str('no_programme_2');
    if (n && m.next2) s += '   ·   ' + Fmt.hhmm(m.next2.start) + ' ' + m.next2.title;
    this.next.appendChild(document.createTextNode(s));
  }

  /** Точка шкалы (0..1) по горизонтали в строке под шкалой (пузырь и метка — в ней) */
  private barX(at: number): number {
    const row = (this.seekB.parentNode as HTMLElement).getBoundingClientRect();
    const bar = this.barBox.getBoundingClientRect();
    return bar.left - row.left + bar.width * Math.max(0, Math.min(1, at));
  }

  /** Пузырь перемотки — под маркером шкалы, у краёв строки — прижат к ним */
  private placeSeek(at: number) {
    const w = this.seekB.offsetWidth;
    const parentW = (this.seekB.parentNode as HTMLElement).offsetWidth;
    const x = Math.max(0, Math.min(this.barX(at) - w / 2, parentW - w));
    this.seekB.style.left = Math.round(x) + 'px';
  }

  /** Метка «Эфир» — под красной чертой, у краёв строки — прижата к ним */
  private placeLive() {
    if (this.liveAt < 0) { this.liveL.style.visibility = 'hidden'; return; }
    const w = this.liveL.offsetWidth;
    const total = (this.liveL.parentNode as HTMLElement).offsetWidth;
    const x = this.barX(this.liveAt) - w / 2;
    this.liveL.style.left = Math.round(Math.max(0, Math.min(x, total - w))) + 'px';
    this.liveL.style.visibility = 'visible';
  }

  private drawBar(v: number, b: number, s: number, arch: boolean) {
    const st = this.barState;
    const live = this.liveAt;
    const cw = this.barBox.offsetWidth, ch = this.barBox.offsetHeight;
    const dpr = U.dpr;
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (st.v === v && st.b === b && st.s === s && st.arch === arch && st.live === live && this.bar.width === W && this.bar.height === H) return;
    st.v = v; st.b = b; st.s = s; st.arch = arch; st.live = live;
    if (W <= 0 || H <= 0) return;
    if (this.bar.width !== W) this.bar.width = W;
    if (this.bar.height !== H) this.bar.height = H;
    const c = this.bar.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cw, ch);
    const t = Math.min(ch, U.px(0.35));
    const top = (ch - t) / 2, bottom = top + t, r = t / 2;
    roundRect(c, 0, top, cw, bottom, r, C.FILL_MARKED);
    roundRect(c, 0, top, cw * b, bottom, r, C.t(0.35));
    const on = arch ? C.ARCHIVE : C.WHITE;
    c.globalAlpha = s >= 0 ? 0.6 : 1;
    roundRect(c, 0, top, cw * v, bottom, r, on);
    c.globalAlpha = 1;
    if (live >= 0) {
      // красная черта «эфир»: при перемотке — высотой с ползунок, без перемотки — не выше полосы
      const half = U.px(0.12), edge = U.px(0.1);
      const x = Math.max(half, Math.min(cw - half, cw * live));
      if (s >= 0) roundRect(c, x - half, edge, x + half, ch - edge, half, C.LIVE);
      else roundRect(c, x - half, top, x + half, bottom, half, C.LIVE);
    }
    if (s >= 0) {
      const half = U.px(0.25), edge = U.px(0.1);
      const x = Math.max(half, Math.min(cw - half, cw * s));
      roundRect(c, x - half - edge, 0, x + half + edge, ch, half, C.PANEL);
      roundRect(c, x - half, edge, x + half, ch - edge, half, C.WHITE);
    }
  }

  private setBadges(m: InfoModel) {
    const parts: string[] = [];
    if (m.error) parts.push('live|' + str('error'));
    if (m.paused) parts.push('pause|');
    if (m.archive) {
      const lag = Clock.now() - m.position;
      parts.push('arch|' + str('archive_2') + (lag > 0 ? ' · −' + Fmt.duration(lag) : ''));
    } else parts.push('live|' + str('live'));
    if (m.height > 0) parts.push('|' + (m.height >= 2000 ? '4K' : m.height >= 1000 ? 'FHD' : m.height >= 700 ? 'HD' : 'SD'));
    if (m.engine) parts.push('|' + m.engine);
    if (m.audios > 1) parts.push('|' + str('audio_n', m.audios));
    if (m.subtitles > 0) parts.push('|SUB');
    if (m.channel.hasArchive) parts.push('hist|' + str('x_d', m.channel.archiveDays));
    const key = parts.join('#');
    if (key === this.badgesKey) return;
    this.badgesKey = key;
    const box = this.badges;
    while (box.firstChild) box.removeChild(box.firstChild);
    for (let i = 0; i < parts.length; i++) {
      const k = parts[i].substring(0, parts[i].indexOf('|'));
      const text = parts[i].substring(parts[i].indexOf('|') + 1);
      const b = el('span', 'bdg' + (k === 'live' ? ' live' : k === 'arch' ? ' arch' : k === 'pause' ? ' pause' : ''), null, box);
      if (k === 'pause') { el('i', '', null, b); el('i', '', null, b); continue; }
      if (k === 'hist') b.appendChild(icon('archive'));
      b.appendChild(document.createTextNode(text));
    }
  }

  // ------------------------------------------------------------ подсказки

  private updateHints() {
    const show = this.visible && this.sticky && Prefs.keyHints;
    visible(this.hints, show);
    if (!show) return;
    const key = this.hintArchive + '|' + this.hintPaused + '|' + this.more;
    if (key === this.hintKey && this.hints.firstChild) return;
    this.hintKey = key;
    const h: [string, string][] = [];
    h.push(['OK', str(this.hintPaused ? 'hint_resume' : 'hint_pause')]);
    if (this.more) h.push(['↑', str('hint_collapse')]);
    else { h.push(['↓', str('about')]); h.push(['↑', str('close')]); }
    h.push(['←  →', str(this.hintArchive ? 'hint_seek' : 'hint_channel')]);
    h.push([str('key_hold_ok'), str('menu')]);
    hintRow(this.hints, h);
  }

  // ------------------------------------------------------------ описание

  private bannerUrl = '';

  setMore(tags: string, text: string, image: string, ch: Channel | null, upcoming: Programme[]) {
    this.more = true;
    setText(this.tags, tags);
    setText(this.desc, text);
    visible(this.desc, text.length > 0);
    const self = this;
    const logoBanner = function () {
      self.bannerUrl = '';
      while (self.banner.firstChild) self.banner.removeChild(self.banner.firstChild);
      if (ch) self.banner.appendChild(Logos.el(ch, '', false));
    };
    if (image) {
      if (this.bannerUrl !== image) {
        this.bannerUrl = image;
        Logos.banner(this.banner, image, function () { if (self.bannerUrl === image) logoBanner(); });
      }
    } else logoBanner();
    const up = this.upnext;
    while (up.firstChild) up.removeChild(up.firstChild);
    el('div', 'h', str('next_on_the_channel'), up);
    for (let i = 0; i < upcoming.length; i++) {
      const r = el('div', 'r el', null, up);
      el('b', '', Fmt.hhmm(upcoming[i].start), r);
      r.appendChild(document.createTextNode(upcoming[i].title));
    }
    visible(up, upcoming.length > 0);
    this.updateHints();
    this.animateMore(true);
  }

  collapse() {
    if (!this.more) return;
    this.more = false;
    this.updateHints();
    this.animateMore(false);
  }

  private animateMore(show: boolean) {
    const b = this.moreBox;
    const shown = b.style.display !== 'none';
    if (!Anim.on || !this.visible) {
      b.style.transition = 'none';
      b.style.height = '';
      b.style.opacity = '1';
      visible(b, show);
      return;
    }
    if (show === shown && b.style.height === '') return;
    const from = shown ? b.offsetHeight : 0;
    b.style.transition = 'none';
    b.style.display = '';
    b.style.height = '';
    const to = show ? b.scrollHeight : 0;
    b.style.height = from + 'px';
    b.style.opacity = shown ? '1' : '0';
    void b.offsetHeight;
    b.style.transition = 'height 250ms ease-out, opacity 200ms';
    b.style.height = to + 'px';
    b.style.opacity = show ? '1' : '0';
    const self = this;
    setTimeout(function () {
      if (self.more !== show) return;
      b.style.transition = 'none';
      b.style.height = '';
      if (!show) b.style.display = 'none';
    }, 270);
  }

  /** timeout 0 — закрепить; закреплённую повторный show с таймаутом не открепляет */
  show(timeout: number) {
    if (this.visible && this.sticky && timeout !== 0) return;
    this.sticky = timeout === 0;
    if (!this.visible) {
      this.visible = true;
      Anim.show(this.el);
      this.titleMq.refresh();
    }
    clearTimeout(this.hideTimer);
    const self = this;
    if (timeout !== 0) this.hideTimer = window.setTimeout(function () { self.hide(); }, timeout * 1000);
    this.updateHints();
  }

  hide() {
    clearTimeout(this.hideTimer);
    if (!this.visible) return;
    if (this.onHide) this.onHide();
    this.visible = false;
    this.sticky = false;
    this.collapse();
    this.titleMq.halt();
    Anim.hide(this.el);
  }

  /**
   * Затемнение — фоном самой панели: дочерний слой с z-index −1 поверх видео не рисуется.
   * Облегчённый интерфейс без прозрачности — сплошной фон (верхний отступ меньше — style.ts LITE)
   */
  private paintBackground() {
    const root = this.el;
    if (lite()) { root.style.background = C.SCRIM; return; }
    const fade = 'rgba(8,9,11,0) 0, rgba(8,9,11,.53) 2.8rem, rgba(8,9,11,.91) 5.6rem, rgba(8,9,11,.97) 100%';
    root.style.background = '-webkit-linear-gradient(top,' + fade + ')';
    root.style.background = 'linear-gradient(to bottom,' + fade + ')';
  }

  relabel() { this.paintBackground(); this.badgesKey = ''; this.hintKey = ''; this.nextKey = ''; }

  panelHeight(): number { return this.visible ? Math.max(0, this.el.offsetHeight - U.px(5.6)) : 0; }

  destroy() { this.hide(); if (this.el.parentNode) this.el.parentNode.removeChild(this.el); }
}
