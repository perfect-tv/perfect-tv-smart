/* Чтение файлов самописного SQLite 1.0.7–1.0.9 — только для переноса данных в filekv.js. */
'use strict';
module.exports = { parse: require('./sqlitekv.js').parseSqlite };
