import { Clock } from '../core/clock';
import { plural, str } from '../core/lang';
import { Net } from '../core/net';
import { Platform } from '../core/platform';
import { Prefs } from '../core/prefs';
import { Bus } from '../data/bus';
import { ALL_KEY, Catalog, FAV_KEY } from '../data/catalog';
import { CatchupUrl } from '../data/catchup';
import { Channel, Playlist } from '../data/models';
import { inArchive, isMissed, Reminder, Reminders } from '../data/reminders';
import { Repo } from '../data/repo';
import { isHlsUrl, Playback } from '../player/playback';
import { useNativeHls } from '../player/hlsmode';
import { Cell } from './cells';
import { el } from './dom';
import { Fmt } from './fmt';
import { GuideLayer } from './guide';
import { InfoPanel } from './info';
import { Keys } from './keys';
import { Layer } from './layer';
import { Logos } from './logos';
import { MenuItem, MenuLayer, MenuPage, MenuTile } from './menu';
import { PinLayer } from './pin';
import { DetailsLayer, FormLayer, HelpLayer, ListItem, ListLayer, LogLayer, MessageLayer, ReminderLayer } from './popups';
import { ScheduleLayer } from './schedule';
import { SearchLayer } from './search';
import { SettingsLayer } from './settings';
import { Buffering, Carousel, Osd, Toast } from './widgets';

/** Архив: start — реальный момент начала ссылки, base — позиция плеера (мс) ему соответствующая */
interface Archive { start: number; base: number | null; timeshift: boolean; continued: boolean; pdt: boolean }

const BACK_EXIT = 2000;
const SWITCH_DELAY = 700;
const OSD_NUMBER = 2000;
const SEEK_DELAY = 900;
const ADAPTIVE_AFTER = 5 * 60 * 1000;
const SEEK_TAP = 30;
const SEEK_START = 30;
const SEEK_GROW = 120;
const SEEK_MAX = 600;
const SEEK_GAP = 700;
const RETRY = [2000, 5000, 10000];
const SLEEP_STEPS = [15, 30, 45, 60, 90, 120];
const AUTO_REFRESH = 15 * 60;

interface Seek { target: number; dir: number; last: number; released: boolean; holdStart: number; holdTick: number; holding: boolean }

/**
 * Экран ТВ: видео, слои поверх (стек), клавиши, эфир и архив. Верхний слой получает клавиши,
 * без слоёв их получает плеер (playerLayer).
 */
export class Tv {
  readonly repo = new Repo();
  catalog: Catalog | null = null;
  playlist: Playlist | null = null;
  readonly playback: Playback;
  readonly ui: HTMLElement;
  readonly info: InfoPanel;
  readonly toast: Toast;
  private osd: Osd;
  private carousel: Carousel;
  private buffering: Buffering;
  readonly guide: GuideLayer;
  readonly keys: Keys;
  private layers: Layer[] = [];

  state = { channel: null as Channel | null, groupKey: null as string | null, archive: null as Archive | null, height: 0, error: false };
  private pending: Channel | null = null;
  private pendingDir = 0;
  private switchDirection = 0;
  private switchGroup: string | null = null;
  private switchTimer = 0;
  private backTime = 0;
  private numBuf = '';
  private numTimer = 0;
  private pauseInfo: number | null = null;
  private retry = 0;
  private retryTimer = 0;
  private lastUrl = '';
  private forceHls = false;
  private viaProxy = false;
  private nativeFallback = false;
  private autoHlsFallback = false;
  private streamStartedAt = 0;
  private seek: Seek | null = null;
  private seekTimer = 0;
  private seekTickTimer = 0;
  private archiveRetry = 0;
  private watch: { pos: number; at: number; moved: number; shown: number } | null = null;
  private scoreTimer = 0;
  private pinPassed = false;
  private beforeLocked: Channel | null = null;
  private beforeLockedGroup: string | null = null;
  private historyBeforeLocked: string[] | null = null;
  private unlockedKeys: { [k: string]: true } = {};
  private menu: MenuLayer | null = null;
  private reminderLayer: ReminderLayer | null = null;
  private sleepAt = 0;
  private sleepTimers: number[] = [];
  private ticks = 0;
  private moreKey = '';
  private screen: Layer | null = null;
  /** Строка о первой загрузке плейлиста (в гиде без каналов) */
  loadStatus = '';

  constructor(video: HTMLVideoElement, ui: HTMLElement) {
    this.ui = ui;
    const self = this;
    this.playback = new Playback(video, {
      onState: function (playing, buffering) {
        self.buffering.set(buffering && !self.state.error);
        if (playing) { self.retry = 0; if (self.state.error) { self.state.error = false; self.updateInfo(); } }
      },
      onReady: function () { self.onReady(); },
      onEnded: function () { self.onStreamEnded(); },
      onError: function (kind, detail) { self.onStreamError(kind, detail); },
      onVideoSize: function (_w, h) { if (self.state.height !== h) { self.state.height = h; self.updateInfo(); } },
      onTracks: function () { if (self.menu) self.menu.refresh(); },
    });
    this.playback.audioLang = Prefs.audioLang;
    this.playback.subtitleLang = Prefs.subtitleLang;
    this.playback.setAspect(Prefs.aspect);
    this.buffering = new Buffering(ui);
    this.info = new InfoPanel(ui);
    this.carousel = new Carousel(ui);
    this.osd = new Osd(ui);
    this.toast = new Toast(ui);
    this.guide = new GuideLayer(this);
    this.keys = new Keys(function () { return self.top(); });
    Logos.setOnLoad(function () { self.guide.redraw(); });
    Bus.on('epg', function () { self.guide.redraw(); if (!self.pending) self.updateInfo(); });
    Bus.on('progress', function () { self.guide.redraw(); });
    Bus.on('channels', function (pid: number) { self.onChannelsChanged(pid); });
    Reminders.onDue = function (r) { self.notifyReminder(r); };
    setInterval(function () { self.tick(); }, 1000);
  }

  // ================================================================ запуск

  /** Старт: плейлисты из базы → последний; без плейлистов — мастер */
  start() {
    const self = this;
    this.repo.loadPlaylists().then(function (list) {
      if (!list.length) { self.devPlaylist(); return; }
      const p = self.repo.playlist(Prefs.lastPlaylist) || list[0];
      self.open(p);
      self.repo.preloadChannels().then(null, function (e) { console.warn('preload channels', e); });
    }, function (e) {
      console.error(e);
      self.showError('storage');
    });
  }

  open(p: Playlist) {
    this.playlist = p;
    Prefs.lastPlaylist = p.id;
    const self = this;
    console.log('open playlist', p.id, p.channelsCount, 'channels saved');
    this.repo.loadCatalog(p).then(function (cat) {
      if (self.playlist !== p) return;
      self.catalog = cat;
      if (cat.channels.length) self.startFromLast();
      if (!cat.channels.length || self.repo.isStale(p)) self.refreshPlaylist(p, false);
      else self.repo.refreshEpg(p, false);
    }, function (e) {
      console.error('loadCatalog', e);
      self.showError('storage');
    });
  }

  private refreshPlaylist(p: Playlist, force: boolean) {
    const self = this;
    const first = !this.catalog || !this.catalog.channels.length;
    if (first) { this.loadStatus = str('loading_channels'); this.guide.redraw(); }
    this.repo.refresh(p, force, first ? function (raw) {
      // первая загрузка: каналы видны по ходу разбора
      if (self.playlist !== p) return;
      self.catalog = self.repo.catalogOf(p, raw);
      if (self.layers.indexOf(self.guide) >= 0) self.guide.reload(); else self.openGuide();
    } : undefined, first ? function (read, n) {
      self.loadStatus = str('loading_channels') + '  ' + Fmt.size(read) + (n ? ' · ' + plural('channels', n) : '');
      self.guide.redraw();
    } : undefined).then(function (err) {
      if (self.playlist !== p) return;
      self.loadStatus = '';
      if (err) { if (first || !self.catalog || !self.catalog.channels.length) self.showError(err); else self.toast.show(self.errorText(err)); return; }
    }, function (e) {
      console.error('refresh', e);
      self.loadStatus = '';
      self.showError('storage');
    });
  }

  private onChannelsChanged(pid: number) {
    if (!this.playlist || this.playlist.id !== pid) return;
    const p = this.playlist;
    const self = this;
    const first = !this.catalog || !this.catalog.channels.length;
    this.repo.loadCatalog(p).then(function (cat) {
      const cur = self.state.channel;
      self.catalog = cat;
      if (cur) { const c = cat.byKey[cur.key]; if (c) self.state.channel = c; }
      if (self.layers.indexOf(self.guide) >= 0) self.guide.reload();
      if (first && !self.state.channel) self.startFromLast();
    }, function (e) { console.error('reload catalog', e); self.showError('storage'); });
  }

  private startFromLast() {
    const cat = this.catalog;
    const p = this.playlist;
    if (!cat || !p) return;
    if (this.state.channel) return;
    const last = cat.byKey[Prefs.lastChannel(p.id)];
    const gk = Prefs.lastGroup(p.id);
    if (last && Prefs.autoplayLast && !cat.isHidden(last)) {
      this.playChannel(last, gk);
      return;
    }
    this.state.groupKey = gk;
    this.openGuide();
  }

  // ================================================================ ошибки, мастер

  errorText(code: string): string {
    if (code === 'no_url') return str('enter_the_address');
    if (code === 'network') return str('no_connection_to_the_server');
    if (code === 'format') return str('the_file_does_not_look_like_an_m3u');
    if (code === 'empty') return str('the_playlist_has_no_channels');
    if (code === 'need_service') return str('need_service');
    if (code === 'storage') return str('storage_error');
    if (code === 'timeout') return str('timeout_error');
    if (code.indexOf('http_') === 0) return str('server_error_x', code.substring(5));
    return code;
  }

  private showError(code: string) {
    const self = this;
    let layer: MessageLayer | null = null;
    layer = new MessageLayer(this.ui, str('could_not_load_the_playlist'), this.errorText(code), [str('retry'), str('settings')], function (i) {
      self.remove(layer!);
      if (i === 0 && self.playlist) self.refreshPlaylist(self.playlist, true);
      else self.openSettings();
    }, function () { self.exitRequest(); });
    this.push(layer);
  }

  /**
   * Для проверки в симуляторе: файл dev-playlist.txt рядом с index.html (адрес в первой строке)
   * добавляется как первый плейлист. В сборку файл не входит — тогда обычный мастер.
   */
  private devPlaylist() {
    const self = this;
    const x = new XMLHttpRequest();
    x.open('GET', 'dev-playlist.txt', true);
    x.onload = function () {
      const url = (x.responseText || '').split('\n')[0].trim();
      if ((x.status === 200 || x.status === 0) && /^https?:\/\//.test(url)) self.repo.addPlaylist('Dev', url).then(function (p) { self.open(p); });
      else self.wizard();
    };
    x.onerror = function () { self.wizard(); };
    x.send();
  }

  /** Мастер первого плейлиста: адрес и имя */
  wizard() {
    const self = this;
    let layer: FormLayer | null = null;
    layer = new FormLayer(this.ui, str('add_playlist'), [
      { label: str('playlist_address'), value: '', type: 'url' },
      { label: str('name'), value: '' },
    ], [str('add'), str('settings')], function (i, v) {
      if (i === 1) { self.remove(layer!); self.openSettings(); return; }
      if (!v[0]) { self.toast.show(str('enter_the_address')); return; }
      self.remove(layer!);
      self.repo.addPlaylist(v[1] || str('playlist'), v[0]).then(function (p) { self.open(p); });
    }, function () { self.exitRequest(); }, str('wizard_note'));
    this.push(layer);
  }

  // ================================================================ слои

  top(): Layer { return this.layers.length ? this.layers[this.layers.length - 1] : this.playerLayer; }

  push(layer: Layer) {
    this.keys.release();
    if (this.layers.indexOf(layer) < 0) this.layers.push(layer);
    if (layer.el && layer.el.parentNode !== this.ui) this.ui.appendChild(layer.el);
    else if (layer.el) this.ui.appendChild(layer.el);
    // тост и набор номера — поверх всего
  }

  remove(layer: Layer) {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.keys.release();
    if (layer.destroy) layer.destroy();
    if (layer.el && layer.el.parentNode) layer.el.parentNode.removeChild(layer.el);
  }

  hasLayer(l: Layer) { return this.layers.indexOf(l) >= 0; }

  private removeAllBut(keep: Layer[]) {
    const l = this.layers.slice().reverse();
    for (let i = 0; i < l.length; i++) if (keep.indexOf(l[i]) < 0) this.remove(l[i]);
  }

  keyDown(e: KeyboardEvent): boolean { return this.keys.onKeyDown(e.keyCode, (e as any).repeat); }
  keyUp(e: KeyboardEvent): boolean { return this.keys.onKeyUp(e.keyCode); }
  wheel(dy: number, dx: number) { const t = this.top(); if (t.wheel) t.wheel(dy, dx); }

  /** Язык или размер интерфейса сменились — пересобрать тексты */
  relabel() {
    if (this.catalog) this.catalog.retitle();
    this.info.relabel();
    this.info.layout();
    this.guide.reload();
    this.updateInfo();
  }

  // ================================================================ плеер без окон

  private playerLayer: Layer = (function (self: Tv): Layer {
    return {
      el: null,
      hasLong: function (name: string) { return name === 'up' || name === 'down'; },
      keyUp: function (name: string) { if (name === 'left' || name === 'right') self.seekKeyUp(); },
      key: function (name: string, long: boolean, digit: number) {
        if (name === 'digit') { self.digit(digit); return; }
        if (!self.state.channel && !self.pending) { self.openGuide(); return; }
        const seekable = self.state.archive !== null && !!self.state.channel && self.state.channel.hasArchive;
        if (name === 'left') { if (seekable) self.seekStep(-1); else self.switchRelative(-1); }
        else if (name === 'right') { if (seekable) self.seekStep(1); else self.switchRelative(1); }
        else if (name === 'pgup') self.switchRelative(1);
        else if (name === 'pgdown') self.switchRelative(-1);
        else if (name === 'up') {
          if (long) { self.openReminders(self.state.channel); return; }
          if (self.info.visible && self.info.more) { self.info.collapse(); return; }
          if (self.info.visible) { self.info.hide(); return; }
          if (Prefs.upArchive && self.state.channel) self.openSchedule(self.state.channel, 0); else self.openHistory();
        } else if (name === 'down') {
          if (long) { self.openHistory(); return; }
          if (self.info.visible && self.info.sticky) { if (!self.info.more) self.expandInfo(); return; }
          if (self.info.visible) { self.updateInfo(); self.info.show(0); self.expandInfo(); return; }
          self.showInfo(true);
        }
      },
      enter: function () {
        if (self.numBuf) { self.applyNumber(); return; }
        if (self.seek) { self.applySeek(); return; }
        if (self.info.visible && self.state.channel && !self.pending) { self.togglePause(); return; }
        self.openGuide();
      },
      long: function () { if (self.state.channel) self.openMenu(self.state.channel); },
      back: function () { self.playerBack(); },
      media: function (name: string) { self.mediaKey(name); },
      wheel: function (dy: number) { self.switchRelative(dy > 0 ? 1 : -1); },
    };
  })(this);

  private playerBack() {
    if (this.numBuf) { this.cancelNumber(); return; }
    if (this.seek) { this.cancelSeek(); return; }
    if (this.info.visible && this.info.more) { this.info.collapse(); return; }
    if (this.info.visible && this.info.sticky) { this.info.hide(); return; }
    if (this.info.visible) this.info.hide();
    this.exitRequest();
  }

  /** «Назад» дважды — выход; на закрытом канале — к последнему открытому */
  exitRequest() {
    const t = Date.now();
    const back = this.lockedReturn();
    if (t - this.backTime < BACK_EXIT) {
      this.backTime = 0;
      if (back) { this.leaveLocked(back); return; }
      this.playback.stop();
      Platform.exit();
      return;
    }
    this.backTime = t;
    this.toast.show(back ? str('press_back_again_to_leave_locked') : str('press_back_again_to_exit'), BACK_EXIT);
  }

  private lockedReturn(): Channel | null {
    const cat = this.catalog, cur = this.state.channel;
    if (!cat || !cur || !cat.isLocked(cur)) return null;
    if (this.beforeLocked && !cat.isLocked(this.beforeLocked)) return this.beforeLocked;
    const h = this.historyBeforeLocked || cat.history;
    for (let i = 0; i < h.length; i++) {
      const c = cat.byKey[h[i]];
      if (c && c !== cur && !cat.isLocked(c)) return c;
    }
    return null;
  }

  private leaveLocked(ch: Channel) {
    const cat = this.catalog;
    const gk = this.beforeLockedGroup;
    let h = this.historyBeforeLocked;
    if (!h && cat) h = cat.history.filter(function (k) { const c = cat.byKey[k]; return !c || !cat.isLocked(c); });
    if (h && cat) cat.replaceHistory(h);
    this.unlockedKeys = {};
    this.pinPassed = false;
    this.beforeLocked = null;
    this.historyBeforeLocked = null;
    this.closeGuide(true);
    this.playChannel(ch, gk);
  }

  // ================================================================ воспроизведение

  hasVideo() { return this.state.channel !== null; }

  /** Текущая позиция воспроизведения (unix-сек) */
  position(): number {
    const a = this.state.archive;
    if (!a) return this.pauseInfo !== null ? this.pauseInfo : Clock.now();
    if (a.pdt) { const w = this.playback.wallClockMs; if (w !== null) return Math.floor(w / 1000); }
    if (a.base === null) return a.start;
    return a.start + Math.max(0, Math.floor((this.playback.positionMs - a.base) / 1000));
  }

  private groupKeyFor(ch: Channel, prefer: string | null): string | null {
    const cat = this.catalog;
    return cat ? cat.groupOf(ch, prefer !== null ? prefer : this.state.groupKey).key : null;
  }

  /**
   * Включить канал. archive — unix-сек начала архива (null — эфир), programEnd — конец передачи.
   */
  playChannel(ch: Channel, groupKey: string | null = null, archive: number | null = null, programEnd = 0, reload = false, unlocked = false) {
    const self = this;
    const cat = this.catalog;
    if (!unlocked && ch !== this.state.channel && cat && cat.isLocked(ch) && !this.sessionUnlocked(ch) && !this.pinPassed) {
      clearTimeout(this.switchTimer);
      this.pending = null;
      const dir = this.switchDirection;
      this.askPin(ch.title(), function () {
        if (!Prefs.pinEveryTime) { self.unlockedKeys[ch.key] = true; self.unlockedKeys['g:' + ch.groupKey] = true; }
        self.playChannel(ch, groupKey, archive, programEnd, reload, true);
      }, function () {
        const skip = dir !== 0 ? self.nextOpen(ch, groupKey, dir) : null;
        if (skip) self.playChannel(skip, groupKey);
        else if (!self.hasVideo()) self.openGuide();
        else self.updateInfo();
      });
      return;
    }
    clearTimeout(this.switchTimer);
    this.pending = null;
    if (ch !== this.state.channel) {
      const was = this.pinPassed;
      this.pinPassed = !!cat && cat.isLocked(ch) && (unlocked || this.pinPassed || this.sessionUnlocked(ch));
      if (this.pinPassed && !was) {
        this.beforeLocked = this.state.channel && cat && !cat.isLocked(this.state.channel) ? this.state.channel : null;
        this.beforeLockedGroup = this.state.groupKey;
        this.historyBeforeLocked = cat ? cat.history.slice() : null;
      }
      if (!this.pinPassed) { this.beforeLocked = null; this.historyBeforeLocked = null; }
    }
    this.stopSeekHold();
    this.seek = null;
    clearTimeout(this.seekTimer);
    this.pauseInfo = null;
    this.watch = null;
    clearTimeout(this.retryTimer);
    const gk = this.groupKeyFor(ch, groupKey);
    if (ch === this.state.channel && archive === null && this.state.archive === null && !reload && !this.state.error) {
      this.state.groupKey = gk;
      this.closeGuide(true);
      this.showInfo();
      return;
    }
    let url: string;
    let a: Archive | null = null;
    if (archive !== null && ch.hasArchive) {
      const tpl = CatchupUrl.template(ch.url, ch.catchupType || '', ch.catchupSource);
      if (tpl === null) { this.toast.show(str('the_channel_has_no_archive')); return; }
      const now = Clock.now();
      const start = archive;
      let dur = Math.max(60, Math.min(now - start, 6 * 3600));
      if (programEnd > start) dur = Math.max(dur, Math.min(programEnd, now) - start);
      // Flussonic HLS, передача моложе 6 ч: archive-START-now.m3u8 (EVENT, дописывается до «сейчас»);
      // «?event=true» балансировщики провайдеров отбрасывают. hls.js начинает с начала окна (startPosition 0),
      // onReady проверяет по PROGRAM-DATE-TIME.
      const ready = CatchupUrl.flussonicHls(ch.catchupType || '', tpl) && now - start < 6 * 3600 ? CatchupUrl.flussonicNow(tpl) : tpl;
      url = CatchupUrl.prepare(ready, start, dur, now);
      a = { start: start, base: null, timeshift: false, continued: false, pdt: false };
      console.log('archive', ch.name, url);
    } else url = CatchupUrl.prepare(ch.url, null, 0, Clock.now());

    if (this.state.channel !== ch) {
      if (cat) cat.addHistory(ch);
      clearTimeout(this.scoreTimer);
      this.scoreTimer = window.setTimeout(function () { if (self.state.channel === ch && self.catalog) self.catalog.addScore(ch); }, ADAPTIVE_AFTER);
      this.nativeFallback = Prefs.playFix(ch.key) === 1;
      this.autoHlsFallback = false;
      this.viaProxy = false;
    }
    this.state.channel = ch;
    this.state.groupKey = gk;
    this.state.archive = a;
    this.state.height = 0;
    this.state.error = false;
    this.forceHls = false;
    this.lastUrl = url;
    if (this.playlist) Prefs.saveLast(this.playlist.id, ch.key, gk || '');
    this.startStream();
    this.closeGuide(true);
    this.showInfo();
  }

  /** Запустить lastUrl: через прокси, если нужны заголовки канала или прямой не прошёл (CORS) */
  private startStream() {
    const ch = this.state.channel;
    if (!ch) return;
    const h = ch.headers();
    let url = this.lastUrl;
    if (this.viaProxy || Net.wantProxy(h)) url = Net.proxyUrl(url, h);
    const native = useNativeHls(Prefs.hlsEngine, this.state.archive !== null,
      this.nativeFallback, this.autoHlsFallback);
    this.streamStartedAt = Date.now();
    console.log('play', ch.name, this.state.archive ? 'archive' : 'live', native ? 'native' : 'hlsjs', url.slice(0, 160));
    this.playback.play(url, {
      fromStart: this.state.archive !== null,
      native: native,
      // тип — по исходной ссылке: у ссылки через прокси (/p?u=…) расширения нет
      forceHls: this.forceHls || isHlsUrl(this.lastUrl),
    });
  }

  private nextOpen(from: Channel, groupKey: string | null, dir: number): Channel | null {
    const cat = this.catalog;
    if (!cat) return null;
    const g = cat.group(groupKey) || cat.groupOf(from, null);
    const list = g.channels;
    const n = list.length;
    const i = list.indexOf(from);
    if (!n || i < 0) return null;
    for (let k = 1; k < n; k++) {
      const c = list[((i + dir * k) % n + n) % n];
      if (c === this.state.channel || !cat.isLocked(c) || this.sessionUnlocked(c)) return c;
    }
    return null;
  }

  private sessionUnlocked(ch: Channel): boolean {
    const cat = this.catalog;
    if (!cat) return false;
    const chOk = !cat.isChannelLocked(ch) || !!this.unlockedKeys[ch.key];
    const gOk = !cat.isGroupLocked(ch.groupKey) || !!this.unlockedKeys['g:' + ch.groupKey];
    return chOk && gOk;
  }

  askPin(title: string, ok: () => void, cancel?: () => void) {
    const self = this;
    let layer: PinLayer | null = null;
    layer = new PinLayer(this.ui, false, title, function () { self.remove(layer!); ok(); }, function () { self.remove(layer!); if (cancel) cancel(); });
    this.push(layer);
  }

  /** Задать PIN (если ещё нет) и затем ok */
  ensurePin(ok: () => void) {
    if (Prefs.pin) { ok(); return; }
    const self = this;
    let layer: PinLayer | null = null;
    layer = new PinLayer(this.ui, true, str('new_pin'), function (pin) {
      self.remove(layer!);
      Prefs.pin = pin;
      self.toast.show(str('pin_set_change_or_remove_it_in'));
      ok();
    }, function () { self.remove(layer!); });
    this.push(layer);
  }

  playArchive(ch: Channel, start0: number, programEnd = 0) {
    if (!ch.hasArchive) { this.toast.show(str('the_channel_has_no_archive')); return; }
    const start = Math.max(start0, Clock.now() - ch.archiveDays * 86400);
    const gk = this.state.channel === ch ? this.state.groupKey : null;
    if (start >= Clock.now() - 30) { this.playChannel(ch, gk); return; }
    this.playChannel(ch, gk, start, programEnd);
  }

  /** Первые данные: привязать позицию плеера к началу ссылки архива */
  private onReady() {
    if (this.streamStartedAt) {
      console.log('play ready', Date.now() - this.streamStartedAt, 'ms', this.playback.engine);
      this.streamStartedAt = 0;
    }
    const a = this.state.archive;
    if (!a || a.base !== null) return;
    const pb = this.playback;
    a.base = pb.positionMs;
    if (a.timeshift) return;
    const now = Clock.now();
    const w = pb.wallClockMs;
    const plausible = w !== null && w / 1000 >= a.start - 86400 && w / 1000 <= now + 120;
    if (!plausible) {
      // без PROGRAM-DATE-TIME «растущий» плейлист — в начало окна (оно и есть начало ссылки)
      if (pb.live && pb.positionMs - pb.windowOffsetMs > 5000) {
        console.log('archive: live playlist without PDT, seek to window start');
        this.watch = null;
        a.base = pb.windowOffsetMs;
        pb.seekTo(0);
      }
      return;
    }
    a.pdt = true;
    const ws = pb.windowStartTimeMs;
    if (ws === null) return;
    const target = a.start * 1000 - ws;
    // у «скользящего» окна со сдвигом (offset) нужный момент — почти у края окна: запас меньше, чем при перемотке
    if (Math.abs(w! / 1000 - a.start) > 8 && target >= 0 && target < pb.windowDurationMs - 2500) {
      console.log('archive: start ' + Math.round(w! / 1000 - a.start) + ' s off, seek to start');
      this.watch = null;
      pb.seekTo(target);
    }
  }

  private onStreamEnded() {
    if (!this.state.archive) {
      if (this.state.channel) this.playChannel(this.state.channel, this.state.groupKey, null, 0, true);
      return;
    }
    const a = this.state.archive;
    if (a.continued) return;
    a.continued = true;
    this.restorePosition(this.position());
  }

  private onStreamError(kind: 'network' | 'media' | 'live', detail: string) {
    const ch = this.state.channel;
    if (!ch) return;
    console.warn('play error', kind, detail, ch.name, this.playback.engine);
    // прямой запрос не прошёл (CORS, заголовки) — через прокси
    if (kind === 'network' && !this.viaProxy && Net.proxyAvailable && Prefs.proxyMode !== 2) {
      this.viaProxy = true;
      this.startStream();
      return;
    }
    // Автоматический режим: если нативный HLS не поддерживает конкретный
    // прямой эфир, один раз пробуем hls.js. Выбор пользователя не меняем.
    if (this.state.archive === null && Prefs.hlsEngine === 2 &&
        this.playback.engine === 'native' && !this.autoHlsFallback &&
        !this.nativeFallback && isHlsUrl(this.lastUrl)) {
      this.autoHlsFallback = true;
      console.warn('play fallback native -> hls.js', kind, detail);
      this.startStream();
      return;
    }
    // hls.js не справился с медиа (звук MP2/AC-3 и т.п.) — встроенный плеер; запоминается за каналом
    if (kind === 'media' && this.playback.engine === 'hls' && !this.nativeFallback) {
      this.nativeFallback = true;
      Prefs.setPlayFix(ch.key, 1);
      this.startStream();
      return;
    }
    if (this.state.archive) {
      const t = Date.now();
      if (t - this.archiveRetry > 15000) { this.archiveRetry = t; this.restorePosition(this.position()); return; }
    }
    this.state.error = true;
    this.buffering.set(false);
    this.updateInfo(true);
    const delay = RETRY[this.retry++];
    if (delay === undefined) return;
    const self = this;
    this.retryTimer = window.setTimeout(function () { if (self.state.channel === ch && self.state.error) self.startStream(); }, delay);
  }

  private restorePosition(pos: number) {
    const ch = this.state.channel;
    if (!ch) return;
    if (ch.hasArchive && pos < Clock.now() - 30) { this.playArchive(ch, pos); return; }
    if (this.state.archive && this.state.archive.timeshift) { this.state.archive = null; this.updateInfo(); return; }
    this.playChannel(ch, this.state.groupKey, null, 0, true);
  }

  private checkArchiveLive() {
    const a = this.state.archive;
    if (!a || a.base === null || this.seek) return;
    if (this.position() >= Clock.now() - 3) {
      console.log('archive: caught up with live');
      this.state.archive = null;
    }
  }

  /** Сторож архива: поток прыгнул вперёд или стоит 15 с — новая ссылка с позиции */
  private watchArchive() {
    const a = this.state.archive;
    if (!a || this.seek || a.base === null) return;
    const pos = this.playback.positionMs;
    const t = Date.now();
    const w = this.watch;
    if (!w || this.playback.paused) { this.watch = { pos: pos, at: t, moved: t, shown: this.position() }; return; }
    const dWall = t - w.at, dPos = pos - w.pos;
    if (dPos > dWall + 5000) {
      const expected = w.shown + Math.floor(dWall / 1000);
      console.log('stream jumped, restore', expected);
      this.watch = null;
      this.restorePosition(expected);
      return;
    }
    w.pos = pos; w.at = t; w.shown = this.position();
    if (dPos !== 0) w.moved = t;
    else if (t - w.moved > 15000 && t - this.archiveRetry > 15000) {
      this.archiveRetry = t;
      w.moved = t;
      console.log('archive stalled, continue from', this.position());
      this.onStreamEnded();
    }
  }

  // ================================================================ пауза, клавиши медиа

  togglePause() {
    if (!this.hasVideo()) return;
    const pb = this.playback;
    if (!pb.paused) {
      this.pauseInfo = this.position();
      pb.pause();
    } else {
      const p = this.pauseInfo;
      this.pauseInfo = null;
      if (p !== null && !this.state.archive && Clock.now() - p > 3) {
        this.state.archive = { start: p, base: pb.positionMs, timeshift: true, continued: false, pdt: false };
      }
      this.watch = null;
      pb.resume();
    }
    this.updateInfo();
    this.info.show(this.info.sticky ? 0 : Prefs.infoHide);
  }

  private mediaKey(name: string) {
    const self = this;
    if (name === 'guide') { this.openGuide(); return; }
    if (name === 'search' || name === 'blue') { this.openSearch(); return; }
    if (name === 'history' || name === 'green') { this.openHistory(); return; }
    if (name === 'yellow') { this.openReminders(this.state.channel); return; }
    if (!this.hasVideo()) return;
    switch (name) {
      case 'playpause': this.togglePause(); break;
      case 'play': if (this.playback.paused) this.togglePause(); break;
      case 'pause': if (!this.playback.paused) this.togglePause(); break;
      case 'forward': this.seekStep(1); break;
      case 'rewind': this.seekStep(-1); break;
      case 'stop':
        if (this.state.archive && this.state.channel) this.playChannel(this.state.channel, this.state.groupKey);
        else this.exitRequest();
        return;
      case 'info': if (this.info.visible) this.info.hide(); else this.showInfo(true); return;
      case 'menu': case 'red': if (this.state.channel) this.openMenu(this.state.channel); return;
      default: return;
    }
    setTimeout(function () { self.showInfo(); }, 50);
  }

  // ================================================================ ←/→, цифры

  private switchRelative(dir: number) {
    const base = this.pending || this.state.channel;
    if (!base) { this.openGuide(); return; }
    const cat = this.catalog;
    if (!cat) return;
    const g = cat.group(this.state.groupKey) || cat.groupOf(base, null);
    const list = g.channels;
    const n = list.length;
    if (!n) return;
    const i = Math.max(0, list.indexOf(base));
    const ni = (i + dir + n) % n;
    const next = list[ni];
    this.pending = next;
    this.pendingDir = dir;
    this.switchGroup = g.key;
    this.updateInfo();
    this.info.show(Prefs.infoHide);
    this.carousel.show(list, ni, this.info.el);
    clearTimeout(this.switchTimer);
    const self = this;
    this.switchTimer = window.setTimeout(function () {
      const nx = self.pending;
      if (!nx) return;
      const gk = self.switchGroup;
      self.pending = null;
      self.switchDirection = self.pendingDir;
      self.playChannel(nx, gk);
      self.switchDirection = 0;
      setTimeout(function () { self.carousel.hide(); }, 1500);
    }, SWITCH_DELAY);
  }

  digit(d: number) {
    const cat = this.catalog;
    if (!cat) return;
    this.numBuf = (this.numBuf + d).slice(-4);
    this.osd.show(this.numBuf, cat);
    clearTimeout(this.numTimer);
    const self = this;
    if (this.top() === this.guide) {
      const c = cat.byNum(parseInt(this.numBuf, 10));
      if (c) this.guide.focusNumber(c.num);
      this.numTimer = window.setTimeout(function () { self.cancelNumber(); }, OSD_NUMBER);
      return;
    }
    if (this.top() !== this.playerLayer) return;
    const maxNum = cat.channels.length ? cat.channels[cat.channels.length - 1].num : 0;
    this.numTimer = window.setTimeout(function () { self.applyNumber(); }, parseInt(this.numBuf + '0', 10) > Math.max(maxNum, cat.channels.length) ? 300 : OSD_NUMBER);
  }

  numberPending() { return this.numBuf !== ''; }

  applyNumber() {
    const cat = this.catalog;
    const ch = cat ? cat.byNum(parseInt(this.numBuf, 10) || 0) : null;
    const inGuide = this.top() === this.guide;
    this.cancelNumber();
    if (ch && !inGuide) this.playChannel(ch);
    else if (ch) this.guide.focusNumber(ch.num);
  }

  cancelNumber() {
    clearTimeout(this.numTimer);
    this.numBuf = '';
    this.osd.hide();
  }

  // ================================================================ перемотка

  private seekStep(dir: number) {
    const ch = this.state.channel;
    if (!ch) return;
    if (!ch.hasArchive) { this.showInfo(); return; }
    const t = Date.now();
    const s = this.seek || { target: this.position(), dir: 0, last: 0, released: true, holdStart: 0, holdTick: 0, holding: false };
    const repeat = s.dir === dir && !s.released && t - s.last < SEEK_GAP;
    s.last = t;
    s.dir = dir;
    s.released = false;
    this.seek = s;
    clearTimeout(this.seekTimer);
    const self = this;
    if (!repeat) {
      this.stopSeekHold();
      this.moveSeek(dir * SEEK_TAP);
      this.seekTimer = window.setTimeout(function () { self.applySeek(); }, SEEK_DELAY);
    } else if (!s.holding) {
      s.holding = true;
      s.holdStart = t;
      s.holdTick = t;
      const tick = function () {
        const sk = self.seek;
        if (!sk || !sk.holding) return;
        const tt = Date.now();
        if (tt - sk.last > SEEK_GAP) { self.seekKeyUp(); return; }
        const rate = Math.min(SEEK_MAX, SEEK_START + SEEK_GROW * (tt - sk.holdStart) / 1000);
        self.moveSeek(Math.round(sk.dir * rate * (tt - sk.holdTick) / 1000));
        sk.holdTick = tt;
        self.seekTickTimer = window.setTimeout(tick, 100);
      };
      this.seekTickTimer = window.setTimeout(tick, 100);
    }
  }

  private moveSeek(delta: number) {
    const ch = this.state.channel, s = this.seek;
    if (!ch || !s) return;
    const now = Clock.now();
    s.target = Math.max(now - ch.archiveDays * 86400, Math.min(now, s.target + delta));
    this.updateInfo();
    this.info.show(Prefs.infoHide);
  }

  private stopSeekHold() {
    clearTimeout(this.seekTickTimer);
    if (this.seek) this.seek.holding = false;
  }

  private seekKeyUp() {
    const s = this.seek;
    if (!s) return;
    s.released = true;
    if (!s.holding) return;
    this.stopSeekHold();
    clearTimeout(this.seekTimer);
    const self = this;
    this.seekTimer = window.setTimeout(function () { self.applySeek(); }, SEEK_DELAY);
  }

  private applySeek() {
    const s = this.seek;
    this.stopSeekHold();
    this.seek = null;
    clearTimeout(this.seekTimer);
    if (!s) return;
    const ch = this.state.channel;
    if (!ch) return;
    if (s.target >= Clock.now() - 30) {
      if (this.state.archive) this.playChannel(ch, this.state.groupKey);
      this.updateInfo();
      return;
    }
    const a = this.state.archive;
    const pb = this.playback;
    if (a && a.base !== null && pb.seekable) {
      const ws = pb.windowStartTimeMs;
      const target = a.pdt && ws !== null ? s.target * 1000 - ws : (s.target - a.start) * 1000 + a.base - pb.windowOffsetMs;
      if (target >= 0 && target < pb.windowDurationMs - 5000) {
        this.watch = null;
        pb.seekTo(target);
        this.updateInfo();
        return;
      }
    }
    // эфир с окном DVR (пауза эфира): внутри окна — перемотка
    if (!a && pb.seekable && pb.live) {
      const back = (Clock.now() - s.target) * 1000;
      const end = pb.windowOffsetMs + pb.windowDurationMs;
      const t = end - back - pb.windowOffsetMs;
      if (t > 0 && ch.archiveDays === 0) {
        this.state.archive = { start: s.target, base: end - back, timeshift: true, continued: false, pdt: false };
        pb.seekTo(t);
        this.updateInfo();
        return;
      }
    }
    this.playArchive(ch, s.target);
  }

  private cancelSeek() {
    clearTimeout(this.seekTimer);
    this.stopSeekHold();
    this.seek = null;
    this.updateInfo();
  }

  // ================================================================ инфопанель

  showInfo(sticky = false) {
    this.updateInfo();
    this.info.show(sticky ? 0 : Prefs.infoHide);
  }

  updateInfo(show = false) {
    const ch = this.pending || this.state.channel;
    if (!ch) return;
    const same = ch === this.state.channel;
    const pos = same ? this.position() : Clock.now();
    const sk = same && this.seek ? this.seek.target : null;
    const ref = sk !== null ? sk : pos;
    const p = this.repo.at(ch, ref);
    const next = this.repo.after(ch, p ? p.stop : ref);
    const pb = this.playback;
    this.info.update({
      channel: ch,
      program: p,
      next: next,
      next2: next ? this.repo.after(ch, next.stop) : null,
      archive: same && this.state.archive !== null,
      position: pos,
      ahead: same ? Math.floor(pb.bufferedAheadMs / 1000) : 0,
      seek: sk,
      height: same ? this.state.height : 0,
      paused: same && pb.paused && this.pauseInfo !== null,
      error: same && this.state.error,
      engine: same && pb.engine === 'native' && this.nativeFallback ? 'NAT' : '',
    });
    if (this.info.more && same && this.moreKey !== ch.key + ':' + (p ? p.start : 0)) this.expandInfo();
    if (show) this.info.show(Prefs.infoHide);
  }

  private expandInfo() {
    const ch = this.state.channel;
    if (!ch) return;
    const pos = this.position();
    const p = this.repo.at(ch, pos);
    this.moreKey = ch.key + ':' + (p ? p.start : 0);
    const from = p ? p.stop : pos;
    const upcoming = this.repo.upcoming(ch, from, 4);
    if (!p) { this.info.setMore(ch.group, '', '', ch, upcoming); return; }
    const tags = [Fmt.dayTimeRange(p.start, p.stop), p.category, p.subTitle].filter(function (s) { return !!s; }).join(' · ');
    this.info.setMore(tags, p.desc, p.icon, ch, upcoming);
  }

  // ================================================================ гид, окна

  openGuide(toGrid = false) {
    this.info.hide();
    if (!this.hasLayer(this.guide)) {
      this.removeAllBut([]);
      this.push(this.guide);
    }
    this.guide.open(this.state.channel, this.state.groupKey, toGrid);
  }

  /** Закрыть гид. Без видео гид закрывать некуда — это запрос на выход */
  closeGuide(silent = false) {
    if (!this.hasLayer(this.guide)) return;
    if (!silent && !this.hasVideo()) { this.exitRequest(); return; }
    this.removeAllBut([this.guide]);
    this.remove(this.guide);
  }

  openHistory() {
    const cat = this.catalog;
    if (!cat) return;
    const now = Clock.now();
    this.info.hide();
    const self = this;
    let layer: ListLayer | null = null;
    const items: ListItem[] = cat.recent(this.state.channel).map(function (ch) {
      const p = self.repo.at(ch, now);
      return {
        label: ch.title(), sub: p ? p.title : '', channel: ch, progress: p ? Fmt.progress(p.start, p.stop, now) : undefined,
        action: function () { self.remove(layer!); self.playChannel(ch); },
        long: function () { self.openMenu(ch); },
      };
    });
    layer = new ListLayer(this.ui, str('recent_channels'), items, function () { self.remove(layer!); }, { empty: str('history_is_empty'), rowEm: 4.6, width: 50 });
    this.push(layer);
  }

  openSchedule(ch: Channel | null, view: number) {
    this.info.hide();
    const self = this;
    let layer: ScheduleLayer | null = null;
    layer = new ScheduleLayer(this, ch, ch ? view : 1, function () { self.remove(layer!); });
    this.push(layer);
  }

  openReminders(ch: Channel | null) { this.openSchedule(ch, 1); }

  /** Журнал (Настройки → Данные) */
  openLog() {
    const self = this;
    let layer: LogLayer | null = null;
    layer = new LogLayer(this.ui, function () { self.remove(layer!); });
    this.push(layer);
  }

  openHelp() {
    const self = this;
    let layer: HelpLayer | null = null;
    layer = new HelpLayer(this.ui, function () { self.remove(layer!); });
    this.push(layer);
  }

  openSearch(query = '') {
    const cat = this.catalog;
    if (!cat) return;
    this.info.hide();
    const self = this;
    let layer: SearchLayer | null = null;
    layer = new SearchLayer(this, query, function () { self.remove(layer!); });
    this.push(layer);
  }

  openSettings() {
    this.info.hide();
    const self = this;
    let layer: SettingsLayer | null = null;
    layer = new SettingsLayer(this, function (changed) {
      self.remove(layer!);
      if (changed) self.afterSettings();
    });
    this.push(layer);
  }

  /** Вернулись из настроек: плейлисты, скрытое, порядок, язык могли поменяться */
  private afterSettings() {
    const self = this;
    this.repo.loadPlaylists().then(function (list) {
      if (!list.length) { self.playback.stop(); self.state.channel = null; self.catalog = null; self.playlist = null; self.wizard(); return; }
      const cur = self.playlist ? self.repo.playlist(self.playlist.id) : null;
      if (!cur) { self.switchPlaylist(list[0]); return; }
      self.playlist = cur;
      if (!self.catalog || cur.channelsCount === 0) { self.open(cur); return; }
      self.reloadCatalog();
      self.relabel();
    });
  }

  reloadCatalog() {
    const p = this.playlist;
    if (!p) return;
    const self = this;
    this.repo.loadCatalog(p).then(function (cat) {
      const cur = self.state.channel;
      self.catalog = cat;
      if (cur) { const c = cat.byKey[cur.key]; if (c) self.state.channel = c; }
      if (self.hasLayer(self.guide)) self.guide.reload();
    });
  }

  switchPlaylist(p: Playlist) {
    this.removeAllBut([]);
    this.playback.stop();
    this.state.channel = null;
    this.state.archive = null;
    this.catalog = null;
    this.open(p);
  }

  /** Карточка передачи: кнопки по времени и архиву канала */
  openDetails(ch: Channel, cell: Cell) {
    const now = Clock.now();
    const buttons: [string, string][] = [];
    const inArch = ch.hasArchive && cell.start >= now - ch.archiveDays * 86400;
    if (cell.end <= now) { if (inArch) buttons.push([str('watch'), 'archive']); }
    else if (cell.start <= now) {
      if (ch.hasArchive) buttons.push([str('watch_from_start'), 'archive']);
      if (this.state.channel === ch && this.state.archive) buttons.push([str('watch_live'), 'live']);
      else if (this.state.channel !== ch) buttons.push([str('watch'), 'live']);
    } else if (cell.program) {
      buttons.push(Reminders.has(ch, cell.start) ? [str('delete_reminder'), 'unremind'] : [str('remind_2'), 'remind']);
    }
    const p = cell.program;
    const self = this;
    const kicker = [p && p.category ? p.category : '', cell.start <= now && now < cell.end ? str('on_air_now') : ''].filter(function (s) { return !!s; }).join(' · ');
    let layer: DetailsLayer | null = null;
    layer = new DetailsLayer(this.ui, ch, Fmt.dayTimeRange(cell.start, cell.end) + (kicker ? ' · ' + kicker : ''), cell.label(),
      [p ? p.subTitle : '', p ? p.desc : ''].filter(function (s) { return !!s; }).join('\n\n'),
      buttons.map(function (b) { return b[0]; }),
      function (i) {
        const a = buttons[i][1];
        if (a === 'archive') { self.removeAllBut([self.guide]); self.playArchive(ch, cell.start, cell.end); }
        else if (a === 'live') { self.removeAllBut([self.guide]); self.playChannel(ch); }
        else if (a === 'remind') {
          self.remove(layer!);
          if (self.playlist && cell.program) Reminders.add(self.playlist, ch, cell.program);
          self.toast.show(str('i_will_remind') + (Prefs.remindBefore > 0 ? str('x_min_before_the_start', Prefs.remindBefore) : str('when_the_programme_starts')));
          self.guide.redraw();
        } else if (a === 'unremind') {
          self.remove(layer!);
          Reminders.remove(Reminders.keyOf(ch.key, cell.start));
          self.guide.redraw();
        }
      }, function () { self.remove(layer!); });
    this.push(layer);
  }

  // ================================================================ напоминания

  private notifyReminder(r: Reminder) {
    if (this.reminderLayer) { this.reminderLayer.add(r); return; }
    const self = this;
    const layer = new ReminderLayer(this.ui, function (rem) { return self.channelOfReminder(rem); }, function (rem, a) { self.reminderAction(rem, a); }, function () {
      self.remove(layer);
      self.reminderLayer = null;
    });
    this.reminderLayer = layer;
    layer.add(r);
    this.push(layer);
  }

  private channelOfReminder(r: Reminder): Channel {
    const cat = this.catalog;
    if (cat && this.playlist && this.playlist.id === r.playlistId && cat.byKey[r.chKey]) return cat.byKey[r.chKey];
    return Channel.stub(r.chName, r.chNum, r.logo);
  }

  private reminderAction(r: Reminder, a: string) {
    const l = this.reminderLayer;
    if (a === 'closeAll') {
      if (l) { const all = l.items.slice(); for (let i = 0; i < all.length; i++) { Reminders.release(all[i].id); } }
      if (l) { this.remove(l); this.reminderLayer = null; }
      return;
    }
    if (l) l.drop(r.id);
    if (a === 'snooze') Reminders.snooze(r.id);
    else if (a === 'later') Reminders.keepMissed(r.id);
    else if (a === 'dismiss') Reminders.release(r.id);
    else if (a === 'close' || a === 'delete') Reminders.remove(r.id);
    else if (a === 'watch' || a === 'archive') { Reminders.remove(r.id); this.launch(r); }
  }

  /** Включить передачу напоминания: идёт — эфир, закончилась — из архива; другой плейлист — сменить */
  launch(r: Reminder) {
    const p = this.repo.playlist(r.playlistId);
    if (!p) { this.toast.show(str('the_playlist_was_deleted')); return; }
    if (!this.playlist || this.playlist.id !== p.id) {
      this.switchPlaylist(p);
      const self = this;
      const wait = function () {
        if (self.catalog && self.playlist === p) { self.launch(r); return; }
        setTimeout(wait, 200);
      };
      setTimeout(wait, 200);
      return;
    }
    const cat = this.catalog;
    const ch = cat ? cat.byKey[r.chKey] : null;
    if (!ch) { this.toast.show(str('the_channel_is_no_longer_in_the')); return; }
    this.removeAllBut([this.guide, this.reminderLayer as any]);
    if (isMissed(r, Clock.now())) this.playArchive(ch, r.start, r.stop); else this.playChannel(ch);
  }

  // ================================================================ меню канала

  closeMenu() {
    if (this.menu) this.remove(this.menu);
    this.menu = null;
  }

  openMenu(ch: Channel, fromGuide = false) {
    this.closeMenu();
    const self = this;
    this.menu = new MenuLayer(this.ui, function () { return self.menuPage(ch, fromGuide); }, function () { self.closeMenu(); });
    this.push(this.menu);
  }

  guideModeName(m: number): string {
    return str(m === 1 ? 'view_channels_programme' : m === 2 ? 'view_categories_channels' : m === 3 ? 'view_channels' : 'tv_guide');
  }

  onOff(v: boolean) { return str(v ? 'on' : 'off'); }

  private menuPage(ch: Channel, fromGuide: boolean): MenuPage {
    const cat = this.catalog;
    if (!cat) return { title: ch.title(), sections: [] };
    const p = this.repo.at(ch, Clock.now());
    const current = this.state.channel === ch;
    const fav = cat.isFavorite(ch);
    const self = this;
    const act = function (a: string) { return function () { self.menuAction(ch, a); }; };

    const quick: MenuTile[] = [];
    if (fromGuide) quick.push({ icon: 'play', title: str('watch'), run: act('play') });
    if (current && this.state.archive) quick.push({ icon: 'live', title: str('tile_live'), run: act('live') });
    if (ch.hasArchive && p) quick.push({ icon: 'restart', title: str('tile_restart'), run: act('restart') });
    quick.push({ icon: 'list', title: str('hint_programme'), run: act('archive') });
    quick.push({ icon: 'star', title: str(fav ? 'tile_fav_remove' : 'tile_fav_add'), run: act('fav') });
    quick.push({ icon: 'hist', title: str('hint_recent'), run: act('history') });

    const viewing: MenuItem[] = [];
    quick.slice(4).forEach(function (t) { viewing.push({ title: t.title, run: t.run }); });
    if (p) viewing.push({ title: str('about'), run: act('about') });
    if (current) {
      const tr = this.playback.tracks();
      const audio = tr.filter(function (t) { return t.kind === 'audio'; });
      const text = tr.filter(function (t) { return t.kind === 'text'; });
      if (audio.length > 1 || text.length) {
        const sel = audio.find(function (t) { return t.selected; });
        viewing.push({ title: str('audio_and_subtitles'), value: sel ? sel.label : '', sub: function () { return self.tracksPage(ch); } });
      }
      if (Prefs.playFix(ch.key) > 0) viewing.push({ title: str('fix_reset'), run: function () { Prefs.setPlayFix(ch.key, 0); self.nativeFallback = false; self.startStream(); } });
      viewing.push({ title: str('picture_format'), value: this.aspectName(), keep: true, run: function () { Prefs.aspect = (Prefs.aspect + 1) % 3; self.playback.setAspect(Prefs.aspect); } });
    }
    viewing.push({ title: str('sleep_timer'), value: this.sleepValue(), keep: true, run: function () { self.cycleSleep(); } });

    const channel: MenuItem[] = [];
    if (fav && this.guide.groupKey() === FAV_KEY && this.hasLayer(this.guide)) {
      channel.push({ title: str('move_up'), keep: true, run: act('fav_up') });
      channel.push({ title: str('move_down'), keep: true, run: act('fav_down') });
    }
    channel.push({ title: str('hide_channel'), run: act('hide') });
    const pinOn = Prefs.pin !== '';
    const chLocked = pinOn && cat.isChannelLocked(ch);
    channel.push({ title: str(chLocked ? 'unlock_channel' : 'lock_channel'), value: str('by_pin'), run: act(chLocked ? 'unlock' : 'lock') });
    if (ch.group) {
      channel.push({
        title: str('category_x', ch.group), sub: function () {
          const gLocked = pinOn && cat.isGroupLocked(ch.groupKey);
          return {
            title: ch.group, subtitle: str('category'), sections: [{
              title: '', items: [
                { title: str('hide_category'), run: act('hide_group') },
                { title: str(gLocked ? 'unlock_category' : 'lock_category'), value: str('by_pin'), run: act(gLocked ? 'unlock_group' : 'lock_group') },
              ],
            }],
          };
        },
      });
    }

    const app: MenuItem[] = [];
    app.push({ title: str('search'), run: act('search') });
    if (!fromGuide) app.push({ title: str('tv_guide'), run: act('guide') });
    const rc = Reminders.count();
    app.push({ title: str('reminders'), value: rc > 0 ? String(rc) : '', run: act('reminders') });
    app.push({
      title: str('channel_list'), sub: function () {
        const l: MenuItem[] = [
          { title: str('view'), value: self.guideModeName(Prefs.guideMode), keep: true, run: act('view') },
          { title: str('adaptive_sorting'), value: self.onOff(Prefs.adaptiveSort), keep: true, run: act('adaptive') },
        ];
        if (cat.hiddenCount() > 0) l.push({ title: str('hidden_2'), value: String(cat.hiddenCount()), run: act('hidden') });
        return { title: str('channel_list'), sections: [{ title: '', items: l }] };
      },
    });
    app.push({
      title: str('playlist_and_programme'), value: this.playlist ? this.playlist.name : '', sub: function () {
        const l: MenuItem[] = [];
        if (self.repo.playlists().length > 1) l.push({ title: str('playlist'), value: self.playlist ? self.playlist.name : '', run: act('playlist') });
        l.push({ title: str('reload_playlist'), run: act('reload') });
        l.push({ title: str('reload_programme'), run: act('reload_epg') });
        return { title: str('playlist_and_programme'), subtitle: self.playlist ? self.playlist.name : '', sections: [{ title: '', items: l }] };
      },
    });
    app.push({ title: str('controls'), run: act('help') });
    app.push({ title: str('settings'), run: act('settings') });

    return {
      title: ch.title(), subtitle: p ? p.title + ' · ' + Fmt.timeRange(p.start, p.stop) : '', channel: ch, tiles: quick.slice(0, 4),
      sections: [
        { title: str('viewing'), items: viewing },
        { title: str('channel'), items: channel },
        { title: str('app'), items: app },
      ],
    };
  }

  private tracksPage(ch: Channel): MenuPage {
    const tr = this.playback.tracks();
    const audio = tr.filter(function (t) { return t.kind === 'audio'; });
    const text = tr.filter(function (t) { return t.kind === 'text'; });
    const self = this;
    const mark = function (on: boolean) { return on ? str('selected_mark') : ''; };
    const pick = function (kind: 'audio' | 'text', t: any) {
      self.playback.selectTrack(t, kind);
      if (kind === 'audio') Prefs.audioLang = t ? t.lang : ''; else Prefs.subtitleLang = t ? t.lang : '';
      setTimeout(function () { if (self.menu) self.menu.refresh(); }, 400);
    };
    const a: MenuItem[] = audio.map(function (t, i) { return { title: t.label || str('track_x', i + 1), value: mark(t.selected), keep: true, run: function () { pick('audio', t); } }; });
    const off = !text.some(function (t) { return t.selected; });
    const s: MenuItem[] = [{ title: str('off'), value: mark(off), keep: true, run: function () { pick('text', null); } }];
    text.forEach(function (t, i) { s.push({ title: t.label || str('track_x', i + 1), value: mark(t.selected), keep: true, run: function () { pick('text', t); } }); });
    return {
      title: str('audio_and_subtitles'), subtitle: ch.title(), sections: [
        { title: str('audio'), items: a.length ? a : [{ title: str('no_tracks'), enabled: false }] },
        { title: str('subtitles'), items: text.length ? s : [{ title: str('no_tracks'), enabled: false }] },
      ],
    };
  }

  private aspectName(): string { return str(Prefs.aspect === 1 ? 'format_stretch' : Prefs.aspect === 2 ? 'format_zoom' : 'auto'); }

  private sleepValue(): string {
    if (!this.sleepAt) return str('off');
    return str('x_min', Math.ceil((this.sleepAt - Date.now()) / 60000));
  }

  private cycleSleep() {
    const left = this.sleepAt ? Math.ceil((this.sleepAt - Date.now()) / 60000) : 0;
    let next = 0;
    for (let i = 0; i < SLEEP_STEPS.length; i++) if (SLEEP_STEPS[i] > left) { next = SLEEP_STEPS[i]; break; }
    for (let i = 0; i < this.sleepTimers.length; i++) clearTimeout(this.sleepTimers[i]);
    this.sleepTimers = [];
    this.sleepAt = 0;
    if (!next) return;
    this.sleepAt = Date.now() + next * 60000;
    const self = this;
    this.sleepTimers.push(window.setTimeout(function () { self.toast.show(str('sleep_timer_in_a_minute')); }, (next - 1) * 60000));
    this.sleepTimers.push(window.setTimeout(function () { self.sleepAt = 0; self.playback.stop(); Platform.exit(); }, next * 60000));
  }

  private menuAction(ch: Channel, a: string) {
    const cat = this.catalog;
    if (!cat) return;
    const self = this;
    const p = this.repo.at(ch, Clock.now());
    switch (a) {
      case 'play': this.playChannel(ch, this.guide.groupKey()); break;
      case 'about': if (p) this.openDetails(ch, new Cell(p.start, p.stop, p)); break;
      case 'restart': if (p) this.playArchive(ch, p.start, p.stop); break;
      case 'archive': this.openSchedule(ch, 0); break;
      case 'live': this.playChannel(ch, this.state.groupKey); break;
      case 'guide': this.openGuide(); break;
      case 'history': this.openHistory(); break;
      case 'search': this.openSearch(); break;
      case 'reminders': this.openReminders(ch); break;
      case 'help': this.openHelp(); break;
      case 'fav': cat.toggleFavorite(ch); this.guide.reload(); break;
      case 'fav_up': cat.moveFavorite(ch, -1); this.guide.reload(); break;
      case 'fav_down': cat.moveFavorite(ch, 1); this.guide.reload(); break;
      case 'hide': this.guide.reloadAfterHide(function (c) { return c.key === ch.key; }, null, function () { cat.hideChannel(ch); }); this.toast.show(str('channel_hidden')); break;
      case 'hide_group': this.guide.reloadAfterHide(function (c) { return c.group === ch.group; }, ch.group, function () { cat.hideGroup(ch.group); }); this.toast.show(str('category_hidden')); break;
      case 'hidden': this.openHidden(); break;
      case 'lock': this.ensurePin(function () { cat.setLocked('channel', ch.key, true); delete self.unlockedKeys[ch.key]; self.guide.redraw(); self.toast.show(str('channel_locked')); }); break;
      case 'lock_group': this.ensurePin(function () { cat.setLocked('group', ch.groupKey, true); delete self.unlockedKeys['g:' + ch.groupKey]; self.guide.redraw(); self.toast.show(str('category_locked')); }); break;
      case 'unlock': this.askPin(str('unlock_channel'), function () { cat.setLocked('channel', ch.key, false); self.guide.redraw(); }); break;
      case 'unlock_group': this.askPin(str('unlock_category'), function () { cat.setLocked('group', ch.groupKey, false); self.guide.redraw(); }); break;
      case 'adaptive': Prefs.adaptiveSort = !Prefs.adaptiveSort; cat.applyView(); this.guide.reload(); break;
      case 'view': Prefs.guideMode = (Prefs.guideMode + 1) % 4; this.guide.setView(Prefs.guideMode); break;
      case 'playlist': this.openPlaylists(); break;
      case 'reload': if (this.playlist) { this.toast.show(str('reloading_playlist')); this.refreshPlaylist(this.playlist, true); } break;
      case 'reload_epg': if (this.playlist) { this.toast.show(str('reloading_programme')); this.repo.refreshEpg(this.playlist, true); } break;
      case 'settings': this.openSettings(); break;
    }
  }

  openHidden() {
    const cat = this.catalog;
    if (!cat) return;
    const self = this;
    let layer: ListLayer | null = null;
    const items: ListItem[] = [];
    Object.keys(cat.hiddenGroups).forEach(function (k) {
      items.push({ label: str('category_2') + cat.hiddenGroups[k], value: str('ok_restore'), action: function () { cat.unhide('group', k); self.guide.reload(); self.remove(layer!); if (cat.hiddenCount() > 0) self.openHidden(); } });
    });
    Object.keys(cat.hiddenChannels).forEach(function (k) {
      items.push({ label: cat.hiddenChannels[k], value: str('ok_restore'), action: function () { cat.unhide('channel', k); self.guide.reload(); self.remove(layer!); if (cat.hiddenCount() > 0) self.openHidden(); } });
    });
    layer = new ListLayer(this.ui, str('hidden_2'), items, function () { self.remove(layer!); }, { empty: str('nothing_is_hidden') });
    this.push(layer);
  }

  openPlaylists() {
    const list = this.repo.playlists();
    const self = this;
    let layer: ListLayer | null = null;
    layer = new ListLayer(this.ui, str('playlist'), list.map(function (p) {
      return {
        label: p.name, value: p.channelsCount > 0 ? plural('channels', p.channelsCount) : p.url,
        action: function () { self.remove(layer!); if (!self.playlist || p.id !== self.playlist.id) self.switchPlaylist(p); },
      };
    }), function () { self.remove(layer!); });
    this.push(layer);
  }

  // ================================================================ раз в секунду

  private tick() {
    this.ticks++;
    this.checkArchiveLive();
    this.watchArchive();
    if (this.info.visible && !this.pending) this.updateInfo();
    if (this.ticks % 30 === 1) Reminders.check();
    if (this.ticks % 60 === 0) this.guide.redraw();
    if (this.ticks % AUTO_REFRESH === 0 && this.playlist && this.catalog && this.catalog.channels.length) {
      const p = this.repo.playlist(this.playlist.id);
      if (p) { if (this.repo.isStale(p)) this.refreshPlaylist(p, false); else this.repo.refreshEpg(p, false); }
    }
  }

  /** Все каналы текущего плейлиста (для поиска) */
  allChannels(): Channel[] {
    const cat = this.catalog;
    if (!cat) return [];
    const g = cat.group(ALL_KEY);
    return g ? g.channels : cat.channels;
  }
}

export { el, inArchive };
