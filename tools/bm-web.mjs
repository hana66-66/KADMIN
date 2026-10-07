#!/usr/bin/env node
// bm-web.mjs —— 用 CDP 驱动「白描网页版」(web.baimiaoapp.com) 做批量 OCR（会员权益、不计积分）
// 前置：带 --remote-debugging-port=9334 启动的 Edge（用户已登录过一次，配置目录持久化）
// 用法：
//   node tools/bm-web.mjs probe                      # 查看页面状态（登录态/控件）
//   node tools/bm-web.mjs ocr --dir=<文件夹> --out=<jsonl> [--limit=N]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PORT = 9334;
const cmd = process.argv[2] || 'probe';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };

// 单实例锁：同一页面只允许一个批处理进程（并行会互相清空文件列表/串号，之前踩过）
const LOCK = path.join(process.env.TEMP || '.', 'bm-web.lock');
const MY_PID = String(process.pid);
function lockAlive(pid) {
  try { const r = execSync('tasklist /FI "PID eq ' + pid + '" /NH', { encoding: 'utf8' }); return r.includes(pid); }
  catch { return false; }
}
if (cmd === 'ocr') {
  if (fs.existsSync(LOCK)) {
    const old = fs.readFileSync(LOCK, 'utf8').trim();
    if (old && old !== MY_PID && lockAlive(old)) {
      console.error('已有批处理在跑（pid ' + old + '）。并行会串号，请等它结束，或删除 ' + LOCK);
      process.exit(3);
    }
  }
  fs.writeFileSync(LOCK, MY_PID);
  const release = () => { try { if (fs.existsSync(LOCK) && fs.readFileSync(LOCK, 'utf8').trim() === MY_PID) fs.unlinkSync(LOCK); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.handlers = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const c = new CDP(ws);
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && c.waiters.has(m.id)) { const w = c.waiters.get(m.id); c.waiters.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
      else if (m.method && c.handlers.has(m.method)) { for (const h of c.handlers.get(m.method)) { try { h(m.params); } catch {} } }
    });
    ws.addEventListener('close', () => c.closed = true);
    ws.addEventListener('error', () => c.closed = true);
    return c;
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  send(method, params = {}, ms = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已断开'));
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { this.waiters.delete(id); return rej(e); }
      // 关键：命令必须带超时。页面被对话框堵住 / 连接半死时，CDP 命令会永久挂起，没有超时整批就卡死
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); rej(new Error('CDP 超时 ' + ms + 'ms: ' + method)); } }, ms);
    });
  }
  async eval(expr, ms = 20000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function pageTarget() {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
  const list = await r.json();
  const p = list.find(t => t.type === 'page' && /baimiao/i.test(t.url)) || list.find(t => t.type === 'page');
  if (!p) throw new Error('找不到页面目标（浏览器没起来？）');
  return p;
}

const target = await pageTarget();
let cdp = await CDP.connect(target.webSocketDebuggerUrl);
// 页面弹框（alert/confirm/beforeunload）会堵死渲染线程 → 自动接受；断开时重连
async function attach(c) {
  await c.send('Runtime.enable');
  try {
    await c.send('Page.enable', {}, 8000);
    c.on('Page.javascriptDialogOpening', () => { c.send('Page.handleJavaScriptDialog', { accept: true }, 8000).catch(() => {}); });
  } catch {}
}
async function reattach() {
  try { cdp.close(); } catch {}
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await attach(cdp);
  return cdp;
}
await attach(cdp);

// reload：把页面复位（上传控件失效/SPA 状态卡死时用）。beforeunload 弹框由 attach 的
//   Page.javascriptDialogOpening 处理器自动接受。
if (cmd === 'reload') {
  await cdp.send('Page.reload', { ignoreCache: false }, 15000).catch(() => {});
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const st = await cdp.eval('document.readyState + "|" + (document.querySelector("input[type=file]") ? "input-ok" : "no-input")', 6000);
      if (/complete\|input-ok/.test(st)) { console.log('页面已复位：' + st); break; }
      if (i === 29) console.log('页面复位后状态：' + st);
    } catch (e) { if (i === 29) console.log('页面复位后仍异常：' + e.message); }
  }
  const btns = await cdp.eval(`[...document.querySelectorAll('button,div,span,a')].map(e=>(e.innerText||'').replace(/\\s+/g,'')).filter(t=>/选择图片|开始识别|全部删除|查看结果/.test(t)).slice(0,6).join(' / ')`).catch(e => '读取失败：' + e.message);
  console.log('控件：' + btns);
  cdp.close();
  process.exit(0);
}

// drag：用真实拖放事件把文件丢进页面虚线框（setFileInputFiles 不生效时的替代上传通道）
if (cmd === 'drag') {
  const file = arg('file');
  if (!file || !fs.existsSync(file)) { console.error('缺少 --file=<图片路径>'); process.exit(2); }
  const sleep2 = ms => new Promise(r => setTimeout(r, ms));
  const zone = await cdp.eval(`(() => {
    const norm = t => (t||'').replace(/\\s+/g,'');
    let el = [...document.querySelectorAll('div,section,label,span')]
      .filter(e => /将图片拖入|点击上方按钮选择图片/.test(norm(e.innerText||e.textContent)))
      .sort((a,b) => (a.innerText||'').length - (b.innerText||'').length)[0];
    if (!el) { const inp = document.querySelector('input[type=file]'); el = inp && (inp.closest('div') || inp.parentElement); }
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight });
  })()`, 15000);
  console.log('落点：' + zone);
  if (zone === 'null') { console.error('找不到拖放区'); process.exit(1); }
  const z = JSON.parse(zone);
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const t of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type: t, x: z.x, y: z.y, data }, 15000);
    await sleep2(350);
  }
  await sleep2(2500);
  const after = await cdp.eval(`document.body.innerText.replace(/\\s+/g,' ').slice(0,400)`, 10000);
  console.log('拖放后页面：' + after);
  cdp.close();
  process.exit(0);
}

// reset：清站点存储 + 重新导航（上传控件"投喂后不生效"这类前端状态问题时用）
if (cmd === 'reset') {
  try { await cdp.eval('localStorage.clear(); sessionStorage.clear(); "cleared"', 8000); console.log('已清 localStorage/sessionStorage'); } catch (e) { console.log('清存储失败：' + e.message); }
  await cdp.send('Page.navigate', { url: 'https://web.baimiaoapp.com/?_=' + Date.now() }, 20000).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const st = await cdp.eval('document.readyState + "|" + (document.querySelector("input[type=file]") ? "input-ok" : "no-input")', 6000);
      if (/complete\|input-ok/.test(st)) { console.log('已重新初始化：' + st); break; }
    } catch {}
  }
  const head = await cdp.eval('document.body.innerText.replace(/\\s+/g," ").slice(0,400)', 8000).catch(e => '读取失败：' + e.message);
  console.log('页面：' + head);
  cdp.close();
  process.exit(0);
}

if (cmd === 'probe') {
  const info = await cdp.eval(`(() => {
    const txt = t => (t || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    return JSON.stringify({
      url: location.href, title: document.title,
      readyState: document.readyState,
      fileInputs: [...document.querySelectorAll('input[type=file]')].map(i => ({ accept: i.accept, multiple: i.multiple, hidden: !(i.offsetWidth || i.offsetHeight) })),
      buttons: [...document.querySelectorAll('button,a[role=button],.btn,[class*=btn]')].map(b => txt(b.innerText || b.textContent)).filter(Boolean).slice(0, 40),
      links: [...document.querySelectorAll('a')].map(a => txt(a.innerText) + '→' + a.getAttribute('href')).filter(x => x.length > 2).slice(0, 30),
      bodyHeads: txt(document.body.innerText).slice(0, 300),
      listArea: txt(document.body.innerText).slice(0, 1200),
      bodyTail: txt(document.body.innerText).slice(-500),
      hasLoginWord: /登录|注册|扫码|微信|QQ/.test(document.body.innerText),
      hasUserWord: /退出|会员|个人中心|我的|剩余/.test(document.body.innerText)
    });
  })()`);
  console.log(JSON.stringify(JSON.parse(info), null, 2));
  cdp.close();
  process.exit(0);
}

if (cmd === 'once') {
  // 单张试跑：上传 → 点「开始识别」→ 等结果 → dump 结果区结构
  const file = arg('file');
  if (!file || !fs.existsSync(file)) { console.error('缺少 --file=<图片路径>'); process.exit(2); }
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  if (!q.nodeId) { console.error('找不到 input[type=file]'); process.exit(1); }
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
  console.log('已投喂文件：' + path.basename(file));
  await new Promise(r => setTimeout(r, 2500));
  const after = await cdp.eval(`(() => {
    const txt = t => (t || '').replace(/\\s+/g,' ').trim();
    const btns = [...document.querySelectorAll('button,a[role=button],[class*=btn]')].map(b => txt(b.innerText||b.textContent)).filter(Boolean);
    return JSON.stringify({ buttons: btns.slice(0,30), body: txt(document.body.innerText).slice(0, 500) });
  })()`);
  console.log('上传后页面：' + after);
  // 精确定位「开始识别」并派发真实鼠标点击（SPA 里 el.click() 有时不触发）
  const box = await cdp.eval(`(() => {
    const norm = t => (t||'').replace(/\\s+/g,'');
    const cands = [...document.querySelectorAll('button,a,div,span')].filter(e => norm(e.innerText||e.textContent) === '开始识别');
    const el = cands.find(e => e.offsetParent !== null && e.getBoundingClientRect().width > 10) || cands[0];
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: el.tagName, cls: String(el.className).slice(0,60), w: Math.round(r.width), h: Math.round(r.height), n: cands.length });
  })()`);
  console.log('开始识别按钮：' + box);
  if (box !== 'null') {
    const b = JSON.parse(box);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    console.log('已派发真实点击 @' + b.x + ',' + b.y);
  }
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const st = await cdp.eval(`(() => {
      const txt = t => (t||'').replace(/\\s+/g,' ').trim();
      const body = txt(document.body.innerText);
      return JSON.stringify({ tail: body.slice(-300), login: /登录账号/.test(body), hasResultWord: /复制|导出|识别结果|识别完成/.test(body) });
    })()`);
    const o = JSON.parse(st);
    console.log('  [' + (i + 1) + '] login=' + o.login + ' 结果词=' + o.hasResultWord + ' :: ' + o.tail.slice(-120));
    if (o.hasResultWord || /请先登录|登录后/.test(o.tail)) break;
  }
  // 打开结果视图并 dump 结构
  const openRes = await cdp.eval(`(() => {
    const norm = t => (t||'').replace(/\\s+/g,'');
    const cands = [...document.querySelectorAll('div,span,a,button')].filter(e => /^(点击查看结果|合并结果并查看)$/.test(norm(e.innerText||e.textContent)));
    const el = cands.find(e => e.offsetParent !== null) || cands[0];
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), text: norm(el.innerText||el.textContent), n: cands.length });
  })()`);
  console.log('查看结果入口：' + openRes);
  if (openRes !== 'null') {
    const b = JSON.parse(openRes);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 3000));
  }
  const dump = await cdp.eval(`(() => {
    const o = {};
    o.url = location.href;
    o.textareas = [...document.querySelectorAll('textarea')].map(t => ({ cls: String(t.className).slice(0,50), len: (t.value||'').length, head: (t.value||'').slice(0,150) }));
    o.editables = [...document.querySelectorAll('[contenteditable]')].map(t => ({ cls: String(t.className).slice(0,50), len: (t.innerText||'').length, head: (t.innerText||'').slice(0,150) }));
    o.pres = [...document.querySelectorAll('pre')].map(t => ({ cls: String(t.className).slice(0,50), head: (t.innerText||'').slice(0,150) }));
    o.leafDivs = [...document.querySelectorAll('div')].filter(d => d.children.length === 0 && (d.innerText||'').trim().length > 15).map(d => ({ cls: String(d.className).slice(0,50), head: (d.innerText||'').slice(0,150) })).slice(0, 15);
    o.bodyTail = document.body.innerText.replace(/\\s+/g,' ').slice(-600);
    return JSON.stringify(o, null, 1);
  })()`);
  console.log('结果区结构：\n' + dump);
  cdp.close();
  process.exit(0);
}

if (cmd === 'net') {
  // 清空列表 → 只上传一张 → 识别 → 记录所有 API 请求（找结果接口）
  const file = arg('file');
  if (!file || !fs.existsSync(file)) { console.error('缺少 --file'); process.exit(2); }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clickByText = async re => {
    const box = await cdp.eval(`(() => { const norm=t=>(t||'').replace(/\\s+/g,''); const c=[...document.querySelectorAll('button,div,span,a')].filter(e=>${re}.test(norm(e.innerText||e.textContent))); const e=c.find(x=>x.offsetParent!==null&&x.getBoundingClientRect().width>8)||c[0]; if(!e) return 'null'; const r=e.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}); })()`);
    if (box === 'null') return false;
    const b = JSON.parse(box);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    return true;
  };
  const seen = [];
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', p => {
    const u = p.response.url;
    if (/\.(png|jpg|jpeg|css|js|woff2?|svg|ico|otf|ttf)$/i.test(u)) return;
    if (/^data:|^blob:/.test(u)) return;
    seen.push({ id: p.requestId, url: u, status: p.response.status });
  });
  // 清空列表
  if (await clickByText(`/^全部删除$/`)) { await sleep(1200); console.log('已清空列表'); }
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
  await sleep(1500);
  await clickByText(`/^开始识别$/`);
  await sleep(25000);
  console.log('== API 请求 ==');
  for (const s of seen) {
    let body = '';
    try { const r = await cdp.send('Network.getResponseBody', { requestId: s.id }); body = (r.body || '').replace(/\s+/g, ' ').slice(0, 400); } catch {}
    console.log('  [' + s.status + '] ' + s.url.replace('https://web.baimiaoapp.com', '').slice(0, 100));
    if (body) console.log('      ' + body.slice(0, 380));
  }
  cdp.close(); process.exit(0);
}

if (cmd === 'ocr') {
  const dir = arg('dir'); const out = arg('out', path.join(process.env.TEMP || '.', 'bm-web.jsonl'));
  const limit = +(arg('limit', '0')) || 0;
  const from = +(arg('from', '0')) || 0;
  const FRESH = process.argv.includes('--fresh');
  if (!dir || !fs.existsSync(dir)) { console.error('缺少 --dir'); process.exit(2); }
  let files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp|bmp)$/i.test(f)).sort();
  if (from) files = files.slice(from);
  if (limit) files = files.slice(0, limit);

  const done = new Set();
  if (fs.existsSync(out)) {
    for (const l of fs.readFileSync(out, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.ok) done.add(r.file); } catch {}
    }
  }
  const todo = files.filter(f => !done.has(f));
  const only = arg('only', '');
  if (only) {                                   // 指定重跑（即使已成功过也重跑，用于修正串号/失败）
    const want = only.split(',').map(s => s.trim()).filter(Boolean);
    const picked = files.filter(f => want.some(w => f.includes(w)));
    console.log('指定重跑 ' + picked.length + ' 张：' + picked.map(f => f.replace(/\.(png|jpe?g)$/i, '')).join('、'));
    todo.length = 0; todo.push(...picked);
  }
  console.log('待识别 ' + todo.length + ' 张（已完成 ' + done.size + '）→ ' + out);
  if (!todo.length) { cdp.close(); process.exit(0); }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clickByText = async re => {
    const box = await cdp.eval(`(() => { const norm=t=>(t||'').replace(/\\s+/g,''); const c=[...document.querySelectorAll('button,div,span,a')].filter(e=>${re}.test(norm(e.innerText||e.textContent))); const e=c.find(x=>x.offsetParent!==null&&x.getBoundingClientRect().width>8)||c[0]; if(!e) return 'null'; const r=e.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}); })()`);
    if (box === 'null') return false;
    const b = JSON.parse(box);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    return true;
  };
  const bodyText = () => cdp.eval(`document.body.innerText.replace(/\\s+/g,' ')`);

  // 网络捕获：结果接口 /api/ocr/image/plus/status?jobStatusId=...
  //   必须按 jobStatusId 精确配对：否则上一张的残留任务结果会被当成本张的结果（串号，实测踩过）
  let pending = null;   // { resolve }
  let wantJob = null;   // 本次提交的任务 id（GET status 里的 jobStatusId）
  const setupNet = async c => {
    await c.send('Network.enable', {}, 15000);
    c.on('Network.responseReceived', p => {
      const u = p.response.url;
      if (/\/api\/ocr\/image\/plus\/status/.test(u)) {
        const m = /jobStatusId=([^&]+)/.exec(u);
        const jid = m ? decodeURIComponent(m[1]) : null;
        if (!wantJob || jid !== wantJob) return;      // 不是本次提交的任务 → 丢弃
        c.send('Network.getResponseBody', { requestId: p.requestId }, 20000).then(r => {
          try {
            const j = JSON.parse(r.body);
            const d = j && j.data;
            if (d && d.isEnded && pending) { const cb = pending; pending = null; cb(d); }
          } catch {}
        }).catch(() => {});
      } else if (/\/api\/ocr\/image\/plus(\?|$)/.test(u)) {
        c.send('Network.getResponseBody', { requestId: p.requestId }, 20000).then(r => {
          try { const j = JSON.parse(r.body); if (j && j.data && j.data.jobStatusId) wantJob = String(j.data.jobStatusId); } catch {}
        }).catch(() => {});
      }
    });
  };
  await setupNet(cdp);
  const waitResult = (ms) => new Promise(res => {
    pending = d => res(d);
    setTimeout(() => { if (pending) { pending = null; res(null); } }, ms);
  });

  let n = 0, failStreak = 0, dropPoint = null;
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('步骤超时 ' + ms + 'ms: ' + label)), ms)),
  ]);
  const findDropPoint = async () => {
    const z = await cdp.eval(`(() => {
      const norm = t => (t||'').replace(/\\s+/g,'');
      let el = [...document.querySelectorAll('div,section,label,span')]
        .filter(e => /将图片拖入|点击上方按钮选择图片/.test(norm(e.innerText||e.textContent)))
        .sort((a,b) => (a.innerText||'').length - (b.innerText||'').length)[0];
      if (!el) { const inp = document.querySelector('input[type=file]'); el = inp && (inp.closest('div') || inp.parentElement); }
      if (!el) return 'null';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`, 15000);
    if (z === 'null') throw new Error('找不到拖放区');
    return JSON.parse(z);
  };
  // 轻量检查：DOM 里有没有文本等于该文件名的叶子节点（比 body.innerText 快得多）
  const listedNow = name => cdp.eval(`(() => {
    const want = ${JSON.stringify(name)};
    return [...document.querySelectorAll('div,span,td,p')].some(e => e.children.length === 0 && (e.textContent||'').trim() === want);
  })()`, 8000);
  const waitListed = async (name, tries) => {
    for (let i = 0; i < tries; i++) {
      await sleep(500);
      try { if (await listedNow(name)) return true; } catch {}
    }
    return false;
  };
  const pageReload = async () => {
    console.log('  ! 连续上传失败，刷新页面复位…');
    await cdp.send('Page.reload', {}, 15000).catch(() => {});
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const st = await cdp.eval('document.readyState + "|" + (document.querySelector("input[type=file]") ? "input-ok" : "no-input")', 6000);
        if (/complete\|input-ok/.test(st)) { console.log('  ! 页面已复位'); return true; }
      } catch {}
    }
    return false;
  };
  for (const f of todo) {
    n++;
    // 长跑防漂移：SPA 每轮会在 DOM 里多留一份上传面板，面板数 >1 就先刷新复位
    try {
      const cnt = await cdp.eval(`document.querySelectorAll('input[type=file]').length`, 8000);
      if (cnt > 1) { console.log('  ! 检测到 ' + cnt + ' 份上传面板，刷新复位'); await pageReload(); }
    } catch {}
    if (n > 1 && (n - 1) % 15 === 0) await pageReload();
    const full = path.join(dir, f);
    let rec = { file: f, ok: false };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // 单张总超时兜底：任何一步（DOM 命令/页面求值/结果等待）卡住都不得拖死整批
        await withTimeout((async () => {
          // 0) --fresh：每张前整页重新导航，彻底避开 SPA 状态漂移（慢几秒，但稳）
          if (FRESH) {
            await cdp.send('Page.navigate', { url: 'https://web.baimiaoapp.com/?_=' + Date.now() }, 20000).catch(() => {});
            for (let i = 0; i < 30; i++) {
              await sleep(700);
              try {
                const st = await cdp.eval('document.readyState + "|" + (document.querySelectorAll("input[type=file]").length)', 6000);
                if (/^complete\|1$/.test(st)) break;
              } catch {}
            }
            await sleep(600);
            dropPoint = null;
          }
          // 1) 清空列表（保证一次只识别一张：否则会把旧图一并重跑，读到的是第一张的结果）
          if (await clickByText(`/^全部删除$/`)) await sleep(900);
          wantJob = null;
          // 2) 上传：页面每轮可能残留多份上传面板（实测），必须喂**最后一份**面板的文件输入框，
          //    否则文件进了旧面板、页面看着毫无反应（曾误判成"上传控件失效"）。
          const inputs = await cdp.send('DOM.querySelectorAll', { nodeId: (await cdp.send('DOM.getDocument', { depth: 1 }, 20000)).root.nodeId, selector: 'input[type=file]' }, 15000);
          const ids = inputs.nodeIds || [];
          if (!ids.length) throw new Error('无上传控件');
          await cdp.send('DOM.setFileInputFiles', { nodeId: ids[ids.length - 1], files: [full] }, 20000);
          await sleep(900);
          if (!await waitListed(f, 5)) {
            // 兜底：真实拖放事件（拖到虚线框）
            if (!dropPoint) dropPoint = await findDropPoint();
            const data = { items: [], files: [full], dragOperationsMask: 1 };
            for (const t of ['dragEnter', 'dragOver', 'drop']) {
              await cdp.send('Input.dispatchDragEvent', { type: t, x: dropPoint.x, y: dropPoint.y, data }, 15000);
              await sleep(250);
            }
            if (!await waitListed(f, 6)) { dropPoint = null; throw new Error('文件未进入列表'); }
          }
          // 3) 开始识别（鼠标点击；若 3 秒内没看到提交请求，改用 JS 直接触发按钮，绕过遮挡/坐标问题）
          if (!await clickByText(`/^开始识别$/`)) throw new Error('未找到开始识别');
          for (let i = 0; i < 8 && !wantJob; i++) await sleep(400);
          if (!wantJob) {
            const r = await cdp.eval(`(() => {
              const norm = t => (t||'').replace(/\\s+/g,'');
              const els = [...document.querySelectorAll('div,button,a')].filter(e => norm(e.innerText||e.textContent) === '开始识别');
              const el = els.reverse().find(e => /btn-submit/.test(e.className||'')) || els[0];
              if (!el) return 'none';
              el.click();
              return 'js-clicked';
            })()`, 12000).catch(e => 'err:' + e.message);
            if (r === 'js-clicked') { for (let i = 0; i < 20 && !wantJob; i++) await sleep(400); }
          }
          // 3.5) 等提交响应拿到本次任务 id，之后的 status 才认（防串号）
          if (!wantJob) throw new Error('未捕获提交任务 id');
          // 4) 等网络结果
          const d = await waitResult(90000);
          if (!d) throw new Error('结果超时/未捕获');
          const words = (d.ydResp && d.ydResp.words_result) || [];
          rec = { file: f, ok: true, hash: d.hash, words: words.map(w => ({ t: w.words, x: w.location.left, y: w.location.top, w: w.location.width, h: w.location.height, s: +(w.score || 0).toFixed(2) })) };
        })(), 150000, '单张处理');
        break;
      } catch (e) {
        rec = { file: f, ok: false, err: e.message };
        // 连接/超时类故障 → 重连后重试本张；仍失败就复位页面
        if (attempt === 1 && /CDP 超时|连接已断开|步骤超时|单张处理/.test(e.message)) {
          console.log('  ! 异常，重连后重试：' + f + '（' + e.message + '）');
          try { await reattach(); await setupNet(cdp); await pageReload(); await sleep(1500); continue; }
          catch (e2) { console.log('  ! 重连失败：' + e2.message); break; }
        }
        break;
      }
    }
    fs.appendFileSync(out, JSON.stringify(rec) + '\n');
    if (rec.ok) failStreak = 0;
    else {
      failStreak++;
      if (failStreak >= 3) { failStreak = 0; await pageReload(); }
    }
    const preview = rec.ok ? rec.words.map(w => w.t).join(' ').slice(0, 80) : rec.err;
    const line = '  [' + n + '/' + todo.length + '] ' + (rec.ok ? '✓ ' + rec.words.length + ' 词 ' : '✗ ') + f.replace(/\.(png|jpe?g)$/i, '') + ' :: ' + preview;
    // 同时写一份进度日志：stdout 若被父进程管道堵住，仍能从日志看进度
    try { fs.appendFileSync(out + '.log', line + '\n'); } catch {}
    console.log(line);
  }
  console.log('DONE ' + n + ' 张');
  cdp.close();
  process.exit(0);
}
console.error('未知命令: ' + cmd);
cdp.close();
