/*
 * Приложение в эмуляторе webOS через DevTools (порт 9998): node tools/emu-cdp.js
 *   eval '<выражение>'                 — выполнить в странице (Chrome 53: Promise не ждёт — класть результат в window)
 *   shot файл.png                      — снимок экрана приложения (webOS 4; на webOS 3 — screendump QEMU)
 *   key <keyCode> [n]                  — нажать клавишу n раз (461 — Назад, 37–40 — стрелки, 13 — OK, 33/34 — PG±)
 *   profile <сек> [keyCode интервал]   — JS-профиль (пока жмётся клавиша) → /tmp/claude-1000/w4/profile.json,
 *                                        разбор — python3 tools/emu-profile.py
 *   trace <сек> [строк keyCode интервал] — трасса браузера: сколько раз и сколько мс на JS-кадры
 *                                        (FireAnimationFrame), Layout, Paint, растр (GPUTask)
 *   logs [мс]                          — журнал консоли за это время
 * Chrome 53 пускает к странице одного клиента DevTools — нажатия шлёт та же команда.
 * Запускать на Node с WebSocket (22+), не на Node 0.12.
 */
const OUT = process.env.EMU_OUT || require('os').tmpdir() + '/';
const [cmd, arg, arg2] = process.argv.slice(2);
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9998/json')).json();
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  let id = 0; const wait = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait[d.id]) { wait[d.id](d); delete wait[d.id]; } else if (cmd === 'logs' && d.method === 'Console.messageAdded') console.log(d.params.message.text); };
  await new Promise(r => ws.onopen = r);
  const send = (method, params = {}) => new Promise(r => { const i = ++id; wait[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true });
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
  } else if (cmd === 'profile') {
    // profile <секунд> <keyCode> <интервал мс>: JS-профиль, пока нажимается клавиша
    await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 200 });
    await send('Profiler.start');
    const end = Date.now() + (+arg) * 1000, code = +(arg2 || 0), iv = +(process.argv[5] || 2000);
    while (Date.now() < end) {
      if (code) await send('Runtime.evaluate', { expression: `(function(){var e=document.createEvent('Event');e.initEvent('keydown',true,true);e.keyCode=${code};e.which=${code};document.dispatchEvent(e);var u=document.createEvent('Event');u.initEvent('keyup',true,true);u.keyCode=${code};u.which=${code};document.dispatchEvent(u);})()` });
      await new Promise(r => setTimeout(r, iv));
    }
    const r = await send('Profiler.stop');
    require('fs').writeFileSync(OUT + 'profile.json', JSON.stringify(r.result.profile));
    console.log('profile saved');
  } else if (cmd === 'trace') {
    // trace <секунд> [строк]: события timeline (Paint, Layout, CompositeLayers, FunctionCall…) — сколько и сколько мс
    const ev = []; let done;
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait[d.id]) { wait[d.id](d); delete wait[d.id]; } else if (d.method === 'Tracing.dataCollected') ev.push(...d.params.value); else if (d.method === 'Tracing.tracingComplete') done(); };
    await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', options: '' });
    // trace <сек> <строк> [keyCode интервал_мс] — нажатия из того же подключения (Chrome 53 пускает одного клиента)
    const kc = +(process.argv[5] || 0), kiv = +(process.argv[6] || 200), tEnd = Date.now() + (+arg) * 1000;
    const keyExpr = `(function(){var e=document.createEvent('Event');e.initEvent('keydown',true,true);e.keyCode=${kc};e.which=${kc};document.dispatchEvent(e);var u=document.createEvent('Event');u.initEvent('keyup',true,true);u.keyCode=${kc};u.which=${kc};document.dispatchEvent(u);})()`;
    while (Date.now() < tEnd) { if (kc) await send('Runtime.evaluate', { expression: keyExpr }); await new Promise(r => setTimeout(r, kc ? kiv : 500)); }
    const fin = new Promise(r => done = r);
    await send('Tracing.end');
    await Promise.race([fin, new Promise(r => setTimeout(r, 20000))]);
    require('fs').writeFileSync(OUT + 'trace.json', JSON.stringify(ev));
    const agg = {};
    for (const e of ev) { if (e.ph !== 'X') continue; const k = e.name; agg[k] = agg[k] || { n: 0, ms: 0 }; agg[k].n++; agg[k].ms += (e.dur || 0) / 1000; }
    const top = Object.entries(agg).sort((x, y) => y[1].ms - x[1].ms).slice(0, +(arg2 || 20));
    for (const [k, v] of top) console.log(String(v.n).padStart(6), v.ms.toFixed(1).padStart(9), 'ms ', k);
  } else if (cmd === 'logs') {
    await send('Console.enable'); await new Promise(r => setTimeout(r, +(arg || 1000)));
  }
  ws.close(); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
