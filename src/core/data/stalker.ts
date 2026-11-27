import { Net, NetError } from '../net';
import { sha1 } from '../sha1';
import { cleanName, RawChannel } from './m3u';
import { Playlist, SOURCE_STALKER } from './models';

/**
 * Stalker/MAG (Ministra): портал + MAC вместо плейлиста (docs/TZ.md, §4).
 * Полный портал: handshake → get_profile → itv/get_all_channels; простые панели
 * (reseller `portal.php`) отвечают без токена. Ссылка канала — либо готовый `cmd`
 * (`ffrt3 http://…`), либо create_link (`ffrt4://…`, `use_http_tmp_link=1`).
 */
const UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2721 Safari/533.3';
const XUA = 'Model: MAG254; Link: WiFi';
const TIMEOUT = 30000;
const PAGE = 1000;

export interface StalkerHandshake { token: string; random: string; notValid: boolean }

/** MAC в виде 00:1A:79:XX:XX:XX; '' — неверный */
export function normalizeStalkerMac(input: string): string {
  const hex = String(input || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) return '';
  let out = '';
  for (let i = 0; i < 12; i += 2) out += (i ? ':' : '') + hex.substring(i, i + 2);
  return out;
}

/** Адрес портала без player-хвоста: `…/c/` → `…`, `…/stalker_portal/c/` → `…/stalker_portal` */
export function normalizeStalkerPortal(input: string): string {
  let s = String(input || '').trim().replace(/[?#].*$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/+$/, '');
  if (/\.php$/i.test(s)) return s;
  s = s.replace(/\/c$/i, '');
  return s;
}

/** Кандидаты API: portal.php, server/load.php, stalker_portal/server/load.php */
export function stalkerEndpoints(input: string): string[] {
  const s = normalizeStalkerPortal(input);
  if (!s) return [];
  if (/\.php$/i.test(s)) return [s];
  const out = [s + '/portal.php', s + '/server/load.php'];
  if (!/\/stalker_portal$/i.test(s)) out.push(s + '/stalker_portal/server/load.php');
  return out;
}

/** prehash = SHA-1 MAC в верхнем регистре (как у MAG) */
export function stalkerPrehash(mac: string): string { return sha1(String(mac || '').toUpperCase()).toUpperCase(); }

/** Заголовки MAG: MAC в cookie, описание устройства, Bearer после handshake */
export function stalkerHeaders(portal: string, mac: string, token: string): { [k: string]: string } {
  const h: { [k: string]: string } = {
    'Cookie': 'mac=' + mac + '; stb_lang=ru; timezone=Europe/Moscow',
    'User-Agent': UA,
    'X-User-Agent': XUA,
    'Referer': portalBase(portal) + '/c/',
  };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

/** База портала: endpoint без portal.php/server/load.php и без хвоста /c */
export function portalBase(portal: string): string {
  const m = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(portal || '');
  if (!m) return String(portal || '').replace(/\/+$/, '');
  let path = m[2] || '';
  path = path.replace(/\/+(?:portal\.php|server\/load\.php)$/i, '').replace(/\/+$/, '');
  if (/\/c$/i.test(path)) path = path.replace(/\/c$/i, '');
  return m[1] + path;
}

/** Абсолютный адрес относительно портала (логотип, js.cmd) */
export function stalkerUrl(portal: string, value: string): string {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const origin = /^(https?:\/\/[^/]+)/i.exec(portal || '');
  if (!origin) return s;
  const base = portalBase(portal);
  if (s.charAt(0) === '/') return origin[1] + s;
  if (s.charAt(0) === '?') return base + s;
  return base.replace(/\/+$/, '') + '/' + s.replace(/^\/+/, '');
}

function authFailure(text: string): boolean {
  const s = String(text || '').trim();
  return /^(authorization failed|access denied|unauthorized request|invalid token|auth failed)\.?$/i.test(s);
}

/** JSON Stalker; текстовая ошибка авторизации — NetError('stalker_auth') */
export function parseStalkerJson(text: string): any {
  const s = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!s) throw new NetError('format');
  if (authFailure(s)) throw new NetError('stalker_auth');
  try { return JSON.parse(s); } catch (e) {
    if (/authorization|access denied|unauthorized|invalid token/i.test(s)) throw new NetError('stalker_auth');
    throw new NetError('format');
  }
}

function jsOf(json: any): any { return json && json.js !== undefined ? json.js : json; }

function query(params: { [k: string]: string }): string {
  const out: string[] = [];
  for (const k in params) out.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  return out.join('&');
}

/** Запрос API; token пуст — простая панель без Authorization */
export function stalkerRequest(portal: string, mac: string, token: string,
  params: { [k: string]: string }, timeout = TIMEOUT): Promise<any> {
  params.JsHttpRequest = '1-xml';
  return Net.text(portal + '?' + query(params), stalkerHeaders(portal, mac, token), timeout).then(parseStalkerJson);
}

/** handshake: токен сессии (полный портал) */
export function stalkerHandshake(portal: string, mac: string, token = ''): Promise<StalkerHandshake> {
  return stalkerRequest(portal, mac, token, {
    type: 'stb', action: 'handshake', token: token, prehash: stalkerPrehash(mac),
  }).then(function (json) {
    const js = jsOf(json) || {};
    if (!js.token) throw new NetError('stalker_auth');
    return { token: String(js.token), random: String(js.random || ''), notValid: Number(js.not_valid || 0) === 1 };
  });
}

/** get_profile: активировать токен; status 2 — портал просит логин/пароль */
export function stalkerProfile(portal: string, mac: string, hs: StalkerHandshake): Promise<any> {
  const metrics = JSON.stringify({ mac: mac, model: 'MAG250', type: 'STB', random: hs.random });
  return stalkerRequest(portal, mac, hs.token, {
    type: 'stb', action: 'get_profile', hd: '1', ver: '0.2.18-r23-250',
    num_banks: '2', stb_type: 'MAG250', client_type: 'STB', image_version: '0.2.18-r23-250',
    video_out: 'hdmi', auth_second_step: '0', not_valid_token: hs.notValid ? '1' : '0',
    metrics: metrics, prehash: stalkerPrehash(mac),
  }).then(function (json) {
    const js = jsOf(json) || {};
    if (Number(js.status) === 2) throw new NetError('stalker_login');
    if (Number(js.status) === 1) throw new NetError('stalker_auth');
    return js;
  });
}

/** `ffmpeg http://…`, `ffrt3 http://…` → адрес; `ffrt4://…` — не адрес */
export function normalizePlaybackCmd(cmd: string): string {
  const s = String(cmd || '').trim();
  const at = s.indexOf(' ');
  if (at > 0) {
    const rest = s.substring(at + 1).trim();
    if (/^https?:\/\//i.test(rest) || rest.charAt(0) === '/' || rest.charAt(0) === '?') return rest;
  }
  return s;
}

function flag(v: any): boolean {
  if (v === null || v === undefined) return false;
  if (v === true || v === 1) return true;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

/** Готовый адрес канала без create_link; '' — нужен create_link */
export function staticStalkerUrl(portal: string, cmd: string, item: any): string {
  if (flag(item && item.use_http_tmp_link) || flag(item && item.use_load_balancing)) return '';
  const url = normalizePlaybackCmd(cmd);
  if (/^https?:\/\/[^/]/i.test(url)) return url;
  if (url.charAt(0) === '/') return stalkerUrl(portal, url);
  return '';
}

interface RawStalkerGenre { id?: string | number; title?: string; name?: string }

/** Каналы Stalker → RawChannel; статический адрес или команда для create_link */
export function buildStalkerChannels(items: any[], genres: RawStalkerGenre[], portal: string, mac: string, token: string): RawChannel[] {
  const groups: { [id: string]: string } = {};
  for (let i = 0; i < genres.length; i++) {
    const g = genres[i];
    if (g && g.id !== undefined) groups[String(g.id)] = String(g.title || g.name || '');
  }
  const headers = JSON.stringify(stalkerHeaders(portal, mac, token));
  const out: RawChannel[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const cmd = String(it.cmd || (it.cmds && it.cmds[0] && it.cmds[0].cmd) || '').trim();
    const name = cleanName(String(it.name || it.o_name || '').trim()) || ('Ch ' + (i + 1));
    let num = parseInt(String(it.number === undefined ? '' : it.number), 10);
    if (!isFinite(num) || num <= 0) num = i + 1;
    const genre = it.tv_genre_id !== undefined ? it.tv_genre_id : (it.category_id !== undefined ? it.category_id : '');
    const stat = staticStalkerUrl(portal, cmd, it);
    out.push({
      num: num, name: name, url: stat, group: genre === '' ? '' : (groups[String(genre)] || ''),
      logo: stalkerUrl(portal, String(it.logo || '')),
      tvgId: String(it.xmltv_id || '').trim(), tvgName: name, tvgShift: 0,
      catchup: null, catchupOffset: null,
      userAgent: UA, referrer: portalBase(portal) + '/c/', headersJson: headers,
      stalkerCmd: stat ? '' : cmd, stalkerPortal: portal, stalkerMac: mac, stalkerToken: token,
    });
  }
  return out;
}

/** Относительный js.cmd → абсолютный адрес */
export function stalkerLinkUrl(portal: string, cmd: string, value: string): string {
  const s = normalizePlaybackCmd(value);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.charAt(0) === '?') {
    const base = normalizePlaybackCmd(cmd);
    if (/^https?:\/\//i.test(base)) return base + s;
    return portalBase(portal) + (base.charAt(0) === '/' ? base : '/' + base) + s;
  }
  if (s.charAt(0) === '/') return portalBase(portal) + s;
  return stalkerUrl(portal, s);
}

/** Временная ссылка канала (create_link); при истёкшем токене — новый handshake */
export function resolveStalkerLink(ch: { url: string; stalkerCmd: string; stalkerPortal: string; stalkerMac: string; stalkerToken: string; headersJson: string }): Promise<string> {
  if (!ch.stalkerCmd) return Promise.resolve(ch.url);
  const ask = function (token: string): Promise<string> {
    return stalkerRequest(ch.stalkerPortal, ch.stalkerMac, token, {
      type: 'itv', action: 'create_link', cmd: ch.stalkerCmd,
      disable_ad: '0', download: '0', force_ch_link_check: '0',
    }).then(function (json) {
      const js = jsOf(json) || {};
      if (js.error) throw new NetError('stalker_bad_response');
      const url = stalkerLinkUrl(ch.stalkerPortal, ch.stalkerCmd, String(js.cmd || ''));
      if (!url) throw new NetError('stalker_bad_response');
      ch.url = url;
      return url;
    });
  };
  return ask(ch.stalkerToken).then(null, function (e) {
    if (!(e instanceof NetError) || e.code !== 'stalker_auth' || !ch.stalkerMac) throw e;
    return stalkerHandshake(ch.stalkerPortal, ch.stalkerMac).then(function (hs) {
      return stalkerProfile(ch.stalkerPortal, ch.stalkerMac, hs).then(function () {
        ch.stalkerToken = hs.token;
        ch.headersJson = JSON.stringify(stalkerHeaders(ch.stalkerPortal, ch.stalkerMac, hs.token));
        return ask(hs.token);
      });
    });
  });
}

function channelData(json: any): any[] {
  const js = jsOf(json);
  if (Array.isArray(js)) return js;
  return js && Array.isArray(js.data) ? js.data : [];
}

/** all_channels, иначе по жанрам get_ordered_list с постраничной догрузкой */
function loadChannels(portal: string, mac: string, token: string, genres: RawStalkerGenre[]): Promise<any[]> {
  return stalkerRequest(portal, mac, token, { type: 'itv', action: 'get_all_channels' }, 120000).then(function (json) {
    const list = channelData(json);
    if (list.length) return list;
    const ids: string[] = [];
    for (let i = 0; i < genres.length; i++) if (genres[i] && genres[i].id !== undefined) ids.push(String(genres[i].id));
    if (!ids.length) ids.push('*');
    const out: any[] = [];
    const one = function (index: number): Promise<void> {
      if (index >= ids.length) return Promise.resolve();
      const genre = ids[index];
      let count = 0;
      const page = function (p: number): Promise<void> {
        return stalkerRequest(portal, mac, token, {
          type: 'itv', action: 'get_ordered_list', genre: genre, p: String(p), p_size: String(PAGE), sortby: 'number',
        }, 120000).then(function (json) {
          const js = jsOf(json) || {};
          const data = Array.isArray(js.data) ? js.data : [];
          for (let i = 0; i < data.length; i++) out.push(data[i]);
          count += data.length;
          const total = parseInt(String(js.total_items === undefined ? '' : js.total_items), 10);
          if (data.length && isFinite(total) && count < total && data.length >= PAGE) return page(p + 1);
        });
      };
      return page(1).then(function () { return one(index + 1); });
    };
    return one(0).then(function () { return out; });
  });
}

function loadGenres(portal: string, mac: string, token: string): Promise<RawStalkerGenre[]> {
  return stalkerRequest(portal, mac, token, { type: 'itv', action: 'get_genres' }).then(function (json) {
    const js = jsOf(json);
    return Array.isArray(js) ? js : (js && Array.isArray(js.data) ? js.data : []);
  });
}

/** Полный портал: handshake + profile; простая панель: сразу каталог без токена */
function tryPortal(endpoint: string, mac: string): Promise<{ list: RawChannel[]; token: string; endpoint: string }> {
  return stalkerHandshake(endpoint, mac).then(function (hs) {
    return stalkerProfile(endpoint, mac, hs).then(function () {
      return loadGenres(endpoint, mac, hs.token).then(function (genres) {
        return loadChannels(endpoint, mac, hs.token, genres).then(function (items) {
          const list = buildStalkerChannels(items, genres, endpoint, mac, hs.token);
          if (!list.length) throw new NetError('stalker_empty');
          return { list: list, token: hs.token, endpoint: endpoint };
        });
      });
    });
  }, function (e) {
    if (e instanceof NetError && e.code === 'stalker_login') return Promise.reject(e);
    // простая панель: ни handshake, ни Bearer не нужны
    return loadGenres(endpoint, mac, '').then(function (genres) {
      return loadChannels(endpoint, mac, '', genres).then(function (items) {
        const list = buildStalkerChannels(items, genres, endpoint, mac, '');
        if (!list.length) throw new NetError('stalker_empty');
        return { list: list, token: '', endpoint: endpoint };
      });
    }, function () { return Promise.reject(e); });
  });
}

export interface StalkerPlaylistResult {
  list: RawChannel[];
  header: { [k: string]: string };
  notModified: boolean;
}

/** Загрузка каналов Stalker: перебор кандидатов API, затем полный/простой режим */
export function loadStalkerPlaylist(p: Playlist, onPartial?: (list: RawChannel[], header: { [k: string]: string }) => void,
  onProgress?: (read: number, channels: number) => void): Promise<StalkerPlaylistResult> {
  const mac = normalizeStalkerMac(p.username || '');
  if (!mac) return Promise.reject(new NetError('stalker_mac'));
  const cands = stalkerEndpoints(p.url);
  if (!cands.length) return Promise.reject(new NetError('no_url'));
  let last: any = null;
  let index = 0;
  const next = function (): Promise<StalkerPlaylistResult> {
    if (index >= cands.length) {
      if (last instanceof NetError && (last.code === 'http_401' || last.code === 'http_403')) return Promise.reject(new NetError('stalker_auth'));
      return Promise.reject(last || new NetError('stalker_bad_response'));
    }
    const endpoint = cands[index++];
    return tryPortal(endpoint, mac).then(function (res) {
      p.url = res.endpoint;
      p.username = mac;
      p.source = SOURCE_STALKER;
      p.headerEpg = [];
      console.log('stalker loaded', endpoint, res.list.length, 'channels', res.token ? 'token' : 'simple');
      if (onProgress) onProgress(res.list.length, res.list.length);
      if (onPartial) onPartial(res.list.slice(), {});
      return { list: res.list, header: {}, notModified: false };
    }, function (e) {
      last = e;
      console.warn('stalker endpoint', endpoint, e && (e.code || e.message || e));
      return next();
    });
  };
  return next();
}
