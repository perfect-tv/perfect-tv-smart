/* Прошедшая программа прежней загрузки, которой нет в новой, остаётся в окне архива (и не старше
 * его); у канала, пропавшего из XMLTV, — только прошедшее. Запуск: node tools/test-keep.js */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.PERFECTTV_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-keep-'));
var pf = require('../service/progfiles.js');
var S = 'http://e/epg.xml', H = 3600, now = Math.floor(Date.now() / 1000), D = 86400;
function line(x, l, n, p) { return JSON.stringify({ k: [S, x, l, n], v: { p: p } }) + '\n'; }
function put(x, l, p) { var d = pf.chanDir(S, x); pf.mkdirp(d, function () {}); }
function write(x, l, p, cb) { var d = pf.chanDir(S, x); pf.mkdirp(d, function () { fs.appendFileSync(path.join(d, l + '.ndjson'), line(x, l, 0, p)); cb(); }); }
function fin(l, keep) { return new Promise(function (res) { pf.finalizeSource(S, l, keep, res); }); }
function prune(l) { return new Promise(function (res) { pf.pruneSource(S, l, res); }); }
function all(x) { return new Promise(function (res) { pf.readEpg(path.join(pf.chanDir(S, x), fs.readdirSync(pf.chanDir(S, x)).filter(function (n) { return /\.epg$/.test(n); })[0]), undefined, undefined, function (e, packs) {
  var out = []; packs.forEach(function (pk) { out = out.concat(pk.p.map(function (r) { return r[2]; })); }); res(out);
}); }); }
var t0 = now - 10 * D;   // старше окна архива
// загрузка 1: a — 10 суток назад, 3 суток назад, вчера, сейчас, завтра; b — 3 суток назад и завтра
new Promise(function (res) {
  write('a', 1, [[t0, t0 + H, 'old10'], [now - 3 * D, now - 3 * D + H, 'past3'], [now - D, now - D + H, 'past1'], [now - 60, now + H, 'now1'], [now + D, now + D + H, 'tom1']], function () {
    write('b', 1, [[now - 3 * D, now - 3 * D + H, 'b-past3'], [now + D, now + D + H, 'b-tom']], res);
  });
}).then(function () { return fin(1, null); }).then(function () { return prune(1); }).then(function () {
  // загрузка 2: у a — с текущей передачи (прошлого нет), b пропал из XMLTV
  return new Promise(function (res) { write('a', 2, [[now - 60, now + H, 'now2'], [now + D, now + D + H, 'tom2']], res); });
}).then(function () { return fin(2, now - 8 * D); }).then(function () { return prune(2); }).then(function () {
  return all('a');
}).then(function (a) {
  assert.deepStrictEqual(a, ['past3', 'past1', 'now2', 'tom2'], 'a: прошедшее из прежней загрузки (без старше архива) + новая');
  return all('b');
}).then(function (b) {
  assert.deepStrictEqual(b, ['b-past3'], 'b пропал: осталось только прошедшее');
  return fin(3, null).then(function () { return prune(3); });
}).then(function () {
  assert.ok(!fs.existsSync(pf.chanDir(S, 'b')), 'без переноса (keepFrom не задан) — b удалён');
  // передача через полночь — и в следующих сутках (первой): интерфейсу хватает одних суток
  var D0 = 20000 * D, buf = pf.encodeEpg('s', 'x', 1, [{ p: [[D0 - 600, D0 + 600, 'night'], [D0 + 600, D0 + 1200, 'day']] }]);
  var f = path.join(process.env.PERFECTTV_DATA_DIR, 'span.epg'); fs.writeFileSync(f, buf);
  return new Promise(function (res) { pf.readEpg(f, 20000, 20000, function (e, packs) { res(packs); }); });
}).then(function (packs) {
  assert.deepStrictEqual(packs[0].p.map(function (r) { return r[2]; }), ['night', 'day'], 'передача через полночь — в начале следующих суток');
  console.log('keep ok');
}).then(null, function (e) { console.error(e); process.exit(1); });
