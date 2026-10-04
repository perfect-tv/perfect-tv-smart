import { str } from '../core/lang';
import { Net } from '../core/net';
import { el, setText } from './dom';
import { PopupLayer } from './popups';
import { drawQr } from './qrcode';
import { U } from './u';

const API = 'http://127.0.0.1:47380/qr/';

interface QrResponse { returnValue?: boolean; url?: string; token?: string; name?: string; ready?: boolean; error?: string }

function get(path: string, cb: (err: string, data: QrResponse | null) => void) {
  const x = new XMLHttpRequest();
  x.open('GET', API + path, true);
  x.timeout = 6000;
  x.onload = function () {
    if (x.status !== 200) { cb('HTTP ' + x.status, null); return; }
    try { cb('', JSON.parse(x.responseText)); } catch (e) { cb('Invalid response', null); }
  };
  x.onerror = function () { cb('Connection failed', null); };
  x.ontimeout = function () { cb('Timeout', null); };
  x.send();
}

/** QR: телефон открывает временную страницу на ТВ, ссылка появляется в настройках. */
export class QrPlaylistLayer extends PopupLayer {
  private status: HTMLElement;
  private address: HTMLElement;
  private qr: HTMLCanvasElement;
  private token = '';
  private closed = false;
  private timer = 0;

  constructor(parent: HTMLElement, private onPlaylist: (url: string, name: string) => void, private onClose: () => void) {
    super(parent, 50, 0.82);
    this.head(null, str('playlist_qr_title'));
    el('div', 'sub', str('playlist_qr_description'), this.win);
    const area = el('div', '', null, this.win);
    area.style.cssText = 'text-align:center;height:' + U.px(21) + 'px';
    this.qr = document.createElement('canvas');
    this.qr.style.cssText = 'display:none;width:' + U.px(18.3) + 'px;height:' + U.px(18.3) + 'px;margin:0 auto;background:white;image-rendering:pixelated';
    area.appendChild(this.qr);
    this.status = el('div', '', str('playlist_qr_starting'), area);
    this.status.style.cssText = 'padding-top:1rem;font-size:1.25rem';
    this.address = el('div', '', '', this.win);
    this.address.style.cssText = 'text-align:center;font-size:1.2rem;overflow-wrap:break-word;word-break:break-all;color:#ddd';
    el('div', 'sub', str('playlist_qr_hint'), this.win).style.cssText = 'margin-top:1.2rem;text-align:center';
    const self = this;
    this.buttons([str('cancel')], function () { self.back(); });
    this.start();
  }

  private start() {
    const self = this;
    Net.checkProxy().then(function (ok) {
      if (self.closed) return;
      if (!ok) {
        setText(self.status, Net.lunaAvailable ? str('playlist_qr_no_http') :
          str('playlist_qr_error') + ': ' + str('proxy_absent'));
        return;
      }
      get('new', function (err, data) {
        if (self.closed) return;
        if (err || !data || !data.returnValue || !data.url || !data.token) {
          setText(self.status, str('playlist_qr_error') + ': ' + (err || (data && data.error) || 'service unavailable'));
          return;
        }
        self.token = data.token;
        try { drawQr(self.qr, data.url); } catch (e) {
          setText(self.status, str('playlist_qr_error'));
          return;
        }
        self.qr.style.display = 'block';
        self.status.style.paddingTop = '0';
        setText(self.status, str('playlist_qr_waiting'));
        setText(self.address, data.url);
        self.poll();
      });
    });
  }

  private poll() {
    if (this.closed || !this.token) return;
    const self = this;
    get('status?token=' + encodeURIComponent(this.token), function (err, data) {
      if (self.closed) return;
      if (!err && data && data.returnValue && data.ready && data.url) {
        self.closed = true;
        self.cancelRemote();
        self.onClose();
        self.onPlaylist(data.url, data.name || str('playlist'));
        return;
      }
      if (err || !data || !data.returnValue) {
        setText(self.status, str('playlist_qr_error') + ': ' + (err || (data && data.error) || 'expired'));
        return;
      }
      self.timer = window.setTimeout(function () { self.poll(); }, 1200);
    });
  }

  private cancelRemote() {
    if (this.token) get('cancel?token=' + encodeURIComponent(this.token), function () { /* */ });
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
