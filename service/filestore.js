/*
 * Файловое хранилище IndexedDB-fallback для LG webOS (Node 0.12, только core modules).
 * JS-сервис в jail может сохранять собственные данные в /media/internal.
 * Данные в файловом пространстве сервиса переживают обновление IPK.
 * Каждая запись пишется через временный файл + rename, чтобы избежать битых данных.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var urlMod = require('url');
var ROOT = require('./datadir.js');   // /media/internal/perfecttv-data или запасная (webOS 3)
var STORES = { playlists: true, channels: true, sources: true, epgch: true, prog: true, map: true };
var MAX_BODY = 3 * 1024 * 1024;
var nextTemp = 0;

function hash(k) { return crypto.createHash('sha1').update(JSON.stringify(k), 'utf8').digest('hex'); }
function exists(p, cb) { fs.stat(p, function (e) { cb(!e); }); }
function mkdir(dir, cb) {
  fs.mkdir(dir, function (e) { if (!e || e.code === 'EEXIST') cb(null); else cb(e); });
}
function chain(parts, done) {
  var i = 0;
  function next(err) { if (err || i >= parts.length) return done(err || null); mkdir(parts[i++], next); }
  next();
}
function storeDir(store) { return path.join(ROOT, store); }
function folder(store, key) {
  var p = storeDir(store);
  if (store === 'prog' && Array.isArray(key) && key.length >= 2) p = path.join(p, hash(key[0]), hash(key[1]));
  else if ((store === 'epgch' || store === 'map') && Array.isArray(key) && key.length >= 1) p = path.join(p, hash(key[0]));
  return p;
}
function location(store, key) { return path.join(folder(store, key), hash(key) + '.json'); }
function ensureFileDir(store, key, cb) {
  var p = folder(store, key);
  var paths = [ROOT, storeDir(store)];
  if (store === 'prog' && key.length >= 2) paths.push(path.join(storeDir(store), hash(key[0])));
  if (p !== storeDir(store)) paths.push(p);
  chain(paths, cb);
}
function validStore(store) { return STORES[store] === true; }
function done(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': res._perfectOrigin || 'null', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function sendError(res, err) { done(res, err && err.code === 'EINVAL' ? 400 : 503, { ok: false, error: String(err && (err.message || err) || 'storage failed') }); }
function invalid(message) { var e = new Error(message); e.code = 'EINVAL'; return e; }

function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (var i = 0; i < a.length && i < b.length; i++) { var d = compare(a[i], b[i]); if (d) return d; }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  var order = function (x) { return typeof x === 'number' ? 1 : typeof x === 'string' ? 2 : Array.isArray(x) ? 3 : 0; };
  return order(a) - order(b);
}
function inRange(key, range) {
  if (!range) return true;
  if (Object.prototype.hasOwnProperty.call(range, 'lower')) {
    var l = compare(key, range.lower); if (l < 0 || (l === 0 && range.lowerOpen)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(range, 'upper')) {
    var u = compare(key, range.upper); if (u > 0 || (u === 0 && range.upperOpen)) return false;
  }
  return true;
}
function rangePrefix(range) {
  if (!range || !Array.isArray(range.lower) || !Array.isArray(range.upper)) return null;
  var lower = range.lower, upper = range.upper;
  if (upper.length !== lower.length + 1 || !Array.isArray(upper[upper.length - 1]) || upper[upper.length - 1].length) return null;
  for (var i = 0; i < lower.length; i++) if (compare(lower[i], upper[i])) return null;
  return lower;
}
function narrowedDir(store, range) {
  var prefix = rangePrefix(range);
  if (!prefix) return storeDir(store);
  if (store === 'prog' && prefix.length >= 2) return path.join(storeDir(store), hash(prefix[0]), hash(prefix[1]));
  if ((store === 'prog' || store === 'epgch' || store === 'map') && prefix.length >= 1) return path.join(storeDir(store), hash(prefix[0]));
  return storeDir(store);
}
function walk(dir, cb) {
  var found = [];
  function explore(p, doneWalk) {
    fs.readdir(p, function (err, names) {
      if (err && err.code === 'ENOENT') return doneWalk();
      if (err) return doneWalk(err);
      var i = 0;
      function next(e) {
        if (e || i >= names.length) return doneWalk(e || null);
        var name = names[i++];
        if (name[0] === '.' || /\.tmp$/.test(name)) return next();
        var f = path.join(p, name);
        fs.stat(f, function (se, st) {
          if (se) return next(se.code === 'ENOENT' ? null : se);
          if (st.isDirectory()) explore(f, next);
          else { if (/\.json$/.test(name)) found.push(f); next(); }
        });
      }
      next();
    });
  }
  explore(dir, function (err) { cb(err, found); });
}
function readRecord(file, cb) {
  fs.readFile(file, 'utf8', function (err, str) {
    if (err) return cb(err);
    try { var obj = JSON.parse(str); cb(null, obj); }
    catch (e) { cb(e); }
  });
}
function list(store, range, cb) {
  walk(narrowedDir(store, range), function (err, files) {
    if (err) return cb(err);
    var result = [], i = 0;
    function next(e) {
      if (e || i >= files.length) return cb(e || null, result);
      readRecord(files[i++], function (re, r) {
        if (re) return next(re);
        if (inRange(r.key, range)) result.push(r);
        next();
      });
    }
    next();
  });
}
function read(store, key, cb) {
  readRecord(location(store, key), function (err, v) {
    if (err && err.code === 'ENOENT') return cb(null, null);
    if (err) return cb(err);
    if (JSON.stringify(v.key) !== JSON.stringify(key)) return cb(invalid('key mismatch'));
    cb(null, v);
  });
}
function putOne(store, item, cb) {
  if (!item || typeof item !== 'object' || item.key === undefined || item.value === undefined) return cb(invalid('invalid record'));
  ensureFileDir(store, item.key, function (err) {
    if (err) return cb(err);
    var name = location(store, item.key);
    var tmp = name + '.' + process.pid + '.' + (++nextTemp) + '.tmp';
    fs.writeFile(tmp, JSON.stringify(item), 'utf8', function (e) {
      if (e) return cb(e);
      fs.rename(tmp, name, function (renameError) {
        if (!renameError) return cb(null);
        fs.unlink(tmp, function () { cb(renameError); });
      });
    });
  });
}
function putMany(store, items, cb) {
  if (!Array.isArray(items) || items.length > 100) return cb(invalid('too many records'));
  var i = 0;
  function next(e) {
    if (e || i >= items.length) {
      if (e || !items.length) return cb(e || null);
      return fs.writeFile(path.join(ROOT, '.active'), '1', 'utf8', cb);
    }
    putOne(store, items[i++], next);
  }
  next();
}
function deleteKeys(store, keys, cb) {
  if (!Array.isArray(keys) || keys.length > 2000) return cb(invalid('invalid keys'));
  var i = 0;
  function next(err) {
    if (err || i >= keys.length) return cb(err || null);
    fs.unlink(location(store, keys[i++]), function (e) { next(e && e.code !== 'ENOENT' ? e : null); });
  }
  next();
}
function rmTree(dir, cb) {
  fs.readdir(dir, function (e, names) {
    if (e && e.code === 'ENOENT') return cb(null);
    if (e) return cb(e);
    var i = 0;
    function next(err) {
      if (err || i >= names.length) return fs.rmdir(dir, function (de) { cb(err || (de && de.code !== 'ENOENT' ? de : null)); });
      var f = path.join(dir, names[i++]);
      fs.stat(f, function (se, st) {
        if (se) return next(se.code !== 'ENOENT' ? se : null);
        if (st.isDirectory()) rmTree(f, next);
        else fs.unlink(f, function (ue) { next(ue && ue.code !== 'ENOENT' ? ue : null); });
      });
    }
    next();
  });
}
function rangeDelete(store, range, cb) {
  // Быстрый полный сброс скачанного EPG: не читай тысячи файлов перед удалением.
  var all = range && !Object.prototype.hasOwnProperty.call(range, 'upper') &&
    ((!Array.isArray(range.lower) && (range.lower === '' || range.lower === 0)) ||
      (Array.isArray(range.lower) && range.lower.length === 1 && range.lower[0] === ''));
  if (all) return rmTree(storeDir(store), cb);
  list(store, range, function (err, items) {
    if (err) return cb(err);
    deleteKeys(store, items.map(function (r) { return r.key; }), cb);
  });
}
function status(cb) { exists(path.join(ROOT, '.active'), function (active) { cb(null, { ok: true, active: active }); }); }
function reset(cb) {
  var names = Object.keys(STORES), i = 0;
  function next(err) {
    if (err || i >= names.length) {
      if (err) return cb(err);
      return fs.unlink(path.join(ROOT, '.active'), function (e) { cb(e && e.code !== 'ENOENT' ? e : null); });
    }
    rmTree(storeDir(names[i++]), next);
  }
  next();
}
function body(req, cb) {
  var chunks = [], size = 0, stopped = false;
  req.on('data', function (chunk) {
    if (stopped) return;
    size += chunk.length;
    if (size > MAX_BODY) { stopped = true; return cb(invalid('request too large')); }
    chunks.push(chunk);
  });
  req.on('end', function () {
    if (stopped) return;
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (e) { cb(invalid('invalid JSON')); }
  });
  req.on('error', function (e) { if (!stopped) { stopped = true; cb(e); } });
}
function handle(req, out) {
  // Запросы из приложения: Origin null / file:// (webOS 4+) или file://top.rootu.perfecttv (webOS 3). Из внешних сайтов доступ запрещён.
  var origin = req.headers.origin || '';
  if (origin && origin !== 'null' && origin !== 'file://' && origin !== 'file://top.rootu.perfecttv' && !/^http:\/\/127\.0\.0\.1(:[0-9]+)?$/.test(origin)) return done(out, 403, { ok: false, error: 'origin denied' });
  out._perfectOrigin = origin || 'null';
  var parsed = urlMod.parse(req.url, true), route = parsed.pathname;
  if (req.method === 'OPTIONS') {
    out.writeHead(204, { 'Access-Control-Allow-Origin': origin || 'null', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return out.end();
  }
  if (route === '/_db/status' && req.method === 'GET') return status(function (e, data) { if (e) sendError(out, e); else done(out, 200, data); });
  if (route === '/_db/get' && req.method === 'GET') {
    var store = parsed.query.store, key;
    try { key = JSON.parse(parsed.query.key); } catch (e) { return sendError(out, invalid('invalid key')); }
    if (!validStore(store)) return sendError(out, invalid('invalid store'));
    return read(store, key, function (e, record) { if (e) sendError(out, e); else done(out, 200, { ok: true, record: record }); });
  }
  if (req.method !== 'POST') return done(out, 405, { ok: false, error: 'method denied' });
  body(req, function (err, payload) {
    if (err) return sendError(out, err);
    var store = payload && payload.store;
    if (route !== '/_db/reset' && !validStore(store)) return sendError(out, invalid('invalid store'));
    var cb = function (e, value) { if (e) sendError(out, e); else done(out, 200, { ok: true, records: value || [] }); };
    if (route === '/_db/put') return putMany(store, payload.items, cb);
    if (route === '/_db/list') return list(store, payload.range || null, cb);
    if (route === '/_db/delete') return deleteKeys(store, payload.keys, cb);
    if (route === '/_db/deleteRange') return rangeDelete(store, payload.range || null, cb);
    if (route === '/_db/reset') return reset(cb);
    sendError(out, invalid('invalid operation'));
  });
}
module.exports = { handle: handle, compare: compare, inRange: inRange, status: status, ROOT: ROOT };
