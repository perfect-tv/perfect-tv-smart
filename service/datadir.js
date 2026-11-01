/*
 * Папка данных сервиса: первая, куда процесс сервиса действительно может писать.
 * webOS 4+ — /media/internal/perfecttv-data; на webOS 3 у JS-сервиса прав на /media/internal нет
 * (EACCES) — тогда /media/developer/perfecttv-data (открыта на запись всем, переживает
 * переустановку приложения), дальше домашняя папка, папка сервиса и /tmp (до перезагрузки ТВ).
 * Код — ES5 (Node 0.12).
 */
'use strict';
var fs = require('fs');
var path = require('path');

function mkdirpSync(dir) {
  try { fs.mkdirSync(dir); return; } catch (e) {
    if (e.code === 'EEXIST') return;
    if (e.code !== 'ENOENT') throw e;
  }
  mkdirpSync(path.dirname(dir));
  try { fs.mkdirSync(dir); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
}

function writable(dir) {
  try {
    mkdirpSync(dir);
    var probe = path.join(dir, '.probe-' + process.pid);
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch (e) { return false; }
}

var candidates = [];
if (process.env.PERFECTTV_DATA_DIR) candidates.push(process.env.PERFECTTV_DATA_DIR);
candidates.push('/media/internal/perfecttv-data', '/media/developer/perfecttv-data');
if (process.env.HOME) candidates.push(path.join(process.env.HOME, 'perfecttv-data'));
candidates.push(path.join(__dirname, 'data'), '/tmp/perfecttv-data');

var ROOT = null;
for (var i = 0; i < candidates.length && !ROOT; i++) if (writable(candidates[i])) ROOT = candidates[i];
if (!ROOT) ROOT = candidates[0];
if (ROOT !== candidates[0]) console.warn('perfecttv data dir:', ROOT, '(not writable:', candidates.slice(0, candidates.indexOf(ROOT)).join(', ') + ')');

module.exports = ROOT;
