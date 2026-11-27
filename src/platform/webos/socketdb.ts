/**
 * SQLite3 transport: WebSocket to local JS service (Node 0.12 compatible).
 * No IndexedDB/localStorage writes. Works in main window and EPG Worker.
 * ES5 output; no URL, fetch, TextEncoder, Buffer, or modern WebSocket APIs.
 */
import { FileRecord, KeyRange } from '../../core/data/db';
import { Luna } from './luna';

const WS_URL = 'ws://127.0.0.1:47380/db';
let socket: WebSocket | null = null;
let connecting: Promise<boolean> | null = null;
let ready = false;
let sequence = 1;
interface Pending { resolve: (v: any) => void; reject: (err: Error) => void; timer: any }
let pending: { [id: number]: Pending } = {};

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 4096) {
    let s = '';
    for (let j = i; j < i + 4096 && j < bytes.length; j++) s += String.fromCharCode(bytes[j]);
    parts.push(s);
  }
  return btoa(parts.join(''));
}
function unbase64(text: string): Uint8Array {
  const raw = atob(text), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function encode(value: any): any {
  if (!value || !(value.data instanceof Uint8Array)) return value;
  const out: any = {};
  for (const k in value) if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = value[k];
  out.data = base64(value.data);
  out.__ptBinary = 1;
  return out;
}
function decode(value: any): any {
  if (!value || value.__ptBinary !== 1) return value;
  const out: any = {};
  for (const k in value) if (Object.prototype.hasOwnProperty.call(value, k) && k !== '__ptBinary') out[k] = value[k];
  out.data = unbase64(value.data);
  return out;
}
function disconnect(error: string) {
  ready = false;
  socket = null;
  connecting = null;
  const current = pending; pending = {};
  for (const id in current) {
    clearTimeout(current[id].timer);
    current[id].reject(new Error('SQLite WebSocket: ' + error));
  }
}
function raw(op: string, data?: any): Promise<any> {
  return new Promise(function (resolve, reject) {
    if (!ready || !socket || socket.readyState !== 1) { reject(new Error('SQLite WebSocket disconnected')); return; }
    const id = sequence++;
    const timer = setTimeout(function () {
      const p = pending[id];
      if (p) { delete pending[id]; p.reject(new Error('SQLite timeout ' + op)); }
    }, 45000);
    pending[id] = { resolve: resolve, reject: reject, timer: timer };
    const msg: any = { id: id, op: op };
    if (data) for (const k in data) if (Object.prototype.hasOwnProperty.call(data, k)) msg[k] = data[k];
    try { socket.send(JSON.stringify(msg)); }
    catch (e) { clearTimeout(timer); delete pending[id]; reject(e); }
  });
}
function connectOnce(timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>(function (resolve) {
    if (typeof WebSocket === 'undefined') { resolve(false); return; }
    let ws: WebSocket;
    try { ws = new WebSocket(WS_URL); } catch (e) { console.warn('sqlite websocket create', e); resolve(false); return; }
    let settled = false;
    const deadline = setTimeout(function () {
      if (!settled) { settled = true; console.warn('sqlite websocket connect timeout'); try { ws.close(); } catch (e) { /* */ } resolve(false); }
    }, timeoutMs);
    function complete(ok: boolean) {
      if (settled) return;
      settled = true; clearTimeout(deadline); resolve(ok);
    }
    ws.onopen = function () {
      socket = ws; ready = true;
      raw('status').then(function (state) {
        if (state.backend !== 'files' && state.backend !== 'SQLite3') { complete(false); ws.close(); return; }
        console.log('storage ready', state.backend, state.entries);
        complete(true);
      }, function (e) { console.warn('sqlite status', e); complete(false); ws.close(); });
    };
    ws.onmessage = function (e) {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch (err) { console.warn('SQLite invalid reply'); return; }
      const p = pending[msg.id]; if (!p) return;
      delete pending[msg.id]; clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error('SQLite ' + (msg.error || 'unknown error')));
    };
    ws.onerror = function () { complete(false); };
    ws.onclose = function () { complete(false); if (socket === ws) disconnect('closed'); };
  });
}
function connect(): Promise<boolean> {
  if (ready && socket && socket.readyState === 1) return Promise.resolve(true);
  if (connecting) return connecting;
  const maxTries = Luna.isWebOS ? 4 : 1;
  let attempt = 0;
  function tryConnect(): Promise<boolean> {
    attempt++;
    return connectOnce(3500).then(function (ok) {
      if (ok || attempt >= maxTries) return ok;
      // Сервис мог перезапускаться после чтения кода загрузчиком — разбудить и повторить
      if ((Luna as any).ensureService) (Luna as any).ensureService();
      return new Promise<boolean>(function (r) { setTimeout(function () { r(tryConnect()); }, 600); });
    });
  }
  connecting = tryConnect().then(function (ok) {
    if (!ok) connecting = null;
    return ok;
  });
  return connecting;
}
function request(op: string, data?: any): Promise<any> {
  return connect().then(function (ok) {
    if (!ok) throw new Error('SQLite WebSocket unavailable');
    return raw(op, data);
  });
}
export const SocketDb = {
  available(): Promise<boolean> { return connect(); },
  /** Сколько занимает хранилище на диске ТВ, байт (сервис обходит папку — не на каждый кадр) */
  storageBytes(): Promise<number> { return request('status', { size: true }).then(function (r) { return typeof r.bytes === 'number' ? r.bytes : -1; }); },
  epgStart(options: any): Promise<any> { return request('epgStart', options); },
  epgStatus(jobId: number): Promise<any> { return request('epgStatus', { jobId: jobId }); },
  epgRematch(url: string, wanted: any[]): Promise<void> {
    return request('epgRematch', { url: url, wanted: wanted }).then(function () { /* */ });
  },
  get<T>(store: string, key: any): Promise<{ present: boolean; value?: T }> {
    return request('get', { store: store, key: key }).then(function (r) {
      return r.record ? { present: true, value: decode(r.record.value) as T } : { present: false };
    });
  },
  put(store: string, values: FileRecord<any>[]): Promise<void> {
    if (!values.length) return Promise.resolve();
    let index = 0;
    function batch(): Promise<void> {
      if (index >= values.length) return Promise.resolve();
      const rows: FileRecord<any>[] = [];
      let length = 0;
      while (index < values.length && rows.length < 100) {
        const r = values[index];
        const item = { key: r.key, value: encode(r.value) };
        const estimate = JSON.stringify(item).length;
        if (rows.length && length + estimate > 430000) break;
        length += estimate; rows.push(item); index++;
      }
      return request('put', { store: store, items: rows }).then(function () { return batch(); });
    }
    return batch();
  },
  all<T>(store: string, range?: KeyRange): Promise<FileRecord<T>[]> {
    const records: FileRecord<T>[] = [];
    function next(offset: number): Promise<FileRecord<T>[]> {
      return request('list', { store: store, range: range || null, offset: offset, limit: 100 }).then(function (r) {
        const rows = r.records || [];
        for (let i = 0; i < rows.length; i++) records.push({ key: rows[i].key, value: decode(rows[i].value) as T });
        return r.next === null || r.next === undefined ? records : next(r.next);
      });
    }
    return next(0);
  },
  delete(store: string, keys: any[]): Promise<void> {
    let pos = 0;
    function batch(): Promise<void> {
      if (pos >= keys.length) return Promise.resolve();
      const chunk = keys.slice(pos, pos + 200); pos += chunk.length;
      return request('delete', { store: store, keys: chunk }).then(function () { return batch(); });
    }
    return batch();
  },
  deleteRange(store: string, range: KeyRange): Promise<void> {
    return request('deleteRange', { store: store, range: range }).then(function () { /* */ });
  },
  reset(): Promise<void> { return request('reset').then(function () { /* */ }); },
  resetStatus() { if (socket) socket.close(); disconnect('reset'); },
};
