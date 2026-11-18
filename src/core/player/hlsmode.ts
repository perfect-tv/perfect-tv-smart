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
