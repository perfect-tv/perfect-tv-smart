import { Channel } from '../data/models';
import { Anim, el, icon, toggle } from './dom';
import { Layer } from './layer';
import { Logos } from './logos';
import { Scroller } from './popups';
import { U } from './u';

export interface MenuTile { icon: string; title: string; run: () => void }
export interface MenuItem {
  title: string;
  value?: string;
  /** Не закрывать меню (значение меняется на месте) */
  keep?: boolean;
  enabled?: boolean;
  run?: () => void;
  /** Страница второго уровня */
  sub?: () => MenuPage;
}
export interface MenuSection { title: string; items: MenuItem[] }
export interface MenuPage { title: string; subtitle?: string; channel?: Channel | null; tiles?: MenuTile[]; sections: MenuSection[] }

/**
 * Меню канала — шторка справа (docs/design.md, «Меню канала»): до четырёх плиток, ниже —
 * группы пунктов. ↑/↓ — пункт (по кругу, через ряд плиток), ←/→ — в ряду плиток, → на «›» —
 * страница второго уровня, ← там — обратно. OK — выполнить (меню закрывается, кроме keep).
 */
export class MenuLayer implements Layer {
  el: HTMLElement;
  private drawer: HTMLElement;
  private stack: { page: () => MenuPage; index: number }[] = [];
  private focusables: { el: HTMLElement; tile?: MenuTile; item?: MenuItem; tileRow?: boolean }[] = [];
  private index = 0;
  private tileIndex = 0;
  private scroller: Scroller | null = null;

  constructor(parent: HTMLElement, page: () => MenuPage, private onClose: () => void) {
    this.el = el('div', '', null, parent);
    this.el.id = 'menu-shade';
    this.drawer = el('div', 'drawer', null, this.el);
    this.drawer.style.width = Math.round(Math.min(U.px(35.6), U.w * 0.45)) + 'px';
    const self = this;
    this.el.addEventListener('click', function (e) { if (e.target === self.el) self.onClose(); });
    this.stack.push({ page: page, index: 0 });
    this.render();
    Anim.show(this.el);
  }

  /** Перестроить текущую страницу (значения поменялись) */
  refresh() { this.render(); }

  private render() {
    const top = this.stack[this.stack.length - 1];
    const page = top.page();
    const d = this.drawer;
    while (d.firstChild) d.removeChild(d.firstChild);
    this.focusables = [];
    const head = el('div', 'row', null, d);
    if (page.channel) {
      const lg = Logos.el(page.channel, '', false);
      lg.style.cssText = 'width:4.6rem;height:3rem;margin-right:1rem';
      head.appendChild(lg);
    }
    const ht = el('div', 'grow', null, head);
    el('div', 'head el', page.title, ht);
    if (page.subtitle) el('div', 'sub el', page.subtitle, ht).style.marginBottom = '0';
    el('div', '', null, d).style.height = '1.2rem';
    const self = this;
    const body = el('div', '', null, d);
    if (page.tiles && page.tiles.length) {
      const row = el('div', 'tiles', null, body);
      for (let i = 0; i < page.tiles.length; i++) {
        const t = page.tiles[i];
        const te = el('div', 'tile', null, row);
        te.appendChild(icon(t.icon));
        el('div', '', t.title, te);
        this.focusables.push({ el: te, tile: t, tileRow: true });
      }
    }
    // пункты — на всю оставшуюся высоту шторки (в крупных размерах интерфейса прокручиваются)
    const used = body.getBoundingClientRect().top - d.getBoundingClientRect().top + body.offsetHeight;
    this.scroller = new Scroller(body, Math.max(U.px(10), U.h - used - U.px(1.6)), 'rgba(30,31,32,.94)');
    const inner = this.scroller.inner;
    for (let s = 0; s < page.sections.length; s++) {
      const sec = page.sections[s];
      if (!sec.items.length) continue;
      if (sec.title) el('div', 'gl', sec.title, inner);
      for (let i = 0; i < sec.items.length; i++) {
        const it = sec.items[i];
        const r = el('div', 'mi', null, inner);
        el('span', 'el grow', it.title, r);
        if (it.value) el('span', 'v', it.value, r);
        if (it.sub) r.appendChild(icon('chevron', 'chev'));
        if (it.enabled === false) r.style.opacity = '0.45';
        this.focusables.push({ el: r, item: it });
      }
    }
    for (let i = 0; i < this.focusables.length; i++) {
      (function (k) {
        const f = self.focusables[k];
        f.el.addEventListener('click', function () { self.index = k; self.focus(); self.enter(); });
        f.el.addEventListener('mousemove', function () { if (self.index !== k) { self.index = k; self.focus(); } });
      })(i);
    }
    this.index = Math.min(top.index, Math.max(0, this.focusables.length - 1));
    this.scroller.scrollTo(0);
    this.focus();
  }

  private focus() {
    for (let i = 0; i < this.focusables.length; i++) toggle(this.focusables[i].el, 'f', i === this.index);
    this.stack[this.stack.length - 1].index = this.index;
    const f = this.focusables[this.index];
    if (f && !f.tileRow && this.scroller) {
      const e = f.el;
      this.scroller.reveal(e.offsetTop, e.offsetTop + e.offsetHeight, e.offsetHeight);
    }
  }

  private tilesCount() { let n = 0; for (let i = 0; i < this.focusables.length; i++) if (this.focusables[i].tileRow) n++; return n; }

  key(name: string) {
    const n = this.focusables.length;
    if (!n) return;
    const tiles = this.tilesCount();
    const cur = this.focusables[this.index];
    if (name === 'up' || name === 'down') {
      // ряд плиток — одна позиция (−1) перед пунктами; по кругу
      const m = n - tiles;
      const min = tiles > 0 ? -1 : 0;
      let pos = cur.tileRow ? -1 : this.index - tiles;
      if (cur.tileRow) this.tileIndex = this.index;
      pos += name === 'up' ? -1 : 1;
      if (pos >= m) pos = min;
      if (pos < min) pos = m - 1;
      this.index = pos < 0 ? Math.min(this.tileIndex, tiles - 1) : tiles + pos;
    } else if (name === 'left') {
      if (cur.tileRow && this.index > 0) this.index--;
      else if (!cur.tileRow && this.stack.length > 1) { this.pop(); return; }
      else return;
    } else if (name === 'right') {
      if (cur.tileRow && this.index < tiles - 1) this.index++;
      else if (cur.item && cur.item.sub) { this.push(cur.item.sub); return; }
      else return;
    } else if (name === 'pgup') this.index = tiles < n ? tiles : 0;
    else if (name === 'pgdown') this.index = n - 1;
    else return;
    this.focus();
  }

  wheel(dy: number) { this.key(dy > 0 ? 'down' : 'up'); }

  private push(sub: () => MenuPage) {
    this.stack.push({ page: sub, index: 0 });
    this.render();
  }

  private pop() {
    this.stack.pop();
    this.render();
  }

  enter() {
    const f = this.focusables[this.index];
    if (!f) return;
    if (f.tile) { this.onClose(); f.tile.run(); return; }
    const it = f.item!;
    if (it.enabled === false) return;
    if (it.sub) { this.push(it.sub); return; }
    if (!it.keep) this.onClose();
    if (it.run) it.run();
    if (it.keep) this.render();
  }

  back() {
    if (this.stack.length > 1) this.pop(); else this.onClose();
  }

  media(name: string) { if (name === 'menu' || name === 'red') this.onClose(); }
}
