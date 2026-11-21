/** Определяет декодер HLS без обращения к браузеру/настройкам. */
/**
 * Канал с заголовками без прокси: играть встроенным плеером, если он ставит хотя бы один из них
 * (supported — имена в нижнем регистре). lost — заголовки, которые не поставит никто (их — в журнал).
 */
export function headersForNative(h: { [k: string]: string } | null, supported: string[]): { native: boolean; lost: string[] } {
  const lost: string[] = [];
  let native = false;
  if (!h || !supported.length) return { native: false, lost: lost };
  for (const k in h) {
    if (supported.indexOf(k.toLowerCase()) >= 0) native = true; else lost.push(k);
  }
  return { native: native, lost: native ? lost : [] };
}

export function useNativeHls(mode: number, archive: boolean, channelNativeFix: boolean, autoFallback: boolean): boolean {
  if (channelNativeFix) return true;
  if (mode === 1) return true;       // пользователь явно выбрал плеер телевизора
  if (mode === 0) return false;      // пользователь явно выбрал hls.js
  return !archive && !autoFallback; // авто: эфир native, архив hls.js
}

/** Кодек HEVC (hvc1…/hev1…) из строки CODECS варианта; '' — не HEVC */
export function hevcCodec(codecs: string): string {
  const list = String(codecs || '').split(',');
  for (let i = 0; i < list.length; i++) {
    const c = list[i].trim();
    if (/^(hvc1|hev1)\./i.test(c)) return c;
  }
  return '';
}

/**
 * Есть ли в вариантах HEVC и принимает ли его MSE (isSupported — MediaSource.isTypeSupported).
 * codec — первый найденный HEVC-кодек (для журнала и сообщения).
 */
export function hevcSupport(levels: any[], isSupported: (codec: string) => boolean): { found: boolean; supported: boolean; codec: string } {
  let found = false, supported = false, codec = '';
  for (let i = 0; i < (levels ? levels.length : 0); i++) {
    const l = levels[i] || {};
    const attrs = l.attrs || {};
    const c = hevcCodec(l.videoCodec || attrs.CODECS || l.codecs || '');
    if (!c) continue;
    found = true;
    if (!codec) codec = c;
    if (isSupported(c)) supported = true;
  }
  return { found: found, supported: supported, codec: codec };
}
