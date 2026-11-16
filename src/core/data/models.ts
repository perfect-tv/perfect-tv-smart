import { Prefs, NUMBER_NEAR_NAME } from '../prefs';
import { Names } from './names';
import { RawChannel } from './m3u';

export const EPG_PLAYLIST = 0;
export const EPG_BOTH = 1;
export const EPG_USER_ONLY = 2;

/** Плейлист из настроек */
export interface Playlist {
  id: number;
  name: string;
  url: string;
  epgMode: number;
  userEpg: string[];
  headerEpg: string[];
  loadedAt: number;
  channelsCount: number;
  error: string;
  etag?: string;
  lastModified?: string;
  sort: number;
}

/** Источники программы по приоритету с учётом режима */
export function epgUrlsOf(p: Playlist): string[] {
  if (p.epgMode === EPG_USER_ONLY) return p.userEpg.slice();
  if (p.epgMode === EPG_BOTH) {
    const out = p.userEpg.slice();
    for (let i = 0; i < p.headerEpg.length; i++) if (out.indexOf(p.headerEpg[i]) < 0) out.push(p.headerEpg[i]);
    return out;
  }
  return p.headerEpg.length ? p.headerEpg.slice() : p.userEpg.slice();
}

/** Канал плейлиста; key — Names.key(name): избранное, история, скрытое, блокировки, напоминания */
export class Channel {
  id: number;
  playlistId: number;
  num: number;
  key: string;
  name: string;
  url: string;
  group: string;
  logo: string;
  tvgId: string;
  tvgName: string;
  tvgShift: number;
  catchupType: string | null;
  catchupSource: string;
  /** Глубина архива в днях (0 — архива нет) */
  archiveDays: number;
  userAgent: string;
  referrer: string;
  headersJson: string;
  /** Категория для навигации */
  groupKey: string;
  /** Логотип из программы (XMLTV) */
  epgIcon = '';

  constructor(id: number, playlistId: number, r: RawChannel, defaultDays: number) {
    this.id = id;
    this.playlistId = playlistId;
    this.num = r.num;
    this.key = Names.key(r.name);
    this.name = r.name;
    this.url = r.url;
    this.group = r.group;
    this.logo = r.logo;
    this.tvgId = r.tvgId;
    this.tvgName = r.tvgName;
    this.tvgShift = r.tvgShift;
    this.catchupType = r.catchup ? r.catchup.type : null;
    this.catchupSource = r.catchup ? r.catchup.source : '';
    this.archiveDays = r.catchup ? (r.catchup.days > 0 ? r.catchup.days : defaultDays) : 0;
    this.userAgent = r.userAgent;
    this.referrer = r.referrer;
    this.headersJson = r.headersJson;
    this.groupKey = r.group;
  }

  get hasArchive() { return this.catchupType !== null; }

  /** Адреса логотипа по приоритету (настройка «Приоритет логотипов»), без пустых и повторов */
  logoUrls(): string[] {
    const a = Prefs.logoPriority === 1 ? [this.epgIcon, this.logo] : [this.logo, this.epgIcon];
    const out: string[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] && out.indexOf(a[i]) < 0) out.push(a[i]);
    return out;
  }

  /** Название для показа: с номером, если номер показывается рядом с названием */
  title(): string { return Prefs.numberMode === NUMBER_NEAR_NAME ? this.num + '. ' + this.name : this.name; }

  /** Заголовки запроса потока: User-Agent, Referer, #EXTHTTP */
  headers(): { [k: string]: string } | null {
    const h: { [k: string]: string } = {};
    let any = false;
    if (this.userAgent) { h['User-Agent'] = this.userAgent; any = true; }
    if (this.referrer) { h['Referer'] = this.referrer; any = true; }
    if (this.headersJson) {
      try {
        const o = JSON.parse(this.headersJson);
        for (const k in o) if (typeof o[k] === 'string') { h[k] = o[k]; any = true; }
      } catch (e) { /* */ }
    }
    return any ? h : null;
  }

  /** Канал-заглушка (напоминание из другого плейлиста) */
  static stub(name: string, num: number, logo: string): Channel {
    return new Channel(-1, 0, { num: num, name: name, url: '', group: '', logo: logo, tvgId: '', tvgName: '', tvgShift: 0, catchup: null, userAgent: '', referrer: '', headersJson: '' }, 0);
  }
}

/** Передача (время — unix-секунды) */
export interface Programme {
  start: number;
  stop: number;
  title: string;
  subTitle: string;
  desc: string;
  category: string;
  icon: string;
}

export function contains(p: Programme, t: number): boolean { return t >= p.start && t < p.stop; }
