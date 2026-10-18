/* Проверка filekv.js: мелкие хранилища, программа файлами, epgBatch с удалением старой загрузки,
 * удаление, сброс, перенос из самописного SQLite 1.0.7–1.0.9. Запуск: node tools/test-filekv.js */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-filekv-'));
process.env.PERFECTTV_DATA_DIR = dir;
// старая раскладка программы 1.1.0 — должна удалиться, источники — сброситься
fs.mkdirSync(path.join(dir, 'prog')); fs.writeFileSync(path.join(dir, 'prog', 'x.ndjson'), '{}\n');
fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({ '"old"': { k: 'old', v: { url: 'old' } } }));
// старая база 1.0.9: плейлист и настройка — должны перенестись
var codec = require('../service/sqlitekv.js');
// шаблон SQLite загружается при первом обращении (только чтение — файлов не создаёт)
codec.dispatch('get', { store: 'playlists', key: 0 }, function () { codec.encodeSqlite([
  { s: 'playlists', k: 1, v: { id: 1, name: 'Old', url: 'http://x/p.m3u' } },
  { s: 'prog', k: ['u', 'c', 1, 0], v: { big: 1 } }
], function (e, buf) {
  if (e) throw e;
  fs.writeFileSync(path.join(dir, 'perfecttv.sqlite3'), buf);
  codec.encodeSqlite([{ s: 'settings', k: 'prefs', v: '{"pin":"1234"}' }], function (e2, b2) {
    if (e2) throw e2;
    fs.writeFileSync(path.join(dir, 'perfecttv-settings.sqlite3'), b2);
    run();
  });
}); });
function q(op, args) {
  return new Promise(function (res, rej) {
    require('../service/filekv.js').dispatch(op, args, function (err, r) { if (err) rej(err); else res(r); });
  });
}
function run() {
  var kv = require('../service/filekv.js');
  q('get', { store: 'playlists', key: 1 }).then(function (r) {
    assert.strictEqual(r.record.value.name, 'Old', 'плейлист перенесён');
    assert.ok(!fs.existsSync(path.join(dir, 'perfecttv.sqlite3')), 'старая база удалена');
    return q('get', { store: 'settings', key: 'prefs' });
  }).then(function (r) {
    assert.strictEqual(r.record.value, '{"pin":"1234"}', 'настройки перенесены');
    assert.ok(!fs.existsSync(path.join(dir, 'prog')), 'старая раскладка программы удалена');
    return q('get', { store: 'sources', key: 'old' });
  }).then(function (r) {
    assert.strictEqual(r.record, null, 'источники сброшены — программа скачается заново');
    // источники, на которые ссылается плейлист (иначе уборка их удалит)
    return q('put', { store: 'playlists', items: [{ key: 1, value: { id: 1, name: 'Old', epgMode: 2, userEpg: ['src', 's2'], headerEpg: [] } }] });
  }).then(function () {
    // программа: две загрузки, вторая с удалением первой
    var p = function (l, n, x) { return { key: ['src', x, l, n], value: { s: 'src', x: x, l: l, n: n, data: 'L' + l + 'N' + n } }; };
    return q('epgBatch', { groups: { prog: [p(1, 0, 'a'), p(1, 0, 'b')], sources: [{ key: 'src', value: { url: 'src', loadId: 1 } }] } });
  }).then(function () {
    return q('epgBatch', { groups: { prog: [{ key: ['src', 'a', 2, 0], value: { data: 'new' } }, { key: ['src', 'a', 2, 1], value: { data: 'new1' } }] }, prune: { url: 'src', loadId: 2 } });
  }).then(function () {
    return q('list', { store: 'prog', range: { lower: ['src', 'a'], upper: ['src', 'a', []] } });
  }).then(function (r) {
    assert.deepStrictEqual(r.records.map(function (x) { return x.key[2] + ':' + x.key[3]; }), ['2:0', '2:1'], 'осталась только новая загрузка');
    return q('list', { store: 'prog', range: { lower: ['src', 'b'], upper: ['src', 'b', []] } });
  }).then(function (r) {
    assert.strictEqual(r.records.length, 0, 'у канала b старая загрузка удалена');
    return q('list', { store: 'prog', range: { lower: ['src'], upper: ['src', []] } });
  }).then(function (r) {
    assert.strictEqual(r.records.length, 2, 'чтение по источнику');
    return q('delete', { store: 'prog', keys: [['src', 'a', 2, 0]] });
  }).then(function () {
    return q('list', { store: 'prog', range: { lower: ['src', 'a'], upper: ['src', 'a', []] } });
  }).then(function (r) {
    assert.deepStrictEqual(r.records.map(function (x) { return x.key[3]; }), [1], 'удаление пачки');
    // сборка канала в один .json.gz и отдача по HTTP как есть
    var pf = require('../service/progfiles.js'), zlib = require('zlib');
    var gz = zlib.gzipSync(new Buffer(JSON.stringify([[1, 2, 'T']])));
    return q('epgBatch', { groups: { prog: [{ key: ['s2', 'c9', 5, 0], value: { codec: 'gzip-json-b64-1', data: gz.toString('base64') } }, { key: ['s2', 'c9', 5, 1], value: { p: [[3, 4, 'U'], [86400 * 2 + 5, 86400 * 2 + 9, 'W']] } }] } }).then(function () {
      var dir9 = pf.chanDir('s2', 'c9');
      assert.strictEqual(path.basename(path.dirname(dir9)).length, 2, 'корзина из двух знаков');
      return new Promise(function (res) { pf.finalizeSource('s2', 5, res); }).then(function () {
        assert.deepStrictEqual(fs.readdirSync(dir9), ['5.epg'], 'канал собран в один .epg');
        return new Promise(function (res) {
          var head = {}, body = [];
          var out = { writeHead: function (c, hh) { head = hh; head.code = c; }, write: function (b) { body.push(b); }, end: function (b) { if (b) body.push(b); res({ head: head, body: Buffer.concat(body.map(function (x) { return Buffer.isBuffer(x) ? x : new Buffer(x); })) }); }, on: function () { return out; }, once: function () { return out; }, emit: function () {}, removeListener: function () {} };
          var stream = require('stream'), w = new stream.Writable({ write: function (c, e, cb) { body.push(c); cb(); } });
          w.writeHead = out.writeHead;
          w.on('finish', function () { res({ head: head, body: Buffer.concat(body) }); });
          pf.serve('s2', 'c9', w, {}, '0', '0');
        });
      });
    }).then(function (resp) {
      assert.strictEqual(resp.head['Content-Encoding'], 'gzip', 'Content-Encoding: gzip');
      var packs = JSON.parse(zlib.gunzipSync(resp.body).toString('utf8'));
      assert.deepStrictEqual(packs.length, 1, 'одни сутки — одна пачка');
      assert.deepStrictEqual(packs[0].p.map(function (r) { return r[2]; }), ['T', 'U'], 'передачи суток 0 из обеих пачек');
      return new Promise(function (res) { pf.readEpg(path.join(pf.chanDir('s2', 'c9'), '5.epg'), 1, 3, function (e, list) { res(list); }); });
    }).then(function (list) {
      assert.deepStrictEqual(list.map(function (pk) { return pk.n + ':' + pk.p.map(function (r) { return r[2]; }).join(); }), ['2:W'], 'сутки 1…3 — только W (сутки 2)');
      return new Promise(function (res) { pf.days('s2', 'c9', res); });
    }).then(function (d) {
      assert.deepStrictEqual(d, [[0, 2], [2, 1]], 'оглавление суток канала');
      return new Promise(function (res) { pf.search([['s2', 'c9', 0, 5, 7]], ['u'], 10, function () { return false; }, res); });
    }).then(function (hits) {
      assert.deepStrictEqual(hits.map(function (x) { return x[0] + ':' + x[1].p[0][2]; }), ['7:U'], 'поиск в сервисе');
      return q('list', { store: 'prog', range: { lower: ['s2', 'c9'], upper: ['s2', 'c9', []] } });
    }).then(function (r2) {
      assert.strictEqual(r2.records.length, 2, 'чтение собранного канала по WebSocket (двое суток)');
      return q('put', { store: 'channels', items: [{ key: 7, value: { pid: 7, list: [1, 2] } }] });
    });
  }).then(function () {
    var saved = JSON.parse(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8'));
    assert.ok(saved[JSON.stringify(7)], 'каналы записаны на диск до ответа');
    return q('deleteRange', { store: 'prog', range: { lower: [''] } });
  }).then(function () {
    return q('list', { store: 'prog' });
  }).then(function (r) {
    assert.strictEqual(r.records.length, 0, 'очистка программы');
    return q('reset', {});
  }).then(function () {
    return q('get', { store: 'playlists', key: 1 });
  }).then(function (r) {
    assert.strictEqual(r.record, null, 'сброс');
    kv.flush(function () { console.log('filekv ok'); process.exit(0); });
  }).then(null, function (e) { console.error(e); process.exit(1); });
}
