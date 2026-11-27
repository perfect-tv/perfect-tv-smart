import { Prefs } from '../prefs';
import { Channel, Playlist } from './models';
import { Names } from './names';
import { Reminders } from './reminders';
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

function orderKey(c: Channel): string { return c.groupKey + '\u0000' + c.key; }

/** Приоритет имени головного канала: без суффикса, затем 4K/FHD/HD, затем SD/orig */
function qualityRank(name: string): number {
  const s = name.toLowerCase();
  if (/(^|[\s._-])(4k|uhd|2160[pi]?|4320[pi]?|fhd|1080[pi]?)(?=$|[\s._-])/.test(s)) return 1;
  if (/(^|[\s._-])(hd|720[pi]?|576[pi]?|480[pi]?)(?=$|[\s._-])/.test(s)) return 2;
  if (/(^|[\s._-])(sd|orig|original|org|50)(?=$|[\s._-])/.test(s)) return 4;
  if (Names.qualityBase(name) !== name) return 3;
  return 0;
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
  private names: { [k: string]: string };
  private numbers: { [k: string]: number };
  private orders: { [k: string]: number };
  /** Ключ дубля качества → ключ головного канала */
  private aliases: { [k: string]: string } = {};
  private lockedGroups: string[];
  private lockedChannels: string[];
  private allGroups: Group[] = [];
  favGroup: Group;
  private groupList: Group[] = [];
  private groupMap: { [k: string]: Group } = {};

  constructor(public playlist: Playlist, public channels: Channel[], private favouritesTitle: () => string, private allTitle: () => string,
    /** tvg-id, у которых программа — заглушка (одна передача на все дни): для объединения не годится */
    private badEpgIds: { [id: string]: boolean } = {}) {
    const pid = playlist.id;
    this.favourites = UserData.favourites(pid);
    this.history = UserData.history(pid);
    this.hiddenGroups = UserData.hidden(pid, 'group');
    this.hiddenChannels = UserData.hidden(pid, 'channel');
    this.scores = UserData.scores(pid);
    this.names = UserData.names(pid);
    this.numbers = UserData.numbers(pid);
    this.orders = UserData.orders(pid);
    this.lockedGroups = UserData.locked(pid, 'group');
    this.lockedChannels = UserData.locked(pid, 'channel');
    this.favGroup = { key: FAV_KEY, title: favouritesTitle(), channels: [], favourites: true };
    for (let i = 0; i < channels.length; i++) {
      const c = channels[i];
      const name = this.names[c.key];
      if (name) c.name = name;
      const num = this.numbers[c.key];
      if (typeof num === 'number') c.num = num;
    }
    if (Prefs.groupQuality) this.groupQuality(channels);
    for (let i = 0; i < channels.length; i++) {
      const c = channels[i];
      if (!c.primary && !this.byKey[c.key]) this.byKey[c.key] = c;
    }
    for (let i = 0; i < channels.length; i++) {
      const c = channels[i];
      if (!c.primary) continue;
      this.byKey[c.key] = c.primary;
      this.aliases[c.key] = c.primary.key;
    }
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
   * tvg-id, которым можно верить при объединении: все каналы категории с этим id должны иметь
   * совпадающую часть имени («NHL» и «NHL Network»), иначе id переиспользован провайдером
   * («demo2703» у пяти разных Sky Sport) и не годится. Заглушка в программе (одна передача
   * на все дни) тоже исключает id.
   */
  private safeTvgIds(list: Channel[]): { [k: string]: boolean } {
    const names: { [k: string]: { [n: string]: true } } = {};
    const bad: { [k: string]: true } = {};
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.tvgId) continue;
      const k = c.groupKey + '\u0000' + c.tvgId;
      if (this.badEpgIds[c.tvgId]) { bad[k] = true; continue; }
      const n = Names.groupCompare(c.name);
      if (!n) continue;
      if (!names[k]) names[k] = {};
      names[k][n] = true;
    }
    const out: { [k: string]: boolean } = {};
    for (const k in names) {
      const arr = Object.keys(names[k]);
      let ok = true;
      for (let i = 0; i < arr.length && ok; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (!Names.related(arr[i], arr[j])) { ok = false; break; }
        }
      }
      out[k] = ok;
    }
    for (const k in bad) out[k] = false;
    return out;
  }

  /** Объединить SD/HD/FHD/4K и одинаковые имена в одну строку с дублями в `alts` */
  private groupQuality(list: Channel[]) {
    const names: { [k: string]: Channel[] } = {};
    const order: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const bk = Names.groupBase(c.name);
      if (!bk) continue;
      const gk = c.groupKey + '\u0000' + bk;
      if (!names[gk]) { names[gk] = []; order.push(gk); }
      names[gk].push(c);
    }
    const safe = this.safeTvgIds(list);
    // Версии с разными tvg-id — разные каналы (у них может быть своя программа):
    // внутри имени делим по id, каналы без id — к самой большой части.
    const fams: Channel[][] = [];
    const famIds: string[] = [];
    const famGroups: string[] = [];
    function addFam(arr: Channel[], id: string) {
      fams.push(arr); famIds.push(id); famGroups.push(arr[0].groupKey);
    }
    for (let i = 0; i < order.length; i++) {
      const g = names[order[i]];
      const byId: { [id: string]: Channel[] } = {};
      const ids: string[] = [];
      const empty: Channel[] = [];
      for (let j = 0; j < g.length; j++) {
        const c = g[j];
        if (c.tvgId) {
          if (!byId[c.tvgId]) { byId[c.tvgId] = []; ids.push(c.tvgId); }
          byId[c.tvgId].push(c);
        } else empty.push(c);
      }
      if (ids.length <= 1) addFam(g, ids.length ? ids[0] : '');
      else {
        ids.sort(function (a, b) { return byId[b].length - byId[a].length; });
        for (let j = 0; j < ids.length; j++) {
          const arr = byId[ids[j]].slice();
          if (j === 0) for (let k = 0; k < empty.length; k++) arr.push(empty[k]);
          addFam(arr, ids[j]);
        }
      }
    }
    // Один безопасный tvg-id у нескольких имён (NHL / NHL Network) — одна строка.
    const same: { [k: string]: number[] } = {};
    for (let i = 0; i < fams.length; i++) {
      const id = famIds[i];
      if (!id || !safe[famGroups[i] + '\u0000' + id]) continue;
      const k = famGroups[i] + '\u0000' + id;
      (same[k] = same[k] || []).push(i);
    }
    const used: { [i: number]: true } = {};
    const merged: Channel[][] = [];
    for (let i = 0; i < fams.length; i++) {
      if (used[i]) continue;
      const id = famIds[i];
      const k = id ? famGroups[i] + '\u0000' + id : '';
      const members = k && same[k] ? same[k] : [i];
      if (members.length === 1) { used[i] = true; merged.push(fams[i]); continue; }
      const arr: Channel[] = [];
      for (let j = 0; j < members.length; j++) {
        used[members[j]] = true;
        for (let n = 0; n < fams[members[j]].length; n++) arr.push(fams[members[j]][n]);
      }
      merged.push(arr);
    }
    for (let i = 0; i < merged.length; i++) {
      const g = merged[i];
      if (g.length < 2) continue;
      g.sort(function (a, b) {
        const ar = qualityRank(a.name), br = qualityRank(b.name);
        return ar - br || b.archiveDays - a.archiveDays || a.name.length - b.name.length || a.index - b.index;
      });
      const p = g[0];
      for (let j = 1; j < g.length; j++) {
        p.alts.push(g[j]);
        g[j].primary = p;
      }
    }
  }

  private resolveKey(key: string): string { return this.aliases[key] || key; }

  /**
   * Видимые категории: без скрытых; при адаптивной сортировке — по очкам, при равенстве — по номеру.
   * «Все каналы» — первой после избранного.
   */
  applyView() {
    const adaptive = Prefs.adaptiveSort;
    const list: Group[] = [];
    const map: { [k: string]: Group } = {};
    const hg = this.hiddenGroups;
    const self = this;
    for (let i = 0; i < this.allGroups.length; i++) {
      const g = this.allGroups[i];
      if (hg[g.key] !== undefined) continue;
      let chs = g.channels.filter(function (c) { return !c.primary && !self.isHidden(c); });
      if (!chs.length) continue;
      chs = chs.slice().sort(function (a, b) { return self.orderOf(a) - self.orderOf(b) || a.index - b.index; });
      if (adaptive) chs = chs.slice().sort(byScore(this.scores));
      const v: Group = { key: g.key, title: g.title, channels: chs, favourites: false };
      list.push(v);
      map[g.key] = v;
    }
    if (list.length) {
      let all = this.channels.filter(function (c) { return !c.primary && hg[c.group] === undefined && !self.isHidden(c); });
      all = all.slice().sort(function (a, b) { return a.index - b.index; });
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
    const seen: { [k: string]: true } = {};
    for (let i = 0; i < this.favourites.length; i++) {
      const c = this.byKey[this.favourites[i]];
      if (c && !seen[c.key] && !this.isHidden(c)) { seen[c.key] = true; out.push(c); }
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
    for (let i = 0; i < this.channels.length; i++) {
      const c = this.channels[i];
      if (c.num === num && !c.primary && !this.isHidden(c)) return c;
    }
    return null;
  }

  // ---- избранное
  isFavorite(ch: Channel) {
    const k = this.resolveKey(ch.key);
    for (let i = 0; i < this.favourites.length; i++) if (this.resolveKey(this.favourites[i]) === k) return true;
    return false;
  }
  toggleFavorite(ch: Channel) {
    const k = this.resolveKey(ch.key);
    if (this.isFavorite(ch)) {
      this.favourites = this.favourites.filter((f) => this.resolveKey(f) !== k);
    } else {
      this.favourites.push(ch.key);
    }
    UserData.saveFavorites(this.playlist.id, this.favourites);
    this.refreshFavorites();
  }
  /** Сдвиг в избранном: −1 вверх, +1 вниз */
  moveFavorite(ch: Channel, dir: number) {
    const key = this.resolveKey(ch.key);
    let i = this.favourites.findIndex((f) => this.resolveKey(f) === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.favourites.length) return;
    this.favourites[i] = this.favourites[j];
    this.favourites[j] = ch.key;
    UserData.saveFavorites(this.playlist.id, this.favourites);
    this.refreshFavorites();
  }

  // ---- история
  addHistory(ch: Channel) {
    const key = this.resolveKey(ch.key);
    const i = this.history.indexOf(key);
    if (i >= 0) this.history.splice(i, 1);
    this.history.unshift(key);
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
    const seen: { [k: string]: true } = {};
    for (let i = 0; i < this.history.length && out.length < HISTORY_SIZE - 1; i++) {
      const c = this.byKey[this.history[i]];
      if (c && c !== current && !seen[c.key] && !this.isHidden(c)) { seen[c.key] = true; out.push(c); }
    }
    return out;
  }

  // ---- скрытое

  /** Головной канал и все его дубли качества */
  private family(ch: Channel): Channel[] {
    const p = ch.primary || ch;
    return [p].concat(p.alts);
  }

  isHidden(ch: Channel) {
    const list = this.family(ch);
    for (let i = 0; i < list.length; i++) if (this.hiddenChannels[list[i].key] !== undefined) return true;
    return false;
  }
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
  isChannelLocked(ch: Channel) {
    const list = this.family(ch);
    for (let i = 0; i < list.length; i++) if (this.lockedChannels.indexOf(list[i].key) >= 0) return true;
    return false;
  }
  isGroupLocked(key: string) { return this.lockedGroups.indexOf(key) >= 0; }
  /** Канал заблокирован сам или его категория */
  isLocked(ch: Channel) { return Prefs.pin !== '' && (this.isChannelLocked(ch) || this.lockedGroups.indexOf(ch.groupKey) >= 0); }
  setLocked(kind: string, key: string, on: boolean) {
    const l = kind === 'group' ? this.lockedGroups : this.lockedChannels;
    const i = l.indexOf(key);
    if (on && i < 0) l.push(key);
    if (!on && i >= 0) l.splice(i, 1);
    UserData.saveLocked(this.playlist.id, kind, l);
  }

  // ---- своё имя, номер и порядок

  private orderOf(c: Channel): number {
    const n = this.orders[orderKey(c)];
    return typeof n === 'number' ? n : c.index;
  }

  /** Переименовать канал; пустое имя — вернуть имя провайдера. Ключ канала не меняется */
  renameChannel(ch: Channel, name: string) {
    const n = name.trim();
    if (!n || n === ch.origName) {
      delete this.names[ch.key];
      ch.name = ch.origName;
    } else {
      this.names[ch.key] = n;
      ch.name = n;
    }
    if (this.hiddenChannels[ch.key] !== undefined) {
      this.hiddenChannels[ch.key] = ch.name;
      UserData.saveHidden(this.playlist.id, 'channel', this.hiddenChannels);
    }
    UserData.saveNames(this.playlist.id, this.names);
    Reminders.rename(ch.key, ch.name, ch.num);
  }

  /** Свой номер; 0 — вернуть номер провайдера */
  setChannelNumber(ch: Channel, num: number) {
    const n = Math.floor(num);
    if (!isFinite(n) || n <= 0 || n === ch.origNum) {
      delete this.numbers[ch.key];
      ch.num = ch.origNum;
    } else {
      this.numbers[ch.key] = n;
      ch.num = n;
    }
    UserData.saveNumbers(this.playlist.id, this.numbers);
    Reminders.rename(ch.key, ch.name, ch.num);
  }

  /** Сдвиг канала внутри его категории: −1 вверх, +1 вниз */
  moveChannel(ch: Channel, dir: number) {
    const g = this.group(ch.groupKey);
    if (!g) return;
    const list = g.channels.slice();
    const i = list.indexOf(ch);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const t = list[i]; list[i] = list[j]; list[j] = t;
    for (let k = 0; k < list.length; k++) this.orders[orderKey(list[k])] = k;
    UserData.saveOrders(this.playlist.id, this.orders);
    this.applyView();
  }

  // ---- адаптивная сортировка
  addScore(ch: Channel) {
    this.scores[ch.key] = (this.scores[ch.key] || 0) + 1;
    UserData.saveScores(this.playlist.id, this.scores);
  }
  popular(limit = POPULAR_SIZE): Channel[] {
    const s = this.scores;
    return this.channels.filter(function (c) { return !c.primary && (s[c.key] || 0) > 0; }).sort(byScore(s)).slice(0, limit);
  }
  resetScores() {
    this.scores = {};
    UserData.saveScores(this.playlist.id, this.scores);
  }
}
