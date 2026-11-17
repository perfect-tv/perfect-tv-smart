import { Storage2 } from './storage';
import { platform } from './platform';

/**
 * Настройки и «где остановились». Хранятся в SQLite3 через синхронный кэш Storage2 одним объектом `prefs`
 * (ключи — как в Android-версии, чтобы резервная копия читалась одинаково).
 */
type V = string | number | boolean;
let cache: { [k: string]: V } | null = null;

function all(): { [k: string]: V } {
  if (!cache) cache = Storage2.json<{ [k: string]: V }>('prefs', {});
  return cache;
}
function save() { Storage2.setJson('prefs', all()); }
function int(k: string, def: number, min?: number, max?: number): number {
  const v = all()[k];
  let n = typeof v === 'number' ? v : def;
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
}
function bool(k: string, def: boolean): boolean { const v = all()[k]; return typeof v === 'boolean' ? v : def; }
function str(k: string, def: string): string { const v = all()[k]; return typeof v === 'string' ? v : def; }
function put(k: string, v: V) { all()[k] = v; save(); }

export const NUMBER_NONE = 0;
export const NUMBER_NEAR_NAME = 1;
export const NUMBER_BADGE = 2;

export const TMDB_API = 'https://api.themoviedb.org/3';
export const TMDB_IMAGES = 'https://image.tmdb.org';

export const Prefs = {
  /** Все настройки — для резервной копии */
  all(): { [k: string]: V } { return Object.assign({}, all()); },
  replace(values: { [k: string]: V }) { cache = Object.assign({}, values); save(); },
  reload() { cache = null; },

  /** Глубина архива, если в плейлисте не указана, дней */
  get archiveDays() { return int('archive_days', 3, 1, 30); }, set archiveDays(v: number) { put('archive_days', v); },
  /** ↑ в плеере: true — программа и архив, false — недавние каналы */
  get upArchive() { return bool('up_archive', true); }, set upArchive(v: boolean) { put('up_archive', v); },
  /** За сколько минут напоминать (0 — когда начнётся) */
  get remindBefore() { return int('remind_before', 1); }, set remindBefore(v: number) { put('remind_before', v); },
  /** Автоскрытие инфопанели, с */
  get infoHide() { return int('info_hide', 5); }, set infoHide(v: number) { put('info_hide', v); },
  get keyHints() { return bool('key_hints', true); }, set keyHints(v: boolean) { put('key_hints', v); },
  /** Бегущая строка: выделенное название, не влезающее в ширину, прокручивается (иначе — «…») */
  get marquee() { return bool('marquee', false); }, set marquee(v: boolean) { put('marquee', v); },
  /** Формат кадра: 0 — вписать, 1 — растянуть, 2 — увеличить */
  get aspect() { return int('aspect', 0, 0, 2); }, set aspect(v: number) { put('aspect', v); },
  get audioLang() { return str('audio_lang', ''); }, set audioLang(v: string) { put('audio_lang', v); },
  get subtitleLang() { return str('subtitle_lang', ''); }, set subtitleLang(v: string) { put('subtitle_lang', v); },
  /** Размер интерфейса: 0 — меньше, 1 — нормальный, 2 — больше (экран — 54 / 48 / 43,2 em) */
  get uiScale() { return int('ui_scale', 1, 0, 2); }, set uiScale(v: number) { put('ui_scale', v); },
  /** Высота экрана в em (1 em = высота / screenEm) */
  get screenEm() { const s = int('ui_scale', 1, 0, 2); return s === 0 ? 54 : s === 2 ? 43.2 : 48; },
  get searchRecent(): string[] { return str('search_recent', '').split('\n').filter(function (s) { return s.length > 0; }); },
  set searchRecent(v: string[]) { put('search_recent', v.join('\n')); },
  get keyboardAbc() { return bool('keyboard_abc', false); }, set keyboardAbc(v: boolean) { put('keyboard_abc', v); },
  /** Приоритет логотипов: 0 — плейлист, 1 — программа */
  get logoPriority() { return int('logo_priority', 0, 0, 1); }, set logoPriority(v: number) { put('logo_priority', v); },
  /** Шапка гида: 0 — канал и передача, 1 — канал, 2 — скрыть */
  get guideHeader() { return int('guide_header', 0, 0, 2); }, set guideHeader(v: number) { put('guide_header', v); },
  get guideDesc() { return bool('guide_desc', false); }, set guideDesc(v: boolean) { put('guide_desc', v); },
  /**
   * «Облегчённый интерфейс»: 0 — выкл, 1 — без анимаций, 2 — без анимаций и прозрачности.
   * Раньше была только «Плавные анимации» (animations): выключенная — это 1
   */
  get lite() { return int('lite', bool('animations', true) ? 0 : 1, 0, 2); }, set lite(v: number) { put('lite', v); },
  get animations() { return Prefs.lite === 0; },
  get adaptiveSort() { return bool('adaptive_sort', false); }, set adaptiveSort(v: boolean) { put('adaptive_sort', v); },
  /** Вид гида: 0 — ТВ-гид, 1 — Каналы + программа, 2 — Категории + каналы, 3 — Каналы */
  get guideMode() { return int('guide_mode', 0, 0, 3); }, set guideMode(v: number) { put('guide_mode', v); },
  get epgRefreshHours() { return int('epg_refresh', 12); }, set epgRefreshHours(v: number) { put('epg_refresh', v); },
  get playlistRefreshHours() { return int('playlist_refresh', 24); }, set playlistRefreshHours(v: number) { put('playlist_refresh', v); },
  /** PIN блокировки; пусто — блокировка выключена */
  get pin() { return str('pin', ''); }, set pin(v: string) { put('pin', v); },
  /** Спрашивать PIN: true — каждый раз, false — один раз до выхода */
  get pinEveryTime() { return bool('pin_every', false); }, set pinEveryTime(v: boolean) { put('pin_every', v); },
  /** Ввод PIN: 0 — кольцо, 1 — ряды, 2 — клавиатура */
  get pinInput() { return int('pin_input', 2, 0, 2); }, set pinInput(v: number) { put('pin_input', v); },
  get tmdbKey() { return str('tmdb_key', ''); }, set tmdbKey(v: string) { put('tmdb_key', v.trim()); },
  get tmdbApi() { return str('tmdb_api', '') || TMDB_API; }, set tmdbApi(v: string) { put('tmdb_api', v.trim()); },
  get tmdbImages() { return str('tmdb_images', '') || TMDB_IMAGES; }, set tmdbImages(v: string) { put('tmdb_images', v.trim()); },
  /** При запуске — сразу последний канал (иначе — гид) */
  get autoplayLast() { return bool('autoplay_last', true); }, set autoplayLast(v: boolean) { put('autoplay_last', v); },
  /** Язык интерфейса: "" — системный, "ru", "en" */
  get language() { return str('language', ''); }, set language(v: string) { put('language', v); },
  /** Номер канала: 0 — нигде, 1 — рядом с названием, 2 — бейдж на логотипе */
  get numberMode() { return int('number_mode', NUMBER_BADGE, 0, 2); }, set numberMode(v: number) { put('number_mode', v); },
  /** Прокси (JS-сервис): 0 — авто (заголовки канала и ошибки CORS), 1 — всегда, 2 — никогда */
  get proxyMode() { return int('proxy_mode', 0, 0, 2); }, set proxyMode(v: number) { put('proxy_mode', v); },
  /** Отрисовка гида: 0 — HTML (DOM, перерисовываются только изменившиеся элементы), 1 — Canvas */
  get guideRender() { return int('guide_render', 0, 0, 1); }, set guideRender(v: number) { put('guide_render', v); },
  /** HLS: 0 — hls.js, 1 — native, 2 — auto (native эфир, hls.js архив). */
  get hlsEngine() { return int('hls_engine', platform().defaultHlsEngine, 0, 2); }, set hlsEngine(v: number) { put('hls_engine', v); },

  get lastPlaylist() { return int('last_playlist', 0); }, set lastPlaylist(v: number) { put('last_playlist', v); },
  lastChannel(playlistId: number): string { return str('last_channel_' + playlistId, ''); },
  lastGroup(playlistId: number): string | null { const v = all()['last_group_' + playlistId]; return typeof v === 'string' ? v : null; },
  saveLast(playlistId: number, channelKey: string, groupKey: string) {
    all()['last_channel_' + playlistId] = channelKey;
    all()['last_group_' + playlistId] = groupKey;
    save();
  },
  /** Поправка воспроизведения канала: 0 — нет, 1 — встроенный плеер вместо hls.js */
  playFix(key: string): number { return int('play_fix_' + key, 0); },
  setPlayFix(key: string, v: number) { if (v <= 0) { delete all()['play_fix_' + key]; save(); } else put('play_fix_' + key, v); },
};
