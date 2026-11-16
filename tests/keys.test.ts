import { describe, it, expect } from 'vitest';
import { Keys, Scheduler } from '../src/core/ui/keys';
import { Layer } from '../src/core/ui/layer';

/** Поддельные часы и таймеры */
class Fake implements Scheduler {
  t = 0;
  private id = 0;
  private tasks: { at: number; id: number; f: () => void }[] = [];
  set(f: () => void, ms: number) { const id = ++this.id; this.tasks.push({ at: this.t + ms, id, f }); return id; }
  clear(id: number) { this.tasks = this.tasks.filter(x => x.id !== id); }
  now() { return this.t; }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const ready = this.tasks.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!ready) break;
      this.tasks.splice(this.tasks.indexOf(ready), 1);
      this.t = ready.at;
      ready.f();
    }
    this.t = end;
  }
}

function rec(longs: string[] = [], holdRepeat = true) {
  const log: string[] = [];
  const l: Layer = {
    el: null, holdRepeat,
    hasLong: n => longs.indexOf(n) >= 0,
    key: (n, long, d) => { log.push(n === 'digit' ? 'd' + d : long ? 'long:' + n : n); },
    keyUp: n => { log.push('up:' + n); },
    enter: () => { log.push('enter'); },
    long: () => { log.push('longok'); },
    back: () => { log.push('back'); },
    media: n => { log.push('m:' + n); },
  };
  return { l, log };
}

const LEFT = 37, UP = 38, RIGHT = 39, DOWN = 40, OK = 13;

describe('Keys', () => {
  it('без долгого — сразу на keydown', () => {
    const f = new Fake(); const { l, log } = rec(); const k = new Keys(() => l, f);
    k.onKeyDown(LEFT, false);
    expect(log).toEqual(['left']);
    k.onKeyUp(LEFT);
    expect(log).toEqual(['left', 'up:left']);
  });

  it('с долгим — короткое на keyup, долгое через 500 мс', () => {
    const f = new Fake(); const { l, log } = rec(['down']); const k = new Keys(() => l, f);
    k.onKeyDown(DOWN, false); f.advance(200); k.onKeyUp(DOWN);
    expect(log).toEqual(['down']);
    k.onKeyDown(DOWN, false); f.advance(500); k.onKeyDown(DOWN, true); k.onKeyUp(DOWN);
    expect(log).toEqual(['down', 'long:down']);
  });

  it('OK: короткое и долгое (800 мс)', () => {
    const f = new Fake(); const { l, log } = rec(); const k = new Keys(() => l, f);
    k.onKeyDown(OK, false); f.advance(100); k.onKeyUp(OK);
    k.onKeyDown(OK, false); f.advance(800); k.onKeyUp(OK);
    expect(log).toEqual(['enter', 'longok']);
  });

  it('удержание ↑ — свой таймер, стоп на keyup', () => {
    const f = new Fake(); const { l, log } = rec(); const k = new Keys(() => l, f);
    k.onKeyDown(UP, false);
    for (let i = 1; i <= 20; i++) { f.advance(50); k.onKeyDown(UP, true); }
    const steps = log.filter(x => x === 'up').length;
    expect(steps).toBeGreaterThanOrEqual(6);
    expect(steps).toBeLessThanOrEqual(10);
    k.onKeyUp(UP);
    const after = log.filter(x => x === 'up').length;
    f.advance(1000);
    expect(log.filter(x => x === 'up').length).toBe(after);
  });

  it('keyup потерялся — удержание кончается', () => {
    const f = new Fake(); const { l, log } = rec(); const k = new Keys(() => l, f);
    k.onKeyDown(DOWN, false); f.advance(3000);
    const n = log.filter(x => x === 'down').length;
    f.advance(3000);
    expect(log.filter(x => x === 'down').length).toBe(n);
  });

  it('слой без повтора (PIN) — каждое нажатие один раз', () => {
    const f = new Fake(); const { l, log } = rec([], false); const k = new Keys(() => l, f);
    k.onKeyDown(UP, false);
    for (let i = 1; i <= 10; i++) { f.advance(50); k.onKeyDown(UP, true); }
    f.advance(2000);
    expect(log).toEqual(['up']);
  });

  it('автоповтор → проходит', () => {
    const f = new Fake(); const { l, log } = rec(); const k = new Keys(() => l, f);
    k.onKeyDown(RIGHT, false); k.onKeyDown(RIGHT, true); k.onKeyDown(RIGHT, true);
    expect(log).toEqual(['right', 'right', 'right']);
  });

  it('цифры, «Назад» (461), медиа, CH+, цветные', () => {
    const f = new Fake(); const { l, log } = rec(); const k = new Keys(() => l, f);
    k.onKeyDown(55, false);          // 7
    k.onKeyDown(99, false);          // 3 на цифровом блоке
    k.onKeyDown(461, false);         // «Назад» пульта LG
    k.onKeyDown(415, false);         // ▶
    k.onKeyDown(417, false); k.onKeyDown(417, true);   // ⏩ с автоповтором
    k.onKeyDown(33, false);          // CH+
    k.onKeyDown(403, false);         // красная
    k.onKeyDown(458, false);         // GUIDE
    expect(log).toEqual(['d7', 'd3', 'back', 'm:play', 'm:forward', 'm:forward', 'pgup', 'm:red', 'm:guide']);
  });

  it('повтор без флага repeat — по отсутствию keyup', () => {
    const f = new Fake(); const { l, log } = rec(); const k = new Keys(() => l, f);
    k.onKeyDown(OK); k.onKeyDown(OK); f.advance(100); k.onKeyUp(OK);
    expect(log).toEqual(['enter']);
  });
});
