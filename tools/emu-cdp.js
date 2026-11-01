/*
 * Приложение в эмуляторе webOS 4 через DevTools (порт 9998): node tools/emu-cdp.js
 *   eval '<выражение>'   — выполнить в странице (Chrome 53: Promise не ждёт — класть результат в window)
 *   shot файл.png        — снимок экрана приложения
 *   key <keyCode> [n]    — нажать клавишу n раз (461 — Назад, 37–40 — стрелки, 13 — OK)
 *   logs [мс]            — журнал консоли за это время
 * Запускать на Node с WebSocket (22+), не на Node 0.12.
 */
const [cmd, arg, arg2] = process.argv.slice(2);
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9998/json')).json();
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  let id = 0; const wait = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait[d.id]) { wait[d.id](d); delete wait[d.id]; } else if (cmd === 'logs' && d.method === 'Console.messageAdded') console.log(d.params.message.text); };
  await new Promise(r => ws.onopen = r);
  const send = (method, params = {}) => new Promise(r => { const i = ++id; wait[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: arg, returnByValue: true });
    console.log(JSON.stringify(r.result.result ? r.result.result.value : r.result, null, 1));
  } else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) { require('fs').writeFileSync(arg, Buffer.from(r.result.data, 'base64')); console.log('saved', arg); } else console.log(JSON.stringify(r).slice(0, 300));
  } else if (cmd === 'key') {
    const code = +arg, n = +(arg2 || 1);
    for (let k = 0; k < n; k++) {
      await send('Runtime.evaluate', { expression: `(function(){var e=document.createEvent('Event');e.initEvent('keydown',true,true);e.keyCode=${code};e.which=${code};document.dispatchEvent(e);var u=document.createEvent('Event');u.initEvent('keyup',true,true);u.keyCode=${code};u.which=${code};document.dispatchEvent(u);})()` });
      await new Promise(r => setTimeout(r, 120));
    }
    console.log('keys', code, n);
  } else if (cmd === 'logs') {
    await send('Console.enable'); await new Promise(r => setTimeout(r, +(arg || 1000)));
  }
  ws.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
