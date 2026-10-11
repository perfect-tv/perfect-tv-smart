/* Хвосты на диске: старая загрузка живёт до готовности новой, пропавший канал, брошенные .tmp,
 * пустые папки, источник, на который больше не ссылается ни один плейлист, старая база .old.
 * Запуск: node tools/test-gc.js */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-gc-'));
process.env.PERFECTTV_DATA_DIR = dir;
// хвосты прежних запусков в корне
fs.writeFileSync(path.join(dir, 'map.json.123.tmp'), 'x');
fs.writeFileSync(path.join(dir, 'perfecttv.sqlite3.old'), 'x');
fs.writeFileSync(path.join(dir, 'files.v1'), '1');
var kv = require('../service/filekv.js'), pf = require('../service/progfiles.js');
var A = 'http://a/epg.xml.gz', B = 'http://b/epg.xml.gz';
function q(op, args) {
  return new Promise(function (res, rej) { kv.dispatch(op, args, function (err, r) { if (err) rej(err); else res(r); }); });
}
function fin(s, l) { return new Promise(function (res) { pf.finalizeSource(s, l, res); }); }
function pack(s, x, l) { return { key: [s, x, l, 0], value: { p: [[l * 100, l * 100 + 50, 'L' + l]] } }; }
function load(s, l, chans) {
  // как epgservice: пачки → сборка .json.gz → источник и удаление прежней загрузки
  return q('epgBatch', { groups: {
    prog: chans.map(function (x) { return pack(s, x, l); }),
    epgch: chans.map(function (x) { return { key: [s, x], value: { s: s, id: x, l: l } }; })
  } }).then(function () { return fin(s, l); }).then(function () {
    return q('epgBatch', { groups: { sources: [{ key: s, value: { url: s, loadId: l } }] }, prune: { url: s, loadId: l } });
  });
}
function files(s, x) { try { return fs.readdirSync(pf.chanDir(s, x)).sort(); } catch (e) { return null; } }
function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

q('status', {}).then(function () {
  assert.ok(!fs.existsSync(path.join(dir, 'map.json.123.tmp')), '.tmp в корне удалён');
  assert.ok(!fs.existsSync(path.join(dir, 'perfecttv.sqlite3.old')), 'старая база .old удалена');
  return q('put', { store: 'playlists', items: [
    { key: 1, value: { id: 1, epgMode: 2, userEpg: [A], headerEpg: [] } },
    { key: 2, value: { id: 2, epgMode: 0, userEpg: [], headerEpg: [B] } }
  ] });
}).then(function () {
  return q('put', { store: 'map', items: [{ key: [1, A], value: { pid: 1, s: A } }, { key: [2, B], value: { pid: 2, s: B } }, { key: [2, A], value: { pid: 2, s: A } }] });
}).then(function () {
  return q('put', { store: 'channels', items: [{ key: 1, value: { id: 1 } }, { key: 2, value: { id: 2 } }] });
}).then(function () {
  return load(A, 1, ['a', 'b']);
}).then(function () { return load(B, 1, ['z']); }).then(function () {
  assert.deepStrictEqual(files(A, 'a'), ['1.json.gz']);
  // идёт новая загрузка (пачки дописаны, ещё не собрана): старая программа на месте
  return q('epgBatch', { groups: { prog: [pack(A, 'a', 2)], epgch: [{ key: [A, 'a'], value: { s: A, id: 'a', l: 2 } }] } });
}).then(function () {
  assert.deepStrictEqual(files(A, 'a'), ['1.json.gz', '2.ndjson'], 'во время загрузки старая программа не удаляется');
  assert.deepStrictEqual(files(A, 'b'), ['1.json.gz'], 'канал b ещё со старой программой');
  // брошенный временный файл сборки
  fs.writeFileSync(path.join(pf.chanDir(A, 'a'), '2.json.gz.tmp'), 'x');
  return fin(A, 2);
}).then(function () {
  return q('epgBatch', { groups: { sources: [{ key: A, value: { url: A, loadId: 2 } }] }, prune: { url: A, loadId: 2 } });
}).then(function () {
  assert.deepStrictEqual(files(A, 'a'), ['2.json.gz'], 'после готовности новой — только она, без .tmp');
  assert.strictEqual(files(A, 'b'), null, 'папка пропавшего из XMLTV канала удалена');
  var bucket = path.dirname(pf.chanDir(A, 'b'));
  if (bucket !== path.dirname(pf.chanDir(A, 'a'))) assert.ok(!fs.existsSync(bucket), 'пустая корзина удалена');
  // плейлист 2 удалён: источник B больше не нужен
  return q('delete', { store: 'playlists', keys: [2] });
}).then(function () { return q('gc', {}); }).then(function (r) {
  assert.ok(r && typeof r.sources === 'number', 'gc отвечает');
  assert.ok(!fs.existsSync(pf.sourceDir(B)), 'программа источника B удалена');
  assert.ok(fs.existsSync(pf.sourceDir(A)), 'источник A на месте');
  return Promise.all([q('get', { store: 'sources', key: B }), q('get', { store: 'sources', key: A }),
    q('list', { store: 'epgch' }), q('list', { store: 'map' }), q('list', { store: 'channels' })]);
}).then(function (r) {
  assert.strictEqual(r[0].record, null, 'запись источника B удалена');
  assert.ok(r[1].record, 'запись источника A на месте');
  assert.deepStrictEqual(r[2].records.map(function (x) { return x.key.join(' '); }), [A + ' a'], 'epgch — только A и без пропавшего канала b');
  assert.deepStrictEqual(r[3].records.map(function (x) { return x.key.join(' '); }), ['1 ' + A], 'map — только живого плейлиста');
  assert.deepStrictEqual(r[4].records.map(function (x) { return x.key; }), [1], 'каналы удалённого плейлиста удалены');
  // плейлист сменил источник: A не нужен — уборка сама через 5 с после записи плейлиста
  return q('put', { store: 'playlists', items: [{ key: 1, value: { id: 1, epgMode: 0, userEpg: [], headerEpg: [B] } }] });
}).then(function () {
  assert.ok(fs.existsSync(pf.sourceDir(A)), 'сразу не удаляется');
  return wait(5600);
}).then(function () {
  assert.ok(!fs.existsSync(pf.sourceDir(A)), 'через 5 с источник A удалён');
  return q('status', { size: true });
}).then(function (r) {
  assert.ok(r.bytes > 0, 'размер хранилища');
  kv.flush(function () { console.log('gc ok'); process.exit(0); });
}).then(null, function (e) { console.error(e); process.exit(1); });
