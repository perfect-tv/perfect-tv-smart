// Точка входа сборки для LG webOS: платформа, затем общее приложение (src/core/app.ts)
import '../../core/polyfills';
import { usePlatform } from '../../core/platform';
import { startApp } from '../../core/app';
import { WebOS } from './webos';

usePlatform(WebOS);
startApp();
