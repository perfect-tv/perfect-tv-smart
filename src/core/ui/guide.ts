import { Clock } from '../clock';
import { str } from '../lang';
import { NUMBER_NEAR_NAME, Prefs } from '../prefs';
import { Group } from '../data/catalog';
import { Channel, Playlist, Programme } from '../data/models';
import { Reminders } from '../data/reminders';
import { DayWindow } from './daywindow';
import { DomCtx } from './domctx';
import { Cell, Cells, SLOT } from './cells';
import { Anim, drawIcon, el } from './dom';
import { Fmt } from './fmt';
import { Layer } from './layer';
import { Logos } from './logos';
import type { Tv } from './tv';
import { C, drawText, lite, RADIUS_S, roundRect, strokeRoundRect, U } from './u';

/** Окно сетки — 2 часа, шаг 30 минут, линия «сейчас» на 25% */
const SPAN = 2 * 3600;

const enum Zone { PLAYLISTS, CATS, CHANNELS, GRID, PROGRAMS, DATES }

/**
 * ТВ-гид (docs/controls.md, «ТВ-гид»): список каналов и сетка программы («ТВ-гид»), программа
 * канала и даты («Каналы + программа»), виды «Категории + каналы» и «Каналы» (видео справа открыто,
 * программа выезжает по →). ← из каналов — колонка категорий (выезжает слева, сдвигает гид вправо),
 * ← там — плейлисты. Всё рисуется на одном Canvas; перерисовка — по requestAnimationFrame.
 */
export class GuideLayer implements Layer {
  el: HTMLElement;
  /** поверхность: <canvas> или (HTML-отрисовка) <div class="gdom"> */
  private canvas: HTMLElement;
  private c!: CanvasRenderingContext2D;
  /** HTML-отрисовка: контекст с командами Canvas поверх DOM (ui/domctx.ts) */
  private dom: DomCtx | null = null;
  private render = -1;
  private groups: Group[] = [];
  private groupIndex = 0;
  private index = 0;
  private zone = Zone.CHANNELS;
  private mode = Prefs.guideMode;
  private winStart = 0;
  private focusTime = 0;
  private live = true;
  private catsFromGroup = 0;
  private catsFromChannel: Channel | null = null;
  private catSearch = false;
  private pls: Playlist[] = [];
  private plsIndex = 0;
  // вид «Каналы + программа»
  private plCh: Channel | null = null;
  private plLast: Channel | null = null;
  private plRows: Programme[] = [];
  private plIndex = 0;
  private plKeep = -1;
  private plRev = -1;
  /** сутки списка передач: грузятся вокруг фокуса, а не все сразу */
  private dw = new DayWindow();
  /** выбрали дату, сутки которой ещё не пришли */
  private plPending: number | null = null;
  private plJump = true;
  private plDays: number[] = [];
  private plDayLabels: [string, string][] = [];
  private dateIndex = 0;
  private plScroll = 0;
  // анимации: колонка категорий, плейлисты, программа (виды 2 и 3), панель описания
  private shift = 0;
  private shift2 = 0;
  private rv = 1;
  private rail = 0;
  private dirty = false;
  private raf = 0;
  private tickTimer = 0;
  private w = 0;
  private h = 0;

  constructor(private tv: Tv) {
    this.el = el('div', 'guide');
    this.canvas = this.el;
    this.surface();
  }

  /** Поверхность по настройке «Отрисовка гида»: HTML (DOM) или Canvas */
  private surface() {
    const mode = Prefs.guideRender;
    if (mode === this.render) return;
    this.render = mode;
    if (this.canvas !== this.el) this.el.removeChild(this.canvas);
    const self = this;
    if (mode === 0) {
      const d = el('div', 'gdom', null, this.el);
      this.dom = new DomCtx(d);
      this.c = this.dom as unknown as CanvasRenderingContext2D;
      this.canvas = d;
    } else {
      const cv = document.createElement('canvas');
      this.el.appendChild(cv);
      this.dom = null;
      this.c = cv.getContext('2d')!;
      this.canvas = cv;
      this.w = 0;   // размер холста — заново
    }
    this.canvas.addEventListener('click', function (e) { self.tap(e.clientX, e.clientY); });
    this.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); const ch = self.focused(); if (ch) self.tv.openMenu(ch, true); });
  }

  // ------------------------------------------------------------ состояние

  private get grid() { return this.mode === 0; }
  private get catsFixed() { return this.mode === 2; }
  private get progHidden() { return this.mode >= 2; }
  private get descOn() { return Prefs.guideDesc && !this.grid; }
  private group(): Group | null { return this.groups[this.groupIndex] || null; }
  private channels(): Channel[] { const g = this.group(); return g ? g.channels : []; }
  private focused(): Channel | null { return this.channels()[this.index] || null; }
  focusedChannel() { return this.focused(); }
  groupKey(): string | null { const g = this.group(); return g ? g.key : null; }

  private liveStart() { return Clock.now() - SLOT; }

  open(ch: Channel | null, groupKey: string | null, toGrid = false) {
    const cat = this.tv.catalog;
    this.surface();
    this.size();
    if (!cat) { this.groups = []; this.redraw(); return; }
    this.groups = cat.groups();
    const g = ch ? cat.groupOf(ch, groupKey) : (cat.group(groupKey) || this.groups[0] || null);
    this.groupIndex = Math.max(0, this.groups.findIndex(function (x) { return !!g && x.key === g.key; }));
    this.index = ch ? Math.max(0, this.channels().indexOf(ch)) : 0;
    this.zone = Zone.CHANNELS;
    this.live = true;
    this.winStart = this.liveStart();
    this.mode = Prefs.guideMode;
    this.plCh = null; this.plLast = null; this.plKeep = -1;
    this.resetShift();
    if (toGrid && this.grid) this.toGrid();
    clearInterval(this.tickTimer);
    const self = this;
    this.tickTimer = window.setInterval(function () { self.redraw(); }, 10000);
    this.redraw();
  }

  /** Список категорий изменился (скрытие, избранное, новый каталог) — фокус на том же канале */
  reload() {
    if (!this.tv.hasLayer(this)) return;
    const f = this.focused();
    const cat = this.tv.catalog;
    this.open(f && cat ? cat.byKey[f.key] || null : null, this.groupKey());
  }

  /** Скрыть канал или категорию и встать рядом (предыдущий, нет — следующий) */
  reloadAfterHide(gone: (c: Channel) => boolean, groupGone: string | null, hide: () => void) {
    const list = this.channels();
    let gk = this.groupKey();
    let ch = this.focused();
    const near = (): string | null => { const g = this.groups[this.groupIndex - 1] || this.groups[this.groupIndex + 1]; return g ? g.key : null; };
    if (gk !== null && gk === groupGone) { gk = near(); ch = null; }
    else if (ch && gone(ch)) {
      let n: Channel | null = null;
      for (let i = this.index - 1; i >= 0; i--) if (!gone(list[i])) { n = list[i]; break; }
      if (!n) for (let i = this.index + 1; i < list.length; i++) if (!gone(list[i])) { n = list[i]; break; }
      ch = n;
      if (!ch) gk = near();
    }
    hide();
    if (this.tv.hasLayer(this)) this.open(ch, gk);
  }

  setView(m: number) {
    this.mode = m;
    if (this.zone === Zone.GRID || this.zone === Zone.PROGRAMS || this.zone === Zone.DATES) this.zone = Zone.CHANNELS;
    this.resetShift();
    this.plCh = null;
    this.live = true;
    this.winStart = this.liveStart();
    this.redraw();
  }

  focusNumber(num: number) {
    const i = this.channels().findIndex(function (c) { return c.num === num; });
    if (i >= 0) { this.index = i; this.redraw(); return; }
    for (let gi = 0; gi < this.groups.length; gi++) {
      const j = this.groups[gi].channels.findIndex(function (c) { return c.num === num; });
      if (j >= 0) { this.groupIndex = gi; this.index = j; this.redraw(); return; }
    }
  }

  private resetShift() {
    this.shift = this.catsFixed ? 1 : 0;
    this.shift2 = 0;
    this.rail = 0;
    this.rv = this.progHidden ? 0 : 1;
  }

  // ------------------------------------------------------------ вид «Каналы + программа»

  /**
   * Ячейки строки сетки — из кэша по каналу, окну и номеру изменения программы канала: при
   * листании те же строки рисуются кадр за кадром, а массив передач и ячейки создавались заново
   * (сборщик мусора — заметная доля JS гида на ТВ).
   */
  private cellCache: { [k: string]: Cell[] } = {};
  private cellCount = 0;
  private rowCells(ch: Channel, from: number, to: number): Cell[] {
    const repo = this.tv.repo;
    const k = ch.playlistId + ':' + ch.key + '|' + from + '|' + to + '|' + repo.revOf(ch);
    let v = this.cellCache[k];
    if (!v) {
      v = Cells.cells(repo.range(ch, from, to), from, to);
      if (++this.cellCount > 300) { this.cellCache = {}; this.cellCount = 0; }
      this.cellCache[k] = v;
    }
    return v;
  }

  /** День передачи i списка; -1 — передач нет (даты из оглавления уже есть, сутки ещё грузятся) */
  private dayOf(i: number) { const p = this.plRows[i]; return p ? Fmt.dayIndex(p.start) : -1; }

  private liveIndex(): number {
    const now = Clock.now();
    let next = -1;
    for (let i = 0; i < this.plRows.length; i++) {
      const p = this.plRows[i];
      if (p.start <= now && now < p.stop) return i;
      if (next < 0 && p.start > now) next = i;
    }
    return next >= 0 ? next : Math.max(0, this.plRows.length - 1);
  }

  private ensureRows() {
    const ch = this.focused();
    if (!ch) { this.plCh = null; this.plLast = null; this.plRows = []; this.plDays = []; this.plDayLabels = []; return; }
    // список перестраивается, когда пришли сутки этого канала (они приходят кусками)
    const repo = this.tv.repo;
    const rev = repo.revOf(ch);
    if (ch === this.plCh && rev === this.plRev) return;
    const same = ch === this.plCh && this.plRows.length > 0;
    const keep = same ? this.plRows[Math.min(this.plIndex, this.plRows.length - 1)].start : ch === this.plLast ? this.plKeep : -1;
    this.plKeep = -1;
    // другой канал: окно суток — заново, догруженное у прежнего — из памяти
    if (this.dw.ch !== ch) {
      this.dw.release(repo);
      this.dw.reset(ch, keep >= 0 ? keep : Clock.now());
      this.plPending = null;
    }
    this.plRev = repo.revOf(ch);
    this.plRows = this.dw.programmes(repo);
    this.plCh = ch;
    this.plLast = ch;
    const days: number[] = [];
    const labels: [string, string][] = [];
    const addDay = function (start: number) {
      days.push(Fmt.dayIndex(start));
      const t = Fmt.dayTabShort(start).split('\n');
      labels.push([t[0], t[1] || '']);
    };
    // даты — все сутки с программой (оглавление сервиса), а не только загруженные
    const all = this.dw.days(repo);
    if (all) for (let i = 0; i < all.length; i++) addDay(all[i]);
    else for (let i = 0; i < this.plRows.length; i++) if (days.indexOf(this.dayOf(i)) < 0) addDay(this.plRows[i].start);
    this.plDays = days;
    this.plDayLabels = labels;
    if (this.plPending !== null && this.dayTarget(this.plPending) >= 0) {
      this.plIndex = this.dayTarget(this.plPending);
      this.plPending = null;
    } else if (keep >= 0) {
      let k = 0;
      for (let i = 0; i < this.plRows.length; i++) if (this.plRows[i].start <= keep) k = i;
      this.plIndex = k;
    } else { this.plIndex = this.liveIndex(); this.plJump = true; }
    const di = this.plPending !== null ? this.plPending : this.plRows.length ? this.dayOf(Math.min(this.plIndex, this.plRows.length - 1)) : -1;
    this.dateIndex = Math.max(0, days.indexOf(di));
  }

  /** К дате k: её сутки не загружены — окно вокруг неё, фокус — когда придут */
  private goDay(k: number) {
    const day = this.plDays[k];
    const t = this.dayTarget(day);
    if (t >= 0) { this.plIndex = t; return; }
    const approx = day * 86400 + new Date(day * 86400 * 1000).getTimezoneOffset() * 60;
    this.dw.center(Fmt.dayStart(approx + 12 * 3600));
    this.plPending = day;
    this.plRev = -1;
  }

  /** Фокус ушёл к краю загруженных суток — догрузить ещё двое */
  private nearEdge() {
    const p = this.plRows[this.plIndex];
    if (p && this.dw.near(p.start)) this.plRev = -1;
  }

  private toPrograms() {
    this.ensureRows();
    if (!this.plRows.length) return;
    this.plIndex = this.liveIndex();
    this.zone = Zone.PROGRAMS;
    this.redraw();
  }

  private programKey(name: string) {
    const n = this.plRows.length;
    if (!n) { this.zone = Zone.CHANNELS; this.redraw(); return; }
    if (name === 'up') this.plIndex = Math.max(0, this.plIndex - 1);
    else if (name === 'down') this.plIndex = Math.min(n - 1, this.plIndex + 1);
    else if (name === 'pgup') this.plIndex = Math.max(0, this.plIndex - 8);
    else if (name === 'pgdown') this.plIndex = Math.min(n - 1, this.plIndex + 8);
    else if (name === 'left') this.zone = Zone.CHANNELS;
    if (name === 'up' || name === 'down' || name === 'pgup' || name === 'pgdown') this.nearEdge();
    else if (name === 'right') { this.dateIndex = Math.max(0, this.plDays.indexOf(this.dayOf(this.plIndex))); this.zone = Zone.DATES; }
    this.redraw();
  }

  private datesKey(name: string) {
    if (name === 'up') this.moveDate(-1);
    else if (name === 'down') this.moveDate(1);
    else if (name === 'left') this.zone = Zone.PROGRAMS;
    this.redraw();
  }

  private moveDate(d: number) {
    const k = Math.max(0, Math.min(this.plDays.length - 1, this.dateIndex + d));
    if (k === this.dateIndex) return;
    this.dateIndex = k;
    this.goDay(k);
  }

  private dayTarget(day: number): number {
    const now = Clock.now();
    let first = -1;
    for (let i = 0; i < this.plRows.length; i++) {
      if (this.dayOf(i) !== day) continue;
      const p = this.plRows[i];
      if (p.start <= now && now < p.stop) return i;
      if (first < 0) first = i;
    }
    return first;
  }

  private programAction(p: Programme) {
    const ch = this.focused();
    if (!ch) return;
    const now = Clock.now();
    if (p.start <= now && now < p.stop) this.tv.playChannel(ch, this.groupKey());
    else if (p.stop <= now && ch.hasArchive && p.start >= now - ch.archiveDays * 86400 - SLOT) this.tv.playArchive(ch, p.start, p.stop);
    else this.tv.openDetails(ch, new Cell(p.start, p.stop, p));
  }

  // ------------------------------------------------------------ клавиши

  hasLong(name: string) { return this.zone === Zone.CHANNELS && name === 'left' && this.grid; }

  key(name: string, long: boolean, digit: number) {
    if (name === 'digit') { this.tv.digit(digit); return; }
    switch (this.zone) {
      case Zone.GRID: this.gridKey(name); return;
      case Zone.PLAYLISTS: this.playlistsKey(name); return;
      case Zone.CATS: this.catsKey(name); return;
      case Zone.PROGRAMS: this.programKey(name); return;
      case Zone.DATES: this.datesKey(name); return;
    }
    if (name === 'up') this.move(-1);
    else if (name === 'down') this.move(1);
    else if (name === 'pgup') this.move(-this.pageSize());
    else if (name === 'pgdown') this.move(this.pageSize());
    else if (name === 'left') {
      const f = this.focused();
      if (long) { if (f) this.tv.openSchedule(f, 0); }
      else this.openCats();
    } else if (name === 'right') { if (this.grid) this.toGrid(); else this.toPrograms(); }
  }

  private openPlaylists() {
    this.pls = this.tv.repo.playlists();
    if (this.pls.length < 2) return;
    const cur = this.tv.playlist;
    this.plsIndex = Math.max(0, this.pls.findIndex(function (p) { return !!cur && p.id === cur.id; }));
    this.zone = Zone.PLAYLISTS;
    this.redraw();
  }

  private playlistsKey(name: string) {
    const n = this.pls.length;
    if (name === 'up') this.plsIndex = (this.plsIndex - 1 + n) % n;
    else if (name === 'down') this.plsIndex = (this.plsIndex + 1) % n;
    else if (name === 'right') this.zone = Zone.CATS;
    this.redraw();
  }

  private choosePlaylist() {
    const p = this.pls[this.plsIndex];
    if (!p) return;
    if (this.tv.playlist && p.id === this.tv.playlist.id) { this.zone = Zone.CATS; this.redraw(); }
    else this.tv.switchPlaylist(p);
  }

  private openCats() {
    if (this.groups.length < 2) return;
    this.catsFromGroup = this.groupIndex;
    this.catsFromChannel = this.focused();
    this.catSearch = false;
    this.zone = Zone.CATS;
    this.redraw();
  }

  private catsKey(name: string) {
    const n = this.groups.length;
    if (this.catSearch) {
      if (name === 'up') { this.catSearch = false; this.setGroup(n - 1); }
      else if (name === 'down') { this.catSearch = false; this.setGroup(0); }
      else if (name === 'left') this.openPlaylists();
      else if (name === 'right') this.closeCats();
      this.redraw();
      return;
    }
    if (name === 'up') { if (this.groupIndex === 0) { this.catSearch = true; this.redraw(); } else this.setGroup(this.groupIndex - 1); }
    else if (name === 'down') this.setGroup((this.groupIndex + 1) % n);
    else if (name === 'pgup') this.setGroup(Math.max(0, this.groupIndex - this.catRows() + 1));
    else if (name === 'pgdown') this.setGroup(Math.min(n - 1, this.groupIndex + this.catRows() - 1));
    else if (name === 'left') this.openPlaylists();
    else if (name === 'right') this.closeCats();
  }

  private setGroup(i: number) {
    if (i === this.groupIndex || i < 0 || i >= this.groups.length) return;
    this.groupIndex = i;
    const k = this.catsFromChannel ? this.channels().indexOf(this.catsFromChannel) : -1;
    this.index = k >= 0 ? k : 0;
    this.redraw();
  }

  private closeCats() {
    this.catSearch = false;
    this.zone = Zone.CHANNELS;
    this.redraw();
  }

  private move(d: number) {
    const n = this.channels().length;
    if (!n) return;
    this.index = Math.abs(d) === 1 ? (this.index + d + n) % n : Math.max(0, Math.min(n - 1, this.index + d));
    this.redraw();
  }

  private pageSize() { return Math.max(1, this.visibleRows() - 1); }

  private toGrid() {
    this.zone = Zone.GRID;
    this.live = false;
    this.focusTime = Clock.now();
    this.redraw();
  }

  private gridKey(name: string) {
    const ch = this.focused();
    if (!ch) return;
    const repo = this.tv.repo;
    const cell = Cells.at(repo.around(ch, this.focusTime), this.focusTime);
    if (name === 'left') {
      this.focusTime = Math.max(Cells.at(repo.around(ch, cell.start - 1), cell.start - 1).start, Clock.now() - 14 * 86400);
      if (this.focusTime < this.winStart) this.winStart = Math.floor(this.focusTime / SLOT) * SLOT;
    } else if (name === 'right') {
      this.focusTime = cell.end;
      if (this.focusTime >= this.winStart + SPAN - SLOT / 2) this.winStart = Math.floor(this.focusTime / SLOT) * SLOT - SLOT;
    } else if (name === 'up') this.move(-1);
    else if (name === 'down') this.move(1);
    else if (name === 'pgup') this.move(-this.pageSize());
    else if (name === 'pgdown') this.move(this.pageSize());
    this.redraw();
  }

  enter() {
    if (this.tv.numberPending()) { this.tv.applyNumber(); return; }
    if (this.zone === Zone.PLAYLISTS) { this.choosePlaylist(); return; }
    if (this.zone === Zone.CATS && this.catSearch) { this.tv.openSearch(); return; }
    if (this.zone === Zone.CATS) { this.closeCats(); return; }
    const ch = this.focused();
    if (!ch) return;
    if (this.zone === Zone.GRID) { this.tv.openDetails(ch, Cells.at(this.tv.repo.around(ch, this.focusTime), this.focusTime)); return; }
    if (this.zone === Zone.PROGRAMS) { const p = this.plRows[this.plIndex]; if (p) this.programAction(p); return; }
    if (this.zone === Zone.DATES) { this.zone = Zone.PROGRAMS; this.redraw(); return; }
    this.tv.playChannel(ch, this.groupKey());
  }

  long() {
    const ch = this.focused();
    // каналов нет (загружаются или ошибка) — настройки: адрес плейлиста, журнал
    if (!ch) { this.tv.openSettings(); return; }
    if (this.zone === Zone.PROGRAMS) {
      const p = this.plRows[this.plIndex];
      if (p) this.tv.openDetails(ch, new Cell(p.start, p.stop, p));
      return;
    }
    this.tv.openMenu(ch, true);
  }

  back() {
    if (this.tv.numberPending()) { this.tv.cancelNumber(); return; }
    if (this.zone === Zone.PLAYLISTS) { this.zone = Zone.CATS; this.redraw(); return; }
    if (this.zone === Zone.CATS) {
      this.groupIndex = Math.max(0, Math.min(this.groups.length - 1, this.catsFromGroup));
      const k = this.catsFromChannel ? this.channels().indexOf(this.catsFromChannel) : -1;
      this.index = k >= 0 ? k : 0;
      this.closeCats();
      return;
    }
    if (this.zone === Zone.GRID) { this.zone = Zone.CHANNELS; this.live = true; this.winStart = this.liveStart(); this.redraw(); return; }
    if (this.zone === Zone.PROGRAMS || this.zone === Zone.DATES) { this.zone = Zone.CHANNELS; this.redraw(); return; }
    this.tv.closeGuide();
  }

  media(name: string) {
    if (name === 'guide') this.tv.closeGuide();
    else if (name === 'menu' || name === 'red') this.long();
    else if (name === 'search' || name === 'blue') this.tv.openSearch();
    else if (name === 'green') this.tv.openHistory();
    else if (name === 'yellow') this.tv.openReminders(this.focused());
  }

  /** Колесо Magic Remote: каналы (в сетке — время по горизонтали колеса) */
  wheel(dy: number, dx: number) {
    if (Math.abs(dx) > Math.abs(dy) && this.grid) {
      this.live = false;
      if (this.zone !== Zone.GRID) { this.zone = Zone.GRID; this.focusTime = Clock.now(); }
      this.gridKey(dx > 0 ? 'right' : 'left');
      return;
    }
    const k = dy > 0 ? 'down' : 'up';
    if (this.zone === Zone.PROGRAMS) this.programKey(k);
    else if (this.zone === Zone.CATS) this.catsKey(k);
    else if (this.zone === Zone.PLAYLISTS) this.playlistsKey(k);
    else if (this.zone === Zone.DATES) this.datesKey(k);
    else this.move(dy > 0 ? 1 : -1);
  }

  destroy() {
    clearInterval(this.tickTimer);
    cancelAnimationFrame(this.raf);
    this.dirty = false;
  }

  // ------------------------------------------------------------ отрисовка

  redraw() {
    if (this.dirty) return;
    this.dirty = true;
    const self = this;
    this.raf = requestAnimationFrame(function () { self.dirty = false; if (self.tv.hasLayer(self)) self.draw(); });
  }

  private size() {
    const w = U.w, h = U.h, dpr = U.dpr;
    if (this.dom) { this.w = w; this.h = h; return; }
    const cv = this.canvas as HTMLCanvasElement;
    if (this.w === w && this.h === h && cv.width === Math.round(w * dpr)) return;
    this.w = w; this.h = h;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }

  private get em() { return U.em; }
  private get padX() { return 4 * U.em; }
  private get padTop() { return 2.4 * U.em; }
  private get padBottom() { return 2.4 * U.em; }
  private get topH() { return 7.6 * U.em; }
  private get top1H() { return 4.8 * U.em; }
  private get headH() { return 2.6 * U.em; }
  private get rowH() { return 3.4 * U.em; }
  private get gap() { return 0.25 * U.em; }
  private get catW() { return 19 * U.em; }
  private get catRowH() { return 3.2 * U.em; }
  private get hintsH() { return Prefs.keyHints ? 1.9 * U.em : 0; }
  private topBlock(m: number) { return m === 2 ? 0 : m === 1 ? this.top1H + U.em : this.topH + U.em; }
  private get topBlockNow() {
    const m = Prefs.guideHeader;
    const a = this.topBlock(m);
    return a + (this.topBlock(Math.max(m, 1)) - a) * this.rail;
  }
  private get bodyTop() { return this.padTop + this.topBlockNow + this.headH; }
  private get contentW() { return this.w - 2 * this.padX; }
  private get railW() { return 5.6 * U.em; }
  private get datesW() { return 5.4 * U.em; }
  private get panelFullW() { return this.contentW * 0.30; }
  private get chW() { const full = this.contentW * 0.30; return this.grid ? full : full + (this.railW - full) * this.rail; }
  private get datesR() { return this.w - this.padX - (this.rail > 0 ? this.panelFullW * this.rail + U.em : 0); }
  private get datesL() { return this.datesR - this.datesW; }
  private get progL() { return this.padX + this.chW + 1.2 * U.em; }
  private get progR() { return this.datesL - U.em; }
  private get listBottom() { return this.h - this.padBottom - this.hintsH; }
  visibleRows() { return Math.max(1, Math.floor((this.h - this.bodyTop - this.padBottom - this.hintsH + this.gap) / (this.rowH + this.gap))); }
  catRows() { return Math.max(1, Math.floor((this.h - this.bodyTop - this.padBottom - this.hintsH + this.gap) / (this.catRowH + this.gap))); }

  private animate(cur: number, target: number): number {
    if (!Anim.on || Math.abs(target - cur) < 0.01) return target;
    this.redraw();
    return cur + (target - cur) * 0.3;
  }

  private draw() {
    const t0 = Date.now();
    if (this.dom) this.dom.begin();
    this.drawFrame();
    if (this.dom) this.dom.end();
    GuideStats.add(Date.now() - t0);
  }

  private drawFrame() {
    this.size();
    const c = this.c;
    const dpr = U.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const z = this.zone;
    this.rv = this.animate(this.rv, !this.progHidden || z === Zone.PROGRAMS || z === Zone.DATES ? 1 : 0);
    this.rail = this.animate(this.rail, this.descOn && (z === Zone.PROGRAMS || z === Zone.DATES) ? 1 : 0);
    this.shift = this.animate(this.shift, z === Zone.CATS || z === Zone.PLAYLISTS || (this.catsFixed && z === Zone.CHANNELS) ? 1 : 0);
    this.shift2 = this.animate(this.shift2, z === Zone.PLAYLISTS ? 1 : 0);
    this.drawBackground();
    const now = Clock.now();
    if (this.live) this.winStart = this.liveStart();
    this.drawTop(now);
    this.drawHints();
    if (this.shift2 > 0) this.drawPlaylists();
    if (this.shift > 0) this.drawCats();
    const moved = this.shift > 0;
    if (moved) {
      c.save();
      const dx = (this.shift + this.shift2) * (this.catW + U.em);
      c.beginPath();
      c.rect(this.padX + dx - this.gap, 0, this.w, this.h);
      c.clip();
      c.translate(dx, 0);
    }
    this.drawBody(now);
    if (moved) c.restore();
  }

  private drawBackground() {
    const c = this.c, w = this.w, h = this.h;
    if (lite()) {
      // без прозрачности: сплошной фон; в видах с видео справа — только слева, справа видео как есть
      c.fillStyle = C.GUIDE_TOP;
      if (!this.progHidden || this.rv >= 0.99) { c.fillRect(0, 0, w, h); return; }
      c.fillRect(0, 0, Math.min(this.padX + (this.catsFixed ? this.catW + U.em : 0) + this.chW + 1.5 * U.em, w * 0.7), h);
      return;
    }
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, C.GUIDE_TOP);
    g.addColorStop(0.4, 'rgba(12,13,14,0.86)');
    g.addColorStop(1, C.GUIDE_BOTTOM);
    if (!this.progHidden || this.rv >= 0.99) { c.fillStyle = g; c.fillRect(0, 0, w, h); return; }
    // слева затемнено, справа видео; программа выезжает — затемняется всё
    const xA = Math.min(this.padX + (this.catsFixed ? this.catW + U.em : 0) + this.chW + 1.5 * U.em, w * 0.7);
    c.fillStyle = g;
    c.fillRect(0, 0, xA, h);
    const lg = c.createLinearGradient(xA, 0, xA + w * 0.22, 0);
    lg.addColorStop(0, 'rgba(12,13,14,0.9)');
    lg.addColorStop(1, 'rgba(12,13,14,' + (0.9 * this.rv).toFixed(3) + ')');
    c.fillStyle = lg;
    c.fillRect(xA, 0, w - xA, h);
    if (Prefs.guideHeader !== 2) {
      const th = this.padTop + this.topBlockNow + this.headH;
      const tg = c.createLinearGradient(0, 0, 0, th + 2 * U.em);
      tg.addColorStop(0, 'rgba(8,9,11,' + (0.75 * (1 - this.rv)).toFixed(3) + ')');
      tg.addColorStop(1, 'rgba(8,9,11,0)');
      c.fillStyle = tg;
      c.fillRect(xA, 0, w - xA, th + 2 * U.em);
    }
  }

  private text(s: string, x: number, cy: number, w: number, size: number, color: string, bold?: boolean | number) {
    const c = this.c;
    c.font = U.font(size, bold);
    c.fillStyle = color;
    drawText(c, s, x, cy, w);
  }

  private textW(s: string, size: number, bold?: boolean | number): number {
    this.c.font = U.font(size, bold);
    return this.c.measureText(s).width;
  }

  private hintsFor(z: Zone): [string, string][] {
    switch (z) {
      case Zone.PLAYLISTS: return [['↑ ↓', str('hint_playlist')], ['OK', str('hint_select')], ['→', str('hint_categories')], [str('key_back'), str('hint_cancel')]];
      case Zone.CATS: return [['↑ ↓', str('category')], ['→', str('hint_to_channels')], [str('key_back'), str('hint_cancel')]];
      case Zone.PROGRAMS: return [['OK', str('watch')], ['←', str('hint_to_channels')], ['→', str('hint_dates')], ['↑ ↓', str('hint_programme_pick')]];
      case Zone.DATES: return [['↑ ↓', str('hint_date')], ['←', str('hint_programmes')], ['OK', str('watch')], [str('key_back'), str('hint_to_channels')]];
      case Zone.GRID: return [['OK', str('about')], ['← →', str('hint_programmes')], [str('key_back'), str('hint_to_channels')]];
      default:
        if (!this.focused()) return [[str('key_hold_ok'), str('settings')], [str('key_back'), str('exit')]];
        return [['OK', str('watch')], ['←', str('hint_categories')], ['→', str(this.grid ? 'hint_into_grid' : 'hint_programme')], [str('key_hold_ok'), str('menu')]];
    }
  }

  /** Подсказки клавиш внизу: клавиша в рамке (стрелки — линиями) и действие */
  private drawHints() {
    if (!this.hintsH) return;
    const c = this.c, em = U.em;
    const list = this.hintsFor(this.zone);
    const cy = this.h - this.padBottom - 0.8 * em;
    let x = this.padX;
    for (let i = 0; i < list.length; i++) {
      const key = list[i][0], action = list[i][1];
      const kw = Math.max(2 * em, keycapWidth(c, key) + em);
      strokeRoundRect(c, x, cy - 0.85 * em, x + kw, cy + 0.85 * em, 0.4 * em, C.t(0.4), Math.max(1, 0.1 * em));
      drawKeycap(c, key, x + (kw - keycapWidth(c, key)) / 2, cy, C.t(0.8));
      x += kw + 0.6 * em;
      this.text(action, x, cy, 1e4, 1.15, C.t(0.6));
      x += this.textW(action, 1.15) + 1.8 * em;
    }
  }

  private drawPlaylists() {
    const em = U.em;
    const l = this.padX - (1 - this.shift2) * (this.padX + this.catW);
    const r = l + this.catW;
    const headY = this.padTop + this.topBlockNow;
    this.text(str('playlists_title'), l + em, headY + this.headH / 2 - 0.3 * em, this.catW - 2 * em, 1.4, C.t(0.85), true);
    const rows = this.catRows();
    const n = this.pls.length;
    const first = Math.max(0, Math.min(this.plsIndex - (rows >> 1), Math.max(0, n - rows)));
    const cur = this.tv.playlist;
    for (let k = 0; k < rows; k++) {
      const i = first + k;
      if (i >= n) break;
      const p = this.pls[i];
      const y = this.bodyTop + k * (this.catRowH + this.gap);
      const focus = i === this.plsIndex && this.zone === Zone.PLAYLISTS;
      const open = !!cur && p.id === cur.id;
      roundRect(this.c, l, y, r, y + this.catRowH, RADIUS_S * em, focus ? C.WHITE : open ? C.FILL_ACTIVE : C.FILL);
      const cy = y + this.catRowH / 2;
      const count = p.channelsCount > 0 ? String(p.channelsCount) : '';
      const cw = this.textW(count, 1.1);
      this.text(count, r - em - cw, cy, cw + 2, 1.1, focus ? C.BLACK : C.t(0.5));
      this.text(p.name || '—', l + em, cy, r - em - cw - 2 * em - l, 1.3, focus ? C.BLACK : C.WHITE, open);
    }
  }

  private drawCats() {
    const em = U.em, c = this.c;
    const l = this.padX - (1 - this.shift) * (this.padX + this.catW) + this.shift2 * (this.catW + em);
    const r = l + this.catW;
    const headY = this.padTop + this.topBlockNow;
    const sf = this.catSearch && this.zone === Zone.CATS;
    roundRect(c, l, headY - 0.3 * em, r, headY + this.headH - 0.3 * em, RADIUS_S * em, sf ? C.WHITE : C.FILL);
    const scy = headY + this.headH / 2 - 0.3 * em;
    drawIcon(c, 'search', l + 0.9 * em, scy - 0.8 * em, 1.6 * em, sf ? C.BLACK : C.t(0.7));
    this.text(str('search'), l + 3.2 * em, scy, this.catW - 4.2 * em, 1.3, sf ? C.BLACK : C.t(0.85));
    const rows = this.catRows();
    const n = this.groups.length;
    const first = Math.max(0, Math.min(this.groupIndex - (rows >> 1), Math.max(0, n - rows)));
    const cat = this.tv.catalog;
    const pin = Prefs.pin !== '';
    for (let k = 0; k < rows; k++) {
      const i = first + k;
      if (i >= n) break;
      const g = this.groups[i];
      const y = this.bodyTop + k * (this.catRowH + this.gap);
      const focus = i === this.groupIndex;
      const white = focus && this.zone === Zone.CATS && !this.catSearch;
      if (focus) roundRect(c, l, y, r, y + this.catRowH, RADIUS_S * em, white ? C.WHITE : C.FILL_ACTIVE);
      const cy = y + this.catRowH / 2;
      const count = String(g.channels.length);
      const cw = this.textW(count, 1.1);
      this.text(count, r - em - cw, cy, cw + 2, 1.1, white ? C.BLACK : C.t(0.5));
      let tx = l + em;
      const isz = 1.5 * em;
      const ic = white ? C.BLACK : C.t(0.7);
      if (g.favourites) { drawIcon(c, 'heart', tx, cy - isz / 2, isz, ic); tx += isz + 0.5 * em; }
      else if (pin && cat && cat.isGroupLocked(g.key)) { drawIcon(c, 'lock', tx, cy - isz / 2, isz, ic); tx += isz + 0.5 * em; }
      this.text(g.title || '—', tx, cy, r - em - cw - em - tx, 1.3, white ? C.BLACK : focus ? C.WHITE : C.t(0.85), focus);
    }
  }

  private drawTop(now: number) {
    const ch = this.focused();
    const m = Prefs.guideHeader;
    if (m === 2) return;
    if (ch) {
      if (m === 0) {
        const c = this.c;
        if (this.rail < 0.99) { c.globalAlpha = 1 - this.rail; this.drawTopFull(ch, now); c.globalAlpha = 1; }
        if (this.rail > 0) { c.globalAlpha = this.rail; this.drawTopChannel(ch); c.globalAlpha = 1; }
      } else this.drawTopChannel(ch);
    }
    this.drawClock(now);
  }

  private clockW() { return this.textW('00:00', 2.2) + U.em; }

  private drawTopFull(ch: Channel, now: number) {
    const em = U.em, t = this.padTop;
    const logoW = 9 * em;
    Logos.draw(this.c, ch, this.padX, t, logoW, 6.2 * em);
    const x = this.padX + logoW + 1.2 * em;
    const w = this.w - this.padX - x - this.clockW() - 12 * em;
    const listP = (this.zone === Zone.PROGRAMS || this.zone === Zone.DATES) && !this.grid ? this.plRows[this.plIndex] : null;
    const ref = this.zone === Zone.GRID ? this.focusTime : now;
    const cell = listP ? new Cell(listP.start, listP.stop, listP) : Cells.at(this.tv.repo.around(ch, ref), ref);
    const p = cell.program;
    this.text(ch.title(), x, t + 0.6 * em, w, 1.2, C.t(0.7));
    this.text(p ? p.title : str('no_programme'), x, t + 2.35 * em, w, 1.8, C.WHITE, true);
    this.text(Fmt.dayTimeRange(cell.start, cell.end), x, t + 4.05 * em, w, 1.2, C.t(0.8));
    if (p && p.desc) this.wrapText(p.desc, x, t + 5.2 * em, w, 1.15, C.t(0.65), 2, 1.5);
  }

  /** Текст в несколько строк (обрезка последней многоточием) */
  private wrapText(s: string, x: number, top: number, w: number, size: number, color: string, maxLines: number, lineEm: number): number {
    const c = this.c;
    c.font = U.font(size);
    c.fillStyle = color;
    c.textBaseline = 'middle';
    const words = s.replace(/\s+/g, ' ').split(' ');
    let line = '';
    let n = 0;
    const lh = lineEm * U.em;
    for (let i = 0; i < words.length; i++) {
      const tryLine = line ? line + ' ' + words[i] : words[i];
      if (c.measureText(tryLine).width <= w || !line) { line = tryLine; continue; }
      if (n === maxLines - 1) { drawText(c, line + ' ' + words.slice(i).join(' '), x, top + n * lh + lh / 2, w); return n + 1; }
      c.fillText(line, x, top + n * lh + lh / 2);
      n++;
      line = words[i];
    }
    if (line) { drawText(c, line, x, top + n * lh + lh / 2, w); n++; }
    return n;
  }

  private drawTopChannel(ch: Channel) {
    const em = U.em, t = this.padTop;
    const logoW = 6.8 * em;
    Logos.draw(this.c, ch, this.padX, t + 0.2 * em, logoW, 4.4 * em);
    const x = this.padX + logoW + 1.2 * em;
    const w = this.w - this.padX - x - this.clockW() - 12 * em;
    this.text(ch.title(), x, t + 1.5 * em, w, 1.8, C.WHITE, true);
    const sub = ch.group + (ch.hasArchive ? ' · ' + str('archive_x_d', ch.archiveDays) : '');
    this.text(sub, x, t + 3.5 * em, w, 1.2, C.t(0.7));
  }

  private drawClock(now: number) {
    const em = U.em, t = this.padTop, c = this.c;
    const s = Fmt.hhmm(now);
    c.font = U.font(2.2);
    c.fillStyle = C.t(0.9);
    c.textBaseline = 'alphabetic';
    c.fillText(s, this.w - this.padX - c.measureText(s).width, t + 1.7 * em + U.px(0.4));
    const pr = this.tv.repo.progress;
    if (this.tv.repo.epgLoading()) {
      let line = str('programme_is_loading');
      if (pr && pr.total > 0) line += ' ' + Math.min(99, Math.floor(pr.read * 100 / pr.total)) + '%';
      c.font = U.font(1.1);
      c.fillStyle = C.t(0.5);
      c.fillText(line, this.w - this.padX - c.measureText(line).width, t + 3.6 * em);
    }
  }

  private drawHead(now: number) {
    if (this.rail > 0.5) return;
    const em = U.em, c = this.c;
    const y = this.padTop + this.topBlockNow;
    const cy = y + this.headH / 2;
    const g = this.group();
    const arrowW = 1.6 * em;
    const l = this.padX, r = this.padX + this.chW - em;
    if (this.groups.length > 1 && !this.catsFixed) this.text('‹', l, cy, arrowW, 1.4, C.t(0.5));
    const title = g ? g.title || '—' : '—';
    const count = g ? String(g.channels.length) : '';
    const cw = this.textW(count, 1.4);
    const tw = Math.min(this.textW(title, 1.4, true), r - l - arrowW - cw - em);
    this.text(title, l + arrowW, cy, tw, 1.4, C.WHITE, true);
    this.text(count, l + arrowW + tw + 0.6 * em, cy, cw + 2, 1.4, C.t(0.5));
    if (!this.grid) return;
    const gl = this.padX + this.chW + this.gap, gr = this.w - this.padX;
    let t = Math.floor(this.winStart / SLOT) * SLOT;
    const nx = gl + (now - this.winStart) / SPAN * (gr - gl);
    c.strokeStyle = C.t(0.25);
    c.lineWidth = Math.max(1, 0.1 * em);
    const tickW = this.textW('00:00', 1.1);
    const hw = this.textW(Fmt.hhmm(now), 1.1, true) / 2 + 0.75 * em;
    while (t < this.winStart + SPAN) {
      if (t >= this.winStart) {
        const x = gl + (t - this.winStart) / SPAN * (gr - gl);
        c.beginPath(); c.moveTo(x, y + 0.6 * em); c.lineTo(x, y + this.headH); c.stroke();
        const lx = x + 0.4 * em;
        if (nx < gl || nx > gr || lx > nx + hw || lx + tickW < nx - hw) this.text(Fmt.hhmm(t), lx, y + 1.2 * em, tickW + 2, 1.1, C.t(0.7));
      }
      t += SLOT;
    }
    const day = Fmt.dayLabel(Math.max(this.winStart, this.zone === Zone.GRID ? this.focusTime : now));
    const dw = this.textW(day, 1.1);
    this.text(day, gr - dw, y - 0.6 * em, dw + 2, 1.1, C.t(0.5));
  }

  private drawBody(now: number) {
    const em = U.em, c = this.c;
    this.drawHead(now);
    const list = this.channels();
    if (!list.length) {
      const cat = this.tv.catalog;
      this.text(this.tv.loadStatus || (!cat || !cat.channels.length ? str('no_channels') : str('no_channels')), this.padX + em, this.bodyTop + 2 * em, this.w - 2 * this.padX, 1.35, C.t(0.6));
      return;
    }
    const rows = this.visibleRows();
    const first = Math.max(0, Math.min(this.index - (rows >> 1), Math.max(0, list.length - rows)));
    const gl = this.padX + this.chW + this.gap, gr = this.w - this.padX;
    for (let r = 0; r < rows; r++) {
      const i = first + r;
      if (i >= list.length) break;
      this.drawRow(list[i], i === this.index, this.bodyTop + r * (this.rowH + this.gap), gl, gr, now);
    }
    if (this.grid) {
      const x = gl + (now - this.winStart) / SPAN * (gr - gl);
      if (x >= gl && x <= gr) {
        const shown = Math.min(rows, list.length - first);
        c.strokeStyle = C.LIVE;
        c.lineWidth = 0.2 * em;
        c.beginPath();
        c.moveTo(x, this.bodyTop - 0.5 * em);
        c.lineTo(x, this.bodyTop + shown * (this.rowH + this.gap) - this.gap);
        c.stroke();
        const s = Fmt.hhmm(now);
        const hw = this.textW(s, 1.1, true) / 2 + 0.45 * em;
        const cx = Math.max(gl + hw, Math.min(gr - hw, x));
        const cy = this.bodyTop - 1.35 * em;
        roundRect(c, cx - hw, cy - 0.85 * em, cx + hw, cy + 0.85 * em, 0.35 * em, C.LIVE);
        c.textAlign = 'center';
        this.text(s, cx, cy + 0.05 * em, 2 * hw, 1.1, C.WHITE, true);
        c.textAlign = 'left';
      }
    } else if (this.rv > 0.01) {
      if (this.rv >= 0.99) { this.drawPrograms(now); this.drawDates(); this.drawPanel(now); }
      else {
        c.save();
        c.beginPath();
        c.rect(this.padX + this.chW + this.gap, 0, this.w, this.h);
        c.clip();
        c.translate(-(1 - this.rv) * this.contentW * 0.5, 0);
        c.globalAlpha = this.rv;
        this.drawPrograms(now); this.drawDates(); this.drawPanel(now);
        c.globalAlpha = 1;
        c.restore();
      }
    }
  }

  private outline(l: number, t: number, r: number, b: number) {
    const sw = 0.15 * U.em;
    strokeRoundRect(this.c, l + sw / 2, t + sw / 2, r - sw / 2, b - sw / 2, RADIUS_S * U.em, C.t(0.8), sw);
  }

  private drawRow(ch: Channel, focus: boolean, y: number, gl: number, gr: number, now: number) {
    const em = U.em, c = this.c;
    const l = this.padX, r = this.padX + this.chW;
    const rowH = this.rowH;
    const chFocus = focus && this.zone === Zone.CHANNELS;
    roundRect(c, l, y, r, y + rowH, RADIUS_S * em, chFocus ? C.WHITE : focus ? C.FILL_ACTIVE : C.FILL);
    if (focus && !chFocus && !this.grid && (this.zone === Zone.PROGRAMS || this.zone === Zone.DATES)) this.outline(l, y, r, y + rowH);
    const fg = chFocus ? C.BLACK : C.WHITE;
    const cy = y + rowH / 2;
    let x = l + 0.35 * em;
    Logos.draw(c, ch, x, y + 0.25 * em, 4.3 * em, rowH - 0.5 * em, { focused: chFocus });
    if (!this.grid && r - l < 10 * em) return;
    x += 5 * em;
    if (Prefs.numberMode === NUMBER_NEAR_NAME) {
      this.text(String(ch.num), x, cy, 2.6 * em, 1.15, chFocus ? C.BLACK : C.t(0.5));
      x += 2.8 * em;
    } else x += 0.5 * em;
    const current = ch === this.tv.state.channel;
    const cat = this.tv.catalog;
    const fav = !!cat && cat.isFavorite(ch);
    const locked = !!cat && cat.isLocked(ch);
    const isz = 1.5 * em;
    const iw = ((fav ? 1 : 0) + (ch.hasArchive ? 1 : 0) + (locked ? 1 : 0)) * (isz + 0.35 * em);
    this.text(ch.name, x, cy, r - x - 0.8 * em - iw, 1.35, fg, current);
    const ic = chFocus ? C.BLACK : C.t(0.7);
    let ix = r - 0.8 * em;
    if (ch.hasArchive) { ix -= isz; drawIcon(c, 'archive', ix, cy - isz / 2, isz, ic); ix -= 0.35 * em; }
    if (fav) { ix -= isz; drawIcon(c, 'star', ix, cy - isz / 2, isz, ic); ix -= 0.35 * em; }
    if (locked) { ix -= isz; drawIcon(c, 'lock', ix, cy - isz / 2, isz, ic); }
    if (!this.grid) return;
    const from = this.winStart, to = this.winStart + SPAN;
    const k = (gr - gl) / SPAN;
    const fc = focus && this.zone === Zone.GRID ? Cells.at(this.tv.repo.around(ch, this.focusTime), this.focusTime) : null;
    const cells = this.rowCells(ch, from, to);
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const cl = gl + (Math.max(cell.start, from) - from) * k;
      const cr = gl + (Math.min(cell.end, to) - from) * k - this.gap;
      if (cr - cl < 2) continue;
      const isFocus = !!fc && fc.start === cell.start;
      const isNow = cell.start <= now && now < cell.end;
      const isPast = cell.end <= now;
      const color = isFocus ? C.WHITE : !cell.program ? C.t(0.04) : isNow ? C.FILL_NOW : isPast ? C.FILL : C.FILL_CELL;
      roundRect(c, cl, y, cr, y + rowH, RADIUS_S * em, color);
      const tl = cl + 0.7 * em;
      let tw = cr - tl - 0.5 * em;
      if (cell.program && cell.start > now && Reminders.has(ch, cell.start) && tw > 2 * em) {
        drawIcon(c, 'bell', cr - 0.5 * em - isz, cy - isz / 2, isz, isFocus ? C.BLACK : C.ARCHIVE);
        tw -= isz + 0.4 * em;
      }
      if (tw > em) {
        const t = cell.title || (isFocus ? Fmt.timeRange(cell.start, cell.end) : '');
        if (t) this.text(t, tl, cy, tw, 1.25, isFocus ? C.BLACK : isPast ? C.t(0.45) : C.WHITE);
      }
    }
  }

  private progH(p: Programme, now: number) { return p.start <= now && now < p.stop ? this.rowH + 0.9 * U.em : this.rowH; }

  private drawPrograms(now: number) {
    this.ensureRows();
    const em = U.em, c = this.c;
    const l = this.progL, r = this.progR, top = this.bodyTop, bottom = this.listBottom;
    const rows = this.plRows;
    if (!rows.length) {
      const ch = this.focused();
      const loading = !!ch && this.tv.repo.isLoading(ch);
      this.text(loading ? str('programme_is_loading') : str('no_programme'), l + em, top + this.rowH / 2, r - l, 1.35, C.t(0.6));
      return;
    }
    const fi = this.zone === Zone.CHANNELS ? this.liveIndex() : this.plIndex;
    let total = 0, fy = 0, fh = 0;
    for (let i = 0; i < rows.length; i++) {
      const h = this.progH(rows[i], now);
      if (i === fi) { fy = total; fh = h; }
      total += h + this.gap;
    }
    const viewH = bottom - top;
    const target = Math.max(0, Math.min(fy - viewH / 2 + fh / 2, Math.max(0, total - viewH)));
    if (this.plJump || !Anim.on) { this.plScroll = target; this.plJump = false; }
    else if (Math.abs(target - this.plScroll) > 0.5) { this.plScroll += (target - this.plScroll) * 0.35; this.redraw(); }
    else this.plScroll = target;
    c.save();
    c.beginPath();
    c.rect(l - 2, top, r - l + 4, bottom - top);
    c.clip();
    let y = top - this.plScroll;
    for (let i = 0; i < rows.length; i++) {
      const h = this.progH(rows[i], now);
      if (y + h >= top && y <= bottom) this.drawProgRow(rows[i], i, l, r, y, h, now);
      y += h + this.gap;
      if (y > bottom) break;
    }
    c.restore();
    this.fadeEdges(l, top, r, bottom, this.plScroll > 1, total - viewH - this.plScroll > 1);
  }

  /** Затемнение краёв списка поверх фона гида */
  private fadeEdges(l: number, t: number, r: number, b: number, top: boolean, bottom: boolean) {
    if (lite()) return;
    const len = Math.min(3 * U.em, (b - t) / 3);
    const c = this.c;
    if (top) {
      const g = c.createLinearGradient(0, t, 0, t + len);
      g.addColorStop(0, 'rgba(12,13,14,0.95)');
      g.addColorStop(1, 'rgba(12,13,14,0)');
      c.fillStyle = g;
      c.fillRect(l - 2, t, r - l + 4, len);
    }
    if (bottom) {
      const g = c.createLinearGradient(0, b - len, 0, b);
      g.addColorStop(0, 'rgba(12,13,14,0)');
      g.addColorStop(1, 'rgba(12,13,14,0.95)');
      c.fillStyle = g;
      c.fillRect(l - 2, b - len, r - l + 4, len);
    }
  }

  private drawProgRow(p: Programme, i: number, l: number, r: number, y: number, h: number, now: number) {
    const ch = this.focused();
    if (!ch) return;
    const em = U.em, c = this.c;
    const live = p.start <= now && now < p.stop;
    const past = p.stop <= now;
    const pf = this.zone === Zone.PROGRAMS && i === this.plIndex;
    const ghost = this.zone === Zone.DATES && i === this.plIndex;
    const bg = pf ? C.WHITE : ghost ? C.FILL_ACTIVE : live ? C.FILL_PLAYING : '';
    if (bg) roundRect(c, l, y, r, y + h, RADIUS_S * em, bg);
    if (ghost) this.outline(l, y, r, y + h);
    const fg = pf ? C.BLACK : past ? C.t(0.62) : C.WHITE;
    const cy = live ? y + this.rowH / 2 - 0.1 * em : y + h / 2;
    this.text(Fmt.hhmm(p.start), l + 0.8 * em, cy, 5 * em, 1.3, fg);
    const ic = pf ? C.BLACK : C.t(0.8);
    const isz = 1.7 * em;
    let ix = r - 0.8 * em;
    if (live) {
      const lw = this.textW('LIVE', 1.2, true);
      const pad = 0.8 * em;
      ix -= lw + 2 * pad;
      strokeRoundRect(c, ix, cy - 0.85 * em, ix + lw + 2 * pad, cy + 0.85 * em, 0.3 * em, ic, 0.12 * em);
      this.text('LIVE', ix + pad, cy + 0.05 * em, lw + 2, 1.2, ic, true);
      ix -= 0.5 * em;
    }
    if (past && ch.hasArchive && p.start >= now - ch.archiveDays * 86400 - SLOT) { ix -= isz; drawIcon(c, 'archive', ix, cy - isz / 2, isz, ic); ix -= 0.5 * em; }
    if (p.start > now && Reminders.has(ch, p.start)) { ix -= isz; drawIcon(c, 'bell', ix, cy - isz / 2, isz, ic); ix -= 0.5 * em; }
    const tx = l + 5.4 * em;
    this.text(p.title, tx, cy, ix - tx - 0.3 * em, 1.35, fg, live);
    if (live) {
      const by = y + h - 0.95 * em;
      const bw = r - 0.8 * em - tx;
      roundRect(c, tx, by, tx + bw, by + 0.25 * em, 0.12 * em, pf ? 'rgba(0,0,0,0.2)' : C.t(0.22));
      roundRect(c, tx, by, tx + bw * Fmt.progress(p.start, p.stop, now), by + 0.25 * em, 0.12 * em, pf ? C.BLACK : C.WHITE);
    }
  }

  private drawDates() {
    const days = this.plDays;
    if (!days.length) return;
    const em = U.em, c = this.c;
    const l = this.datesL, r = this.datesR;
    const th = 3.6 * em, step = th + 0.3 * em;
    const top = this.bodyTop, bottom = this.listBottom;
    const cur = this.zone === Zone.DATES ? this.dateIndex
      : Math.max(0, days.indexOf(this.dayOf(this.zone === Zone.CHANNELS ? this.liveIndex() : Math.max(0, Math.min(this.plIndex, this.plRows.length - 1)))));
    const viewH = bottom - top;
    const off = Math.max(0, Math.min(cur * step - viewH / 2 + th / 2, Math.max(0, days.length * step - viewH)));
    c.save();
    c.beginPath();
    c.rect(l - 2, top, r - l + 4, bottom - top);
    c.clip();
    c.textAlign = 'center';
    for (let k = 0; k < days.length; k++) {
      const y = top + k * step - off;
      if (y + th < top || y > bottom) continue;
      const focus = this.zone === Zone.DATES && k === this.dateIndex;
      if (focus) roundRect(c, l, y, r, y + th, RADIUS_S * em, C.WHITE);
      else if (k === cur) this.outline(l, y, r, y + th);
      const color = focus ? C.BLACK : k === cur ? C.WHITE : C.t(0.72);
      const bold = focus || k === cur;
      this.text(this.plDayLabels[k][0], (l + r) / 2, y + th / 2 - 0.6 * em, r - l, 1.25, color, bold);
      this.text(this.plDayLabels[k][1], (l + r) / 2, y + th / 2 + 0.75 * em, r - l, 1.25, color, bold);
    }
    c.textAlign = 'left';
    c.restore();
    this.fadeEdges(l, top, r, bottom, off > 1, days.length * step - viewH - off > 1);
  }

  private panelImg: { url: string; img: HTMLImageElement; ok: boolean } | null = null;

  /** Панель передачи справа (настройка «Описание в ТВ-гиде») */
  private drawPanel(now: number) {
    if (this.rail <= 0.01) return;
    const ch = this.focused();
    const p = this.plRows[this.plIndex];
    if (!ch || !p) return;
    const em = U.em, c = this.c;
    const pw = this.panelFullW;
    const l = this.w - this.padX - pw + (1 - this.rail) * (pw + this.padX);
    const top = this.bodyTop, bottom = this.listBottom;
    c.globalAlpha = this.rail;
    const ih = Math.min(pw * 9 / 16, (bottom - top) * 0.4);
    let drawn = false;
    if (p.icon) {
      if (!this.panelImg || this.panelImg.url !== p.icon) {
        const img = new Image();
        const rec = { url: p.icon, img: img, ok: false };
        const self = this;
        img.onload = function () { rec.ok = true; self.redraw(); };
        img.src = p.icon;
        this.panelImg = rec;
      }
      if (this.panelImg.ok) {
        const img = this.panelImg.img;
        const k = Math.max(pw / img.naturalWidth, ih / img.naturalHeight);
        const sw = pw / k, sh = ih / k;
        c.save();
        c.beginPath();
        c.rect(l, top, pw, ih);
        c.clip();
        try { c.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, l, top, pw, ih); } catch (e) { /* */ }
        c.restore();
        drawn = true;
      }
    }
    if (!drawn) Logos.draw(c, ch, l, top, pw, ih, { badge: false });
    let y = top + ih + 1.2 * em;
    this.text(Fmt.dayTimeRange(p.start, p.stop), l, y + 0.6 * em, pw, 1.2, C.t(0.7));
    y += 1.9 * em;
    const tl = this.wrapText(p.title, l, y, pw, 1.6, C.WHITE, 3, 2);
    y += tl * 2 * em + 0.7 * em;
    if (p.desc) this.wrapText(p.desc, l, y, pw, 1.25, C.t(0.8), Math.max(2, Math.floor((bottom - y - 3 * em) / (1.7 * em))), 1.7);
    const live = p.start <= now && now < p.stop;
    const action = str(live ? 'watch_live' : p.stop <= now && ch.hasArchive && p.start >= now - ch.archiveDays * 86400 - SLOT ? 'watch_from_archive' : 'about');
    const cy = bottom - 0.9 * em;
    const kw = Math.max(2 * em, this.textW('OK', 1.1) + em);
    strokeRoundRect(c, l, cy - 0.85 * em, l + kw, cy + 0.85 * em, 0.4 * em, C.t(0.4), Math.max(1, 0.1 * em));
    c.textAlign = 'center';
    this.text('OK', l + kw / 2, cy, kw, 1.1, C.t(0.8));
    c.textAlign = 'left';
    this.text(action, l + kw + 0.6 * em, cy, pw - kw, 1.15, C.t(0.6));
    c.globalAlpha = 1;
  }

  // ------------------------------------------------------------ мышь (Magic Remote)

  private rowAt(y: number): number {
    const rows = this.visibleRows();
    const first = Math.max(0, Math.min(this.index - (rows >> 1), Math.max(0, this.channels().length - rows)));
    return first + Math.floor((y - this.bodyTop) / (this.rowH + this.gap));
  }

  private tap(x: number, y: number) {
    const headY = this.padTop + this.topBlockNow;
    if (this.zone === Zone.PLAYLISTS) {
      if (x < this.padX + this.catW && y >= this.bodyTop) {
        const rows = this.catRows();
        const first = Math.max(0, Math.min(this.plsIndex - (rows >> 1), Math.max(0, this.pls.length - rows)));
        const i = first + Math.floor((y - this.bodyTop) / (this.catRowH + this.gap));
        if (i >= 0 && i < this.pls.length) { this.plsIndex = i; this.choosePlaylist(); return; }
      }
      this.zone = Zone.CATS;
      this.redraw();
      return;
    }
    if (this.zone === Zone.CATS || (this.catsFixed && this.shift > 0.99 && x < this.padX + this.catW)) {
      if (x < this.padX + this.catW && y < this.bodyTop && y >= headY) { this.tv.openSearch(); return; }
      if (x < this.padX + this.catW && y >= this.bodyTop) {
        const rows = this.catRows();
        const first = Math.max(0, Math.min(this.groupIndex - (rows >> 1), Math.max(0, this.groups.length - rows)));
        this.catsFromChannel = this.focused();
        this.setGroup(first + Math.floor((y - this.bodyTop) / (this.catRowH + this.gap)));
      }
      if (!this.catsFixed) this.closeCats(); else { this.zone = Zone.CHANNELS; this.redraw(); }
      return;
    }
    if (this.catsFixed && this.shift > 0.99) x -= this.catW + U.em;
    if (y >= headY && y <= headY + this.headH && x < this.padX + this.chW && !this.catsFixed) { this.openCats(); return; }
    if (y < this.bodyTop) return;
    if (!this.grid && x > this.padX + this.chW) { this.listTap(x, y); return; }
    const i = this.rowAt(y);
    if (i < 0 || i >= this.channels().length) return;
    this.index = i;
    const gl = this.padX + this.chW + this.gap;
    if (x < gl || !this.grid) { this.zone = Zone.CHANNELS; this.enter(); }
    else {
      this.zone = Zone.GRID;
      this.live = false;
      this.focusTime = this.winStart + Math.floor((x - gl) / (this.w - this.padX - gl) * SPAN);
      this.enter();
    }
    this.redraw();
  }

  private listTap(x: number, y: number) {
    this.ensureRows();
    const now = Clock.now();
    if (x >= this.datesL && x <= this.datesR) {
      const step = 3.9 * U.em;
      const cur = Math.max(0, this.plDays.indexOf(this.dayOf(Math.max(0, Math.min(this.plIndex, this.plRows.length - 1)))));
      const viewH = this.listBottom - this.bodyTop;
      const off = Math.max(0, Math.min(cur * step - viewH / 2 + 1.8 * U.em, Math.max(0, this.plDays.length * step - viewH)));
      const k = Math.floor((y - this.bodyTop + off) / step);
      if (k >= 0 && k < this.plDays.length) { this.dateIndex = k; this.goDay(k); this.zone = Zone.PROGRAMS; }
      this.redraw();
      return;
    }
    if (x < this.progL || x > this.progR) return;
    let yy = this.bodyTop - this.plScroll;
    for (let i = 0; i < this.plRows.length; i++) {
      const h = this.progH(this.plRows[i], now);
      if (y >= yy && y < yy + h) {
        const wasFocus = this.zone === Zone.PROGRAMS && this.plIndex === i;
        this.plIndex = i;
        this.zone = Zone.PROGRAMS;
        if (wasFocus) this.programAction(this.plRows[i]);
        this.redraw();
        return;
      }
      yy += h + this.gap;
    }
  }

  relabel() { this.redraw(); }
}

// ------------------------------------------------------------ клавиши в рамке на Canvas

const ARROW_RE = /(←|→|↑|↓)/;

function keycapWidth(c: CanvasRenderingContext2D, key: string): number {
  c.font = U.font(1.1);
  const parts = key.split(ARROW_RE);
  let w = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (ARROW_RE.test(p)) w += 1.1 * U.em;
    else w += c.measureText(p).width;
  }
  return w;
}

/** Клавиша: стрелки — линиями (глифы шрифта стоят у нижнего края), остальное — текстом */
function drawKeycap(c: CanvasRenderingContext2D, key: string, x: number, cy: number, color: string) {
  c.font = U.font(1.1);
  c.fillStyle = color;
  c.strokeStyle = color;
  c.textBaseline = 'middle';
  const parts = key.split(ARROW_RE);
  const s = 1.1 * U.em;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (ARROW_RE.test(p)) {
      const h = s * 0.38;
      const mx = x + s / 2;
      c.lineWidth = Math.max(1.2, 0.13 * U.em);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.beginPath();
      if (p === '←' || p === '→') {
        const d = p === '←' ? -1 : 1;
        c.moveTo(mx - d * h, cy); c.lineTo(mx + d * h, cy);
        c.moveTo(mx + d * h * 0.2, cy - h * 0.7); c.lineTo(mx + d * h, cy); c.lineTo(mx + d * h * 0.2, cy + h * 0.7);
      } else {
        const d = p === '↑' ? -1 : 1;
        c.moveTo(mx, cy - d * h); c.lineTo(mx, cy + d * h);
        c.moveTo(mx - h * 0.7, cy + d * h * 0.2); c.lineTo(mx, cy + d * h); c.lineTo(mx + h * 0.7, cy + d * h * 0.2);
      }
      c.stroke();
      x += s;
    } else {
      c.fillText(p, x, cy + 0.05 * U.em);
      x += c.measureText(p).width;
    }
  }
}

/** Время отрисовки гида (мс) — в журнал раз в 50 кадров: сравнить HTML и Canvas на ТВ */
const GuideStats = {
  n: 0, sum: 0, max: 0,
  add(ms: number) {
    this.n++; this.sum += ms; if (ms > this.max) this.max = ms;
    if (this.n >= 50) {
      console.log('guide draw ' + (Prefs.guideRender === 0 ? 'html' : 'canvas') + ' (js) avg ' + (this.sum / this.n).toFixed(1) + ' ms, max ' + this.max + ' ms / ' + this.n + ' frames');
      this.n = 0; this.sum = 0; this.max = 0;
    }
  },
};
