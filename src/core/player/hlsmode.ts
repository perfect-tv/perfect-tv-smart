/** Определяет декодер HLS без обращения к браузеру/настройкам. */
export function useNativeHls(mode: number, archive: boolean, channelNativeFix: boolean, autoFallback: boolean): boolean {
  if (channelNativeFix) return true;
  if (mode === 1) return true;       // пользователь явно выбрал плеер телевизора
  if (mode === 0) return false;      // пользователь явно выбрал hls.js
  return !archive && !autoFallback; // авто: эфир native, архив hls.js
}
