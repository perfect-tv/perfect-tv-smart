'use strict';
// Интеграционная проверка сервиса при запрете localhost:47380.
// Не используется пакет webos-service с ПК: подменяем только Luna-обёртку.
var assert = require('assert');
var http = require('http');
var zlib = require('zlib');
var Module = require('module');
var stream = require('../service/luna-stream.js');
var proxy = require('../service/proxy.js');
var content = new Buffer(350000);
for (var i = 0; i < content.length; i++) content[i] = i % 251;
var handlers = {};
var origLoad = Module._load;
Module._load = function (id, parent, isMain) {
  if (id === 'webos-service') return function Service(id) {
    assert.strictEqual(id, 'top.rootu.perfecttv.service');
    this.register = function (name, fn) { handlers[name] = fn; };
    this.activityManager = { create: function (name, cb) { cb({ name: name }); },
      complete: function (act, cb) { if (cb) cb(act); } };
  };
  return origLoad.apply(this, arguments);
};
require('../service/service.js');
Module._load = origLoad;

function call(method, payload, extra) {
  return new Promise(function (resolve, reject) {
    var msg = { payload: payload || {}, isSubscription: !!extra,
      uniqueToken: extra || 'test', respond: resolve };
    try { handlers[method](msg); } catch (e) { reject(e); }
  });
}
function check(name, condition) { assert(condition, name); console.log('PASS', name); }

var server = http.createServer(function (req, res) {
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/file' }); res.end(); return; }
  if (req.url === '/missing') { res.writeHead(404); res.end('missing'); return; }
  if (req.url === '/etag' && req.headers['if-none-match'] === '"test"') {
    res.writeHead(304); res.end(); return;
  }
  if (req.url === '/gzip') {
    var gz = zlib.gzipSync(content);
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'application/octet-stream' });
    res.end(gz); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', ETag: '"test"' });
  res.end(content);
});

server.listen(0, '127.0.0.1', function () {
  var base = 'http://127.0.0.1:' + server.address().port;
  var originalStart = proxy.start;
  // Имитируем EACCES при открытии HTTP-порта на телевизоре.
  proxy.start = function (port, cb) { cb(new Error('EACCES TCP listen blocked')); };

  Promise.resolve().then(function () {
    return call('start', { subscribe: true }, 'subscription-1');
  }).then(function (res) {
    check('Luna-service работает без TCP listener', res.returnValue && res.subscribed && !res.proxyReady && /EACCES/.test(res.proxyError));
    return call('ping');
  }).then(function (res) {
    check('ping доступен через Luna', res.returnValue && !res.proxyReady);
    return call('streamOpen', { url: base + '/redirect' });
  }).then(function (open) {
    check('redirect и заголовки', open.returnValue && open.status === 200 && open.url === base + '/file' && open.headers.etag === '"test"');
    var bufs = [], chunks = 0;
    function read() {
      return call('streamRead', { id: open.id }).then(function (part) {
        assert(part.returnValue);
        assert(part.bytes <= 32 * 1024);
        bufs.push(new Buffer(part.data, 'base64'));
        chunks++;
        return part.end ? null : read();
      });
    }
    return read().then(function () {
      check('большие данные передаются целиком порциями', chunks > 4 && Buffer.concat(bufs).equals(content));
    });
  }).then(function () {
    return call('streamOpen', { url: base + '/gzip' });
  }).then(function (open) {
    assert(open.returnValue);
    var bufs = [];
    function read() {
      return call('streamRead', { id: open.id }).then(function (part) {
        assert(part.returnValue);
        bufs.push(new Buffer(part.data, 'base64'));
        return part.end ? null : read();
      });
    }
    return read().then(function () {
      check('gzip распаковывается при Luna-передаче', Buffer.concat(bufs).equals(content));
    });
  }).then(function () {
    return call('streamOpen', { url: base + '/etag', etag: '"test"' });
  }).then(function (open) {
    check('HTTP 304 сохраняется', open.returnValue && open.status === 304);
    return call('streamClose', { id: open.id });
  }).then(function () {
    return call('streamOpen', { url: base + '/missing' });
  }).then(function (open) {
    check('ошибки HTTP не скрываются', open.returnValue && open.status === 404);
    return call('streamClose', { id: open.id });
  }).then(function () {
    var startedOnMeta = false;
    proxy.start = function (port, cb) { startedOnMeta = true; cb(null); };
    return call('codeMeta').then(function (meta) {
      check('codeMeta сразу поднимает HTTP-прокси для загрузчика', meta.returnValue && startedOnMeta);
    });
  }).then(function () {
    check('методы сервиса зарегистрированы', ['start', 'ping', 'streamOpen', 'streamRead', 'streamClose'].every(function (name) { return typeof handlers[name] === 'function'; }));
    console.log('Luna integration tests passed');
  }).then(function () {
    proxy.start = originalStart;
    server.close();
  }, function (err) {
    proxy.start = originalStart;
    server.close();
    console.error(err && err.stack || err);
    process.exitCode = 1;
  });
});
