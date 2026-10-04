/*
 * Small independent SQLite3 database for frequently changing settings.
 * The existing large perfecttv.sqlite3 (EPG and channel data) is not rewritten
 * when the channel, favourites or viewing history change.
 * ES5 / Node 0.12. Settings are migrated once from the legacy SQLite3 file.
 */
'use strict';
var fs = require('fs');
var path = require('path');
module.exports = function (root, codec, ensure) {
  var file = path.join(root, 'perfecttv-settings.sqlite3');
  var loaded = false, loading = false, waiters = [];
  var rows = {}, writing = false, jobs = [];
  function id(key) { return JSON.stringify(['settings', key]); }
  function count() { return Object.keys(rows).length; }
  function persist(next, cb) {
    ensure(function (err) {
      if (err) return cb(err);
      var buf;
      try { buf = codec.encode(Object.keys(next).sort().map(function (k) { return next[k]; })); }
      catch (e) { return cb(e); }
      var tmp = file + '.' + process.pid + '.tmp';
      fs.writeFile(tmp, buf, function (writeErr) {
        if (writeErr) return cb(writeErr);
        fs.rename(tmp, file, function (renameErr) {
          if (renameErr) return fs.unlink(tmp, function () { cb(renameErr); });
          cb(null);
        });
      });
    });
  }
  function init(legacy, cb) {
    if (loaded) return cb(null);
    waiters.push(cb);
    if (loading) return;
    loading = true;
    fs.readFile(file, function (err, buf) {
      var next = {};
      if (err && err.code !== 'ENOENT') return finish(err);
      if (err) {
        // The old SQLite file remains unchanged, until the new one is durable.
        for (var i = 0; i < legacy.length; i++) {
          var r = legacy[i];
          if (r.s === 'settings') next[id(r.k)] = r;
        }
        return persist(next, function (e) { if (!e) rows = next; finish(e); });
      }
      try {
        var parsed = codec.parse(buf);
        for (var j = 0; j < parsed.length; j++) {
          var record = parsed[j];
          if (record.s !== 'settings' || typeof record.k !== 'string') throw new Error('invalid settings SQLite row');
          next[id(record.k)] = record;
        }
        rows = next;
        finish(null);
      } catch (ex) { finish(ex); }
    });
    function finish(err) {
      loaded = !err;
      loading = false;
      var w = waiters; waiters = [];
      for (var i = 0; i < w.length; i++) w[i](err || null);
    }
  }
  function drain() {
    if (writing || !jobs.length) return;
    writing = true;
    var batch = jobs.splice(0, jobs.length);
    var copy = {}, key, error = null;
    for (key in rows) if (Object.prototype.hasOwnProperty.call(rows, key)) copy[key] = rows[key];
    try { for (var i = 0; i < batch.length; i++) batch[i].job(copy); }
    catch (ex) { error = ex; }
    if (error) return done(error);
    persist(copy, function (err) { if (!err) rows = copy; done(err); });
    function done(err) {
      writing = false;
      for (var j = 0; j < batch.length; j++) batch[j].cb(err || null);
      drain();
    }
  }
  function write(fn, cb) { jobs.push({ job: fn, cb: cb }); drain(); }
  function dispatch(op, q, cb) {
    var key, k, r, list, range, limit, offset, end, selected, bytes;
    if (op === 'get') {
      r = rows[id(q.key)];
      return cb(null, { record: r ? { key: r.k, value: r.v } : null });
    }
    if (op === 'list') {
      range = q.range || null;
      list = [];
      for (k in rows) if (Object.prototype.hasOwnProperty.call(rows, k)) {
        r = rows[k];
        if (range && (range.lower !== undefined && r.k < range.lower ||
          range.upper !== undefined && r.k > range.upper)) continue;
        list.push({ key: r.k, value: r.v });
      }
      list.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
      offset = Math.max(0, parseInt(q.offset, 10) || 0);
      limit = Math.min(250, Math.max(1, parseInt(q.limit, 10) || 80));
      selected = []; bytes = 0; end = offset;
      while (end < list.length && selected.length < limit) {
        r = list[end]; var estimate = JSON.stringify(r).length;
        if (selected.length && bytes + estimate > 430000) break;
        selected.push(r); bytes += estimate; end++;
      }
      return cb(null, { records: selected, next: end < list.length ? end : null });
    }
    if (op === 'put') {
      if (!Array.isArray(q.items) || q.items.length > 100) return cb(new Error('invalid settings batch'));
      return write(function (next) {
        for (var i = 0; i < q.items.length; i++) {
          var rec = q.items[i];
          if (!rec || typeof rec.key !== 'string' || rec.value === undefined) throw new Error('invalid settings record');
          next[id(rec.key)] = { s: 'settings', k: rec.key, v: rec.value };
        }
      }, function (err) { cb(err, { written: q.items.length }); });
    }
    if (op === 'delete' || op === 'deleteRange') {
      if (op === 'delete' && !Array.isArray(q.keys)) return cb(new Error('invalid settings delete'));
      return write(function (next) {
        if (op === 'delete') {
          for (var i = 0; i < q.keys.length; i++) delete next[id(q.keys[i])];
        } else {
          for (var k in next) if (Object.prototype.hasOwnProperty.call(next, k)) {
            var name = next[k].k, range = q.range || null;
            if (!range || (range.lower === undefined || name >= range.lower) &&
              (range.upper === undefined || name <= range.upper)) delete next[k];
          }
        }
      }, function (err) { cb(err, { removed: true }); });
    }
    cb(new Error('unknown settings operation'));
  }
  return { init: init, dispatch: dispatch, reset: function (cb) {
    write(function (next) { for (var k in next) if (Object.prototype.hasOwnProperty.call(next, k)) delete next[k]; }, cb);
  }, count: count, path: file };
};
