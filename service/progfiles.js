/*
 * Файлы программы (общий модуль хранилища filekv.js, дочернего процесса разбора и HTTP /prog).
 *
 * Раскладка: prog2/<h(источник)>/<первые 2 знака h(канал)>/<h(канал)>/<загрузка>.<ndjson|epg>
 *   — до 256 корзин на источник, в каждой — десятки каналов (а не тысячи папок в одной).
 * Пока загрузка идёт, пачки канала дописываются строками в <загрузка>.ndjson
 * ({"k":[s,x,l,n],"v":{…, codec:'gzip-json-b64-1', data}}). В конце загрузки канал собирается
 * в один <загрузка>.epg, разбитый по суткам (UTC): браузер просит у /prog только нужные сутки,
 * а не всю программу канала (в среднем 650 передач, бывает 13 тысяч) — память браузера ТВ.
 *
 * Формат .epg: строка "PTV1 <длина оглавления, 8 знаков>\n", оглавление JSON
 * [[сутки, смещение, длина, передач], …] (смещения — от конца оглавления), затем по gzip-потоку
 * на сутки — JSON-массив из одной пачки [{s,x,l,n:сутки,p:[[start,stop,…],…]}]. Сутки — по
 * началу передачи. Одни сутки /prog отдаёт как есть с Content-Encoding: gzip (распакует браузер).
 * Прежний <загрузка>.json.gz (1.1.1, канал целиком) читается, пока его не сменит новая загрузка.
 * Код — ES5 (Node 0.12).
 */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');

var ROOT = require('./datadir.js');   // /media/internal/perfecttv-data или запасная (webOS 3)
var PROG = path.join(ROOT, 'prog2');
var BufferFrom = function (s, enc) { return new Buffer(s, enc); };

function h(s) { return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 20); }
function sourceDir(s) { return path.join(PROG, h(s)); }
function chanDir(s, x) { var hx = h(x); return path.join(PROG, h(s), hx.slice(0, 2), hx); }
function loadOf(name) { return name.split('.')[0]; }
var DAY = 86400;
function dayOf(t) { return Math.floor(t / DAY); }
var PACK_FILE = /\.(ndjson|json\.gz|epg)$/;
var HEAD = 14;   // "PTV1 " + 8 знаков + "\n"

/** Пачки (из одного канала) → .epg по суткам: Buffer */
function encodeEpg(s, x, l, packs) {
  var byDay = {}, days = [];
  for (var i = 0; i < packs.length; i++) {
    var p = packs[i].p || [];
    for (var j = 0; j < p.length; j++) {
      var d = dayOf(p[j][0]);
      if (!byDay[d]) { byDay[d] = []; days.push(d); }
      byDay[d].push(p[j]);
    }
  }
  days.sort(function (a, b) { return a - b; });
  var index = [], bodies = [], off = 0;
  for (var k = 0; k < days.length; k++) {
    var list = byDay[days[k]];
    list.sort(function (a, b) { return a[0] - b[0]; });
    var gz = zlib.gzipSync(BufferFrom(JSON.stringify([{ s: s, x: x, l: l, n: days[k], p: list }]), 'utf8'), { level: 6 });
    index.push([days[k], off, gz.length, list.length]);
    bodies.push(gz);
    off += gz.length;
  }
  var ix = BufferFrom(JSON.stringify(index), 'utf8');
  var len = String(ix.length);
  while (len.length < 8) len = '0' + len;
  return Buffer.concat([BufferFrom('PTV1 ' + len + '\n', 'utf8'), ix].concat(bodies));
}

/** Оглавление .epg: cb(err, {fd, base, index}) — fd открыт, закрыть вызывающему */
function openEpg(file, cb) {
  fs.open(file, 'r', function (oe, fd) {
    if (oe) return cb(oe);
    var head = new Buffer(HEAD);
    fs.read(fd, head, 0, HEAD, 0, function (re, n) {
      var m = !re && n === HEAD && /^PTV1 (\d{8})\n$/.exec(head.toString('utf8'));
      if (!m) { fs.close(fd, function () { /* */ }); return cb(re || new Error('bad epg file')); }
      var len = parseInt(m[1], 10), ib = new Buffer(len);
      fs.read(fd, ib, 0, len, HEAD, function (ie, n2) {
        var index = null;
        if (!ie && n2 === len) { try { index = JSON.parse(ib.toString('utf8')); } catch (e) { index = null; } }
        if (!index) { fs.close(fd, function () { /* */ }); return cb(ie || new Error('bad epg index')); }
        cb(null, { fd: fd, base: HEAD + len, index: index });
      });
    });
  });
}

/** Пачки .epg за сутки [a, b] (a/b не заданы — все): cb(err, [{s,x,l,n,p}]) */
function readEpg(file, a, b, cb) {
  openEpg(file, function (e, f) {
    if (e) return cb(e, []);
    var out = [], i = 0;
    (function next() {
      while (i < f.index.length && !inDays(f.index[i][0], a, b)) i++;
      if (i >= f.index.length) return fs.close(f.fd, function () { cb(null, out); });
      var it = f.index[i++], buf = new Buffer(it[2]);
      fs.read(f.fd, buf, 0, it[2], f.base + it[1], function (re) {
        if (!re) { try { out = out.concat(JSON.parse(zlib.gunzipSync(buf).toString('utf8'))); } catch (pe) { /* битые сутки — как будто нет */ } }
        next();
      });
    })();
  });
}
function inDays(d, a, b) { return (a === undefined || d >= a) && (b === undefined || d <= b); }

/** Оставить в пачке передачи, начинающиеся в сутки [a, b] */
function clipPack(pk, a, b) {
  if (a === undefined && b === undefined) return pk;
  var p = pk.p.filter(function (r) { return inDays(dayOf(r[0]), a, b); });
  return { s: pk.s, x: pk.x, l: pk.l, n: pk.n, p: p };
}

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
    readDirFiles(dir, names, function (out) { cb(null, out); });
  });
}
function readDirFiles(dir, names, cb) {
  (function () {
    var out = [], i = 0;
    (function next() {
      if (i >= names.length) return cb(out);
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
      } else if (/\.epg$/.test(name)) {
        readEpg(file, undefined, undefined, function (ee, packs) {
          for (var j = 0; j < packs.length; j++) out.push({ key: [packs[j].s, packs[j].x, packs[j].l, packs[j].n], value: packs[j] });
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
  })();
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
 * Конец загрузки: каждый канал источника — из строк <load>.ndjson в один <load>.epg по суткам.
 * keepFrom (unix-секунды, начало окна архива) — прошедшая программа прежней загрузки, которой нет
 * в новой, переносится: многие XMLTV отдают программу только с сегодняшнего дня, а архив канала —
 * неделя. Переносится то, что раньше первой передачи новой загрузки (у канала, пропавшего из
 * XMLTV, — всё прошедшее), и не старше keepFrom: старше архива не храним.
 * По каналу за раз с уступкой циклу событий (в процессе сервиса прокси не простаивает).
 */
function finalizeSource(s, loadId, keepFrom, cb) {
  if (typeof keepFrom === 'function') { cb = keepFrom; keepFrom = null; }
  var load = String(loadId), name = load + '.ndjson';
  var now = Math.floor(Date.now() / 1000);
  channelDirs(h(s), function (dirs) {
    var i = 0, done = 0, kept = 0;
    (function next() {
      if (i >= dirs.length) { console.log('EPG packed', done, 'channels to .epg', kept ? '(kept past programme of ' + kept + ')' : ''); return cb(null); }
      var dir = dirs[i++];
      fs.readdir(dir, function (de, names) {
        names = names || [];
        var olds = names.filter(function (n) { return PACK_FILE.test(n) && loadOf(n) !== load; });
        var hasNew = names.indexOf(name) >= 0;
        if (!hasNew && (keepFrom === null || !olds.length)) return setImmediate(next);
        readNew(function (packs, x) {
          if (!packs) return setImmediate(next);
          var first = Infinity;
          for (var k = 0; k < packs.length; k++) for (var r = 0; r < packs[k].p.length; r++) if (packs[k].p[r][0] < first) first = packs[k].p[r][0];
          carry(first === Infinity ? now : first, !hasNew, function (old, ox) {
            if (old.length) { packs.push({ s: s, x: x || ox, l: loadId, n: -1, p: old }); kept++; }
            if (!packs.length || !(x || ox)) return setImmediate(next);
            write(packs, x || ox);
          });
        });
      });
      function readNew(done2) {
        fs.readFile(path.join(dir, name), 'utf8', function (re, text) {
          if (re) return done2([], null);
          var packs = [], lines = text.split('\n'), x = null;
          try {
            for (var j = 0; j < lines.length; j++) {
              if (!lines[j]) continue;
              var r = JSON.parse(lines[j]);
              packs.push(plainPack(r.k, r.v));
              x = r.k[1];
            }
          } catch (e) { return done2(null, null); }
          packs.sort(function (a, b) { return a.n - b.n; });
          done2(packs, x);
        });
      }
      // прошедшее из прежних файлов: начало ≥ keepFrom и < until (канал пропал — и уже закончилось)
      function carry(until, pastOnly, done2) {
        if (keepFrom === null) return done2([], null);
        fs.readdir(dir, function (e, names) {
          var olds = (names || []).filter(function (n) { return PACK_FILE.test(n) && loadOf(n) !== load; });
          var out = [], seen = {}, ox = null, j = 0;
          (function each() {
            if (j >= olds.length) { out.sort(function (a, b) { return a[0] - b[0]; }); return done2(out, ox); }
            filePacks(dir, olds[j++], dayOf(keepFrom), dayOf(until), function (list) {
              for (var k = 0; k < list.length; k++) {
                ox = ox || list[k].x;
                for (var r = 0; r < list[k].p.length; r++) {
                  var pr = list[k].p[r];
                  if (pr[0] < keepFrom || pr[0] >= until || (pastOnly && pr[1] > now) || seen[pr[0]]) continue;
                  seen[pr[0]] = true;
                  out.push(pr);
                }
              }
              each();
            });
          })();
        });
      }
      function write(packs, x) {
        var buf;
        try { buf = encodeEpg(s, x, loadId, packs); } catch (ze) { return setImmediate(next); }
        var dst = path.join(dir, load + '.epg'), tmp = dst + '.tmp';
        fs.writeFile(tmp, buf, function (we) {
          if (we) return setImmediate(next);
          fs.rename(tmp, dst, function (rne) {
            if (rne) return fs.unlink(tmp, function () { setImmediate(next); });
            done++;
            fs.unlink(path.join(dir, name), function () { setImmediate(next); });
          });
        });
      }
    })();
  });
}

/** Пачки одного файла канала за сутки [a, b]: cb([{s,x,l,n,p}]) */
function filePacks(dir, name, a, b, cb) {
  var file = path.join(dir, name);
  if (/\.epg$/.test(name)) return readEpg(file, a, b, function (e, packs) { cb(packs); });
  // .ndjson (загрузка идёт) и .json.gz (1.1.1) — целиком, затем по суткам
  readDirFiles(dir, [name], function (recs) {
    var out = [];
    for (var i = 0; i < recs.length; i++) {
      try { var pk = clipPack(plainPack(recs[i].key, recs[i].value), a, b); if (pk.p.length) out.push(pk); } catch (e) { /* */ }
    }
    cb(out);
  });
}

function num(v) { if (v === undefined || v === null || v === '') return undefined; var n = parseInt(v, 10); return isFinite(n) ? n : undefined; }

/**
 * HTTP /prog?s=&x=[&a=&b=]: программа канала за сутки a…b (номера суток UTC по началу передачи;
 * без a/b — вся) — JSON-массив пачек [{s,x,l,n,p}]. Одни сутки из собранного .epg — gzip-поток
 * как есть с Content-Encoding: gzip; иначе (несколько суток, идёт загрузка, файлы двух загрузок)
 * — собрать здесь и отдать обычным JSON (по локальному адресу сжатие не нужно).
 */
function serve(s, x, out, headers, a0, b0, daysOnly) {
  if (typeof s !== 'string' || typeof x !== 'string') {
    out.writeHead(400, headers); return out.end('[]');
  }
  if (daysOnly) return days(s, x, function (list) {
    headers['Content-Type'] = 'application/json';
    out.writeHead(200, headers);
    out.end(JSON.stringify(list));
  });
  var a = num(a0), b = num(b0);
  var dir = chanDir(s, x);
  headers['Content-Type'] = 'application/json';
  fs.readdir(dir, function (err, names) {
    names = (names || []).filter(function (n) { return PACK_FILE.test(n); });
    if (err || !names.length) { out.writeHead(200, headers); return out.end('[]'); }
    if (names.length === 1 && /\.epg$/.test(names[0]) && a !== undefined && a === b) {
      return openEpg(path.join(dir, names[0]), function (oe, f) {
        if (oe) { out.writeHead(200, headers); return out.end('[]'); }
        var it = null;
        for (var i = 0; i < f.index.length; i++) if (f.index[i][0] === a) it = f.index[i];
        if (!it) { fs.close(f.fd, function () { /* */ }); out.writeHead(200, headers); return out.end('[]'); }
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = String(it[2]);
        out.writeHead(200, headers);
        fs.createReadStream(null, { fd: f.fd, start: f.base + it[1], end: f.base + it[1] + it[2] - 1, autoClose: true }).pipe(out);
      });
    }
    var packs = [], i = 0;
    (function next() {
      if (i >= names.length) { out.writeHead(200, headers); return out.end(JSON.stringify(packs)); }
      filePacks(dir, names[i++], a, b, function (list) { packs = packs.concat(list); next(); });
    })();
  });
}

/**
 * Оглавление канала: [[сутки, передач], …] по возрастанию — для вкладок дат (расписание грузит
 * сутки по мере листания, а даты показывает все). У .epg — только его оглавление, без распаковки.
 */
function days(s, x, cb) {
  var dir = chanDir(s, x), count = {};
  function add(d, n) { if (!count[d] || count[d] < n) count[d] = n; }   // две загрузки — не складывать
  fs.readdir(dir, function (e, names) {
    names = (names || []).filter(function (n) { return PACK_FILE.test(n); });
    var i = 0;
    (function next() {
      if (i >= names.length) {
        var out = Object.keys(count).map(function (d) { return [+d, count[d]]; });
        out.sort(function (a, b) { return a[0] - b[0]; });
        return cb(out);
      }
      var name = names[i++];
      if (/\.epg$/.test(name)) {
        return openEpg(path.join(dir, name), function (oe, f) {
          if (oe) return next();
          for (var k = 0; k < f.index.length; k++) add(f.index[k][0], f.index[k][3]);
          fs.close(f.fd, function () { next(); });
        });
      }
      filePacks(dir, name, undefined, undefined, function (packs) {
        var c = {};
        for (var k = 0; k < packs.length; k++) for (var r = 0; r < packs[k].p.length; r++) { var d = dayOf(packs[k].p[r][0]); c[d] = (c[d] || 0) + 1; }
        for (var dd in c) add(+dd, c[dd]);
        next();
      });
    })();
  });
}

/**
 * Поиск по названиям передач — здесь, а не в браузере (иначе браузеру читать программу всех
 * каналов). items: [[s, x, a, b, i], …] (сутки a…b), words — в нижнем регистре.
 * cb([[i, пачка {l, p}], …]) — не больше max передач; stopped() — клиент ушёл.
 */
function search(items, words, max, stopped, cb) {
  var out = [], found = 0, i = 0;
  (function next() {
    if (i >= items.length || found >= max || stopped()) return cb(out);
    var it = items[i++];
    if (!Array.isArray(it) || typeof it[0] !== 'string' || typeof it[1] !== 'string') return next();
    var dir = chanDir(it[0], it[1]);
    fs.readdir(dir, function (e, names) {
      names = (names || []).filter(function (n) { return PACK_FILE.test(n); });
      var j = 0;
      (function file() {
        if (j >= names.length) return setImmediate(next);
        filePacks(dir, names[j++], num(it[2]), num(it[3]), function (packs) {
          for (var k = 0; k < packs.length; k++) {
            var hit = [];
            for (var r = 0; r < packs[k].p.length; r++) {
              var t = String(packs[k].p[r][2] || '').toLowerCase(), ok = true;
              for (var w = 0; w < words.length; w++) if (t.indexOf(words[w]) < 0) { ok = false; break; }
              if (ok) hit.push(packs[k].p[r]);
            }
            if (hit.length) { out.push([it[4], { l: packs[k].l, p: hit }]); found += hit.length; }
          }
          file();
        });
      })();
    });
  })();
}

module.exports = {
  ROOT: ROOT, PROG: PROG, h: h, sourceDir: sourceDir, chanDir: chanDir, mkdirp: mkdirp, rmrf: rmrf,
  channelDirs: channelDirs, readDir: readDir, readChannel: readChannel, appendPacks: appendPacks,
  pruneSource: pruneSource, sourceHashes: sourceHashes, du: du, finalizeSource: finalizeSource, serve: serve, search: search, days: days, plainPack: plainPack,
  encodeEpg: encodeEpg, readEpg: readEpg, dayOf: dayOf
};
