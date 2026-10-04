import '../core/polyfills';
import { Clock } from '../core/clock';
import { Net } from '../core/net';
import { Prefs } from '../core/prefs';
import { Db } from '../data/db';
import { Loaders } from '../data/loaders';

/**
 * Воркер загрузки программы (§5): сеть, распаковка, разбор XMLTV и запись пачек
 * в SQLite3 по WebSocket — вне основного потока, чтобы гид и плеер не подтормаживали на слабых ТВ.
 *
 * Основной поток → воркер:
 *   {type:'ping'}                                    проверка: соединение с SQLite3 через WebSocket
 *   {type:'load', id, url, wanted, maxArchiveDays, langs, force, prefs, proxyOk, clock}
 * Воркер → основной поток:
 *   {type:'pong', ok, error}
 *   {type:'progress', id, read, total, programmes}
 *   {type:'pack', id}                                пачка записана — сбросить кэш программы
 *   {type:'done', id, meta}
 *   {type:'log', level, args}                        строки журнала
 */
const ctx: any = self;

function post(m: any) { ctx.postMessage(m); }

// журнал воркера — в журнал приложения
const c: any = console;
['log', 'warn', 'error'].forEach(function (k) {
  c[k] = function  {
    const args = Array.prototype.slice.call(arguments).map(function (a: any) {
      if (a instanceof Error) return a.name + ': ' + a.message;
      if (typeof a === 'object' && a!== null) { try { return JSON.stringify(a).slice(0, 300); } catch (e) { return String(a); } }
      return String(a);
    });
    post({ type: 'log', level: k, args: ['[epg]'].concat(args) });
  };
});

ctx.onmessage = function (e: MessageEvent) {
  const m = e.data;
  if (m.type === 'ping') {
    Db.get('sources', '').then(function  { post({ type: 'pong', ok: true }); }, function (err: any) {
      post({ type: 'pong', ok: false, error: String(err && (err.message || err.name) || err) });
    });
    return;
  }
  if (m.type === 'load') {
    if (m.prefs) Prefs.replace(m.prefs);
    Net.setProxy(!!m.proxyOk);
    Clock.setOffset(m.clock || 0);
    Loaders.loadEpg(m.url, m.wanted, m.maxArchiveDays, m.langs, m.force,
      function (read, total, programmes) { post({ type: 'progress', id: m.id, read: read, total: total, programmes: programmes }); },
      function  { post({ type: 'pack', id: m.id }); },).then(function (meta) {
      post({ type: 'done', id: m.id, meta: meta });
    }, function (err: any) {
      console.error('load', err);
      post({ type: 'done', id: m.id, meta: null });
    });
  }
};
