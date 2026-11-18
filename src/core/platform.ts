import type { CodeManifest } from './codever';
import type { RecordDb } from './data/db';
import type { SourceMeta, WantedSet } from './data/loaders';
import type { Resp, StreamOpts } from './net';
import type { NativeEngine, PlaybackListener } from './player/playback';

/**
 * Платформа — всё, чем телевизоры разных марок отличаются друг от друга (docs/TZ.md, §2 «Платформы»).
 * Ядро (src/core) работает только через этот интерфейс и не знает, на чём запущено; реализация —
 * src/platform/<имя>/, она же — точка входа сборки (вызывает usePlatform, затем startApp).
 * Необязательная часть (proxy, epg, qr) — null: ядро обходится своим (прямые запросы, разбор
 * программы в браузере, без кнопки «С телефона»).
 */
export interface PlatformApi {
  /** 'webos', 'browser'… — для журнала и проверок в коде платформы */
  id: string;
  /** Строка «Платформа» в настройках: 'webOS 4.0.0', 'Chrome/120' */
  label(): string;
  /** До интерфейса: поднять сервис, перенести старые данные. Хранилище настроек ядро читает после */
  boot(): Promise<void>;
  /** Выход: в лаунчер ТВ или закрыть вкладку */
  exit(): void;
  /** Курсор пульта-указки (Magic Remote) виден */
  cursorVisible(): boolean;
  onCursor(l: (visible: boolean) => void): void;
  /** Движок HLS по умолчанию (Prefs.hlsEngine): 0 — hls.js, 2 — встроенный плеер */
  defaultHlsEngine: number;
  /** Настройки: синхронный кэш Storage2 поверх него */
  kv: KvBackend;
  /** Записи: плейлисты, каналы, источники программы, сопоставление */
  db: RecordDb;
  /** Прокси для заголовков и обхода CORS; null — только прямые запросы */
  proxy: ProxyApi | null;
  /** Своя загрузка и чтение программы; null — разбор в браузере (Loaders) и чтение из db */
  epg: EpgBackend | null;
  /** Плейлист с телефона по QR; null — кнопки нет */
  qr: QrInbox | null;
  /** Свой встроенный плеер («плеер телевизора» в настройках); null — video.src */
  nativePlayer: ((l: PlaybackListener) => NativeEngine) | null;
  /**
   * Заголовки запроса (в нижнем регистре), которые ставит сам встроенный плеер (AVPlay на Tizen:
   * user-agent, cookie). Канал с ними без прокси играет только встроенным плеером: hls.js в
   * браузере ТВ их поставить не может. [] — не умеет
   */
  nativeHeaders: string[];
  /** Сколько занимают данные приложения, байт; −1 — неизвестно */
  storageBytes(): Promise<number>;
  /** Ключи строк, где слова зависят от платформы (страница «Сеть», ошибка «нужен прокси») */
  labels: PlatformLabels;
  /**
   * Обновление кода с сайта без переустановки (core/codeupdate.ts): папка на сайте и версия API
   * своего сервиса (0 — сервиса нет). null — нет (браузер и так открывает свежий сайт)
   */
  code: CodeChannel | null;
}

export interface CodeChannel {
  /** Папка на сайте: https://perfect-tv.github.io/<dir>/version.json */
  dir: string;
  /** Версия API своего сервиса (0 — нет сервиса или неизвестна) */
  serviceApi(): number;
  /** Скачать версию с сайта (base — адрес папки со «/» в конце), проверить sha256 и сохранить для загрузчика */
  install(base: string, m: CodeManifest): Promise<void>;
  /** Забыть скачанный код: следующий запуск — встроенным */
  clear(): Promise<void>;
}

export interface PlatformLabels {
  proxy: string; proxySub: string; proxyMode: string;
  storage: string; storageSub: string;
  /** Текст ошибки need_service: прямой запрос не прошёл, а прокси нет */
  needProxy: string;
}

/** Подписи webOS — по умолчанию */
export const SERVICE_LABELS: PlatformLabels = {
  proxy: 'proxy_status', proxySub: 'proxy_status_sub', proxyMode: 'proxy_mode',
  storage: 'sqlite_storage', storageSub: 'sqlite_storage_sub', needProxy: 'need_service',
};

export interface KvBackend {
  /** Все значения; persistent = false — хранилище недоступно, новые значения живут только в памяти */
  load(): Promise<{ values: { [k: string]: string }; persistent: boolean }>;
  save(put: { key: string; value: string }[], del: string[]): Promise<void>;
  /** Полный сброс: остаются только rows */
  reset(rows: { key: string; value: string }[]): Promise<void>;
}

export interface ProxyApi {
  /** HTTP-прокси работает: url() годится для плеера и text() */
  readonly available: boolean;
  /** Проверка уже была */
  readonly checked: boolean;
  /** Адрес HTTP-прокси с протоколом сервиса webOS (/p?u=&h=) — для воркера программы; '' — нет */
  readonly base: string;
  /** Ключ строки состояния для настроек: proxy_running, proxy_luna, proxy_absent */
  state(): string;
  check(): Promise<boolean>;
  /** Адрес через прокси с заголовками запроса */
  url(url: string, headers?: { [k: string]: string } | null): string;
  /** Ответ потоком через прокси (любым транспортом платформы); нет прокси — NetError('need_service') */
  stream(url: string, opts: StreamOpts, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<Resp>;
}

export type EpgProgressFn = (read: number, total: number, programmes: number) => void;

export interface EpgBackend {
  load(url: string, wanted: WantedSet[], maxArchiveDays: number, langs: string[], force: boolean,
    onProgress: EpgProgressFn, onPack: () => void): Promise<SourceMeta | null>;
  /** Пересопоставить каналы с уже загруженным источником; отказ — ядро сопоставит само по db */
  rematch(url: string, wanted: WantedSet[]): Promise<void>;
  /** Пачки передач канала за сутки a…b (UTC); отказ — ядро читает канал из db */
  packs(s: string, x: string, a: number, b: number): Promise<any[]>;
  /** Сутки, за которые есть программа: [[день, …]]; null — неизвестно */
  days(s: string, x: string): Promise<number[][] | null>;
  /** Поиск по программе: [[номер канала в items, {l, p}], …]; отказ — ядро ищет само */
  search(words: string[], items: any[], max: number, cancelled: () => boolean): Promise<any[]>;
}

/** Что спрашивает страница телефона: плейлист (адрес и название) или программу XMLTV (адрес) */
export type QrKind = 'playlist' | 'epg';

export interface QrInbox {
  /** Временная страница для телефона: адрес для QR, метка ожидания, подсказка (ключ строки) */
  open(kind?: QrKind): Promise<{ url: string; token: string; hint?: string }>;
  /** Ссылку уже прислали — {url, name}; ещё нет — null; ошибка/истекло — отказ */
  poll(token: string): Promise<{ url: string; name: string } | null>;
  cancel(token: string): void;
}

/** Без платформы (юнит-тесты): настройки в памяти, без прокси и базы */
const memKv: KvBackend = {
  load: function () { return Promise.resolve({ values: {}, persistent: false }); },
  save: function () { return Promise.resolve(); },
  reset: function () { return Promise.resolve(); },
};
function noDb(): Promise<any> { return Promise.reject(new Error('no platform db')); }
const BARE: PlatformApi = {
  id: 'bare',
  label: function () { return typeof navigator !== 'undefined' ? navigator.userAgent : ''; },
  boot: function () { return Promise.resolve(); },
  exit: function () { /* */ },
  cursorVisible: function () { return false; },
  onCursor: function () { /* */ },
  defaultHlsEngine: 0,
  kv: memKv,
  db: { get: noDb, put: noDb, putAll: noDb, delete: noDb, all: noDb, deleteWhere: noDb, deleteRange: noDb, drop: noDb },
  proxy: null,
  epg: null,
  qr: null,
  nativePlayer: null,
  nativeHeaders: [],
  storageBytes: function () { return Promise.resolve(-1); },
  labels: SERVICE_LABELS,
  code: null,
};

let current: PlatformApi = BARE;

/** Точка входа платформы — до всего остального */
export function usePlatform(p: PlatformApi) { current = p; }

export function platform(): PlatformApi { return current; }
