import { platform } from '../platform';

/**
 * Хранилище записей (docs/TZ.md, §2 «Хранение»). Где оно лежит, решает платформа (PlatformApi.db):
 * на webOS — файлы JS-сервиса, в браузере — IndexedDB (src/core/data/idb.ts).
 *   playlists  id                    Playlist (без каналов)
 *   channels   pid                   {pid, list: RawChannel[]}
 *   sources    url                   источник EPG: loadedAt, loadId, etag, lastModified, error, count
 *   epgch      [s, id]               канал XMLTV: names, icon
 *   prog       [s, x, l, n]          пачка передач канала x источника s загрузки l: p = [[start, stop, title, sub, desc, cat, icon]]
 *   map        [pid, s]              сопоставление каналов плейлиста с источником: m = {ключ канала: xml_id}
 */

/** Диапазон ключей — простой объект (IDBKeyRange есть не везде, а его поля только для чтения) */
export interface KeyRange { lower?: any; upper?: any; lowerOpen?: boolean; upperOpen?: boolean }
export interface FileRecord<T> { key: any; value: T }

export interface RecordDb {
  get<T>(store: string, key: any): Promise<T | undefined>;
  put(store: string, value: any): Promise<void>;
  /** Несколько записей разом (одной транзакцией, где это есть) */
  putAll(store: string, values: any[]): Promise<void>;
  delete(store: string, key: any): Promise<void>;
  all<T>(store: string, range?: KeyRange): Promise<T[]>;
  /** filter(value) → true — удалить; ответ — сколько удалено */
  deleteWhere(store: string, range: KeyRange | null, filter: (v: any) => boolean): Promise<number>;
  deleteRange(store: string, range: KeyRange): Promise<void>;
  /** Удалить всё (сброс данных) */
  drop(): Promise<void>;
}

/** Ключи с префиксом: [a, b, []] больше любых [a, b, …] (массив старше строк и чисел) */
export function prefixRange(prefix: any[]): KeyRange {
  return { lower: prefix, upper: prefix.concat([[]]) };
}

/** Все ключи не меньше v */
export function lowerBound(v: any): KeyRange { return { lower: v }; }

/** Ключ записи по схеме выше */
export function recordKey(store: string, v: any): any {
  if (store === 'playlists') return v.id;
  if (store === 'channels') return v.pid;
  if (store === 'sources') return v.url;
  if (store === 'epgch') return [v.s, v.id];
  if (store === 'prog') return [v.s, v.x, v.l, v.n];
  if (store === 'map') return [v.pid, v.s];
  throw new Error('unknown store: ' + store);
}

/** Хранилище текущей платформы */
export const Db: RecordDb = {
  get: function (store, key) { return platform().db.get(store, key); },
  put: function (store, value) { return platform().db.put(store, value); },
  putAll: function (store, values) { return values.length ? platform().db.putAll(store, values) : Promise.resolve(); },
  delete: function (store, key) { return platform().db.delete(store, key); },
  all: function (store, range) { return platform().db.all(store, range); },
  deleteWhere: function (store, range, filter) { return platform().db.deleteWhere(store, range, filter); },
  deleteRange: function (store, range) { return platform().db.deleteRange(store, range); },
  drop: function () { return platform().db.drop(); },
} as RecordDb;
