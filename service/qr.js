/*
 * Одноразовая передача URL плейлиста с телефона на телевизор.
 * Телефон подключается только к временной странице на LAN :47381.
 * Сетевой прокси (/p и /s) по-прежнему доступен исключительно на 127.0.0.1:47380.
 * ES5, Node.js 0.12+, без дополнительных пакетов.
 */
'use strict';
var http = require('http');
var crypto = require('crypto');
var os = require('os');
var querystring = require('querystring');
var PORT = 47381;
var EXPIRE_MS = 5 * 60 * 1000;
var server = null;
var opening = false;
var waiters = [];
var session = null;
var expireTimer = null;

function json(out, status, body) {
  out.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*' });
  out.end(JSON.stringify(body));
}

function html(out, status, body) {
  out.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"
  });
  out.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Perfect TV</title><style>' +
    'body{box-sizing:border-box;margin:0;padding:35px 18px;background:#141515;color:white;font:17px system-ui,sans-serif}' +
    'main{max-width:520px;margin:0 auto}h1{font-size:28px}p{color:#bbc3c8;line-height:1.5}' +
    'label{display:block;margin:20px 0 7px}input{width:100%;box-sizing:border-box;background:#292c30;border:1px solid #62666a;padding:14px;border-radius:8px;color:white;font:16px sans-serif}' +
    'button{width:100%;margin-top:24px;padding:15px;border:0;border-radius:8px;font:700 17px sans-serif;cursor:pointer}' +
    '</style></head><body><main>' + body + '</main></body></html>');
}

function page(out, token) {
  html(out, 200, '<h1>Perfect TV</h1><p>Введите адрес M3U/M3U8-плейлиста. ' +
    'Ссылка будет передана телевизору в вашей локальной сети.</p>' +
    '<form action="/q/' + token + '" method="post" accept-charset="utf-8">' +
    '<label for="url">Адрес плейлиста</label><input id="url" name="url" type="url" inputmode="url" ' +
    'placeholder="https://example.com/playlist.m3u" required maxlength="4096" autofocus>' +
    '<label for="name">Название (необязательно)</label><input id="name" name="name" maxlength="100" placeholder="Мой IPTV">' +
    '<button type="submit">Отправить на телевизор</button></form>');
}

function validUrl(v) {
  return typeof v === 'string' && v.length > 7 && v.length <= 4096 &&
    /^https?:\/\/[^\s]+$/i.test(v) && !/[\x00-\x1f\x7f]/.test(v);
}

function handler(req, out) {
  var m = /^\/q\/([0-9a-f]{32})$/.exec(req.url || '');
  if (!m || !session || m[1] !== session.token || Date.now() >= session.expires) {
    return html(out, 404, '<h1>Ссылка недействительна</h1><p>Откройте новый QR-код в настройках Perfect TV.</p>');
  }
  if (req.method === 'GET') return page(out, m[1]);
  if (req.method !== 'POST') return html(out, 405, '<h1>Метод не поддерживается</h1>');
  var body = '';
  req.on('data', function (chunk) {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body, 'utf8') > 8192) req.destroy();
  });
  req.on('end', function () {
    if (!session || m[1] !== session.token || Date.now() >= session.expires) return html(out, 404, '<h1>Время истекло</h1>');
    var fields = querystring.parse(body);
    var address = typeof fields.url === 'string' ? fields.url.trim() : '';
    if (!validUrl(address)) return html(out, 400, '<h1>Неверный адрес</h1><p>Нужна ссылка http:// или https:// на плейлист.</p>');
    var name = typeof fields.name === 'string' ? fields.name.trim().slice(0, 100) : '';
    session.url = address;
    session.name = name;
    html(out, 200, '<h1>Ссылка отправлена ✓</h1><p>Теперь вернитесь к телевизору. ' +
      'Perfect TV добавит плейлист и начнёт загрузку каналов.</p>');
  });
}

function lanIp() {
  var ifaces = os.networkInterfaces();
  var best = '', score = -1;
  for (var name in ifaces) {
    if (!ifaces.hasOwnProperty(name)) continue;
    for (var i = 0; i < ifaces[name].length; i++) {
      var n = ifaces[name][i];
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.internal || !n.address) continue;
      var ip = n.address;
      var privateNet = /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip);
      if (!privateNet) continue;
      var rank = 1;
      if (/^(eth|en|wlan|wl)/i.test(name)) rank += 4;
      if (/^192\.168\./.test(ip)) rank += 1;
      if (rank > score) { best = ip; score = rank; }
    }
  }
  return best;
}

function shutdownIfIdle() {
  if (session) return;
  if (server && !opening) {
    var old = server;
    server = null;
    try { old.close(); } catch (e) { /* already closed */ }
  }
}

function cancel(token) {
  if (session && token === session.token) {
    session = null;
    if (expireTimer) clearTimeout(expireTimer);
    expireTimer = null;
  }
  shutdownIfIdle();
}

function ensureServer(cb) {
  if (server && !opening) return cb(null);
  waiters.push(cb);
  if (opening) return;
  opening = true;
  var s = http.createServer(handler);
  server = s;
  var done = false;
  function finish(err) {
    if (done) return;
    done = true;
    opening = false;
    if (err) server = null;
    var w = waiters;
    waiters = [];
    for (var i = 0; i < w.length; i++) w[i](err || null);
  }
  s.on('error', function (err) { finish(err); if (server === s) server = null; });
  s.listen(PORT, '0.0.0.0', function () { finish(null); if (!session) shutdownIfIdle(); });
}

function create(cb) {
  var ip = lanIp();
  if (!ip) return cb(new Error('TV LAN IPv4 address not found'));
  ensureServer(function (err) {
    if (err) return cb(err);
    // Меняем токен без закрытия уже слушающего LAN-сервера.
    if (session) { session = null; if (expireTimer) clearTimeout(expireTimer); expireTimer = null; }
    var token = crypto.randomBytes(16).toString('hex');
    var expires = Date.now() + EXPIRE_MS;
    session = { token: token, url: '', name: '', expires: expires };
    expireTimer = setTimeout(function () { cancel(token); }, EXPIRE_MS);
    if (expireTimer.unref) expireTimer.unref();
    cb(null, { returnValue: true, url: 'http://' + ip + ':' + PORT + '/q/' + token,
      token: token, expires: expires });
  });
}

function status(token) {
  if (!session || session.token !== token || Date.now() >= session.expires) {
    return { returnValue: false, error: 'expired' };
  }
  return { returnValue: true, ready: !!session.url, url: session.url || '', name: session.name || '' };
}

module.exports = { create: create, status: status, cancel: cancel, json: json, port: PORT };
