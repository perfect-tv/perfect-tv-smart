import { str } from '../lang';
import { platform, QrKind } from '../platform';
import { el, setText } from './dom';
import { PopupLayer } from './popups';
import { drawQr } from './qrcode';
import { U } from './u';

/** QR: телефон открывает временную страницу на ТВ, ссылка появляется в настройках. */
export class QrPlaylistLayer extends PopupLayer {
  private status: HTMLElement;
  private address: HTMLElement;
  private hint: HTMLElement;
  private qr: HTMLCanvasElement;
  private token = '';
  private closed = false;
  private timer = 0;

  /** kind 'epg' — ждём адрес программы XMLTV (onPlaylist получит его, название пустое) */
  constructor(parent: HTMLElement, private onPlaylist: (url: string, name: string) => void, private onClose: () => void, private kind: QrKind = 'playlist') {
    super(parent, 50, 0.82);
    this.head(null, str(kind === 'epg' ? 'epg_qr_title' : 'playlist_qr_title'));
    el('div', 'sub', str(kind === 'epg' ? 'epg_qr_description' : 'playlist_qr_description'), this.win);
    const area = el('div', '', null, this.win);
    area.style.cssText = 'text-align:center;height:' + U.px(21) + 'px';
    this.qr = document.createElement('canvas');
    this.qr.style.cssText = 'display:none;width:' + U.px(18.3) + 'px;height:' + U.px(18.3) + 'px;margin:0 auto;background:white;image-rendering:pixelated';
    area.appendChild(this.qr);
    this.status = el('div', '', str('playlist_qr_starting'), area);
    this.status.style.cssText = 'padding-top:1rem;font-size:1.25rem';
    this.address = el('div', '', '', this.win);
    this.address.style.cssText = 'text-align:center;font-size:1.2rem;overflow-wrap:break-word;word-break:break-all;color:#ddd';
    this.hint = el('div', 'sub', str('playlist_qr_hint'), this.win);
    this.hint.style.cssText = 'margin-top:1.2rem;text-align:center';
    const self = this;
    this.buttons([str('cancel')], function () { self.back(); });
    this.start();
  }

  private start() {
    const self = this;
    const qr = platform().qr;
    if (!qr) { setText(this.status, str('playlist_qr_error')); return; }
    qr.open(this.kind).then(function (d) {
      if (self.closed) { qr.cancel(d.token); return; }
      self.token = d.token;
      if (d.hint) setText(self.hint, str(d.hint));
      try { drawQr(self.qr, d.url); } catch (e) {
        setText(self.status, str('playlist_qr_error'));
        return;
      }
      self.qr.style.display = 'block';
      self.status.style.paddingTop = '0';
      setText(self.status, str('playlist_qr_waiting'));
      setText(self.address, d.url);
      self.poll();
    }, function (e: any) { self.fail(e); });
  }

  private fail(e: any) {
    if (this.closed) return;
    const msg = e && e.message ? e.message : String(e);
    setText(this.status, e && e.whole ? msg : str('playlist_qr_error') + ': ' + msg);
  }

  private poll() {
    if (this.closed || !this.token) return;
    const self = this;
    platform().qr!.poll(this.token).then(function (got) {
      if (self.closed) return;
      if (got) {
        self.closed = true;
        self.cancelRemote();
        self.onClose();
        self.onPlaylist(got.url, self.kind === 'epg' ? '' : got.name || str('playlist'));
        return;
      }
      self.timer = window.setTimeout(function () { self.poll(); }, 1200);
    }, function (e) { self.fail(e); });
  }

  private cancelRemote() {
    const qr = platform().qr;
    if (this.token && qr) qr.cancel(this.token);
  }

  enter() { this.back(); }
  back() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.cancelRemote();
    this.onClose();
  }
  destroy() {
    this.closed = true;
    clearTimeout(this.timer);
    this.cancelRemote();
  }
}
