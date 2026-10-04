import { Net, PROXY } from '../core/net';

/**
 * Файловое хранилище через работающий локальный Node-сервис webOS.
 * Используется после переполнения IndexedDB; сервис хранит файлы в /media/internal.
 * Старые webOS/Chromium: XHR и ES5, без fetch, URL, Blob, atob-streams.
 */
export interface FileRecord<T> { key: any; value: T }
export interface KeyRange { lower?: any; upper?: any; lowerOpen?: boolean; upperOpen?: boolean }
let activeCheck: Promise<boolean> | null = null;
let fileActive = false;

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 4096) {
    let part = '';
    for (let j = i; j < i + 4096 && j < bytes.length; j++) part += String.fromCharCode(bytes[j]);
    parts.push(part);
  }
  return btoa(parts.join(''));
}
function unbase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function encode(value: any): any {
  if (!value || !(value.data instanceof Uint8Array)) return value;
  const v: any = {};
  for (const k in value) if (Object.prototype.hasOwnProperty.call(value, k)) v[k] = value[k];
  v.data = base64(value.data);
  v.__ptBinary = 1;
  return v;
}
function decode(value: any): any {
  if (!value || value.__ptBinary !== 1) return value;
  const v: any = {};
  for (const k in value) if (Object.prototype.hasOwnProperty.call(value, k) && k !== '__ptBinary') v[k] = value[k];
  v.data = unbase64(value.data);
  return v;
}
function send(method: string, route: string, payload?: any): Promise<any> {
  return new Promise(function (resolve, reject) {
    const x = new XMLHttpRequest();
    x.open(method, PROXY + '/_db/' + route, true);
    x.timeout = 60000;
    if (method === 'POST') x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
    x.onload = function () {
      let r: any;
      try { r = JSON.parse(x.responseText); }
      catch (e) { reject(new Error('file storage invalid response')); return; }
      if (x.status !== 200 || !r.ok) { reject(new Error('file storage ' + route + ': ' + (r.error || x.status))); return; }
      resolve(r);
    };
    x.onerror = function () { reject(new Error('file storage HTTP unavailable')); };
    x.ontimeout = function () { reject(new Error('file storage timeout')); };
    try { x.send(payload === undefined ? null : JSON.stringify(payload)); }
    catch (e) { reject(e); }
  });
}

function pathParam(key: any) { return encodeURIComponent(JSON.stringify(key)); }

export const FileDb = {
  available(): boolean { return Net.proxyAvailable && typeof XMLHttpRequest !== 'undefined'; },
  /** Один запрос на весь жизненный цикл потока, файловый режим сохраняется на диске. */
  active(): Promise<boolean> {
    if (!FileDb.available()) return Promise.resolve(false);
    if (fileActive) return Promise.resolve(true);
    if (!activeCheck) {
      activeCheck = send('GET', 'status').then(function (r) {
        fileActive = !!r.active;
        if (fileActive) console.log('storage: Node files active');
        return fileActive;
      }, function (e) {
        console.warn('file storage status', e);
        activeCheck = null;
        return false;
      });
    }
    return activeCheck;
  },
  /** Реальная запись сразу активирует режим для следующих транзакций. */
  put(store: string, values: FileRecord<any>[]): Promise<void> {
    if (!FileDb.available()) return Promise.reject(new Error('file storage service unavailable'));
    let pos = 0;
    function batch(): Promise<void> {
      if (pos >= values.length) { fileActive = true; return Promise.resolve(); }
      const items = [];
      let size = 0;
      while (pos < values.length && items.length < 40) {
        const r = values[pos];
        const item = { key: r.key, value: encode(r.value) };
        const estimate = JSON.stringify(item).length;
        if (items.length > 0 && size + estimate > 420000) break;
        items.push(item);
        size += estimate;
        pos++;
      }
      return send('POST', 'put', { store: store, items: items }).then(function () {
        if (!fileActive) console.log('storage: Node filesystem write ok', store);
        fileActive = true;
        return batch();
      });
    }
    return batch();
  },
  get<T>(store: string, key: any): Promise<{ present: boolean; value?: T }> {
    if (!FileDb.available()) return Promise.resolve({ present: false });
    return send('GET', 'get?store=' + encodeURIComponent(store) + '&key=' + pathParam(key)).then(function (r) {
      return r.record ? { present: true, value: decode(r.record.value) as T } : { present: false };
    });
  },
  list<T>(store: string, range?: KeyRange): Promise<FileRecord<T>[]> {
    if (!FileDb.available()) return Promise.resolve([]);
    return send('POST', 'list', { store: store, range: range || null }).then(function (r) {
      return (r.records || []).map(function (v: any) { return { key: v.key, value: decode(v.value) as T }; });
    });
  },
  delete(store: string, keys: any[]): Promise<void> {
    if (!FileDb.available() || !keys.length) return Promise.resolve();
    let i = 0;
    function batch(): Promise<void> {
      if (i >= keys.length) return Promise.resolve();
      const slice = keys.slice(i, i + 300);
      i += slice.length;
      return send('POST', 'delete', { store: store, keys: slice }).then(batch);
    }
    return batch();
  },
  deleteRange(store: string, range: KeyRange): Promise<void> {
    if (!FileDb.available()) return Promise.resolve();
    return send('POST', 'deleteRange', { store: store, range: range }).then(function () { /* */ });
  },
  reset(): Promise<void> {
    if (!FileDb.available()) { fileActive = false; activeCheck = null; return Promise.resolve(); }
    return send('POST', 'reset').then(function () { fileActive = false; activeCheck = null; });
  },
  /** Тестовый сброс временного кеша состояния (без удаления данных). */
  resetStatus() { fileActive = false; activeCheck = null; },
};

/** В IndexedDB KeyRange свойства открыты только для чтения, берём их явно. */
export function asRange(r?: IDBKeyRange): KeyRange | undefined {
  if (!r) return undefined;
  const out: KeyRange = {};
  if (r.lower !== undefined) { out.lower = r.lower; out.lowerOpen = r.lowerOpen; }
  if (r.upper !== undefined) { out.upper = r.upper; out.upperOpen = r.upperOpen; }
  return out;
}
