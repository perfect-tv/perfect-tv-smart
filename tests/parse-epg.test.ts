import { describe, expect, it, vi } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';
import { Net } from '../src/core/net';
import { EpgBatch, Loaders } from '../src/core/data/loaders';
import { unpackProgramme } from '../src/core/data/compact';
import { Clock } from '../src/core/clock';

/** Разбор программы без базы (то, что делает воркер): пачки — в sink, ответ 304 — notModified */
function xmltv(): Uint8Array {
  const now = Clock.now();
  const t = function (s: number) {
    const d = new Date(s * 1000);
    const p = function (n: number) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + '00 +0000';
  };
  let x = '<?xml version="1.0" encoding="UTF-8"?><tv>';
  x += '<channel id="one"><display-name>Первый</display-name></channel><channel id="two"><display-name>Второй</display-name></channel>';
  for (let i = 0; i < 50; i++) {
    x += '<programme start="' + t(now + i * 1800) + '" stop="' + t(now + (i + 1) * 1800) + '" channel="one"><title>Передача ' + i + '</title></programme>';
    x += '<programme start="' + t(now + i * 1800) + '" stop="' + t(now + (i + 1) * 1800) + '" channel="three"><title>Чужая</title></programme>';
  }
  return gzipSync(strToU8(x + '</tv>'));
}

const req = {
  url: 'http://epg.test/e.xml.gz', loadId: 7, maxArchiveDays: 3, langs: ['ru'], etag: '', lastModified: '',
  wanted: [{ pid: 1, channels: [{ key: 'k1', tvgId: 'one', tvgName: '', name: 'Первый' }] }],
};

describe('Loaders.parseEpg', () => {
  it('отдаёт каналы, сжатые пачки и сопоставление, ждёт записи каждой пачки', async () => {
    const gz = xmltv();
    const spy = vi.spyOn(Net, 'stream').mockImplementation(async (_u, opts, onChunk) => {
      const r = { status: 200, url: req.url, proxied: false, header: (n: string) => (n === 'ETag' ? '"e1"' : '') };
      opts.onResponse!(r);
      for (let i = 0; i < gz.length; i += 97) await onChunk(gz.subarray(i, i + 97));
      return r;
    });
    const batches: EpgBatch[] = [];
    let writing = false;
    const res = await Loaders.parseEpg(req, async (b) => {
      expect(writing).toBe(false); // следующая пачка — только после записи предыдущей
      writing = true;
      batches.push(b);
      await new Promise((r) => setTimeout(r, 1));
      writing = false;
    }, () => {});
    spy.mockRestore();
    expect(res.notModified).toBe(false);
    expect(res.etag).toBe('"e1"');
    expect(res.total).toBe(50);
    expect(res.maps[0].m.k1[0]).toBe('one');
    const chans = batches.reduce((n, b) => n + b.epgch.length, 0);
    expect(chans).toBe(2);
    const packs = batches.reduce((a: any[], b) => a.concat(b.packs), []);
    expect(packs.every((p) => p.data instanceof Uint8Array && p.l === 7)).toBe(true);
    const progs = packs.reduce((a: any[], p) => a.concat(unpackProgramme(p)), []);
    expect(progs.length).toBe(50);
    expect(progs[0][2]).toBe('Передача 0');
  });

  it('304 — без разбора и записи', async () => {
    const spy = vi.spyOn(Net, 'stream').mockResolvedValue({ status: 304, url: req.url, proxied: false, header: () => '' });
    const sink = vi.fn();
    const res = await Loaders.parseEpg(Object.assign({}, req, { etag: '"e1"' }), sink, () => {});
    spy.mockRestore();
    expect(res.notModified).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });
});
