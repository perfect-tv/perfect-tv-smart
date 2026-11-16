import { Prefs } from '../core/prefs';
import { Channel, Playlist } from './models';
import { UserData } from './userdata';

export interface Group { key: string; title: string; channels: Channel[]; favourites: boolean }

export const FAV_KEY = '';
/** «Все каналы»: ключ не совпадёт ни с одной категорией плейлиста (символ частной зоны Unicode) */
export const ALL_KEY = 'all';
export const HISTORY_SIZE = 11;
export const POPULAR_SIZE = 12;

function byScore(scores: { [k: string]: number }) {
  return function (a: Channel, b: Channel) {
    const d = (scores[b.key] || 0) - (scores[a.key] || 0);
    return d !== 0 ? d : a.num - b.num;
  };
}

/**
 * Каталог каналов одного плейлиста в памяти: категории, избранное, история, скрытое, блокировки,
 * очки адаптивной сортировки. Данные пользователя — UserData по ключу канала.
 */
export class Catalog {
  byKey: { [key: string]: Channel } = {};
  favourites: string[];
  history: string[];
  hiddenGroups: { [k: string]: string };
  hiddenChannels: { [k: string]: string };
  private scores: { [k: string]: number };
  private lockedGroups: string[];
  private lockedChannels: string[];
  private allGroups: Group[] = [];
  favGroup: Group;
  private groupList: Group[] = [];
  private groupMap: { [k: string]: Group } = {};

  constructor(public playlist: Playlist, public channels: Channel[], private favouritesTitle: () => string, private allTitle: () => string) {
    const pid = playlist.id;
    this.favourites = UserData.favourites(pid);
    this.history = UserData.history(pid);
    this.hiddenGroups = UserData.hidden(pid, 'group');
    this.hiddenChannels = UserData.hidden(pid, 'channel');
    this.scores = UserData.scores(pid);
    this.lockedGroups = UserData.locked(pid, 'group');
    this.lockedChannels = UserData.locked(pid, 'channel');
    this.favGroup = { key: FAV_KEY, title: favouritesTitle(), channels: [], favourites: true };
    for (let i = 0; i < channels.length; i++) if (!this.byKey[channels[i].key]) this.byKey[channels[i].key] = channels[i];
    const order: string[] = [];
    const map: { [k: string]: Channel[] } = {};
    for (let i = 0; i < channels.length; i++) {
      const g = channels[i].group;
      if (!map[g]) { map[g] = []; order.push(g); }
      map[g].push(channels[i]);
    }
    for (let i = 0; i < order.length; i++) this.allGroups.push({ key: order[i], title: order[i], channels: map[order[i]], favourites: false });
    this.refreshFavorites();
    this.applyView();
  }

  /**
   * Видимые категории: без скрытых; при адаптивной сортировке — по очкам, при равенстве — по номеру.
   * «Все каналы» — первой после избранного.
   */
  applyView() {
    const adaptive = Prefs.adaptiveSort;
    const list: Group[] = [];
    const map: { [k: string]: Group } = {};
    const hc = this.hiddenChannels, hg = this.hiddenGroups;
    for (let i = 0; i < this.allGroups.length; i++) {
      const g = this.allGroups[i];
      if (hg[g.key] !== undefined) continue;
      let chs = g.channels.filter(function (c) { return hc[c.key] === undefined; });
      if (!chs.length) continue;
      if (adaptive) chs = chs.slice().sort(byScore(this.scores));
      const v: Group = { key: g.key, title: g.title, channels: chs, favourites: false };
      list.push(v);
      map[g.key] = v;
    }
    if (list.length) {
      let all = this.channels.filter(function (c) { return hg[c.group] === undefined && hc[c.key] === undefined; });
      if (adaptive) all = all.slice().sort(byScore(this.scores));
      const g: Group = { key: ALL_KEY, title: this.allTitle(), channels: all, favourites: false };
      list.unshift(g);
      map[ALL_KEY] = g;
    }
    this.groupList = list;
    this.groupMap = map;
  }

  /** Названия «Избранного» и «Всех каналов» — после смены языка */
  retitle() {
    this.favGroup.title = this.favouritesTitle();
    const a = this.groupMap[ALL_KEY];
    if (a) a.title = this.allTitle();
  }

  refreshFavorites() {
    const out: Channel[] = [];
    for (let i = 0; i < this.favourites.length; i++) {
      const c = this.byKey[this.favourites[i]];
      if (c && this.hiddenChannels[c.key] === undefined) out.push(c);
    }
    this.favGroup = { key: FAV_KEY, title: this.favouritesTitle(), channels: out, favourites: true };
  }

  /** Категории для навигации: избранное (если не пусто) + «Все каналы» + категории плейлиста */
  groups(): Group[] { return this.favGroup.channels.length ? [this.favGroup].concat(this.groupList) : this.groupList; }

  group(key: string | null): Group | null {
    if (key === null) return null;
    if (key === FAV_KEY) return this.favGroup.channels.length ? this.favGroup : null;
    return this.groupMap[key] || null;
  }

  /** Категория канала: preferKey, если канал в ней есть, иначе родная */
  groupOf(ch: Channel, preferKey: string | null): Group {
    const p = this.group(preferKey);
    if (p && p.channels.indexOf(ch) >= 0) return p;
    for (let i = 0; i < this.groupList.length; i++) {
      const g = this.groupList[i];
      if (g.key !== ALL_KEY && g.channels.indexOf(ch) >= 0) return g;
    }
    for (let i = 0; i < this.groupList.length; i++) if (this.groupList[i].channels.indexOf(ch) >= 0) return this.groupList[i];
    return this.groupList[0] || this.favGroup;
  }

  byNum(num: number): Channel | null {
    for (let i = 0; i < this.channels.length; i++) if (this.channels[i].num === num && this.hiddenChannels[this.channels[i].key] === undefined) return this.channels[i];
    return null;
  }

  // ---- избранное
  isFavorite(ch: Channel) { return this.favourites.indexOf(ch.key) >= 0; }
  toggleFavorite(ch: Channel) {
    const i = this.favourites.indexOf(ch.key);
    if (i >= 0) this.favourites.splice(i, 1); else this.favourites.push(ch.key);
    UserData.saveFavorites(this.playlist.id, this.favourites);
    this.refreshFavorites();
  }
  /** Сдвиг в избранном: −1 вверх, +1 вниз */
  moveFavorite(ch: Channel, dir: number) {
    const i = this.favourites.indexOf(ch.key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.favourites.length) return;
    this.favourites[i] = this.favourites[j];
    this.favourites[j] = ch.key;
    UserData.saveFavorites(this.playlist.id, this.favourites);
    this.refreshFavorites();
  }

  // ---- история
  addHistory(ch: Channel) {
    const i = this.history.indexOf(ch.key);
    if (i >= 0) this.history.splice(i, 1);
    this.history.unshift(ch.key);
    if (this.history.length > HISTORY_SIZE) this.history.length = HISTORY_SIZE;
    UserData.saveHistory(this.playlist.id, this.history);
  }
  replaceHistory(keys: string[]) {
    this.history = keys.slice(0, HISTORY_SIZE);
    UserData.saveHistory(this.playlist.id, this.history);
  }
  /** Недавние каналы без текущего */
  recent(current: Channel | null): Channel[] {
    const out: Channel[] = [];
    for (let i = 0; i < this.history.length && out.length < HISTORY_SIZE - 1; i++) {
      const c = this.byKey[this.history[i]];
      if (c && c !== current && this.hiddenChannels[c.key] === undefined) out.push(c);
    }
    return out;
  }

  // ---- скрытое
  isHidden(ch: Channel) { return this.hiddenChannels[ch.key] !== undefined; }
  hideChannel(ch: Channel) {
    this.hiddenChannels[ch.key] = ch.name;
    UserData.saveHidden(this.playlist.id, 'channel', this.hiddenChannels);
    this.applyView();
    this.refreshFavorites();
  }
  hideGroup(key: string) {
    if (key === FAV_KEY || key === ALL_KEY) return;
    this.hiddenGroups[key] = key;
    UserData.saveHidden(this.playlist.id, 'group', this.hiddenGroups);
    this.applyView();
  }
  unhide(kind: string, key: string) {
    const m = kind === 'group' ? this.hiddenGroups : this.hiddenChannels;
    delete m[key];
    UserData.saveHidden(this.playlist.id, kind, m);
    this.applyView();
    this.refreshFavorites();
  }
  hiddenCount() { return Object.keys(this.hiddenGroups).length + Object.keys(this.hiddenChannels).length; }

  // ---- блокировка (действует, только если PIN задан)
  isChannelLocked(ch: Channel) { return this.lockedChannels.indexOf(ch.key) >= 0; }
  isGroupLocked(key: string) { return this.lockedGroups.indexOf(key) >= 0; }
  /** Канал заблокирован сам или его категория */
  isLocked(ch: Channel) { return Prefs.pin !== '' && (this.lockedChannels.indexOf(ch.key) >= 0 || this.lockedGroups.indexOf(ch.groupKey) >= 0); }
  setLocked(kind: string, key: string, on: boolean) {
    const l = kind === 'group' ? this.lockedGroups : this.lockedChannels;
    const i = l.indexOf(key);
    if (on && i < 0) l.push(key);
    if (!on && i >= 0) l.splice(i, 1);
    UserData.saveLocked(this.playlist.id, kind, l);
  }

  // ---- адаптивная сортировка
  addScore(ch: Channel) {
    this.scores[ch.key] = (this.scores[ch.key] || 0) + 1;
    UserData.saveScores(this.playlist.id, this.scores);
  }
  popular(limit = POPULAR_SIZE): Channel[] {
    const s = this.scores;
    return this.channels.filter(function (c) { return (s[c.key] || 0) > 0; }).sort(byScore(s)).slice(0, limit);
  }
  resetScores() {
    this.scores = {};
    UserData.saveScores(this.playlist.id, this.scores);
  }
}
