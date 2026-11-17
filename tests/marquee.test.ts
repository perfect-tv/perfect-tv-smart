import { describe, it, expect } from 'vitest';
import { MarqueeMath as M } from '../src/core/ui/marquee';

const speed = 100; // px/с: overflow 200 px едет 2 с

describe('MarqueeMath', () => {
  it('начинается с паузы', () => {
    expect(M.offset(200, speed, 0)).toBe(0);
    expect(M.offset(200, speed, M.PAUSE_MS)).toBe(0);
  });
  it('едет со скоростью', () => {
    expect(M.offset(200, speed, M.PAUSE_MS + 500)).toBeCloseTo(50, 2);
    expect(M.offset(200, speed, M.PAUSE_MS + 2000)).toBeCloseTo(200, 2);
  });
  it('пауза на конце, затем снова с начала', () => {
    const end = M.PAUSE_MS + 2000;
    expect(M.offset(200, speed, end + M.PAUSE_MS - 1)).toBeCloseTo(200, 2);
    const cycle = M.cycleMs(200, speed);
    expect(M.offset(200, speed, cycle)).toBe(0);
    expect(M.offset(200, speed, cycle + M.PAUSE_MS - 1)).toBe(0);
    expect(M.offset(200, speed, cycle + M.PAUSE_MS + 500)).toBeCloseTo(50, 2);
  });
  it('влезает — не едет', () => {
    expect(M.offset(0, speed, 5000)).toBe(0);
    expect(M.offset(-10, speed, 5000)).toBe(0);
    expect(M.nextFrameMs(0, speed, 0)).toBe(-1);
  });
  it('следующий кадр', () => {
    expect(M.nextFrameMs(200, speed, 100)).toBe(M.PAUSE_MS - 100);
    expect(M.nextFrameMs(200, speed, M.PAUSE_MS + 10)).toBe(M.FRAME_MS);
    expect(M.nextFrameMs(200, speed, M.PAUSE_MS + 2000 + 10)).toBe(M.PAUSE_MS - 10);
  });
});
