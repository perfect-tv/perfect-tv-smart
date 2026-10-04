/* WebSocket (RFC6455) к хранилищу приложения (filekv.js) и разбору программы (epgrunner.js). Node 0.12 / ES5, без npm. */
'use strict';
var crypto = require('crypto');
var url = require('url');
var sqlite = require('./filekv.js');
var MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
var MAX_MESSAGE = 4 * 1024 * 1024;
function allowed(origin) {
  return !origin || origin === 'null' || origin === 'file://' ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(origin);
}
function frame(op, content) {
  var payload = Buffer.isBuffer(content) ? content : new Buffer(String(content || ''), 'utf8');
  var n = payload.length, h, pos;
  if (n < 126) { h = new Buffer(2); h[1] = n; pos = 2; }
  else if (n <= 65535) { h = new Buffer(4); h[1] = 126; h.writeUInt16BE(n, 2); pos = 4; }
  else { h = new Buffer(10); h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); pos = 10; }
  h[0] = 128 | op;
  return Buffer.concat([h, payload], pos + n);
}
function handle(req, socket, head) {
  var pathname = url.parse(req.url).pathname;
  if (pathname !== '/db') return socket.destroy();
  var origin = req.headers.origin || '';
  var key = req.headers['sec-websocket-key'];
  if (!allowed(origin) || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  var accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  var buffer = new Buffer(0), parts = [], size = 0, stopped = false;
  function close() { if (stopped) return; stopped = true; try { socket.end(frame(8, '')); } catch (e) { /* socket closed */ } }
  function answer(id, err, result) {
    if (stopped) return;
    var payload = JSON.stringify(err ? { id: id, ok: false, error: err.message || String(err) } :
      { id: id, ok: true, result: result || {} });
    if (payload.length > MAX_MESSAGE) payload = JSON.stringify({ id: id, ok: false, error: 'response too large' });
    try { socket.write(frame(1, payload)); } catch (e) { close(); }
  }
  function processMessage(body) {
    var msg;
    try { msg = JSON.parse(body); }
    catch (e) { return answer(null, new Error('bad JSON')); }
    if (!msg || typeof msg.id !== 'number' || typeof msg.op !== 'string') return answer(null, new Error('bad request'));
    var handler = /^epg(Start|Status|Rematch)$/.test(msg.op) ? require('./epgrunner.js') : sqlite;
    handler.dispatch(msg.op, msg, function (err, result) { answer(msg.id, err, result); });
  }
  function take(data) {
    if (stopped) return;
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 2) {
      var opcode = buffer[0] & 15, fin = !!(buffer[0] & 128), masked = !!(buffer[1] & 128);
      var len = buffer[1] & 127, pos = 2, n, hi;
      if (len === 126) { if (buffer.length < 4) break; len = buffer.readUInt16BE(2); pos = 4; }
      if (len === 127) {
        if (buffer.length < 10) break;
        hi = buffer.readUInt32BE(2); n = buffer.readUInt32BE(6);
        if (hi || n > MAX_MESSAGE) { close(); return; }
        len = n; pos = 10;
      }
      if (!masked || len > MAX_MESSAGE) { close(); return; }
      if (buffer.length < pos + 4 + len) break;
      var mask = buffer.slice(pos, pos + 4), body = new Buffer(len), i;
      pos += 4;
      for (i = 0; i < len; i++) body[i] = buffer[pos + i] ^ mask[i & 3];
      buffer = buffer.slice(pos + len);
      if (opcode === 8) return close();
      if (opcode === 9) { socket.write(frame(10, body)); continue; }
      if (opcode === 10) continue;
      if (opcode !== 1 && opcode !== 0) { close(); return; }
      parts.push(body); size += body.length;
      if (size > MAX_MESSAGE) { close(); return; }
      if (fin) { var content = Buffer.concat(parts, size).toString('utf8'); parts = []; size = 0; processMessage(content); }
    }
  }
  socket.on('data', take);
  socket.on('error', function () { stopped = true; });
  socket.on('end', function () { stopped = true; });
  if (head && head.length) take(head);
}
module.exports = { handle: handle, allowed: allowed, frame: frame };
