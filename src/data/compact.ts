import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import { RawChannel } from './m3u';

/**
 * Хранение больших списков на старых webOS: массивы JSON с gzip гораздо меньше
 * структурированного клона из тысяч однотипных объектов в IndexedDB.
 * Старые записи {pid,list} и {s,x,l,n,p} читаются без миграции/сброса настроек.
 */
export interface ChannelRecord {
  pid: number;
  list?: RawChannel[];
  codec?: string;
  data?: Uint8Array;
}

function bytes(value: any): Uint8Array {
  // После структурированного клонирования IndexedDB должен вернуть Uint8Array.
  // ArrayBuffer поддерживается для совместимости с реализациями старых WebKit.
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('invalid compressed record');
}

export function packChannels(pid: number, list: RawChannel[]): ChannelRecord {
  const json = strToU8(JSON.stringify(list));
  const data = gzipSync(json, { level: 3 });
  console.log('playlist packed', list.length, 'channels', json.length, '->', data.length, 'bytes');
  return { pid: pid, codec: 'gzip-json-1', data: data };
}

export function unpackChannels(rec: ChannelRecord | undefined): RawChannel[] {
  if (!rec) return [];
  if (rec.list) return rec.list; // Совместимость с версиями 1.0.2–1.0.4.
  if (rec.codec !== 'gzip-json-1') throw new Error('unknown channels codec');
  return JSON.parse(strFromU8(gunzipSync(bytes(rec.data))));
}

export interface ProgrammePack {
  s: string;
  x: string;
  l: number;
  n: number;
  p?: any[];
  codec?: string;
  data?: Uint8Array | string;
}

export function packProgramme(v: ProgrammePack): ProgrammePack {
  const data = gzipSync(strToU8(JSON.stringify(v.p || [])), { level: 1 });
  return { s: v.s, x: v.x, l: v.l, n: v.n, codec: 'gzip-json-1', data: data };
}

export function unpackProgramme(v: ProgrammePack): any[] {
  if (v.p) return v.p;
  if (v.codec === 'gzip-json-b64-1') {
    if (typeof v.data !== 'string') throw new Error('invalid EPG base64');
    const raw = atob(v.data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return JSON.parse(strFromU8(gunzipSync(bytes)));
  }
  if (v.codec !== 'gzip-json-1') throw new Error('unknown EPG codec');
  return JSON.parse(strFromU8(gunzipSync(bytes(v.data))));
}
