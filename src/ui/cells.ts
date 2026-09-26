import { Programme } from '../data/models';
import { Fmt } from './fmt';

/**
 * Ячейка ленты канала: передача из EPG или получасовой слот в промежутке без программы
 * (так по каналу без EPG можно ходить по сетке и смотреть архив с шагом 30 минут).
 */
export class Cell {
  constructor(public start: number, public end: number, public program: Programme | null) {}
  get title(): string { return this.program ? this.program.title : ''; }
  /** Заголовок для карточки и архива: у пустого слота — время */
  label(): string { return this.program ? this.program.title : Fmt.timeRange(this.start, this.end); }
}

export const SLOT = 1800;

function floorSlot(t: number) { return Math.floor(t / SLOT) * SLOT; }

export const Cells = {
  /** Непрерывная лента на [from, to) */
  cells(programs: Programme[], from: number, to: number): Cell[] {
    const out: Cell[] = [];
    let t = from;
    function gap(end: number) {
      while (t < end) {
        const slotEnd = Math.min(end, floorSlot(t) + SLOT);
        out.push(new Cell(t, slotEnd, null));
        t = slotEnd;
      }
    }
    for (let i = 0; i < programs.length; i++) {
      const p = programs[i];
      if (t >= to) break;
      if (p.stop <= t) continue;
      if (p.start > t) gap(Math.min(p.start, to));
      if (t >= to) break;
      out.push(new Cell(p.start, p.stop, p));
      t = p.stop;
    }
    gap(to);
    return out;
  },

  /** Ячейка, содержащая момент t */
  at(programs: Programme[], t: number): Cell {
    let prevEnd = -Infinity;
    for (let i = 0; i < programs.length; i++) {
      const p = programs[i];
      if (p.start <= t && t < p.stop) return new Cell(p.start, p.stop, p);
      if (p.start > t) {
        const start = Math.max(floorSlot(t), prevEnd);
        return new Cell(start, Math.min(p.start, floorSlot(t) + SLOT), null);
      }
      prevEnd = p.stop;
    }
    return new Cell(Math.max(floorSlot(t), prevEnd), floorSlot(t) + SLOT, null);
  },
};
