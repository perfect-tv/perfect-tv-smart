// Точка входа сборки для Samsung Tizen: платформа, затем общее приложение (src/core/app.ts)
import '../../core/polyfills';
import { usePlatform } from '../../core/platform';
import { startApp } from '../../core/app';
import { Tizen } from './tizen';

usePlatform(Tizen);
startApp();
