/**
 * Слой интерфейса поверх видео (окно, гид, плеер). Клавиши получает верхний слой стека.
 *   key(name, long, digit)  name: left|right|up|down|pgup|pgdown|digit
 *   hasLong(name)           есть ли долгое действие (тогда короткое — на keyup)
 *   keyUp(name)             клавиша без долгого действия отпущена (конец удержания)
 *   media(name)             playpause|play|pause|stop|rewind|forward|guide|info|menu|history|search|red|green|yellow|blue
 */
export interface Layer {
  el: HTMLElement | null;
  key?(name: string, long: boolean, digit: number): void;
  hasLong?(name: string): boolean;
  /** false — каждое нажатие один раз (ввод PIN): удержание не повторяет */
  holdRepeat?: boolean;
  keyUp?(name: string): void;
  enter?(): void;
  long?(): void;
  back?(): void;
  media?(name: string): void;
  /** Колесо Magic Remote / мыши: dy > 0 — вниз */
  wheel?(dy: number, dx: number): void;
  /** Убрать слой (отписки, таймеры) */
  destroy?(): void;
  /** Язык сменился — перерисовать тексты */
  relabel?(): void;
}
