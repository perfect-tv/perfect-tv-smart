import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileDb } from '../src/data/filedb';
import { Net } from '../src/core/net';
import { packChannels, unpackChannels } from '../src/data/compact';

const oldXhr = (globalThis as any).XMLHttpRequest;
const saved: { [store: string]: { [key: string]: { key: any; value: any } } } = {};
let enabled = false;
let writeBatches = 0;

class MockXHR {
  method = '';
  address = '';
  timeout = 0;
  status = 0;
  responseText = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(method: string, url: string) { this.method = method; this.address = url; }
  setRequestHeader(_key: string, _value: string) { /* */ }
  send(body: string | null) {
    const self = this;
    setTimeout(function () {
      try {
        const path = self.address.split('/_db/')[1];
        const cmd = path.split('?')[0];
        const data = body ? JSON.parse(body) : {};
        const store = data.store || '';
        if (!saved[store]) saved[store] = {};
        let result: any = { ok: true };
        if (cmd === 'status') result.active = enabled;
        else if (cmd === 'put') {
          writeBatches++;
          for (const item of data.items) saved[store][JSON.stringify(item.key)] = item;
          enabled = true;
        } else if (cmd === 'get') {
          const q = path.split('?')[1].split('&');
          const fields: { [key: string]: string } = {};
          for (const f of q) { const bits = f.split('='); fields[bits[0]] = decodeURIComponent(bits[1]); }
          result.record = (saved[fields.store] || {})[JSON.stringify(JSON.parse(fields.key))] || null;
        } else if (cmd === 'list') {
          result.records = Object.keys(saved[store]).map(function (key) { return saved[store][key]; });
        } else if (cmd === 'delete') {
          for (const key of data.keys) delete saved[store][JSON.stringify(key)];
        } else if (cmd === 'reset') { enabled = false; Object.keys(saved).forEach(function (k) { delete saved[k]; }); }
        else throw new Error('mock unknown command: ' + cmd);
        self.status = 200;
        self.responseText = JSON.stringify(result);
        if (self.onload) self.onload();
      } catch (e) {
        if (self.onerror) self.onerror();
      }
    }, 0);
  }
}

beforeAll(function () {
  (globalThis as any).XMLHttpRequest = MockXHR;
  Net.setProxy(true);
  FileDb.resetStatus();
});
afterAll(function () {
  Net.setProxy(false);
  FileDb.resetStatus();
  (globalThis as any).XMLHttpRequest = oldXhr;
});

describe('Файловый транспорт клиента через Node webOS', function () {
  it('переключается после первой записи и читает gzip-байты плейлиста без потерь', async function () {
    expect(await FileDb.active()).toBe(false);
    const list: any[] = [];
    for (let i = 0; i < 2000; i++) list.push({ num: i, name: 'Канал ' + i, url: 'https://example.test/' + i, group: '', logo: '', tvgId: '', tvgName: '', tvgShift: 0, catchup: null, userAgent: '', referrer: '', headersJson: '' });
    const packed = packChannels(1, list);
    await FileDb.put('channels', [{ key: 1, value: packed }]);
    expect(await FileDb.active()).toBe(true);
    expect(unpackChannels((await FileDb.get<any>('channels', 1)).value)).toEqual(list);
  });
  it('после перезапуска клиента читает существующие файлы', async function () {
    FileDb.resetStatus();
    expect(await FileDb.active()).toBe(true);
    expect((await FileDb.list<any>('channels')).length).toBe(1);
  });
  it('пишет большие пачки последовательными HTTP-запросами', async function () {
    const records = [];
    for (let i = 0; i < 95; i++) records.push({ key: i, value: { id: i, name: 'Тестовый плейлист ' + i } });
    const before = writeBatches;
    await FileDb.put('playlists', records);
    expect(writeBatches - before).toBe(3);
    expect((await FileDb.list<any>('playlists')).length).toBe(95);
    await FileDb.delete('playlists', [0, 94]);
    expect((await FileDb.list<any>('playlists')).length).toBe(93);
  });
});
