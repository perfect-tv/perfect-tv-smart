import { describe, it, expect } from 'vitest';
import { gzipSync } from 'fflate';
import { XmltvParser, EpgChannelRaw, EpgProgramme, parseTime } from '../src/core/data/xmltv';
import { EpgMatcher } from '../src/core/data/matcher';
import { Unpacker } from '../src/core/data/streams';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test">
  <channel id="1tv"><display-name lang="ru">Первый канал</display-name><display-name>Channel One</display-name><icon src="http://i/1.png"/></channel>
  <channel id="ntv"><display-name lang="ru">НТВ</display-name></channel>
  <channel id="skip"><display-name>Skip</display-name></channel>
  <programme start="20231114220000 +0300" stop="20231114230000 +0300" channel="1tv">
    <title lang="en">News</title><title lang="ru">Новости</title>
    <desc lang="ru"><![CDATA[Главное & <важное>]]></desc>
    <category lang="ru">Новости</category>
  </programme>
  <programme start="20231114230000 +0300" channel="1tv"><title>Без конца</title></programme>
  <programme start="20231115000000 +0300" stop="20231115010000 +0300" channel="1tv"><title>Ночь &amp; день</title></programme>
  <programme start="20231114190000" stop="20231114200000" channel="ntv"><title>Сегодня</title></programme>
  <programme start="20231114190000 +0000" stop="20231114200000 +0000" channel="skip"><title>X</title></programme>
</tv>`;

function run(bytes: Uint8Array, wanted: string[], chunk = 0): [XmltvParser, EpgChannelRaw[], EpgProgramme[]] {
  const ch: EpgChannelRaw[] = [], pr: EpgProgramme[] = [];
  let before = 0;
  const p = new XmltvParser(['ru'], c => ch.push(c), () => before++, id => wanted.indexOf(id) >= 0, x => pr.push(x));
  const u = new Unpacker(b => p.push(b));
  if (chunk) for (let i = 0; i < bytes.length; i += chunk) u.push(bytes.subarray(i, i + chunk));
  else u.push(bytes);
  u.end();
  p.end();
  expect(before).toBe(1);
  return [p, ch, pr];
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('XMLTV', () => {
  it('каналы и передачи, любые куски', () => {
    for (const chunk of [0, 1, 3, 17, 100]) {
      const [p, ch, pr] = run(enc(xml), ['1tv', 'ntv'], chunk);
      expect(ch.length).toBe(3);
      expect(ch[0].names).toEqual(['Первый канал', 'Channel One']);
      expect(ch[0].icon).toBe('http://i/1.png');
      expect(p.skipped).toBe(1);
      const first = pr.find(x => x.channel === '1tv')!;
      expect(first.title).toBe('Новости');
      expect(first.desc).toBe('Главное & <важное>');
      expect(first.category).toBe('Новости');
      expect(first.start).toBe(1699988400);
      const noStop = pr.find(x => x.title === 'Без конца')!;
      expect(noStop.stop).toBe(noStop.start + 3600);
      expect(pr.find(x => x.start === noStop.stop)!.title).toBe('Ночь & день');
      expect(pr.find(x => x.channel === 'ntv')!.start).toBe(parseTime('20231114190000 +0000'));
    }
  });

  it('заглушка программы: одно название на все передачи', () => {
    const x = `<tv><channel id="fake"><display-name>Fake</display-name></channel>
<channel id="short"><display-name>Short</display-name></channel>
<channel id="real"><display-name>Real</display-name></channel>` +
      [0, 1, 2, 3, 4].map(function (i) { return `<programme start="202311141${10 + i}0000 +0000" stop="202311141${11 + i}0000 +0000" channel="fake"><title>Музыка на канале</title></programme>`; }).join('') +
      [0, 1, 2].map(function (i) { return `<programme start="202311141${10 + i}0000 +0000" stop="202311141${11 + i}0000 +0000" channel="short"><title>Нет программы</title></programme>`; }).join('') +
      ['Новости', 'Кино', 'Спорт', 'Погода'].map(function (t, i) { return `<programme start="202311141${10 + i}0000 +0000" stop="202311141${11 + i}0000 +0000" channel="real"><title>${t}</title></programme>`; }).join('') +
      '</tv>';
    const [p] = run(enc(x), ['fake', 'short', 'real']);
    expect(p.fakeIds()).toEqual(['fake']);
  });

  it('gzip', () => {
    const [, , pr] = run(gzipSync(enc(xml)), ['1tv'], 64);
    expect(pr.length).toBe(3);
  });

  it('windows-1251', () => {
    // «Канал» и «Передача» в cp1251
    const cp = (s: string) => Array.from(s).map(c => { const k = c.charCodeAt(0); return k >= 0x410 && k <= 0x44f ? k - 0x410 + 0xc0 : k; });
    const text = '<?xml version="1.0" encoding="windows-1251"?><tv><channel id="a"><display-name>Канал</display-name></channel>' +
      '<programme start="20231114190000 +0000" stop="20231114200000 +0000" channel="a"><title>Передача</title></programme></tv>';
    const [, ch, pr] = run(new Uint8Array(cp(text)), ['a'], 10);
    expect(ch[0].names[0]).toBe('Канал');
    expect(pr[0].title).toBe('Передача');
  });

  it('время', () => {
    expect(parseTime('20231114220000 +0300')).toBe(1699988400);
    expect(parseTime('20231114190000')).toBe(1699988400);
    expect(parseTime('202311141900 +0000')).toBe(1699988400);
    expect(parseTime('20231114160000 -0300')).toBe(1699988400);
    expect(parseTime('bad')).toBe(0);
  });

  it('комментарии, вложенные теги, сущности, самозакрытые', () => {
    const x = `<?xml version="1.0"?><!-- комментарий <programme channel="a"> -->
<tv><channel id="a&amp;b"><display-name>A &amp; B</display-name></channel>
<programme start="20231114190000 +0000" stop="20231114200000 +0000" channel="a&amp;b">
<title lang="ru">Кино &#171;Х&#xBB;</title><desc>Текст <b>жирный</b> и &lt;угол&gt;</desc><icon src="http://i/x.png" /></programme>
<programme start="20231114200000 +0000" stop="20231114210000 +0000" channel="a&amp;b"/>
<programme channel="other" start="20231114200000 +0000" stop="20231114210000 +0000"><title>skip</title></programme>
</tv>`;
    for (const chunk of [0, 2, 9]) {
      const [p, ch, pr] = run(enc(x), ['a&b'], chunk);
      expect(ch[0].id).toBe('a&b');
      expect(ch[0].names[0]).toBe('A & B');
      expect(pr.length).toBe(2);
      expect(pr[0].title).toBe('Кино «Х»');
      expect(pr[0].desc).toBe('Текст жирный и <угол>');
      expect(pr[0].icon).toBe('http://i/x.png');
      expect(pr[1].title).toBe('');
      expect(p.skipped).toBe(1);
    }
  });
});

describe('EpgMatcher', () => {
  const m = new EpgMatcher();
  m.addChannel({ id: '1tv', names: ['Первый канал', 'Channel One'], icon: '' });
  m.addChannel({ id: 'NTV', names: ['НТВ'], icon: '' });
  m.addChannel({ id: 'rtr', names: ['Россия 1'], icon: '' });
  m.addChannel({ id: 'zvezda', names: ['Телеканал Звезда'], icon: '' });
  m.addChannel({ id: 'karusel2', names: ['Карусель (+2)'], icon: '' });
  it('по tvg-id', () => {
    expect(m.match('1tv', '', 'что угодно')).toBe('1tv');
    expect(m.match('ntv', '', '')).toBe('NTV');
  });
  it('по tvg-name, затем имени', () => {
    expect(m.match('unknown', 'Россия 1', 'Другое')).toBe('rtr');
    expect(m.match('', '', 'Россия-1')).toBe('rtr');
    expect(m.match('', '', 'Первый')).toBe('1tv');
  });
  it('транслит и приставки', () => {
    expect(m.match('', '', 'HTB')).toBe('NTV');
    expect(m.match('', '', 'Звезда')).toBe('zvezda');
    expect(m.match('', '', 'Карусель +2')).toBe('karusel2');
  });
  it('нет совпадения', () => { expect(m.match('', '', 'Неизвестный канал')).toBeNull(); });
});
