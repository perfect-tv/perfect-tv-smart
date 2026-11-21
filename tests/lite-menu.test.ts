import { describe, it, expect } from 'vitest';
import { Prefs } from '../src/core/prefs';
import { css } from '../src/core/ui/style';

/**
 * Облегчённый интерфейс без прозрачности убирает затемнение, но не саму шторку меню
 * канала: иначе меню не видно, а клавиши продолжают в него попадать.
 */
describe('облегчённый интерфейс: меню канала', () => {
  it('не скрывает шторку в режиме без прозрачности', () => {
    const prev = Prefs.lite;
    try {
      Prefs.lite = 2;
      expect(css()).not.toMatch(/#menu-shade\s*\{[^}]*display\s*:\s*none/);
    } finally {
      Prefs.lite = prev;
    }
  });
});
