import { Net, NetError } from '../net';
import { Catchup, RawChannel, cleanName } from './m3u';
import { Playlist } from './models';

/**
 * Xtream Codes: сервер + логин + пароль вместо M3U (docs/TZ.md, §4).
 * API — player_api.php, программа — xmltv.php, прямой поток — /live/<user>/<pass>/<id>.<m3u8|ts>.
 * Данные канала те же, что у M3U, поэтому дальше работает общий каталог, гид и архив.
 */
export interface XtreamAccount { server: string; username: string; password: string }

/** Разобрать ввод: адрес сервера, player_api.php, get.php?username=…&password=… или адрес с логином */
export function normalizeXtreamAccount(input: string): XtreamAccount {
  let s = String(input || '').trim().split('#')[0];
  let query = '';
  const q = s.indexOf('?');
  if (q >= 0) { query = s.substring(q + 1); s = s.substring(0, q); }
  s = s.replace(/\/+(?:player_api|get|xmltv)\.php.*$/i, '');
  const hadScheme = /^https?:\/\//i.test(s);
  s = s.replace(/\/+$/, '');
  if (s && !hadScheme) s = 'http://' + s;
  // без хоста (http://, «/player_api.php») адрес негоден
  if (s && !/^https?:\/\/[^\/]+/i.test(s)) s = '';
  const p = parseQuery(query);
  return { server: s, username: p.username || '', password: p.password || '' };
}

function parseQuery(q: string): { [k: string]: string } {
  const out: { [k: string]: string } = {};
  const parts = q.split('&');
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq <= 0) continue;
    const k = parts[i].substring(0, eq);
    const v = parts[i].substring(eq + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { out[k] = v; }
  }
  return out;
}

function enc(s: string): string { return encodeURIComponent(s); }

/** player_api.php с логином; action — get_live_categories и т.п. */
export function apiUrl(server: string, user: string, pass: string, action?: string): string {
  let u = server + '/player_api.php?username=' + enc(user) + '&password=' + enc(pass);
  if (action) u += '&action=' + enc(action);
  return u;
}

/** XMLTV-программа Xtream; адрес хранится в headerEpg и грузится общим разборщиком */
export function xmltvUrl(server: string, user: string, pass: string): string {
  return server + '/xmltv.php?username=' + enc(user) + '&password=' + enc(pass);
}

/** Прямой поток Xtream */
export function liveUrl(server: string, user: string, pass: string, streamId: string | number, output: 'm3u8' | 'ts'): string {
  return server + '/live/' + enc(user) + '/' + enc(pass) + '/' + enc(String(streamId)) + '.' + (output === 'ts' ? 'ts' : 'm3u8');
}

/** JSON Xtream: BOM/HTML/битый ответ — понятная ошибка, а не падение разбора */
export function parseXtreamJson(text: string): any {
  const s = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!s) throw new NetError('format');
  try { return JSON.parse(s); } catch (e) { throw new NetError('format'); }
}

/** Ответ API с user_info.auth = 0 — неверный логин/пароль/срок действия */
export function checkXtreamAuth(json: any): void {
  const u = json && json.user_info;
  if (u && (u.auth === 0 || u.auth === '0' || u.auth === false || u.status === 'Disabled' || u.status === 'Banned')) {
    throw new NetError('xtream_auth');
  }
}

/**
 * Смещение сервера в минутах (для URL архива Xtream: время в нём — местное время сервера).
 * server_info.time_now — местное время сервера, timestamp_now — UTC. Нет данных — null.
 */
export function serverOffsetMinutes(json: any): number | null {
  const si = json && json.server_info;
  if (!si) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(si.time_now || ''));
  let ts = Number(si.timestamp_now);
  if (!m || !isFinite(ts)) return null;
  if (ts > 1e12) ts = ts / 1000;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  return Math.round((utc - ts) / 60);
}

interface XtreamStream {
  num?: number | string;
  name?: string;
  stream_id?: number | string;
  stream_icon?: string;
  epg_channel_id?: string | null;
  category_id?: number | string;
  tv_archive?: number | string | boolean;
  tv_archive_duration?: number | string;
}

interface XtreamCategory { category_id?: number | string; category_name?: string }

/** Ответ get_live_streams → каналы приложения; категории — id → название */
export function buildXtreamChannels(streams: XtreamStream[], categories: XtreamCategory[],
  account: XtreamAccount, output: 'm3u8' | 'ts', offset: number | null): RawChannel[] {
  const groups: { [id: string]: string } = {};
  for (let i = 0; i < categories.length; i++) {
    const c = categories[i];
    if (c && c.category_id !== undefined) groups[String(c.category_id)] = String(c.category_name || '');
  }
  const out: RawChannel[] = [];
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    if (!s || s.stream_id === undefined || s.stream_id === null) continue;
    let num = parseInt(String(s.num === undefined ? '' : s.num), 10);
    if (!isFinite(num) || num <= 0) num = i + 1;
    const name = cleanName(String(s.name || '').trim()) || ('Ch ' + num);
    const archiveValue = String(s.tv_archive === undefined ? '' : s.tv_archive).toLowerCase();
    const archive = s.tv_archive === true || archiveValue === '1' || archiveValue === 'true';
    const days = parseInt(String(s.tv_archive_duration === undefined ? '' : s.tv_archive_duration), 10) || 0;
    const catchup: Catchup | null = archive ? { type: 'xc', source: '', days: days } : null;
    out.push({
      num: num,
      name: name,
      url: liveUrl(account.server, account.username, account.password, s.stream_id, output),
      group: s.category_id === undefined ? '' : (groups[String(s.category_id)] || ''),
      logo: String(s.stream_icon || ''),
      tvgId: String(s.epg_channel_id || '').trim(),
      tvgName: name,
      tvgShift: 0,
      catchup: catchup,
      catchupOffset: catchup ? offset : null,
      userAgent: '',
      referrer: '',
      headersJson: '',
    });
  }
  return out;
}

export interface XtreamPlaylistResult {
  list: RawChannel[];
  header: { [k: string]: string };
  notModified: boolean;
}

/** Загрузка live-каналов Xtream. Программа подключается адресом xmltv.php через headerEpg. */
export function loadXtreamPlaylist(p: Playlist, onPartial?: (list: RawChannel[], header: { [k: string]: string }) => void,
  onProgress?: (read: number, channels: number) => void): Promise<XtreamPlaylistResult> {
  const acc = normalizeXtreamAccount(p.url);
  if (!acc.server) return Promise.reject(new NetError('no_url'));
  const user = p.username || acc.username;
  const pass = p.password || acc.password;
  if (!user || !pass) return Promise.reject(new NetError('xtream_auth'));
  const output: 'm3u8' | 'ts' = p.output === 'ts' ? 'ts' : 'm3u8';
  const account: XtreamAccount = { server: acc.server, username: user, password: pass };
  console.log('xtream api', acc.server);
  return Net.text(apiUrl(account.server, user, pass)).then(function (infoText) {
    const info = parseXtreamJson(infoText);
    checkXtreamAuth(info);
    const offset = serverOffsetMinutes(info);
    return Promise.all([
      Net.text(apiUrl(account.server, user, pass, 'get_live_categories')),
      Net.text(apiUrl(account.server, user, pass, 'get_live_streams'), undefined, 120000),
    ]).then(function (r) {
      const cats = parseXtreamJson(r[0]);
      const streams = parseXtreamJson(r[1]);
      checkXtreamAuth(cats);
      checkXtreamAuth(streams);
      if (!Array.isArray(streams)) throw new NetError('format');
      const list = buildXtreamChannels(streams, Array.isArray(cats) ? cats : [], account, output, offset);
      if (!list.length) throw new NetError('empty');
      const header = { 'url-tvg': xmltvUrl(account.server, user, pass) };
      if (onProgress) onProgress(r[1].length, list.length);
      if (onPartial) onPartial(list.slice(), header);
      console.log('xtream parsed', list.length, 'channels');
      return { list: list, header: header, notModified: false };
    });
  });
}
