import { Clock } from '../clock';
import { Log } from '../log';
import { str } from '../lang';
import { Channel } from '../data/models';
import { inArchive, isMissed, Reminder } from '../data/reminders';
import { Anim, el, setText, toggle, visible } from './dom';
import { Fmt } from './fmt';
import { Layer } from './layer';
import { Logos } from './logos';
import { keycap } from './widgets';
import { C, U } from './u';

/**
 * Окно по центру поверх затемнения. widthEm — ширина в em (не шире 90% экрана),
 * heightFraction — высота долей экрана (0 — по содержимому).
 */
export abstract class PopupLayer implements Layer {
  el: HTMLElement;
  win: HTMLElement;

  constructor(parent: HTMLElement, widthEm: number, heightFraction = 0) {
    this.el = el('div', 'overlay', null, parent);
    this.win = el('div', 'win', null, this.el);
    const w = Math.min(U.px(widthEm), U.w * 0.9);
    this.win.style.width = Math.round(w) + 'px';
    this.win.style.left = Math.round((U.w - w) / 2) + 'px';
    if (heightFraction > 0) {
      const h = U.h * heightFraction;
      this.win.style.height = Math.round(h) + 'px';
      this.win.style.top = Math.round((U.h - h) / 2) + 'px';
    }
    const self = this;
    // клик Magic Remote вне окна — закрыть
    this.el.addEventListener('click', function (e) { if (e.target === self.el && self.back) self.back(); });
    Anim.show(this.el);
  }

  /** Окно по содержимому — по центру по вертикали */
  protected center() {
    if (this.win.style.height) return;
    const h = this.win.offsetHeight;
    this.win.style.top = Math.round(Math.max(U.px(2.4), (U.h - h) / 2)) + 'px';
  }

  protected head(ch: Channel | null, title: string, subtitle?: string): HTMLElement {
    const r = el('div', 'row head', null, this.win);
    if (ch) {
      const lg = Logos.el(ch, '', false);
      lg.style.width = U.px(4.6) + 'px';
      lg.style.height = U.px(3) + 'px';
      lg.style.marginRight = U.px(1) + 'px';
      r.appendChild(lg);
    }
    const t = el('div', 'grow', null, r);
    const h = el('div', 'el', title, t);
    if (subtitle) el('div', 't60 el', subtitle, t).style.cssText = 'font-size:1.2rem;font-weight:400;margin-top:0.2rem';
    return h;
  }

  protected buttons(labels: string[], onClick: (i: number) => void): HTMLElement[] {
    const box = el('div', 'btns', null, this.win);
    const out: HTMLElement[] = [];
    for (let i = 0; i < labels.length; i++) {
      const b = el('div', 'btn', labels[i], box);
      (function (k) { b.addEventListener('click', function () { onClick(k); }); })(i);
      out.push(b);
    }
    return out;
  }

  protected select(views: HTMLElement[], index: number) {
    for (let i = 0; i < views.length; i++) toggle(views[i], 'f', i === index);
  }

  back?(): void;
}

/** Прокручиваемый столбец строк одинаковой высоты: фокус всегда виден, края гаснут */
export class Scroller {
  box: HTMLElement;
  inner: HTMLElement;
  private fadeTop: HTMLElement;
  private fadeBottom: HTMLElement;
  offset = 0;

  constructor(parent: HTMLElement, heightPx: number, bg: string) {
    this.box = el('div', 'scroller', null, parent);
    this.box.style.height = Math.round(heightPx) + 'px';
    this.inner = el('div', 'inner', null, this.box);
    this.fadeTop = el('div', 'fade-top', null, this.box);
    this.fadeBottom = el('div', 'fade-bottom', null, this.box);
    const g = function (dir: string) { return '-webkit-linear-gradient(' + dir + ',' + bg + ',rgba(0,0,0,0))'; };
    this.fadeTop.style.background = g('top');
    this.fadeBottom.style.background = g('bottom');
  }

  /** Прокрутить так, чтобы элемент [top, bottom) был виден (с запасом в строку) */
  reveal(top: number, bottom: number, margin = 0) {
    const h = this.box.clientHeight;
    const total = this.inner.offsetHeight;
    let off = this.offset;
    if (top - margin < off) off = top - margin;
    if (bottom + margin > off + h) off = bottom + margin - h;
    off = Math.max(0, Math.min(off, Math.max(0, total - h)));
    this.scrollTo(off);
  }

  private lastScroll = 0;
  private applied = NaN;

  /**
   * Сдвиг списка. Плавно (120 мс) — только редкие сдвиги: при листании подряд (чаще раза в 250 мс)
   * и в облегчённом интерфейсе — сразу. Каждая плавная прокрутка — 7–8 кадров пересборки экрана;
   * при удержании клавиши они шли почти непрерывно (настройки на эмуляторе webOS 4 — 156% ядра у
   * сборки экрана).
   */
  scrollTo(off: number) {
    this.offset = off;
    const y = -Math.round(off);
    if (y !== this.applied) {
      const now = Date.now();
      const smooth = Anim.on && now - this.lastScroll > 250;
      this.lastScroll = now;
      this.applied = y;
      const tr = smooth ? '' : 'none';
      if ((this.inner as any).__tr !== tr) { (this.inner as any).__tr = tr; this.inner.style.webkitTransition = tr; this.inner.style.transition = tr; }
      const t = 'translateY(' + y + 'px)';
      this.inner.style.webkitTransform = t;
      this.inner.style.transform = t;
    }
    const h = this.box.clientHeight;
    const total = this.inner.offsetHeight;
    visible(this.fadeTop, off > 1);
    visible(this.fadeBottom, off + h < total - 1);
  }

  by(dy: number) {
    const h = this.box.clientHeight;
    const total = this.inner.offsetHeight;
    this.scrollTo(Math.max(0, Math.min(this.offset + dy, Math.max(0, total - h))));
  }
}

export interface ListItem {
  label: string;
  value?: string;
  channel?: Channel | null;
  sub?: string;
  progress?: number;
  action: () => void;
  long?: () => void;
}

/** Список: ↑/↓ (по кругу), PG± — страница, OK — действие, удерж. OK — long */
export class ListLayer extends PopupLayer {
  private rows: HTMLElement[] = [];
  private index = 0;
  private scroller: Scroller | null = null;
  private rowH = U.px(3.6);

  constructor(parent: HTMLElement, title: string, private items: ListItem[], private onBack: () => void, opts?: { ch?: Channel | null; subtitle?: string; width?: number; empty?: string; rowEm?: number }) {
    super(parent, (opts && opts.width) || 46);
    const o = opts || {};
    if (o.rowEm) this.rowH = U.px(o.rowEm);
    this.head(o.ch || null, title, o.subtitle);
    if (!items.length) {
      el('div', 'empty', o.empty || str('empty'), this.win);
    } else {
      const max = U.h * 0.72;
      const h = Math.min(max, items.length * this.rowH);
      this.scroller = new Scroller(this.win, h, C.POPUP);
      const list = el('div', 'list', null, this.scroller.inner);
      const self = this;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const r = el('div', 'it', null, list);
        r.style.height = this.rowH + 'px';
        if (it.channel) r.appendChild(Logos.el(it.channel));
        const tx = el('div', 'grow', null, r);
        el('div', 'el', it.label, tx);
        if (it.sub) el('div', 'el t60', it.sub, tx).style.fontSize = '1.15rem';
        if (it.progress !== undefined) { const pb = el('div', 'pbar', null, tx); el('i', '', null, pb).style.width = Math.round(it.progress * 100) + '%'; }
        if (it.value) el('span', 'v', it.value, r);
        (function (k) {
          r.addEventListener('click', function () { self.index = k; self.focus(); self.enter(); });
          r.addEventListener('mousemove', function () { if (self.index !== k) { self.index = k; self.focus(); } });
        })(i);
        this.rows.push(r);
      }
    }
    this.center();
    this.focus();
  }

  private focus() {
    this.select(this.rows, this.index);
    if (this.scroller) this.scroller.reveal(this.index * this.rowH, (this.index + 1) * this.rowH, this.rowH);
  }

  key(name: string) {
    const n = this.items.length;
    if (!n) return;
    const page = Math.max(1, Math.floor((this.scroller ? this.scroller.box.clientHeight : 0) / this.rowH) - 1);
    if (name === 'up') this.index = (this.index - 1 + n) % n;
    else if (name === 'down') this.index = (this.index + 1) % n;
    else if (name === 'pgup') this.index = Math.max(0, this.index - page);
    else if (name === 'pgdown') this.index = Math.min(n - 1, this.index + page);
    else return;
    this.focus();
  }

  wheel(dy: number) { this.key(dy > 0 ? 'down' : 'up'); }
  enter() { const it = this.items[this.index]; if (it) it.action(); }
  long() { const it = this.items[this.index]; if (it && it.long) it.long(); }
  back() { this.onBack(); }
}

/** Сообщение с кнопками (экран ошибки, подтверждение) */
export class MessageLayer extends PopupLayer {
  private index = 0;
  private views: HTMLElement[];
  constructor(parent: HTMLElement, title: string, text: string, private labels: string[], private onAction: (i: number) => void, private onBack: () => void) {
    super(parent, 44);
    this.head(null, title);
    if (text) { const p = el('div', 't75', text, this.win); p.style.cssText = 'font-size:1.35rem;line-height:1.9rem;white-space:pre-line'; }
    const self = this;
    this.views = this.buttons(labels, function (i) { self.onAction(i); });
    this.select(this.views, 0);
    this.center();
  }
  key(name: string) {
    const n = this.views.length;
    if (name === 'left') this.index = (this.index - 1 + n) % n;
    else if (name === 'right') this.index = (this.index + 1) % n;
    else return;
    this.select(this.views, this.index);
  }
  enter() { this.onAction(this.index); }
  back() { this.onBack(); }
}

/** Карточка передачи: время, название, описание (↑/↓ — прокрутка), кнопки ←/→ */
export class DetailsLayer extends PopupLayer {
  private index = 0;
  private views: HTMLElement[];
  private scroller: Scroller;
  constructor(parent: HTMLElement, ch: Channel, time: string, title: string, desc: string, labels: string[], private onAction: (i: number) => void, private onBack: () => void) {
    super(parent, 56);
    this.head(ch, ch.title(), time);
    const t = el('div', '', title, this.win);
    t.style.cssText = 'font-size:1.8rem;font-weight:700;margin:0.4rem 0 0.8rem;line-height:2.3rem';
    this.scroller = new Scroller(this.win, U.px(16), C.POPUP);
    const d = el('div', 't85', desc || str('no_description'), this.scroller.inner);
    d.style.cssText = 'font-size:1.35rem;line-height:2rem;white-space:pre-line';
    const self = this;
    this.views = this.buttons(labels, function (i) { self.onAction(i); });
    this.select(this.views, 0);
    // описание короче окна — окно ниже
    const ih = this.scroller.inner.offsetHeight;
    if (ih < U.px(16)) this.scroller.box.style.height = ih + 'px';
    this.scroller.scrollTo(0);
    this.center();
  }
  key(name: string) {
    const n = this.views.length;
    if (name === 'left' && n) this.index = (this.index - 1 + n) % n;
    else if (name === 'right' && n) this.index = (this.index + 1) % n;
    else if (name === 'up') this.scroller.by(-U.px(4));
    else if (name === 'down') this.scroller.by(U.px(4));
    else return;
    this.select(this.views, this.index);
  }
  wheel(dy: number) { this.scroller.by(dy > 0 ? U.px(4) : -U.px(4)); }
  enter() { if (this.views.length) this.onAction(this.index); else this.onBack(); }
  back() { this.onBack(); }
}

/** Окно «Управление»: клавиши по разделам; ↑/↓ — прокрутка, PG± — страница, OK/Назад — закрыть */
export class HelpLayer extends PopupLayer {
  private scroller: Scroller;
  constructor(parent: HTMLElement, private onClose: () => void) {
    super(parent, 64, 0.86);
    this.head(null, str('controls'));
    this.scroller = new Scroller(this.win, U.h * 0.86 - U.px(6), C.POPUP);
    const col = this.scroller.inner;
    const text = HelpLayer.text();
    for (let i = 0; i < text.length; i++) {
      const s = el('div', 'gl', text[i][0], col);
      s.style.paddingLeft = '0';
      const rows = text[i][1];
      for (let j = 0; j < rows.length; j++) {
        const r = el('div', 'row', null, col);
        r.style.cssText = 'min-height:2.8rem;font-size:1.3rem;align-items:flex-start;-webkit-align-items:flex-start;padding:0.3rem 0';
        const k = el('div', '', null, r);
        k.style.cssText = 'width:16rem;flex:none;-webkit-flex:none';
        k.appendChild(keycap(rows[j][0]));
        el('div', 'grow t85', rows[j][1], r).style.lineHeight = '1.9rem';
      }
    }
    this.scroller.scrollTo(0);
  }

  /** Текст держать в согласии с docs/controls.md (функция: строки — на текущем языке) */
  static text(): [string, [string, string][]][] {
    return [
      [str('player'), [
        ['← / →', str('previous_next_channel_of_the')],
        ['CH+ / CH−', str('next_previous_channel')],
        ['0–9', str('channel_by_number_below_hints_for')],
        ['OK', str('tv_guide_with_the_info_panel_open')],
        [str('hold_ok_red'), str('channel_menu')],
        ['↓', str('info_panel_again_programme')],
        [str('hold_down') + ', ' + str('key_green'), str('recent_channels')],
        ['↑', str('channel_programme_and_archive_in')],
        [str('hold_up') + ', ' + str('key_yellow'), str('reminders')],
        ['▶ ❚❚ ⏪ ⏩', str('pause_seek_from_live_into_the')],
        ['⏹', str('stop_in_the_archive_back_to_live')],
        [str('guide_info'), str('tv_guide_info_panel')],
        [str('key_blue'), str('search')],
        [str('back_twice'), str('exit_the_app')],
      ]],
      [str('tv_guide'), [
        ['↑ / ↓', str('channel')],
        ['←', str('categories_up_down_right_to_channels')],
        ['→', str('into_the_grid_in_list_view_programme')],
        [str('hold_left'), str('channel_programme_and_archive')],
        [str('ok_hold_ok'), str('watch_channel_menu')],
        [str('in_the_grid'), str('arrows_programmes_ok_programme_card')],
        [str('back'), str('close_the_guide')],
      ]],
      [str('programme_and_archive'), [
        ['↑ / ↓', str('programme')],
        ['←', str('to_dates_up_down_day_left_back_to')],
        ['→', str('to_archive_reminders_tabs_up_down')],
        ['OK', str('past_from_archive_current_live')],
        [str('hold_ok'), str('programme_card_watch_from_start')],
      ]],
      [str('programme_card'), [
        ['← / →', str('buttons')],
        ['↑ / ↓', str('scroll_description')],
        ['OK', str('button_action')],
      ]],
      [str('parental_lock'), [
        [str('channel_menu'), str('lock_channel_category_by_pin_the_pin')],
        [str('pin_window'), str('remote_digits_or_the_method_from')],
        ['PIN', str('n4_6_digits_only_entered_dots_are')],
      ]],
      [str('reminders'), [
        [str('remind'), str('in_the_card_of_an_upcoming_programme')],
        [str('reminder_window'), str('watch_snooze_5_min_close_several_at')],
        [str('missed'), str('a_programme_with_an_archive_stays_in')],
      ]],
      [str('magic_remote'), [
        [str('pointer'), str('magic_remote_pointer')],
        [str('wheel'), str('magic_remote_wheel')],
      ]],
    ];
  }

  key(name: string) {
    const page = this.scroller.box.clientHeight - U.px(3);
    if (name === 'up') this.scroller.by(-U.px(3));
    else if (name === 'down') this.scroller.by(U.px(3));
    else if (name === 'pgup') this.scroller.by(-page);
    else if (name === 'pgdown') this.scroller.by(page);
  }
  wheel(dy: number) { this.scroller.by(dy > 0 ? U.px(4) : -U.px(4)); }
  enter() { this.onClose(); }
  back() { this.onClose(); }
}

/**
 * Напоминания, которые пора показать: одно окно, счётчик «1 / 3», ↑/↓ — другие,
 * ←/→ — кнопки «Смотреть» / «Отложить на 5 мин» / «Закрыть» (+ «Закрыть все»).
 * Пропущенная с архивом — «Смотреть из архива» / «Позже» / «Удалить».
 */
export class ReminderLayer extends PopupLayer {
  items: Reminder[] = [];
  private index = 0;
  private button = 0;
  private body: HTMLElement;
  private btnBox: HTMLElement;
  private btnViews: HTMLElement[] = [];
  private touched = false;

  constructor(parent: HTMLElement, private resolveChannel: (r: Reminder) => Channel, private onAct: (r: Reminder, action: string) => void, private onClose: () => void) {
    super(parent, 50);
    this.body = el('div', '', null, this.win);
    this.btnBox = el('div', '', null, this.win);
  }

  has(id: string) { return this.items.some(function (r) { return r.id === id; }); }

  add(r: Reminder) {
    if (this.has(r.id)) return;
    this.items.push(r);
    if (!this.touched) this.items.sort(function (a, b) { return a.start - b.start; });
    this.render();
  }

  drop(id: string) {
    const i = this.items.findIndex(function (r) { return r.id === id; });
    if (i < 0) return;
    this.items.splice(i, 1);
    if (this.index >= this.items.length) this.index = Math.max(0, this.items.length - 1);
    this.button = 0;
    if (!this.items.length) { this.onClose(); return; }
    this.render();
  }

  private actions(r: Reminder): [string, string][] {
    const t = Clock.now();
    const missed = isMissed(r, t) && inArchive(r, t);
    const a: [string, string][] = missed
      ? [['archive', str('watch_from_archive')], ['later', str('later')], ['delete', str('delete')]]
      : [['watch', str('watch')], ['snooze', str('snooze_5_min')], ['close', str('close')]];
    if (this.items.length > 1) a.push(['closeAll', str('close_all')]);
    return a;
  }

  private render() {
    const r = this.items[this.index];
    if (!r) return;
    const b = this.body;
    while (b.firstChild) b.removeChild(b.firstChild);
    const ch = this.resolveChannel(r);
    const t = Clock.now();
    let state: string;
    if (isMissed(r, t)) state = str('missed');
    else if (r.start <= t) state = str('already_on');
    else state = str('in_x', Fmt.until(r.start - t));
    const head = el('div', 'row head', null, b);
    const lg = Logos.el(ch, '', false);
    lg.style.cssText = 'width:4.6rem;height:3rem;margin-right:1rem';
    head.appendChild(lg);
    const ht = el('div', 'grow', null, head);
    el('div', 'el', r.chName, ht);
    el('div', 't60 el', str('reminder') + ' · ' + state, ht).style.cssText = 'font-size:1.2rem;font-weight:400';
    if (this.items.length > 1) el('div', 't60', (this.index + 1) + ' / ' + this.items.length, head).style.cssText = 'font-size:1.3rem;font-weight:400';
    el('div', 't65', Fmt.dayTimeRange(r.start, r.stop), b).style.fontSize = '1.25rem';
    const tt = el('div', '', r.title, b);
    tt.style.cssText = 'font-size:1.8rem;font-weight:700;margin:0.4rem 0 0.6rem';
    if (r.desc) { const d = el('div', 't85', r.desc, b); d.style.cssText = 'font-size:1.3rem;line-height:1.85rem;max-height:7.4rem;overflow:hidden'; }
    while (this.btnBox.firstChild) this.btnBox.removeChild(this.btnBox.firstChild);
    const acts = this.actions(r);
    const self = this;
    const box = el('div', 'btns', null, this.btnBox);
    this.btnViews = [];
    for (let i = 0; i < acts.length; i++) {
      const v = el('div', 'btn', acts[i][1], box);
      (function (k) { v.addEventListener('click', function () { self.button = k; self.enter(); }); })(i);
      this.btnViews.push(v);
    }
    if (this.button >= acts.length) this.button = 0;
    this.select(this.btnViews, this.button);
    this.win.style.height = '';
    this.center();
  }

  key(name: string) {
    const n = this.items.length;
    if (name === 'up' && n > 1) { this.index = (this.index - 1 + n) % n; this.touched = true; this.button = 0; this.render(); }
    else if (name === 'down' && n > 1) { this.index = (this.index + 1) % n; this.touched = true; this.button = 0; this.render(); }
    else if (name === 'left') { this.button = (this.button - 1 + this.btnViews.length) % this.btnViews.length; this.select(this.btnViews, this.button); }
    else if (name === 'right') { this.button = (this.button + 1) % this.btnViews.length; this.select(this.btnViews, this.button); }
  }

  enter() {
    const r = this.items[this.index];
    if (!r) return;
    const a = this.actions(r)[this.button][0];
    this.onAct(r, a);
  }

  back() { this.onAct(this.items[this.index], 'dismiss'); }
}

/** Поле ввода формы: <input> (на ТВ — экранная клавиатура системы) */
export interface Field { label: string; value: string; type?: string; input?: HTMLInputElement }

/**
 * Форма: поля и кнопки. ↑/↓ — поле или ряд кнопок, OK на поле — ввод (системная клавиатура),
 * ←/→ — кнопки.
 */
/** Строка над формой: подпись и кнопка (выбор языка в окне первого запуска) */
export interface FormLead { label: string; button: string; action: () => void }

export class FormLayer extends PopupLayer {
  private index = 0;
  private button = 0;
  private btnViews: HTMLElement[];
  private leadView: HTMLElement | null = null;
  constructor(parent: HTMLElement, title: string, private fields: Field[], labels: string[], private onAction: (i: number, values: string[]) => void, private onBack: () => void, note?: string,
    private lead?: FormLead, focusLead?: boolean) {
    super(parent, 60);
    if (lead) {
      // над формой: «Language:» и кнопка; фокус — выше первого поля (index −1)
      const row = el('div', 'row', null, this.win);
      row.style.cssText = 'margin-bottom:1.2rem';
      el('div', 't60', lead.label, row).style.cssText = 'font-size:1.3rem;margin-right:1rem';
      const b = el('div', 'btn', lead.button, row);
      b.style.marginRight = '0';
      b.addEventListener('click', function () { lead.action(); });
      this.leadView = b;
      if (focusLead) this.index = -1;
    }
    this.head(null, title);
    if (note) { const n = el('div', 't60', note, this.win); n.style.cssText = 'font-size:1.2rem;line-height:1.7rem;margin:-0.4rem 0 1rem;white-space:pre-line'; }
    const self = this;
    for (let i = 0; i < fields.length; i++) {
      const f = el('div', 'field', null, this.win);
      el('div', 'lbl', fields[i].label, f);
      const inp = document.createElement('input');
      inp.type = fields[i].type || 'text';
      inp.value = fields[i].value;
      inp.setAttribute('autocomplete', 'off');
      inp.setAttribute('spellcheck', 'false');
      f.appendChild(inp);
      fields[i].input = inp;
      (function (k) {
        inp.addEventListener('keydown', function (e) {
          // стрелки ↑/↓ и OK — не в поле, а форме
          const c = e.keyCode;
          if (c === 38 || c === 40 || c === 13 || c === 461 || c === 27) {
            e.preventDefault();
            e.stopPropagation();
            inp.blur();
            if (c === 38) self.key('up'); else if (c === 40) self.key('down');
            else if (c === 461 || c === 27) { /* закрыть только клавиатуру */ }
            else self.key('down');
          }
        });
        inp.addEventListener('focus', function () { self.index = k; self.applyFocus(false); });
      })(i);
    }
    this.btnViews = this.buttons(labels, function (i) { self.onAction(i, self.values()); });
    this.applyFocus(false);
    this.center();
  }

  values(): string[] { return this.fields.map(function (f) { return f.input ? f.input.value.trim() : ''; }); }

  private applyFocus(open: boolean) {
    if (this.leadView) toggle(this.leadView, 'f', this.index === -1);
    for (let i = 0; i < this.fields.length; i++) toggle(this.fields[i].input!, 'f', this.index === i);
    this.select(this.btnViews, this.index === this.fields.length ? this.button : -1);
    if (open && this.index < this.fields.length) this.fields[this.index].input!.focus();
  }

  key(name: string) {
    const n = this.fields.length;
    if (name === 'up') this.index = Math.max(this.leadView ? -1 : 0, this.index - 1);
    else if (name === 'down') this.index = Math.min(n, this.index + 1);
    else if (name === 'left' && this.index === n) this.button = Math.max(0, this.button - 1);
    else if (name === 'right' && this.index === n) this.button = Math.min(this.btnViews.length - 1, this.button + 1);
    else return;
    this.applyFocus(false);
  }

  enter() {
    if (this.index === -1 && this.lead) { this.lead.action(); return; }
    if (this.index < this.fields.length) { this.applyFocus(true); return; }
    this.onAction(this.button, this.values());
  }

  back() {
    const a = document.activeElement as HTMLElement | null;
    if (a && a.tagName === 'INPUT') { a.blur(); return; }
    this.onBack();
  }
}

export { setText };

/** Журнал приложения (последние строки консоли и ошибки): ↑/↓ — прокрутка, OK/Назад — закрыть */
export class LogLayer extends PopupLayer {
  private scroller: Scroller;
  constructor(parent: HTMLElement, private onClose: () => void) {
    super(parent, 90, 0.9);
    this.head(null, str('log'));
    this.scroller = new Scroller(this.win, U.h * 0.9 - U.px(6), C.POPUP);
    const pre = el('div', 't85', Log.lines().join('\n'), this.scroller.inner);
    pre.style.cssText = 'font-family:monospace;font-size:1.1rem;line-height:1.5rem;white-space:pre-wrap;word-break:break-all';
    this.scroller.scrollTo(1e9);
    this.scroller.by(0);
  }
  key(name: string) {
    const page = this.scroller.box.clientHeight - U.px(3);
    if (name === 'up') this.scroller.by(-U.px(4.5));
    else if (name === 'down') this.scroller.by(U.px(4.5));
    else if (name === 'pgup') this.scroller.by(-page);
    else if (name === 'pgdown') this.scroller.by(page);
  }
  wheel(dy: number) { this.scroller.by(dy > 0 ? U.px(4.5) : -U.px(4.5)); }
  enter() { this.onClose(); }
  back() { this.onClose(); }
}
