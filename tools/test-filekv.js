/* Проверка filekv.js: мелкие хранилища, программа файлами, epgBatch с удалением старой загрузки,
 * удаление, сброс, перенос из самописного SQLite 1.0.7–1.0.9. Запуск: node tools/test-filekv.js */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-filekv-'));
process.env.PERFECTTV_DATA_DIR = dir;
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
    return q('put', { store: 'channels', items: [{ key: 7, value: { pid: 7, list: [1, 2] } }] });
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
