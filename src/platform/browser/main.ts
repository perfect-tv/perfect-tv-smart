// Точка входа сборки для обычного браузера (и ТВ, где приложение — страница по адресу:
// VIDAA, Titan OS, MSX): платформа, затем общее приложение (src/core/app.ts)
import '../../core/polyfills';
import { usePlatform } from '../../core/platform';
import { startApp } from '../../core/app';
import { Browser } from './browser';

usePlatform(Browser);
startApp();
