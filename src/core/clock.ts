/**
 * Время приложения: unix-секунды с поправкой по серверу (заголовок Date ответов плейлиста и EPG,
 * если расхождение больше 30 с). Часы телевизора бывают не выставлены, а архив и прогресс
 * считаются от реального времени. В логике — только Clock.now(), а не Date.now().
 */
let offsetMs = 0;

export const Clock = {
  nowMs(): number { return Date.now() + offsetMs; },
  now(): number { return Math.floor((Date.now() + offsetMs) / 1000); },
  /** Заголовок Date ответа сервера */
  syncWith(dateHeader: string | null | undefined) {
    if (!dateHeader) return;
    const t = Date.parse(dateHeader);
    if (!isFinite(t)) return;
    const diff = t - Date.now();
    offsetMs = Math.abs(diff) > 30000 ? diff : 0;
  },
  /** Для тестов */
  setOffset(ms: number) { offsetMs = ms; },
  get offset() { return offsetMs; },
};
