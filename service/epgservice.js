/* Server-side XMLTV ingestion for legacy webOS Node.js 0.12 (ES5).
 * The parser and channel matcher are compiled from the exact browser TypeScript
 * implementations; only streaming HTTP/gzip and SQLite commits live here.
 * The UI requests a job over WebSocket and polls its small progress status.
 */
'use strict';
var BufferClass = Buffer;
var zlib = require('zlib');
var proxy = require('./proxy.js');
// хранилище: в сервисе — файлы (filekv.js); в дочернем процессе разбора — запросы к родителю (epg-child.js)
var backend = null;
var sqlite = { dispatch: function (op, q, cb) { (backend || (backend = require('./filekv.js'))).dispatch(op, q, cb); } };
function setBackend(b) { backend = b; }
var jobs = {};
var activeUrl = '';
var seq = 0;

// TextDecoder does not exist in Node 0.12. decode() is called on complete
// XML tags, not arbitrary half-decoded UTF-8 strings.
if (typeof global.TextDecoder === 'undefined') {
  var cp1251 = [
    0x0402,0x0403,0x201a,0x0453,0x201e,0x2026,0x2020,0x2021,
    0x20ac,0x2030,0x0409,0x2039,0x040a,0x040c,0x040b,0x040f,
    0x0452,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,
    0xfffd,0x2122,0x0459,0x203a,0x045a,0x045c,0x045b,0x045f,
    0x00a0,0x040e,0x045e,0x0408,0x00a4,0x0490,0x00a6,0x00a7,
    0x0401,0x00a9,0x0404,0x00ab,0x00ac,0x00ad,0x00ae,0x0407,
    0x00b0,0x00b1,0x0406,0x0456,0x0491,0x00b5,0x00b6,0x00b7,
    0x0451,0x2116,0x0454,0x00bb,0x0458,0x0405,0x0455,0x0457
  ];
  global.TextDecoder = function (encoding) {
    this.encoding = String(encoding || 'utf-8').toLowerCase();
  };
  global.TextDecoder.prototype.decode = function (bytes) {
    var b = BufferClass.isBuffer(bytes) ? bytes : new BufferClass(bytes || []);
    if (this.encoding === 'windows-1251' || this.encoding === 'cp1251') {
      var s = '', i, v;
      for (i = 0; i < b.length; i++) {
        v = b[i]; s += String.fromCharCode(v < 128 ? v : v >= 192 ? v + 848 : cp1251[v - 128]);
      }
      return s;
    }
    var enc = this.encoding === 'iso-8859-1' ? 'latin1' : this.encoding;
    return b.toString(enc === 'utf-8' || enc === 'utf16le' || enc === 'utf-16le' || enc === 'latin1' ? enc : 'utf8');
  };
}
if (!Uint8Array.prototype.slice) {
  Uint8Array.prototype.slice = function (start, end) {
    var sub = this.subarray(start, end === undefined ? this.length : end);
    var copy = new Uint8Array(sub.length); copy.set(sub); return copy;
  };
}
var parserLib = require('./epg-parser.js');

function emptyMeta(url) {
  return { url: url, loadedAt: 0, loadId: 0, etag: '', lastModified: '', error: '', count: 0, status: 0 };
}
function now() { return Math.floor(Date.now() / 1000); }
function get(store, key, cb) {
  sqlite.dispatch('get', { store: store, key: key }, function (err, r) {
    cb(err, r && r.record ? r.record.value : null);
  });
}
function commit(groups, prune, cb) {
  sqlite.dispatch('epgBatch', { groups: groups, prune: prune || null }, cb);
}
function record(store, v) {
  if (store === 'epgch') return { key: [v.s, v.id], value: v };
  if (store === 'map') return { key: [v.pid, v.s], value: v };
  if (store === 'prog') return { key: [v.s, v.x, v.l, v.n], value: v };
  if (store === 'sources') return { key: v.url, value: v };
  throw new Error('bad EPG store');
}
function pack(program) {
  var json = JSON.stringify(program.p);
  var compressed = zlib.gzipSync(new BufferClass(json, 'utf8'), { level: 1 });
  return { s: program.s, x: program.x, l: program.l, n: program.n,
    codec: 'gzip-json-b64-1', data: compressed.toString('base64') };
}
function listChannels(url, cb) {
  var rows = [], offset = 0;
  function next() {
    sqlite.dispatch('list', { store: 'epgch', range: { lower: [url], upper: [url, []] },
      offset: offset, limit: 250 }, function (err, r) {
      if (err) return cb(err);
      var batch = r.records || [];
      for (var i = 0; i < batch.length; i++) rows.push(batch[i].value);
      if (r.next === null || r.next === undefined) cb(null, rows);
      else { offset = r.next; next(); }
    });
  }
  next();
}
function matching(channels, wanted, url) {
  var matcher = new parserLib.EpgMatcher(), icons = {}, result = [], i, j, c, match;
  for (i = 0; i < channels.length; i++) {
    c = channels[i]; matcher.addChannel(c);
    if (c.icon) icons[c.id] = c.icon;
  }
  var selected = {};
  for (i = 0; i < wanted.length; i++) {
    var map = {}, list = wanted[i].channels || [];
    for (j = 0; j < list.length; j++) {
      c = list[j]; match = matcher.match(c.tvgId || '', c.tvgName || '', c.name || '');
      if (match !== null) { map[c.key] = [match, icons[match] || '']; selected[match] = true; }
    }
    result.push({ pid: wanted[i].pid, s: url, m: map });
  }
  return { maps: result, selected: selected };
}
function rematch(url, wanted, cb) {
  listChannels(url, function (err, channels) {
    if (err) return cb(err);
    if (!channels.length) return cb(null, { mapped: 0 });
    var maps = matching(channels, wanted, url).maps;
    commit({ map: maps.map(function (m) { return record('map', m); }) }, null, function (e) {
      cb(e, { mapped: maps.length });
    });
  });
}
function publicState(job) {
  return { jobId: job.id, phase: job.phase, done: job.done, read: job.read,
    total: job.total, programmes: job.programmes, revision: job.revision,
    error: job.error, meta: job.done ? job.meta : null };
}
function start(q, cb) {
  var url = String(q.url || '');
  if (!/^https?:\/\//i.test(url) || url.length > 4096 || !Array.isArray(q.wanted) || q.wanted.length > 100)
    return cb(new Error('invalid EPG request'));
  if (activeUrl) {
    if (activeUrl === url) {
      for (var k in jobs) if (jobs[k].url === url && !jobs[k].done) return cb(null, publicState(jobs[k]));
    }
    return cb(new Error('EPG busy'));
  }
  var totalWanted = 0;
  for (var i = 0; i < q.wanted.length; i++) totalWanted += (q.wanted[i].channels || []).length;
  if (totalWanted > 60000) return cb(new Error('too many EPG channels'));
  var id = ++seq;
  var job = { id: id, url: url, done: false, phase: 'starting', read: 0, total: 0,
    programmes: 0, revision: 0, error: '', meta: null };
  jobs[id] = job;
  activeUrl = url;
  cb(null, publicState(job));
  setImmediate(function () { execute(job, q); });
}
function status(q, cb) {
  var job = jobs[q.jobId];
  if (!job) return cb(new Error('EPG job not found'));
  cb(null, publicState(job));
}
function finish(job, meta, error) {
  job.phase = 'done'; job.done = true; job.meta = meta;
  job.error = error || '';
  activeUrl = '';
  var keys = Object.keys(jobs);
  if (keys.length > 8) {
    keys.sort(function (a, b) { return Number(a) - Number(b); });
    for (var i = 0; i < keys.length - 8; i++) delete jobs[keys[i]];
  }
}
function execute(job, q) {
  var url = job.url, initialClock = Date.now();
  var clientClock = typeof q.now === 'number' && q.now > 1000000000 ? q.now : 0;
  var loadId = Math.max(initialClock, Math.floor(clientClock * 1000));
  function currentTime() {
    return clientClock ? Math.floor(clientClock + (Date.now() - initialClock) / 1000) : now();
  }
  get('sources', url, function (err, saved) {
    var old = saved || emptyMeta(url);
    var meta = {};
    for (var k in old) if (Object.prototype.hasOwnProperty.call(old, k)) meta[k] = old[k];
    var done = false;
    if (err) return failed(err);
    function failed(e) {
      if (done) return; done = true;
      var code = /format|zip|xz/i.test(String(e.message || e)) ? 'format' : 'network';
      meta.status = 3; meta.error = code;
      console.warn('EPG service error', url, e && (e.stack || e.message || e));
      commit({ sources: [record('sources', meta)] }, null, function (dbErr) {
        finish(job, meta, String(dbErr || e));
      });
    }
    var headers = {};
    if (!q.force && old.etag) headers['If-None-Match'] = old.etag;
    if (!q.force && old.lastModified) headers['If-Modified-Since'] = old.lastModified;
    job.phase = 'network';
    proxy.request(url, headers, function (e, res) {
      if (e) return failed(e);
      if (res.statusCode === 304) {
        meta.status = 2; meta.loadedAt = currentTime(); meta.error = '';
        return rematch(url, q.wanted, function (mErr) {
          if (mErr) return failed(mErr);
          commit({ sources: [record('sources', meta)] }, null, function (dbErr) {
            if (dbErr) return failed(dbErr);
            done = true; finish(job, meta, null);
          });
        });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); return failed(new Error('HTTP ' + res.statusCode));
      }
      var etag = res.headers.etag || '', lm = res.headers['last-modified'] || '';
      job.total = res.headers['content-encoding'] ? 0 : (parseInt(res.headers['content-length'], 10) || 0);
      var channels = [], channelRows = [], packs = [], current = [], currentId = '';
      var countInQueue = 0, seqs = {}, total = 0;
      var selected = {}, maps = [], didMatch = false;
      var lo = currentTime() - (Math.max(0, q.maxArchiveDays || 7) + 1) * 86400;
      var hi = currentTime() + 8 * 86400;
      var inflater = null, xml = null, stopping = false, inflight = false;
      function rebuild() {
        var result = matching(channels, q.wanted, url);
        maps = result.maps; selected = result.selected; didMatch = true;
      }
      function flushCurrent() {
        if (!current.length) return;
        var n = seqs[currentId] || 0;
        seqs[currentId] = n + 1;
        var r = { s: url, x: currentId, l: loadId, n: n, p: current };
        packs.push(record('prog', pack(r)));
        current = [];
      }
      var parser;
      try {
        parser = new parserLib.XmltvParser(q.langs || ['ru', 'en'],
          function (c) {
            channels.push(c);
            channelRows.push(record('epgch', { s: url, id: c.id, names: c.names, icon: c.icon, l: loadId }));
          }, rebuild,
          function (id) { return selected[id] === true; },
          function (p) {
            if (p.stop < lo || p.start > hi) return;
            if (p.channel !== currentId) { flushCurrent(); currentId = p.channel; }
            current.push([p.start,p.stop,p.title,p.subTitle,p.desc,p.category,p.icon]);
            total++; countInQueue++;
            if (current.length >= 1500) flushCurrent();
          });
      } catch (ex) { res.resume(); return failed(ex); }
      function batch(final, callback) {
        if (final) flushCurrent();
        if (!channelRows.length && !packs.length && !final) return callback(null);
        var groups = {
          epgch: channelRows.splice(0, channelRows.length),
          prog: packs.splice(0, packs.length)
        };
        countInQueue = 0;
        if (final) {
          if (!didMatch) rebuild();
          groups.map = maps.map(function (m) { return record('map', m); });
          meta.status = 2; meta.loadedAt = currentTime(); meta.error = '';
          meta.etag = etag; meta.lastModified = lm; meta.loadId = loadId; meta.count = total;
          groups.sources = [record('sources', meta)];
        }
        if (!final) {
          commit(groups, null, function (batchErr) {
            if (!batchErr) job.revision++;
            callback(batchErr);
          });
          return;
        }
        // конец загрузки: дописать последнее, собрать каналы в .json.gz (их браузер распакует сам),
        // затем записать источник и удалить файлы прежней загрузки
        var sources = groups.sources;
        delete groups.sources;
        commit(groups, null, function (batchErr) {
          if (batchErr) return callback(batchErr);
          job.phase = 'packing';
          var fin = (backend && backend.finalize) || require('./progfiles.js').finalizeSource;
          // прошедшая программа прежней загрузки, которой нет в новой, остаётся — в окне архива (lo)
          fin(url, loadId, lo, function (finErr) {
            if (finErr) console.warn('EPG finalize', finErr && finErr.message);
            commit({ sources: sources }, { url: url, loadId: loadId }, function (srcErr) {
              if (!srcErr) job.revision++;
              callback(srcErr);
            });
          });
        });
      }
      function onDecoded(chunk) {
        if (stopping || done) return;
        try {
          parser.push(chunk);
          job.programmes = total;
        } catch (ex) { stopping = true; return failed(ex); }
        if (!inflight && (countInQueue >= 8000 || channelRows.length >= 700 || packs.length >= 500)) {
          inflight = true;
          if (xml) xml.pause();
          batch(false, function (dbErr) {
            inflight = false;
            if (dbErr) { stopping = true; failed(dbErr); }
            else if (xml) xml.resume();
          });
        }
      }
      function onComplete() {
        if (done || stopping) return;
        job.phase = 'saving';
        try { parser.end(); } catch (ex) { return failed(ex); }
        batch(true, function (dbErr) {
          if (dbErr) return failed(dbErr);
          done = true; job.programmes = total;
          console.log('EPG service complete', url, total, 'programmes', channels.length, 'channels');
          finish(job, meta, null);
        });
      }
      function route(input, initial, kind, skip) {
        if (done || stopping) return;
        if (kind === 'xz') return failed(new Error('format_xz'));
        var zipMethod = 8, storedLeft = -1;
        if (kind === 'zip') {
          if (initial.length < skip) return failed(new Error('invalid zip entry'));
          if (initial.readUInt16LE(6) & 1) return failed(new Error('encrypted ZIP not supported'));
          zipMethod = initial.readUInt16LE(8);
          if (zipMethod !== 8 && zipMethod !== 0) return failed(new Error('unsupported ZIP method'));
          if (zipMethod === 0 && !(initial.readUInt16LE(6) & 8))
            storedLeft = initial.readUInt32LE(22);
        }
        xml = kind === 'gzip' ? zlib.createGunzip() :
          kind === 'zip' && zipMethod === 8 ? zlib.createInflateRaw() : input;
        function consumeStored(chunk) {
          if (storedLeft < 0) return onDecoded(chunk);
          if (storedLeft > 0) {
            var take = Math.min(chunk.length, storedLeft);
            onDecoded(chunk.slice(0, take));
            storedLeft -= take;
          }
        }
        xml.on('data', kind === 'zip' && zipMethod === 0 ? consumeStored : onDecoded);
        xml.on('end', onComplete);
        xml.on('error', failed);
        job.phase = 'parsing';
        if (xml !== input) {
          xml.write(initial.slice(skip || 0));
          input.pipe(xml);
        } else {
          if (kind === 'zip' && zipMethod === 0) consumeStored(initial.slice(skip));
          else onDecoded(initial);
        }
        if (!inflight) input.resume();
      }
      // Read only a small header to detect .xml, .xml.gz, or .zip even if
      // the provider omitted Content-Encoding or used a misleading extension.
      var input = proxy.bodyOf(res), header = new BufferClass(0);
      input.on('error', failed);
      input.on('data', function (chunk) { job.read += chunk.length; });
      function detect(chunk) {
        if (done || stopping) return;
        header = BufferClass.concat([header, chunk]);
        if (header.length < 6) return;
        var kind = 'plain', skip = 0;
        if (header[0] === 31 && header[1] === 139) kind = 'gzip';
        else if (header[0] === 80 && header[1] === 75 && header[2] === 3 && header[3] === 4) {
          kind = 'zip';
          if (header.length < 30) return;
          skip = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
          if (header.length < skip) return;
        } else if (header[0] === 253 && header[1] === 55) kind = 'xz';
        input.pause();
        input.removeListener('data', detect);
        route(input, header, kind, skip);
      }
      input.on('data', detect);
      input.on('end', function () {
        if (!xml && !done) {
          input.removeListener('data', detect);
          if (!header.length) return failed(new Error('format_empty'));
          // Very small plain XML file.
          route(input, header, 'plain', 0);
          onComplete();
        }
      });
    });
  });
}
function dispatch(op, q, cb) {
  if (op === 'epgStart') return start(q, cb);
  if (op === 'epgStatus') return status(q, cb);
  if (op === 'epgRematch') {
    if (typeof q.url !== 'string' || !Array.isArray(q.wanted)) return cb(new Error('invalid rematch request'));
    return rematch(q.url, q.wanted, cb);
  }
  cb(new Error('unknown EPG operation'));
}
module.exports = { dispatch: dispatch, rematch: rematch, matching: matching, setBackend: setBackend };
