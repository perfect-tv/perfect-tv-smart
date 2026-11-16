import { afterEach, describe, expect, it } from 'vitest';
import { Net } from '../src/core/net';

/** Страница по HTTPS без прокси: http:// не загрузить (смешанное содержимое) — такие адреса не принимаем */
const g: any = globalThis;
const had = 'location' in g, old = g.location;
afterEach(function () { if (had) g.location = old; else delete g.location; });

describe('Только HTTPS', () => {
  it('https-страница без прокси: http:// запрещён, https:// — нет', () => {
    g.location = { protocol: 'https:' };
    expect(Net.httpsOnly()).toBe(true);
    expect(Net.blockedHttp('http://iptv.example/list.m3u')).toBe(true);
    expect(Net.blockedHttp('HTTP://iptv.example/list.m3u')).toBe(true);
    expect(Net.blockedHttp('https://iptv.example/list.m3u')).toBe(false);
  });
  it('file:// (webOS, Tizen) и http-страница — ограничения нет', () => {
    g.location = { protocol: 'file:' };
    expect(Net.blockedHttp('http://iptv.example/list.m3u')).toBe(false);
    g.location = { protocol: 'http:' };
    expect(Net.httpsOnly()).toBe(false);
  });
});
