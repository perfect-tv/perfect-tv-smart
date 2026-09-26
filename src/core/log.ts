/**
 * Журнал для проверки на телевизоре без кабеля: последние строки console.* и неперехваченные
 * ошибки (window.onerror, unhandledrejection). Показывается в Настройки → Данные → «Журнал».
 */
const MAX = 400;
const lines: string[] = [];
const t0 = Date.now();

function stamp(): string {
  const s = (Date.now() - t0) / 1000;
  return (s < 10 ? '  ' : s < 100 ? ' ' : '') + s.toFixed(1);
}

function text(a: any): string {
  if (a instanceof Error) return a.name + ': ' + a.message + (a.stack ? ' | ' + String(a.stack).split('\n').slice(1, 3).join(' ').replace(/\s+/g, ' ') : '');
  if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a).slice(0, 300); } catch (e) { return String(a); } }
  return String(a);
}

export function log(level: string, args: any[]) {
  let s = stamp() + ' ' + level + ' ';
  for (let i = 0; i < args.length; i++) s += (i ? ' ' : '') + text(args[i]);
  lines.push(s.slice(0, 600));
  if (lines.length > MAX) lines.shift();
}

export const Log = {
  lines(): string[] { return lines.slice(); },
  /** Перехватить console.* и ошибки окна */
  install() {
    const c: any = console;
    ['log', 'warn', 'error'].forEach(function (k) {
      const orig = c[k];
      c[k] = function () {
        const args = Array.prototype.slice.call(arguments);
        log(k === 'log' ? 'I' : k === 'warn' ? 'W' : 'E', args);
        if (orig) try { orig.apply(console, args); } catch (e) { /* */ }
      };
    });
    window.addEventListener('error', function (e: any) {
      log('E', ['uncaught', e.message || '', (e.filename || '').split('/').pop() + ':' + (e.lineno || '') + ':' + (e.colno || ''), e.error || '']);
    });
    window.addEventListener('unhandledrejection', function (e: any) { log('E', ['unhandled promise', e.reason]); });
    log('I', ['start', navigator.userAgent]);
  },
};
