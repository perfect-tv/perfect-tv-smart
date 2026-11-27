import { describe, it, expect, vi } from 'vitest';
import { CatchupUrl } from '../src/core/data/catchup';
import { Playlist } from '../src/core/data/models';
import {
  apiUrl, buildXtreamChannels, checkXtreamAuth, liveUrl, loadXtreamPlaylist, normalizeXtreamAccount,
  parseXtreamJson, serverOffsetMinutes, xmltvUrl,
} from '../src/core/data/xtream';
import { Net } from '../src/core/net';

function playlist(): Playlist {
  return {
    id: 1, name: 'Xtream', url: 'http://h:8080', source: 1, username: 'u', password: 'p', output: 'm3u8',
    epgMode: 0, userEpg: [], headerEpg: [], loadedAt: 0, channelsCount: 0, error: '', sort: 0,
  };
}

describe('Xtream Codes', () => {
  it('нормализует адрес сервера и вытаскивает логин из get.php', () => {
    expect(normalizeXtreamAccount('http://h:8080/')).toEqual({ server: 'http://h:8080', username: '', password: '' });
    expect(normalizeXtreamAccount('h:8080/player_api.php?username=u&password=p')).toEqual({ server: 'http://h:8080', username: 'u', password: 'p' });
    expect(normalizeXtreamAccount('https://h/iptv/')).toEqual({ server: 'https://h/iptv', username: '', password: '' });
    expect(normalizeXtreamAccount('http://h:8080/get.php?username=a%40b&password=p%3A1&type=m3u_plus'))
      .toEqual({ server: 'http://h:8080', username: 'a@b', password: 'p:1' });
    expect(normalizeXtreamAccount('http://h:8080/xmltv.php?username=u&password=p')).toEqual({ server: 'http://h:8080', username: 'u', password: 'p' });
    expect(normalizeXtreamAccount('http://').server).toBe('');
    expect(normalizeXtreamAccount('').server).toBe('');
  });

  it('строит адреса API, программы и потоков', () => {
    expect(apiUrl('http://h:8080', 'u', 'p', 'get_live_streams')).toBe('http://h:8080/player_api.php?username=u&password=p&action=get_live_streams');
    expect(xmltvUrl('http://h:8080', 'u', 'p')).toBe('http://h:8080/xmltv.php?username=u&password=p');
    expect(liveUrl('http://h:8080', 'u', 'p', 42, 'm3u8')).toBe('http://h:8080/live/u/p/42.m3u8');
    expect(liveUrl('http://h:8080', 'u', 'p', 42, 'ts')).toBe('http://h:8080/live/u/p/42.ts');
  });

  it('смещение сервера по time_now и timestamp_now', () => {
    const ts = Date.UTC(2023, 10, 14, 19, 13) / 1000;
    expect(serverOffsetMinutes({ server_info: { time_now: '2023-11-14 22:13:00', timestamp_now: ts } })).toBe(180);
    expect(serverOffsetMinutes({ server_info: { time_now: '2023-11-14 22:13', timestamp_now: String(ts) } })).toBe(180);
    expect(serverOffsetMinutes({})).toBeNull();
  });

  it('проверяет ответ и логин', () => {
    expect(parseXtreamJson('\uFEFF {"ok":1}')).toEqual({ ok: 1 });
    expect(() => parseXtreamJson('<html>login</html>')).toThrowError(/format/);
    expect(() => checkXtreamAuth({ user_info: { auth: 0 } })).toThrowError(/xtream_auth/);
    expect(() => checkXtreamAuth({ user_info: { auth: 1, status: 'Active' } })).not.toThrow();
  });

  it('превращает live-потоки в каналы, категории и архив', () => {
    const offset = 180;
    const channels = buildXtreamChannels([
      { num: '0', name: ' Первый HD ', stream_id: 42, stream_icon: 'http://logo/1.png', epg_channel_id: 'one', category_id: '2', tv_archive: 1, tv_archive_duration: '5' },
      { num: 7, name: 'Кино', stream_id: '43', category_id: '9' },
      { name: 'Без id' },
    ], [{ category_id: '2', category_name: 'Новости' }], { server: 'http://h:8080', username: 'u', password: 'p' }, 'm3u8', offset);

    expect(channels.length).toBe(2);
    expect(channels[0].num).toBe(1);
    expect(channels[0].name).toBe('Первый HD');
    expect(channels[0].group).toBe('Новости');
    expect(channels[0].logo).toBe('http://logo/1.png');
    expect(channels[0].tvgId).toBe('one');
    expect(channels[0].catchup).toEqual({ type: 'xc', source: '', days: 5 });
    expect(channels[0].catchupOffset).toBe(180);
    expect(channels[0].url).toBe('http://h:8080/live/u/p/42.m3u8');
    expect(channels[1].num).toBe(7);
    expect(channels[1].group).toBe('');
    expect(channels[1].catchup).toBeNull();
    expect(channels[1].catchupOffset).toBeNull();
  });

  it('загрузка: API, программа в headerEpg и ошибка входа', async () => {
    const ts = Date.UTC(2023, 10, 14, 19, 13) / 1000;
    const spy = vi.spyOn(Net, 'text').mockImplementation(function (url: string) {
      if (url.indexOf('action=get_live_categories') >= 0) return Promise.resolve(JSON.stringify([{ category_id: '2', category_name: 'Новости' }]));
      if (url.indexOf('action=get_live_streams') >= 0) return Promise.resolve(JSON.stringify([
        { num: 1, name: 'Первый', stream_id: 42, epg_channel_id: 'one', category_id: '2', tv_archive: 1, tv_archive_duration: '5' },
      ]));
      return Promise.resolve(JSON.stringify({ user_info: { auth: 1, status: 'Active' }, server_info: { time_now: '2023-11-14 22:13:00', timestamp_now: ts } }));
    });
    const progress: number[][] = [];
    const res = await loadXtreamPlaylist(playlist(), undefined, function (read, n) { progress.push([read, n]); });
    expect(res.list.length).toBe(1);
    expect(res.list[0].catchupOffset).toBe(180);
    expect(res.header['url-tvg']).toBe('http://h:8080/xmltv.php?username=u&password=p');
    expect(progress[0][1]).toBe(1);
    spy.mockRestore();

    const bad = vi.spyOn(Net, 'text').mockResolvedValue(JSON.stringify({ user_info: { auth: 0 } }));
    await expect(loadXtreamPlaylist(playlist())).rejects.toMatchObject({ code: 'xtream_auth' });
    bad.mockRestore();
  });

  it('архив Xtream: местное время сервера, а не телевизора', () => {
    const [ch] = buildXtreamChannels([
      { num: 1, name: 'A', stream_id: 42, tv_archive: 1, tv_archive_duration: '5' },
    ], [], { server: 'http://h:8080', username: 'u', password: 'p' }, 'm3u8', 180);
    const tpl = CatchupUrl.template(ch.url, ch.catchup!.type, ch.catchup!.source)!;
    expect(tpl).toBe('http://h:8080/timeshift/u/p/${(d)M}/${(b)yyyy-MM-dd:HH-mm}/42.m3u8');
    const start = Date.UTC(2023, 10, 14, 19, 13) / 1000;
    expect(CatchupUrl.prepare(tpl, start, 3600, start + 300, () => 180))
      .toBe('http://h:8080/timeshift/u/p/60/2023-11-14%3A22-13/42.m3u8');
  });
});
