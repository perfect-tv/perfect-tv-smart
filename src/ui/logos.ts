import { NUMBER_BADGE, Prefs } from '../core/prefs';
import { Storage2 } from '../core/storage';
import { Channel } from '../data/models';
import { Names } from '../data/names';
import { el } from './dom';
import { C, drawText, roundRect, U } from './u';

/**
 * Логотипы каналов («Логотипы»): серая подложка, логотип с отступом 14% высоты,
 * бейдж номера в левом верхнем углу; нет логотипа или не загрузился — цветная плашка с монограммой.
 * Адреса по приоритету (Channel.logoUrls), неудачные запоминаются: 12 ч (между запусками),
 * без сети — 3 мин. Картинки — в памяти (LRU), для Canvas и DOM одни и те же.
 */
interface Entry { img: HTMLImageElement; state: 0 | 1 | 2; waiters: ( => void)[] }

const MAX = 400;
const MAX_FAILED = 150; // Список недоступных URL не должен заполнить localStorage на webOS
const cache: { [url: string]: Entry } = {};
const order: string[] = [];
let failed: { [url: string]: number } = Storage2.json<{ [url: string]: number }>('logo_failed', {});
let onLoad: ( => void) | null = null;
let redrawQueued = false;

function now { return Date.now; }
function isFailed(u: string) { const t = failed[u]; return t!== undefined && t > now; }
function markFailed(u: string) {
  const online = typeof navigator === 'undefined' || navigator.onLine!== false;
  failed[u] = now + (online? 12 * 3600 * 1000: 3 * 60 * 1000);
  if (online) {
    // Устаревшие и самые старые — долой; URL логотипов могут быть длинными.
    const active: string[] = [];
    for (const k in failed) {
      if (failed[k] < now) delete failed[k]; else active.push(k);
    }
    if (active.length > MAX_FAILED) {
      active.sort(function (a, b) { return failed[a] - failed[b]; });
      for (let i = 0; i < active.length - MAX_FAILED; i++) delete failed[active[i]];
    }
    Storage2.setJson('logo_failed', failed);
  }
}

function touch(u: string) {
  const i = order.indexOf(u);
  if (i >= 0) order.splice(i, 1);
  order.push(u);
  while (order.length > MAX) {
    const old = order.shift!;
    const e = cache[old];
    if (e && e.state!== 0) delete cache[old];
  }
}

/** Картинка по адресу: загружена — img, грузится или не загрузилась — null */
function get(u: string, cb?:  => void): HTMLImageElement | null {
  let e = cache[u];
  if (!e) {
    const img = new Image;
    e = { img: img, state: 0, waiters: [] };
    cache[u] = e;
    const entry = e;
    img.onload = function  {
      entry.state = img.naturalWidth > 0? 1: 2;
      if (entry.state === 2) markFailed(u);
      flush(entry);
    };
    img.onerror = function  { entry.state = 2; markFailed(u); flush(entry); };
    img.src = u;
  }
  touch(u);
  if (e.state === 1) return e.img;
  if (e.state === 0 && cb && e.waiters.indexOf(cb) < 0) e.waiters.push(cb);
  return null;
}

function flush(e: Entry) {
  const w = e.waiters.splice(0, e.waiters.length);
  for (let i = 0; i < w.length; i++) w[i];
  if (onLoad &&!redrawQueued) {
    redrawQueued = true;
    setTimeout(function  { redrawQueued = false; if (onLoad) onLoad; }, 50);
  }
}

/** Адрес, который стоит пробовать: первый не числящийся неудачным */
function urlFor(ch: Channel): string {
  const urls = ch.logoUrls;
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    const e = cache[u];
    if (e && e.state === 2) continue;
    if (isFailed(u)) continue;
    return u;
  }
  return '';
}

/** Цвет плашки монограммы: приглушённый, от ключа канала */
export function monoColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return 'hsl(' + hue + ',32%,32%)';
}

export const Logos = {
  /** Перерисовка Canvas, когда картинка загрузилась */
  setOnLoad(f:  => void) { onLoad = f; },

  clearFailed {
    failed = {};
    Storage2.remove('logo_failed');
    for (const k in cache) if (cache[k].state === 2) delete cache[k];
  },

  /** Загруженная картинка канала, null — нет (монограмма) или грузится */
  image(ch: Channel): HTMLImageElement | null {
    const u = urlFor(ch);
    return u? get(u): null;
  },

  /** Будет ли картинка (есть адрес, не числящийся неудачным) */
  hasLogo(ch: Channel): boolean { return urlFor(ch)!== ''; },

  /**
   * Логотип на Canvas: подложка (fill_soft или logo_plate на белом), картинка с отступом 14%
   * высоты (вписать), без картинки — монограмма; бейдж номера (настройка «Номер канала»).
   */
  draw(c: CanvasRenderingContext2D, ch: Channel, l: number, t: number, w: number, h: number, opts?: { focused?: boolean; badge?: boolean; plate?: string }) {
    const o = opts || {};
    const rad = U.px(0.4);
    const img = Logos.image(ch);
    const has = Logos.hasLogo(ch);
    if (!img &&!has) {
      roundRect(c, l, t, l + w, t + h, rad, monoColor(ch.key));
      c.fillStyle = C.WHITE;
      c.textAlign = 'center';
      c.font = U.font(Math.min(h / U.em * 0.42, 1.6), true);
      drawText(c, Names.monogram(ch.name), l + w / 2, t + h / 2 + U.px(0.05), w - U.px(0.4));
      c.textAlign = 'left';
    } else {
      roundRect(c, l, t, l + w, t + h, rad, o.plate || (o.focused? C.LOGO_PLATE: C.FILL_SOFT));
      if (img) {
        const pad = h * 0.14;
        const bw = w - pad * 2, bh = h - pad * 2;
        const k = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
        const iw = img.naturalWidth * k, ih = img.naturalHeight * k;
        try { c.drawImage(img, l + (w - iw) / 2, t + (h - ih) / 2, iw, ih); } catch (e) { /* */ }
      }
    }
    if (o.badge!== false && Prefs.numberMode === NUMBER_BADGE) {
      c.font = U.font(Math.max(0.9, Math.min(1.1, h / U.em * 0.3)), 700);
      const s = String(ch.num);
      const bw = c.measureText(s).width + U.px(0.6);
      const bh = U.px(Math.max(1.3, Math.min(1.6, h / U.em * 0.42)));
      roundRect(c, l, t, l + bw, t + bh, rad, 'rgba(26,27,28,0.78)');
      c.fillStyle = C.t(0.9);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(s, l + bw / 2, t + bh / 2 + U.px(0.05));
      c.textAlign = 'left';
    }
  },

  /** Логотип в DOM: <div class="logo"> с картинкой или монограммой и бейджем номера */
  el(ch: Channel, cls?: string, badge = true): HTMLElement {
    const box = el('div', 'logo' + (cls? ' ' + cls: ''));
    Logos.fill(box, ch, badge);
    return box;
  },

  fill(box: HTMLElement, ch: Channel, badge = true) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.style.background = '';
    const u = urlFor(ch);
    const mono = function  {
      box.style.background = monoColor(ch.key);
      while (box.firstChild) box.removeChild(box.firstChild);
      el('span', 'mono', Names.monogram(ch.name), box);
      addBadge;
    };
    const addBadge = function  {
      if (badge && Prefs.numberMode === NUMBER_BADGE) el('span', 'num', String(ch.num), box);
    };
    if (!u) { mono; return; }
    const img = get(u, function  {
      const e = cache[u];
      if (e && e.state === 1 && box.getAttribute('data-k') === ch.key) Logos.fill(box, ch, badge);
      else if (box.getAttribute('data-k') === ch.key) Logos.fill(box, ch, badge);
    });
    box.setAttribute('data-k', ch.key);
    if (img) {
      const i = document.createElement('img');
      i.src = u;
      box.appendChild(i);
    }
    addBadge;
  },

  /** Картинка передачи (EPG/TMDB) в контейнер; не загрузилась — fallback */
  banner(box: HTMLElement, url: string, fallback:  => void) {
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!url || isFailed(url)) { fallback; return; }
    const i = document.createElement('img');
    i.className = 'cover';
    i.onerror = function  { markFailed(url); fallback; };
    i.src = url;
    box.appendChild(i);
  },
};
