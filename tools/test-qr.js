/* Проверка полного цикла QR-приложения локально: node tools/test-qr.js */
'use strict';
var http = require('http');
var assert = require('assert');
var proxy = require('../service/proxy.js');

function fetch(url, method, data) {
  return new Promise(function (resolve, reject) {
    var u = require('url').parse(url);
    var req = http.request({ hostname: u.hostname, port: u.port, path: u.path,
      method: method || 'GET', headers: data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {} }, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () { resolve({ code: res.statusCode, body: body }); });
    });
    req.on('error', reject);
    req.end(data || '');
  });
}

proxy.start(47380, function (err) {
  if (err) { console.error('Прокси не запущен:', err.message); process.exit(1); }
  fetch('http://127.0.0.1:47380/qr/new').then(function (r) {
    assert.strictEqual(r.code, 200);
    var s = JSON.parse(r.body);
    var path = 'http://127.0.0.1:47381/q/' + s.token;
    return fetch(path).then(function (html) {
      assert.strictEqual(html.code, 200);
      assert(html.body.indexOf('name="url"') >= 0);
      return fetch(path, 'POST', 'url=ftp%3A%2F%2Finvalid').then(function (bad) {
        assert.strictEqual(bad.code, 400);
        return fetch(path, 'POST', 'url=https%3A%2F%2Fexample.com%2Fplaylist.m3u%3Ftoken%3D1&name=TV').then(function (ok) {
          assert.strictEqual(ok.code, 200);
          return fetch('http://127.0.0.1:47380/qr/status?token=' + s.token).then(function (status) {
            var x = JSON.parse(status.body);
            assert.strictEqual(x.ready, true);
            assert.strictEqual(x.url, 'https://example.com/playlist.m3u?token=1');
            assert.strictEqual(x.name, 'TV');
            return fetch('http://127.0.0.1:47380/qr/cancel?token=' + s.token).then(function () {
              return fetch('http://127.0.0.1:47380/qr/status?token=' + s.token);
            }).then(function (gone) {
              assert.strictEqual(JSON.parse(gone.body).returnValue, false);
              console.log('QR service: полный цикл пройден (форма, валидация, приём, отмена)');
              process.exit(0);
            });
          });
        });
      });
    });
  }).catch(function (e) { console.error(e); process.exit(1); });
});
