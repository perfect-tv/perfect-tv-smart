import { Layer } from './layer';

/**
 * Разбор нажатий пульта (docs/controls.md, «Долгие нажатия»).
 *
 * Если у слоя для направления есть долгое действие (hasLong), короткое срабатывает на keyup,
 * а долгое — через LONG_PRESS удержания. Если нет — сразу на keydown; удержание ↑/↓ листает
 * своим таймером с ускорением (Hold), автоповтор пульта для них не используется. Автоповтор ←/→
 * передаётся слою как есть (перемотка считает его сама). OK: короткое — enter() на keyup,
 * долгое (800 мс) — long().
 */
export interface Scheduler {
  set(f: () => void, ms: number): number;
  clear(id: number): void;
  now(): number;
}

export const realScheduler: Scheduler = {
  set: function (f, ms) { return window.setTimeout(f, ms) as any; },
  clear: function (id) { window.clearTimeout(id); },
  now: function () { return Date.now(); },
};

export const LONG_PRESS = 500;
export const OK_LONG_PRESS = 800;
/** Удержание ↑/↓, мс: через DELAY, интервал от START до MIN за RAMP; GAP — keyup потерялся */
export const Hold = { DELAY: 350, START: 90, MIN: 35, RAMP: 1500, GAP: 700 };

/** Коды клавиш: пульты LG (webOS) и Samsung (Tizen), клавиатура (для проверки в браузере) */
const NAMES: { [code: number]: string } = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down',
  33: 'pgup', 34: 'pgdown', // CH+ / CH− (LG), Page Up / Down
  427: 'pgup', 428: 'pgdown', // CH+ / CH− (Samsung)
};

export function isOk(code: number) { return code === 13; }
export function isBack(code: number) { return code === 461 || code === 27 || code === 8 || code === 10009; }
export function digit(code: number): number | null {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 96 && code <= 105) return code - 96;
  return null;
}

/** Медиа- и служебные клавиши → имя действия */
export function media(code: number): string | null {
  switch (code) {
    case 415: return 'play';
    case 19: return 'pause';
    case 179: case 10252: case 32: return 'playpause';
    case 413: return 'stop';
    case 412: case 188: return 'rewind';     // ⏪, «,» на клавиатуре
    case 417: case 190: return 'forward';    // ⏩, «.»
    case 458: case 71: return 'guide';       // GUIDE, G
    case 457: case 73: return 'info';        // INFO, I
    case 403: return 'red';
    case 404: return 'green';
    case 405: return 'yellow';
    case 406: return 'blue';
    case 77: case 93: case 10135: return 'menu'; // M, клавиша контекстного меню, Tools (Samsung)
    case 10073: return 'guide';              // Channel List (Samsung)
    case 10225: return 'search';             // Search (Samsung)
    case 72: case 10190: return 'history';   // H, Previous Channel (Samsung)
    case 70: return 'search';                // F
    default: return null;
  }
}

interface Held { name: string; layer: Layer; fired: boolean }
interface Repeat { name: string; layer: Layer; since: number; last: number; timer: number }

export class Keys {
  private held: Held | null = null;
  private heldTimer = 0;
  private repeat: Repeat | null = null;
  private down: { [code: number]: boolean } = {};

  constructor(private handler: () => Layer | null, private s: Scheduler = realScheduler) {}

  /** keydown; repeat — автоповтор пульта. true — клавиша наша */
  onKeyDown(code: number, repeat0?: boolean): boolean {
    const repeat = repeat0 === undefined ? !!this.down[code] : repeat0;
    this.down[code] = true;
    const d = digit(code);
    if (d !== null) {
      if (!repeat) { const h = this.handler(); if (h && h.key) h.key('digit', false, d); }
      return true;
    }
    if (isOk(code)) {
      if (repeat) return true;
      const layer = this.handler();
      if (!layer) return true;
      this.startHeld('ok', layer, OK_LONG_PRESS);
      return true;
    }
    if (isBack(code)) {
      if (!repeat) { const h = this.handler(); if (h && h.back) h.back(); }
      return true;
    }
    const m = media(code);
    if (m !== null) {
      // автоповтор ⏪/⏩ — удержание перемотки
      if (!repeat || m === 'rewind' || m === 'forward') { const h = this.handler(); if (h && h.media) h.media(m); }
      return true;
    }
    const name = NAMES[code];
    if (!name) return false;
    const layer = this.handler();
    if (!layer) return true;
    const h = this.held;
    if (h && h.name === name) return true;
    if (layer.hasLong && layer.hasLong(name)) {
      if (repeat) return true;
      this.startHeld(name, layer, LONG_PRESS);
      return true;
    }
    if (layer.holdRepeat === false) {
      if (!repeat) { this.release(); if (layer.key) layer.key(name, false, 0); }
      return true;
    }
    const r = this.repeat;
    if (r && r.name === name) { r.last = this.s.now(); return true; }
    if (repeat && (name === 'up' || name === 'down')) return true;
    this.release();
    if (layer.key) layer.key(name, false, 0);
    if ((name === 'up' || name === 'down') && !repeat) this.startRepeat(name, layer);
    return true;
  }

  onKeyUp(code: number): boolean {
    delete this.down[code];
    const name = isOk(code) ? 'ok' : NAMES[code];
    if (!name) return digit(code) !== null || isBack(code) || media(code) !== null;
    const r = this.repeat;
    if (r && r.name === name) this.stopRepeat();
    const h = this.held;
    if (!h || h.name !== name) {
      if (name !== 'ok') { const l = this.handler(); if (l && l.keyUp) l.keyUp(name); }
      return true;
    }
    this.held = null;
    this.s.clear(this.heldTimer);
    if (!h.fired && this.handler() === h.layer) {
      if (name === 'ok') { if (h.layer.enter) h.layer.enter(); } else if (h.layer.key) h.layer.key(name, false, 0);
    }
    return true;
  }

  private startHeld(name: string, layer: Layer, delay: number) {
    this.release();
    const h: Held = { name: name, layer: layer, fired: false };
    this.held = h;
    const self = this;
    this.heldTimer = this.s.set(function () {
      if (self.held !== h) return;
      h.fired = true;
      if (self.handler() !== layer) return;
      if (name === 'ok') { if (layer.long) layer.long(); } else if (layer.key) layer.key(name, true, 0);
    }, delay);
  }

  private startRepeat(name: string, layer: Layer) {
    const now = this.s.now();
    const rep: Repeat = { name: name, layer: layer, since: now + Hold.DELAY, last: now, timer: 0 };
    this.repeat = rep;
    const self = this;
    const tick = function () {
      if (self.repeat !== rep) return;
      const t = self.s.now();
      if (t - rep.last > Hold.GAP || self.handler() !== layer) { self.stopRepeat(); return; }
      if (layer.key) layer.key(name, false, 0);
      const k = Math.min(1, (t - rep.since) / Hold.RAMP);
      const spent = self.s.now() - t;
      rep.timer = self.s.set(tick, Math.max(16, Math.round(Hold.START - (Hold.START - Hold.MIN) * k) - spent));
    };
    rep.timer = this.s.set(tick, Hold.DELAY);
  }

  private stopRepeat() {
    if (this.repeat) this.s.clear(this.repeat.timer);
    this.repeat = null;
  }

  /** Сбросить удержания (смена экрана) */
  release() {
    this.s.clear(this.heldTimer);
    this.held = null;
    this.stopRepeat();
  }

  /** Пульт перестал присылать keyup (окно потеряло фокус) — забыть нажатые */
  reset() {
    this.down = {};
    this.release();
  }
}
