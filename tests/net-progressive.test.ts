import { afterEach, describe, expect, it } from 'vitest';
import { rangeStream } from '../src/core/net';

/**
 * Без fetch-потоков: Range отклонён (CORS, OPTIONS) — один простой запрос в «x-user-defined»,
 * куски — по мере роста responseText, без Range и условных заголовков.
 */
const realXhr = (globalThis as any).XMLHttpRequest;
afterEach(function () { (globalThis as any).XMLHttpRequest = realXhr; });

function install(data: Uint8Array, sent: { headers: { [k: string]: string }; mime: string }[]) {
  class FakeXhr {
    readyState = 0; status = 0; responseText = ''; response: any = null; responseType = ''; timeout = 0; responseURL = '';
    onreadystatechange: any; onprogress: any; onload: any; onerror: any; ontimeout: any;
    private h: { [k: string]: string } = {}; private mime = '';
    open() { /* */ }
    setRequestHeader(k: string, v: string) { this.h[k] = v; }
    overrideMimeType(m: string) { this.mime = m; }
    getResponseHeader(n: string) { return n === 'Content-Length' ? String(data.length) : null; }
    abort() { /* */ }
    send() {
      sent.push({ headers: this.h, mime: this.mime });
      const self = this;
      // Range или If-None-Match — «предварительный запрос не прошёл»
      if (this.h['Range'] || this.h['If-None-Match']) { setTimeout(function () { self.onerror && self.onerror(); }, 0); return; }
      let i = 0;
      const step = function () {
        if (i === 0) { self.readyState = 2; self.status = 200; self.onreadystatechange && self.onreadystatechange(); }
        const end = Math.min(data.length, i + 700);
        let s = '';
        for (; i < end; i++) s += String.fromCharCode(data[i] >= 128 ? 0xf700 + data[i] : data[i]);
        self.responseText += s;
        self.readyState = 3;
        self.onprogress && self.onprogress();
        if (i < data.length) setTimeout(step, 0);
        else { self.readyState = 4; self.onload && self.onload(); }
      };
      setTimeout(step, 0);
    }
  }
  (globalThis as any).XMLHttpRequest = FakeXhr;
}

describe('Net без fetch-потоков', () => {
  it('Range отклонён — байты целиком по ходу загрузки простым запросом', async () => {
    const data = new Uint8Array(5000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xff;
    const sent: { headers: { [k: string]: string }; mime: string }[] = [];
    install(data, sent);
    const got: number[] = [];
    let pieces = 0;
    const r = await rangeStream('http://epg.test/a.gz', { 'If-None-Match': '"x"' }, {}, function (b) {
      pieces++;
      for (let i = 0; i < b.length; i++) got.push(b[i]);
    });
    expect(r.status).toBe(200);
    expect(got.length).toBe(data.length);
    expect(got.every(function (v, i) { return v === data[i]; })).toBe(true);
    expect(pieces).toBeGreaterThan(1);
    // второй запрос — без Range и условных заголовков, с x-user-defined
    expect(sent.length).toBe(2);
    expect(Object.keys(sent[1].headers)).toEqual([]);
    expect(sent[1].mime).toContain('x-user-defined');
  });
});
