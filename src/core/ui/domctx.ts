import { ICON_SVG } from './dom';

/**
 * HTML-отрисовка гида: тот же набор команд, что у CanvasRenderingContext2D (гид рисует как
 * обычно), но каждая команда берёт элемент DOM из постоянного набора и меняет у него только то,
 * что изменилось. Браузер перерисовывает лишь изменившиеся элементы, а не весь экран 1920×1080,
 * как Canvas (на webOS 3/4 рисование в Canvas часто идёт без видеокарты).
 *
 * Элементы — по видам (прямоугольник, рамка, текст, картинка, линия, значок, область обрезки),
 * i-я команда вида берёт i-й элемент; порядок наложения — z-index по порядку команд, поэтому
 * при сдвиге строк узлы не пересоздаются. Неиспользованные за кадр — display:none.
 * Поддержано то, чем пользуется гид: fillRect (цвет или линейный градиент), скруглённые
 * прямоугольники и рамки (roundRect/strokeRoundRect в u.ts), fillText, drawImage (<img>), линии
 * (stroke пути → SVG), значки (drawIcon), clip по прямоугольнику, translate, globalAlpha.
 */

interface Grad { x0: number; y0: number; x1: number; y1: number; stops: [number, string][]; addColorStop(o: number, c: string): void }
interface Box { el: HTMLElement; kids: { [kind: string]: Rec[] }; used: { [kind: string]: number }; z: number; ox: number; oy: number }
interface State {
  fillStyle: any; strokeStyle: any; font: string; textAlign: string; textBaseline: string; globalAlpha: number;
  lineWidth: number; lineCap: string; lineJoin: string; tx: number; ty: number; box: Box;
}

const SVGNS = 'http://www.w3.org/2000/svg';

function px(v: number): string { return (Math.round(v * 10) / 10) + 'px'; }

/**
 * Запись об элементе: что ему уже выставлено (стили, текст, картинка, значок) — в обычном
 * JS-объекте. Поля прямо на DOM-узле (e.__s) в старом V8 читаются медленно: учёт стилей был
 * половиной времени отрисовки гида на эмуляторе webOS 4.
 */
class Rec {
  st: any;
  s: { [prop: string]: string } = {};
  n: { [prop: string]: number } = {};
  a: { [name: string]: string } = {};
  t: string | null = null;
  icon = '';
  img: any = null;
  nw = 0;
  nh = 0;
  src = '';
  box: Box | null = null;
  sub: Rec | null = null;
  constructor(public el: any) { this.st = el.style; }
}

/** Размер в px только при изменении: число сравнивается до сборки строки */
function setPx(r: Rec, prop: string, v: number) {
  const n = Math.round(v * 10) / 10;
  if (r.n[prop] === n) return;
  r.n[prop] = n;
  r.st[prop] = n + 'px';
}
function setNum(r: Rec, prop: string, n: number) {
  if (r.n[prop] === n) return;
  r.n[prop] = n;
  r.st[prop] = String(n);
}
/** Стиль только при изменении */
function set(r: Rec, prop: string, v: string) {
  if (r.s[prop] === v) return;
  r.s[prop] = v;
  r.st[prop] = v;
}
function attr(r: Rec, name: string, v: string) {
  if (r.a[name] === v) return;
  r.a[name] = v;
  r.el.setAttribute(name, v);
}

export class DomCtx {
  readonly isDom = true;
  fillStyle: any = '#000';
  strokeStyle: any = '#000';
  font = '10px sans-serif';
  textAlign = 'left';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  private tx = 0;
  private ty = 0;
  private stack: State[] = [];
  private root: Box;
  private box: Box;
  private path: string[] = [];
  private lastRect: number[] | null = null;
  private m: CanvasRenderingContext2D;

  constructor(public el: HTMLElement) {
    this.root = { el: el, kids: {}, used: {}, z: 0, ox: 0, oy: 0 };
    this.box = this.root;
    this.m = document.createElement('canvas').getContext('2d')!;
  }

  // ------------------------------------------------------------ кадр

  begin() {
    this.reset(this.root);
    this.box = this.root;
    this.stack = [];
    this.tx = 0; this.ty = 0;
    this.globalAlpha = 1;
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
  }

  /** Конец кадра: лишние элементы — скрыть */
  end() { this.finish(this.root); }

  private reset(b: Box) { b.used = {}; b.z = 0; }

  private finish(b: Box) {
    for (const kind in b.kids) {
      const list = b.kids[kind], n = b.used[kind] || 0;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (i >= n) set(r, 'display', 'none');
        else if (r.box) this.finish(r.box);
      }
    }
  }

  private take(kind: string, make: () => any): Rec {
    const b = this.box;
    const list = b.kids[kind] || (b.kids[kind] = []);
    const i = b.used[kind] || 0;
    b.used[kind] = i + 1;
    let r = list[i];
    if (!r) {
      const e = make();
      if (!e.__svg) e.className = 'dk';
      b.el.appendChild(e);
      r = new Rec(e);
      list.push(r);
    }
    set(r, 'display', '');
    setNum(r, 'zIndex', ++b.z);
    setNum(r, 'opacity', this.globalAlpha < 1 ? Math.round(this.globalAlpha * 1000) / 1000 : 1);
    return r;
  }

  /** Координаты холста → внутри текущей области обрезки */
  private X(x: number) { return x + this.tx - this.box.ox; }
  private Y(y: number) { return y + this.ty - this.box.oy; }

  // ------------------------------------------------------------ состояние

  save() {
    this.stack.push({
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, font: this.font, textAlign: this.textAlign,
      textBaseline: this.textBaseline, globalAlpha: this.globalAlpha, lineWidth: this.lineWidth,
      lineCap: this.lineCap, lineJoin: this.lineJoin, tx: this.tx, ty: this.ty, box: this.box,
    });
  }
  restore() {
    const s = this.stack.pop();
    if (!s) return;
    this.fillStyle = s.fillStyle; this.strokeStyle = s.strokeStyle; this.font = s.font; this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline; this.globalAlpha = s.globalAlpha; this.lineWidth = s.lineWidth;
    this.lineCap = s.lineCap; this.lineJoin = s.lineJoin; this.tx = s.tx; this.ty = s.ty; this.box = s.box;
  }
  translate(x: number, y: number) { this.tx += x; this.ty += y; }
  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number) { this.tx = e / (a || 1); this.ty = f / (d || 1); }
  scale() { /* только в значках — у них свой путь */ }
  clearRect() { /* кадр начинается с begin() */ }

  // ------------------------------------------------------------ пути

  beginPath() { this.path = []; this.lastRect = null; }
  moveTo(x: number, y: number) { this.path.push('M' + this.X(x).toFixed(1) + ' ' + this.Y(y).toFixed(1)); }
  lineTo(x: number, y: number) { this.path.push('L' + this.X(x).toFixed(1) + ' ' + this.Y(y).toFixed(1)); }
  arcTo(x1: number, y1: number) { this.lineTo(x1, y1); }
  closePath() { this.path.push('Z'); }
  rect(x: number, y: number, w: number, h: number) {
    this.lastRect = [x + this.tx, y + this.ty, w, h];
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
  }

  /** Обрезка — только прямоугольник (как в гиде): вложенный div с overflow:hidden */
  clip() {
    const r = this.lastRect;
    if (!r) return;
    const parent = this.box;
    const e = this.take('c', function () { return document.createElement('div'); });
    if (!e.box) e.box = { el: e.el, kids: {}, used: {}, z: 0, ox: 0, oy: 0 };
    set(e, 'overflow', 'hidden');
    setPx(e, 'left', r[0] - parent.ox);
    setPx(e, 'top', r[1] - parent.oy);
    setPx(e, 'width', r[2]);
    setPx(e, 'height', r[3]);
    const b: Box = e.box;
    this.reset(b);
    b.ox = r[0]; b.oy = r[1];
    this.box = b;
  }

  private svgPath(kind: string, fill: boolean) {
    if (!this.path.length) return;
    const e = this.take(kind, function () {
      const s: any = document.createElementNS(SVGNS, 'svg');
      s.__svg = true;
      s.setAttribute('class', 'dk dks');
      s.appendChild(document.createElementNS(SVGNS, 'path'));
      return s;
    });
    const p = e.sub || (e.sub = new Rec(e.el.firstChild));
    attr(p, 'd', this.path.join(''));
    if (fill) { attr(p, 'fill', String(this.fillStyle)); attr(p, 'stroke', 'none'); }
    else {
      attr(p, 'fill', 'none');
      attr(p, 'stroke', String(this.strokeStyle));
      attr(p, 'stroke-width', String(this.lineWidth));
      attr(p, 'stroke-linecap', this.lineCap);
      attr(p, 'stroke-linejoin', this.lineJoin);
    }
  }
  stroke() { this.svgPath('s', false); }
  fill() { this.svgPath('f', true); }

  // ------------------------------------------------------------ заливка

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Grad {
    const tx = this.tx, ty = this.ty;
    return {
      x0: x0 + tx, y0: y0 + ty, x1: x1 + tx, y1: y1 + ty, stops: [],
      addColorStop: function (o: number, c: string) { this.stops.push([o, c]); },
    };
  }

  /** Фон прямоугольника с абсолютной позицией (ax, ay, w, h): цвет или градиент */
  private paint(e: Rec, style: any, ax: number, ay: number, w: number, h: number) {
    if (style && style.stops) {
      const g = style as Grad;
      const vertical = Math.abs(g.x1 - g.x0) < Math.abs(g.y1 - g.y0);
      const parts: string[] = [];
      for (let i = 0; i < g.stops.length; i++) {
        const o = g.stops[i][0];
        const pos = vertical ? g.y0 + o * (g.y1 - g.y0) - ay : g.x0 + o * (g.x1 - g.x0) - ax;
        parts.push(g.stops[i][1] + ' ' + px(pos));
      }
      set(e, 'backgroundColor', 'transparent');
      set(e, 'backgroundImage', 'linear-gradient(' + (vertical ? 'to bottom' : 'to right') + ',' + parts.join(',') + ')');
    } else {
      set(e, 'backgroundImage', 'none');
      set(e, 'backgroundColor', String(style));
    }
  }

  fillRect(x: number, y: number, w: number, h: number) { this.box2(x, y, w, h, 0, this.fillStyle); }

  /** Скруглённый прямоугольник (roundRect в u.ts) */
  roundRect(l: number, t: number, r: number, b: number, rad: number, color: string) { this.box2(l, t, r - l, b - t, rad, color); }

  /** Свой радиус у каждого угла (roundRect4 в u.ts) */
  roundRect4(l: number, t: number, r: number, b: number, tl: number, tr: number, br: number, bl: number, color: string) {
    this.box2(l, t, r - l, b - t, 0, color, px(tl) + ' ' + px(tr) + ' ' + px(br) + ' ' + px(bl));
  }

  private box2(x: number, y: number, w: number, h: number, rad: number, style: any, radii?: string) {
    if (w <= 0 || h <= 0) return;
    const e = this.take('b', function () { return document.createElement('div'); });
    setPx(e, 'left', this.X(x));
    setPx(e, 'top', this.Y(y));
    setPx(e, 'width', w);
    setPx(e, 'height', h);
    if (radii) { e.n.borderRadius = -1; set(e, 'borderRadius', radii); }
    else { if (e.s.borderRadius !== undefined) { delete e.s.borderRadius; } setPx(e, 'borderRadius', rad > 0 ? rad : 0); }
    this.paint(e, style, x + this.tx, y + this.ty, w, h);
  }

  /** Рамка (strokeRoundRect в u.ts): линия по контуру, как у Canvas — наполовину снаружи */
  strokeRoundRect(l: number, t: number, r: number, b: number, rad: number, color: string, width: number) {
    if (r <= l || b <= t) return;
    const e = this.take('o', function () { return document.createElement('div'); });
    setPx(e, 'left', this.X(l - width / 2));
    setPx(e, 'top', this.Y(t - width / 2));
    setPx(e, 'width', r - l + width);
    setPx(e, 'height', b - t + width);
    setPx(e, 'borderRadius', rad + width / 2);
    set(e, 'border', px(width) + ' solid ' + color);
  }

  // ------------------------------------------------------------ текст

  /**
   * Ширина текста — из кэша: в каждом кадре меряются одни и те же названия, а назначение шрифта
   * холсту для измерений и само измерение — четверть времени отрисовки гида (профиль на webOS 4).
   */
  private mFont = '';
  private byFont: { [font: string]: { [s: string]: number } } = {};
  private wFont = '';
  private wMap: { [s: string]: number } = {};
  private widthCount = 0;
  /** результат measureText — один объект на все вызовы (гид читает только width сразу) */
  private mres = { width: 0 };
  measureText(s: string): TextMetrics {
    if (this.font !== this.wFont) {
      this.wFont = this.font;
      this.wMap = this.byFont[this.font] || (this.byFont[this.font] = {});
    }
    let w = this.wMap[s];
    if (w === undefined) {
      if (this.mFont !== this.font) { this.m.font = this.font; this.mFont = this.font; }
      w = this.m.measureText(s).width;
      if (++this.widthCount > 6000) { this.byFont = {}; this.wFont = ''; this.widthCount = 0; this.wMap = this.byFont[this.font] = {}; this.wFont = this.font; }
      this.wMap[s] = w;
    }
    this.mres.width = w;
    return this.mres as any as TextMetrics;
  }

  private tFont = '';
  private tKind = 't';
  private fontKinds: { [font: string]: string } = {};
  private fontKindN = 0;

  private sizes: { [font: string]: number } = {};
  private fontSize(font: string): number {
    let v = this.sizes[font];
    if (v === undefined) { const m = /([\d.]+)px/.exec(font); v = this.sizes[font] = m ? parseFloat(m[1]) : 10; }
    return v;
  }

  fillText(s: string, x: number, y: number) {
    if (!s) return;
    const size = this.fontSize(this.font);
    let left = x;
    if (this.textAlign === 'center' || this.textAlign === 'right' || this.textAlign === 'end') {
      const w = this.measureText(s).width;
      left = this.textAlign === 'center' ? x - w / 2 : x - w;
    }
    const bl = this.textBaseline;
    const top = bl === 'middle' ? y - size / 2 : bl === 'top' || bl === 'hanging' ? y : bl === 'bottom' ? y - size : y - size * 0.8;
    // свой набор элементов на каждый шрифт: иначе при сдвиге строк i-й текст доставался то
    // названию канала, то передаче, и шрифт / высота строки / цвет переписывались у большинства
    // (на одну смену канала — ~440 из ~800 изменённых свойств)
    if (this.font !== this.tFont) {
      this.tFont = this.font;
      this.tKind = this.fontKinds[this.font] || (this.fontKinds[this.font] = 't' + (++this.fontKindN));
    }
    const e = this.take(this.tKind, function () { return document.createElement('div'); });
    setPx(e, 'left', this.X(left));
    setPx(e, 'top', this.Y(top));
    set(e, 'font', this.font);
    setPx(e, 'lineHeight', size);
    set(e, 'color', String(this.fillStyle));
    if (e.t !== s) { e.t = s; e.el.textContent = s; }
  }

  // ------------------------------------------------------------ картинки и значки

  /** drawImage(img, dx, dy, dw, dh) или (img, sx, sy, sw, sh, dx, dy, dw, dh) — <img> в рамке */
  drawImage(img: any, a: number, b: number, c: number, d: number, e?: number, f?: number, g?: number, h?: number) {
    if (!img) return;
    const box = this.take('m', function () {
      const w = document.createElement('div');
      const i = document.createElement('img');
      i.className = 'dk';
      w.appendChild(i);
      return w;
    });
    // размеры и адрес картинки — один раз на картинку (пока не загрузилась — каждый кадр):
    // чтение naturalWidth / src у DOM-узла каждый кадр — заметная часть отрисовки
    if (box.img !== img || box.nw <= 0) {
      box.img = img;
      box.nw = img.naturalWidth || 0;
      box.nh = img.naturalHeight || 0;
      const src = img.src;
      if (box.src !== src) { box.src = src; (box.sub || (box.sub = new Rec(box.el.firstChild))).el.src = src; }
    }
    const nw = box.nw || 1, nh = box.nh || 1;
    let sx = 0, sy = 0, sw = nw, sh = nh, dx = a, dy = b, dw = c, dh = d;
    if (e !== undefined) { sx = a; sy = b; sw = c; sh = d; dx = e; dy = f!; dw = g!; dh = h!; }
    if (dw <= 0 || dh <= 0) { set(box, 'display', 'none'); return; }
    set(box, 'overflow', 'hidden');
    setPx(box, 'left', this.X(dx));
    setPx(box, 'top', this.Y(dy));
    setPx(box, 'width', dw);
    setPx(box, 'height', dh);
    const kx = dw / sw, ky = dh / sh;
    const im = box.sub || (box.sub = new Rec(box.el.firstChild));
    setPx(im, 'left', -sx * kx);
    setPx(im, 'top', -sy * ky);
    setPx(im, 'width', nw * kx);
    setPx(im, 'height', nh * ky);
  }

  /** Значок (drawIcon в dom.ts) — та же SVG-разметка, что у значков в окнах */
  icon(name: string, x: number, y: number, size: number, color: string) {
    const e = this.take('i', function () { return document.createElement('div'); });
    if (e.icon !== name) {
      e.icon = name;
      e.el.innerHTML = '<svg viewBox="0 0 24 24" fill="' + (name === 'play' ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICON_SVG[name] || '') + '</svg>';
    }
    setPx(e, 'left', this.X(x));
    setPx(e, 'top', this.Y(y));
    setPx(e, 'width', size);
    setPx(e, 'height', size);
    set(e, 'color', color);
  }
}

/** Контекст гида — DOM (HTML-отрисовка)? */
export function isDom(c: any): c is DomCtx { return !!c && c.isDom === true; }
