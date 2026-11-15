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

/** Один бандл: esbuild (ES2017) → tsc (ES5) → сжатие → проверка, что это ES5 */
async function bundle(entry) {
  const res = await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'iife',
    target: 'es2017',
    write: false,
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    define: { DEV: dev? 'true': 'false', APP_VERSION: JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8')).version) },
    logLevel: 'warning',
  });
  const out = ts.transpileModule(res.outputFiles[0].text, {
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
  try {
    acorn.parse(js, { ecmaVersion: 5, sourceType: 'script' });
  } catch (e) {
    const lines = js.split('\n');
    const ln = e.loc? e.loc.line: 0;
    throw new Error(entry + ': бандл не ES5: ' + e.message + '\n' + (lines[ln - 1] || '').slice(0, 200));
  }
  return js;
}

async function build {
  const t0 = Date.now;
  const app = await bundle('src/main.ts');
  // XMLTV + matching run inside the webOS Node service. CommonJS, ES5 only.
  const serviceCode = await esbuild.build({
    entryPoints: [path.join(root, 'src/service/epg-entry.ts')], bundle: true,
    platform: 'node', format: 'cjs', target: 'es2017', write: false,
    minify: false, legalComments: 'none', logLevel: 'warning',
  });
  const serviceEs5 = ts.transpileModule(serviceCode.outputFiles[0].text, {
    compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS,
      downlevelIteration: true, removeComments:!dev }, fileName: 'epg-parser.js',
  }).outputText;
  acorn.parse(serviceEs5, { ecmaVersion: 5, sourceType: 'script' });
  fs.writeFileSync(path.join(root, 'service/epg-parser.js'), serviceEs5);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'app.js'), app);
  // EPG is parsed by the Node service; remove the legacy browser Worker.
  fs.rmSync(path.join(dist, 'epg-worker.js'), { force: true });
  copy(path.join(root, 'node_modules/hls.js/dist/hls.min.js'), path.join(dist, 'hls.min.js'));
  copy(path.join(root, 'src/index.html'), path.join(dist, 'index.html'));
  copy(path.join(root, 'appinfo.json'), path.join(dist, 'appinfo.json'));
  for (const f of fs.readdirSync(path.join(root, 'assets'))) copy(path.join(root, 'assets', f), path.join(dist, f));
  console.log(`dist/app.js ${(app.length / 1024).toFixed(0)} KB, Node epg-parser.js ${(serviceEs5.length / 1024).toFixed(0)} KB, ${Date.now - t0} ms`);
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
