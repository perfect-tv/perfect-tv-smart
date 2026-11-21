import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Playlist } from '../src/core/data/models';
import { BrowserDb } from '../src/platform/browser/db';

/** localStorage в Node для проверки зеркала плейлистов */
function memoryStorage(): Storage {
  const m: { [k: string]: string } = {};
  return {
    get length() { return Object.keys(m).length; },
    clear: function () { for (const k in m) delete m[k]; },
    getItem: function (k: string) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    key: function (i: number) { return Object.keys(m)[i] || null; },
    removeItem: function (k: string) { delete m[k]; },
    setItem: function (k: string, v: string) { m[k] = String(v); },
  } as Storage;
}

function playlist(id: number, url: string): Playlist {
  return { id: id, name: 'Плейлист ' + id, url: url, epgMode: 0, userEpg: [], headerEpg: [], loadedAt: 0, channelsCount: 0, error: '', sort: id - 1 };
}

describe('плейлисты в browser: зеркало localStorage', () => {
  beforeEach(function () { (globalThis as any).localStorage = memoryStorage(); });
  afterEach(function () { delete (globalThis as any).localStorage; });

  it('при недоступном IndexedDB список читается из localStorage', async () => {
    // IndexedDB в Node нет — как после обесточивания VIDAA
    (globalThis as any).localStorage.setItem('ptvdb:playlists', JSON.stringify([playlist(1, 'http://x/1.m3u')]));
    const list = await BrowserDb.all<Playlist>('playlists');
    expect(list.map(function (p) { return p.id; })).toEqual([1]);
    expect(list[0].url).toBe('http://x/1.m3u');
  });

  it('новый плейлист сохраняется в зеркало, даже если IndexedDB не пишется', async () => {
    await BrowserDb.put('playlists', playlist(2, 'http://x/2.m3u'));
    const saved = JSON.parse((globalThis as any).localStorage.getItem('ptvdb:playlists'));
    expect(saved.map(function (p: Playlist) { return p.id; })).toEqual([2]);
    expect(saved[0].url).toBe('http://x/2.m3u');
  });

  it('удаление убирает плейлист из зеркала', async () => {
    (globalThis as any).localStorage.setItem('ptvdb:playlists', JSON.stringify([playlist(1, 'http://x/1.m3u'), playlist(2, 'http://x/2.m3u')]));
    await BrowserDb.delete('playlists', 1);
    const saved = JSON.parse((globalThis as any).localStorage.getItem('ptvdb:playlists'));
    expect(saved.map(function (p: Playlist) { return p.id; })).toEqual([2]);
  });
});
