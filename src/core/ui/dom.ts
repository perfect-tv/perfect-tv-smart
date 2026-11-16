import { Prefs } from '../prefs';

/** Мелочи для DOM: создание элементов, показ/скрытие с прозрачностью, классы */
export function el(tag: string, cls?: string, text?: string | null, parent?: HTMLElement | null): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function setText(e: HTMLElement, s: string) {
  if (e.textContent !== s) e.textContent = s;
}

export function toggle(e: HTMLElement, cls: string, on: boolean) {
  const has = (' ' + e.className + ' ').indexOf(' ' + cls + ' ') >= 0;
  if (on && !has) e.className = (e.className ? e.className + ' ' : '') + cls;
  else if (!on && has) e.className = (' ' + e.className + ' ').replace(' ' + cls + ' ', ' ').trim();
}

export function visible(e: HTMLElement, on: boolean) {
  e.style.display = on ? '' : 'none';
}

export function clear(e: HTMLElement) {
  while (e.firstChild) e.removeChild(e.firstChild);
}

/** Плавные появления/скрытия (настройка «Облегчённый интерфейс» — выкл.) */
export const Anim = {
  get on() { return Prefs.animations; },
  show(e: HTMLElement) {
    e.style.display = '';
    if (!Anim.on) { e.style.opacity = '1'; return; }
    e.style.transition = 'none';
    e.style.opacity = '0';
    // принудительный пересчёт стилей, затем переход
    void e.offsetHeight;
    e.style.transition = 'opacity 150ms';
    e.style.opacity = '1';
  },
  hide(e: HTMLElement, done?: () => void) {
    if (!Anim.on || e.style.display === 'none') {
      e.style.display = 'none';
      if (done) done();
      return;
    }
    e.style.transition = 'opacity 140ms';
    e.style.opacity = '0';
    setTimeout(function () {
      if (e.style.opacity === '0') e.style.display = 'none';
      e.style.opacity = '1';
      if (done) done();
    }, 150);
  },
};

/** SVG-значки (линии, цвет — currentColor) */
const ICONS: { [k: string]: string } = {
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  hist: '<path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M12 8v4l3 2"/>',
  star: '<path d="M12 4l2.5 5 5.5.8-4 3.9.9 5.5L12 16.6 7.1 19.2l.9-5.5-4-3.9 5.5-.8z"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  back: '<path d="M11 6l-6 6 6 6"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21h4"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor"/>',
  live: '<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10"/>',
  restart: '<path d="M5 12a7 7 0 1 0 2-5"/><path d="M5 4v4h4"/>',
  guide: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 10v9"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  bksp: '<path d="M9 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5-6z"/><path d="M12 10l4 4M16 10l-4 4"/>',
  archive: '<path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M12 8v4l3 2"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
};

/** SVG-разметка значков (для HTML-гида, ui/domctx.ts) */
export const ICON_SVG = ICONS;

export function icon(name: string, cls?: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'ic' + (cls ? ' ' + cls : '');
  s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  return s;
}

/** Путь значка для Canvas (Path2D есть с Chromium 36) */
const pathCache: { [k: string]: Path2D[] } = {};
export function iconPaths(name: string): Path2D[] {
  let p = pathCache[name];
  if (p) return p;
  p = [];
  const src = ICONS[name] || '';
  const re = /<(path|circle|rect)\s([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const a: { [k: string]: string } = {};
    m[2].replace(/([\w-]+)="([^"]*)"/g, function (_s, k, v) { a[k] = v; return ''; });
    const path = new Path2D();
    if (m[1] === 'path') { p.push(new Path2D(a.d)); continue; }
    if (m[1] === 'circle') { path.arc(+a.cx, +a.cy, +a.r, 0, Math.PI * 2); }
    if (m[1] === 'rect') { path.rect(+a.x, +a.y, +a.width, +a.height); }
    p.push(path);
  }
  pathCache[name] = p;
  return p;
}

/** Нарисовать значок на Canvas: (x, y) — левый верхний угол, size — сторона, px */
export function drawIcon(c: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, color: string) {
  if ((c as any).isDom) { (c as any).icon(name, x, y, size, color); return; }   // HTML-гид
  const ps = iconPaths(name);
  c.save();
  c.translate(x, y);
  c.scale(size / 24, size / 24);
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = 2;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (let i = 0; i < ps.length; i++) c.stroke(ps[i]);
  if (name === 'play') c.fill(ps[0]);
  c.restore();
}
