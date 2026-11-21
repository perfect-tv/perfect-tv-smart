/**
 * «О программе» (Настройки → О программе): ссылки и лицензии — в одном месте.
 * Пустая ссылка — пункта нет. На ТВ ссылку не нажать: окно показывает её QR-кодом (src/ui/about.ts),
 * поэтому адрес — не длиннее ~100 знаков (QR версии 5-L, src/ui/qrcode.ts).
 */
declare const APP_VERSION: string;

export const About = {
  get version(): string { return typeof APP_VERSION === 'string' ? APP_VERSION : ''; },
  /** Исходный код */
  github: 'https://github.com/perfect-tv/perfect-tv-smart',
  /** Телеграм-канал */
  telegram: 'https://t.me/perfect_tv_app',
  /** Поддержать проект (страница доната) */
  donate: 'https://boosty.to/rootu/donate',
  /** Лицензия Perfect TV (название; текст — в LICENSE репозитория) */
  license: 'GNU GPL 3.0',
};

/** Сторонний код в сборке и данные: название, версия, лицензия, правообладатель */
export const THIRD_PARTY: { name: string; version: string; license: string; owner: string; url: string }[] = [
  { name: 'hls.js', version: '1.7.4', license: 'Apache License 2.0', owner: 'Brightcove, Dailymotion, contributors', url: 'github.com/video-dev/hls.js' },
  { name: 'fflate', version: '0.8.3', license: 'MIT', owner: 'Arjun Barrett', url: 'github.com/101arrowz/fflate' },
];
