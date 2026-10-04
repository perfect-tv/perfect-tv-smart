/*
 * Хранилище приложения в файлах (вместо самописного SQLite 1.0.7–1.0.9).
 * Протокол — тот же, что у sqlitekv.js: get / list / put / delete / deleteRange / epgBatch /
 * status / reset (интерфейс и разбор программы не меняются).
 *
 * Раскладка (ROOT = /media/internal/perfecttv-data или PERFECTTV_DATA_DIR):
 *   <store>.json                     мелкие хранилища целиком: playlists, channels, sources,
 *                                    epgch, map, settings — в памяти; запись с задержкой,
 *                                    атомарно (временный файл + rename)
 *   prog/<h(s)>/<h(x)>/<l>.ndjson    программа: пачки канала x источника s загрузки l,
 *                                    строка — {"k":[s,x,l,n],"v":…}; пачки только дописываются
 * Программа в памяти не держится, база целиком не перезаписывается: запись пачки — дописать
 * строку в файл её канала, чтение канала — прочитать его файлы, смена загрузки — удалить
 * файлы прежних загрузок.
 *
 * Код — ES5 (Node 0.12 на webOS 3–5).
 */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = process.env.PERFECTTV_DATA_DIR || '/media/internal/perfecttv-data';
var PROG = path.join(ROOT, 'prog');
var SMALL = { playlists: 1, channels: 1, sources: 1, epgch: 1, map: 1, settings: 1 };
var SAVE_DELAY = 300;

var stores = {};        // имя → {data: {id: {k, v}}, dirty, timer, saving}
var ready = false;
var waiters = [];
var progQueue = [];     // изменения программы — по одному (дописывание, удаление)
var progBusy = false;

function error(msg) { var e = new Error(msg); e.code = 'EINVAL'; return e; }
function valid(store) { return store === 'prog' || Object.prototype.hasOwnProperty.call(SMALL, store); }
function id(key) { return JSON.stringify(key); }
function h(s) { return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 20); }

function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (var i = 0; i < a.length && i < b.length; i++) { var c = compare(a[i], b[i]); if (c) return c; }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  function order(x) { return typeof x === 'number' ? 1 : typeof x === 'string' ? 2 : Array.isArray(x) ? 3 : 0; }
  return order(a) - order(b);
}
function inRange(key, range) {
  if (!range) return true;
  if (Object.prototype.hasOwnProperty.call(range, 'lower')) { var l = compare(key, range.lower); if (l < 0 || (l === 0 && range.lowerOpen)) return false; }
  if (Object.prototype.hasOwnProperty.call(range, 'upper')) { var u = compare(key, range.upper); if (u > 0 || (u === 0 && range.upperOpen)) return false; }
  return true;
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

function writeAtomic(file, text, cb) {
  var tmp = file + '.' + process.pid + '.tmp';
  fs.writeFile(tmp, text, function (err) {
    if (err) return cb(err);
    fs.rename(tmp, file, function (re) {
      if (re) return fs.unlink(tmp, function () { cb(re); });
      cb(null);
    });
  });
}

// ------------------------------------------------------------ мелкие хранилища

function loadStore(name, cb) {
  fs.readFile(path.join(ROOT, name + '.json'), 'utf8', function (err, text) {
    var data = {};
    if (!err) {
      try { data = JSON.parse(text) || {}; } catch (e) { console.error('filekv: broken ' + name + '.json', e.message); data = {}; }
    } else if (err.code !== 'ENOENT') return cb(err);
    stores[name] = { data: data, dirty: false, timer: null, saving: false, waiters: [] };
    cb(null);
  });
}

function saveStore(name) {
  var st = stores[name];
  if (!st || st.saving) return;
  st.timer = null;
  if (!st.dirty) return;
  st.dirty = false;
  st.saving = true;
  var w = st.waiters; st.waiters = [];
  writeAtomic(path.join(ROOT, name + '.json'), JSON.stringify(st.data), function (err) {
    st.saving = false;
    if (err) console.error('filekv: save ' + name, err.message);
    for (var i = 0; i < w.length; i++) w[i](err || null);
    if (st.dirty && !st.timer) st.timer = setTimeout(function () { saveStore(name); }, SAVE_DELAY);
  });
}

/** Изменили мелкое хранилище: записать с задержкой; cb — когда записано */
function touch(name, cb) {
  var st = stores[name];
  st.dirty = true;
  if (cb) st.waiters.push(cb);
  if (!st.timer && !st.saving) st.timer = setTimeout(function () { saveStore(name); }, SAVE_DELAY);
}

function init(cb) {
  if (ready) return cb(null);
  waiters.push(cb);
  if (waiters.length > 1) return;
  mkdirp(PROG, function (err) {
    if (err) return done(err);
    var names = Object.keys(SMALL), i = 0;
    (function next(e) {
      if (e) return done(e);
      if (i >= names.length) return migrate(done);
      loadStore(names[i++], next);
    })();
  });
  function done(err) {
    if (!err) ready = true;
    var w = waiters; waiters = [];
    for (var j = 0; j < w.length; j++) w[j](err || null);
  }
}

/**
 * Перенос с 1.0.7–1.0.9 (самописный SQLite): настройки — из perfecttv-settings.sqlite3, плейлисты,
 * каналы, источники и сопоставления — из perfecttv.sqlite3, если он не больше 40 МБ (больший
 * разбирается целиком в память — на ТВ это риск; тогда плейлисты добавить заново).
 * Программа не переносится — она скачается снова. Старые файлы удаляются после переноса.
 */
function migrate(cb) {
  var marker = path.join(ROOT, 'files.v1');
  fs.stat(marker, function (me) {
    if (!me) return cb(null);
    var codec;
    try { codec = require('./sqlite-codec.js'); } catch (e) { codec = null; }
    var imported = 0;
    function importFile(file, maxBytes, next) {
      fs.stat(file, function (se, st) {
        if (se) return next();
        if (st.size > maxBytes || !codec) {
          console.warn('filekv: old database skipped', file, st.size);
          return fs.rename(file, file + '.old', function () { next(); });
        }
        fs.readFile(file, function (re, buf) {
          if (re) return next();
          var rows;
          try { rows = codec.parse(buf); } catch (pe) { console.warn('filekv: old database unreadable', pe.message); rows = []; }
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r || !Object.prototype.hasOwnProperty.call(SMALL, r.s) || r.s === 'epgch') continue;
            stores[r.s].data[id(r.k)] = { k: r.k, v: r.v };
            stores[r.s].dirty = true;
            imported++;
          }
          fs.unlink(file, function () { next(); });
        });
      });
    }
    importFile(path.join(ROOT, 'perfecttv.sqlite3'), 40 * 1024 * 1024, function () {
      importFile(path.join(ROOT, 'perfecttv-settings.sqlite3'), 40 * 1024 * 1024, function () {
        var names = Object.keys(SMALL), i = 0;
        (function next(e) {
          if (e) console.error('filekv: migration save', e.message);
          if (i < names.length) {
            var n = names[i++];
            if (!stores[n].dirty) return next();
            stores[n].dirty = false;
            return writeAtomic(path.join(ROOT, n + '.json'), JSON.stringify(stores[n].data), next);
          }
          if (imported) console.log('filekv: imported from old database', imported, 'records');
          writeAtomic(marker, String(Date.now()), function () { cb(null); });
        })();
      });
    });
  });
}

// ------------------------------------------------------------ программа

function chanDir(s, x) { return path.join(PROG, h(s), h(x)); }

/** Строки файлов канала → записи {key, value} */
function readChannel(s, x, cb) {
  var dir = chanDir(s, x);
  fs.readdir(dir, function (err, names) {
    if (err) return cb(err.code === 'ENOENT' ? null : err, []);
    var out = [], i = 0;
    (function next() {
      if (i >= names.length) return cb(null, out);
      var name = names[i++];
      if (!/\.ndjson$/.test(name)) return next();
      fs.readFile(path.join(dir, name), 'utf8', function (re, text) {
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
    })();
  });
}

/** Каналы источника (или всех): [{s, x}] — из первой строки любого файла канала */
function channelsOf(sourceHash, cb) {
  var roots = [];
  function scanSource(sh, done) {
    fs.readdir(path.join(PROG, sh), function (e, chans) {
      if (e) return done();
      for (var i = 0; i < chans.length; i++) roots.push(path.join(PROG, sh, chans[i]));
      done();
    });
  }
  if (sourceHash) return scanSource(sourceHash, function () { cb(roots); });
  fs.readdir(PROG, function (e, srcs) {
    if (e) return cb(roots);
    var i = 0;
    (function next() { if (i >= srcs.length) return cb(roots); scanSource(srcs[i++], next); })();
  });
}

function progRun(task) {
  progQueue.push(task);
  if (progBusy) return;
  progBusy = true;
  (function next() {
    var t = progQueue.shift();
    if (!t) { progBusy = false; return; }
    t(function () { setImmediate(next); });
  })();
}

/** Дописать пачки: по файлу канала-загрузки, последовательно */
function appendPacks(rows, cb) {
  var groups = {}, order = [];
  for (var i = 0; i < rows.length; i++) {
    var k = rows[i].key;
    if (!Array.isArray(k) || k.length < 4) return cb(error('invalid prog key'));
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

/** Удалить у источника s файлы всех загрузок, кроме keepLoad */
function pruneSource(s, keepLoad, cb) {
  var keep = String(keepLoad) + '.ndjson';
  channelsOf(h(s), function (dirs) {
    var i = 0;
    (function next() {
      if (i >= dirs.length) return cb(null);
      var dir = dirs[i++];
      fs.readdir(dir, function (e, names) {
        if (e) return next();
        var j = 0;
        (function del() {
          if (j >= names.length) return next();
          var n = names[j++];
          if (n === keep) return del();
          fs.unlink(path.join(dir, n), function () { del(); });
        })();
      });
    })();
  });
}

/** Удалить пачки по ключам: переписать файлы их каналов без этих строк (редкий путь) */
function deletePacks(keys, cb) {
  var byChan = {}, list = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!Array.isArray(k) || k.length < 4) continue;
    var c = id([k[0], k[1]]);
    if (!byChan[c]) { byChan[c] = { s: k[0], x: k[1], ids: {} }; list.push(c); }
    byChan[c].ids[id(k)] = true;
  }
  var j = 0;
  (function next() {
    if (j >= list.length) return cb(null);
    var ch = byChan[list[j++]];
    readChannel(ch.s, ch.x, function (e, recs) {
      var files = {};
      for (var r = 0; r < recs.length; r++) {
        if (ch.ids[id(recs[r].key)]) continue;
        var f = String(recs[r].key[2]) + '.ndjson';
        files[f] = (files[f] || '') + JSON.stringify({ k: recs[r].key, v: recs[r].value }) + '\n';
      }
      var dir = chanDir(ch.s, ch.x);
      rmrf(dir, function () {
        var names = Object.keys(files);
        if (!names.length) return next();
        mkdirp(dir, function () {
          var n = 0;
          (function w() {
            if (n >= names.length) return next();
            var name = names[n++];
            fs.writeFile(path.join(dir, name), files[name], w);
          })();
        });
      });
    });
  })();
}

/** Чтение программы по диапазону: канал [s, x] — его файлы; источник [s] — его каналы; иначе всё */
function listProg(range, cb) {
  var lower = range && Array.isArray(range.lower) ? range.lower : null;
  var upper = range && Array.isArray(range.upper) ? range.upper : null;
  var s = lower && upper && typeof lower[0] === 'string' && lower[0] === upper[0] ? lower[0] : null;
  var x = s !== null && lower.length >= 2 && upper.length >= 2 && lower[1] === upper[1] ? lower[1] : null;
  if (s !== null && x !== null) {
    return readChannel(s, x, function (e, recs) { cb(e, recs.filter(function (r) { return inRange(r.key, range); })); });
  }
  channelsOf(s !== null ? h(s) : null, function (dirs) {
    var out = [], i = 0;
    (function next() {
      if (i >= dirs.length) return cb(null, out);
      var dir = dirs[i++];
      fs.readdir(dir, function (e, names) {
        if (e || !names.length) return next();
        // s и x канала — из первой строки любого его файла
        fs.readFile(path.join(dir, names[0]), 'utf8', function (re, text) {
          var first = null;
          try { first = JSON.parse((text || '').split('\n')[0]); } catch (pe) { first = null; }
          if (!first || !Array.isArray(first.k)) return next();
          readChannel(first.k[0], first.k[1], function (ce, recs) {
            for (var r = 0; r < recs.length; r++) if (inRange(recs[r].key, range)) out.push(recs[r]);
            next();
          });
        });
      });
    })();
  });
}

// ------------------------------------------------------------ протокол

function page(records, q, cb) {
  records.sort(function (a, b) { return compare(a.key, b.key); });
  var offset = Math.max(0, parseInt(q.offset, 10) || 0);
  var max = Math.min(250, Math.max(1, parseInt(q.limit, 10) || 80));
  // ответ по WebSocket — не больше ~450 КБ: память браузера на старых ТВ
  var selected = [], size = 0, end = offset;
  while (end < records.length && selected.length < max) {
    var row = records[end], estimate = JSON.stringify(row).length;
    if (selected.length && size + estimate > 430000) break;
    selected.push(row); size += estimate; end++;
  }
  cb(null, { records: selected, next: end < records.length ? end : null });
}

function dispatch(op, q, cb) {
  init(function (err) {
    if (err) return cb(err);
    var store = q.store, i;
    if (op === 'status') {
      var n = 0;
      for (var s in stores) n += Object.keys(stores[s].data).length;
      return cb(null, { backend: 'files', path: ROOT, entries: n });
    }
    if (op === 'reset') {
      for (var name in stores) { stores[name].data = {}; touch(name); }
      return progRun(function (done) { rmrf(PROG, function () { mkdirp(PROG, function (e) { done(); cb(e, { ok: !e }); }); }); });
    }
    if (op === 'epgBatch') {
      var groups = q.groups || {}, prog = [];
      try {
        for (var g in groups) if (Object.prototype.hasOwnProperty.call(groups, g)) {
          if (!valid(g) || g === 'settings' || g === 'playlists' || g === 'channels' || !Array.isArray(groups[g])) throw error('invalid epg store');
          var rows = groups[g];
          for (i = 0; i < rows.length; i++) if (!rows[i] || rows[i].key === undefined || rows[i].value === undefined) throw error('invalid EPG record');
          if (g === 'prog') { prog = rows; continue; }
          for (i = 0; i < rows.length; i++) stores[g].data[id(rows[i].key)] = { k: rows[i].key, v: rows[i].value };
        }
        if (q.prune && (typeof q.prune.url !== 'string' || typeof q.prune.loadId !== 'number')) throw error('invalid EPG pruning');
      } catch (e) { return cb(e); }
      var count = 0;
      for (g in groups) if (Object.prototype.hasOwnProperty.call(groups, g)) count += groups[g].length;
      return progRun(function (done) {
        appendPacks(prog, function (ae) {
          if (ae) { done(); return cb(ae); }
          var finish = function (pe) {
            // мелкие хранилища программы (sources, epgch, map) — записать сразу, без задержки
            var pend = 0, firstErr = pe || null;
            for (var gg in groups) if (gg !== 'prog' && Object.prototype.hasOwnProperty.call(groups, gg) && groups[gg].length) {
              pend++;
              touch(gg, function (te) { if (te && !firstErr) firstErr = te; if (--pend === 0) { done(); cb(firstErr, { written: count }); } });
              saveStore(gg);
            }
            if (!pend) { done(); cb(firstErr, { written: count }); }
          };
          if (q.prune) pruneSource(q.prune.url, q.prune.loadId, finish); else finish(null);
        });
      });
    }
    if (!valid(store)) return cb(error('invalid store'));
    if (op === 'get') {
      if (store === 'prog') return cb(error('prog: use list'));
      var r = stores[store].data[id(q.key)];
      return cb(null, { record: r ? { key: r.k, value: r.v } : null });
    }
    if (op === 'list') {
      if (store === 'prog') return listProg(q.range || null, function (e, recs) { if (e) return cb(e); page(recs, q, cb); });
      var out = [], data = stores[store].data;
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k) && inRange(data[k].k, q.range || null)) out.push({ key: data[k].k, value: data[k].v });
      return page(out, q, cb);
    }
    if (op === 'put') {
      var items = q.items;
      if (!Array.isArray(items) || items.length > 100) return cb(error('invalid batch'));
      for (i = 0; i < items.length; i++) if (!items[i] || items[i].key === undefined || items[i].value === undefined) return cb(error('invalid record'));
      if (store === 'prog') return progRun(function (done) { appendPacks(items, function (e) { done(); cb(e, { written: items.length }); }); });
      for (i = 0; i < items.length; i++) stores[store].data[id(items[i].key)] = { k: items[i].key, v: items[i].value };
      // настройки — с задержкой (часто и мелко); остальное — дождаться записи
      if (store === 'settings') { touch(store); return cb(null, { written: items.length }); }
      touch(store, function (e) { cb(e, { written: items.length }); });
      return;
    }
    if (op === 'delete') {
      var keys = q.keys;
      if (!Array.isArray(keys)) return cb(error('invalid keys'));
      if (store === 'prog') return progRun(function (done) { deletePacks(keys, function (e) { done(); cb(e, { removed: true }); }); });
      for (i = 0; i < keys.length; i++) delete stores[store].data[id(keys[i])];
      if (store === 'settings') { touch(store); return cb(null, { removed: true }); }
      touch(store, function (e) { cb(e, { removed: true }); });
      return;
    }
    if (op === 'deleteRange') {
      var range = q.range || null;
      if (store === 'prog') {
        var lo = range && Array.isArray(range.lower) ? range.lower : null, up = range && Array.isArray(range.upper) ? range.upper : null;
        var src = lo && up && typeof lo[0] === 'string' && lo[0] === up[0] ? lo[0] : null;
        return progRun(function (done) {
          var target = src !== null ? path.join(PROG, h(src)) : PROG;
          rmrf(target, function (e) { mkdirp(PROG, function () { done(); cb(e, { removed: true }); }); });
        });
      }
      var d = stores[store].data;
      for (var dk in d) if (Object.prototype.hasOwnProperty.call(d, dk) && inRange(d[dk].k, range)) delete d[dk];
      touch(store, function (e) { cb(e, { removed: true }); });
      return;
    }
    cb(error('unknown operation'));
  });
}

/** Записать отложенное (выход сервиса) */
function flush(cb) {
  var names = Object.keys(stores), pend = 0;
  for (var i = 0; i < names.length; i++) if (stores[names[i]].dirty || stores[names[i]].timer) {
    pend++;
    if (stores[names[i]].timer) { clearTimeout(stores[names[i]].timer); stores[names[i]].timer = null; }
    touch(names[i], function () { if (--pend === 0 && cb) cb(); });
    saveStore(names[i]);
  }
  if (!pend && cb) cb();
}

module.exports = { dispatch: dispatch, flush: flush, valid: valid, root: ROOT };
