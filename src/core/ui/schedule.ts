import { Clock } from '../core/clock';
import { str } from '../core/lang';
import { Bus } from '../data/bus';
import { Channel } from '../data/models';
import { inArchive, isMissed, Reminder, Reminders } from '../data/reminders';
import { Cell, Cells, SLOT } from './cells';
import { DayWindow } from './daywindow';
import { Anim, el, icon, setText, toggle } from './dom';
import { Fmt } from './fmt';
import { Layer } from './layer';
import { Logos } from './logos';
import { DetailsLayer, Scroller } from './popups';
import type { Tv } from './tv';
import { U } from './u';
import { hintRow } from './widgets';

interface Row {
  sep: boolean;
  day: number;
  title: string;
  start: number;
  time?: string;
  sub?: string;
  past?: boolean;
  live?: boolean;
  archive?: boolean;
  playing?: boolean;
  remind?: boolean;
  desc?: string;
  range?: string;
  action?: string;
  progress?: number;
  cell?: Cell;
  reminder?: Reminder;
  el?: HTMLElement;
}

const enum Zone { LIST, DATES, TABS }

/**
 * «Программа и архив» (docs/controls.md): слева — даты (←), в центре — передачи по дням,
 * справа — панель передачи в фокусе; в шапке — кнопки «Программа» / «Напоминания · N» (→).
 * Подсветка: белая заливка — фокус; рамка — куда перейдёт фокус; серым — играющая и её дата.
 */
export class ScheduleLayer implements Layer {
  el: HTMLElement;
  private win: HTMLElement;
  private head: HTMLElement;
  private tabsBox: HTMLElement;
  private tabViews: HTMLElement[] = [];
  private datesBox: HTMLElement;
  private listBox: HTMLElement;
  private panel: HTMLElement;
  private hints: HTMLElement;
  private scroller!: Scroller;
  private datesScroller!: Scroller;
  private rows: Row[] = [];
  private days: { day: number; label: string; el?: HTMLElement }[] = [];
  private index = -1;
  private dateIndex = 0;
  private tab = 0;
  private zone = Zone.LIST;
  private timer = 0;
  private onEpg: () => void;
  private onRem: () => void;
  /** сутки, которые грузятся вокруг фокуса (канал целиком не держим) */
  private dw = new DayWindow();
  /** выбрали дату, сутки которой ещё не пришли — фокус на неё, когда придут */
  private pendingDay: number | null = null;

  constructor(private tv: Tv, private ch: Channel | null, view: number, private onClose: () => void) {
    // сразу в документе: позиции строк нужны для прокрутки к идущей передаче
    this.el = el('div', 'overlay sched', null, tv.ui);
    const win = el('div', 'win', null, this.el);
    this.win = win;
    const W = U.w - 2 * U.px(4), H = U.h - 2 * U.px(2.4);
    win.style.cssText = 'left:' + U.px(4) + 'px;top:' + U.px(2.4) + 'px;width:' + W + 'px;height:' + H + 'px;padding:1.2rem 1.5rem';
    this.head = el('div', 'row head', null, win);
    this.tabsBox = el('div', 'tabs', null, win);
    const body = el('div', 'abs', null, win);
    const bodyTop = U.px(6);
    const bodyH = H - bodyTop - U.px(3.6);
    body.style.cssText = 'left:1.5rem;right:1.5rem;top:' + bodyTop + 'px;height:' + bodyH + 'px';
    this.datesBox = el('div', 'dates', null, body);
    this.listBox = el('div', 'abs', null, body);
    const panelW = (W - U.px(3)) * 0.32;
    this.listBox.style.cssText = 'left:10rem;top:0;bottom:0;right:' + (panelW + U.px(1)) + 'px';
    this.panel = el('div', 'panel', null, body);
    this.panel.style.width = panelW + 'px';
    this.hints = el('div', 'hints abs', null, win);
    this.hints.style.cssText = 'left:1.5rem;bottom:1rem';
    this.datesScroller = new Scroller(this.datesBox, bodyH, 'rgba(30,31,32,.94)');
    this.scroller = new Scroller(this.listBox, bodyH, 'rgba(30,31,32,.94)');
    this.tab = ch ? view : 1;
    if (ch) this.dw.reset(ch, tv.state.channel === ch ? tv.position() : Clock.now());
    const self = this;
    this.onEpg = function () { if (self.tab === 0) self.rebuild(true); };
    this.onRem = function () { self.renderTabs(); if (self.tab === 1) self.rebuild(true); };
    Bus.on('epg', this.onEpg);
    Bus.on('reminders', this.onRem);
    this.timer = window.setInterval(function () { self.rebuild(true); }, 30000);
    this.el.addEventListener('click', function (e) { if (e.target === self.el) self.onClose(); });
    this.renderHead();
    this.renderTabs();
    this.rebuild(false);
    Anim.show(this.el);
  }

  private renderHead() {
    const h = this.head;
    while (h.firstChild) h.removeChild(h.firstChild);
    const ch = this.ch;
    if (this.tab === 0 && ch) {
      const lg = Logos.el(ch, '', false);
      lg.style.cssText = 'width:5.6rem;height:3.6rem;margin-right:1.2rem';
      h.appendChild(lg);
      const t = el('div', 'grow', null, h);
      el('div', 'el', ch.title(), t).style.fontSize = '1.7rem';
      el('div', 'el t60', ch.group + (ch.hasArchive ? ' · ' + str('archive_x_d', ch.archiveDays) : '') + (this.tv.repo.epgLoading() ? ' · …' : ''), t).style.cssText = 'font-size:1.2rem;font-weight:400;margin-top:0.2rem';
    } else {
      const ic = icon('bell');
      ic.style.cssText = 'width:3rem;height:3rem;margin-right:1.2rem';
      h.appendChild(ic);
      const t = el('div', 'grow', null, h);
      el('div', 'el', str('reminders'), t).style.fontSize = '1.7rem';
      el('div', 'el t60', str('programmes_to_remind_about'), t).style.cssText = 'font-size:1.2rem;font-weight:400;margin-top:0.2rem';
    }
  }

  private renderTabs() {
    const b = this.tabsBox;
    while (b.firstChild) b.removeChild(b.firstChild);
    this.tabViews = [];
    if (!this.ch) return;
    const n = Reminders.count();
    const labels = [str('hint_programme'), n > 0 ? str('reminders') + ' · ' + n : str('reminders')];
    const self = this;
    for (let i = 0; i < 2; i++) {
      const t = el('div', 'tab', labels[i], b);
      (function (k) { t.addEventListener('click', function () { self.setTab(k); }); })(i);
      this.tabViews.push(t);
    }
    this.applyTabs();
  }

  private applyTabs() {
    for (let i = 0; i < this.tabViews.length; i++) {
      toggle(this.tabViews[i], 'f', this.zone === Zone.TABS && i === this.tab);
      toggle(this.tabViews[i], 'm', !(this.zone === Zone.TABS) && i === this.tab);
    }
  }

  private setTab(k: number) {
    if (k === this.tab || !this.ch) return;
    this.tab = k;
    this.index = -1;
    this.renderHead();
    this.rebuild(false);
    this.applyTabs();
  }

  // ------------------------------------------------------------ содержимое

  private buildArchive(): { rows: Row[]; focus: number } {
    const ch = this.ch!;
    const tm = Clock.now();
    const days = ch.archiveDays;
    // архив — ровно последние days × 24 ч (DayWindow.from)
    const archFrom = this.dw.from;
    const from = this.dw.lo, to = this.dw.hi;
    const st = this.tv.state;
    const playingPos = st.channel === ch ? this.tv.position() : -1;
    // передачи окна (у начала архива — и та, что шла в этот момент); в архиве без программы —
    // «Нет программы» по 30 минут (или до первой передачи)
    const programs = this.dw.programmes(this.tv.repo);
    const start = programs.length && programs[0].start < from ? programs[0].start : from;
    const list = Cells.cells(programs, start, to).filter(function (c) {
      return c.program !== null || (ch.hasArchive && days > 0 && c.end > archFrom && c.start < tm);
    });
    const rows: Row[] = [];
    let day = -1e9;
    let focus = -1;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const d = Fmt.dayIndex(c.start);
      if (d !== day) { day = d; rows.push({ sep: true, day: d, title: Fmt.dayLabel(c.start), start: c.start }); }
      const live = c.start <= tm && tm < c.end;
      const playing = playingPos >= c.start && playingPos < c.end;
      // передача, начавшаяся до начала архива, но идущая в нём, — тоже из архива
      const arch = ch.hasArchive && c.end > archFrom && c.start < tm;
      if (playing || (live && focus < 0)) focus = rows.length;
      rows.push({
        sep: false, day: d, title: c.program ? c.program.title : str('no_programme'), start: c.start, time: Fmt.hhmm(c.start), past: c.end <= tm, live: live, archive: arch, playing: playing,
        remind: c.start > tm && Reminders.has(ch, c.start), desc: c.program ? c.program.desc : '', range: Fmt.dayTimeRange(c.start, c.end),
        action: str(live ? 'watch_live' : c.end <= tm && arch ? 'watch_from_archive' : 'about'),
        progress: live ? Fmt.progress(c.start, c.end, tm) : undefined, cell: c,
      });
    }
    return { rows: rows, focus: focus };
  }

  private buildReminders(): { rows: Row[]; focus: number } {
    const multi = this.tv.repo.playlists().length > 1;
    const rows: Row[] = [];
    let day = -1e9;
    const all = Reminders.all();
    const now = Clock.now();
    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      const d = Fmt.dayIndex(r.start);
      if (d !== day) { day = d; rows.push({ sep: true, day: d, title: Fmt.dayLabel(r.start), start: r.start }); }
      const left = r.start - now;
      const when = isMissed(r, now) ? str('missed_watch_from_archive') : left > 0 ? str('starts_in') + Fmt.until(left) : str('on_air');
      rows.push({
        sep: false, day: d, title: r.title, start: r.start, time: Fmt.hhmm(r.start),
        sub: r.chName + (multi && r.playlistName ? ' · ' + r.playlistName : '') + ' · ' + when,
        past: isMissed(r, now), archive: isMissed(r, now), desc: r.desc, range: Fmt.dayTimeRange(r.start, r.stop), reminder: r, action: str('about'),
      });
    }
    return { rows: rows, focus: -1 };
  }

  /** Пересобрать список; keep — фокус на той же передаче */
  private rebuild(keep: boolean) {
    const keepStart = keep && this.rows[this.index] ? this.rows[this.index].start : null;
    const b = this.tab === 0 && this.ch ? this.buildArchive() : this.buildReminders();
    this.rows = b.rows;
    const inner = this.scroller.inner;
    while (inner.firstChild) inner.removeChild(inner.firstChild);
    const self = this;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.sep) { r.el = el('div', 'dh', r.title, inner); continue; }
      const e = el('div', 'pr' + (r.past ? ' past' : '') + (r.playing ? ' playing' : ''), null, inner);
      if (r.sub) e.style.height = '5rem';
      el('div', 'tm', r.time || '', e);
      const mid = el('div', 'grow', null, e);
      el('div', 'el', r.title, mid).style.fontWeight = r.live ? '700' : '400';
      if (r.sub) el('div', 'el t60', r.sub, mid).style.fontSize = '1.15rem';
      if (r.progress !== undefined) el('i', '', null, el('div', 'pbar', null, mid)).style.width = Math.round(r.progress * 100) + '%';
      if (r.live) el('span', 'live', 'LIVE', e);
      if (r.playing) e.appendChild(icon('play'));
      if (r.archive && !r.live) e.appendChild(icon('archive'));
      if (r.remind) e.appendChild(icon('bell'));
      r.el = e;
      (function (k) {
        e.addEventListener('click', function () { if (self.index === k) self.enter(); else { self.zone = Zone.LIST; self.index = k; self.focus(); } });
      })(i);
    }
    if (!this.rows.length) {
      const e = el('div', 'empty', this.tab === 0 ? (this.tv.repo.epgLoading() ? str('programme_is_loading') : str('no_programme')) : str('no_reminders_add_them_in_the_card_of'), inner);
      e.style.whiteSpace = 'pre-line';
    }
    // даты: все сутки с программой (оглавление сервиса), а не только загруженные
    this.days = [];
    const all = this.tab === 0 && this.ch ? this.dw.days(this.tv.repo) : null;
    if (all) {
      for (let i = 0; i < all.length; i++) this.days.push({ day: Fmt.dayIndex(all[i]), label: Fmt.dayTab(all[i]) });
      // архив без программы: загруженные сутки, которых нет в оглавлении
      for (let i = 0; i < this.rows.length; i++) {
        const r = this.rows[i];
        if (r.sep && !this.days.some(function (d) { return d.day === r.day; })) this.days.push({ day: r.day, label: Fmt.dayTab(r.start) });
      }
      this.days.sort(function (a, b) { return a.day - b.day; });
    } else for (let i = 0; i < this.rows.length; i++) if (this.rows[i].sep) this.days.push({ day: this.rows[i].day, label: Fmt.dayTab(this.rows[i].start) });
    const dinner = this.datesScroller.inner;
    while (dinner.firstChild) dinner.removeChild(dinner.firstChild);
    for (let i = 0; i < this.days.length; i++) {
      const d = el('div', 'date', this.days[i].label, dinner);
      this.days[i].el = d;
      (function (k) { d.addEventListener('click', function () { self.dateIndex = k; self.zone = Zone.LIST; self.goDay(k); }); })(i);
    }
    // фокус
    let idx = -1;
    if (keepStart !== null) {
      for (let i = 0; i < this.rows.length; i++) if (!this.rows[i].sep && this.rows[i].start <= keepStart) idx = i;
    }
    if (this.pendingDay !== null) {
      const t = this.dayTarget(this.pendingDay);
      if (t >= 0) { idx = t; this.pendingDay = null; }
    }
    if (idx < 0) idx = b.focus;
    if (idx < 0) for (let i = 0; i < this.rows.length; i++) if (!this.rows[i].sep) { idx = i; break; }
    this.index = idx;
    this.focus(true);
    this.renderHead();
  }

  /** К дате k: её сутки не загружены — окно вокруг неё, фокус — когда придут */
  private goDay(k: number) {
    const day = this.days[k].day;
    const t = this.dayTarget(day);
    if (t >= 0) { this.index = t; this.focus(); return; }
    const start = day * 86400 + new Date(day * 86400 * 1000).getTimezoneOffset() * 60;
    this.dw.center(Fmt.dayStart(start + 12 * 3600));
    this.pendingDay = day;
    this.rebuild(false);
  }

  private dayTarget(day: number): number {
    let first = -1;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.sep || r.day !== day) continue;
      if (r.live || r.playing) return i;
      if (first < 0) first = i;
    }
    return first;
  }

  private focus(jump?: boolean) {
    const r = this.rows[this.index];
    for (let i = 0; i < this.rows.length; i++) {
      const e = this.rows[i].el;
      if (!e || this.rows[i].sep) continue;
      toggle(e, 'f', i === this.index && this.zone === Zone.LIST);
      toggle(e, 'm', i === this.index && this.zone !== Zone.LIST);
    }
    // даты: фокус — белая; рамка — дата передачи в фокусе; серым — дата играющей
    const curDay = r ? r.day : null;
    let playingDay: number | null = null;
    for (let i = 0; i < this.rows.length; i++) if (this.rows[i].playing) playingDay = this.rows[i].day;
    for (let i = 0; i < this.days.length; i++) {
      const d = this.days[i];
      toggle(d.el!, 'f', this.zone === Zone.DATES && i === this.dateIndex);
      toggle(d.el!, 'r', this.zone !== Zone.DATES && d.day === curDay);
      toggle(d.el!, 'm', d.day === playingDay && !(this.zone === Zone.DATES && i === this.dateIndex));
    }
    if (r && r.el) {
      // заголовок дня держим на экране вместе с первой передачей дня
      let top = r.el.offsetTop;
      const prev = this.rows[this.index - 1];
      if (prev && prev.sep && prev.el) top = prev.el.offsetTop;
      const h = this.scroller.box.clientHeight;
      if (jump) this.scroller.scrollTo(Math.max(0, Math.min(r.el.offsetTop - h / 2 + r.el.offsetHeight / 2, this.scroller.inner.offsetHeight - h)));
      else this.scroller.reveal(top, r.el.offsetTop + r.el.offsetHeight, U.px(4));
    }
    const di = this.zone === Zone.DATES ? this.dateIndex : this.days.findIndex(function (d) { return d.day === curDay; });
    const de = this.days[di] && this.days[di].el;
    if (de) this.datesScroller.reveal(de.offsetTop, de.offsetTop + de.offsetHeight, U.px(2));
    this.renderPanel();
    this.applyTabs();
    this.renderHints();
  }

  private renderPanel() {
    const p = this.panel;
    while (p.firstChild) p.removeChild(p.firstChild);
    const r = this.rows[this.index];
    if (!r || r.sep) return;
    el('div', 'tm', r.range || '', p);
    el('div', 'nm', r.title, p);
    el('div', 'ds', r.desc || '', p);
    const ok = el('div', 'ok row', null, p);
    hintRow(ok, [['OK', r.action || '']]);
  }

  private renderHints() {
    const z = this.zone;
    const h: [string, string][] = z === Zone.DATES ? [['↑ ↓', str('hint_date')], ['→', str('hint_programmes')], [str('key_back'), str('hint_programmes')]]
      : z === Zone.TABS ? [['← →', str('hint_view')], ['↓', str('hint_programmes')]]
        : [['OK', (this.rows[this.index] && this.rows[this.index].action) || str('about')], ['←', str('hint_dates')], ['→', str('hint_view')], [str('key_hold_ok'), str('programme_card')]];
    hintRow(this.hints, h);
  }

  // ------------------------------------------------------------ клавиши

  private moveRow(d: number) {
    let i = this.index;
    for (;;) {
      i += d;
      if (i < 0 || i >= this.rows.length) return;
      if (!this.rows[i].sep) break;
    }
    this.index = i;
    // у края загруженного — догрузить ещё двое суток (фокус останется на этой передаче)
    if (this.tab === 0 && this.ch && this.dw.near(this.rows[i].start)) { this.rebuild(true); return; }
    this.focus();
  }

  key(name: string) {
    if (this.zone === Zone.DATES) {
      if (name === 'up' || name === 'down') {
        const k = Math.max(0, Math.min(this.days.length - 1, this.dateIndex + (name === 'up' ? -1 : 1)));
        this.dateIndex = k;
        const t = this.dayTarget(this.days[k].day);
        if (t >= 0) this.index = t;
        else if (this.tab === 0 && this.ch) { this.goDay(k); return; }
        // список прокручивается к заголовку дня
        const r = this.rows[this.index];
        const prev = this.rows[this.index - 1];
        if (r && r.el) this.scroller.reveal(prev && prev.sep && prev.el ? prev.el.offsetTop : r.el.offsetTop, r.el.offsetTop + r.el.offsetHeight);
        this.focus();
      } else if (name === 'right') { this.zone = Zone.LIST; this.focus(); }
      return;
    }
    if (this.zone === Zone.TABS) {
      if (name === 'left') { if (this.tab === 0) { this.zone = Zone.LIST; this.focus(); } else this.setTab(this.tab - 1); }
      else if (name === 'right') this.setTab(Math.min(1, this.tab + 1));
      else if (name === 'down') { this.zone = Zone.LIST; this.focus(); }
      return;
    }
    if (name === 'up') this.moveRow(-1);
    else if (name === 'down') this.moveRow(1);
    else if (name === 'pgup') for (let k = 0; k < 8; k++) this.moveRow(-1);
    else if (name === 'pgdown') for (let k = 0; k < 8; k++) this.moveRow(1);
    else if (name === 'left' && this.days.length) {
      const r = this.rows[this.index];
      this.dateIndex = Math.max(0, this.days.findIndex(function (d) { return !!r && d.day === r.day; }));
      this.zone = Zone.DATES;
      this.focus();
    } else if (name === 'right' && this.ch) { this.zone = Zone.TABS; this.focus(); }
  }

  wheel(dy: number) { if (this.zone === Zone.LIST) this.moveRow(dy > 0 ? 1 : -1); }

  enter() {
    if (this.zone === Zone.DATES || this.zone === Zone.TABS) { this.zone = Zone.LIST; this.focus(); return; }
    const r = this.rows[this.index];
    if (!r || r.sep) return;
    if (r.reminder) { this.reminderDetails(r.reminder); return; }
    const ch = this.ch!;
    const c = r.cell!;
    if (r.live) { this.onClose(); this.tv.playChannel(ch, this.tv.state.channel === ch ? this.tv.state.groupKey : null); }
    else if (r.past && r.archive) { this.onClose(); this.tv.playArchive(ch, c.start, c.end); }
    else this.tv.openDetails(ch, c);
  }

  long() {
    const r = this.rows[this.index];
    if (!r || r.sep) return;
    if (r.reminder) { this.reminderDetails(r.reminder); return; }
    if (this.ch && r.cell) this.tv.openDetails(this.ch, r.cell);
  }

  private reminderDetails(r: Reminder) {
    const now = Clock.now();
    const buttons: [string, string][] = [];
    if (isMissed(r, now)) { if (inArchive(r, now)) buttons.push([str('watch_from_archive'), 'watch']); }
    else if (r.start <= now) buttons.push([str('watch'), 'watch']);
    buttons.push([str('delete_reminder'), 'remove']);
    const tv = this.tv;
    const ch = Channel.stub(r.chName, r.chNum, r.logo);
    let layer: DetailsLayer | null = null;
    const self = this;
    layer = new DetailsLayer(tv.ui, ch, Fmt.dayTimeRange(r.start, r.stop) + (r.playlistName ? ' · ' + r.playlistName : ''), r.title, r.desc,
      buttons.map(function (b) { return b[0]; }), function (i) {
        tv.remove(layer!);
        Reminders.remove(r.id);
        if (buttons[i][1] === 'watch') { self.onClose(); tv.launch(r); }
      }, function () { tv.remove(layer!); });
    tv.push(layer);
  }

  back() {
    if (this.zone !== Zone.LIST) { this.zone = Zone.LIST; this.focus(); return; }
    this.onClose();
  }

  media(name: string) { if (name === 'red' || name === 'menu') this.long(); }

  destroy() {
    clearInterval(this.timer);
    this.dw.release(this.tv.repo);
    Bus.off('epg', this.onEpg);
    Bus.off('reminders', this.onRem);
  }

  relabel() { setText(this.head, ''); this.renderHead(); this.renderTabs(); this.rebuild(true); }
}
