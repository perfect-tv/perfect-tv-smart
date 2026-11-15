import en from '../../strings/en.json';
import ru from '../../strings/ru.json';

/**
 * Языки интерфейса — единственное место регистрации. Новый язык: файл strings/<код>.json
 * (код — ISO 639-1: de, uk, pl…) и строка здесь; проще всего — `npm run i18n -- add <код> <название>`
 *  Английский — основа: чего нет в переводе, берётся из него.
 */
export const LANGS: { [code: string]: { [key: string]: any } } = {
  en: en,
  ru: ru,
};
