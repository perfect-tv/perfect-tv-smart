import { Clock } from '../core/clock';
import { lang, languages, plural, str } from '../core/lang';
import { Net } from '../core/net';
import { Platform } from '../core/platform';
import { Prefs } from '../core/prefs';
import { Storage2 } from '../core/storage';
import { Db } from '../data/db';
import { SocketDb } from '../data/socketdb';
import { SourceMeta, SRC_ERROR, SRC_LOADING, SRC_READY } from '../data/loaders';
import { EPG_BOTH, EPG_PLAYLIST, EPG_USER_ONLY, Playlist } from '../data/models';
import { Reminders } from '../data/reminders';
import { UserData } from '../data/userdata';
import { Anim, el, setText, toggle } from './dom';
import { Fmt } from './fmt';
import { Layer } from './layer';
import { Logos } from './logos';
import { PinLayer } from './pin';
import { FormLayer, MessageLayer, Scroller } from './popups';
import { QrPlaylistLayer } from './qrplaylist';
import { LicensesLayer, QrLinkLayer } from './about';
import { About } from '../core/about';
import type { Tv } from './tv';
import { U } from './u';
import { hintRow } from './widgets';

interface SItem {
  name: string;
  desc?: string;
  /** Значение справа: строка или выбор из values */
  value?: () => string;
  values?: string[];
  index?: () => number;
  pick?: (i: number) => void;
  action?: () => void;
  note?: boolean;
  section?: boolean;
}
interface Page { title: string; items: () => SItem[]; form?: boolean }

/**
 * Настройки (docs/TZ.md, §11): слева разделы, справа пункты. В разделах ↑/↓ — раздел (страница
 * меняется сразу), → / OK — к пунктам. В пунктах ↑/↓ — пункт, ← / → — значение по кругу, OK —
 * следующее значение или действие, «Назад» — к разделам. Формы — окнами поверх.
 */
export class SettingsLayer implements Layer {
  el: HTMLElement;
  private nav: HTMLElement;
  private navItems: HTMLElement[] = [];
  private pageEl: HTMLElement;
  private head: HTMLElement;
  private scroller: Scroller;
  private section = 0;
  private stack: Page[] = [];
  private items: SItem[] = [];
  private rows: (HTMLElement | null)[] = [];
  private index = 0;
  private inItems = false;
  private changed = false;
  private sources: { [url: string]: SourceMeta } = {};

  constructor(private tv: Tv, private onClose: (changed: boolean) => void) {
    this.el = el('div', 'settings', null, tv.ui);
    this.nav = el('div', 'nav', null, this.el);
    this.pageEl = el('div', 'page', null, this.el);
    this.head = el('div', 'h', '', this.pageEl);
    this.scroller = new Scroller(this.pageEl, U.h - U.px(2.4 + 5) - U.px(3.2), 'rgb(18,19,20)');
    const hints = el('div', 'hints', null, this.el);
    if (Prefs.keyHints) hintRow(hints, [['←  →', str('hint_change')], ['OK', str('hint_select')], [str('key_back'), str('hint_sections')]]);
    this.buildNav();
    this.loadSources();
    this.showSection();
    Anim.show(this.el);
  }

  private titles(): string[] {
    return [str('playlists'), str('viewing'), str('appearance'), str('channel_list'), str('parental_lock'), str('network'), str('data_and_backup'), str('about_app')];
  }

  private buildNav() {
    const n = this.nav;
    while (n.firstChild) n.removeChild(n.firstChild);
    el('div', 'h', str('settings'), n);
    this.navItems = [];
    const t = this.titles();
    const self = this;
    for (let i = 0; i < t.length; i++) {
      const v = el('div', 'it', t[i], n);
      (function (k) { v.addEventListener('click', function () { self.section = k; self.stack = []; self.inItems = true; self.showSection(); }); })(i);
      this.navItems.push(v);
    }
  }

  private loadSources() {
    const self = this;
    Db.all<SourceMeta>('sources').then(function (list) {
      self.sources = {};
      for (let i = 0; i < list.length; i++) self.sources[list[i].url] = list[i];
      if (self.stack.length) self.render(true);
    }, function (e) { console.warn('EPG sources unavailable', e); });
  }

  private sectionPage(i: number): Page {
    const self = this;
    const t = this.titles()[i];
    const f = [
      function () { return self.pagePlaylists(); },
      function () { return self.pageViewing(); },
      function () { return self.pageAppearance(); },
      function () { return self.pageChannels(); },
      function () { return self.pageLock(); },
      function () { return self.pageNetwork(); },
      function () { return self.pageData(); },
      function () { return self.pageAbout(); },
    ][i];
    return { title: t, items: f };
  }

  private showSection() {
    this.stack = [this.sectionPage(this.section)];
    this.index = 0;
    this.render(false);
  }

  private render(keep: boolean) {
    const page = this.stack[this.stack.length - 1];
    setText(this.head, page.title);
    this.items = page.items();
    const inner = this.scroller.inner;
    const oldOff = this.scroller.offset;
    while (inner.firstChild) inner.removeChild(inner.firstChild);
    this.rows = [];
    const self = this;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.note) { el('div', 'note', it.name, inner); this.rows.push(null); continue; }
      if (it.section) { el('div', 'sect', it.name, inner); this.rows.push(null); continue; }
      const r = el('div', 'si', null, inner);
      const tx = el('div', 'tx', null, r);
      el('div', 'nm el', it.name, tx);
      if (it.desc) el('div', 'ds', it.desc, tx);
      let v = '';
      if (it.values && it.index) v = '‹  ' + it.values[it.index()] + '  ›';
      else if (it.value) v = it.value();
      if (v) el('div', 'val', v, r);
      (function (k) {
        r.addEventListener('click', function () { self.inItems = true; self.index = k; self.applyFocus(); self.enter(); });
      })(i);
      this.rows.push(r);
    }
    if (!keep || this.index >= this.items.length || !this.rows[this.index]) {
      this.index = 0;
      while (this.index < this.rows.length && !this.rows[this.index]) this.index++;
    }
    if (keep) this.scroller.scrollTo(oldOff); else this.scroller.scrollTo(0);
    this.applyFocus();
  }

  private applyFocus() {
    for (let i = 0; i < this.navItems.length; i++) {
      toggle(this.navItems[i], 'f', !this.inItems && i === this.section);
      toggle(this.navItems[i], 'a', this.inItems && i === this.section);
    }
    for (let i = 0; i < this.rows.length; i++) { const r = this.rows[i]; if (r) toggle(r, 'f', this.inItems && i === this.index); }
    toggle(this.el, 'form', this.stack.length > 1);
    const r = this.rows[this.index];
    if (this.inItems && r) this.scroller.reveal(r.offsetTop, r.offsetTop + r.offsetHeight, U.px(2));
  }

  private move(d: number) {
    let i = this.index;
    for (;;) {
      i += d;
      if (i < 0 || i >= this.rows.length) return;
      if (this.rows[i]) break;
    }
    this.index = i;
    this.applyFocus();
  }

  key(name: string) {
    if (!this.inItems) {
      const n = this.navItems.length;
      if (name === 'up') { this.section = (this.section - 1 + n) % n; this.showSection(); }
      else if (name === 'down') { this.section = (this.section + 1) % n; this.showSection(); }
      else if (name === 'right') { this.inItems = true; this.applyFocus(); }
      return;
    }
    const it = this.items[this.index];
    if (name === 'up') this.move(-1);
    else if (name === 'down') this.move(1);
    else if (name === 'pgup') for (let k = 0; k < 6; k++) this.move(-1);
    else if (name === 'pgdown') for (let k = 0; k < 6; k++) this.move(1);
    else if ((name === 'left' || name === 'right') && it && it.values && it.index && it.pick) {
      const n = it.values.length;
      this.changed = true;
      it.pick((it.index() + (name === 'left' ? n - 1 : 1)) % n);
      this.render(true);
    } else if (name === 'left') { this.back(); }
  }

  wheel(dy: number) { if (this.inItems) this.move(dy > 0 ? 1 : -1); else this.key(dy > 0 ? 'down' : 'up'); }

  enter() {
    if (!this.inItems) { this.inItems = true; this.applyFocus(); return; }
    const it = this.items[this.index];
    if (!it) return;
    if (it.values && it.index && it.pick) {
      this.changed = true;
      it.pick((it.index() + 1) % it.values.length);
      this.render(true);
      return;
    }
    if (it.action) { this.changed = true; it.action(); }
  }

  back() {
    if (this.stack.length > 1) { this.stack.pop(); this.render(false); return; }
    if (this.inItems) { this.inItems = false; this.applyFocus(); return; }
    this.onClose(this.changed);
  }

  private push(p: Page) { this.stack.push(p); this.inItems = true; this.render(false); }
  private refresh() { this.render(true); }

  // ------------------------------------------------------------ разделы

  private srcStatus(url: string): string {
    const m = this.sources[url];
    if (!m) return str('not_loaded');
    if (m.status === SRC_LOADING) return str('loading');
    if (m.status === SRC_ERROR) return str('error_2') + this.tv.errorText(m.error);
    if (m.status === SRC_READY) return plural('programmes_ago', m.count, Fmt.until(Clock.now() - m.loadedAt));
    return str('not_loaded');
  }

  private pagePlaylists(): SItem[] {
    const self = this;
    const out: SItem[] = [];
    const list = this.tv.repo.playlists();
    list.forEach(function (p) {
      const status = p.error ? str('error_2') + self.tv.errorText(p.error) : p.channelsCount > 0 ? plural('channels', p.channelsCount) : str('not_loaded');
      out.push({ name: p.name, value: function () { return p.id === Prefs.lastPlaylist ? '●' : ''; }, desc: p.url + ' · ' + status, action: function () { self.push(self.playlistPage(p)); } });
    });
    out.push({ name: str('plus_add_playlist'), action: function () { self.editPlaylist(null); } });
    out.push({ name: str('playlist_qr_action'), desc: str('playlist_qr_action_desc'), action: function () { self.addPlaylistByQr(); } });
    return out;
  }

  private playlistPage(p: Playlist): Page {
    const self = this;
    const repo = this.tv.repo;
    return {
      title: p.name, form: true, items: function () {
        const modes = [str('epg_from_playlist'), str('epg_playlist_and_own'), str('epg_own_only')];
        const out: SItem[] = [
          { name: str('name_and_address'), desc: p.url, action: function () { self.editPlaylist(p); } },
          { name: str('programme_epg'), values: modes, index: function () { return p.epgMode === EPG_BOTH ? 1 : p.epgMode === EPG_USER_ONLY ? 2 : 0; }, pick: function (i) { p.epgMode = i === 1 ? EPG_BOTH : i === 2 ? EPG_USER_ONLY : EPG_PLAYLIST; repo.savePlaylist(p); } },
          { name: str('from_the_playlist'), section: true },
        ];
        if (!p.headerEpg.length) out.push({ name: str('the_playlist_has_no_programme_source'), note: true });
        p.headerEpg.forEach(function (u) { out.push({ name: u, desc: self.srcStatus(u), action: function () { repo.refreshEpg(p, true); self.tv.toast.show(str('reloading_programme')); } }); });
        out.push({ name: str('own_sources'), section: true });
        p.userEpg.forEach(function (u, i) {
          out.push({ name: u, desc: self.srcStatus(u), action: function () { self.editEpg(p, i); } });
        });
        out.push({ name: str('plus_add_source'), action: function () { self.editEpg(p, -1); } });
        out.push({ name: str('actions'), section: true });
        out.push({ name: str('reload_playlist'), action: function () { self.tv.toast.show(str('reloading_playlist')); repo.refresh(p, true).then(function (err) { if (err) self.tv.toast.show(self.tv.errorText(err)); self.refresh(); }); } });
        out.push({ name: str('reload_programme'), action: function () { self.tv.toast.show(str('reloading_programme')); repo.refreshEpg(p, true); } });
        if (repo.playlists().length > 1) {
          out.push({ name: str('move_up'), action: function () { repo.movePlaylist(p.id, -1); } });
          out.push({ name: str('move_down'), action: function () { repo.movePlaylist(p.id, 1); } });
          if (!self.tv.playlist || self.tv.playlist.id !== p.id) out.push({ name: str('open_playlist'), action: function () { self.onClose(false); self.tv.switchPlaylist(p); } });
        }
        out.push({ name: str('delete_playlist'), action: function () { self.confirmDelete(p); } });
        return out;
      },
    };
  }

  /** Приём ссылки с телефона через временный HTTP-сервер на самом ТВ. */
  private addPlaylistByQr() {
    const self = this;
    const tv = this.tv;
    let layer: QrPlaylistLayer | null = null;
    layer = new QrPlaylistLayer(tv.ui, function (url, name) {
      const existing = tv.repo.playlists().filter(function (p) { return p.url === url; });
      if (existing.length) {
        tv.toast.show(str('playlist_qr_exists'));
        self.refresh();
        return;
      }
      self.changed = true;
      tv.repo.addPlaylist(name, url).then(function (p) {
        if (!tv.playlist) { self.onClose(false); tv.open(p); return; }
        self.refresh();
        tv.repo.refresh(p, true).then(function () { self.refresh(); });
      }, function () { tv.toast.show(str('playlist_qr_save_error')); });
    }, function () { tv.remove(layer!); });
    tv.push(layer);
  }

  private editPlaylist(p: Playlist | null) {
    const self = this;
    const tv = this.tv;
    let layer: FormLayer | null = null;
    layer = new FormLayer(tv.ui, p ? str('playlist') : str('add_playlist'), [
      { label: str('playlist_address'), value: p ? p.url : '', type: 'url' },
      { label: str('name'), value: p ? p.name : '' },
    ], [str('save'), str('cancel')], function (i, v) {
      if (i === 1) { tv.remove(layer!); return; }
      if (!v[0]) { tv.toast.show(str('enter_the_address')); return; }
      tv.remove(layer!);
      self.changed = true;
      if (p) {
        const urlChanged = p.url !== v[0];
        p.url = v[0];
        p.name = v[1] || p.name;
        if (urlChanged) { p.loadedAt = 0; p.etag = ''; p.lastModified = ''; }
        tv.repo.savePlaylist(p).then(function () { self.refresh(); if (urlChanged) tv.repo.refresh(p, true); });
      } else {
        tv.repo.addPlaylist(v[1] || str('playlist'), v[0]).then(function (np) {
          if (!tv.playlist) { self.onClose(false); tv.open(np); return; }
          self.refresh();
          tv.repo.refresh(np, true).then(function () { self.refresh(); });
        });
      }
    }, function () { tv.remove(layer!); });
    tv.push(layer);
  }

  private editEpg(p: Playlist, i: number) {
    const self = this;
    const tv = this.tv;
    let layer: FormLayer | null = null;
    const labels = i >= 0 ? [str('save'), str('delete'), str('cancel')] : [str('add'), str('cancel')];
    layer = new FormLayer(tv.ui, str('programme_source'), [{ label: str('xmltv_url'), value: i >= 0 ? p.userEpg[i] : '', type: 'url' }], labels, function (k, v) {
      const lab = labels[k];
      tv.remove(layer!);
      if (lab === str('cancel')) return;
      if (lab === str('delete')) p.userEpg.splice(i, 1);
      else if (v[0]) { if (i >= 0) p.userEpg[i] = v[0]; else p.userEpg.push(v[0]); }
      if (p.epgMode === EPG_PLAYLIST && p.userEpg.length && !p.headerEpg.length) p.epgMode = EPG_BOTH;
      tv.repo.savePlaylist(p).then(function () { self.refresh(); tv.repo.refreshEpg(p, false); });
    }, function () { tv.remove(layer!); });
    tv.push(layer);
  }

  private confirmDelete(p: Playlist) {
    const self = this;
    const tv = this.tv;
    let layer: MessageLayer | null = null;
    layer = new MessageLayer(tv.ui, str('delete_playlist'), p.name + '\n' + str('delete_playlist_warning'), [str('delete'), str('cancel')], function (i) {
      tv.remove(layer!);
      if (i !== 0) return;
      tv.repo.deletePlaylist(p.id).then(function () { self.changed = true; self.stack = [self.sectionPage(0)]; self.render(false); });
    }, function () { tv.remove(layer!); });
    tv.push(layer);
  }

  private pageViewing(): SItem[] {
    const days = [1, 2, 3, 4, 5, 7, 10, 14];
    const rem = [0, 1, 2, 3, 4, 5, 10];
    const hide = [3, 5, 7, 10];
    const epg = [6, 12, 24];
    return [
      { name: str('default_archive_depth'), desc: str('if_the_playlist_does_not_set_it'), values: days.map(function (d) { return str('x_d', d); }), index: function () { return Math.max(0, days.indexOf(Prefs.archiveDays)); }, pick: function (i) { Prefs.archiveDays = days[i]; } },
      { name: str('up_key_in_the_player'), values: [str('recent_channels'), str('programme_and_archive')], index: function () { return Prefs.upArchive ? 1 : 0; }, pick: function (i) { Prefs.upArchive = i === 1; } },
      { name: str('hls_engine'), desc: str('hls_engine_sub'), values: [str('hls_engine_hlsjs'), str('hls_engine_native'), str('hls_engine_auto')], index: function () { return Prefs.hlsEngine; }, pick: function (i) { Prefs.hlsEngine = i; } },
      { name: str('remind_about_a_programme'), values: rem.map(function (m) { return m === 0 ? str('when_it_starts') : str('x_min_before', m); }), index: function () { return Math.max(0, rem.indexOf(Prefs.remindBefore)); }, pick: function (i) { Prefs.remindBefore = rem[i]; } },
      { name: str('start_with_the_last_channel'), desc: str('off_the_guide_opens_on_start'), values: [str('off'), str('on')], index: function () { return Prefs.autoplayLast ? 1 : 0; }, pick: function (i) { Prefs.autoplayLast = i === 1; } },
      { name: str('hide_info_panel_after'), values: hide.map(function (s) { return str('x_s', s); }), index: function () { return Math.max(0, hide.indexOf(Prefs.infoHide)); }, pick: function (i) { Prefs.infoHide = hide[i]; } },
      { name: str('reload_programme_every'), values: epg.map(function (h) { return str('x_h', h); }), index: function () { return Math.max(0, epg.indexOf(Prefs.epgRefreshHours)); }, pick: function (i) { Prefs.epgRefreshHours = epg[i]; } },
    ];
  }

  private pageAppearance(): SItem[] {
    const self = this;
    // языки — все переводы из strings/ (core/langs.ts); название пункта — и по-английски, чтобы
    // найти его в незнакомом языке
    const list = languages();
    const langs = [''].concat(list.map(function (l) { return l.code; }));
    return [
      { name: lang() === 'en' ? 'Language' : str('interface_language') + ' / Language', values: [str('system')].concat(list.map(function (l) { return l.name; })), index: function () { return Math.max(0, langs.indexOf(Prefs.language)); }, pick: function (i) { Prefs.language = langs[i]; self.relabelAll(); } },
      { name: str('interface_size'), desc: str('larger_for_a_big_room'), values: [str('size_small'), str('size_normal'), str('size_large')], index: function () { return Prefs.uiScale; }, pick: function (i) { Prefs.uiScale = i; U.init(); self.tv.relabel(); } },
      { name: str('channel_number'), desc: str('without_a_logo_the_number_is_always'), values: [str('hidden'), str('next_to_the_name'), str('badge_on_the_logo')], index: function () { return Prefs.numberMode; }, pick: function (i) { Prefs.numberMode = i; } },
      { name: str('logo_priority'), desc: str('logo_priority_sub'), values: [str('logo_from_playlist'), str('logo_from_programme')], index: function () { return Prefs.logoPriority; }, pick: function (i) { Prefs.logoPriority = i; } },
      { name: str('guide_view'), values: [str('tv_guide'), str('view_channels_programme'), str('view_categories_channels'), str('view_channels')], index: function () { return Prefs.guideMode; }, pick: function (i) { Prefs.guideMode = i; } },
      { name: str('guide_header'), desc: str('guide_header_sub'), values: [str('header_full'), str('header_channel'), str('header_hide')], index: function () { return Prefs.guideHeader; }, pick: function (i) { Prefs.guideHeader = i; } },
      { name: str('guide_render'), desc: str('guide_render_sub'), values: [str('guide_render_html'), str('guide_render_canvas')], index: function () { return Prefs.guideRender; }, pick: function (i) { Prefs.guideRender = i; } },
      { name: str('guide_desc'), desc: str('guide_desc_sub'), values: [str('off'), str('on')], index: function () { return Prefs.guideDesc ? 1 : 0; }, pick: function (i) { Prefs.guideDesc = i === 1; } },
      { name: str('keyboard_layout'), values: [str('layout_standard'), str('layout_abc')], index: function () { return Prefs.keyboardAbc ? 1 : 0; }, pick: function (i) { Prefs.keyboardAbc = i === 1; } },
      { name: str('key_hints'), desc: str('a_row_at_the_bottom_of_the_pinned'), values: [str('off'), str('on')], index: function () { return Prefs.keyHints ? 1 : 0; }, pick: function (i) { Prefs.keyHints = i === 1; } },
      { name: str('smooth_animations'), desc: str('turn_off_on_weak_boxes'), values: [str('off'), str('on')], index: function () { return Prefs.animations ? 1 : 0; }, pick: function (i) { Prefs.animations = i === 1; } },
    ];
  }

  /** Язык сменился — пересобрать настройки на месте */
  private relabelAll() {
    this.buildNav();
    this.stack[0] = this.sectionPage(this.section);
    this.tv.relabel();
  }

  private pageChannels(): SItem[] {
    const self = this;
    let hidden = 0;
    const list = this.tv.repo.playlists();
    list.forEach(function (p) { hidden += Object.keys(UserData.hidden(p.id, 'group')).length + Object.keys(UserData.hidden(p.id, 'channel')).length; });
    return [
      { name: str('adaptive_sorting'), desc: str('frequently_watched_channels_go_up'), values: [str('off'), str('on')], index: function () { return Prefs.adaptiveSort ? 1 : 0; }, pick: function (i) { Prefs.adaptiveSort = i === 1; } },
      { name: str('reset_sorting_scores'), desc: str('all_playlists_order_by_numbers_again'), action: function () { list.forEach(function (p) { UserData.saveScores(p.id, {}); }); self.tv.toast.show(str('scores_reset')); } },
      { name: str('hidden_categories_and_channels'), desc: str('all_playlists_ok_restore'), value: function () { return hidden > 0 ? String(hidden) : str('none'); }, action: function () { self.push(self.hiddenPage()); } },
    ];
  }

  private hiddenPage(): Page {
    const self = this;
    return {
      title: str('hidden_categories_and_channels'), form: true, items: function () {
        const out: SItem[] = [];
        self.tv.repo.playlists().forEach(function (p) {
          const g = UserData.hidden(p.id, 'group'), c = UserData.hidden(p.id, 'channel');
          Object.keys(g).forEach(function (k) { out.push({ name: str('category_2') + g[k], value: function () { return str('restore'); }, desc: p.name, action: function () { delete g[k]; UserData.saveHidden(p.id, 'group', g); self.refresh(); } }); });
          Object.keys(c).forEach(function (k) { out.push({ name: c[k], value: function () { return str('restore'); }, desc: p.name, action: function () { delete c[k]; UserData.saveHidden(p.id, 'channel', c); self.refresh(); } }); });
        });
        if (!out.length) out.push({ name: str('nothing_is_hidden'), note: true });
        return out;
      },
    };
  }

  private pageLock(): SItem[] {
    const self = this;
    const inputs = [str('ring_like_fire_tv'), str('rows_like_google'), str('keypad')];
    if (!Prefs.pin) return [{ name: str('pin_code'), value: function () { return str('not_set'); }, desc: str('channels_and_categories_are_locked'), action: function () { self.newPin(); } }];
    return [
      { name: str('change_pin'), action: function () { self.checkPin(function () { self.newPin(); }); } },
      { name: str('ask_for_pin'), values: [str('once_until_exit'), str('every_time')], index: function () { return Prefs.pinEveryTime ? 1 : 0; }, pick: function (i) { Prefs.pinEveryTime = i === 1; } },
      { name: str('pin_input'), desc: str('ring_and_rows_do_not_show_which'), values: inputs, index: function () { return Prefs.pinInput; }, pick: function (i) { Prefs.pinInput = i; } },
      { name: str('remove_pin'), desc: str('locks_stop_working_marks_are_kept'), action: function () { self.checkPin(function () { Prefs.pin = ''; self.refresh(); }); } },
    ];
  }

  private checkPin(ok: () => void) {
    const tv = this.tv;
    let layer: PinLayer | null = null;
    layer = new PinLayer(tv.ui, false, str('current_pin'), function () { tv.remove(layer!); ok(); }, function () { tv.remove(layer!); });
    tv.push(layer);
  }

  private newPin() {
    const tv = this.tv;
    const self = this;
    let layer: PinLayer | null = null;
    layer = new PinLayer(tv.ui, true, str('new_pin'), function (pin) { tv.remove(layer!); Prefs.pin = pin; self.stack[0] = self.sectionPage(self.section); self.render(false); }, function () { tv.remove(layer!); });
    tv.push(layer);
  }

  private storageBytes = -1;
  private storageAsked = 0;

  private pageNetwork(): SItem[] {
    const self = this;
    // items() вызывается на каждой перерисовке — спрашивать сервис не чаще раза в 10 с
    if (Storage2.sqliteActive() && Date.now() - this.storageAsked > 10000) this.storageAsked = Date.now(), SocketDb.storageBytes().then(function (b) { self.storageBytes = b; self.refresh(); }, function () { /* */ });
    return [
      { name: str('proxy_status'), value: function () { return Net.proxyAvailable ? str('proxy_running') : Net.lunaAvailable ? str('proxy_luna') : str('proxy_absent'); }, desc: str('proxy_status_sub'), action: function () { Net.checkProxy().then(function () { self.refresh(); }); } },
      { name: str('sqlite_storage'), desc: str('sqlite_storage_sub'), value: function () {
        if (!Storage2.sqliteActive()) return str('sqlite_not_ready');
        return self.storageBytes >= 0 ? str('sqlite_ready') + ' · ' + str('size_mb', (self.storageBytes / 1048576).toFixed(1)) : str('sqlite_ready');
      }, action: function () { SocketDb.available().then(function () { return SocketDb.storageBytes(); }).then(function (b) { self.storageBytes = b; self.refresh(); }, function () { self.refresh(); }); } },
      { name: str('proxy_mode'), desc: str('proxy_mode_sub'), values: [str('proxy_auto'), str('proxy_always'), str('proxy_never')], index: function () { return Prefs.proxyMode; }, pick: function (i) { Prefs.proxyMode = i; } },
      { name: str('platform'), value: function () { return Platform.isWebOS ? 'webOS ' + (Platform.version() || '') : navigator.userAgent.replace(/^.*(Chrom(e|ium)\/[\d.]+).*$/, '$1'); }, note: false },
    ];
  }

  /** О программе: версия, ссылки (QR-кодом — на ТВ ссылку не нажать), лицензии */
  private pageAbout(): SItem[] {
    const tv = this.tv;
    const qr = function (title: string, url: string) {
      let layer: QrLinkLayer | null = null;
      layer = new QrLinkLayer(tv.ui, title, url, function () { tv.remove(layer!); });
      tv.push(layer);
    };
    const link = function (name: string, desc: string, url: string): SItem[] {
      return url ? [{ name: name, desc: desc, value: function () { return url.replace(/^https?:\/\//, ''); }, action: function () { qr(name, url); } }] : [];
    };
    const items: SItem[] = [
      { name: 'Perfect TV', value: function () { return str('about_version', About.version); }, desc: str('about_sub') },
    ];
    return items
      .concat(link(str('about_telegram'), str('about_telegram_sub'), About.telegram))
      .concat(link(str('about_donate'), str('about_donate_sub'), About.donate))
      .concat(link(str('about_github'), str('about_github_sub'), About.github))
      .concat([{ name: str('about_licenses'), desc: str('about_licenses_sub'), action: function () {
        let layer: LicensesLayer | null = null;
        layer = new LicensesLayer(tv.ui, function () { tv.remove(layer!); });
        tv.push(layer);
      } }]);
  }

  private pageData(): SItem[] {
    const self = this;
    const tv = this.tv;
    return [
      { name: str('log'), desc: str('log_sub'), action: function () { tv.openLog(); } },
      { name: str('logo_cache'), desc: str('logo_cache_sub_webos'), action: function () { Logos.clearFailed(); tv.toast.show(str('logo_cache_cleared')); } },
      { name: str('clear_programme'), desc: str('clear_programme_sub'), action: function () {
        Promise.all([Db.deleteRange('prog', IDBKeyRange.lowerBound([''])), Db.deleteRange('sources', IDBKeyRange.lowerBound('')), Db.deleteRange('epgch', IDBKeyRange.lowerBound(['']))]).then(function () {
          tv.repo.invalidateAll();
          tv.toast.show(str('programme_cleared'));
          if (tv.playlist) tv.repo.refreshEpg(tv.playlist, true);
        });
      } },
      { name: str('backup_save'), desc: str('backup_save_sub_webos'), action: function () { self.backupSave(); } },
      { name: str('backup_restore'), desc: str('backup_restore_sub_webos'), action: function () { self.backupRestore(); } },
      { name: str('reset_all'), desc: str('reset_all_sub'), action: function () { self.confirmReset(); } },
    ];
  }

  /** Резервная копия: JSON в SQLite (`settings.backup`); сохраняется при сбросе. */
  private backupSave() {
    const self = this;
    this.tv.repo.loadPlaylists().then(function (list) {
      const data = {
        v: 1, at: Clock.now(), prefs: Prefs.all(), user: UserData.dump(), reminders: Reminders.dump(),
        playlists: list.map(function (p) { return { id: p.id, name: p.name, url: p.url, epgMode: p.epgMode, userEpg: p.userEpg, sort: p.sort }; }),
      };
      Storage2.setJson('backup', data);
      Storage2.flush().then(function () { self.tv.toast.show(str('backup_saved_webos')); }, function (e) { console.error('backup save', e); self.tv.toast.show(str('storage_error')); });
    });
  }

  private backupRestore() {
    const data = Storage2.json<any>('backup', null);
    if (!data) { this.tv.toast.show(str('backup_none')); return; }
    const tv = this.tv;
    Prefs.replace(data.prefs || {});
    UserData.restore(data.user || {});
    Reminders.restore(data.reminders || []);
    const ps: Playlist[] = (data.playlists || []).map(function (p: any) {
      return { id: p.id, name: p.name, url: p.url, epgMode: p.epgMode || 0, userEpg: p.userEpg || [], headerEpg: [], loadedAt: 0, channelsCount: 0, error: '', sort: p.sort || 0 };
    });
    Db.deleteRange('playlists', IDBKeyRange.lowerBound(0)).then(function () { return Db.putAll('playlists', ps); }).then(function () {
      return Storage2.flush();
    }).then(function () {
      tv.toast.show(str('backup_restored'));
      setTimeout(function () { location.reload(); }, 800);
    }, function (e) { console.error('backup restore', e); tv.toast.show(str('storage_error')); });
  }

  private confirmReset() {
    const tv = this.tv;
    let layer: MessageLayer | null = null;
    layer = new MessageLayer(tv.ui, str('reset_all'), str('reset_all_warning'), [str('reset'), str('cancel')], function (i) {
      tv.remove(layer!);
      if (i !== 0) return;
      const backup = Storage2.get('backup');
      Storage2.flush().then(function () { return Db.drop(); }).then(function () {
        return Storage2.resetRuntime(backup);
      }).then(function () { location.reload(); }, function (e) { console.error('reset', e); tv.toast.show(str('storage_error')); });
    }, function () { tv.remove(layer!); });
    tv.push(layer);
  }
}
