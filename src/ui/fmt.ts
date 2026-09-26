import { Clock } from '../core/clock';
import { lang, str } from '../core/lang';

/** Форматирование времени и размеров (местное время ТВ) */
function pad2(n: number) { return n < 10 ? '0' + n : String(n); }
function week(): string[] { return str('week_short').split('|'); }
function month(): string[] { return str('month_short').split('|'); }

export const Fmt = {
  pad2: pad2,

  hhmm(sec: number): string {
    const d = new Date(sec * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  },

  /** Номер местного дня */
  dayIndex(sec: number): number {
    const d = new Date(sec * 1000);
    return Math.floor((sec - d.getTimezoneOffset() * 60) / 86400);
  },

  /** Начало местного дня, unix-секунды */
  dayStart(sec: number): number {
    const d = new Date(sec * 1000);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  },

  /** «Сегодня», «Вчера», «Завтра» или «Пн, 27.10» */
  dayLabel(sec: number): string {
    const diff = Fmt.dayIndex(sec) - Fmt.dayIndex(Clock.now());
    if (diff === 0) return str('today');
    if (diff === -1) return str('yesterday');
    if (diff === 1) return str('tomorrow');
    const d = new Date(sec * 1000);
    return week()[d.getDay()] + ', ' + pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1);
  },

  /** Вкладка дня: «ср,\n28 окт.» */
  dayTab(sec: number): string {
    const d = new Date(sec * 1000);
    return week()[d.getDay()].toLowerCase() + ',\n' + d.getDate() + ' ' + month()[d.getMonth()];
  },

  /** Компактная подпись дня: «ср\n28» */
  dayTabShort(sec: number): string {
    const d = new Date(sec * 1000);
    return week()[d.getDay()].toLowerCase() + '\n' + d.getDate();
  },

  timeRange(start: number, end: number): string { return Fmt.hhmm(start) + ' – ' + Fmt.hhmm(end); },
  dayTimeRange(start: number, end: number): string { return Fmt.dayLabel(start) + ', ' + Fmt.timeRange(start, end); },

  progress(start: number, stop: number, t: number): number {
    const v = (t - start) / Math.max(1, stop - start);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  },

  /** Длительность: 1:05:09 / 5:09 */
  duration(sec0: number): string {
    const sec = Math.max(0, Math.floor(sec0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h > 0 ? h + ':' + pad2(m) : String(m)) + ':' + pad2(s);
  },

  size(bytes: number): string {
    if (bytes < 1024 * 1024) return str('size_kb', Math.ceil(bytes / 1024));
    const v = (bytes / 1048576).toFixed(1);
    return str('size_mb', lang() === 'ru' ? v.replace('.', ',') : v);
  },

  /** «1д 2ч 5м» */
  until(sec0: number): string {
    const sec = Math.max(0, sec0);
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor((sec % 3600 + 59) / 60);
    const out: string[] = [];
    if (d > 0) out.push(str('x_d_2', d));
    if (h > 0) out.push(str('x_h_2', h));
    if (m > 0 || !out.length) out.push(str('x_m', m));
    return out.join(' ');
  },
};
