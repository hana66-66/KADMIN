// bm-sniff.mjs —— 被动监听白描页面的 API 流量（只读，不操作页面，可与批处理并行）
//   用法: node tools/bm-sniff.mjs [--sec=60]
const PORT = 9334;
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const sec = +(arg('sec', '60')) || 60;

const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
const list = await r.json();
const p = list.find(t => t.type === 'page' && /baimiao/i.test(t.url)) || list.find(t => t.type === 'page');
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 0; const waiters = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); w(m); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/\/api\/ocr\//.test(u)) console.log('→ ' + m.params.request.method + ' ' + u.slice(0, 160));
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (/\/api\/ocr\//.test(u)) {
      const rid = m.params.requestId;
      send('Network.getResponseBody', { requestId: rid }, 8000).then(r2 => {
        const body = r2.result && r2.result.body ? r2.result.body : '';
        console.log('← ' + m.params.response.status + ' ' + u.slice(0, 120) + '  body=' + body.replace(/\s+/g, ' ').slice(0, 220));
      }).catch(() => {});
    }
  }
});
const send = (method, params = {}, ms = 8000) => new Promise(res => {
  const i = ++id; waiters.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (waiters.has(i)) { waiters.delete(i); res({}); } }, ms);
});
await send('Network.enable', {}, 10000);
console.log('监听 ' + sec + ' 秒…');
await new Promise(r2 => setTimeout(r2, sec * 1000));
ws.close();
process.exit(0);
