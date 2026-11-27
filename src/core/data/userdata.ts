import { Storage2 } from '../storage';

/**
 * Пользовательские данные плейлиста (SQLite3 (settings), ключи `ud_<плейлист>_<вид>`): избранное
 * (порядок), история, скрытое (ключ → название), блокировки, очки адаптивной сортировки.
 * Всё привязано к ключу канала Names.key(name), а не к номеру.
 */
function k(pid: number, kind: string) { return 'ud_' + pid + '_' + kind; }

export const UserData = {
  favourites(pid: number): string[] { return Storage2.json<string[]>(k(pid, 'fav'), []); },
  saveFavorites(pid: number, list: string[]) { Storage2.setJson(k(pid, 'fav'), list); },
  history(pid: number): string[] { return Storage2.json<string[]>(k(pid, 'hist'), []); },
  saveHistory(pid: number, list: string[]) { Storage2.setJson(k(pid, 'hist'), list); },
  hidden(pid: number, kind: string): { [key: string]: string } { return Storage2.json<{ [key: string]: string }>(k(pid, 'hid_' + kind), {}); },
  saveHidden(pid: number, kind: string, m: { [key: string]: string }) { Storage2.setJson(k(pid, 'hid_' + kind), m); },
  locked(pid: number, kind: string): string[] { return Storage2.json<string[]>(k(pid, 'lock_' + kind), []); },
  saveLocked(pid: number, kind: string, list: string[]) { Storage2.setJson(k(pid, 'lock_' + kind), list); },
  scores(pid: number): { [key: string]: number } { return Storage2.json<{ [key: string]: number }>(k(pid, 'score'), {}); },
  saveScores(pid: number, m: { [key: string]: number }) { Storage2.setJson(k(pid, 'score'), m); },
  /** Своё название канала (ключ канала → имя) */
  names(pid: number): { [key: string]: string } { return Storage2.json<{ [key: string]: string }>(k(pid, 'name'), {}); },
  saveNames(pid: number, m: { [key: string]: string }) { Storage2.setJson(k(pid, 'name'), m); },
  /** Свой номер канала (ключ канала → номер) */
  numbers(pid: number): { [key: string]: number } { return Storage2.json<{ [key: string]: number }>(k(pid, 'num'), {}); },
  saveNumbers(pid: number, m: { [key: string]: number }) { Storage2.setJson(k(pid, 'num'), m); },
  /** Порядок в категории: «категория + ключ» → индекс */
  orders(pid: number): { [key: string]: number } { return Storage2.json<{ [key: string]: number }>(k(pid, 'ord'), {}); },
  saveOrders(pid: number, m: { [key: string]: number }) { Storage2.setJson(k(pid, 'ord'), m); },
  /** Ручная привязка к программе: ключ канала → [источник, id, иконка] */
  epgMap(pid: number): { [key: string]: [string, string, string] } {
    return Storage2.json<{ [key: string]: [string, string, string] }>(k(pid, 'epgmap'), {});
  },
  saveEpgMap(pid: number, m: { [key: string]: [string, string, string] }) { Storage2.setJson(k(pid, 'epgmap'), m); },

  /** Удалить всё о плейлисте */
  dropPlaylist(pid: number) {
    const keys = Storage2.keys();
    for (let i = 0; i < keys.length; i++) if (keys[i].indexOf('ud_' + pid + '_') === 0) Storage2.remove(keys[i]);
  },

  /** Все ключи пользовательских данных — для резервной копии */
  dump(): { [k: string]: any } {
    const out: { [k: string]: any } = {};
    const keys = Storage2.keys();
    for (let i = 0; i < keys.length; i++) if (keys[i].indexOf('ud_') === 0) out[keys[i]] = Storage2.json(keys[i], null);
    return out;
  },
  restore(d: { [k: string]: any }) {
    const keys = Storage2.keys();
    for (let i = 0; i < keys.length; i++) if (keys[i].indexOf('ud_') === 0) Storage2.remove(keys[i]);
    for (const key in d) if (key.indexOf('ud_') === 0) Storage2.setJson(key, d[key]);
  },
};
