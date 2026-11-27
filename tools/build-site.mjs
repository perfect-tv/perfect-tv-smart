// Сайт perfect-tv.github.io в site-out/: в корне — само приложение (сборка platform browser: браузер,
// VIDAA, Titan OS, MSX), рядом — страницы из site/ (about/ — что это и как поставить на ТВ), код для
// обновления пакетов webOS и Tizen без переустановки — webos/ и tizen/.
// Публикует .github/workflows/release.yml (по тегу v<версия>).
// Запуск: node tools/build-site.mjs   (SITE_CNAME=домен — свой домен для GitHub Pages)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const appinfo = JSON.parse(fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8'));
const version = appinfo.version;
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ version: version, built: new Date().toISOString() }) + '\n');

// Код для обновления без переустановки (docs/TZ.md, «Обновление без переустановки»): /webos/ и
// /tizen/ — app.js и hls.min.js той же версии, что в пакетах релиза, и version.json: версия, нужные
// коду протокол оболочки (SHELL в src/core/codever.ts) и API сервиса webOS (SERVICE_API в
// service/proxy.js), sha256 файлов — их сверяют загрузчик (Tizen) и сервис (webOS).
const shell = Number(/export const SHELL = (\d+)/.exec(fs.readFileSync(path.join(root, 'src/core/codever.ts'), 'utf8'))[1]);
const serviceApi = Number(/var SERVICE_API = (\d+)/.exec(fs.readFileSync(path.join(root, 'service/proxy.js'), 'utf8'))[1]);
for (const [plat, distDir, service] of [['webos', 'dist', serviceApi], ['tizen', 'dist-tizen', 0]]) {
  execFileSync(process.execPath, [path.join(root, 'tools/build.mjs'), '--platform', plat], { stdio: 'inherit' });
  const dir = path.join(out, plat);
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const f of ['hls.min.js', 'app.js']) {
    const buf = fs.readFileSync(path.join(root, distDir, f));
    fs.writeFileSync(path.join(dir, f), buf);
    files[f] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  }
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: version, shell: shell, service: service, files: files }, null, 1) + '\n');
}

// Репозиторий для webOS Homebrew Channel («кружка»): /webos.json в корне сайта.
// Берёт собранный out/top.rootu.perfecttv_<версия>_all.ipk (или собирает его, если ещё нет).
const ipkName = `${appinfo.id}_${version}_all.ipk`;
const ipkPath = path.join(root, 'out', ipkName);
if (!fs.existsSync(ipkPath)) {
  fs.rmSync(path.join(root, 'dist/dev-playlist.txt'), { force: true });
  execFileSync(path.join(root, 'node_modules/.bin/ares-package'), ['-o', path.join(root, 'out'), path.join(root, 'dist'), path.join(root, 'service')], { stdio: 'inherit' });
}
const ipkBuf = fs.readFileSync(ipkPath);
const ipkSha256 = crypto.createHash('sha256').update(ipkBuf).digest('hex');
const siteBase = process.env.SITE_CNAME ? `https://${process.env.SITE_CNAME.trim()}` : 'https://perfect-tv.github.io';
const repoSlug = process.env.GITHUB_REPOSITORY || 'perfect-tv/perfect-tv-smart';
const iconUri = `${siteBase}/largeIcon.png`;
const ipkUrl = `https://github.com/${repoSlug}/releases/download/v${version}/${ipkName}`;
const webosJson = {
  paging: { page: 1, count: 1, maxPage: 1, itemsTotal: 1 },
  packages: [
    {
      id: appinfo.id,
      title: appinfo.title,
      iconUri: iconUri,
      manifest: {
        id: appinfo.id,
        version: version,
        type: appinfo.type || 'web',
        title: appinfo.title,
        appDescription: 'Perfect TV IPTV player (M3U, Xtream Codes, Stalker/MAG, XMLTV EPG, Archive)',
        iconUri: iconUri,
        sourceUrl: `https://github.com/${repoSlug}`,
        rootRequired: false,
        ipkUrl: ipkUrl,
        ipkHash: { sha256: ipkSha256 },
        ipkSize: ipkBuf.length,
      },
      shortDescription: 'IPTV player',
      fullDescriptionUrl: `${siteBase}/about/`,
    },
  ],
};
fs.writeFileSync(path.join(out, 'webos.json'), JSON.stringify(webosJson, null, 2) + '\n');

let n = 0, size = 0;
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else { n++; size += s.size; } } })(out);
console.log(`site-out: ${n} файлов, ${(size / 1024).toFixed(0)} KB, версия ${version}`);
