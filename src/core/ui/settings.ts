import { Clock } from '../clock';
import { lang, languages, plural, str } from '../lang';
import { Net } from '../net';
import { platform } from '../platform';
import { Prefs } from '../prefs';
import { Storage2 } from '../storage';
import { Db, lowerBound } from '../data/db';
import { SourceMeta, SRC_ERROR, SRC_LOADING, SRC_READY } from '../data/loaders';
import { EPG_BOTH, EPG_PLAYLIST, EPG_USER_ONLY, isStalker, isXtream, Playlist, SOURCE_M3U, SOURCE_STALKER, SOURCE_XTREAM } from '../data/models';
import { normalizeStalkerMac, normalizeStalkerPortal } from '../data/stalker';
import { normalizeXtreamAccount } from '../data/xtream';
import { Reminders } from '../data/reminders';
import { UserData } from '../data/userdata';
import { Anim, el, setText, toggle } from './dom';
import { Fmt } from './fmt';
import { Layer } from './layer';
import { Logos } from './logos';
import { PinLayer } from './pin';
import { FormLayer, ListLayer, MessageLayer, Scroller } from './popups';
import { QrPlaylistLayer } from './qrplaylist';
import { LicensesLayer, QrLinkLayer } from './about';
import { About } from '../about';
import type { Tv } from './tv';
import { U } from './u';
import { restyle } from './style';
import { hintRow } from './widgets';
import { CodeUpdate } from '../codeupdate';

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
      const what = isXtream(p) ? str('source_xtream') + (p.username ? ' · ' + p.username : '') + (p.url ? ' · ' + p.url : '')
        : isStalker(p) ? str('source_stalker') + (p.username ? ' · ' + p.username : '') + (p.url ? ' · ' + p.url : '') : p.url;
      out.push({ name: p.name, value: function () { return p.id === Prefs.lastPlaylist ? '●' : ''; }, desc: what + ' · ' + status, action: function () { self.push(self.playlistPage(p)); } });
    });
    out.push({ name: str('plus_add_playlist'), action: function () { self.addSource(); } });
    if (platform().qr) out.push({ name: str('playlist_qr_action'), desc: str('playlist_qr_action_desc'), action: function () { self.addPlaylistByQr(); } });
    return out;
  }

  private playlistPage(p: Playlist): Page {
    const self = this;
    const repo = this.tv.repo;
    return {
      title: p.name, form: true, items: function () {
        const modes = [str('epg_from_playlist'), str('epg_playlist_and_own'), str('epg_own_only')];
        const xc = isXtream(p), st = isStalker(p);
        const what = xc ? str('source_xtream') + (p.username ? ' · ' + p.username : '') + ' · ' + p.url
          : st ? str('source_stalker') + (p.username ? ' · ' + p.username : '') + ' · ' + p.url : p.url;
        const out: SItem[] = [
          { name: str('name_and_address'), desc: what, action: function () { self.editPlaylist(p); } },
          { name: str('programme_epg'), values: modes, index: function () { return p.epgMode === EPG_BOTH ? 1 : p.epgMode === EPG_USER_ONLY ? 2 : 0; }, pick: function (i) { p.epgMode = i === 1 ? EPG_BOTH : i === 2 ? EPG_USER_ONLY : EPG_PLAYLIST; repo.savePlaylist(p); } },
        ];
        if (xc) out.push({
          name: str('xtream_output'), desc: str('xtream_output_sub'), values: [str('xtream_output_hls'), str('xtream_output_ts')],
          index: function () { return p.output === 'ts' ? 1 : 0; },
          pick: function (i) {
            const next = i === 1 ? 'ts' : 'm3u8';
            if (p.output === next) return;
            p.output = next;
            p.loadedAt = 0;
            p.channelsCount = 0;
            p.error = '';
            repo.savePlaylist(p).then(function () { repo.refresh(p, true); });
          },
        });
        out.push({ name: str('from_the_playlist'), section: true });
        if (!p.headerEpg.length) out.push({ name: str('the_playlist_has_no_programme_source'), note: true });
        p.headerEpg.forEach(function (u) {
          // адрес программы Xtream содержит пароль — на экране не показываем
          const name = xc && u.indexOf('/xmltv.php') >= 0 ? str('xtream_guide') : u;
          out.push({ name: name, desc: self.srcStatus(u), action: function () { repo.refreshEpg(p, true); self.tv.toast.show(str('reloading_programme')); } });
        });
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

  /** Приём ссылки с телефона (PlatformApi.qr; на webOS — временный HTTP-сервер на самом ТВ) */
  private addPlaylistByQr() {
    const self = this;
    const tv = this.tv;
    let layer: QrPlaylistLayer | null = null;
    layer = new QrPlaylistLayer(tv.ui, function (url, name) {
      if (Net.blockedHttp(url)) { tv.remove(layer!); tv.toast.show(str('https_only_error')); return; }
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

  /** Добавить источник: M3U или Xtream (у них разные поля) */
  private addSource() {
    const self = this;
    const tv = this.tv;
    let layer: ListLayer | null = null;
    layer = new ListLayer(tv.ui, str('add_source'), [
      { label: str('source_m3u'), sub: str('source_m3u_sub'), action: function () { tv.remove(layer!); self.editPlaylist(null, SOURCE_M3U); } },
      { label: str('source_xtream'), sub: str('source_xtream_sub'), action: function () { tv.remove(layer!); self.editPlaylist(null, SOURCE_XTREAM); } },
      { label: str('source_stalker'), sub: str('source_stalker_sub'), action: function () { tv.remove(layer!); self.editPlaylist(null, SOURCE_STALKER); } },
    ], function () { tv.remove(layer!); }, { width: 52 });
    tv.push(layer);
  }

  private editPlaylist(p: Playlist | null, source = SOURCE_M3U) {
    if (p ? isXtream(p) : source === SOURCE_XTREAM) this.editXtream(p);
    else if (p ? isStalker(p) : source === SOURCE_STALKER) this.editStalker(p);
    else this.editM3u(p);
  }

  private editStalker(p: Playlist | null) {
    const self = this;
    const tv = this.tv;
    let layer: FormLayer | null = null;
    layer = new FormLayer(tv.ui, p ? str('source_stalker') : str('add_source'), [
      { label: str('stalker_portal'), value: p ? p.url : '', type: 'url' },
      { label: str('stalker_mac'), value: p ? (p.username || '') : '' },
      { label: str('name'), value: p ? p.name : '' },
    ], [str('save'), str('cancel')], function (i, v) {
      if (i === 1) { tv.remove(layer!); return; }
      const portal = normalizeStalkerPortal(v[0]);
      const mac = normalizeStalkerMac(v[1]);
      if (!portal || !/^https?:\/\/[^\/]+/i.test(portal)) { tv.toast.show(str('stalker_portal_invalid')); return; }
      if (!mac) { tv.toast.show(str('stalker_mac_invalid')); return; }
      if (Net.blockedHttp(portal)) { tv.toast.show(str('https_only_error')); return; }
      tv.remove(layer!);
      self.changed = true;
      if (p) {
        const changed = p.url !== portal || normalizeStalkerMac(p.username || '') !== mac;
        p.url = portal;
        p.source = SOURCE_STALKER;
        p.username = mac;
        p.password = '';
        p.name = v[2] || p.name;
        if (changed) { p.loadedAt = 0; p.etag = ''; p.lastModified = ''; p.channelsCount = 0; p.error = ''; p.headerEpg = []; }
        tv.repo.savePlaylist(p).then(function () { self.refresh(); if (changed) tv.repo.refresh(p, true); });
      } else {
        tv.repo.addPlaylist(v[2] || str('source_stalker'), portal, SOURCE_STALKER, mac).then(function (np) {
          if (!tv.playlist) { self.onClose(false); tv.open(np); return; }
          self.refresh();
          tv.repo.refresh(np, true).then(function () { self.refresh(); });
        });
      }
    }, function () { tv.remove(layer!); }, str('stalker_note'));
    tv.push(layer);
  }

  private editM3u(p: Playlist | null) {
    const self = this;
    const tv = this.tv;
    let layer: FormLayer | null = null;
    layer = new FormLayer(tv.ui, p ? str('playlist') : str('add_playlist'), [
      { label: str('playlist_address'), value: p ? p.url : '', type: 'url' },
      { label: str('name'), value: p ? p.name : '' },
    ], [str('save'), str('cancel')], function (i, v) {
      if (i === 1) { tv.remove(layer!); return; }
      if (!v[0]) { tv.toast.show(str('enter_the_address')); return; }
      if (Net.blockedHttp(v[0])) { tv.toast.show(str('https_only_error')); return; }
      tv.remove(layer!);
      self.changed = true;
      if (p) {
        const urlChanged = p.url !== v[0];
        p.url = v[0];
        p.source = SOURCE_M3U;
        p.username = '';
        p.password = '';
        p.name = v[1] || p.name;
        if (urlChanged) { p.loadedAt = 0; p.etag = ''; p.lastModified = ''; p.headerEpg = []; }
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

  private editXtream(p: Playlist | null) {
    const self = this;
    const tv = this.tv;
    let layer: FormLayer | null = null;
    layer = new FormLayer(tv.ui, p ? str('source_xtream') : str('add_source'), [
      { label: str('xtream_server'), value: p ? p.url : '', type: 'url' },
      { label: str('xtream_username'), value: p ? (p.username || '') : '' },
      { label: str('xtream_password'), value: p ? (p.password || '') : '', type: 'password' },
      { label: str('name'), value: p ? p.name : '' },
    ], [str('save'), str('cancel')], function (i, v) {
      if (i === 1) { tv.remove(layer!); return; }
      const acc = normalizeXtreamAccount(v[0]);
      const user = v[1] || acc.username;
      const pass = v[2] || acc.password;
      if (!acc.server) { tv.toast.show(str('xtream_server_invalid')); return; }
      if (!user || !pass) { tv.toast.show(str('xtream_credentials')); return; }
      if (Net.blockedHttp(acc.server)) { tv.toast.show(str('https_only_error')); return; }
      tv.remove(layer!);
      self.changed = true;
      if (p) {
        const changed = p.url !== acc.server || (p.username || '') !== user || (p.password || '') !== pass;
        p.url = acc.server;
        p.source = SOURCE_XTREAM;
        p.username = user;
        p.password = pass;
        p.output = p.output === 'ts' ? 'ts' : 'm3u8';
        p.name = v[3] || p.name;
        if (changed) { p.loadedAt = 0; p.etag = ''; p.lastModified = ''; p.channelsCount = 0; p.error = ''; p.headerEpg = []; }
        tv.repo.savePlaylist(p).then(function () { self.refresh(); if (changed) tv.repo.refresh(p, true); });
      } else {
        tv.repo.addPlaylist(v[3] || str('source_xtream'), acc.server, SOURCE_XTREAM, user, pass).then(function (np) {
          if (!tv.playlist) { self.onClose(false); tv.open(np); return; }
          self.refresh();
          tv.repo.refresh(np, true).then(function () { self.refresh(); });
        });
      }
    }, function () { tv.remove(layer!); }, str('xtream_note'));
    tv.push(layer);
  }

  private editEpg(p: Playlist, i: number) {
    const self = this;
    const tv = this.tv;
    let layer: FormLayer | null = null;
    const labels = i >= 0 ? [str('save'), str('delete'), str('cancel')] : [str('add'), str('cancel')];
    // адрес XMLTV с телефона по QR — где у платформы есть приём
    if (platform().qr) labels.splice(labels.length - 1, 0, str('playlist_from_phone'));
    const apply = function (url: string | null, del: boolean) {
      if (!del && url && Net.blockedHttp(url)) { tv.toast.show(str('https_only_error')); return; }
      if (del) p.userEpg.splice(i, 1);
      else if (url) { if (i >= 0) p.userEpg[i] = url; else if (p.userEpg.indexOf(url) < 0) p.userEpg.push(url); }
      if (p.epgMode === EPG_PLAYLIST && p.userEpg.length && !p.headerEpg.length) p.epgMode = EPG_BOTH;
      tv.repo.savePlaylist(p).then(function () { self.refresh(); tv.repo.refreshEpg(p, false); });
    };
    layer = new FormLayer(tv.ui, str('programme_source'), [{ label: str('xmltv_url'), value: i >= 0 ? p.userEpg[i] : '', type: 'url' }], labels, function (k, v) {
      const lab = labels[k];
      tv.remove(layer!);
      if (lab === str('cancel')) return;
      if (lab === str('playlist_from_phone')) {
        let q: QrPlaylistLayer | null = null;
        q = new QrPlaylistLayer(tv.ui, function (url) {
          tv.remove(q!);
          apply(url, false);
          tv.toast.show(str('epg_qr_added'));
        }, function () { tv.remove(q!); }, 'epg');
        tv.push(q);
        return;
      }
      apply(v[0], lab === str('delete'));
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
      { name: str('buffer_size'), desc: str('buffer_size_sub'), values: [2, 4, 6, 8, 10, 12].map(function (x) { return str('x_s', x); }), index: function () { return Math.max(0, [2, 4, 6, 8, 10, 12].indexOf(Prefs.bufferSec)); }, pick: function (i) { Prefs.bufferSec = [2, 4, 6, 8, 10, 12][i]; } },
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
      { name: str('marquee'), desc: str('marquee_sub'), values: [str('off'), str('on')], index: function () { return Prefs.marquee ? 1 : 0; }, pick: function (i) { Prefs.marquee = i === 1; } },
      { name: str('lite_interface'), desc: str('lite_interface_sub'), values: [str('off'), str('lite_no_animations'), str('lite_no_transparency')], index: function () { return Prefs.lite; }, pick: function (i) { Prefs.lite = i; U.init(); restyle(); self.tv.relabel(); } },
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
      { name: str('group_quality'), desc: str('group_quality_sub'), values: [str('off'), str('on')], index: function () { return Prefs.groupQuality ? 1 : 0; }, pick: function (i) { Prefs.groupQuality = i === 1; self.tv.reloadCatalog(true); } },
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
    // items() вызывается на каждой перерисовке — спрашивать размер не чаще раза в 10 с
    const askSize = function () { self.storageAsked = Date.now(); platform().storageBytes().then(function (b) { self.storageBytes = b; self.refresh(); }, function () { self.refresh(); }); };
    if (Storage2.persistent() && Date.now() - this.storageAsked > 10000) askSize();
    const items: SItem[] = [];
    const lb = platform().labels;
    if (Net.proxyState()) items.push({ name: str(lb.proxy), value: function () { return str(Net.proxyState()); }, desc: str(lb.proxySub), action: function () { Net.checkProxy().then(function () { self.refresh(); }); } });
    items.push({ name: str(lb.storage), desc: str(lb.storageSub), value: function () {
      if (!Storage2.persistent()) return str('sqlite_not_ready');
      return self.storageBytes >= 0 ? str('sqlite_ready') + ' · ' + str('size_mb', (self.storageBytes / 1048576).toFixed(1)) : str('sqlite_ready');
    }, action: askSize });
    if (Net.proxyState()) items.push({ name: str(lb.proxyMode), desc: str('proxy_mode_sub'), values: [str('proxy_auto'), str('proxy_always'), str('proxy_never')], index: function () { return Prefs.proxyMode; }, pick: function (i) { Prefs.proxyMode = i; } });
    items.push({ name: str('platform'), value: function () { return platform().label(); }, note: false });
    return items;
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
    const self = this;
    const items: SItem[] = [
      { name: 'Perfect TV', value: function () { return str('about_version', About.version); }, desc: str('about_sub') },
    ];
    // обновление кода с сайта без переустановки (webOS, Tizen — оболочка с загрузчиком)
    if (CodeUpdate.available) {
      const label: { [s: string]: () => string } = {
        idle: function () { return str('code_idle'); },
        checking: function () { return str('code_checking'); },
        downloading: function () { return str('code_downloading', CodeUpdate.found); },
        latest: function () { return str('code_latest'); },
        ready: function () { return str('code_ready', CodeUpdate.found); },
        shell: function () { return str('code_need_package', CodeUpdate.found); },
        service: function () { return str('code_need_package', CodeUpdate.found); },
        error: function () { return str('code_error'); },
      };
      items.push({ name: str('code_update'), desc: str('code_update_sub'),
        value: function () { const f = label[CodeUpdate.status]; return f ? f() : ''; },
        action: function () {
          if (CodeUpdate.status === 'ready') { CodeUpdate.restart(); return; }
          CodeUpdate.check().then(function () { self.refresh(); });
          self.refresh();
        } });
      items.push({ name: str('code_auto'), desc: str('code_auto_sub'), values: [str('off'), str('on')],
        index: function () { return Prefs.codeAuto ? 1 : 0; }, pick: function (i) { Prefs.codeAuto = i === 1; } });
      if (CodeUpdate.downloaded) items.push({ name: str('code_builtin'), desc: str('code_builtin_sub', CodeUpdate.builtin),
        action: function () { CodeUpdate.reset().then(function () { tv.toast.show(str('code_builtin_done', CodeUpdate.builtin)); }); } });
    }
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
        Promise.all([Db.deleteRange('prog', lowerBound([''])), Db.deleteRange('sources', lowerBound('')), Db.deleteRange('epgch', lowerBound(['']))]).then(function () {
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
        playlists: list.map(function (p) {
          return {
            id: p.id, name: p.name, url: p.url, source: p.source || 0, username: p.username || '', password: p.password || '',
            output: p.output || 'm3u8', epgMode: p.epgMode, userEpg: p.userEpg, sort: p.sort,
          };
        }),
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
      return {
        id: p.id, name: p.name, url: p.url, source: p.source || 0, username: p.username || '', password: p.password || '',
        output: p.output === 'ts' ? 'ts' : 'm3u8', epgMode: p.epgMode || 0, userEpg: p.userEpg || [], headerEpg: [],
        loadedAt: 0, channelsCount: 0, error: '', sort: p.sort || 0,
      };
    });
    Db.deleteRange('playlists', lowerBound(0)).then(function () { return Db.putAll('playlists', ps); }).then(function () {
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
