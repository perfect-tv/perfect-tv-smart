import { Clock } from '../core/clock';
import type { Repo } from '../data/repo';
import { Channel, Programme } from '../data/models';
import { Fmt } from './fmt';

const DAY = 86400;
/** Ближе этого к краю окна — догрузить */
const EDGE = 6 * 3600;

/**
 * Окно суток расписания канала («Программа и архив», список передач в гиде). Канал целиком
 * не грузим: сначала вчера, сегодня и завтра вокруг фокуса, при листании к краю — ещё по двое
 * суток, в пределах глубины архива и 8 суток вперёд. Даты — по оглавлению сервиса (все сразу).
 * Ушли с канала или закрыли окно — release(): догруженное выбрасывается из памяти.
 */
export class DayWindow {
  ch: Channel | null = null;
  /** границы: начало первых суток архива … конец восьмых суток вперёд (местное время) */
  from = 0;
  to = 0;
  /** загружаемое окно */
  lo = 0;
  hi = 0;

  /** Канал и время, вокруг которого открыть окно */
  reset(ch: Channel, t: number) {
    const now = Clock.now();
    this.ch = ch;
    this.from = Fmt.dayStart(now - Math.max(ch.archiveDays, 1) * DAY);
    this.to = Fmt.dayStart(now) + 8 * DAY;
    this.center(t);
  }

  /** Окно — сутки вокруг t (переход к дате) */
  center(t: number) {
    const d = Fmt.dayStart(Math.max(this.from, Math.min(this.to - 1, t)));
    this.lo = Math.max(this.from, d - DAY);
    this.hi = Math.min(this.to, d + 2 * DAY);
  }

  has(t: number) { return t >= this.lo && t < this.hi; }

  /** Передачи окна (недостающие сутки запрашиваются) */
  programmes(repo: Repo): Programme[] {
    if (!this.ch) return [];
    const lo = this.lo;
    return repo.range(this.ch, lo, this.hi).filter(function (p) { return p.start >= lo; });
  }

  /** Фокус на передаче со временем t: у края — расширить окно на двое суток; true — расширили */
  near(t: number): boolean {
    let changed = false;
    if (t - this.lo < EDGE && this.lo > this.from) { this.lo = Math.max(this.from, Fmt.dayStart(this.lo - 2 * DAY + 3600)); changed = true; }
    if (this.hi - t < EDGE && this.hi < this.to) { this.hi = Math.min(this.to, Fmt.dayStart(this.hi + 2 * DAY + 3600)); changed = true; }
    return changed;
  }

  /**
   * Местные сутки с программой в границах окна: начала суток. По оглавлению сервиса; пока его
   * нет — null (тогда даты — по загруженным передачам).
   */
  days(repo: Repo): number[] | null {
    if (!this.ch) return [];
    const idx = repo.daysOf(this.ch);
    if (!idx) return null;
    const shift = Math.round(this.ch.tvgShift * 3600);
    const out: number[] = [];
    for (let i = 0; i < idx.length; i++) {
      if (!idx[i][1]) continue;
      // сутки источника (UTC) задевают одни или двое местных суток
      const a = Fmt.dayStart(idx[i][0] * DAY + shift), b = Fmt.dayStart((idx[i][0] + 1) * DAY + shift - 1);
      const ds = a === b ? [a] : [a, b];
      for (let k = 0; k < ds.length; k++) if (ds[k] >= this.from && ds[k] < this.to && out.indexOf(ds[k]) < 0) out.push(ds[k]);
    }
    out.sort(function (x, y) { return x - y; });
    return out;
  }

  /** Выбросить догруженные сутки канала: остаются вчера, сегодня и завтра (их рисуют гид и плеер) */
  release(repo: Repo) {
    if (!this.ch) return;
    const now = Clock.now();
    repo.release(this.ch, Fmt.dayStart(now) - DAY, Fmt.dayStart(now) + 2 * DAY);
    this.ch = null;
  }
}
