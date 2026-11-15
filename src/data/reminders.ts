import { Clock } from '../core/clock';
import { Prefs } from '../core/prefs';
import { Storage2 } from '../core/storage';
import { Bus } from './bus';
import { Channel, Playlist, Programme } from './models';

/**
 * Напоминания о передачах (общие для плейлистов, SQLite3 `settings.reminders`). Проверку вызывает
 * интерфейс раз в 30 с; когда приложение закрыто, напоминаний нет (фоновых будильников у
 * веб-приложения webOS нет — docs/PLAN.md).
 */
export interface Reminder {
  id: string;
  playlistId: number;
  playlistName: string;
  chKey: string;
  chName: string;
  chNum: number;
  logo: string;
  start: number;
  stop: number;
  title: string;
  desc: string;
  snooze: number;
  archiveDays: number;
  missedSeen: boolean;
}

export const SNOOZE = 300;

export function isMissed(r: Reminder, now: number) { return r.stop <= now; }
export function inArchive(r: Reminder, now: number) { return r.archiveDays > 0 && r.start >= now - r.archiveDays * 86400; }

let list: Reminder[] | null = null;
const shown: { [id: string]: true } = {};

function load(): Reminder[] {
  if (!list) list = Storage2.json<Reminder[]>('reminders', []);
  return list;
}
function save() { Storage2.setJson('reminders', load()); }
function changed() { save(); Bus.emit('reminders'); }

export const Reminders = {
  onDue: null as ((r: Reminder) => void) | null,

  keyOf(chKey: string, start: number) { return chKey + ':' + start; },
  all(): Reminder[] { return load().slice().sort(function (a, b) { return a.start - b.start; }); },
  has(ch: Channel, start: number): boolean {
    const id = Reminders.keyOf(ch.key, start);
    return load().some(function (r) { return r.id === id; });
  },
  count(): number { return load().length; },

  add(p: Playlist, ch: Channel, pr: Programme) {
    if (Reminders.has(ch, pr.start)) return;
    load().push({
      id: Reminders.keyOf(ch.key, pr.start), playlistId: p.id, playlistName: p.name, chKey: ch.key, chName: ch.name, chNum: ch.num,
      logo: ch.logoUrls()[0] || '', start: pr.start, stop: pr.stop, title: pr.title, desc: pr.desc, snooze: 0,
      archiveDays: ch.hasArchive ? ch.archiveDays : 0, missedSeen: false,
    });
    changed();
  },

  remove(id: string) {
    list = load().filter(function (r) { return r.id !== id; });
    delete shown[id];
    changed();
  },

  /** Отложить на 5 минут; у пропущенной — «позже»: оставить в списке */
  snooze(id: string) {
    const r = load().find(function (x) { return x.id === id; });
    if (!r) return;
    const t = Clock.now();
    if (isMissed(r, t)) return Reminders.keepMissed(id);
    r.snooze = t + SNOOZE;
    if (r.snooze >= r.stop && r.archiveDays === 0) return Reminders.remove(id);
    delete shown[id];
    changed();
  },

  /** Пропущенная показана — больше не всплывает, остаётся в списке до конца архива */
  keepMissed(id: string) {
    const r = load().find(function (x) { return x.id === id; });
    if (!r) return;
    r.missedSeen = true;
    delete shown[id];
    changed();
  },

  dueAt(r: Reminder): number { return r.snooze > 0 ? r.snooze : r.start - Prefs.remindBefore * 60; },

  /** Удалить закончившиеся без архива и ушедшие за глубину архива */
  cleanup() {
    const t = Clock.now();
    const before = load().length;
    list = load().filter(function (r) { return !(isMissed(r, t) && !inArchive(r, t)); });
    if (list.length !== before) changed();
  },

  /** Кого пора показать: идущие и скоро начинающиеся, а также один раз — пропущенные с архивом */
  check() {
    Reminders.cleanup();
    const t = Clock.now();
    const all = Reminders.all();
    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      if (shown[r.id]) continue;
      const live = Reminders.dueAt(r) <= t && t < r.stop;
      const missed = isMissed(r, t) && inArchive(r, t) && !r.missedSeen;
      if (live || missed) {
        shown[r.id] = true;
        if (Reminders.onDue) Reminders.onDue(r);
      }
    }
  },

  /** Показ закрыт без решения — можно показать снова */
  release(id: string) { delete shown[id]; },

  /** Для резервной копии */
  dump(): Reminder[] { return load().slice(); },
  restore(l: Reminder[]) { list = l.slice(); changed(); },
};
