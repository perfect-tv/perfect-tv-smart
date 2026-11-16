import { describe, expect, it } from 'vitest';
import { packChannels, packProgramme, unpackChannels, unpackProgramme } from '../src/core/data/compact';
import { errorCode, isQuotaError } from '../src/core/data/loaders';
import { merge } from '../src/core/data/repo';
import { RawChannel } from '../src/core/data/m3u';
import { gzipSync, strToU8 } from 'fflate';

function channel(i: number): RawChannel {
  return {
    num: i, name: 'Канал № ' + i + ' HD',
    url: 'https://cdn.example.test/very/long/path/to/live/' + i + '/index.m3u8?token=longtoken',
    group: i % 2 ? 'Кино' : 'Новости',
    logo: 'https://cdn.example.test/logos/' + i + '.png', tvgId: 'ch' + i,
    tvgName: 'Канал ' + i, tvgShift: 0,
    catchup: i % 3 ? { type: 'flussonic', source: 'https://cdn.example.test/live/{start}', days: 5 } : null,
    userAgent: '', referrer: '', headersJson: '',
  };
}

describe('Компактное хранение каналов и EPG для webOS', () => {
  it('5000 каналов с кириллицей переживают gzip и занимают меньше 1/3 JSON', () => {
    const list = Array.from({ length: 5000 }, (_, i) => channel(i + 1));
    const record = packChannels(7, list);
    expect(record.pid).toBe(7);
    expect(record.list).toBeUndefined();
    expect(record.data).toBeInstanceOf(Uint8Array);
    expect(record.data!.length).toBeLessThan(Buffer.byteLength(JSON.stringify(list), 'utf8') / 3);
    // В IndexedDB typed array клонируется через structured clone.
    const copy = { ...record, data: new Uint8Array(record.data!) };
    expect(unpackChannels(copy)).toEqual(list);
  });

  it('читаются старые записи 1.0.4 и пустой кэш', () => {
    const list = [channel(1)];
    expect(unpackChannels({ pid: 3, list })).toEqual(list);
    expect(unpackChannels(undefined)).toEqual([]);
  });

  it('пачки программы смешанных версий и кириллица читаются в merge', () => {
    const old = { s: 'epg', x: 'x', l: 1, n: 0, p: [[10, 20, 'До эфира', '', '', '', '']] };
    const fresh = { s: 'epg', x: 'x', l: 2, n: 0, p: [[20, 40, 'Новости', 'Вечер', 'Описание', 'Кино', '']] };
    const packed = packProgramme(fresh);
    expect(packed.p).toBeUndefined();
    expect(unpackProgramme(packed)).toEqual(fresh.p);
    expect(merge([old, packed], 3600)).toEqual([
      { start: 3610, stop: 3620, title: 'До эфира', subTitle: '', desc: '', category: '', icon: '' },
      { start: 3620, stop: 3640, title: 'Новости', subTitle: 'Вечер', desc: 'Описание', category: 'Кино', icon: '' },
    ]);
  });

  it('EPG packs produced by Node service decode from Base64', () => {
    const rows = [[100, 200, 'News', '', 'Test', '', '']];
    const gzip = gzipSync(strToU8(JSON.stringify(rows)));
    const base64 = Buffer.from(gzip).toString('base64');
    const rec = { s: 'url', x: 'tv', l: 1, n: 0, codec: 'gzip-json-b64-1', data: base64 };
    expect(unpackProgramme(rec)).toEqual(rows);
    expect(merge([rec], 0)).toHaveLength(1);
  });

  it('QuotaExceededError считается ошибкой хранения, а не сети', () => {
    expect(isQuotaError({ name: 'QuotaExceededError', message: 'Too much data' })).toBe(true);
    expect(errorCode({ name: 'QuotaExceededError' })).toBe('storage');
    expect(errorCode({ error: { name: 'QuotaExceededError' } })).toBe('storage');
    expect(errorCode(new Error('QuotaExceededError: no storage'))).toBe('storage');
    expect(errorCode(new Error('offline'))).toBe('network');
  });
});
