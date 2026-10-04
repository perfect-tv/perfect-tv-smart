'use strict';
var fs = require('fs'), path = require('path'), os = require('os');
var cp = require('child_process'), assert = require('assert'), crypto = require('crypto');
var root = process.env.PERFECTTV_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pt-shard-'));
process.env.PERFECTTV_DATA_DIR = root;
var sql = require('../service/sqlitekv.js');
function run(op, q) { return new Promise(function (resolve, reject) {
  sql.dispatch(op, q || {}, function (err, res) { if (err) reject(err); else resolve(res); });
}); }
function hash(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function checkFile(file, expected) {
  var p = cp.spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute("pragma integrity_check").fetchone()[0]=="ok"; print(c.execute("select count(*) from kv").fetchone()[0])', file], { encoding: 'utf8' });
  assert.strictEqual(p.status, 0, p.stderr);
  if (expected !== null) assert.strictEqual(Number(p.stdout.trim()), expected);
}
function child(mode, expectedHash) {
  var p = cp.spawnSync(process.execPath, [__filename, mode, expectedHash || ''], {
    env: Object.assign({}, process.env, { PERFECTTV_DATA_DIR: root }), encoding: 'utf8'
  });
  assert.strictEqual(p.status, 0, p.stderr || p.stdout);
  return p.stdout.trim();
}
(async function () {
  if (process.argv[2]) {
    var mode = process.argv[2];
    var status = await run('status', {});
    assert.strictEqual(status.backend, 'SQLite3');
    var main = sql.path;
    assert.strictEqual(hash(main), process.argv[3]);
    if (mode === 'import') {
      var legacy = await run('get', { store: 'settings', key: 'prefs' });
      assert.strictEqual(legacy.record.value, 'legacy-value');
      assert.strictEqual((await run('get', { store: 'settings', key: 'history' })).record.value, 'old-history');
      await run('put', { store: 'settings', items: [{ key: 'prefs', value: 'new-value' }] });
      await run('delete', { store: 'settings', keys: ['history'] });
      var recent = await run('list', { store: 'settings' });
      assert.strictEqual(recent.records.length, 1);
      assert.strictEqual(recent.records[0].value, 'new-value');
      var p = await run('list', { store: 'prog', range: { lower: ['s', 'ch42'], upper: ['s', 'ch42', []] } });
      assert.strictEqual(p.records.length, 1);
      assert.strictEqual(p.records[0].key[1], 'ch42');
    } else if (mode === 'reopen') {
      assert.strictEqual((await run('get', { store: 'settings', key: 'prefs' })).record.value, 'new-value');
      assert.strictEqual((await run('get', { store: 'settings', key: 'history' })).record, null);
      await run('reset', {});
    } else if (mode === 'reset-reopen') {
      assert.strictEqual((await run('get', { store: 'settings', key: 'prefs' })).record, null);
      assert.strictEqual((await run('list', { store: 'prog' })).records.length, 0);
    }
    console.log('child', mode, 'OK');
    return;
  }
  await run('status', {});
  var rows = [
    { s: 'settings', k: 'prefs', v: 'legacy-value' },
    { s: 'settings', k: 'history', v: 'old-history' }
  ];
  for (var i = 0; i < 3000; i++) rows.push({ s: 'prog', k: ['s', 'ch' + i, 1234, 0],
    v: { s: 's', x: 'ch' + i, data: Array(500).join(String(i % 10)) } });
  fs.writeFileSync(sql.path, sql.encodeSqlite(rows));
  fs.unlinkSync(path.join(root, 'perfecttv-settings.sqlite3'));
  var before = hash(sql.path);
  console.log('legacy', fs.statSync(sql.path).size, 'bytes');
  console.log(child('import', before));
  assert.strictEqual(hash(sql.path), before, 'settings writes must NOT touch EPG db');
  checkFile(path.join(root, 'perfecttv-settings.sqlite3'), 1);
  checkFile(sql.path, rows.length);
  console.log(child('reopen', before));
  checkFile(sql.path, 0);
  checkFile(path.join(root, 'perfecttv-settings.sqlite3'), 0);
  console.log(child('reset-reopen', hash(sql.path)));
  console.log('OK settings sharding, migration, persistence, reset, EPG index');
})().catch(function (e) { console.error(e.stack || e); process.exitCode = 1; });
