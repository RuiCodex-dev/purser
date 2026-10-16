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
    } else if (cmd === 'click') {
      // real mouse click at the centre of the first element matching a CSS selector (+ optional text)
      const r = await send('Runtime.evaluate', { expression: `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(args[0])})].find(e=>(!${JSON.stringify(args[1]||'')}||(e.textContent.trim()||e.value||'')===${JSON.stringify(args[1]||'')})&&e.offsetParent!==null);if(!el)return null;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`, returnByValue: true });
      const pt = r.result.value; if (!pt) throw new Error('no element');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
      console.log('clicked', pt);
    } else if (cmd === 'upload') {
      const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
      const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: args[0] });
      if (!q.nodeId) throw new Error('no input');
      await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: args.slice(1) });
      console.log('uploaded', args.length - 1);
    } else if (cmd === 'evalfile') {
      const r = await send('Runtime.evaluate', { expression: fs.readFileSync(args[0], 'utf8'), awaitPromise: true, returnByValue: true });
      console.log(JSON.stringify(r.result.value ?? (r.exceptionDetails?.exception?.description || r.exceptionDetails?.text)));
    } else if (cmd === 'front') {
      await send('Page.bringToFront'); console.log('front');
    } else if (cmd === 'type') {
      await send('Input.insertText', { text: args[0] }); console.log('typed', args[0].length);
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
