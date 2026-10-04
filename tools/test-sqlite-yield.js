'use strict';
var fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), assert = require('assert');
var root = process.env.PERFECTTV_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pt-yield-'));
process.env.PERFECTTV_DATA_DIR = root;
var sql = require('../service/sqlitekv.js');
function run(op, q) { return new Promise(function (resolve, reject) {
  sql.dispatch(op, q || {}, function (err, res) { if (err) reject(err); else resolve(res); });
}); }
(async function () {
  await run('status', {});
  if (!process.argv[2]) {
    var rows = [];
    for (var i = 0; i < 6000; i++) rows.push({ s: 'prog', k: ['s', 'ch' + i, 1234, 0],
      v: { s: 's', x: 'ch' + i, data: Array(600).join(String(i % 10)) } });
    fs.writeFileSync(sql.path, sql.encodeSqlite(rows));
    var result = cp.spawnSync(process.execPath, [__filename, 'child'], {
      env: Object.assign({}, process.env, { PERFECTTV_DATA_DIR: root }), encoding: 'utf8'
    });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    console.log(result.stdout.trim());
    return;
  }
  var ticks = 0, stateBeforeMain = false, mainDone = false;
  var interval = setInterval(function () { ticks++; }, 1);
  var t0 = Date.now();
  var main = run('put', { store: 'sources', items: [{ key: 'test', value: { url: 'test' } }] })
    .then(function () { mainDone = true; });
  // SQLite settings must remain responsive while the EPG serializer yields.
  await run('get', { store: 'settings', key: 'prefs' });
  stateBeforeMain = !mainDone;
  await main;
  clearInterval(interval);
  assert(stateBeforeMain, 'settings request was blocked behind EPG rewrite');
  assert(ticks >= 15, 'database serialization blocked Node event loop: ' + ticks);
  assert.strictEqual((await run('get', { store: 'sources', key: 'test' })).record.value.url, 'test');
  var verify = cp.spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("pragma integrity_check").fetchone()[0])', sql.path], { encoding: 'utf8' });
  assert.strictEqual(verify.status, 0, verify.stderr);
  assert.strictEqual(verify.stdout.trim(), 'ok');
  console.log('SQLite yielded', ticks, 'times in', Date.now() - t0, 'ms; settings responsive, integrity ok');
})().catch(function (err) { console.error(err.stack); process.exitCode = 1; });
