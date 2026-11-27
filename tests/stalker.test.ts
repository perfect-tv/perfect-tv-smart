import { describe, it, expect, vi } from 'vitest';
import {
  buildStalkerChannels, loadStalkerPlaylist, normalizeStalkerMac, normalizeStalkerPortal,
  parseStalkerJson, resolveStalkerLink, staticStalkerUrl, stalkerEndpoints, stalkerLinkUrl, stalkerPrehash,
} from '../src/core/data/stalker';
import { Playlist, SOURCE_STALKER } from '../src/core/data/models';
import { Net } from '../src/core/net';
import { sha1 } from '../src/core/sha1';

const MAC = '00:1A:79:00:00:01';

function playlist(): Playlist {
  return {
    id: 1, name: 'Stalker', url: 'http://h:8080/c/', source: SOURCE_STALKER, username: MAC,
    epgMode: 0, userEpg: [], headerEpg: [], loadedAt: 0, channelsCount: 0, error: '', sort: 0,
  };
}

describe('Stalker / MAG', () => {
  it('MAC, портал и кандидаты API', () => {
    expect(normalizeStalkerMac(MAC)).toBe(MAC);
    expect(normalizeStalkerMac('00-1a-79-00-00-01')).toBe(MAC);
    expect(normalizeStalkerMac('001A79000001')).toBe(MAC);
    expect(normalizeStalkerMac('00:1A:79:00:00')).toBe('');
    expect(normalizeStalkerPortal('h:8080/c/')).toBe('http://h:8080');
    expect(normalizeStalkerPortal('http://h:8080/stalker_portal/c/')).toBe('http://h:8080/stalker_portal');
    expect(stalkerEndpoints('http://h:8080/c/')).toEqual([
      'http://h:8080/portal.php', 'http://h:8080/server/load.php', 'http://h:8080/stalker_portal/server/load.php',
    ]);
    expect(stalkerEndpoints('http://h:8080/portal.php')).toEqual(['http://h:8080/portal.php']);
  });

  it('prehash — SHA-1 MAC в верхнем регистре', () => {
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(stalkerPrehash(MAC)).toBe(sha1(MAC).toUpperCase());
  });

  it('статический адрес и create_link по флагам', () => {
    expect(staticStalkerUrl('http://h:8080/portal.php', 'ffrt3 http://cdn/1.m3u8', { use_http_tmp_link: '0' }))
      .toBe('http://cdn/1.m3u8');
    expect(staticStalkerUrl('http://h:8080/portal.php', 'http://cdn/1.m3u8', { use_load_balancing: '0' }))
      .toBe('http://cdn/1.m3u8');
    expect(staticStalkerUrl('http://h:8080/portal.php', 'ffrt4://ch/1', { use_http_tmp_link: '0' })).toBe('');
    expect(staticStalkerUrl('http://h:8080/portal.php', 'http://cdn/1.m3u8', { use_http_tmp_link: '1' })).toBe('');
    expect(staticStalkerUrl('http://h:8080/portal.php', '/media/1.m3u8', { use_http_tmp_link: '0' }))
      .toBe('http://h:8080/media/1.m3u8');
  });

  it('относительный js.cmd от портала', () => {
    expect(stalkerLinkUrl('http://h:8080/stalker_portal/server/load.php', 'x', '/media/1.m3u8'))
      .toBe('http://h:8080/stalker_portal/media/1.m3u8');
    expect(stalkerLinkUrl('http://h:8080/portal.php', 'http://cdn/1.m3u8', '?token=1'))
      .toBe('http://cdn/1.m3u8?token=1');
  });

  it('каналы: жанры, номера, логотипы, статический адрес и команда', () => {
    const channels = buildStalkerChannels([
      { id: '1', name: ' Первый ', number: '7', cmd: 'ffrt3 http://cdn/1.m3u8', logo: '/logos/1.png', tv_genre_id: '2', xmltv_id: 'one', use_http_tmp_link: '0' },
      { id: '2', name: 'Второй', cmd: 'ffrt4://ch/2', logo: 'http://logo/2.png', tv_genre_id: '2', use_http_tmp_link: '1' },
    ], [{ id: '2', title: 'Новости' }], 'http://h:8080/stalker_portal/server/load.php', MAC, 'T');
    expect(channels.length).toBe(2);
    expect(channels[0].num).toBe(7);
    expect(channels[0].name).toBe('Первый');
    expect(channels[0].group).toBe('Новости');
    expect(channels[0].url).toBe('http://cdn/1.m3u8');
    expect(channels[0].stalkerCmd).toBe('');
    expect(channels[0].tvgId).toBe('one');
    expect(channels[0].logo).toBe('http://h:8080/logos/1.png');
    expect(JSON.parse(channels[0].headersJson).Authorization).toBe('Bearer T');
    expect(channels[1].url).toBe('');
    expect(channels[1].stalkerCmd).toBe('ffrt4://ch/2');
  });

  it('текстовая ошибка авторизации', () => {
    expect(() => parseStalkerJson('Authorization failed.')).toThrowError(/stalker_auth/);
    expect(() => parseStalkerJson('Ошибка')).toThrowError(/format/);
    expect(parseStalkerJson('{"js":{"data":[]}}')).toEqual({ js: { data: [] } });
  });

  it('загрузка полного портала и временная ссылка', async () => {
    const spy = vi.spyOn(Net, 'text').mockImplementation(function (url: string) {
      if (url.indexOf('action=handshake') >= 0) return Promise.resolve(JSON.stringify({ js: { token: 'T', random: 'R' } }));
      if (url.indexOf('action=get_profile') >= 0) return Promise.resolve(JSON.stringify({ js: { id: '1', status: 0 } }));
      if (url.indexOf('action=get_genres') >= 0) return Promise.resolve(JSON.stringify({ js: [{ id: '2', title: 'Новости' }] }));
      if (url.indexOf('action=get_all_channels') >= 0) return Promise.resolve(JSON.stringify({ js: { data: [
        { id: '1', name: 'Первый', number: '1', cmd: 'ffrt3 http://cdn/1.m3u8', tv_genre_id: '2', use_http_tmp_link: '0' },
        { id: '2', name: 'Второй', number: '2', cmd: 'ffrt4://ch/2', tv_genre_id: '2', use_http_tmp_link: '1' },
      ] } }));
      if (url.indexOf('action=create_link') >= 0) return Promise.resolve(JSON.stringify({ js: { cmd: 'http://cdn/2.m3u8' } }));
      return Promise.reject(new Error('unexpected ' + url));
    });
    const p = playlist();
    const res = await loadStalkerPlaylist(p);
    expect(res.list.length).toBe(2);
    expect(p.url).toBe('http://h:8080/portal.php');
    expect(p.username).toBe(MAC);
    const ch = { url: '', stalkerCmd: 'ffrt4://ch/2', stalkerPortal: 'http://h:8080/portal.php', stalkerMac: MAC, stalkerToken: 'T', headersJson: '' };
    expect(await resolveStalkerLink(ch)).toBe('http://cdn/2.m3u8');
    expect(ch.url).toBe('http://cdn/2.m3u8');
    spy.mockRestore();
  });

  it('простая панель: handshake отклонён, каталог без токена', async () => {
    const spy = vi.spyOn(Net, 'text').mockImplementation(function (url: string) {
      if (url.indexOf('action=handshake') >= 0) return Promise.resolve('Access denied.');
      if (url.indexOf('action=get_genres') >= 0) return Promise.resolve(JSON.stringify({ js: [{ id: '2', title: 'ТВ' }] }));
      if (url.indexOf('action=get_all_channels') >= 0) return Promise.resolve(JSON.stringify({ js: { data: [
        { id: '1', name: 'Канал', cmd: 'ffrt3 http://cdn/1.m3u8', tv_genre_id: '2', use_http_tmp_link: '0' },
      ] } }));
      return Promise.reject(new Error('unexpected ' + url));
    });
    const res = await loadStalkerPlaylist(playlist());
    expect(res.list.length).toBe(1);
    expect(JSON.parse(res.list[0].headersJson).Authorization).toBeUndefined();
    spy.mockRestore();
  });
});
