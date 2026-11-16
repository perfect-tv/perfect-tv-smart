import { Clock } from '../../core/clock';
import { EpgBackend } from '../../core/platform';
import { PROXY, WebosProxy } from './proxy';
import { SocketDb } from './socketdb';

/**
 * Программа на webOS — в JS-сервисе (service/epgservice.js): он сам качает, распаковывает и
 * разбирает XMLTV в дочернем процессе и хранит по суткам (.epg). По WebSocket идут только
 * ход загрузки и итог; передачи читаются по HTTP (/prog — одни сутки gzip-потоком, браузер ТВ
 * распаковывает сам; /progsearch — поиск). Нет HTTP — отказ, ядро читает из базы само.
 */
function getJson(path: string, timeout: number): Promise<any> {
  return new Promise<any>(function (resolve, reject) {
    if (!WebosProxy.available) { reject(new Error('no proxy')); return; }
    const r = new XMLHttpRequest();
    r.open('GET', PROXY + path, true);
    r.timeout = timeout;
    r.onload = function () {
      if (r.status !== 200) { reject(new Error(path.split('?')[0] + ' ' + r.status)); return; }
      try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
    };
    r.onerror = r.ontimeout = function () { reject(new Error(path.split('?')[0] + ' network')); };
    r.send();
  });
}

export const WebosEpg: EpgBackend = {
  load(url, wanted, maxArchiveDays, langs, force, onProgress, onPack) {
    return SocketDb.epgStart({ url: url, wanted: wanted, maxArchiveDays: maxArchiveDays,
      langs: langs, force: force, now: Clock.now() }).then(function (started) {
      const jobId: number = started.jobId;
      let revision = started.revision || 0;
      console.log('epg service start', url, jobId);
      return new Promise<any>(function (resolve, reject) {
        function poll() {
          SocketDb.epgStatus(jobId).then(function (state) {
            if (state.revision > revision) { revision = state.revision; onPack(); }
            onProgress(state.read || 0, state.total || 0, state.programmes || 0);
            if (state.done) {
              if (state.error) console.warn('epg service error', state.error);
              console.log('epg service complete', url, state.programmes || 0);
              resolve(state.meta || null);
              return;
            }
            setTimeout(poll, 1000);
          }, reject);
        }
        poll();
      });
    });
  },

  rematch(url, wanted) {
    return SocketDb.available().then(function (ok) {
      if (!ok) throw new Error('service unavailable');
      return SocketDb.epgRematch(url, wanted);
    });
  },

  packs(s, x, a, b) {
    return getJson('/prog?s=' + encodeURIComponent(s) + '&x=' + encodeURIComponent(x) + '&a=' + a + '&b=' + b, 15000);
  },

  days(s, x) {
    return getJson('/prog?days=1&s=' + encodeURIComponent(s) + '&x=' + encodeURIComponent(x), 15000).then(function (v) {
      return Array.isArray(v) ? v : null;
    }, function () { return null; });
  },

  search(words, items, max, cancelled) {
    return new Promise<any[]>(function (resolve, reject) {
      if (!WebosProxy.available) { reject(new Error('no proxy')); return; }
      const r = new XMLHttpRequest();
      r.open('POST', PROXY + '/progsearch', true);
      r.timeout = 60000;
      r.onload = function () {
        if (r.status !== 200) { reject(new Error('progsearch ' + r.status)); return; }
        try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
      };
      r.onerror = r.ontimeout = function () { reject(new Error('progsearch network')); };
      // text/plain — без предварительного OPTIONS
      r.setRequestHeader('Content-Type', 'text/plain');
      r.send(JSON.stringify({ w: words, c: items, max: max }));
      const poll = setInterval(function () { if (cancelled()) { clearInterval(poll); try { r.abort(); } catch (e) { /* */ } } }, 200);
      r.addEventListener('loadend', function () { clearInterval(poll); });
    });
  },
};
