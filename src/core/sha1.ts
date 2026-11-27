import { utf8 } from './sha256';

/**
 * SHA-1 строки в UTF-8 (шестнадцатеричная) — `prehash` для Stalker/MAG.
 * Свой: WebCrypto на webOS 3 (Chromium 38) и в пакете со схемой file:// бывает недоступен.
 */
export function sha1(s: string): string {
  const b = utf8(s);
  const n = b.length;
  const words = ((n + 9 + 63) >> 6) << 4;
  const w = new Int32Array(words);
  for (let i = 0; i < n; i++) w[i >> 2] |= b[i] << (24 - (i & 3) * 8);
  w[n >> 2] |= 0x80 << (24 - (n & 3) * 8);
  w[words - 1] = n * 8;
  w[words - 2] = Math.floor(n / 0x20000000);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const m = new Int32Array(80);
  for (let off = 0; off < words; off += 16) {
    for (let i = 0; i < 16; i++) m[i] = w[off + i];
    for (let i = 16; i < 80; i++) {
      const x = m[i - 3] ^ m[i - 8] ^ m[i - 14] ^ m[i - 16];
      m[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (bb & c) | (~bb & d); k = 0x5a827999; }
      else if (i < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = bb ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + m[i]) | 0;
      e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  let out = '';
  const parts = [h0, h1, h2, h3, h4];
  for (let i = 0; i < parts.length; i++) out += ('00000000' + (parts[i] >>> 0).toString(16)).slice(-8);
  return out;
}
