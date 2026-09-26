import { Prefs } from '../core/prefs';

/**
 * Палитра, масштаб и рисование на Canvas.
 * 1 em = высота экрана / 48 (настройка «Размер интерфейса»: 54 / 48 / 43,2) — то же, что 10 dp
 * в Android-версии. В CSS это 1rem (размер шрифта корня ставит U.init).
 * «Белый» — #EBEBEB, а не чистый: на телевизоре чистый белый режет глаза.
 */
const SOFT = 235;
function wa(a: number): string { return 'rgba(235,235,235,' + a + ')'; }

export const C = {
  WHITE: 'rgb(235,235,235)',
  BLACK: '#000',
  FILL: wa(0.05),
  FILL_SOFT: wa(0.06),
  FILL_CELL: wa(0.09),
  FILL_BTN: wa(0.12),
  FILL_NOW: wa(0.17),
  FILL_MARKED: wa(0.18),
  FILL_PLAYING: wa(0.30),
  FILL_ACTIVE: wa(0.22),
  LINE: wa(0.08),
  LINE_STRONG: wa(0.10),
  PANEL: 'rgba(26,27,28,0.92)',
  PANEL_CARD: 'rgba(26,27,28,0.85)',
  PANEL_CARD_ON: 'rgba(26,27,28,0.95)',
  POPUP: 'rgba(30,31,32,0.94)',
  OVERLAY: 'rgba(0,0,0,0.45)',
  SCRIM: 'rgba(8,9,11,0.97)',
  GUIDE_TOP: 'rgba(12,13,14,0.97)',
  GUIDE_BOTTOM: 'rgba(12,13,14,0.80)',
  SETTINGS_BG: '#121314',
  LOGO_PLATE: '#2A2C2F',
  LIVE: '#E53935',
  ARCHIVE: '#FFB84D',
  ON_ARCHIVE: '#201400',
  t: function (a: number) { return wa(a); },
  black: function (a: number) { return 'rgba(0,0,0,' + a + ')'; },
};

export const RADIUS_S = 0.4;
export const RADIUS = 0.6;
export const RADIUS_L = 1;
export const FONT = '"LG Smart UI", "Roboto", "Noto Sans", "Helvetica Neue", Arial, sans-serif';

export const U = {
  /** px на 1 em */
  em: 22.5,
  /** Ширина и высота экрана, px (CSS) */
  w: 1920,
  h: 1080,
  dpr: 1,

  init {
    const w = window.innerWidth || 1920;
    const h = window.innerHeight || 1080;
    // экран не 16:9 (окно браузера) — считаем от вписанного 16:9
    const hh = Math.min(h, w * 9 / 16);
    U.w = w;
    U.h = h;
    U.em = hh / Prefs.screenEm;
    U.dpr = window.devicePixelRatio || 1;
    document.documentElement.style.fontSize = U.em + 'px';
  },

  px(e: number): number { return e * U.em; },
  /** Ширина экрана в em */
  get wEm { return U.w / U.em; },
  get hEm { return U.h / U.em; },

  font(sizeEm: number, bold?: boolean | number): string {
    const wgt = bold === true? 700: typeof bold === 'number'? bold: 400;
    return wgt + ' ' + (sizeEm * U.em).toFixed(2) + 'px ' + FONT;
  },
};

export function roundRect(c: CanvasRenderingContext2D, l: number, t: number, r: number, b: number, rad: number, color: string) {
  const w = r - l, h = b - t;
  if (w <= 0 || h <= 0) return;
  rad = Math.min(rad, w / 2, h / 2);
  c.fillStyle = color;
  c.beginPath;
  c.moveTo(l + rad, t);
  c.lineTo(r - rad, t);
  c.arcTo(r, t, r, t + rad, rad);
  c.lineTo(r, b - rad);
  c.arcTo(r, b, r - rad, b, rad);
  c.lineTo(l + rad, b);
  c.arcTo(l, b, l, b - rad, rad);
  c.lineTo(l, t + rad);
  c.arcTo(l, t, l + rad, t, rad);
  c.closePath;
  c.fill;
}

export function strokeRoundRect(c: CanvasRenderingContext2D, l: number, t: number, r: number, b: number, rad: number, color: string, width: number) {
  const w = r - l, h = b - t;
  if (w <= 0 || h <= 0) return;
  rad = Math.min(rad, w / 2, h / 2);
  c.strokeStyle = color;
  c.lineWidth = width;
  c.beginPath;
  c.moveTo(l + rad, t);
  c.lineTo(r - rad, t);
  c.arcTo(r, t, r, t + rad, rad);
  c.lineTo(r, b - rad);
  c.arcTo(r, b, r - rad, b, rad);
  c.lineTo(l + rad, b);
  c.arcTo(l, b, l, b - rad, rad);
  c.lineTo(l, t + rad);
  c.arcTo(l, t, l + rad, t, rad);
  c.closePath;
  c.stroke;
}

const ellCache: { [k: string]: string } = {};
let ellCount = 0;

/** Текст в одну строку с вертикальным центром cy, обрезка многоточием (результат кэшируется) */
export function drawText(c: CanvasRenderingContext2D, s: string, x: number, cy: number, width: number) {
  if (width <= 0 ||!s) return;
  c.textBaseline = 'middle';
  let t = s;
  if (c.measureText(s).width > width) {
    const key = c.font + '|' + Math.round(width) + '|' + s;
    let v = ellCache[key];
    if (v === undefined) {
      let lo = 0, hi = s.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (c.measureText(s.substring(0, mid) + '…').width <= width) lo = mid; else hi = mid - 1;
      }
      v = s.substring(0, lo).replace(/\s+$/, '') + '…';
      if (++ellCount > 4000) { for (const k in ellCache) delete ellCache[k]; ellCount = 0; }
      ellCache[key] = v;
    }
    t = v;
  }
  c.fillText(t, x, cy);
}

export { SOFT };
