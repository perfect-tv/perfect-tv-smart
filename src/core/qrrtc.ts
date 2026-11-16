import { Net } from './net';
import { QrInbox, QrKind } from './platform';

/**
 * Плейлист с телефона по QR без своего сервера на ТВ — через WebRTC (браузер, Tizen; на webOS —
 * не нужен: там страницу для телефона отдаёт сервис). ТВ показывает QR со ссылкой на страницу
 * perfect-tv.github.io/send/#<id>.<ключ>[.e — программа XMLTV][.s — только https://, Net.httpsOnly]; телефон через сервер сигнализации передаёт ТВ предложение
 * соединения (SDP), ТВ отвечает, и ссылка на плейлист идёт напрямую телефон → ТВ по каналу данных
 * WebRTC (шифрование DTLS). Сервер сигнализации видит только SDP, не ссылку (в ней часто логин
 * провайдера). Сигнализация — публичный ntfy.sh (pub/sub по HTTP с CORS): ТВ слушает тему <id> по
 * WebSocket, телефон — свою тему; сообщения — POST с ?cache=no (сервер их не хранит, только
 * передаёт подписчику), простой запрос без предварительного OPTIONS. Облачный PeerJS не подошёл:
 * закрывал соединение на любое пересылаемое сообщение. STUN — Google (связь вне одной сети).
 * Старые движки (Chromium 38): webkitRTCPeerConnection и вызовы с callback — их и используем.
 */
const SIGNAL = 'ntfy.sh';
export const SEND_PAGE = 'https://perfect-tv.github.io/send/';
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const TTL = 5 * 60 * 1000;

const w: any = typeof window !== 'undefined' ? window : {};

function rtcCtor(): any { return w.RTCPeerConnection || w.webkitRTCPeerConnection || null; }

export function rtcAvailable(): boolean {
  return !!rtcCtor() && typeof w.WebSocket !== 'undefined';
}

function rand(n: number): string {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const c: any = w.crypto && w.crypto.getRandomValues ? w.crypto.getRandomValues(new Uint8Array(n)) : null;
  for (let i = 0; i < n; i++) s += abc.charAt((c ? c[i] : Math.floor(Math.random() * 256)) % abc.length);
  return s;
}

/**
 * Вызов RTCPeerConnection. Без префикса (Chromium 56+) — Promise; с префиксом (Chromium 38–55, webOS 3/4)
 * — только callback: смешивать нельзя (новый Chrome с callback ещё и возвращает Promise, и тот
 * срабатывает раньше callback с пустым значением).
 */
const PROMISES = !!w.RTCPeerConnection;
function rtc(pc: any, method: string, arg?: any): Promise<any> {
  if (PROMISES) return arg === undefined ? pc[method]() : pc[method](arg);
  return new Promise(function (resolve, reject) {
    try {
      if (arg === undefined) pc[method](resolve, reject);
      else pc[method](arg, resolve, reject);
    } catch (e) { reject(e); }
  });
}

function sessionDesc(d: any): any {
  const C = w.RTCSessionDescription || w.webkitRTCSessionDescription;
  return C ? new C(d) : d;
}

/** Все кандидаты ICE собраны (одно сообщение вместо потока) — или 3 с */
function gathered(pc: any): Promise<void> {
  return new Promise<void>(function (resolve) {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const t = setTimeout(resolve, 3000);
    pc.onicecandidate = function (e: any) { if (!e.candidate) { clearTimeout(t); resolve(); } };
  });
}

interface Session {
  id: string; key: string; ws: WebSocket; pc: any; started: number;
  got: { url: string; name: string } | null; error: string;
}

const sessions: { [id: string]: Session } = {};

function close(s: Session) {
  try { s.ws.close(); } catch (e) { /* */ }
  try { if (s.pc) s.pc.close(); } catch (e) { /* */ }
  delete sessions[s.id];
}

/** Сообщение в тему ntfy: простой POST (text/plain) — без предварительного OPTIONS */
function publish(topic: string, data: any) {
  const x = new XMLHttpRequest();
  x.open('POST', 'https://' + SIGNAL + '/' + topic + '?cache=no', true);
  x.setRequestHeader('Content-Type', 'text/plain');
  x.onerror = function () { console.warn('qr rtc: publish failed'); };
  x.send(JSON.stringify(data));
}

function onOffer(s: Session, from: string, offer: any) {
  const PC = rtcCtor();
  try { if (s.pc) s.pc.close(); } catch (e) { /* */ }
  const pc = new PC({ iceServers: ICE });
  s.pc = pc;
  pc.ondatachannel = function (ev: any) {
    const ch = ev.channel;
    ch.onmessage = function (m: any) {
      let d: any = null;
      try { d = JSON.parse(m.data); } catch (e) { return; }
      if (!d || d.k !== s.key || typeof d.url !== 'string' || !/^https?:\/\//i.test(d.url)) {
        try { ch.send(JSON.stringify({ ok: false })); } catch (e) { /* */ }
        return;
      }
      s.got = { url: d.url, name: typeof d.name === 'string' ? d.name : '' };
      try { ch.send(JSON.stringify({ ok: true })); } catch (e) { /* */ }
      console.log('qr rtc: playlist received');
    };
  };
  rtc(pc, 'setRemoteDescription', sessionDesc(offer)).then(function () {
    return rtc(pc, 'createAnswer');
  }).then(function (answer: any) {
    return rtc(pc, 'setLocalDescription', answer);
  }).then(function () {
    return gathered(pc);
  }).then(function () {
    const d = pc.localDescription;
    console.log('qr rtc: answer sent');
    publish(from, { t: 'answer', sdp: { type: d.type, sdp: d.sdp } });
  }, function (e: any) {
    console.warn('qr rtc: answer', e && (e.message || e.name || e));
  });
}

export const RtcQr: QrInbox = {
  open(kind?: QrKind) {
    return new Promise(function (resolve, reject) {
      const id = 'ptv-' + rand(20), key = rand(10);
      let ws: WebSocket;
      try { ws = new WebSocket('wss://' + SIGNAL + '/' + id + '/ws'); }
      catch (e) { reject(new Error('signaling')); return; }
      const s: Session = { id: id, key: key, ws: ws, pc: null, started: Date.now(), got: null, error: '' };
      let opened = false;
      const t = setTimeout(function () { if (!opened) { close(s); reject(new Error('signaling timeout')); } }, 10000);
      ws.onmessage = function (e: MessageEvent) {
        let m: any = null;
        try { m = JSON.parse(e.data); } catch (er) { return; }
        if (m.event === 'open' && !opened) {
          opened = true;
          clearTimeout(t);
          sessions[id] = s;
          console.log('qr rtc: waiting', id);
          resolve({ url: SEND_PAGE + '#' + id + '.' + key + (kind === 'epg' ? '.e' : '') + (Net.httpsOnly() ? '.s' : ''), token: id, hint: 'playlist_qr_hint_rtc' });
        } else if (m.event === 'message' && m.message) {
          let d: any = null;
          try { d = JSON.parse(m.message); } catch (er) { return; }
          if (d && d.t === 'offer' && d.sdp && typeof d.from === 'string' && /^ptvp-[a-z0-9]+$/.test(d.from)) {
            console.log('qr rtc: offer');
            onOffer(s, d.from, d.sdp);
          }
        }
      };
      ws.onerror = function () { if (!opened) { clearTimeout(t); close(s); reject(new Error('signaling')); } };
      ws.onclose = function (e: any) {
        if (!s.got) s.error = s.error || 'closed';
        console.log('qr rtc: signaling closed', e && e.code);
      };
    });
  },
  poll(token) {
    const s = sessions[token];
    if (!s) return Promise.reject(new Error('expired'));
    if (s.got) { const g = s.got; close(s); return Promise.resolve(g); }
    if (Date.now() - s.started > TTL) { close(s); return Promise.reject(new Error('expired')); }
    if (s.error && !s.pc) { close(s); return Promise.reject(new Error(s.error)); }
    return Promise.resolve(null);
  },
  cancel(token) { const s = sessions[token]; if (s) close(s); },
};
