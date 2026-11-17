/*
 * Код приложения, скачанный с сайта (docs/TZ.md, «Обновление без переустановки»): файлы в папке
 * данных сервиса (<datadir>/code/current), а не в браузерном хранилище — у webOS оно переполняется
 * (QuotaExceededError, PLAN.md 1.0.5–1.0.7). Загрузчик приложения (src/platform/webos/loader.ts)
 * читает код по Luna кусками; скачивает сервис сам (адрес и sha256 файлов присылает приложение —
 * version.json оно берёт запросом браузера с проверкой сертификата), файлы сверяются по sha256.
 * Метка «запускается версия X» и список сбойных версий — тоже здесь (state.json).
 * Код — ES5 (Node 0.12).
 */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var proxy = require('./proxy.js');
var ROOT = require('./datadir.js');

var DIR = path.join(ROOT, 'code');
var CUR = path.join(DIR, 'current');
var NEW = path.join(DIR, 'staging');
var OLD = path.join(DIR, 'old');
var STATE = path.join(DIR, 'state.json');
var CHUNK = 131072;   // символов за один ответ Luna
var NAME = /^[a-z0-9][a-z0-9.\-]*\.js$/;

function mkdir(d) { try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
function rmrf(d) {
  var list;
  try { list = fs.readdirSync(d); } catch (e) { return; }
  for (var i = 0; i < list.length; i++) {
    var p = path.join(d, list[i]);
    try { if (fs.statSync(p).isDirectory()) rmrf(p); else fs.unlinkSync(p); } catch (e) { /* */ }
  }
  try { fs.rmdirSync(d); } catch (e) { /* */ }
}
function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }

function state() {
  var s = readJson(STATE, null) || {};
  return { boot: typeof s.boot === 'string' ? s.boot : '', bad: s.bad instanceof Array ? s.bad : [] };
}
function saveState(s) {
  mkdir(DIR);
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(s));
  fs.renameSync(STATE + '.tmp', STATE);
}

/** Сведения о скачанном коде (null — нет), метка запуска и сбойные версии */
function meta(q, cb) {
  var m = readJson(path.join(CUR, 'meta.json'), null);
  var s = state();
  cb(null, { meta: m, boot: s.boot, bad: s.bad });
}

var cache = { name: '', version: '', text: '' };

/** Кусок файла: { name, offset } → { text, size, done } (offset и size — в символах) */
function read(q, cb) {
  var name = String(q.name || '');
  if (!NAME.test(name)) return cb(new Error('bad name'));
  var m = readJson(path.join(CUR, 'meta.json'), null);
  if (!m || !m.files || !m.files[name]) return cb(new Error('no file'));
  if (cache.name !== name || cache.version !== m.version) {
    try { cache = { name: name, version: m.version, text: fs.readFileSync(path.join(CUR, name), 'utf8') }; }
    catch (e) { return cb(e); }
  }
  var off = Math.max(0, q.offset | 0);
  var text = cache.text.substring(off, off + CHUNK);
  var done = off + text.length >= cache.text.length;
  if (done) cache = { name: '', version: '', text: '' };
  cb(null, { version: m.version, text: text, size: done ? off + text.length : -1, done: done });
}

/** Метка запуска (boot: версия или '') и сбойная версия (bad) */
function setState(q, cb) {
  try {
    var s = state();
    if (typeof q.boot === 'string') s.boot = q.boot;
    if (q.bad && s.bad.indexOf(String(q.bad)) < 0) { s.bad.push(String(q.bad)); s.bad = s.bad.slice(-10); }
    saveState(s);
    cb(null, s);
  } catch (e) { cb(e); }
}

function download(url, sha, cb) {
  proxy.request(url, { 'Cache-Control': 'no-cache' }, function (err, res) {
    if (err) return cb(err);
    if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode + ' ' + url)); }
    var parts = [];
    var body = proxy.bodyOf(res);
    body.on('data', function (b) { parts.push(b); });
    body.on('error', function (e) { cb(e); });
    body.on('end', function () {
      var buf = Buffer.concat(parts);
      var h = crypto.createHash('sha256').update(buf).digest('hex');
      if (h !== sha) return cb(new Error('sha256 mismatch ' + url));
      cb(null, buf);
    });
  });
}

var fetching = false;

/**
 * Скачать версию: { base, version, shell, service, files: { name: { sha256 } } }. Файлы — в staging,
 * все сошлись по sha256 — staging становится current (прежний — удаляется).
 */
function fetchCode(q, cb) {
  if (fetching) return cb(new Error('busy'));
  var base = String(q.base || '');
  if (!/^https?:\/\//.test(base)) return cb(new Error('bad base'));
  var names = Object.keys(q.files || {});
  for (var i = 0; i < names.length; i++) if (!NAME.test(names[i]) || !/^[0-9a-f]{64}$/.test(String(q.files[names[i]].sha256))) return cb(new Error('bad manifest'));
  if (!names.length || !q.version) return cb(new Error('bad manifest'));
  fetching = true;
  var finish = function (err) { fetching = false; if (err) rmrf(NEW); cb(err || null, err ? null : { version: q.version }); };
  try { mkdir(DIR); rmrf(NEW); mkdir(NEW); } catch (e) { return finish(e); }
  var k = 0;
  (function next() {
    if (k >= names.length) {
      try {
        var files = {};
        for (var j = 0; j < names.length; j++) files[names[j]] = q.files[names[j]].sha256;
        fs.writeFileSync(path.join(NEW, 'meta.json'), JSON.stringify({ version: String(q.version), shell: q.shell | 0, service: q.service | 0, files: files, saved: Date.now() }));
        rmrf(OLD);
        try { fs.renameSync(CUR, OLD); } catch (e) { /* первой версии нет */ }
        fs.renameSync(NEW, CUR);
        rmrf(OLD);
      } catch (e) { return finish(e); }
      console.log('code: saved', q.version);
      return finish(null);
    }
    var name = names[k++];
    download(base.replace(/\/?$/, '/') + name + '?v=' + encodeURIComponent(q.version), q.files[name].sha256, function (err, buf) {
      if (err) return finish(err);
      try { fs.writeFileSync(path.join(NEW, name), buf); } catch (e) { return finish(e); }
      next();
    });
  })();
}

/** Забыть скачанный код (запуск — встроенным) */
function clear(q, cb) { rmrf(CUR); cb(null, {}); }

function dispatch(op, q, cb) {
  try {
    if (op === 'codeMeta') return meta(q, cb);
    if (op === 'codeRead') return read(q, cb);
    if (op === 'codeState') return setState(q, cb);
    if (op === 'codeFetch') return fetchCode(q, cb);
    if (op === 'codeClear') return clear(q, cb);
  } catch (e) { return cb(e); }
  cb(new Error('unknown op ' + op));
}

module.exports = { dispatch: dispatch, OPS: ['codeMeta', 'codeRead', 'codeState', 'codeFetch', 'codeClear'] };
