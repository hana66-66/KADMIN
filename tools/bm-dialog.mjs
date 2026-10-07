// bm-dialog.mjs —— 诊断并解除白描页面上的 JS 对话框（alert/confirm/beforeunload）
//   页面被对话框堵住时，Runtime.evaluate 会永久挂起，批处理就卡死在这里。
//   用法: node tools/bm-dialog.mjs [--watch=<秒>]
const PORT = 9334;
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const watch = +(arg('watch', '0')) || 0;

const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
const list = await r.json();
const p = list.find(t => t.type === 'page' && /baimiao/i.test(t.url)) || list.find(t => t.type === 'page');
if (!p) { console.error('找不到页面'); process.exit(2); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 0; const waiters = new Map(); const events = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); w(m); }
  else if (m.method) events.push(m);
});
const send = (method, params = {}, ms = 8000) => new Promise(res => {
  const i = ++id; waiters.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (waiters.has(i)) { waiters.delete(i); res({ timedOut: true }); } }, ms);
});

await send('Page.enable');
console.log('Page.enable →', 'ok');

// 1) 先试一次求值：挂起说明渲染线程被对话框堵住
const probe = await send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, 5000);
console.log('Runtime.evaluate 1+1 →', probe.timedOut ? '挂起（页面被阻塞，极可能有对话框）' : JSON.stringify(probe.result && probe.result.result));

// 2) 尝试解除对话框（没有对话框时会报错，忽略即可）
const acc = await send('Page.handleJavaScriptDialog', { accept: true }, 5000);
console.log('handleJavaScriptDialog(accept) →', JSON.stringify(acc.result || acc.error || acc.timedOut));

const after = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, 5000);
console.log('解除后再求值 →', after.timedOut ? '仍然挂起' : JSON.stringify(after.result && after.result.result && after.result.result.value));

if (watch > 0) {
  console.log('盯守 ' + watch + ' 秒，自动接受后续对话框…');
  const t0 = Date.now();
  while (Date.now() - t0 < watch * 1000) {
    await new Promise(r2 => setTimeout(r2, 1500));
    const opened = events.filter(e => e.method === 'Page.javascriptDialogOpening');
    if (opened.length) {
      console.log('  对话框: ' + JSON.stringify(opened[opened.length - 1].params.message || '').slice(0, 120));
      await send('Page.handleJavaScriptDialog', { accept: true }, 3000);
      events.length = 0;
    }
  }
  console.log('盯守结束');
}
ws.close();
process.exit(0);
