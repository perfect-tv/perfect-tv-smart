#!/usr/bin/env node
/*
 * Переводы интерфейса:
 *   npm run i18n                          — сколько переведено по каждому языку, что не переведено
 *   npm run i18n -- add <код> <Название> [правило]
 *                                         — новый язык: strings/<код>.json (копия английского —
 *                                           переводить на месте) и регистрация в src/core/langs.ts
 *   npm run i18n -- sync <код>            — привести файл к английскому: порядок ключей как в en,
 *                                           новые строки — английским текстом, лишние — удалить
 * Правила множественных чисел — PLURAL_RULES в src/core/lang.ts (en, fr, ru, pl, cs, lt, lv, ro, other).
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'strings');
const langsTs = path.join(root, 'src/core/langs.ts');
const read = (c) => JSON.parse(fs.readFileSync(path.join(dir, c + '.json'), 'utf8'));
const write = (c, t) => fs.writeFileSync(path.join(dir, c + '.json'), JSON.stringify(t, null, 1) + '\n');
const en = read('en');
const keys = Object.keys(en).filter((k) =>!k.startsWith('_'));
const RULES = ['en', 'fr', 'ru', 'pl', 'cs', 'lt', 'lv', 'ro', 'other'];

const [cmd, code, name, rule] = process.argv.slice(2);

function sync(c) {
  const t = read(c);
  const out = { _name: t._name || c, _plural: t._plural || 'en' };
  for (const k of keys) out[k] = k in t? t[k]: en[k];
  write(c, out);
  return out;
}

if (cmd === 'add') {
  if (!/^[a-z]{2,3}(-[a-z]{2})?$/.test(code || '') ||!name) {
    console.log('Использование: npm run i18n -- add <код ISO 639-1, например de> <Название на языке, например Deutsch> [правило: ' + RULES.join('|') + ']');
    process.exit(2);
  }
  if (fs.existsSync(path.join(dir, code + '.json'))) { console.log('strings/' + code + '.json уже есть'); process.exit(1); }
  if (rule &&!RULES.includes(rule)) { console.log('Правило — одно из: ' + RULES.join(', ')); process.exit(2); }
  const t = { _name: name, _plural: rule || 'en' };
  for (const k of keys) t[k] = en[k];
  write(code, t);
  const id = code.replace('-', '_');
  let ts = fs.readFileSync(langsTs, 'utf8');
  ts = ts.replace(/(import \w+ from '\.\.\/\.\.\/strings\/[\w-]+\.json';\n)(?![\s\S]*import \w+ from '\.\.\/\.\.\/strings)/, `$1import ${id} from '../../strings/${code}.json';\n`);
  ts = ts.replace(/(\n};\s*)$/, `\n  '${code}': ${id},$1`);
  fs.writeFileSync(langsTs, ts);
  console.log('Создан strings/' + code + '.json (' + keys.length + ' строк, пока по-английски) и зарегистрирован в src/core/langs.ts.');
  console.log('Переведите значения (ключи и %1$s / %1$d не трогать), затем: npm test && npm run build');
  process.exit(0);
}

if (cmd === 'sync') {
  if (!code ||!fs.existsSync(path.join(dir, code + '.json'))) { console.log('Нет strings/' + code + '.json'); process.exit(1); }
  sync(code);
  console.log('strings/' + code + '.json приведён к английскому (порядок, новые строки — по-английски).');
  process.exit(0);
}

// отчёт
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort) {
  const c = f.replace(/\.json$/, '');
  if (c === 'en') continue;
  const t = read(c);
  const missing = keys.filter((k) =>!(k in t));
  const same = keys.filter((k) => k in t && JSON.stringify(t[k]) === JSON.stringify(en[k]) && /[a-z]{3}/i.test(JSON.stringify(en[k])));
  const extra = Object.keys(t).filter((k) =>!k.startsWith('_') &&!(k in en));
  const done = keys.length - missing.length - same.length;
  console.log(`${c} (${t._name || '?'}): переведено ${done} из ${keys.length} (${Math.round(100 * done / keys.length)}%)` +
    (missing.length? `, нет ${missing.length}`: '') + (same.length? `, как в английском ${same.length}`: '') + (extra.length? `, лишних ${extra.length}`: ''));
  if (process.argv.includes('-v')) {
    if (missing.length) console.log('  нет: ' + missing.join(', '));
    if (same.length) console.log('  как в английском (проверить): ' + same.join(', '));
    if (extra.length) console.log('  лишние (нет в английском): ' + extra.join(', '));
  }
}
