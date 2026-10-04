/*
 * Передача M3U/XMLTV в приложение через Luna вместо localhost HTTP.
 * На некоторых LG webOS сервис Node работает, но слушающий TCP-порт недоступен.
 * Данные идут небольшими base64-порциями с backpressure; Node 0.12 / ES5.
 */
'use strict';
var proxy = require('./proxy.js');
var sessions = {};
var nextId = 1;
var MAX_SESSIONS = 4;
// Base64 увеличивает сообщение на 1/3; держим ответ с запасом < 64 КБ.
var READ_BYTES = 32 * 1024;
var QUEUE_LIMIT = 512 * 1024;

function count() {
  var n = 0;
  for (var id in sessions) if (sessions.hasOwnProperty(id)) n++;
  return n;
}

function close(id) {
  var s = sessions[id];
  if (!s) return;
  delete sessions[id];
  if (s.waitTimer) clearTimeout(s.waitTimer);
  s.waitTimer = null;
  if (s.waiter) {
    var waiter = s.waiter;
    s.waiter = null;
    waiter({ returnValue: false, error: 'closed' });
  }
  try { if (s.request) s.request.abort(); } catch (e) { /* */ }
  try { if (s.body && s.body.destroy) s.body.destroy(); } catch (e) { /* */ }
}

function wake(s) {
  if (s.waiter) {
    var waiter = s.waiter;
    s.waiter = null;
    if (s.waitTimer) clearTimeout(s.waitTimer);
    s.waitTimer = null;
    deliver(s, waiter);
  }
}

function deliver(s, cb) {
  s.touched = Date.now();
  if (!s.queue.length && !s.ended) {
    if (s.waiter) return cb({ returnValue: false, error: 'busy' });
    s.waiter = cb;
    s.waitTimer = setTimeout(function () {
      s.ended = true;
      s.error = 'read timeout';
      wake(s);
    }, 45000);
    return;
  }
  var parts = [];
  var total = 0;
  while (s.queue.length && total < READ_BYTES) {
    var b = s.queue[0];
    var take = Math.min(b.length, READ_BYTES - total);
    parts.push(take === b.length ? b : b.slice(0, take));
    total += take;
    if (take === b.length) s.queue.shift();
    else s.queue[0] = b.slice(take);
  }
  s.size -= total;
  if (s.body && s.size < QUEUE_LIMIT / 2) s.body.resume();
  var end = s.ended && s.queue.length === 0;
  var response = { returnValue: true, data: Buffer.concat(parts, total).toString('base64'),
    bytes: total, end: end, error: end ? s.error : '' };
  cb(response);
  if (end) close(s.id);
}

function open(args, cb) {
  args = args || {};
  if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) {
    return cb({ returnValue: false, error: 'Invalid URL' });
  }
  if (count() >= MAX_SESSIONS) return cb({ returnValue: false, error: 'Too many streams' });
  var id = String(nextId++);
  var headers = {};
  var k;
  var userHeaders = args.headers || {};
  for (k in userHeaders) if (userHeaders.hasOwnProperty(k) && typeof userHeaders[k] === 'string') {
    headers[k] = userHeaders[k];
  }
  if (args.etag) headers['If-None-Match'] = String(args.etag);
  if (args.lastModified) headers['If-Modified-Since'] = String(args.lastModified);
  var s = sessions[id] = { id: id, queue: [], size: 0, ended: false,
    error: '', body: null, request: null, waiter: null, waitTimer: null,
    touched: Date.now() };
  s.request = proxy.request(args.url, headers, function (err, response, finalUrl) {
    if (!sessions[id]) return;
    if (err) {
      close(id);
      return cb({ returnValue: false, error: err.message || 'network' });
    }
    var hd = {};
    var names = ['content-type', 'date', 'etag', 'last-modified', 'content-length', 'content-encoding'];
    for (var i = 0; i < names.length; i++) if (response.headers[names[i]]) hd[names[i]] = response.headers[names[i]];
    if (hd['content-encoding']) delete hd['content-length'];
    // HTTP 304/ошибку передаём клиенту без тела. Он обработает код ответа.
    if (response.statusCode === 304 || response.statusCode >= 400) {
      response.resume();
      s.ended = true;
    } else {
      var body;
      try { body = proxy.bodyOf(response); }
      catch (e) { close(id); return cb({ returnValue: false, error: String(e.message || e) }); }
      s.body = body;
      body.on('data', function (chunk) {
        s.queue.push(chunk);
        s.size += chunk.length;
        if (s.size >= QUEUE_LIMIT) body.pause();
        wake(s);
      });
      body.on('end', function () { s.ended = true; wake(s); });
      body.on('error', function (e) { s.error = e.message || 'network'; s.ended = true; wake(s); });
      body.on('close', function () {
        if (!s.ended) { s.error = s.error || 'connection closed'; s.ended = true; wake(s); }
      });
    }
    cb({ returnValue: true, id: id, status: response.statusCode,
      url: finalUrl, headers: hd, end: s.ended && !s.queue.length });
  });
}

function read(args, cb) {
  var s = args && sessions[args.id];
  if (!s) return cb({ returnValue: false, error: 'No session' });
  deliver(s, cb);
}

// Чтобы незакрытый поток не удерживал соединение после закрытия приложения.
var sweep = setInterval(function () {
  var now = Date.now();
  for (var id in sessions) if (sessions.hasOwnProperty(id) && now - sessions[id].touched > 120000) close(id);
}, 30000);
if (sweep.unref) sweep.unref();

module.exports = { open: open, read: read, close: close };