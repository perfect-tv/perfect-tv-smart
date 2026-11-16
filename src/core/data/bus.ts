/**
 * События данных для интерфейса:
 *   channels  — каталог плейлиста обновился (загрузка, перезагрузка)
 *   epg       — программа источника пополнилась (пачка записана, загрузка закончилась)
 *   progress  — прогресс загрузки (строка в гиде)
 *   reminders — список напоминаний изменился
 */
type Fn = (arg?: any) => void;
const map: { [ev: string]: Fn[] } = {};

export const Bus = {
  on(ev: string, f: Fn) { (map[ev] || (map[ev] = [])).push(f); },
  off(ev: string, f: Fn) {
    const l = map[ev];
    if (!l) return;
    const i = l.indexOf(f);
    if (i >= 0) l.splice(i, 1);
  },
  emit(ev: string, arg?: any) {
    const l = map[ev];
    if (!l) return;
    const copy = l.slice();
    for (let i = 0; i < copy.length; i++) {
      try { copy[i](arg); } catch (e) { console.error(ev, e); }
    }
  },
};
