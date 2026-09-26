// Сборка в dist/: esbuild собирает бандл (синтаксис ES2017), tsc переводит его в ES5 —
// webOS 3 (Chromium 38) не знает классов, стрелок, let/const, async (§2).
// Запуск: node tools/build.mjs [--watch] [--dev]
import * as esbuild from 'esbuild';
import ts from 'typescript';
import * as acorn from 'acorn';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

async function build {
  const t0 = Date.now;
  const res = await esbuild.build({
    entryPoints: [path.join(root, 'src/main.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2017',
    write: false,
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    define: { DEV: dev? 'true': 'false' },
    logLevel: 'warning',
  });
  const code = res.outputFiles[0].text;
  const out = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.None,
      downlevelIteration: true,
      allowJs: true,
      removeComments:!dev,
      newLine: ts.NewLineKind.LineFeed,
    },
    fileName: 'app.js',
  });
  let js = out.outputText;
  if (!dev) {
    // сжатие без смены синтаксиса (esbuild с target es5 не трогает уже ES5-код)
    const min = await esbuild.transform(js, { minify: true, target: 'es5', legalComments: 'none' });
    js = min.code;
  }
  // проверка: в бандле только ES5
  try {
    acorn.parse(js, { ecmaVersion: 5, sourceType: 'script' });
  } catch (e) {
    const lines = js.split('\n');
    const ln = e.loc? e.loc.line: 0;
    throw new Error('Бандл не ES5: ' + e.message + '\n' + (lines[ln - 1] || '').slice(0, 200));
  }
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'app.js'), js);
  copy(path.join(root, 'node_modules/hls.js/dist/hls.min.js'), path.join(dist, 'hls.min.js'));
  copy(path.join(root, 'src/index.html'), path.join(dist, 'index.html'));
  copy(path.join(root, 'appinfo.json'), path.join(dist, 'appinfo.json'));
  for (const f of fs.readdirSync(path.join(root, 'assets'))) copy(path.join(root, 'assets', f), path.join(dist, f));
  console.log(`dist/app.js ${(js.length / 1024).toFixed(0)} КБ, ${Date.now - t0} мс`);
}

if (watch) {
  let busy = false, again = false;
  const run = async  => {
    if (busy) { again = true; return; }
    busy = true;
    try { await build; } catch (e) { console.error(e.message); }
    busy = false;
    if (again) { again = false; run; }
  };
  await run;
  fs.watch(path.join(root, 'src'), { recursive: true }, run);
  fs.watch(path.join(root, 'strings'), { recursive: true }, run);
} else {
  await build;
}
