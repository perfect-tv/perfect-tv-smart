/*
 * Запуск разбора программы: в дочернем процессе (epg-child.js), а если его не запустить
 * (запрещено системой, процесс упал до готовности) — в этом же процессе (epgservice.js).
 * Состояние задач дочернего процесса зеркалится здесь для epgStatus.
 * Код — ES5 (Node 0.12).
 */
'use strict';
var path = require('path');
var kv = require('./filekv.js');
var epg = require('./epgservice.js');

var child = null;
var childOk = false;
var childFailed = false;
var pendingStarts = {};
var startSeq = 0;
var mirror = {};          // jobId → состояние
var queue = [];           // запуски до готовности дочернего процесса

function spawn() {
  if (child || childFailed) return;
  var cp;
  try {
    cp = require('child_process').fork(path.join(__dirname, 'epg-child.js'), [], { silent: false });
  } catch (e) {
    console.warn('EPG child: fork failed', e && e.message);
    childFailed = true;
    return;
  }
  child = cp;
  lowerPriority(cp.pid);
  var readyTimer = setTimeout(function () {
    if (!childOk) { console.warn('EPG child: no ready'); fail(); }
  }, 10000);
  cp.on('message', function (m) {
    if (!m) return;
    if (m.type === 'ready') {
      childOk = true;
      clearTimeout(readyTimer);
      console.log('EPG child ready, pid', cp.pid);
      var q = queue; queue = [];
      for (var i = 0; i < q.length; i++) q[i]();
      return;
    }
    if (m.type === 'kv') {
      kv.dispatch(m.op, m.q, function (err, result) {
        if (child === cp) cp.send({ type: 'kvres', rid: m.rid, error: err ? err.message || String(err) : '', result: result || null });
      });
      return;
    }
    if (m.type === 'started') {
      var p = pendingStarts[m.reqId];
      delete pendingStarts[m.reqId];
      if (m.state) mirror[m.state.jobId] = m.state;
      if (p) p(m.error ? new Error(m.error) : null, m.state);
      return;
    }
    if (m.type === 'state' && m.state) mirror[m.state.jobId] = m.state;
  });
  cp.on('exit', function (code) {
    console.warn('EPG child exit', code);
    clearTimeout(readyTimer);
    if (child === cp) fail();
  });
  cp.on('error', function (e) { console.warn('EPG child error', e && e.message); if (child === cp) fail(); });
}

/**
 * Разбор программы — с пониженным приоритетом (nice 10): большая программа (iptvx.one — 98 МБ gz)
 * разбирается минутами, и всё это время прокси этого же сервиса (поток с заголовками канала идёт
 * через него) и плеер получали меньше процессора — запуск канала на слабом ТВ 2–3 с вместо 1,5–2.
 * В Node 0.12 нет os.setPriority — renice (util-linux на webOS); нет его — работаем как есть.
 */
var NICE = 10;
function lowerPriority(pid) {
  if (!pid) return;
  var bins = ['renice', '/usr/bin/renice', '/bin/renice'];
  (function next(i) {
    if (i >= bins.length) { console.warn('EPG child: renice unavailable'); return; }
    try {
      require('child_process').execFile(bins[i], ['-n', String(NICE), '-p', String(pid)], { timeout: 5000 }, function (err) {
        if (err && err.code === 'ENOENT') return next(i + 1);
        if (err) console.warn('EPG child: renice failed', err.message);
        else console.log('EPG child: nice', NICE, 'pid', pid);
      });
    } catch (e) { next(i + 1); }
  })(0);
}

/** Дочерний процесс недоступен: незавершённые задачи — с ошибкой, дальше — в этом процессе */
function fail() {
  var cp = child;
  child = null;
  childOk = false;
  childFailed = true;
  try { if (cp) cp.kill(); } catch (e) { /* */ }
  for (var id in mirror) if (!mirror[id].done) { mirror[id].done = true; mirror[id].phase = 'done'; mirror[id].error = 'EPG child stopped'; }
  for (var r in pendingStarts) { var p = pendingStarts[r]; delete pendingStarts[r]; p(new Error('EPG child stopped')); }
  var q = queue; queue = [];
  for (var i = 0; i < q.length; i++) q[i]();
}

function start(q, cb) {
  if (childFailed) return epg.dispatch('epgStart', q, cb);
  spawn();
  if (childFailed) return epg.dispatch('epgStart', q, cb);
  var run = function () {
    if (!childOk) return epg.dispatch('epgStart', q, cb);
    var reqId = ++startSeq;
    pendingStarts[reqId] = cb;
    child.send({ type: 'start', reqId: reqId, q: q });
  };
  if (childOk) run(); else queue.push(run);
}

function status(q, cb) {
  if (!childFailed || mirror[q.jobId]) {
    var st = mirror[q.jobId];
    if (st) return cb(null, st);
  }
  epg.dispatch('epgStatus', q, cb);
}

function dispatch(op, q, cb) {
  if (op === 'epgStart') return start(q, cb);
  if (op === 'epgStatus') return status(q, cb);
  // сопоставление каналов — быстрое, здесь же
  return epg.dispatch(op, q, cb);
}

module.exports = { dispatch: dispatch };
