import { describe, it, expect, vi } from 'vitest';
import { Loaders, EpgRequest, WantedSet } from '../src/core/data/loaders';
import { Net } from '../src/core/net';

function xmlTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = function (n: number) { return n < 10 ? '0' + n : String(n); };
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + ' +0000';
}

describe('ручная привязка к программе', () => {
  it('epgId выбирает канал XMLTV независимо от matcher', async () => {
    const now = Math.floor(Date.now() / 1000);
    const xml = '<?xml version="1.0" encoding="UTF-8"?><tv>' +
      '<channel id="auto"><display-name>Авто</display-name></channel>' +
      '<channel id="manual"><display-name>Ручной</display-name><icon src="http://logo"/></channel>' +
      '<programme start="' + xmlTime(now - 60) + '" stop="' + xmlTime(now + 3600) + '" channel="auto"><title>Авто</title></programme>' +
      '<programme start="' + xmlTime(now - 60) + '" stop="' + xmlTime(now + 3600) + '" channel="manual"><title>Ручной</title></programme>' +
      '</tv>';
    const bytes = new TextEncoder().encode(xml);
    const spy = vi.spyOn(Net, 'stream').mockImplementation(function (url: string, _opts: any, onChunk: any) {
      return Promise.resolve(onChunk(bytes)).then(function () {
        return { status: 200, url: url, proxied: false, header: function () { return ''; } };
      });
    } as any);
    const wanted: WantedSet[] = [{
      pid: 1,
      channels: [{ key: 'x', tvgId: '', tvgName: '', name: 'Авто', epgId: 'manual' }],
    }];
    const req: EpgRequest = { url: 'http://example/epg.xml', wanted: wanted, maxArchiveDays: 1, langs: ['ru'], loadId: 1, etag: '', lastModified: '' };
    const maps: any[] = [];
    const res = await Loaders.parseEpg(req, function (b) {
      maps.push.apply(maps, b.maps);
      return Promise.resolve();
    }, function () { /* */ });
    expect(res.total).toBe(1);
    expect(maps[0].m['x'][0]).toBe('manual');
    expect(maps[0].m['x'][1]).toBe('http://logo');
    spy.mockRestore();
  });
});
