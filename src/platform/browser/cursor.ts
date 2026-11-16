/**
 * Курсор мыши или пульта-указки без системного события о нём: виден, пока им двигают, и 3 с после;
 * нажатие клавиши прячет сразу.
 */
let cursor = false;
let timer = 0;
const listeners: ((v: boolean) => void)[] = [];
function set(v: boolean) {
  if (v === cursor) return;
  cursor = v;
  for (let i = 0; i < listeners.length; i++) listeners[i](v);
}
if (typeof document !== 'undefined') {
  document.addEventListener('mousemove', function () {
    set(true);
    clearTimeout(timer);
    timer = window.setTimeout(function () { set(false); }, 3000);
  }, false);
  document.addEventListener('keydown', function () { clearTimeout(timer); set(false); }, true);
}

export const Cursor = {
  visible: function () { return cursor; },
  on: function (l: (v: boolean) => void) { listeners.push(l); },
};
