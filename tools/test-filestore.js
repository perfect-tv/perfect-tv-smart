'use strict';
/* Интеграция Node 0.12-compatible файлового хранилища, без webos-service. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var http = require('http');
var crypto = require('crypto');
var root = fs.mkdtempSync(path.join(os.tmpdir(), 'perfecttv-fs-'));
process.env.PERFECTTV_DATA_DIR = path.join(root, 'private');
var file = require('../service/filestore.js');
var proxy = require('../service/proxy.js');
var port = 0;
var cases = 0;
function pass(label, condition) { assert(condition, label); cases++; console.log('PASS', label); }
function request(method, route, body, origin) {
  return new Promise(function (resolve, reject) {
    var data = body === undefined ? '' : JSON.stringify(body);
    var headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
    if (origin) headers.Origin = origin;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    var req = http.request({ host: '127.0.0.1', port: port, method: method, path: route, headers: headers }, function (res) {
      var parts = [];
      res.on('data', function (c) { parts.push(c); });
      res.on('end', function () {
        var response;
        try { response = JSON.parse(Buffer.concat(parts).toString('utf8')); }
        catch (e) { reject(e); return; }
        resolve({ status: res.statusCode, headers: res.headers, body: response });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
function post(cmd, payload) { return request('POST', '/_db/' + cmd, payload, 'null').then(function (r) {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert(r.body.ok, JSON.stringify(r.body));
  return r.body;
}); }
function get(store, key) { return request('GET', '/_db/get?store=' + store + '&key=' + encodeURIComponent(JSON.stringify(key)), undefined, 'null').then(function (r) { return r.body; }); }
var ch1 = { pid: 1, codec: 'gzip-json-1', data: crypto.randomBytes(52000).toString('base64'), __ptBinary: 1 };
var epg = { s: 'https://epg.example.test/a.xml.gz', x: 'Первый HD', l: 11, n: 0, codec: 'gzip-json-1', data: 'AOJJ', __ptBinary: 1 };
var key = [epg.s, epg.x, epg.l, epg.n];
var key2 = [epg.s, 'Россия 24', 11, 0];
function main() {
  return request('GET', '/_db/status', undefined, 'null').then(function (r) {
    pass('новый сервис без старых записей', r.status === 200 && !r.body.active);
    return post('put', { store: 'channels', items: [{ key: 1, value: ch1 }] });
  }).then(function () {
    return request('GET', '/_db/status', undefined, 'null');
  }).then(function (r) {
    pass('после первой записи активирован файловый режим', r.body.active);
    return get('channels', 1);
  }).then(function (r) {
    pass('большая сжатая запись плейлиста хранится целиком', r.record && r.record.value.data === ch1.data);
    return post('put', { store: 'playlists', items: [{ key: 1, value: { id: 1, name: 'Новости HD', url: 'https://iptv.example/playlist.m3u8' } }] });
  }).then(function () { return post('put', { store: 'prog', items: [{ key: key, value: epg }, { key: key2, value: { s: epg.s, x: key2[1], l: 11, n: 0, p: [[100, 200, 'Новости']] } }] }); })
    .then(function () { return post('list', { store: 'prog', range: { lower: [epg.s, epg.x], upper: [epg.s, epg.x, []] } }); })
    .then(function (r) {
      pass('читается только выбранный EPG-канал', r.records.length === 1 && r.records[0].value.x === epg.x);
      return post('put', { store: 'prog', items: [{ key: [epg.s, epg.x, 12, 0], value: { s: epg.s, x: epg.x, l: 12, n: 0, p: [[200, 300, 'Кино']] } }] });
    }).then(function () { return post('list', { store: 'prog', range: { lower: [epg.s], upper: [epg.s, []] } }); })
    .then(function (r) {
      pass('по источнику EPG доступны все каналы', r.records.length === 3);
      return post('deleteRange', { store: 'prog', range: { lower: [epg.s, epg.x], upper: [epg.s, epg.x, []] } });
    }).then(function () { return post('list', { store: 'prog', range: { lower: [epg.s], upper: [epg.s, []] } }); })
    .then(function (r) {
      pass('удаление по префиксу удаляет только свой канал', r.records.length === 1 && r.records[0].value.x === key2[1]);
      return post('deleteRange', { store: 'prog', range: { lower: [''] } });
    }).then(function () { return post('list', { store: 'prog' }); })
    .then(function (r) {
      pass('полная очистка EPG действительно освобождает файловое хранилище', r.records.length === 0);
      return get('channels', 1);
    }).then(function (r) {
      pass('очистка EPG не затрагивает каналы', r.record && r.record.value.data === ch1.data);
      return request('POST', '/_db/put', { store: 'other', items: [] }, 'null');
    }).then(function (r) {
      pass('доступ к произвольным папкам запрещён', r.status === 400);
      return request('POST', '/_db/put', { store: 'channels', items: [{ key: 2, value: { pid: 2 } }] }, 'https://untrusted.example');
    }).then(function (r) {
      pass('запись с чужого HTTP-источника запрещена', r.status === 403);
      return post('delete', { store: 'channels', keys: [1] });
    }).then(function () { return get('channels', 1); })
    .then(function (r) {
      pass('удаление одного плейлиста работает', r.record === null);
      return get('playlists', 1);
    }).then(function (r) {
      pass('плейлисты хранятся отдельно от каналов', r.record && r.record.value.name === 'Новости HD');
      // Чтение напрямую с диска имитирует перезапуск сервиса.
      var filePath = path.join(process.env.PERFECTTV_DATA_DIR, 'playlists', crypto.createHash('sha1').update('1').digest('hex') + '.json');
      pass('файл переживает перезапуск Node-сервиса', JSON.parse(fs.readFileSync(filePath, 'utf8')).value.name === 'Новости HD');
      return post('reset', {});
    }).then(function () { return request('GET', '/_db/status', undefined, 'null'); })
    .then(function (r) {
      pass('общий сброс удаляет файловые данные и маркер', !r.body.active);
      console.log('Файловое хранилище: ' + cases + ' проверок успешно');
    });
}
var server = http.createServer(file.handle);
server.listen(0, '127.0.0.1', function () {
  port = server.address().port;
  main().then(function () { server.close(); }, function (e) { console.error(e.stack || e); process.exitCode = 1; server.close(); });
});
