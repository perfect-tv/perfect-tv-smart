import { describe, it, expect } from 'vitest';
import { Cells } from '../src/core/ui/cells';
import { Programme } from '../src/core/data/models';
import { merge } from '../src/core/data/repo';

const p = (start: number, stop: number): Programme => ({ start, stop, title: 'p' + start, subTitle: '', desc: '', category: '', icon: '' });
const h = 1700000000 - 1700000000 % 1800;

describe('Cells', () => {
  it('пустоты — получасовые слоты', () => {
    const c = Cells.cells([p(h + 3600, h + 5400)], h + 600, h + 7200);
    expect(c.map(x => x.start)).toEqual([h + 600, h + 1800, h + 3600, h + 5400]);
    expect(c.map(x => x.program ? x.program.title : null)).toEqual([null, null, 'p' + (h + 3600), null]);
    expect(c[c.length - 1].end).toBe(h + 7200);
  });
  it('ячейка в момент: внутри, до, после', () => {
    const list = [p(h + 3600, h + 5400), p(h + 5400, h + 9000)];
    expect(Cells.at(list, h + 4000).start).toBe(h + 3600);
    const before = Cells.at(list, h + 100);
    expect(before.program).toBeNull();
    expect([before.start, before.end]).toEqual([h, h + 1800]);
    const after = Cells.at(list, h + 9100);
    expect([after.start, after.end]).toEqual([h + 9000, h + 10800]);
    expect(Cells.at([p(h + 1000, h + 2000)], h + 500).end).toBe(h + 1000);
  });
  it('без EPG — слоты', () => {
    const c = Cells.cells([], h, h + 3600);
    expect(c.length).toBe(2);
    expect(c[0].title).toBe('');
  });
});

describe('merge (пачки программы)', () => {
  it('новая загрузка важнее старой, перекрытия обрезаются, сдвиг', () => {
    const old = { l: 1, n: 0, p: [[100, 200, 'старая'], [200, 300, 'b'], [500, 600, 'хвост']] };
    const cur = { l: 2, n: 0, p: [[100, 250, 'новая'], [240, 400, 'c']] };
    const list = merge([old, cur], 10);
    expect(list.map(x => x.title)).toEqual(['новая', 'c', 'хвост']);
    expect(list[0].stop).toBe(250);       // 240 + 10: обрезано по началу следующей
    expect(list[0].start).toBe(110);
  });
});
