import { KvBackend } from '../../core/platform';
import { SocketDb } from './socketdb';

/**
 * Настройки на webOS — хранилище 'settings' JS-сервиса (WebSocket). localStorage версий до 1.0.7
 * читается один раз (маркер migrated:settings): иначе удалённые настройки воскресали бы при
 * каждом запуске. Сервис недоступен — значения из localStorage, запись не сохраняется
 * (квоту localStorage на webOS больше не заполняем). Ключи migrated:* — служебные, не настройки.
 */
function ls(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

function legacy(): { [k: string]: string } {
  const out: { [k: string]: string } = {};
  const old = ls();
  if (!old) return out;
  try {
    for (let i = 0; i < old.length; i++) {
      const k = old.key(i);
      if (k === null) continue;
      const v = old.getItem(k);
      if (v !== null) out[k] = v;
    }
  } catch (e) { console.warn('legacy settings read', e); }
  return out;
}

export const WebosKv: KvBackend = {
  load() {
    return SocketDb.available().then(function (ok) {
      if (!ok) return { values: legacy(), persistent: false };
      return SocketDb.all<string>('settings').then(function (list) {
        const values: { [k: string]: string } = {};
        let alreadyMigrated = false;
        for (let i = 0; i < list.length; i++) {
          const k = list[i].key;
          if (k === 'migrated:settings') { alreadyMigrated = true; continue; }
          if (k.indexOf('migrated:') === 0) continue;
          values[k] = list[i].value;
        }
        const importRows: { key: any; value: any }[] = [];
        if (!alreadyMigrated) {
          const old = legacy();
          for (const k in old) {
            if (k === 'logo_failed' || Object.prototype.hasOwnProperty.call(values, k)) continue;
            values[k] = old[k];
            importRows.push({ key: k, value: old[k] });
          }
          importRows.push({ key: 'migrated:settings', value: '1' });
        }
        return SocketDb.put('settings', importRows).then(function () {
          if (importRows.length) console.log('settings: legacy import', importRows.length);
          return { values: values, persistent: true };
        });
      });
    }).then(null, function (e) {
      console.error('settings bootstrap', e);
      return { values: legacy(), persistent: false };
    });
  },
  save(put, del) {
    return SocketDb.put('settings', put).then(function () { return SocketDb.delete('settings', del); });
  },
  reset(rows) {
    // Полный сброс также очищает старое localStorage: оно больше не пишется и не должно импортироваться снова
    const old = ls();
    if (old) try { old.clear(); } catch (e) { console.warn('reset legacy settings', e); }
    return SocketDb.put('settings', [{ key: 'migrated:settings', value: '1' }].concat(rows));
  },
};
