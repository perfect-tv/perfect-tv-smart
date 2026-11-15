/**
 * «О программе» (Настройки → О программе): ссылки и лицензии — в одном месте.
 * Пустая ссылка — пункта нет. На ТВ ссылку не нажать: окно показывает её QR-кодом (src/ui/about.ts),
 * поэтому адрес — не длиннее ~100 знаков (QR версии 5-L, src/ui/qrcode.ts).
 */
declare const APP_VERSION: string;

export const About = {
  get version(): string { return typeof APP_VERSION === 'string' ? APP_VERSION : ''; },
  /** Исходный код */
  github: '',
  /** Телеграм-канал */
  telegram: '',
  /** Поддержать проект (страница доната) */
  donate: '',
  /** Лицензия Perfect TV (название; текст — в LICENSE репозитория) */
  license: '',
};

/** Сторонний код в сборке и данные: название, версия, лицензия, правообладатель */
export const THIRD_PARTY: { name: string; version: string; license: string; owner: string; url: string }[] = [
  { name: 'hls.js', version: '1.5.20', license: 'Apache License 2.0', owner: 'Brightcove, Dailymotion, contributors', url: 'github.com/video-dev/hls.js' },
  { name: 'fflate', version: '0.8.3', license: 'MIT', owner: 'Arjun Barrett', url: 'github.com/101arrowz/fflate' },
];
