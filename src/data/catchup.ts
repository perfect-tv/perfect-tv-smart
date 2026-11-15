/**
 * Шаблоны URL архива (catchup) (docs/TZ.md, §8; примеры — tests/catchup.test.ts).
 *
 * Подстановки:
 *   ${start} ${utc} ${end} ${utcend} ${offset} ${duration} ${now} ${lutc} ${timestamp}
 *   ${(b)yyyy-MM-dd:HH-mm}  начало;  ${(e)...} конец;  ${(n)...} сейчас
 *   ${(bu)...} — в UTC, ${(b+3)...} — со сдвигом часового пояса
 *   ${(d)M} ${(d)S} ${(d)h} ${(d)m} — длительность
 */

// фигурные скобки экранированы везде (так же, как в Android-версии)
const VAR_RE = /\$\{(\((([a-zA-Z\d]+?)(u)?)([+-]\d+)?\))?([^\$\{\}]+)\}/;

/** Смещение пояса в минутах к UTC для момента ms (Москва: +180) */
export type TzFn = (ms: number) => number;
export const localTz: TzFn = function (ms) { return -new Date(ms).getTimezoneOffset(); };

export const CatchupUrl = {
  /** Шаблон архива канала или null, если архив не поддерживается */
  template(url: string, type0: string, source: string): string | null {
    let type = (type0 || '').toLowerCase();
    if (!type) {
      if (source) type = /^[?&\/][^\/]/.test(source) ? 'append' : 'default';
      else type = url.indexOf('${') < 0 ? 'shift' : 'default';
    }
    let out: string;
    switch (type) {
      case 'append': case 'timeshift': case 'shift':
        if (type === 'append' && source) {
          out = (/^https?:\/\//i.test(source) ? '' : url) + source;
        } else {
          const base = source || url;
          return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'utc=${start}&lutc=${timestamp}';
        }
        break;
      case 'flussonic': case 'flussonic-hls': case 'flussonic-ts': case 'fs':
        // /ch/index.m3u8 → /ch/archive-{start}-{duration}.m3u8; mono/video — так же; /ch/mpegts → timeshift_abs
        return url
          .replace(/\/(video|mono)\.(m3u8|ts)/, '/$1-${start}-${duration}.$2')
          .replace(/\/(index|playlist)\.(m3u8|ts)/, '/archive-${start}-${duration}.$2')
          .replace(/\/mpegts/, '/timeshift_abs-${start}.ts');
      case 'xc':
        // http://host:8080/live/user/pass/1477.m3u8 → /timeshift/user/pass/{min}/{Y-m-d:H-M}/1477.m3u8
        out = url
          .replace(/^(https?:\/\/[^\/]+)(\/live)?(\/[^\/]+\/[^\/]+\/)([^\/.]+)\.m3u8?$/, '$1/timeshift$3${(d)M}/${(b)yyyy-MM-dd:HH-mm}/$4.m3u8')
          .replace(/^(https?:\/\/[^\/]+)(\/live)?(\/[^\/]+\/[^\/]+\/)([^\/.]+)(\.ts|)$/, '$1/timeshift$3${(d)M}/${(b)yyyy-MM-dd:HH-mm}/$4.ts');
        break;
      case 'default':
        out = source || url;
        break;
      default:
        return null;
    }
    if (out.indexOf('${') < 0) return CatchupUrl.template(out, 'shift', '');
    return out;
  },

  /**
   * Flussonic с HLS-архивом (archive-/mono-/video-…-START-DURATION.m3u8): вместо длительности
   * можно подставить `now` — EVENT-плейлист от начала до текущего момента, дописывается.
   */
  flussonicHls(type: string, tpl: string): boolean {
    return /^(flussonic|fs)/i.test(type || '') && /-\$\{start\}-\$\{duration\}\.m3u8/.test(tpl);
  },

  /** EVENT-ссылка Flussonic: archive-START-now.m3u8 */
  flussonicNow(tpl: string): string {
    return tpl.replace(/-\$\{start\}-\$\{duration\}\.m3u8/, '-${start}-now.m3u8');
  },

  /**
   * Подставить значения в шаблон.
   * @param start unix-секунды начала, null — без диапазона (эфир: start = сейчас)
   */
  prepare(url0: string, start0: number | null, duration0: number, now: number, tz: TzFn = localTz): string {
    const vars: { [k: string]: (m: RegExpExecArray) => string } = {};
    if (start0 === null) {
      vars.start = function () { return String(now); };
      vars.offset = function () { return '0'; };
    } else {
      const start = start0;
      const dur = Math.max(60, duration0);
      const startMin = start / 60;
      const durMin = Math.round(dur / 60);
      vars.start = function () { return String(start); };
      vars.utc = vars.start;
      vars.end = function () { return String(start + dur); };
      vars.utcend = vars.end;
      vars.offset = function () { return String(now - start); };
      vars.duration = function () { return String(dur); };
      vars.now = function () { return String(now); };
      vars.lutc = vars.now;
      vars.d = function (m) {
        return replaceAll(m[6], [['M', String(durMin)], ['S', String(dur)], ['h', String(Math.floor(durMin / 60))], ['m', pad2(durMin % 60)], ['s', '00']]);
      };
      vars.b = function (m) { return formatTime(startMin, m[6], m[4] || '', m[5] || '', tz); };
      vars.e = function (m) { return formatTime(startMin + durMin, m[6], m[4] || '', m[5] || '', tz); };
      vars.n = function (m) { return formatTime(now / 60, m[6], m[4] || '', m[5] || '', tz); };
    }
    vars.timestamp = function () { return String(now); };
    let url = url0;
    let guard = 0;
    while (guard++ < 50) {
      const m = VAR_RE.exec(url);
      if (!m) break;
      const g2 = m[2] || '', g3 = m[3] || '', key = m[6];
      let v: string;
      if (g2 && vars[g2]) v = vars[g2](m);
      else if (g3 && vars[g3]) v = vars[g3](m);
      else if (vars[key]) v = vars[key](m);
      else v = m[1] || '';
      url = url.substring(0, m.index) + encode(v) + url.substring(m.index + m[0].length);
    }
    return url;
  },
};

function formatTime(minutes: number, format: string, utc: string, tzShift: string, tz: TzFn): string {
  let shift = (parseInt(tzShift, 10) || 0) * 60;
  const ms = Math.round(minutes * 60000);
  if (!utc) shift += tz(ms);
  const d = new Date(Math.round((minutes + shift) * 60000));
  return replaceAll(format, [
    ['yyyy', String(d.getUTCFullYear())],
    ['MM', pad2(d.getUTCMonth() + 1)],
    ['dd', pad2(d.getUTCDate())],
    ['HH', pad2(d.getUTCHours())],
    ['mm', pad2(d.getUTCMinutes())],
    ['ss', pad2(d.getUTCSeconds())],
    ['UTF', String(ms)],
  ]);
}

function replaceAll(s: string, pairs: string[][]): string {
  let out = s;
  for (let i = 0; i < pairs.length; i++) out = out.split(pairs[i][0]).join(pairs[i][1]);
  return out;
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

function encode(s: string): string { return encodeURIComponent(s); }
