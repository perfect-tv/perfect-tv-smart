/*
 * Локальный прокси приложения (§2 «Сеть»): http://127.0.0.1:47380
 *
 * Упакованное приложение webOS (file://) упирается в CORS и не может ставить User-Agent / Referer.
 * Прокси ходит в сеть сам: с заголовками канала, редиректами, распаковкой gzip, и отвечает
 * с Access-Control-Allow-Origin: *.
 *
 *   GET /ping                         {"ok":true,"v":1}
 *   GET /p?u=<url>&h=<json>           ответ сервера как есть (+ CORS);.m3u8 — адреса внутри переписаны на прокси
 *   GET /s/open?u=<url>&h=<json>      сессия чтения кусками: {"id","status","headers","url"}
 *   GET /s/read?id=<id>&max=<байты>   очередной кусок (ждёт данных); X-End: 1 — конец, X-Error — ошибка
 *   GET /s/close?id=<id>
 *
 * Код — ES5 и только модули Node: на webOS 3 в JS-сервисе Node 0.12.
 * На ПК: node service/proxy.js [порт]
 */
'use strict';
var http = require('http');
var https = require('https');
var urlMod = require('url');
var zlib = require('zlib');

var PORT = 47380;
var VERSION = 1;
var server = null;
var sessions = {};
var nextId = 1;

function log {
  if (process.env.PROXY_LOG) console.log.apply(console, arguments);
}

function cors(h) {
  h['Access-Control-Allow-Origin'] = '*';
  h['Access-Control-Allow-Headers'] = '*';
  h['Access-Control-Expose-Headers'] = 'Date, ETag, Last-Modified, Content-Length, Content-Type, X-Url, X-Status, X-End, X-Error, Content-Range, Accept-Ranges';
  return h;
}

function parseHeaders(h) {
  if (!h) return {};
  try {
    var o = JSON.parse(h);
    return o && typeof o === 'object'? o: {};
  } catch (e) { return {}; }
}

/** Запрос с редиректами; cb(err, res, finalUrl) */
function request(url, headers, cb, depth) {
  depth = depth || 0;
  var u;
  try { u = urlMod.parse(url); } catch (e) { return cb(e); }
  if (u.protocol!== 'http:' && u.protocol!== 'https:') return cb(new Error('protocol'));
  var lib = u.protocol === 'https:'? https: http;
  var h = {};
  var k;
  for (k in headers) if (headers.hasOwnProperty(k)) h[k] = headers[k];
  if (!hasHeader(h, 'user-agent')) h['User-Agent'] = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0 Safari/537.36 PerfectTV';
  if (!hasHeader(h, 'accept-encoding')) h['Accept-Encoding'] = 'gzip';
  var opts = {
    protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path, method: 'GET', headers: h,
    rejectUnauthorized: false
  };
  var done = false;
  var req = lib.request(opts, function (res) {
    if (done) return;
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 8) {
      done = true;
      res.resume;
      return request(urlMod.resolve(url, res.headers.location), headers, cb, depth + 1);
    }
    done = true;
    cb(null, res, url);
  });
  req.setTimeout(30000, function  { req.abort; });
  req.on('error', function (e) { if (!done) { done = true; cb(e); } });
  req.end;
  return req;
}

function hasHeader(h, name) {
  for (var k in h) if (h.hasOwnProperty(k) && k.toLowerCase === name) return true;
  return false;
}

/** Тело с учётом Content-Encoding */
function bodyOf(res) {
  var enc = (res.headers['content-encoding'] || '').toLowerCase;
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip);
  if (enc === 'deflate') return res.pipe(zlib.createInflate);
  return res;
}

function isPlaylist(url, res) {
  var ct = (res.headers['content-type'] || '').toLowerCase;
  if (ct.indexOf('mpegurl') >= 0) return true;
  var p = urlMod.parse(url).pathname || '';
  return /\.m3u8$/i.test(p) && ct.indexOf('video/') < 0;
}

function proxied(abs, hRaw) {
  return '/p?u=' + encodeURIComponent(abs) + (hRaw? '&h=' + encodeURIComponent(hRaw): '');
}

/** Адреса в HLS-плейлисте — на прокси (с теми же заголовками) */
function rewriteM3u8(text, base, hRaw) {
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].replace(/\r$/, '');
    if (!l) continue;
    if (l.charAt(0) === '#') {
      lines[i] = l.replace(/URI="([^"]+)"/g, function (m, u) {
        if (/^(data|skd):/i.test(u)) return m;
        return 'URI="http://127.0.0.1:' + PORT + proxied(urlMod.resolve(base, u), hRaw) + '"';
      });
    } else {
      lines[i] = 'http://127.0.0.1:' + PORT + proxied(urlMod.resolve(base, l.trim), hRaw);
    }
  }
  return lines.join('\n');
}

function copyHeaders(res, extra) {
  var h = cors({});
  var pass = ['content-type', 'date', 'etag', 'last-modified', 'content-range', 'accept-ranges', 'cache-control'];
  for (var i = 0; i < pass.length; i++) if (res.headers[pass[i]]) h[pass[i]] = res.headers[pass[i]];
  var enc = (res.headers['content-encoding'] || '').toLowerCase;
  if (!enc && res.headers['content-length']) h['content-length'] = res.headers['content-length'];
  for (var k in extra) if (extra.hasOwnProperty(k)) h[k] = extra[k];
  return h;
}

function fail(out, code, msg) {
  if (out.headersSent) { try { out.end; } catch (e) { /* */ } return; }
  out.writeHead(code, cors({ 'Content-Type': 'text/plain', 'X-Error': String(msg).slice(0, 200) }));
  out.end(String(msg));
}

function handleProxy(q, req, out) {
  var url = q.u;
  if (!url) return fail(out, 400, 'no url');
  var hRaw = q.h || '';
  var headers = parseHeaders(hRaw);
  // Range и условные заголовки клиента — дальше
  ['range', 'if-none-match', 'if-modified-since'].forEach(function (k) { if (req.headers[k]) headers[k] = req.headers[k]; });
  var upstream = request(url, headers, function (err, res, finalUrl) {
    if (err) return fail(out, 502, err.message || 'network');
    log('proxy', res.statusCode, finalUrl);
    var extra = { 'X-Url': finalUrl, 'X-Status': String(res.statusCode) };
    if (res.statusCode < 400 && isPlaylist(finalUrl, res)) {
      var chunks = [];
      var body = bodyOf(res);
      body.on('data', function (c) { chunks.push(c); });
      body.on('error', function (e) { fail(out, 502, e.message); });
      body.on('end', function  {
        var text = rewriteM3u8(Buffer.concat(chunks).toString('utf8'), finalUrl, hRaw);
        var h = copyHeaders(res, extra);
        delete h['content-length'];
        h['content-type'] = 'application/vnd.apple.mpegurl';
        out.writeHead(res.statusCode, h);
        out.end(text);
      });
      return;
    }
    out.writeHead(res.statusCode, copyHeaders(res, extra));
    var b = bodyOf(res);
    b.on('error', function  { try { out.end; } catch (e) { /* */ } });
    b.pipe(out);
  });
  req.on('close', function  { if (upstream) try { upstream.abort; } catch (e) { /* */ } });
}

// ---------------------------------------------------------------- сессии чтения кусками

function sessionOpen(q, out) {
  var url = q.u;
  if (!url) return fail(out, 400, 'no url');
  var headers = parseHeaders(q.h || '');
  if (q.etag) headers['If-None-Match'] = q.etag;
  if (q.lm) headers['If-Modified-Since'] = q.lm;
  var id = String(nextId++);
  var s = { id: id, queue: [], size: 0, ended: false, error: '', waiter: null, touched: Date.now, body: null, req: null };
  s.req = request(url, headers, function (err, res, finalUrl) {
    if (err) {
      out.writeHead(200, cors({ 'Content-Type': 'application/json' }));
      out.end(JSON.stringify({ id: '', status: 0, error: err.message || 'network' }));
      return;
    }
    sessions[id] = s;
    var h = {};
    ['content-type', 'content-length', 'date', 'etag', 'last-modified', 'content-encoding'].forEach(function (k) { if (res.headers[k]) h[k] = res.headers[k]; });
    if (h['content-encoding']) delete h['content-length'];
    if (res.statusCode >= 300) { res.resume; s.ended = true; }
    else {
      var body = bodyOf(res);
      s.body = body;
      body.on('data', function (c) {
        s.queue.push(c);
        s.size += c.length;
        if (s.size > 4 * 1024 * 1024) body.pause;
        wake(s);
      });
      body.on('end', function  { s.ended = true; wake(s); });
      body.on('error', function (e) { s.error = e.message || 'network'; s.ended = true; wake(s); });
    }
    out.writeHead(200, cors({ 'Content-Type': 'application/json' }));
    out.end(JSON.stringify({ id: id, status: res.statusCode, headers: h, url: finalUrl }));
  });
}

function wake(s) {
  var w = s.waiter;
  if (w) { s.waiter = null; w; }
}

function sessionRead(q, out) {
  var s = sessions[q.id];
  if (!s) return fail(out, 404, 'no session');
  s.touched = Date.now;
  var max = Math.max(65536, Math.min(8 * 1024 * 1024, parseInt(q.max, 10) || 1048576));
  function send {
    if (!s.queue.length &&!s.ended) {
      s.waiter = send;
      return;
    }
    var parts = [];
    var n = 0;
    while (s.queue.length && n < max) {
      var c = s.queue[0];
      if (n + c.length > max) {
        parts.push(c.slice(0, max - n));
        s.queue[0] = c.slice(max - n);
        n = max;
        break;
      }
      parts.push(c);
      n += c.length;
      s.queue.shift;
    }
    s.size -= n;
    if (s.body && s.size < 1024 * 1024) s.body.resume;
    var end = s.ended &&!s.queue.length;
    var h = cors({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(n) });
    if (end) h['X-End'] = '1';
    if (end && s.error) h['X-Error'] = s.error;
    out.writeHead(200, h);
    out.end(Buffer.concat(parts, n));
    if (end) delete sessions[s.id];
  }
  send;
}

function sessionClose(q, out) {
  var s = sessions[q.id];
  if (s) {
    delete sessions[q.id];
    try { if (s.req) s.req.abort; } catch (e) { /* */ }
  }
  out.writeHead(200, cors({ 'Content-Type': 'text/plain' }));
  out.end('ok');
}

setInterval(function  {
  var t = Date.now;
  for (var id in sessions) {
    if (sessions.hasOwnProperty(id) && t - sessions[id].touched > 120000) {
      try { if (sessions[id].req) sessions[id].req.abort; } catch (e) { /* */ }
      delete sessions[id];
    }
  }
}, 30000).unref;

function handler(req, out) {
  var u = urlMod.parse(req.url, true);
  var q = u.query || {};
  if (req.method === 'OPTIONS') { out.writeHead(204, cors({})); return out.end; }
  switch (u.pathname) {
    case '/ping': out.writeHead(200, cors({ 'Content-Type': 'application/json' })); return out.end(JSON.stringify({ ok: true, v: VERSION }));
    case '/p': return handleProxy(q, req, out);
    case '/s/open': return sessionOpen(q, out);
    case '/s/read': return sessionRead(q, out);
    case '/s/close': return sessionClose(q, out);
    default: return fail(out, 404, 'not found');
  }
}

/** Запустить (повторный вызов — ничего не делает); cb(err) */
function start(port, cb) {
  if (server) { if (cb) cb(null); return; }
  PORT = port || PORT;
  server = http.createServer(handler);
  server.on('error', function (e) {
    server = null;
    // порт занят — значит, прокси уже работает (прошлый экземпляр сервиса)
    if (cb) cb(e.code === 'EADDRINUSE'? null: e);
    cb = null;
  });
  server.listen(PORT, '127.0.0.1', function  { if (cb) cb(null); cb = null; });
}

module.exports = { start: start, PORT: PORT, rewriteM3u8: rewriteM3u8 };

if (require.main === module) {
  var p = parseInt(process.argv[2], 10) || PORT;
  start(p, function (e) {
    if (e) { console.error(e); process.exit(1); }
    console.log('прокси Perfect TV: http://127.0.0.1:' + p);
  });
}
