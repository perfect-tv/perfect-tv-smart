// Недостающее в Chromium 38 (webOS 3). Только то, чем пользуется код приложения.
/* eslint-disable */
declare var global: any;

const AP: any = Array.prototype;
const SP: any = String.prototype;
const O: any = Object;

if (!O.assign) {
  O.assign = function (t: any) {
    for (let i = 1; i < arguments.length; i++) {
      const s = arguments[i];
      if (s) for (const k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  };
}
if (!O.values) O.values = function (o: any) { const r: any[] = []; for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r.push(o[k]); return r; };
if (!O.entries) O.entries = function (o: any) { const r: any[] = []; for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r.push([k, o[k]]); return r; };
if (!AP.find) AP.find = function (f: any, t?: any) { for (let i = 0; i < this.length; i++) if (f.call(t, this[i], i, this)) return this[i]; return undefined; };
if (!AP.findIndex) AP.findIndex = function (f: any, t?: any) { for (let i = 0; i < this.length; i++) if (f.call(t, this[i], i, this)) return i; return -1; };
if (!AP.includes) AP.includes = function (v: any) { return this.indexOf(v) >= 0; };
if (!AP.fill) AP.fill = function (v: any, s?: number, e?: number) { const n = this.length; for (let i = s || 0; i < (e === undefined ? n : e); i++) this[i] = v; return this; };
if (!(Array as any).from) {
  (Array as any).from = function (src: any, map?: any) {
    const r: any[] = [];
    if (src == null) return r;
    if (typeof src.length === 'number') { for (let i = 0; i < src.length; i++) r.push(map ? map(src[i], i) : src[i]); return r; }
    if (typeof src.forEach === 'function') src.forEach(function (v: any) { r.push(map ? map(v, r.length) : v); });
    return r;
  };
}
if (!(Array as any).of) (Array as any).of = function () { return AP.slice.call(arguments); };
if (!SP.startsWith) SP.startsWith = function (s: string, p?: number) { p = p || 0; return this.substr(p, s.length) === s; };
if (!SP.endsWith) SP.endsWith = function (s: string) { return this.length >= s.length && this.substr(this.length - s.length) === s; };
if (!SP.includes) SP.includes = function (s: string, p?: number) { return this.indexOf(s, p || 0) >= 0; };
if (!SP.repeat) SP.repeat = function (n: number) { let r = ''; for (let i = 0; i < n; i++) r += this; return r; };
if (!SP.padStart) SP.padStart = function (n: number, c?: string) { let s = String(this); c = c || ' '; while (s.length < n) s = c + s; return s.slice(-n); };
if (!SP.trimEnd) SP.trimEnd = function () { return this.replace(/\s+$/, ''); };
if (!(Number as any).isFinite) (Number as any).isFinite = function (v: any) { return typeof v === 'number' && isFinite(v); };
if (!(Number as any).isNaN) (Number as any).isNaN = function (v: any) { return v !== v; };
if (!(Math as any).sign) (Math as any).sign = function (x: number) { return x > 0 ? 1 : x < 0 ? -1 : x; };
if (!(Math as any).trunc) (Math as any).trunc = function (x: number) { return x < 0 ? Math.ceil(x) : Math.floor(x); };
if (!(Math as any).log10) (Math as any).log10 = function (x: number) { return Math.log(x) / Math.LN10; };
// Uint8Array.prototype.slice/indexOf появились в Chromium 45
const UP: any = Uint8Array.prototype;
if (!UP.slice) UP.slice = function (s: number, e?: number) { return new Uint8Array(this.subarray(s, e)); };
if (!UP.indexOf) UP.indexOf = function (v: number, f?: number) { for (let i = f || 0; i < this.length; i++) if (this[i] === v) return i; return -1; };
if (!UP.fill) UP.fill = function (v: number, s?: number, e?: number) { for (let i = s || 0; i < (e === undefined ? this.length : e); i++) this[i] = v; return this; };

export {};
