import { describe, it, expect } from 'vitest';
import { Catalog } from '../src/core/data/catalog';
import { Channel, Playlist } from '../src/core/data/models';
import { RawChannel } from '../src/core/data/m3u';
import { Prefs } from '../src/core/prefs';
import { UserData } from '../src/core/data/userdata';

const pid = 991234;

function raw(name: string, group: string, num: number, tvgId = ''): RawChannel {
  return {
    num: num, name: name, url: 'http://example/' + num, group: group, logo: '',
    tvgId: tvgId, tvgName: name, tvgShift: 0, catchup: null,
    userAgent: '', referrer: '', headersJson: '',
  };
}

function playlist(): Playlist {
  return {
    id: pid, name: 'Test', url: 'http://example/list.m3u', source: 0,
    epgMode: 0, userEpg: [], headerEpg: [], loadedAt: 0, channelsCount: 0, error: '', sort: 0,
  };
}

function catalog(raws: RawChannel[], badEpg: { [id: string]: boolean } = {}): Catalog {
  const p = playlist();
  const channels = raws.map(function (r, i) { return new Channel(i, pid, r, 0); });
  return new Catalog(p, channels, function () { return 'Favourites'; }, function () { return 'All'; }, badEpg);
}

describe('каталог: своё имя, номер и порядок', () => {
  it('переименование и номер переживают перезагрузку каталога', () => {
    UserData.dropPlaylist(pid);
    const raws = [raw('Первый', 'Новости', 1), raw('Второй', 'Новости', 2), raw('Третий', 'Кино', 3)];
    let cat = catalog(raws);
    const first = cat.byKey['первый'];
    cat.renameChannel(first, 'Мой первый');
    cat.setChannelNumber(first, 10);
    cat.moveChannel(first, 1);

    expect(cat.group('Новости')!.channels.map(function (c) { return c.name + ':' + c.num; })).toEqual(['Второй:2', 'Мой первый:10']);

    cat = catalog(raws);
    expect(cat.byKey['первый'].name).toBe('Мой первый');
    expect(cat.byNum(10)).toBe(cat.byKey['первый']);
    expect(cat.group('Новости')!.channels.map(function (c) { return c.name; })).toEqual(['Второй', 'Мой первый']);
    expect(cat.group('Кино')!.channels[0].name).toBe('Третий');

    cat.renameChannel(cat.byKey['первый'], '');
    cat.setChannelNumber(cat.byKey['первый'], 0);
    expect(cat.byKey['первый'].name).toBe('Первый');
    expect(cat.byKey['первый'].num).toBe(1);
    UserData.dropPlaylist(pid);
  });

  it('порядок задаётся в пределах категории и не трогает другие', () => {
    UserData.dropPlaylist(pid);
    const raws = [raw('A', 'One', 1), raw('B', 'One', 2), raw('C', 'Two', 3), raw('D', 'Two', 4)];
    const cat = catalog(raws);
    cat.moveChannel(cat.byKey['c'], -1);
    expect(cat.group('Two')!.channels.map(function (c) { return c.name; })).toEqual(['C', 'D']);
    expect(cat.group('One')!.channels.map(function (c) { return c.name; })).toEqual(['A', 'B']);
    UserData.dropPlaylist(pid);
  });

  it('SD/HD/FHD/4K объединяются, дубли доступны как потоки', () => {
    UserData.dropPlaylist(pid);
    const old = Prefs.groupQuality;
    Prefs.groupQuality = true;
    const raws = [
      raw('Первый HD', 'Новости', 1),
      raw('Первый', 'Новости', 2),
      raw('Первый FHD', 'Новости', 3),
      raw('Второй HD', 'Новости', 4),
    ];
    const cat = catalog(raws);
    const group = cat.group('Новости')!;
    expect(group.channels.map(function (c) { return c.name; })).toEqual(['Первый', 'Второй HD']);
    const primary = group.channels[0];
    expect(primary.alts.length).toBe(2);
    expect(primary.alts[0].primary).toBe(primary);
    expect(cat.byKey['первыйhd']).toBe(primary);
    expect(cat.byKey['первыйfhd']).toBe(primary);
    expect(cat.byNum(1)).toBe(null);
    expect(cat.byNum(2)).toBe(primary);
    cat.toggleFavorite(primary);
    expect(cat.isFavorite(primary.alts[0])).toBe(true);
    cat.toggleFavorite(primary.alts[0]);
    expect(cat.isFavorite(primary)).toBe(false);

    Prefs.groupQuality = false;
    const plain = catalog(raws);
    expect(plain.group('Новости')!.channels.length).toBe(4);
    Prefs.groupQuality = old;
    UserData.dropPlaylist(pid);
  });

  it('«Матч! ТВ» и «Матч! HD orig» — одна строка, номера каналов не слипаются', () => {
    UserData.dropPlaylist(pid);
    const old = Prefs.groupQuality;
    Prefs.groupQuality = true;
    const raws = [
      raw('Матч! ТВ', 'Спорт', 1),
      raw('Матч! ТВ HD', 'Спорт', 2),
      raw('Матч! HD orig', 'Спорт', 3),
      raw('Кино 2', 'Кино', 4),
      raw('Кино 2 ORG', 'Кино', 5),
      raw('Кино 3', 'Кино', 6),
    ];
    const cat = catalog(raws);
    const sport = cat.group('Спорт')!;
    expect(sport.channels.map(function (c) { return c.name; })).toEqual(['Матч! ТВ']);
    expect(sport.channels[0].alts.map(function (c) { return c.name; })).toEqual(['Матч! ТВ HD', 'Матч! HD orig']);
    expect(cat.group('Кино')!.channels.map(function (c) { return c.name; })).toEqual(['Кино 2', 'Кино 3']);
    expect(cat.group('Кино')!.channels[0].alts.map(function (c) { return c.name; })).toEqual(['Кино 2 ORG']);
    Prefs.groupQuality = old;
    UserData.dropPlaylist(pid);
  });

  it('tvg-id объединяет только при совпадающей части имени, переиспользованный id — нет', () => {
    UserData.dropPlaylist(pid);
    const old = Prefs.groupQuality;
    Prefs.groupQuality = true;
    const raws = [
      raw('NHL', 'Спорт', 1, 'demo2224'),
      raw('NHL Network HD', 'Спорт', 2, 'demo2224'),
      raw('Sky Sport Bundesliga 1 HD', 'Спорт', 3, 'demo2703'),
      raw('Sky Sport Bundesliga 7 HD', 'Спорт', 4, 'demo2703'),
      raw('Eurosport 1 HD CEE', 'Спорт', 5, 'demo1459'),
      raw('Eurosport 1 HD', 'Спорт', 6, 'demo1459'),
    ];
    const cat = catalog(raws);
    expect(cat.group('Спорт')!.channels.map(function (c) { return c.name; }))
      .toEqual(['NHL', 'Sky Sport Bundesliga 1 HD', 'Sky Sport Bundesliga 7 HD', 'Eurosport 1 HD']);
    expect(cat.group('Спорт')!.channels[0].alts.map(function (c) { return c.name; })).toEqual(['NHL Network HD']);
    expect(cat.group('Спорт')!.channels[3].alts.map(function (c) { return c.name; })).toEqual(['Eurosport 1 HD CEE']);
    Prefs.groupQuality = old;
    UserData.dropPlaylist(pid);
  });

  it('разные tvg-id у «Канал» и «Канал HD» — разные строки, одинаковый — одна', () => {
    UserData.dropPlaylist(pid);
    const old = Prefs.groupQuality;
    Prefs.groupQuality = true;
    const split = catalog([raw('Канал', 'ТВ', 1, 'id1'), raw('Канал HD', 'ТВ', 2, 'id2')]);
    expect(split.group('ТВ')!.channels.map(function (c) { return c.name; })).toEqual(['Канал', 'Канал HD']);
    const same = catalog([raw('Канал', 'ТВ', 1, 'id1'), raw('Канал HD', 'ТВ', 2, 'id1')]);
    expect(same.group('ТВ')!.channels.map(function (c) { return c.name; })).toEqual(['Канал']);
    expect(same.group('ТВ')!.channels[0].alts.map(function (c) { return c.name; })).toEqual(['Канал HD']);
    Prefs.groupQuality = old;
    UserData.dropPlaylist(pid);
  });

  it('программа-заглушка исключает tvg-id, но версии качества по имени остаются', () => {
    UserData.dropPlaylist(pid);
    const old = Prefs.groupQuality;
    Prefs.groupQuality = true;
    const raws = [
      raw('Жара', 'Музыка', 1, 'demo202'),
      raw('Жара Радио', 'Музыка', 2, 'demo202'),
      raw('Канал', 'ТВ', 3, 'id1'),
      raw('Канал HD', 'ТВ', 4, 'id1'),
    ];
    const cat = catalog(raws, { 'demo202': true });
    expect(cat.group('Музыка')!.channels.map(function (c) { return c.name; })).toEqual(['Жара', 'Жара Радио']);
    expect(cat.group('ТВ')!.channels.map(function (c) { return c.name; })).toEqual(['Канал']);
    expect(cat.group('ТВ')!.channels[0].alts.map(function (c) { return c.name; })).toEqual(['Канал HD']);
    Prefs.groupQuality = old;
    UserData.dropPlaylist(pid);
  });
});
