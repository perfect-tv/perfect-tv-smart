import { describe, it, expect } from 'vitest';
import { gzipSync } from 'fflate';
import { M3uParser, RawChannel, parseAttrs, epgUrls } from '../src/core/data/m3u';
import { Names } from '../src/core/data/names';
import { Unpacker } from '../src/core/data/streams';

const list = `#EXTM3U url-tvg="http://epg.example/epg.xml.gz" catchup="shift" catchup-days="3"
#EXTINF:-1 tvg-id="first" tvg-logo="http://logo/1.png" group-title="Новости",Первый HD
http://stream/1.m3u8
#EXTGRP:Кино
#EXTINF:-1 catchup-days="5",Кино ТВ
#EXTVLCOPT:http-user-agent=Test
http://stream/2.m3u8
#EXTINF:-1,YouTube
https://www.youtube.com/watch?v=x
#EXTINF:0 tvg-name=Some,Без группы
http://stream/3.m3u8
`;

function parse(text: string, group = 'Other', chunk = 0): [M3uParser, RawChannel[]] {
  const out: RawChannel[] = [];
  const p = new M3uParser(function (c) { out.push(c); }, group);
  if (chunk > 0) for (let i = 0; i < text.length; i += chunk) p.push(text.substring(i, i + chunk));
  else p.push(text);
  p.end();
  return [p, out];
}

describe('M3U', () => {
  it('заголовок, группы, параметры', () => {
    for (const chunk of [0, 1, 7]) {
      const [p, ch] = parse(list, 'Other', chunk);
      expect(p.isM3u).toBe(true);
      expect(p.header['url-tvg']).toBe('http://epg.example/epg.xml.gz');
      expect(ch.length).toBe(3);
      expect(ch.map(c => c.group)).toEqual(['Новости', 'Кино', 'Кино']);
      expect(ch[0].logo).toBe('http://logo/1.png');
      expect(ch[1].userAgent).toBe('Test');
      expect(ch[2].name).toBe('Без группы');
      expect(ch[2].tvgName).toBe('Some');
      expect(ch.map(c => c.num)).toEqual([1, 2, 3]);
      expect(ch[0].catchup).toEqual({ type: 'shift', source: '', days: 3 });
      expect(ch[1].catchup!.days).toBe(5);
    }
  });

  it('запятая внутри кавычек', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
    const text = '#EXTM3U\n' +
      `#EXTINF:-1 tvg-id="7843" tvg-logo="https://example.com/J4zlRGv.png" http-user-agent="${ua}" group-title="Украина 🇺🇦",ICTV 2 HD\n` +
      `#EXTVLCOPT:http-user-agent=${ua}\n` +
      'http://example.com/368/index.m3u8\n' +
      "#EXTINF:-1 group-title='A, B',Канал, с запятой\n" +
      'http://example.com/2.m3u8\n';
    const [, ch] = parse(text);
    expect(ch[0].name).toBe('ICTV 2 HD');
    expect(ch[0].group).toBe('Украина 🇺🇦');
    expect(ch[0].tvgId).toBe('7843');
    expect(ch[0].userAgent).toBe(ua);
    expect(ch[1].name).toBe('Канал, с запятой');
    expect(ch[1].group).toBe('A, B');
  });

  it('BOM, CRLF и не M3U', () => {
    const [p, ch] = parse('﻿#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://a\r\n');
    expect(p.isM3u).toBe(true);
    expect(ch[0].name).toBe('A');
    expect(ch[0].url).toBe('http://a');
    const [p2, ch2] = parse('<html>\nhttp://a\n');
    expect(p2.isM3u).toBe(false);
    expect(ch2.length).toBe(0);
  });

  it('catchup disabled и enable', () => {
    const [, ch] = parse('#EXTM3U catchup-days="7"\n' +
      '#EXTINF:-1 catchup="disabled",A\nhttp://a\n' +
      '#EXTINF:-1 catchup-enable="0",B\nhttp://b\n' +
      '#EXTINF:-1 catchup="flussonic",C\nhttp://c\n' +
      '#EXTINF:-1,D\nhttp://d\n');
    expect(ch[0].catchup).toBeNull();
    expect(ch[1].catchup).toBeNull();
    expect(ch[2].catchup).toEqual({ type: 'flussonic', source: '', days: 7 });
    expect(ch[3].catchup!.days).toBe(7);
  });

  it('без EXTINF, referrer, EXTHTTP', () => {
    const [, ch] = parse('#EXTM3U\nhttp://a\n#EXTINF:-1 http-referrer="http://r",B\n#EXTHTTP:{"Cookie":"x"}\nhttp://b\n');
    expect(ch[0].name).toBe('Ch 1');
    expect(ch[1].referrer).toBe('http://r');
    expect(ch[1].headersJson).toBe('{"Cookie":"x"}');
  });

  it('несколько адресов EPG', () => {
    const h = parseAttrs(' url-tvg="http://a/epg.xml.gz,http://b/epg.xml http://a/epg.xml.gz"');
    expect(epgUrls(h)).toEqual(['http://a/epg.xml.gz', 'http://b/epg.xml']);
  });

  it('gzip-поток и обрыв на середине', () => {
    const gz = gzipSync(new TextEncoder().encode(list));
    const parts: Uint8Array[] = [];
    const u = new Unpacker(b => parts.push(b));
    for (let i = 0; i < gz.length; i += 5) u.push(gz.subarray(i, i + 5));
    u.end();
    expect(u.kind).toBe('gzip');
    const dec = new TextDecoder();
    let n = 0;
    const p = new M3uParser(() => n++);
    for (const b of parts) p.push(dec.decode(b, { stream: true }));
    p.end();
    expect(n).toBe(3);
    // обрыв: последняя строка без перевода строки — канал всё равно есть
    const [, ch] = parse('#EXTM3U\n#EXTINF:-1,A\nhttp://a');
    expect(ch.length).toBe(1);
  });

  it('имена', () => {
    expect(Names.key('Первый HD')).toBe('первыйhd');
    expect(Names.key('I.C.T.V')).toBe('ictv');
    expect(Names.matchKey('НТВ')).toBe(Names.matchKey('HTB'));
    expect(Names.matchKey('Телеканал Звезда')).toBe(Names.matchKey('Звезда'));
    expect(Names.short('Россия 1')).toBe('россия1');
    expect(Names.qualityBase('Первый HD')).toBe('Первый');
    expect(Names.qualityBase('Первый (FHD)')).toBe('Первый');
    expect(Names.qualityBase('Первый 1080p')).toBe('Первый');
    expect(Names.qualityBase('Первый FULL HD')).toBe('Первый');
    expect(Names.qualityBase('Первый HDR')).toBe('Первый');
    expect(Names.qualityBase('Первый канал HD orig')).toBe('Первый канал');
    expect(Names.qualityBase('Матч! HD orig')).toBe('Матч!');
    expect(Names.qualityBase('Кино 2 ORG')).toBe('Кино 2');
    expect(Names.qualityBase('Первый +1')).toBe('Первый +1');
    expect(Names.groupBase('Матч! ТВ')).toBe(Names.groupBase('Матч! ТВ HD'));
    expect(Names.groupBase('Матч! ТВ')).toBe(Names.groupBase('Матч! HD orig'));
    expect(Names.groupBase('Кино 2')).toBe(Names.groupBase('Кино 2 ORG'));
    expect(Names.groupBase('Кино 2')).not.toBe(Names.groupBase('Кино 3'));
    expect(Names.groupBase('Первый канал')).toBe(Names.groupBase('Первый'));
    expect(Names.qualityBase('HD')).toBe('');
    expect(Names.groupCompare('Матч! ТВ')).toBe('матч');
    expect(Names.groupCompare('NHL Network HD')).toBe('nhl network');
    expect(Names.related(Names.groupCompare('NHL'), Names.groupCompare('NHL Network HD'))).toBe(true);
    expect(Names.related(Names.groupCompare('Action IL'), Names.groupCompare('YES Action IL'))).toBe(true);
    expect(Names.related(Names.groupCompare('Кино 2'), Names.groupCompare('Кино 20'))).toBe(false);
    expect(Names.related(Names.groupCompare('Musicbox 80s'), Names.groupCompare('Musicbox 90s'))).toBe(false);
    expect(Names.related(Names.groupCompare('Sky Sport Bundesliga 1 HD'), Names.groupCompare('Sky Sport Bundesliga 7 HD'))).toBe(false);
  });

  it('монограммы', () => {
    const cases: [string, string][] = [['НТВ', 'НТВ'], ['Карусель', 'КА'], ['Первый канал', 'ПК'], ['Матч! ТВ', 'МТ'], ['Россия 1', 'Р1'],
      ['Россия 24', 'Р24'], ['Первый канал HD', 'ПКH'], ['5 канал', '5К'], ['Музыка 2000', 'М20'], [' tv ', 'TV'], ['!!!', '?'], ['', '?']];
    for (const [n, m] of cases) expect(Names.monogram(n)).toBe(m);
  });
});
