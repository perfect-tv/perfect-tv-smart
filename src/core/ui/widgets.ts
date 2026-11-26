import { str } from '../lang';
import { Catalog } from '../data/catalog';
import { Channel } from '../data/models';
import { Anim, el, setText, visible } from './dom';
import { Logos } from './logos';
import { U } from './u';
import type { CarouselView, OsdView } from './views';

/**
 * Стрелки в подсказках — линиями (SVG), а не символами шрифта: глифы стрелок стоят у нижнего
 * края строки и «прибиты ко дну» рамки.
 */
const ARROWS: { [c: string]: string } = {
  '←': 'M19 12H5M11 6l-6 6 6 6',
  '→': 'M5 12h14M13 6l6 6-6 6',
  '↑': 'M12 19V5M6 11l6-6 6 6',
  '↓': 'M12 5v14M6 13l6 6 6-6',
};

export function keycap(text: string): HTMLElement {
  const k = el('span', 'kc');
  const parts = text.split(/(←|→|↑|↓)/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (ARROWS[p]) {
      const s = document.createElement('span');
      s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="' + ARROWS[p] + '"/></svg>';
      k.appendChild(s.firstChild!);
    } else k.appendChild(document.createTextNode(p.replace(/\s+/g, ' ')));
  }
  return k;
}

/** Строка подсказок клавиш: [клавиша, действие] */
export function hintRow(box: HTMLElement, items: [string, string][]) {
  while (box.firstChild) box.removeChild(box.firstChild);
  for (let i = 0; i < items.length; i++) {
    const h = el('span', 'hint', null, box);
    h.appendChild(keycap(items[i][0]));
    h.appendChild(document.createTextNode(items[i][1]));
  }
}

/** Тост вверху по центру */
export class Toast {
  private el: HTMLElement;
  private timer = 0;
  constructor(parent: HTMLElement) {
    this.el = el('div', '', null, parent);
    this.el.id = 'toast';
    this.el.style.display = 'none';
  }
  show(text: string, ms = 2500) {
    setText(this.el, text);
    if (this.el.style.display === 'none') Anim.show(this.el);
    clearTimeout(this.timer);
    const e = this.el;
    this.timer = window.setTimeout(function () { Anim.hide(e); }, ms);
  }
  hide() { clearTimeout(this.timer); this.el.style.display = 'none'; }
}

/** Набор номера: номер, логотип, название; ниже — каналы, которые выберутся следующей цифрой */
export class Osd implements OsdView {
  private el: HTMLElement;
  private num: HTMLElement;
  private logo: HTMLElement;
  private name: HTMLElement;
  private hints: HTMLElement;
  constructor(parent: HTMLElement) {
    const e = el('div', '', null, parent);
    e.id = 'osd';
    e.style.display = 'none';
    this.el = e;
    const r = el('div', 'row numrow', null, e);
    this.num = el('div', 'big', null, r);
    this.logo = el('div', 'logo', null, r);
    this.name = el('div', 'name el', null, r);
    // не «hint»: так называется строка подсказок клавиш (flex в одну строку)
    this.hints = el('div', 'cands', null, e);
  }
  show(buf: string, cat: Catalog) {
    const n = parseInt(buf, 10) || 0;
    const ch = cat.byNum(n);
    setText(this.num, buf);
    if (ch) Logos.fill(this.logo, ch, false);
    visible(this.logo, !!ch);
    setText(this.name, ch ? ch.name : '—');
    this.name.style.opacity = ch ? '1' : '0.5';
    const h = this.hints;
    while (h.firstChild) h.removeChild(h.firstChild);
    if (n > 0 && buf.length < 4) {
      let count = 0;
      for (let k = n * 10; k <= n * 10 + 9 && count < 6; k++) {
        const c = cat.byNum(k);
        if (!c) continue;
        count++;
        const row = el('div', 'hrow el', null, h);
        el('b', '', String(c.num), row);
        row.appendChild(document.createTextNode(c.name));
      }
    }
    this.el.style.display = '';
  }
  hide() { this.el.style.display = 'none'; }
  destroy() { if (this.el.parentNode) this.el.parentNode.removeChild(this.el); }
}

/** Карусель каналов над инфопанелью: выбранная карточка по центру в белой рамке */
export class Carousel implements CarouselView {
  private el: HTMLElement;
  private cards: HTMLElement[] = [];
  private logos: HTMLElement[] = [];
  private names: HTMLElement[] = [];
  static SIZE = 7;
  constructor(parent: HTMLElement) {
    const e = el('div', '', null, parent);
    e.id = 'carousel';
    e.style.display = 'none';
    this.el = e;
    for (let i = 0; i < Carousel.SIZE; i++) {
      const c = el('div', 'card', null, e);
      this.cards.push(c);
      this.logos.push(el('div', 'logo', null, c));
      this.names.push(el('div', 'nm el', null, c));
    }
  }
  show(list: Channel[], index: number, panelHeight: number) {
    const n = list.length;
    if (!n) return;
    const mid = Carousel.SIZE >> 1;
    const cw = U.px(12.4), gap = U.px(1.2);
    const x0 = (U.w - (Carousel.SIZE * cw + (Carousel.SIZE - 1) * gap)) / 2;
    for (let k = 0; k < Carousel.SIZE; k++) {
      const card = this.cards[k];
      card.style.left = Math.round(x0 + k * (cw + gap)) + 'px';
      if (n === 1 && k !== mid) { card.style.visibility = 'hidden'; continue; }
      card.style.visibility = 'visible';
      const ch = list[((index + k - mid) % n + n) % n];
      Logos.fill(this.logos[k], ch);
      setText(this.names[k], ch.name);
      card.className = 'card' + (k === mid ? ' on' : '');
    }
    // над содержимым панели (её верх — плавное затемнение)
    this.el.style.bottom = Math.round(panelHeight + U.px(0.8)) + 'px';
    this.el.style.display = '';
  }
  hide() { if (this.el.style.display !== 'none') Anim.hide(this.el); }
  destroy() { if (this.el.parentNode) this.el.parentNode.removeChild(this.el); }
}

/**
 * Кольцо загрузки потока: дольше 1 с. Поворот шагами по 45° 3 раза в секунду, а не CSS-анимацией:
 * бесконечное вращение перерисовывало экран 60 раз в секунду — на ТВ без ускорения (эмулятор
 * webOS 4) приложение было занято на 127% ядра против 2% без кольца, при 2–3 шагах в секунду —
 * около 13%. При выключенных «Плавных анимациях» кольцо стоит.
 */
export class Buffering {
  private el: HTMLElement;
  private timer = 0;
  private spin = 0;
  private angle = 0;
  constructor(parent: HTMLElement) {
    this.el = el('div', '', null, parent);
    this.el.id = 'buffering';
    this.el.style.display = 'none';
  }
  set(on: boolean) {
    clearTimeout(this.timer);
    if (!on) { clearInterval(this.spin); this.spin = 0; this.el.style.display = 'none'; return; }
    const e = this.el;
    if (e.style.display !== 'none') return;
    const self = this;
    this.timer = window.setTimeout(function () {
      e.style.display = '';
      if (!Anim.on || self.spin) return;
      self.spin = window.setInterval(function () {
        self.angle = (self.angle + 45) % 360;
        const t = 'rotate(' + self.angle + 'deg)';
        (e.style as any).webkitTransform = t;
        e.style.transform = t;
      }, 333);
    }, 1000);
  }
}

export { str };
