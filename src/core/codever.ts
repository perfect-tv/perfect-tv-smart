/**
 * Обновление кода без переустановки (docs/TZ.md, «Обновление без переустановки»): общие правила
 * загрузчика оболочки (src/loader/loader.ts) и проверки обновлений (core/codeupdate.ts).
 */

/**
 * Протокол оболочки: что загрузчик умеет. Код с сайта объявляет нужный ему минимум (`shell` в
 * version.json); больше, чем у оболочки, — нужна переустановка пакета. Повышать, когда меняется
 * то, чего скачанный код ждёт от оболочки (API window.ptvLoader, файлы в пакете, права в config.xml).
 */
export const SHELL = 1;

/** Файлы кода в порядке запуска (их и скачивает проверка обновлений) */
export const CODE_FILES = ['hls.min.js', 'app.js'];

/** Скачанный код: запись в IndexedDB загрузчика */
export interface CodeRecord {
  version: string;
  /** Нужный коду протокол оболочки и API сервиса webOS */
  shell: number;
  service: number;
  files: { [name: string]: string };
  saved: number;
}

/** version.json на сайте рядом с кодом платформы */
export interface CodeManifest {
  version: string;
  shell: number;
  service: number;
  files: { [name: string]: { sha256: string; size: number } };
}

/** Сравнение версий «1.2.10»: −1, 0, 1 */
export function compareVersions(a: string, b: string): number {
  const x = String(a || '').split('.'), y = String(b || '').split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = parseInt(x[i] || '0', 10) || 0, q = parseInt(y[i] || '0', 10) || 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Запускать ли скачанный код: он целый, подходит оболочке, не падал при запуске и новее
 * встроенного (пакет переустановили более новым — встроенный главнее).
 */
export function useDownloaded(rec: CodeRecord | null, shell: number, builtin: string, bad: string[]): boolean {
  if (!rec || !rec.version || !rec.files) return false;
  if ((rec.shell || 0) > shell) return false;
  if (bad.indexOf(rec.version) >= 0) return false;
  for (let i = 0; i < CODE_FILES.length; i++) if (typeof rec.files[CODE_FILES[i]] !== 'string' || !rec.files[CODE_FILES[i]]) return false;
  return compareVersions(rec.version, builtin) > 0;
}

/** Почему версию с сайта не поставить: '' — можно; 'same' — не новее; 'shell' / 'service' — нужен новый пакет; 'bad' — уже падала */
export function manifestVerdict(m: CodeManifest, running: string, shell: number, service: number, bad: string[]): string {
  if (!m || !m.version || compareVersions(m.version, running) <= 0) return 'same';
  if ((m.shell || 0) > shell) return 'shell';
  if ((m.service || 0) > service) return 'service';
  if (bad.indexOf(m.version) >= 0) return 'bad';
  return '';
}
