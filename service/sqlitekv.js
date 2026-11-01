/*
 * SQLite3 KV backend without native Node addons / WebAssembly.
 * webOS 3/4 runs Node 0.12.2, where native sqlite3 and WASM are unavailable.
 * Creates a genuine SQLite 3 file (CREATE TABLE kv(s TEXT,k TEXT,v TEXT)),
 * serializes SQLite table B-trees and overflow pages, and reads them back.
 * All writes use temp+rename. No external database executable is required.
 * ES5 only. This module intentionally supports only the internal kv schema;
 * arbitrary SQL is NOT accepted from the web app.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var TEMPLATE = path.join(__dirname, 'perfecttv-template.sqlite3');
var ROOT = require('./datadir.js');   // /media/internal/perfecttv-data или запасная (webOS 3)
var DB_PATH = path.join(ROOT, 'perfecttv.sqlite3');
var settingsDb = null;
var PAGE = 4096;
var X = PAGE - 35;
var M = Math.floor((PAGE - 12) * 32 / 255) - 23;
var STORES = { playlists: 1, channels: 1, sources: 1, epgch: 1, prog: 1, map: 1, settings: 1 };
var data = {};
var loaded = false, loading = false, waiters = [];
var writing = false, jobs = [];
var serial = 1;
var templateBytes = null;
// Индекс по (источник XMLTV, id канала), строится лениво при чтении гида.
var progIndex = null;

function error(msg) { var e = new Error(msg); e.code = 'EINVAL'; return e; }
function valid(store) { return Object.prototype.hasOwnProperty.call(STORES, store); }
function b32(buf, off, n) { buf.writeUInt32BE(n >>> 0, off); }
function b16(buf, off, n) { buf.writeUInt16BE(n, off); }
function varint(n) {
  if (n < 0 || n > 9007199254740991) throw error('varint out of range');
  var a = [n % 128]; n = Math.floor(n / 128);
  while (n) { a.unshift((n % 128) | 128); n = Math.floor(n / 128); }
  return new Buffer(a);
}
function readVar(buf, at) {
  var v = 0, i = 0, b;
  while (i < 9) {
    b = buf[at + i]; if (b === undefined) throw error('truncated varint');
    v = v * 128 + (b & 127); i++;
    if (!(b & 128)) return { n: v, size: i };
  }
  throw error('large varint');
}
function encodeRecord(record) {
  var strs = [record.s, JSON.stringify(record.k), JSON.stringify(record.v)];
  var bytes = [], codes = [], i, h, size, old;
  for (i = 0; i < strs.length; i++) {
    bytes.push(new Buffer(strs[i], 'utf8'));
    codes.push(varint(13 + 2 * bytes[i].length));
  }
  size = codes[0].length + codes[1].length + codes[2].length + 1;
  do { old = size; size = codes[0].length + codes[1].length + codes[2].length + varint(size).length; } while (size !== old);
  h = [varint(size)].concat(codes).concat(bytes);
  return Buffer.concat(h);
}
function decodeRecord(buf) {
  var head = readVar(buf, 0), offset = head.size, vals = [], i;
  var serials = [];
  for (i = 0; i < 3; i++) {
    var code = readVar(buf, offset); serials.push(code.n); offset += code.size;
  }
  offset = head.n;
  for (i = 0; i < serials.length; i++) {
    var st = serials[i];
    if (st < 13 || st % 2 === 0) throw error('unexpected sqlite field format');
    var len = (st - 13) / 2;
    if (offset + len > buf.length) throw error('truncated sqlite text');
    vals.push(buf.toString('utf8', offset, offset + len)); offset += len;
  }
  return { s: vals[0], k: JSON.parse(vals[1]), v: JSON.parse(vals[2]) };
}
function localSize(n) {
  if (n <= X) return n;
  var k = M + (n - M) % (PAGE - 4);
  return k > X ? M : k;
}
function makeBuffer() { var b = new Buffer(PAGE); b.fill(0); return b; }
function renderLeaf(page, cells) {
  var offset = PAGE, i, cell;
  page[0] = 13; b16(page, 1, 0); b16(page, 3, cells.length); page[7] = 0;
  for (i = 0; i < cells.length; i++) {
    cell = cells[i]; offset -= cell.length;
    if (offset < 8 + cells.length * 2) throw error('sqlite leaf page full');
    cell.copy(page, offset); b16(page, 8 + i * 2, offset);
  }
  b16(page, 5, offset);
}
function renderInterior(page, children) {
  var offset = PAGE, i, cell;
  page[0] = 5; b16(page, 1, 0); b16(page, 3, children.length - 1); page[7] = 0;
  b32(page, 8, children[children.length - 1].page);
  for (i = 0; i < children.length - 1; i++) {
    cell = Buffer.concat([uint32(children[i].page), varint(children[i].max)]);
    offset -= cell.length;
    if (offset < 12 + (children.length - 1) * 2) throw error('sqlite interior full');
    cell.copy(page, offset); b16(page, 12 + i * 2, offset);
  }
  b16(page, 5, offset);
}
function uint32(n) { var b = new Buffer(4); b32(b, 0, n); return b; }
function encodeSqlite(records, cb) {
  if (!templateBytes) throw error('SQLite template is not loaded');
  var pages = [null, new Buffer(templateBytes.slice(0, PAGE)), makeBuffer()];
  var leaves = [], leaf = { cells: [], used: 8, max: 0 };
  function alloc() { pages.push(makeBuffer()); return pages.length - 1; }
  var i, rowid, payload, here, cell, extra, k, next, num, p, at, min;
  i = 0;
  function step() {
    var limit = cb ? Math.min(i + 100, records.length) : records.length;
    for (; i < limit; i++) {
    rowid = i + 1;
    payload = encodeRecord(records[i]);
    k = localSize(payload.length);
    here = [varint(payload.length), varint(rowid), payload.slice(0, k)];
    if (k < payload.length) {
      extra = []; at = k;
      while (at < payload.length) {
        num = alloc(); extra.push(num); at += PAGE - 4;
      }
      at = k;
      for (p = 0; p < extra.length; p++) {
        next = p + 1 < extra.length ? extra[p + 1] : 0;
        b32(pages[extra[p]], 0, next);
        min = Math.min(PAGE - 4, payload.length - at);
        payload.copy(pages[extra[p]], 4, at, at + min);
        at += min;
      }
      here.push(uint32(extra[0]));
    }
    cell = Buffer.concat(here);
    if (leaf.cells.length && leaf.used + cell.length + 2 > PAGE) {
      leaves.push(leaf); leaf = { cells: [], used: 8, max: 0 };
    }
    if (leaf.used + cell.length + 2 > PAGE) throw error('sqlite cell exceeds local page');
    leaf.cells.push(cell); leaf.used += cell.length + 2; leaf.max = rowid;
    }
    // Не блокируем JS-сервис многосекундной сериализацией EPG: отдаём
    // управление Node после каждого маленького блока страниц SQLite.
    if (i < records.length) { setImmediate(run); return null; }
  leaves.push(leaf);
  if (leaves.length === 1) renderLeaf(pages[2], leaves[0].cells);
  else {
    var children = [];
    for (i = 0; i < leaves.length; i++) {
      num = alloc(); renderLeaf(pages[num], leaves[i].cells);
      children.push({ page: num, max: leaves[i].max });
    }
    while (children.length > 130) {
      var upper = [];
      for (i = 0; i < children.length; i += 130) {
        var chunk = children.slice(i, i + 130);
        num = alloc(); renderInterior(pages[num], chunk);
        upper.push({ page: num, max: chunk[chunk.length - 1].max });
      }
      children = upper;
    }
    renderInterior(pages[2], children);
  }
  var head = pages[1];
  b32(head, 24, serial); b32(head, 28, pages.length - 1);
  b32(head, 92, serial);
  return Buffer.concat(pages.slice(1));
  }
  function run() {
    var result;
    try { result = step(); } catch (e) { return cb(e); }
    if (result) cb(null, result);
  }
  if (cb) { setImmediate(run); return; }
  return step();
}
function parseSqlite(buffer) {
  if (buffer.toString('ascii', 0, 16) !== 'SQLite format 3\u0000') throw error('not sqlite3 database');
  if (buffer.readUInt16BE(16) !== PAGE || buffer.length % PAGE) throw error('invalid sqlite page size');
  var seen = {}, records = [];
  function page(n) {
    if (n < 2 || n * PAGE > buffer.length) throw error('sqlite page out of bounds');
    return buffer.slice((n - 1) * PAGE, n * PAGE);
  }
  function overflow(n, count) {
    var chunks = [], total = 0, seenOver = {};
    while (n && total < count) {
      if (seenOver[n]) throw error('sqlite overflow loop');
      seenOver[n] = true;
      var p = page(n), len = Math.min(PAGE - 4, count - total);
      chunks.push(p.slice(4, 4 + len)); total += len;
      n = p.readUInt32BE(0);
    }
    if (total !== count) throw error('sqlite truncated overflow');
    return Buffer.concat(chunks);
  }
  function walk(n) {
    if (seen[n]) throw error('sqlite btree loop'); seen[n] = true;
    var p = page(n), typ = p[0], count = p.readUInt16BE(3), i, off, off2, sz, key, l, tail, content;
    if (typ === 5) {
      for (i = 0; i < count; i++) { off = p.readUInt16BE(12 + i * 2); walk(p.readUInt32BE(off)); }
      walk(p.readUInt32BE(8));
    } else if (typ === 13) {
      for (i = 0; i < count; i++) {
        off = p.readUInt16BE(8 + i * 2);
        sz = readVar(p, off); off2 = off + sz.size;
        key = readVar(p, off2); off2 += key.size;
        l = localSize(sz.n);
        content = p.slice(off2, off2 + l);
        if (l < sz.n) {
          tail = p.readUInt32BE(off2 + l);
          content = Buffer.concat([content, overflow(tail, sz.n - l)]);
        }
        records.push(decodeRecord(content));
      }
    } else throw error('unknown sqlite btree page ' + typ);
  }
  walk(2);
  return records;
}
function id(store, key) { return JSON.stringify([store, key]); }
function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    var i; for (i = 0; i < a.length && i < b.length; i++) { var c = compare(a[i], b[i]); if (c) return c; }
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
function mkdir(pathname, cb) { fs.mkdir(pathname, function (e) { cb(!e || e.code === 'EEXIST' ? null : e); }); }
function ensure(cb) {
  mkdir('/media', function () {
    // На телевизоре /media уже существует. В тестах ROOT — отдельный каталог.
    var segments = ROOT.split(path.sep), i = ROOT.charAt(0) === '/' ? 1 : 0, cur = ROOT.charAt(0) === '/' ? '/' : '';
    function next(err) {
      if (err || i >= segments.length) return cb(err || null);
      cur = path.join(cur, segments[i++]); if (!cur || cur === '.') return next();
      mkdir(cur, next);
    }
    next();
  });
}
function init(cb) {
  if (loaded) return cb(null);
  waiters.push(cb);
  if (loading) return;
  loading = true;
  fs.readFile(TEMPLATE, function (terr, tpl) {
    if (terr) return finish(terr);
    templateBytes = tpl;
    fs.readFile(DB_PATH, function (err, b) {
      if (err && err.code !== 'ENOENT') return finish(err);
      try {
        var rows = err ? [] : parseSqlite(b), m = {}, i;
        for (i = 0; i < rows.length; i++) m[id(rows[i].s, rows[i].k)] = rows[i];
        data = m; progIndex = null; loaded = true; finish(null);
      } catch (ex) { finish(ex); }
    });
  });
  function finish(err) {
    loading = false;
    var w = waiters; waiters = [];
    for (var i = 0; i < w.length; i++) w[i](err || null);
  }
}
function persist(snapshot, cb) {
  ensure(function (e) {
    if (e) return cb(e);
    var records;
    try { records = Object.keys(snapshot).sort().map(function (k) { return snapshot[k]; }); }
    catch (ex) { return cb(ex); }
    encodeSqlite(records, function (encodeErr, buf) {
      if (encodeErr) return cb(encodeErr);
      var tmp = DB_PATH + '.' + process.pid + '.tmp';
      fs.writeFile(tmp, buf, function (err) {
        if (err) return cb(err);
        fs.rename(tmp, DB_PATH, function (re) {
          if (re) fs.unlink(tmp, function () { cb(re); });
          else cb(null);
        });
      });
    });
  });
}
function write(job, cb) {
  jobs.push({ job: job, cb: cb });
  drain();
}
function drain() {
  if (writing || !jobs.length) return;
  writing = true;
  var batch = jobs.splice(0, jobs.length), copy = {}, k;
  for (k in data) if (Object.prototype.hasOwnProperty.call(data, k)) copy[k] = data[k];
  var e = null;
  try { for (var i = 0; i < batch.length; i++) batch[i].job(copy); }
  catch (ex) { e = ex; }
  if (e) return finished(e);
  serial++;
  persist(copy, function (err) { if (!err) { data = copy; progIndex = null; } finished(err); });
  function finished(err) {
    writing = false;
    for (var j = 0; j < batch.length; j++) batch[j].cb(err || null);
    drain();
  }
}
function progRecords(source, channel) {
  if (!progIndex) {
    progIndex = {};
    for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) {
      var rec = data[k];
      if (rec.s !== 'prog' || !Array.isArray(rec.k) || rec.k.length < 2) continue;
      var key = JSON.stringify([rec.k[0], rec.k[1]]);
      if (!progIndex[key]) progIndex[key] = [];
      progIndex[key].push(rec);
    }
  }
  return progIndex[JSON.stringify([source, channel])] || [];
}
function dispatch(op, q, cb) {
  init(function (err) {
    if (err) return cb(err);
    // Frequently changing history and preferences live in their own SQLite3
    // file. This prevents a full EPG database rewrite for every channel switch.
    if (op === 'status' || op === 'reset' || q.store === 'settings') {
      if (!settingsDb) settingsDb = require('./sqlite-settings.js')(ROOT,
        { encode: encodeSqlite, parse: parseSqlite }, ensure);
      var legacy = [];
      for (var oldKey in data) if (Object.prototype.hasOwnProperty.call(data, oldKey) && data[oldKey].s === 'settings')
        legacy.push(data[oldKey]);
      return settingsDb.init(legacy, function (settingsErr) {
        if (settingsErr) return cb(settingsErr);
        if (op === 'status') return cb(null, { backend: 'SQLite3', path: DB_PATH,
          settingsPath: settingsDb.path, stores: Object.keys(STORES),
          entries: Object.keys(data).length + settingsDb.count() - legacy.length });
        if (op === 'reset') return write(function (s) {
          for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) delete s[k];
        }, function (clearErr) {
          if (clearErr) return cb(clearErr);
          settingsDb.reset(function (stateErr) { cb(stateErr, { ok: !stateErr }); });
        });
        return settingsDb.dispatch(op, q, cb);
      });
    }
    var store = q.store, items, records, keys, offset, max, range;
    // EPG service commits related records together, avoiding a full SQLite rewrite
    // for each channel or programme pack. Never expose arbitrary SQL.
    if (op === 'epgBatch') {
      var groups = q.groups || {}, count = 0, g, rows, j, row;
      try {
        for (g in groups) if (Object.prototype.hasOwnProperty.call(groups, g)) {
          if (!valid(g) || g === 'settings' || g === 'playlists' || g === 'channels' || !Array.isArray(groups[g])) throw error('invalid epg store');
          rows = groups[g]; count += rows.length;
          if (count > 3000) throw error('EPG batch too large');
          for (j = 0; j < rows.length; j++) {
            row = rows[j];
            if (!row || row.key === undefined || row.value === undefined) throw error('invalid EPG record');
          }
        }
        if (q.prune && (typeof q.prune.url !== 'string' || typeof q.prune.loadId !== 'number'))
          throw error('invalid EPG pruning');
      } catch (e) { return cb(e); }
      return write(function (snap) {
        for (g in groups) if (Object.prototype.hasOwnProperty.call(groups, g)) {
          rows = groups[g];
          for (j = 0; j < rows.length; j++) {
            row = rows[j];
            snap[id(g, row.key)] = { s: g, k: row.key, v: row.value };
          }
        }
        if (q.prune) {
          for (var k in snap) if (Object.prototype.hasOwnProperty.call(snap, k)) {
            var rec = snap[k];
            if (rec.s === 'prog' && Array.isArray(rec.k) && rec.k[0] === q.prune.url &&
                rec.k[2] !== q.prune.loadId) delete snap[k];
          }
        }
      }, function (e) { cb(e, { written: count }); });
    }
    if (!valid(store)) return cb(error('invalid sqlite store'));
    if (op === 'get') {
      var r = data[id(store, q.key)];
      return cb(null, { record: r ? { key: r.k, value: r.v } : null });
    }
    if (op === 'list') {
      range = q.range || null;
      records = [];
      var candidates = null;
      // Репозиторий запрашивает передачи одного канала по [source, channel].
      // Не нужно линейно обходить все передачи из большой базы при зеппинге.
      if (store === 'prog' && range && Array.isArray(range.lower) && range.lower.length === 2 &&
          Array.isArray(range.upper) && range.upper.length === 3 &&
          range.lower[0] === range.upper[0] && range.lower[1] === range.upper[1])
        candidates = progRecords(range.lower[0], range.lower[1]);
      if (candidates) {
        for (var i = 0; i < candidates.length; i++)
          if (inRange(candidates[i].k, range)) records.push({ key: candidates[i].k, value: candidates[i].v });
      } else {
        for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k) && data[k].s === store && inRange(data[k].k, range))
          records.push({ key: data[k].k, value: data[k].v });
      }
      records.sort(function (a, b) { return compare(a.key, b.key); });
      offset = Math.max(0, parseInt(q.offset, 10) || 0);
      max = Math.min(250, Math.max(1, parseInt(q.limit, 10) || 80));
      // Ответ по WebSocket ограничиваем примерно 450 КБ, чтобы не раздувать память браузера.
      var selected = [], size = 0, end = offset;
      while (end < records.length && selected.length < max) {
        var row = records[end], estimate = JSON.stringify(row).length;
        if (selected.length && size + estimate > 430000) break;
        selected.push(row); size += estimate; end++;
      }
      return cb(null, { records: selected, next: end < records.length ? end : null });
    }
    if (op === 'put') {
      items = q.items;
      if (!Array.isArray(items) || items.length > 100) return cb(error('invalid sqlite batch'));
      return write(function (snap) {
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (!item || item.key === undefined || item.value === undefined) throw error('invalid sqlite record');
          snap[id(store, item.key)] = { s: store, k: item.key, v: item.value };
        }
      }, function (e) { cb(e, { written: items.length }); });
    }
    if (op === 'delete' || op === 'deleteRange') {
      keys = q.keys;
      if (op === 'delete' && !Array.isArray(keys)) return cb(error('invalid sqlite keys'));
      return write(function (snap) {
        if (op === 'delete') { for (var i = 0; i < keys.length; i++) delete snap[id(store, keys[i])]; }
        else for (var k in snap) if (Object.prototype.hasOwnProperty.call(snap, k) && snap[k].s === store && inRange(snap[k].k, q.range || null)) delete snap[k];
      }, function (e) { cb(e, { removed: true }); });
    }
    cb(error('unknown sqlite operation'));
  });
}
module.exports = { dispatch: dispatch, encodeSqlite: encodeSqlite, parseSqlite: parseSqlite, valid: valid, path: DB_PATH };
