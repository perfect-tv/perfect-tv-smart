import { describe, it, expect } from 'vitest';
import { RecordDb, recordKey } from '../src/core/data/db';
import { Playlist } from '../src/core/data/models';
import { Repo } from '../src/core/data/repo';
import { usePlatform } from '../src/core/platform';

/** Хранилище записей в памяти — как Db платформы, с ключами по схеме core/data/db.ts */
function memoryDb(): RecordDb {
  const data: { [store: string]: { [key: string]: any } } = {};
  const store = (name: string) => data[name] || (data[name] = {});
  const key = (name: string, k: any) => JSON.stringify(k);
  return {
    get: function (name, k) { return Promise.resolve(store(name)[key(name, k)]); },
    put: function (name, v) { store(name)[key(name, recordKey(name, v))] = v; return Promise.resolve(); },
    putAll: function (name, values) { for (let i = 0; i < values.length; i++) store(name)[key(name, recordKey(name, values[i]))] = values[i]; return Promise.resolve(); },
    delete: function (name, k) { delete store(name)[key(name, k)]; return Promise.resolve(); },
    all: function (name) { const s = store(name); return Promise.resolve(Object.keys(s).map(function (k) { return s[k]; })); },
    deleteWhere: function () { return Promise.resolve(0); },
    deleteRange: function () { return Promise.resolve(); },
    drop: function () { return Promise.resolve(); },
  } as RecordDb;
}

function playlist(id: number, url: string): Playlist {
  return { id: id, name: 'Плейлист ' + id, url: url, epgMode: 0, userEpg: [], headerEpg: [], loadedAt: 0, channelsCount: 0, error: '', sort: id - 1 };
}

describe('добавление плейлиста', () => {
  it('не перезаписывает первый плейлист, если список в памяти ещё не загружен', async () => {
    const db = memoryDb();
    usePlatform({ db: db } as any);
    await db.put('playlists', playlist(1, 'http://example.com/first.m3u'));
    // QR/настройки успели открыться до loadPlaylists: в памяти пусто
    const repo = new Repo();
    const added = await repo.addPlaylist('Второй', 'http://example.com/second.m3u');
    const all = await db.all<Playlist>('playlists');
    expect(added.id).toBe(2);
    expect(all.map(function (p) { return p.id; }).sort()).toEqual([1, 2]);
    const first = await db.get<Playlist>('playlists', 1);
    expect(first && first.url).toBe('http://example.com/first.m3u');
  });
});
