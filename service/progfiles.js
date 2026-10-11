/*
 * Файлы программы (общий модуль хранилища filekv.js, дочернего процесса разбора и HTTP /prog).
 *
 * Раскладка: prog2/<h(источник)>/<первые 2 знака h(канал)>/<h(канал)>/<загрузка>.<ndjson|json.gz>
 *   — до 256 корзин на источник, в каждой — десятки каналов (а не тысячи папок в одной).
 * Пока загрузка идёт, пачки канала дописываются строками в <загрузка>.ndjson
 * ({"k":[s,x,l,n],"v":{…, codec:'gzip-json-b64-1', data}}). В конце загрузки канал собирается
 * в один gzip-поток <загрузка>.json.gz — JSON-массив пачек [{s,x,l,n,p:[[start,stop,…],…]}]:
 * его HTTP /prog отдаёт как есть с Content-Encoding: gzip, и браузер ТВ распаковывает его сам,
 * нативно (без fflate в основном потоке и без base64).
 * Код — ES5 (Node 0.12).
 */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');

var ROOT = process.env.PERFECTTV_DATA_DIR || '/media/internal/perfecttv-data';
var PROG = path.join(ROOT, 'prog2');
var BufferFrom = function (s, enc) { return new Buffer(s, enc); };

function h(s) { return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 20); }
function sourceDir(s) { return path.join(PROG, h(s)); }
function chanDir(s, x) { var hx = h(x); return path.join(PROG, h(s), hx.slice(0, 2), hx); }
function loadOf(name) { return name.split('.')[0]; }

function mkdirp(dir, cb) {
  fs.mkdir(dir, function (e) {
    if (!e || e.code === 'EEXIST') return cb(null);
    if (e.code !== 'ENOENT') return cb(e);
    mkdirp(path.dirname(dir), function (pe) { if (pe) return cb(pe); fs.mkdir(dir, function (e2) { cb(!e2 || e2.code === 'EEXIST' ? null : e2); }); });
  });
}

function rmrf(p, cb) {
  fs.lstat(p, function (e, st) {
    if (e) return cb(e.code === 'ENOENT' ? null : e);
    if (!st.isDirectory()) return fs.unlink(p, function (ue) { cb(ue && ue.code !== 'ENOENT' ? ue : null); });
    fs.readdir(p, function (re, names) {
      if (re) return cb(re);
      var i = 0;
      (function next(err) {
        if (err) return cb(err);
        if (i >= names.length) return fs.rmdir(p, function (de) { cb(de && de.code !== 'ENOENT' ? de : null); });
        rmrf(path.join(p, names[i++]), next);
      })();
    });
  });
}

/** Папки каналов источника (sourceHash) или всех источников (null) */
function channelDirs(sourceHash, cb) {
  var out = [];
  function readdir(dir, done) { fs.readdir(dir, function (e, names) { done(e ? [] : names); }); }
  function scanSource(sh, done) {
    var sd = path.join(PROG, sh);
    readdir(sd, function (buckets) {
      var i = 0;
      (function next() {
        if (i >= buckets.length) return done();
        var b = path.join(sd, buckets[i++]);
        readdir(b, function (chans) {
          for (var j = 0; j < chans.length; j++) out.push(path.join(b, chans[j]));
          next();
        });
      })();
    });
  }
  if (sourceHash) return scanSource(sourceHash, function () { cb(out); });
  readdir(PROG, function (srcs) {
    var i = 0;
    (function next() { if (i >= srcs.length) return cb(out); scanSource(srcs[i++], next); })();
  });
}

/** Пачка из строки ndjson → {s,x,l,n,p} с распакованным массивом передач */
function plainPack(k, v) {
  var p = v && v.p;
  if (!p && v && v.codec === 'gzip-json-b64-1' && typeof v.data === 'string') {
    p = JSON.parse(zlib.gunzipSync(BufferFrom(v.data, 'base64')).toString('utf8'));
  }
  return { s: k[0], x: k[1], l: k[2], n: k[3], p: p || [] };
}

/** Все пачки папки канала: [{key, value}] — value из ndjson как есть, из json.gz — {s,x,l,n,p} */
function readDir(dir, cb) {
  fs.readdir(dir, function (err, names) {
    if (err) return cb(err.code === 'ENOENT' ? null : err, []);
    var out = [], i = 0;
    (function next() {
      if (i >= names.length) return cb(null, out);
      var name = names[i++], file = path.join(dir, name);
      if (/\.ndjson$/.test(name)) {
        fs.readFile(file, 'utf8', function (re, text) {
          if (!re) {
            var lines = text.split('\n');
            for (var j = 0; j < lines.length; j++) {
              if (!lines[j]) continue;
              // недописанная последняя строка (запись идёт прямо сейчас) — пропускаем
              try { var r = JSON.parse(lines[j]); out.push({ key: r.k, value: r.v }); } catch (e) { /* */ }
            }
          }
          next();
        });
      } else if (/\.json\.gz$/.test(name)) {
        fs.readFile(file, function (re, buf) {
          if (!re) {
            try {
              var packs = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
              for (var j = 0; j < packs.length; j++) out.push({ key: [packs[j].s, packs[j].x, packs[j].l, packs[j].n], value: packs[j] });
            } catch (e) { /* битый файл — как будто нет */ }
          }
          next();
        });
      } else next();
    })();
  });
}

function readChannel(s, x, cb) { readDir(chanDir(s, x), cb); }

/** Дописать пачки: по файлу канала-загрузки, последовательно */
function appendPacks(rows, cb) {
  var groups = {}, order = [];
  for (var i = 0; i < rows.length; i++) {
    var k = rows[i].key;
    if (!Array.isArray(k) || k.length < 4) { var e = new Error('invalid prog key'); e.code = 'EINVAL'; return cb(e); }
    var file = path.join(chanDir(k[0], k[1]), String(k[2]) + '.ndjson');
    if (!groups[file]) { groups[file] = ''; order.push(file); }
    groups[file] += JSON.stringify({ k: k, v: rows[i].value }) + '\n';
  }
  var j = 0;
  (function next(err) {
    if (err) return cb(err);
    if (j >= order.length) return cb(null);
    var f = order[j++];
    mkdirp(path.dirname(f), function (me) {
      if (me) return next(me);
      fs.appendFile(f, groups[f], next);
    });
  })();
}

/** Убрать папку канала и её корзину, если опустели (непустую rmdir не тронет) */
function rmdirEmpty(dir, cb) {
  fs.rmdir(dir, function (e) {
    if (e) return cb();
    fs.rmdir(path.dirname(dir), function () { cb(); });
  });
}

/**
 * Удалить у источника s файлы всех загрузок, кроме keepLoad, и брошенные .tmp (сервис убили
 * посреди сборки); опустевшие папки каналов и корзины — тоже. Канал, пропавший из XMLTV или из
 * плейлиста, уходит здесь же: его файлы — от прежней загрузки.
 */
function pruneSource(s, keepLoad, cb) {
  var keep = String(keepLoad);
  channelDirs(h(s), function (dirs) {
    var i = 0;
    (function next() {
      if (i >= dirs.length) return cb(null);
      var dir = dirs[i++];
      fs.readdir(dir, function (e, names) {
        if (e) return next();
        var j = 0;
        (function del() {
          if (j >= names.length) return rmdirEmpty(dir, next);
          var n = names[j++];
          if (loadOf(n) === keep && !/\.tmp$/.test(n)) return del();
          fs.unlink(path.join(dir, n), function () { del(); });
        })();
      });
    })();
  });
}

/** Папки источников в prog2 (хэши) */
function sourceHashes(cb) { fs.readdir(PROG, function (e, names) { cb(e ? [] : names); }); }

/** Размер папки (байт), для «Хранилище» в настройках */
function du(p, cb) {
  fs.lstat(p, function (e, st) {
    if (e) return cb(0);
    if (!st.isDirectory()) return cb(st.size);
    fs.readdir(p, function (re, names) {
      if (re) return cb(0);
      var total = 0, i = 0;
      (function next() {
        if (i >= names.length) return cb(total);
        du(path.join(p, names[i++]), function (n) { total += n; next(); });
      })();
    });
  });
}

/**
 * Конец загрузки: каждый канал источника — из строк <load>.ndjson в один <load>.json.gz.
 * По каналу за раз с уступкой циклу событий (в процессе сервиса прокси не простаивает).
 */
function finalizeSource(s, loadId, cb) {
  var name = String(loadId) + '.ndjson';
  channelDirs(h(s), function (dirs) {
    var i = 0, done = 0;
    (function next() {
      if (i >= dirs.length) { console.log('EPG packed', done, 'channels to .json.gz'); return cb(null); }
      var dir = dirs[i++], src = path.join(dir, name);
      fs.readFile(src, 'utf8', function (re, text) {
        if (re) return setImmediate(next);
        var packs = [], lines = text.split('\n');
        try {
          for (var j = 0; j < lines.length; j++) {
            if (!lines[j]) continue;
            var r = JSON.parse(lines[j]);
            packs.push(plainPack(r.k, r.v));
          }
        } catch (e) { return setImmediate(next); }
        packs.sort(function (a, b) { return a.n - b.n; });
        var gz;
        try { gz = zlib.gzipSync(BufferFrom(JSON.stringify(packs), 'utf8'), { level: 6 }); } catch (ze) { return setImmediate(next); }
        var dst = path.join(dir, String(loadId) + '.json.gz'), tmp = dst + '.tmp';
        fs.writeFile(tmp, gz, function (we) {
          if (we) return setImmediate(next);
          fs.rename(tmp, dst, function (rne) {
            if (rne) return fs.unlink(tmp, function () { setImmediate(next); });
            done++;
            fs.unlink(src, function () { setImmediate(next); });
          });
        });
      });
    })();
  });
}

/**
 * HTTP /prog?s=&x=: программа канала — JSON-массив пачек [{s,x,l,n,p}]. Канал собран в один
 * .json.gz — файл как есть с Content-Encoding: gzip (распакует браузер); иначе (загрузка ещё
 * идёт, или есть файлы двух загрузок) — собрать здесь и отдать обычным JSON.
 */
function serve(s, x, out, headers) {
  if (typeof s !== 'string' || typeof x !== 'string') {
    out.writeHead(400, headers); return out.end('[]');
  }
  var dir = chanDir(s, x);
  fs.readdir(dir, function (err, names) {
    names = (names || []).filter(function (n) { return /\.(ndjson|json\.gz)$/.test(n); });
    if (err || !names.length) {
      headers['Content-Type'] = 'application/json';
      out.writeHead(200, headers);
      return out.end('[]');
    }
    if (names.length === 1 && /\.json\.gz$/.test(names[0])) {
      var file = path.join(dir, names[0]);
      return fs.stat(file, function (se, st) {
        if (se) { out.writeHead(500, headers); return out.end('[]'); }
        headers['Content-Type'] = 'application/json';
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = String(st.size);
        out.writeHead(200, headers);
        fs.createReadStream(file).pipe(out);
      });
    }
    readDir(dir, function (re, recs) {
      var packs = [];
      for (var i = 0; i < recs.length; i++) {
        try { packs.push(plainPack(recs[i].key, recs[i].value)); } catch (e) { /* */ }
      }
      headers['Content-Type'] = 'application/json';
      out.writeHead(200, headers);
      out.end(JSON.stringify(packs));
    });
  });
}

module.exports = {
  ROOT: ROOT, PROG: PROG, h: h, sourceDir: sourceDir, chanDir: chanDir, mkdirp: mkdirp, rmrf: rmrf,
  channelDirs: channelDirs, readDir: readDir, readChannel: readChannel, appendPacks: appendPacks,
  pruneSource: pruneSource, sourceHashes: sourceHashes, du: du, finalizeSource: finalizeSource, serve: serve, plainPack: plainPack
};
