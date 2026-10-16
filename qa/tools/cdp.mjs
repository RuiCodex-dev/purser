// Minimal raw-CDP driver for ONE page target (no browser-wide handlers).
// usage: node cdp.mjs <wsUrl> eval "<js expression>" | nav <url> | shot <file.png> [fullpage]
import fs from 'node:fs';
const [ws, cmd, ...args] = process.argv.slice(2);
const sock = new WebSocket(ws);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } };
sock.onopen = async () => {
  try {
    if (cmd === 'eval') {
      const r = await send('Runtime.evaluate', { expression: args[0], awaitPromise: true, returnByValue: true });
      const v = r.result.value; console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    } else if (cmd === 'nav') {
      await send('Page.enable'); await send('Page.navigate', { url: args[0] });
      await new Promise(r => setTimeout(r, Number(args[1] || 4000))); console.log('ok');
    } else if (cmd === 'shot') {
      const full = args[1] === 'full';
      let clip;
      if (full) { const m = await send('Page.getLayoutMetrics'); clip = { x: 0, y: 0, width: m.cssContentSize.width, height: m.cssContentSize.height, scale: 1 }; }
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
      fs.writeFileSync(args[0], Buffer.from(r.data, 'base64')); console.log('saved', args[0]);
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  sock.close();
};
