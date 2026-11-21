import { describe, it, expect } from 'vitest';
import { overlapsDays } from '../src/core/data/repo';

const DAY = 86400;
/** День 20000 — условные «сегодняшние» сутки */
const D = 20000;

describe('программа через полночь', () => {
  it('передача, начавшаяся вчера и идущая сегодня, попадает в сегодняшние сутки', () => {
    const start = (D - 1) * DAY + 23 * 3600 + 30 * 60;
    const stop = D * DAY + 30 * 60;
    expect(overlapsDays(start, stop, D, D)).toBe(true);
  });
  it('передача только вчерашних суток в сегодня не попадает', () => {
    expect(overlapsDays((D - 1) * DAY + 10 * 3600, (D - 1) * DAY + 11 * 3600, D, D)).toBe(false);
  });
  it('передача ровно до полуночи не считается сегодняшней', () => {
    expect(overlapsDays(D * DAY - 3600, D * DAY, D, D)).toBe(false);
  });
  it('несколько суток — пересекает каждые', () => {
    expect(overlapsDays((D - 1) * DAY, (D + 2) * DAY, D, D)).toBe(true);
    expect(overlapsDays((D - 1) * DAY, (D + 2) * DAY, D + 1, D + 1)).toBe(true);
  });
});
