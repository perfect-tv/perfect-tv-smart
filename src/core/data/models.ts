import { Prefs, NUMBER_NEAR_NAME } from '../prefs';
import { Names } from './names';
import { RawChannel } from './m3u';

export const EPG_PLAYLIST = 0;
export const EPG_BOTH = 1;
export const EPG_USER_ONLY = 2;

/** Тип источника: обычный M3U/M3U8, Xtream Codes (сервер, логин, пароль) или Stalker/MAG (портал, MAC) */
export const SOURCE_M3U = 0;
export const SOURCE_XTREAM = 1;
export const SOURCE_STALKER = 2;

/** Плейлист из настроек */
export interface Playlist {
  id: number;
  name: string;
  /** M3U: адрес плейлиста; Xtream: адрес сервера; Stalker: рабочий адрес API (portal.php/server/load.php) */
  url: string;
  /** 0 — M3U, 1 — Xtream, 2 — Stalker/MAG; у старых записей поля нет */
  source?: number;
  /** Xtream: логин; Stalker: MAC-адрес */
  username?: string;
  /** Xtream: пароль */
  password?: string;
  /** Xtream: формат прямого потока — HLS (.m3u8) или MPEG-TS (.ts) */
  output?: 'm3u8' | 'ts';
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

export function isXtream(p: Playlist): boolean { return (p.source || SOURCE_M3U) === SOURCE_XTREAM; }
export function isStalker(p: Playlist): boolean { return (p.source || SOURCE_M3U) === SOURCE_STALKER; }

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
  /** Смещение сервера (минуты) для архива Xtream; null — часовой пояс телевизора */
  catchupOffset: number | null;
  /** Глубина архива в днях (0 — архива нет) */
  archiveDays: number;
  userAgent: string;
  referrer: string;
  headersJson: string;
  /** Stalker: команда канала для create_link (пусто — статический адрес или обычный канал) */
  stalkerCmd = '';
  stalkerPortal = '';
  stalkerMac = '';
  stalkerToken = '';
  /** Stalker: когда получена временная ссылка (unix-сек); 0 — ещё не получена */
  stalkerLinkAt = 0;
  /** Категория для навигации */
  groupKey: string;
  /** Логотип из программы (XMLTV) */
  epgIcon = '';
  /** Дубли качества: у головного канала — остальные, у дубля — головной */
  alts: Channel[] = [];
  primary: Channel | null = null;
  /** Выбранный поток: 0 — сам канал, 1… — alts[0]… */
  altIndex = 0;

  /** Имя и номер от провайдера — для сброса переименования/своего номера */
  origName: string;
  origNum: number;
  /** Порядок в исходном плейлисте (для «Все каналы» и tie-break) */
  index: number;

  constructor(id: number, playlistId: number, r: RawChannel, defaultDays: number) {
    this.id = id;
    this.playlistId = playlistId;
    this.num = r.num;
    this.origNum = r.num;
    this.index = id;
    this.key = Names.key(r.name);
    this.origName = r.name;
    this.name = r.name;
    this.url = r.url;
    this.group = r.group;
    this.logo = r.logo;
    this.tvgId = r.tvgId;
    this.tvgName = r.tvgName;
    this.tvgShift = r.tvgShift;
    this.catchupType = r.catchup ? r.catchup.type : null;
    this.catchupSource = r.catchup ? r.catchup.source : '';
    this.catchupOffset = r.catchupOffset === undefined || r.catchupOffset === null ? null : r.catchupOffset;
    this.archiveDays = r.catchup ? (r.catchup.days > 0 ? r.catchup.days : defaultDays) : 0;
    this.userAgent = r.userAgent;
    this.referrer = r.referrer;
    this.headersJson = r.headersJson;
    this.stalkerCmd = r.stalkerCmd || '';
    this.stalkerPortal = r.stalkerPortal || '';
    this.stalkerMac = r.stalkerMac || '';
    this.stalkerToken = r.stalkerToken || '';
    this.groupKey = r.group;
  }

  get hasArchive() { return this.catchupType !== null; }

  /** Источник воспроизведения: сам канал или выбранный дубль качества */
  active(): Channel {
    const a = this.alts[this.altIndex - 1];
    return a || this;
  }

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
