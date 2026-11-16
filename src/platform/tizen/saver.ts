/** Заставка мешает смотреть: выключить, пока видео играет (требование Samsung к плеерам) */
export function screenSaver(off: boolean) {
  const w: any = window;
  try {
    const ac = w.webapis && w.webapis.appcommon;
    if (ac) ac.setScreenSaver(off ? ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF : ac.AppCommonScreenSaverState.SCREEN_SAVER_ON, function () { /* */ }, function () { /* */ });
  } catch (e) { /* */ }
}
