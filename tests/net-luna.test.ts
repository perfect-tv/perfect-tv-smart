import { describe, expect, it, vi } from 'vitest';

const luna = vi.hoisted(() => ({
  isWebOS: true,
  startService: vi.fn(),
  requestService: vi.fn(),
}));
vi.mock('../src/platform/webos/luna', () => ({ Luna: luna }));

import { WebosProxy } from '../src/platform/webos/proxy';

describe('Прокси webOS: обход CORS через Luna без локального HTTP', () => {
  it('читает M3U в чанках через PalmServiceBridge и закрывает сессию', async () => {
    (globalThis as any).document = {};
    const raw = new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Канал\nhttp://example.com/live.m3u8\n');
    const half = Math.floor(raw.length / 2);
    let reads = 0;
    luna.requestService.mockImplementation((method: string, args: any) => {
      if (method === 'ping') return Promise.resolve({ returnValue: true, proxyReady: false, node: '0.12.2' });
      if (method === 'streamOpen') return Promise.resolve({ returnValue: true, id: 'abc', status: 200, url: args.url,
        headers: { 'content-type': 'audio/x-mpegurl' } });
      if (method === 'streamRead') {
        const part = reads++ === 0 ? raw.slice(0, half) : raw.slice(half);
        return Promise.resolve({ returnValue: true, data: Buffer.from(part).toString('base64'), end: reads === 2 });
      }
      if (method === 'streamClose') return Promise.resolve({ returnValue: true });
      throw new Error('unexpected RPC ' + method);
    });
    const bytes: number[] = [];
    const result = await WebosProxy.stream('https://example.com/list.m3u', {}, chunk => {
      for (let i = 0; i < chunk.length; i++) bytes.push(chunk[i]);
    });
    expect(new TextDecoder().decode(new Uint8Array(bytes))).toContain('Канал');
    expect(result.status).toBe(200);
    expect(result.proxied).toBe(true);
    expect(WebosProxy.luna).toBe(true);
    expect(luna.requestService).toHaveBeenCalledWith('streamClose', { id: 'abc' }, 5000);
    delete (globalThis as any).document;
  });

  it('не маскирует HTTP 403 и закрывает сессию', async () => {
    (globalThis as any).document = {};
    luna.requestService.mockImplementation((method: string) => {
      if (method === 'streamOpen') return Promise.resolve({ returnValue: true, id: 'forbidden', status: 403,
        headers: {}, url: 'https://example.com/blocked' });
      if (method === 'streamClose') return Promise.resolve({ returnValue: true });
      throw new Error('Unexpected ' + method);
    });
    await expect(WebosProxy.stream('https://example.com/blocked', {}, () => {}))
      .rejects.toMatchObject({ code: 'http_403', status: 403 });
    expect(luna.requestService).toHaveBeenCalledWith('streamClose', { id: 'forbidden' }, 5000);
    delete (globalThis as any).document;
  });
});
