import { str } from '../core/lang';
import { About, THIRD_PARTY } from '../core/about';
import { el } from './dom';
import { PopupLayer, Scroller } from './popups';
import { drawQr } from './qrcode';
import { U } from './u';

/** Ссылка QR-кодом: на ТВ её не открыть — навести камеру телефона */
export class QrLinkLayer extends PopupLayer {
  constructor(parent: HTMLElement, title: string, url: string, private onClose: () => void) {
    super(parent, 40);
    this.head(null, title);
    const area = el('div', '', null, this.win);
    area.style.cssText = 'text-align:center;padding:0.6rem 0 0.4rem';
    const qr = document.createElement('canvas');
    qr.style.cssText = 'width:' + U.px(16) + 'px;height:' + U.px(16) + 'px;margin:0 auto;display:block;background:white;image-rendering:pixelated';
    area.appendChild(qr);
    try { drawQr(qr, url); } catch (e) { qr.style.display = 'none'; }
    const a = el('div', '', url.replace(/^https?:\/\//, ''), this.win);
    a.style.cssText = 'text-align:center;font-size:1.3rem;margin-top:0.8rem;overflow-wrap:break-word;word-break:break-all';
    el('div', 'sub', str('about_scan_hint'), this.win).style.cssText = 'text-align:center;margin-top:0.6rem';
    const self = this;
    this.select(this.buttons([str('close')], function () { self.onClose(); }), 0);
    this.center();
  }
  key() { /* одна кнопка */ }
  enter() { this.onClose(); }
  back() { this.onClose(); }
}

/** Лицензии: Perfect TV, сторонний код в сборке, данные TMDB. ↑/↓ — прокрутка */
export class LicensesLayer extends PopupLayer {
  private scroller: Scroller;
  constructor(parent: HTMLElement, private onClose: () => void) {
    super(parent, 56, 0.8);
    this.head(null, str('about_licenses'));
    this.scroller = new Scroller(this.win, U.h * 0.8 - U.px(6), 'rgba(30,31,32,.94)');
    const col = this.scroller.inner;
    const block = function (title: string, lines: string[]) {
      el('div', 'gl', title, col).style.paddingLeft = '0';
      for (let i = 0; i < lines.length; i++) {
        const p = el('div', 't75', lines[i], col);
        p.style.cssText = 'font-size:1.25rem;line-height:1.8rem;margin-bottom:0.3rem;white-space:pre-line';
      }
    };
    block('Perfect TV ' + About.version, [
      About.license ? str('about_license_app', About.license) : str('about_license_app_none'),
      About.github ? About.github.replace(/^https?:\/\//, '') : '',
    ].filter(function (s) { return !!s; }));
    for (let i = 0; i < THIRD_PARTY.length; i++) {
      const t = THIRD_PARTY[i];
      block(t.name + ' ' + t.version, [t.license + ' · © ' + t.owner, t.url]);
    }
    block('TMDB', [str('about_tmdb')]);
    block(str('about_trademarks_title'), [str('about_trademarks')]);
    this.scroller.scrollTo(0);
  }
  key(name: string) {
    const page = this.scroller.box.clientHeight - U.px(3);
    if (name === 'up') this.scroller.by(-U.px(3));
    else if (name === 'down') this.scroller.by(U.px(3));
    else if (name === 'pgup') this.scroller.by(-page);
    else if (name === 'pgdown') this.scroller.by(page);
  }
  wheel(dy: number) { this.scroller.by(dy > 0 ? U.px(4) : -U.px(4)); }
  enter() { this.onClose(); }
  back() { this.onClose(); }
}
