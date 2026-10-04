/*
 * Дочерний процесс разбора программы: скачивание, распаковка, разбор XMLTV — здесь, чтобы
 * основной процесс сервиса (прокси видео) не простаивал. Хранилище — у родителя: каждая
 * операция уходит ему сообщением и ждёт ответа (один писатель, кэш не расходится).
 * Код — ES5 (Node 0.12).
 */
'use strict';
var epg = require('./epgservice.js');
var seq = 0;
var waits = {};

epg.setBackend({
  dispatch: function (op, q, cb) {
    var rid = ++seq;
    waits[rid] = cb;
    process.send({ type: 'kv', rid: rid, op: op, q: q });
  }
});

var watched = {};

function report(jobId) {
  epg.dispatch('epgStatus', { jobId: jobId }, function (err, st) {
    if (err) return;
    process.send({ type: 'state', state: st });
    if (st.done) delete watched[jobId];
  });
}

setInterval(function () { for (var id in watched) report(Number(id)); }, 300);

process.on('message', function (m) {
  if (!m) return;
  if (m.type === 'kvres') {
    var cb = waits[m.rid];
    delete waits[m.rid];
    if (cb) cb(m.error ? new Error(m.error) : null, m.result);
    return;
  }
  if (m.type === 'start') {
    epg.dispatch('epgStart', m.q, function (err, st) {
      process.send({ type: 'started', reqId: m.reqId, error: err ? err.message || String(err) : '', state: st || null });
      if (!err && st) watched[st.jobId] = true;
    });
  }
});

// родитель (сервис) завершился — и мы тоже, без сирот
process.on('disconnect', function () { process.exit(0); });

process.send({ type: 'ready' });
