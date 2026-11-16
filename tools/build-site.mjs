// Сайт perfect-tv.github.io в site-out/: в корне — само приложение (сборка platform browser: браузер,
// VIDAA, Titan OS, MSX), рядом — страницы из site/ (about/ — что это и как поставить на ТВ).
// Публикует .github/workflows/release.yml (по тегу v<версия>).
// Запуск: node tools/build-site.mjs   (SITE_CNAME=домен — свой домен для GitHub Pages)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'site-out');

execFileSync(process.execPath, [path.join(root, 'tools/build.mjs'), '--platform', 'browser'], { stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'dist-browser'), out, { recursive: true });
fs.rmSync(path.join(out, 'dev-playlist.txt'), { force: true });
fs.cpSync(path.join(root, 'site'), out, { recursive: true });
// без обработки Jekyll: файлы как есть
fs.writeFileSync(path.join(out, '.nojekyll'), '');
if (process.env.SITE_CNAME) fs.writeFileSync(path.join(out, 'CNAME'), process.env.SITE_CNAME.trim() + '\n');
const version = JSON.parse(fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8')).version;
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ version: version, built: new Date().toISOString() }) + '\n');

let n = 0, size = 0;
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else { n++; size += s.size; } } })(out);
console.log(`site-out: ${n} файлов, ${(size / 1024).toFixed(0)} KB, версия ${version}`);
