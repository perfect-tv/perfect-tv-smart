import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { XmltvParser } from '../src/core/data/xmltv';
import { Unpacker } from '../src/core/data/streams';

/**
 * Скорость разбора XMLTV: синтетика (2000 каналов, нужны 5%) кусками по 64 КБ, как из сети.
 * XMLTV_FILE=путь — на настоящем файле (.xml или .xml.gz). XMLTV_MB — размер синтетики.
 */
function block(k0: number, n: number, channels: number): string {
  let s = '';
  for (let k = k0; k < k0 + n; k++) {
    const c = k % channels;
    s += '<programme start="20231114' + String(100000 + (k % 1400)).slice(-6) + ' +0300" stop="20231114235959 +0300" channel="ch' + c + '">\n'
      + '  <title lang="ru">Передача номер ' + k + ' &amp; продолжение</title>\n'
      + '  <desc lang="ru">Описание передачи: сюжет, ведущие, гости и прочие подробности, которые занимают место в файле программы. Серия ' + k + '.</desc>\n'
      + '  <category lang="ru">Развлекательные</category>\n</programme>\n';
  }
  return s;
}

describe('XMLTV, скорость', () => {
  it('разбор', () => {
    let n = 0;
    const want = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0; return Math.abs(h) % 20 === 0; };
    const p = new XmltvParser(['ru'], () => {}, () => {}, want, () => { n++; });
    const u = new Unpacker(b => p.push(b));
    const CH = 64 * 1024;
    let bytes = 0;
    const t0 = Date.now();
    const file = process.env.XMLTV_FILE;
    if (file) {
      const buf = fs.readFileSync(file);
      for (let i = 0; i < buf.length; i += CH) u.push(new Uint8Array(buf.buffer, buf.byteOffset + i, Math.min(CH, buf.length - i)));
      bytes = buf.length;
    } else {
      const mb = parseInt(process.env.XMLTV_MB || '100', 10);
      const enc = new TextEncoder();
      let head = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
      for (let c = 0; c < 2000; c++) head += '<channel id="ch' + c + '"><display-name lang="ru">Канал ' + c + '</display-name></channel>\n';
      u.push(enc.encode(head));
      const blocks: Uint8Array[] = [];
      for (let i = 0; i < 16; i++) blocks.push(enc.encode(block(i * 3000, 3000, 2000)));
      let i = 0;
      while (bytes < mb * 1048576) {
        const b = blocks[i++ % blocks.length];
        for (let o = 0; o < b.length; o += CH) u.push(b.subarray(o, Math.min(o + CH, b.length)));
        bytes += b.length;
      }
      u.push(enc.encode('</tv>\n'));
    }
    u.end();
    p.end();
    const sec = (Date.now() - t0) / 1000;
    console.log('XMLTV ' + (bytes / 1048576).toFixed(0) + ' МБ за ' + sec.toFixed(2) + ' с: ' + (bytes / 1048576 / sec).toFixed(0) + ' МБ/с, взято ' + n + ', пропущено ' + p.skipped);
    expect(n).toBeGreaterThan(0);
  }, 300000);
});
