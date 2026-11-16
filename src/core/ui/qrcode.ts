/**
 * Самодостаточный QR Code, версия 5-L (37x37, до 106 байт в byte mode).
 * URL локальной страницы передачи плейлиста состоит только из ASCII.
 * Никаких сетевых QR API: адрес ТВ и одноразовый токен остаются в домашней сети.
 */
const SIZE = 37;
const DATA_BYTES = 108;
const ECC_BYTES = 26;

function multiply(a: number, b: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((b >>> i) & 1) * a;
  }
  return z;
}

function ecc(data: number[]): number[] {
  const div: number[] = [];
  for (let i = 0; i < ECC_BYTES; i++) div.push(0);
  div[ECC_BYTES - 1] = 1;
  let root = 1;
  for (let i = 0; i < ECC_BYTES; i++) {
    for (let j = 0; j < ECC_BYTES; j++) {
      div[j] = multiply(div[j], root);
      if (j + 1 < ECC_BYTES) div[j] ^= div[j + 1];
    }
    root = multiply(root, 2);
  }
  const rem: number[] = [];
  for (let i = 0; i < ECC_BYTES; i++) rem.push(0);
  for (let i = 0; i < data.length; i++) {
    const f = data[i] ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let j = 0; j < ECC_BYTES; j++) rem[j] ^= multiply(div[j], f);
  }
  return rem;
}

/** Генерация битовой матрицы QR, 1 — тёмный модуль. */
export function qrMatrix(text: string): boolean[][] {
  if (text.length > 106) throw new Error('QR URL too long');
  const bits: number[] = [];
  function add(v: number, width: number) {
    for (let i = width - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  }
  add(4, 4);  // byte mode
  add(text.length, 8);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) throw new Error('QR supports ASCII URLs only');
    add(c, 8);
  }
  for (let i = 0; i < 4 && bits.length < DATA_BYTES * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  while (data.length < DATA_BYTES) data.push((data.length % 2) ? 0x11 : 0xEC);
  const codewords = data.concat(ecc(data));

  const m: boolean[][] = [];
  const fn: boolean[][] = [];
  for (let y = 0; y < SIZE; y++) {
    m.push([]); fn.push([]);
    for (let x = 0; x < SIZE; x++) { m[y].push(false); fn[y].push(false); }
  }
  function set(x: number, y: number, black: boolean) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    m[y][x] = black;
    fn[y][x] = true;
  }
  function finder(cx: number, cy: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const r = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, r !== 2 && r !== 4);
      }
    }
  }
  for (let i = 0; i < SIZE; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  finder(3, 3); finder(SIZE - 4, 3); finder(3, SIZE - 4);
  // Для версии 5 одна дополнительная метка выравнивания — (30,30).
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    set(30 + dx, 30 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  function format(mask: number) {
    // Уровень коррекции L = 01, данные формата + BCH(15,5).
    const value = (1 << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((value << 10) | rem) ^ 0x5412;
    function b(i: number) { return ((f >>> i) & 1) !== 0; }
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(SIZE - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, SIZE - 15 + i, b(i));
    set(8, SIZE - 8, true);
  }
  format(0); // сначала резервируем места под формат
  let bit = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < SIZE; vert++) {
      const y = ((right + 1) & 2) === 0 ? SIZE - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx;
        if (fn[y][x]) continue;
        if (bit < codewords.length * 8) m[y][x] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) !== 0;
        bit++;
      }
    }
  }
  if (bit < codewords.length * 8) throw new Error('QR capacity error');
  // Маска 0 (шахматная, определена спецификацией QR).
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (!fn[y][x] && (x + y) % 2 === 0) m[y][x] = !m[y][x];
  }
  format(0);
  return m;
}

/** Контрастный canvas с обязательной белой рамкой (quiet zone 4 модуля). */
export function drawQr(canvas: HTMLCanvasElement, url: string) {
  const q = qrMatrix(url);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  const step = 8;
  const padding = 4;
  canvas.width = canvas.height = (SIZE + padding * 2) * step;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (q[y][x]) ctx.fillRect((x + padding) * step, (y + padding) * step, step, step);
  }
}
