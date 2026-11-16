import { Gunzip, Unzip, UnzipInflate } from 'fflate';

/**
 * Распаковка потока по сигнатуре первых байтов: 1F 8B — gzip, PK — zip (первый файл),
 * FD 37 7A 58 5A — xz (не поддерживается). Остальное идёт как есть.
 */
export class Unpacker {
  kind: 'plain' | 'gzip' | 'zip' | 'xz' | '' = '';
  private head: Uint8Array | null = null;
  private gz: Gunzip | null = null;
  private zip: Unzip | null = null;
  private zipStarted = false;

  constructor(private out: (b: Uint8Array) => void) {}

  push(chunk: Uint8Array) {
    if (!this.kind) {
      // нужно хотя бы 5 байтов для сигнатуры
      if (this.head) {
        const nb = new Uint8Array(this.head.length + chunk.length);
        nb.set(this.head, 0); nb.set(chunk, this.head.length);
        chunk = nb;
        this.head = null;
      }
      if (chunk.length < 5) { this.head = chunk; return; }
      this.detect(chunk);
    }
    this.feed(chunk, false);
  }

  end() {
    if (!this.kind) {
      const h = this.head || new Uint8Array(0);
      this.head = null;
      if (h.length) { this.detect(h); this.feed(h, true); } else this.kind = 'plain';
      return;
    }
    this.feed(new Uint8Array(0), true);
  }

  private detect(b: Uint8Array) {
    if (b[0] === 0x1f && b[1] === 0x8b) this.kind = 'gzip';
    else if (b[0] === 0x50 && b[1] === 0x4b) this.kind = 'zip';
    else if (b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58 && b[4] === 0x5a) this.kind = 'xz';
    else this.kind = 'plain';
    const out = this.out;
    if (this.kind === 'gzip') this.gz = new Gunzip(function (d) { if (d && d.length) out(d); });
    if (this.kind === 'zip') {
      const self = this;
      this.zip = new Unzip(function (file) {
        if (self.zipStarted) return; // только первый файл
        self.zipStarted = true;
        file.ondata = function (err, d) { if (err) throw err; if (d && d.length) out(d); };
        file.start();
      });
      this.zip.register(UnzipInflate);
    }
    if (this.kind === 'xz') throw new Error('format_xz');
  }

  private feed(b: Uint8Array, final: boolean) {
    if (this.kind === 'gzip') this.gz!.push(b, final);
    else if (this.kind === 'zip') this.zip!.push(b, final);
    else if (b.length) this.out(b);
  }
}
