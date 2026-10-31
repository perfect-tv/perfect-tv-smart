/*
 * Проверка сервиса на настоящем Node 0.12 (как на webOS 3–5): загрузка XMLTV через дочерний
 * процесс, /prog за сутки и за неделю, оглавление суток, поиск, уборка. ES5.
 *   путь/к/node-v0.12.18-linux-x64/bin/node tools/node012-check.js файл.xml.gz tvg-id [tvg-id…]
 * Node 0.12 — https://nodejs.org/dist/v0.12.18/ (сверить SHASUMS256.txt).
 */
'use strict';
var fs = require('fs'), http = require('http'), path = require('path'), os = require('os'), zlib = require('zlib');
var file = process.argv[2], ids = process.argv.slice(3);
if (!file || !ids.length) { console.log('usage: node tools/node012-check.js file.xml.gz tvg-id [tvg-id…]'); process.exit(2); }
var dir = path.join(os.tmpdir(), 'pt-node012-' + process.pid);
fs.mkdirSync(dir);
process.env.PERFECTTV_DATA_DIR = dir;
var root = path.join(__dirname, '..');
var epg = require(path.join(root, 'service/epgrunner.js'));
var kv = require(path.join(root, 'service/filekv.js'));
var proxy = require(path.join(root, 'service/proxy.js'));
function fail(msg) { console.log('FAIL', msg); process.exit(1); }
var files = http.createServer(function (req, res) { fs.createReadStream(file).pipe(res); });
files.listen(0, '127.0.0.1', function () {
  var url = 'http://127.0.0.1:' + files.address().port + '/e.xml.gz', t0 = Date.now();
  var chans = ids.map(function (id, i) { return { key: 'k' + i, tvgId: id, tvgName: '', name: id }; });
  kv.dispatch('put', { store: 'playlists', items: [{ key: 1, value: { id: 1, epgMode: 2, userEpg: [url], headerEpg: [] } }] }, function () {
    epg.dispatch('epgStart', { url: url, wanted: [{ pid: 1, channels: chans }], maxArchiveDays: 7, langs: ['ru'], force: true }, function (err, st) {
      if (err) fail('start ' + err);
      (function poll() {
        epg.dispatch('epgStatus', { jobId: st.jobId }, function (e, s) {
          if (!s || !s.done) return setTimeout(poll, 500);
          if (s.error || !s.meta || !s.meta.count) fail('load ' + (s.error || 'no programmes'));
          console.log('load ok', s.meta.count, 'programmes', (Date.now() - t0) / 1000, 's');
          proxy.start(47392, function (pe) { if (pe) fail('proxy ' + pe); requests(url); });
        });
      })();
    });
  });
});
function get(p, cb) {
  http.get({ host: '127.0.0.1', port: 47392, path: p }, function (res) {
    var b = []; res.on('data', function (c) { b.push(c); });
    res.on('end', function () { var buf = Buffer.concat(b); cb(res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(buf) : buf); });
  });
}
function requests(url) {
  kv.dispatch('get', { store: 'map', key: [1, url] }, function (e, r) {
    var m = r && r.record && r.record.value.m, k = m && Object.keys(m)[0];
    if (!k) fail('no mapping');
    var x = m[k][0], today = Math.floor(Date.now() / 86400000);
    var q = '/prog?s=' + encodeURIComponent(url) + '&x=' + encodeURIComponent(x);
    get(q + '&a=' + today + '&b=' + today, function (b1) {
      var one = JSON.parse(b1.toString());
      get(q + '&a=' + (today - 3) + '&b=' + (today + 3), function (b2) {
        var week = JSON.parse(b2.toString());
        get(q + '&days=1', function (b3) {
          var days = JSON.parse(b3.toString());
          if (!days.length) fail('days');
          var req = http.request({ host: '127.0.0.1', port: 47392, path: '/progsearch', method: 'POST', headers: { 'Content-Type': 'text/plain' } }, function (res) {
            var b = ''; res.on('data', function (c) { b += c; });
            res.on('end', function () {
              var hits = JSON.parse(b);
              kv.dispatch('gc', {}, function (ge, gr) {
                if (ge) fail('gc ' + ge);
                console.log('OK today', one.length ? one[0].p.length : 0, '| week packs', week.length, '| days', days.length, '| search', hits.length, '| gc', JSON.stringify(gr));
                process.exit(0);
              });
            });
          });
          req.end(JSON.stringify({ w: ['а'], c: [[url, x, today - 8, today + 8, 0]], max: 50 }));
        });
      });
    });
  });
}
