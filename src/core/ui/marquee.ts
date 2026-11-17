import { Prefs } from '../prefs';
import { Anim, setText } from './dom';
import { drawText, U } from './u';

/**
 * Расчёт бегущей строки (чистая логика). Цикл одной строки, не влезающей в ширину: пауза PAUSE_MS →
 * прокрутка до конца со скоростью SPEED_EM → пауза PAUSE_MS на конце → мгновенный возврат к началу
 * и снова пауза. Смещение — на сколько пикселей текст сдвинут влево.
 */
export const MarqueeMath = {
  /** Пауза в начале и на конце, мс */
  PAUSE_MS: 1500,
  /** Скорость прокрутки, em в секунду */
  SPEED_EM: 7,
  /** Шаг кадров при прокрутке на Canvas, мс (≈30 к/с: гид перерисовывается целиком) */
  FRAME_MS: 33,

  /** Длительность прокрутки, мс; speed — пикселей в секунду */
  scrollMs(overflow: number, speed: number): number { return overflow <= 0 || speed <= 0 ? 0 : Math.round(overflow / speed * 1000); },

  cycleMs(overflow: number, speed: number): number { return MarqueeMath.PAUSE_MS + MarqueeMath.scrollMs(overflow, speed) + MarqueeMath.PAUSE_MS; },

  /** Смещение через elapsed мс после показа строки; overflow — ширина текста минус ширина места */
  offset(overflow: number, speed: number, elapsed: number): number {
    if (overflow <= 0) return 0;
    const run = elapsed % MarqueeMath.cycleMs(overflow, speed) - MarqueeMath.PAUSE_MS;
    if (run <= 0) return 0;
    return Math.min(overflow, run / 1000 * speed);
  },

  /** Через сколько мс нужен следующий кадр (-1 — не нужен: строка влезает) */
  nextFrameMs(overflow: number, speed: number, elapsed: number): number {
    if (overflow <= 0) return -1;
    const scroll = MarqueeMath.scrollMs(overflow, speed);
    const cycle = MarqueeMath.cycleMs(overflow, speed);
    const t = elapsed % cycle;
    if (t < MarqueeMath.PAUSE_MS) return MarqueeMath.PAUSE_MS - t;                    // стоим в начале
    if (t < MarqueeMath.PAUSE_MS + scroll) return MarqueeMath.FRAME_MS;              // едем
    return cycle - t;                                                                 // стоим на конце
  },
};

/** Бегущая строка включена: настройка и не облегчённый интерфейс (прокрутка — та же анимация) */
export function marqueeOn(): boolean { return Prefs.marquee && Anim.on; }

interface Slot { key: string; t0: number; used: boolean; overflow: number; elapsed: number }

/**
 * Бегущие строки на Canvas гида (и в HTML-гиде: те же команды). draw рисует выделенную строку
 * (шрифт и цвет ставит вызывающий). Один таймер: кадр запрашивается, только пока строка едет или
 * ждёт смены фазы; нет вызовов draw за кадр (фокус ушёл, гид закрыт) — таймер не продлевается.
 * Невыделенные строки — обрезка «…». В конце кадра — end().
 *
 * Слот — место строки на экране (канал, передача, ячейка, шапка): у каждого свой отсчёт; смена
 * ключа строки или потеря выделения — цикл заново (с паузы).
 */
export class Marquee {
  private slots: Slot[] = [];
  private timer = 0;
  private due = 0;

  constructor(private redraw: () => void, private em: () => number) {
    for (let i = 0; i < 4; i++) this.slots.push({ key: '', t0: 0, used: false, overflow: 0, elapsed: 0 });
  }

  draw(c: CanvasRenderingContext2D, slot: number, key: string, active: boolean, s: string, x: number, cy: number, width: number) {
    if (width <= 0 || !s) return;
    const tw = active ? c.measureText(s).width : 0;
    if (!active || tw <= width || !marqueeOn()) { drawText(c, s, x, cy, width); return; }
    const st = this.slots[slot];
    const now = Date.now();
    if (st.key !== key) { st.key = key; st.t0 = now; }
    st.used = true;
    st.overflow = tw - width;
    st.elapsed = now - st.t0;
    const off = MarqueeMath.offset(st.overflow, MarqueeMath.SPEED_EM * this.em(), st.elapsed);
    const h = this.em() * 2;
    c.save();
    c.beginPath();
    c.rect(x, cy - h, width, 2 * h);
    c.clip();
    c.textBaseline = 'middle';
    c.fillText(s, x - off, cy);
    c.restore();
  }

  /** Конец кадра: слоты без выделения сбрасываются, следующий кадр — по ближайшей смене фазы */
  end() {
    let wait = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const st = this.slots[i];
      if (!st.used) { st.key = ''; continue; }
      st.used = false;
      const n = MarqueeMath.nextFrameMs(st.overflow, MarqueeMath.SPEED_EM * this.em(), st.elapsed);
      if (n >= 0 && (wait < 0 || n < wait)) wait = n;
    }
    if (wait < 0) return;
    const at = Date.now() + wait;
    // уже ждём кадра не позже — новый таймер не нужен
    if (this.timer && this.due <= at + 5) return;
    clearTimeout(this.timer);
    this.due = at;
    const self = this;
    this.timer = window.setTimeout(function () { self.timer = 0; self.redraw(); }, wait);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = 0;
    for (let i = 0; i < this.slots.length; i++) { this.slots[i].key = ''; this.slots[i].used = false; }
  }
}

/**
 * Бегущая строка в DOM (название в инфопанели): элемент с классом «el» (одна строка, «…») и
 * текстом во вложенном span. Не влезает — span едет CSS-переходом transform (один переход на
 * цикл, без перерисовки на каждом кадре), паузы — таймерами. Ширины меряются, когда элемент виден
 * (refresh — после показа панели и при смене текста).
 */
export class DomMarquee {
  private span: HTMLElement;
  private text = '';
  private timer = 0;
  private running = false;

  constructor(private box: HTMLElement) {
    this.span = document.createElement('span');
    box.appendChild(this.span);
  }

  set(s: string) {
    if (s === this.text) return;
    this.text = s;
    setText(this.span, s);
    this.refresh();
  }

  /** Перемерить и запустить или остановить (виден ли элемент — по ширине) */
  refresh() {
    this.halt();
    if (!marqueeOn()) return;
    const w = this.box.clientWidth;
    if (w <= 0) return;
    this.span.style.display = 'inline-block';
    const overflow = this.span.offsetWidth - w;
    if (overflow <= 1) { this.span.style.display = ''; return; }
    this.running = true;
    this.box.style.textOverflow = 'clip';
    const scroll = MarqueeMath.scrollMs(overflow, MarqueeMath.SPEED_EM * U.em);
    const self = this;
    const sp = this.span.style as any;
    const move = function (x: number, ms: number) {
      const tr = ms > 0 ? 'transform ' + ms + 'ms linear' : 'none';
      sp.webkitTransition = ms > 0 ? '-webkit-transform ' + ms + 'ms linear' : 'none';
      sp.transition = tr;
      sp.webkitTransform = 'translateX(' + x + 'px)';
      sp.transform = 'translateX(' + x + 'px)';
    };
    const cycle = function () {
      if (!self.running) return;
      move(0, 0);
      self.timer = window.setTimeout(function () {
        if (!self.running) return;
        move(-overflow, scroll);
        self.timer = window.setTimeout(cycle, scroll + MarqueeMath.PAUSE_MS);
      }, MarqueeMath.PAUSE_MS);
    };
    cycle();
  }

  /** Остановить (панель скрыта): текст на месте, «…» */
  halt() {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.running = false;
    const sp = this.span.style as any;
    sp.webkitTransition = 'none'; sp.transition = 'none';
    sp.webkitTransform = ''; sp.transform = '';
    sp.display = '';
    this.box.style.textOverflow = '';
  }
}
