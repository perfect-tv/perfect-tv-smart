import { str } from '../core/lang';
import { Prefs } from '../core/prefs';
import { el, setText, toggle } from './dom';
import { PopupLayer } from './popups';

export const MIN = 4;
export const MAX = 6;

/**
 * Окно PIN («Окно PIN»). Видны только набранные точки (длина не видна).
 *   RING (как Fire TV): ↑ → ↓ ← = 1 2 3 4, OK = 0; «Меню» / красная / удерж. OK — раскладка 5–9.
 *   ROWS (как Google): ряд 1-2-3: ← = 1, OK = 2, → = 3; ↑/↓ — другой ряд (с 1-2-3 вверх — 7-8-9);
 *        на ряду 7-8-9 ↓ = 0.
 *   PAD: сетка 1–9, ⌫, 0, «Готово».
 * В RING и ROWS нажатая цифра не подсвечивается. Цифры пульта работают всегда.
 * CHECK — PIN принимается, как только набран верный; 6 цифр без совпадения — «Неверный PIN».
 * CREATE — всегда клавиатурой, ввод дважды.
 */
export class PinLayer extends PopupLayer {
  holdRepeat = false;
  private buf = '';
  private first: string | null = null;
  private style: number;
  private high = false;
  private row = 0;
  private padIndex = 0;
  private dots: HTMLElement;
  private hint: HTMLElement;
  private err: HTMLElement;
  private help: HTMLElement;
  private stage: HTMLElement;
  private padViews: HTMLElement[] = [];
  private static PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'done'];

  constructor(parent: HTMLElement, private create: boolean, title: string, private onDone: (pin: string) => void, private onCancel:  => void) {
    super(parent, 40);
    toggle(this.win, 'pin', true);
    this.style = create? 2: Prefs.pinInput;
    this.head(null, title);
    this.hint = el('div', 't75', '', this.win);
    this.hint.style.cssText = 'font-size:1.35rem;text-align:center';
    this.dots = el('div', 'dots', null, this.win);
    this.err = el('div', 'err', '', this.win);
    this.stage = el('div', '', null, this.win);
    this.help = el('div', 'hint2', '', this.win);
    this.help.style.whiteSpace = 'pre-line';
    setText(this.hint, create? str('create_a_pin_of_4_6_digits'): str('enter_pin'));
    if (create) setText(this.help, str('done_when_entered_back_delete'));
    else if (this.style === 1) setText(this.help, str('up_down_another_row_on_7_8_9_down_0'));
    this.build;
    this.render;
    this.center;
  }

  private build {
    const s = this.stage;
    const self = this;
    if (this.style === 2) {
      const kb = el('div', 'kb', null, s);
      for (let i = 0; i < PinLayer.PAD.length; i++) {
        const k = PinLayer.PAD[i];
        const b = el('b', '', k === 'del'? '⌫': k === 'done'? str('done'): k, kb);
        if (k === 'done') b.style.fontSize = '1.3rem';
        (function (n) { b.addEventListener('click', function  { self.padIndex = n; self.press(PinLayer.PAD[n]); self.render; }); })(i);
        this.padViews.push(b);
      }
    } else if (this.style === 0) {
      el('div', 'ring', null, s);
    } else {
      const rows = el('div', 'rows', null, s);
      el('div', 'pad', null, rows);
      const all = el('div', 'all', null, rows);
      for (let i = 1; i <= 9; i++) el('b', '', String(i), all);
      el('b', '', '', all);
      el('b', '', '0', all);
    }
  }

  private render {
    const d = this.dots;
    while (d.firstChild) d.removeChild(d.firstChild);
    for (let i = 0; i < this.buf.length; i++) el('i', '', null, d);
    if (this.style === 2) {
      for (let i = 0; i < this.padViews.length; i++) toggle(this.padViews[i], 'f', i === this.padIndex);
    } else if (this.style === 0) {
      const ring = this.stage.firstChild as HTMLElement;
      while (ring.firstChild) ring.removeChild(ring.firstChild);
      const base = this.high? 5: 1;
      const pos: [number, number][] = [[50, 18], [82, 50], [50, 82], [18, 50]];
      for (let i = 0; i < 4; i++) {
        const b = el('b', '', String(base + i), ring);
        b.style.left = pos[i][0] + '%';
        b.style.top = pos[i][1] + '%';
      }
      el('b', 'c', this.high? '9': '0', ring);
      setText(this.help, str('pin_ring_help', this.high? '0–4': '5–9'));
    } else {
      const pad = (this.stage.firstChild as HTMLElement).firstChild as HTMLElement;
      while (pad.firstChild) pad.removeChild(pad.firstChild);
      const b0 = this.row * 3 + 1;
      const pos: [number, number, string][] = [[20, 50, String(b0)], [50, 50, String(b0 + 1)], [80, 50, String(b0 + 2)]];
      if (this.row === 2) pos.push([50, 82, '0']);
      for (let i = 0; i < pos.length; i++) {
        const b = el('b', '', pos[i][2], pad);
        b.style.left = pos[i][0] + '%';
        b.style.top = pos[i][1] + '%';
      }
      const all = (this.stage.firstChild as HTMLElement).lastChild as HTMLElement;
      for (let i = 0; i < all.childNodes.length; i++) {
        const on = (i < 9 && Math.floor(i / 3) === this.row) || (i === 10 && this.row === 2);
        toggle(all.childNodes[i] as HTMLElement, 'on', on);
      }
    }
  }

  private digit(d: number) {
    setText(this.err, '');
    if (this.buf.length >= MAX) return;
    this.buf += d;
    setText(this.hint, this.create? (this.first === null? str('create_a_pin_of_4_6_digits'): str('repeat_the_pin')): str('enter_pin'));
    if (!this.create) {
      if (this.buf === Prefs.pin) { this.onDone(this.buf); return; }
      if (this.buf.length >= MAX) { this.fail(str('wrong_pin')); return; }
    }
    this.render;
  }

  private fail(text: string) {
    this.buf = '';
    setText(this.err, text);
    this.render;
  }

  private confirm {
    if (this.buf.length < MIN) { this.fail(str('x_to_x_digits_required', MIN, MAX)); return; }
    if (this.first === null) {
      this.first = this.buf;
      this.buf = '';
      setText(this.hint, str('repeat_the_pin'));
      setText(this.err, '');
      this.render;
      return;
    }
    if (this.first === this.buf) { this.onDone(this.buf); return; }
    this.first = null;
    setText(this.hint, str('create_a_pin_of_4_6_digits'));
    this.fail(str('did_not_match_create_the_pin_again'));
  }

  private press(k: string) {
    if (k === 'del') { this.buf = this.buf.substring(0, this.buf.length - 1); this.render; return; }
    if (k === 'done') {
      if (this.create) this.confirm;
      else if (this.buf) this.fail(str('wrong_pin'));
      return;
    }
    this.digit(parseInt(k, 10));
  }

  key(name: string, _long: boolean, d: number) {
    if (name === 'digit') { this.digit(d); return; }
    if (this.style === 2) {
      const i = this.padIndex;
      if (name === 'left') this.padIndex = i % 3 === 0? i + 2: i - 1;
      else if (name === 'right') this.padIndex = i % 3 === 2? i - 2: i + 1;
      else if (name === 'up') this.padIndex = (i + 9) % 12;
      else if (name === 'down') this.padIndex = (i + 3) % 12;
      this.render;
      return;
    }
    if (this.style === 0) {
      const base = this.high? 5: 1;
      if (name === 'up') this.digit(base);
      else if (name === 'right') this.digit(base + 1);
      else if (name === 'down') this.digit(base + 2);
      else if (name === 'left') this.digit(base + 3);
      return;
    }
    // ряды
    if (name === 'left') this.digit(this.row * 3 + 1);
    else if (name === 'right') this.digit(this.row * 3 + 3);
    else if (name === 'up') { this.row = (this.row + 2) % 3; this.render; }
    else if (name === 'down') { if (this.row === 2) this.digit(0); else { this.row++; this.render; } }
  }

  enter {
    if (this.style === 2) { this.press(PinLayer.PAD[this.padIndex]); this.render; return; }
    if (this.style === 0) { this.digit(this.high? 9: 0); return; }
    this.digit(this.row * 3 + 2);
  }

  long {
    if (this.style === 0) { this.high =!this.high; this.render; }
  }

  media(name: string) {
    if ((name === 'menu' || name === 'red') && this.style === 0) { this.high =!this.high; this.render; }
  }

  back {
    if (this.buf) { this.buf = this.buf.substring(0, this.buf.length - 1); setText(this.err, ''); this.render; return; }
    this.onCancel;
  }
}
