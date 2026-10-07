#!/usr/bin/env node
// diyMake.mjs —— 用「Kards卡牌DIY制作器」网站批量合成卡图
//   输入：源文件夹里的 文档.txt（稀有度/类型/花费/攻血/效果）+ 同名美术图（<卡名>.jpg|png）
//   流程：无头 Edge + CDP 打开网站 → 点选类型/稀有度/套装/国家（按网站自己的循环点击函数）
//         → 填入 费用/攻击/血量/卡名/效果文本 → 贴入美术图并铺满取景区 → 调 html2canvas 导出 PNG
//   输出：<out>/<卡名>.png（500×702，默认写回源文件夹）
// 用法：
//   node tools/diyMake.mjs --dir="C:\path\DIY卡" [--out=...] [--set=基础] [--scale=1] [--only=卡名,卡名]
// 说明：国家按卡名在 src/cards.js 的 NATIONS 里反查；稀有度映射 铁→普通 铜→限定 银→特殊 金→精英 衍生→衍生。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const C = require(path.join(ROOT, 'src', 'cards.js'));

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const SRC = arg('dir');
if (!SRC || !fs.existsSync(SRC)) { console.error('缺少 --dir=<源文件夹>'); process.exit(2); }
const OUT = arg('out', SRC);
const SET_NAME = arg('set', '基础');
const SCALE = +(arg('scale', '1'));
const ONLY = (arg('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const EDGE = fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = 'https://ohminecraftlauncher.github.io/DIY/';
const PORT = 9333;

/* ---------- 网站选项表（顺序即点击顺序，来自 script/index.js） ---------- */
const TYPES = ['步兵', '坦克', '炮兵', '战斗机', '轰炸机', '指令', '反制'];
const RARITYS = ['普通', '限定', '特殊', '精英', '衍生'];
const SETS = ['基础', '澳新风暴', '国土阵线', '海战', '血与铁', '秘密行动', '冬季战争', '战友', '战区', '世纪大战', '军团', '突破', '忠诚'];
const FACTIONS = ['germany', 'britain', 'japan', 'soviet', 'usa', 'france', 'italy', 'poland', 'finland', 'anzac', 'neutral', 'china'];
const RARITY_MAP = { 铁: '普通', 铜: '限定', 银: '特殊', 金: '精英', 衍生: '衍生', 无: '衍生' };
const NATION_MAP = { us: 'usa', gb: 'britain', su: 'soviet', jp: 'japan', de: 'germany', pl: 'poland', fr: 'france', fi: 'finland', it: 'italy' };

/* ---------- 解析 文档.txt ---------- */
function parseDoc(txt) {
  const rawLines = txt.split(/\r?\n/);
  const lines = rawLines.map(s => s.trim());
  const cards = [];
  let cur = null;
  const FIELD = /^([^\s:：]{1,6})\s*[：:]\s*(.*)$/;
  const isName = (t, i) => {
    if (FIELD.test(t)) return false;
    if (/^\s/.test(rawLines[i] || '')) return false;        // 缩进行 = 上一字段的续行（本表效果换行用制表符缩进）
    for (let k = i + 1; k < Math.min(i + 3, lines.length); k++) if (FIELD.test(lines[k].trim())) return true;
    return false;
  };
  const appendLast = t => {
    if (!cur) return;
    const ks = Object.keys(cur.fields);
    if (!ks.length) return;
    const k = ks[ks.length - 1];
    const prev = cur.fields[k];
    cur.fields[k] = /[。！？；;]$/.test(prev) ? prev + t : prev + '；' + t;   // 上行已收尾则不加分隔符（避免「。；」）
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (!t) continue;
    const fm = t.match(FIELD);
    if (fm) { if (cur) cur.fields[fm[1]] = fm[2].trim(); continue; }
    if (!isName(t, i)) { appendLast(t); continue; }          // 效果续行
    if (cur) cards.push(cur);
    cur = { name: t.replace(/\.(?:png|jpe?g|webp)$/i, '').replace(/^[①-⑳]\s*/, '').trim(), fields: {} };
  }
  if (cur) cards.push(cur);
  return cards;
}
/* 卡名 → 国家（在 NATIONS 里反查） */
function nationOfCard(name) {
  for (const [key, n] of Object.entries(C.NATIONS)) {
    for (const list of [n.units, n.orders, n.counters]) {
      if (list.some(x => String(x.n).replace(/\s+/g, '') === String(name).replace(/\s+/g, ''))) return key;
    }
  }
  return null;
}
function artFileOf(name) {
  const cands = ['.jpg', '.jpeg', '.png', '.webp'].map(ext => path.join(SRC, name + ext)).filter(p => fs.existsSync(p));
  // 排除「已是成卡尺寸 500×702」的文件——那是本工具此前的导出结果，不能当素材用
  const usable = cands.filter(p => { const s = imgSize(p); return !(s.w === 500 && s.h === 702); });
  if (usable.length) return usable[0];
  if (cands.length) return { __isExport: true, path: cands[0] };   // 只有成卡：下面会转成告警
  const norm = s => String(s).replace(/\s+/g, '');
  const hit = fs.readdirSync(SRC).find(f => /\.(png|jpe?g|webp)$/i.test(f) && norm(path.parse(f).name) === norm(name));
  return hit ? path.join(SRC, hit) : null;
}
function imgSize(p) {
  const b = fs.readFileSync(p);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  // JPEG：扫描 SOF 段
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { w: 0, h: 0 };
}

/* ---------- CDP 极简客户端 ---------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const c = new CDP(ws);
    ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);
      if (msg.id && c.waiters.has(msg.id)) { const w = c.waiters.get(msg.id); c.waiters.delete(msg.id); msg.error ? w.rej(new Error(JSON.stringify(msg.error))) : w.res(msg.result); }
      else if (msg.method) c.events.push(msg);
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.waiters.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

/* 写 PNG：先写临时文件再改名（目标被占用时重试），避免偶发 UNKNOWN/EPERM */
function writePng(outFile, b64) {
  const tmp = outFile + '.tmp' + process.pid;
  fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
  for (let i = 0; i < 12; i++) {
    try { fs.renameSync(tmp, outFile); return; }
    catch (e) {
      if (i === 11) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      const until = Date.now() + 150; while (Date.now() < until) { /* 等待占用释放 */ }
    }
  }
}

/* ---------- 主流程 ---------- */
const docPath = path.join(SRC, '文档.txt');
if (!fs.existsSync(docPath)) { console.error('找不到 ' + docPath); process.exit(2); }
const all = parseDoc(fs.readFileSync(docPath, 'utf8'));
const jobs = [];
for (const card of all) {
  if (ONLY.length && !ONLY.includes(card.name)) continue;
  const f = card.fields;
  const isUnit = !!f['类型'];
  const nation = nationOfCard(card.name);
  const art = artFileOf(card.name);
  const artPath = art && art.__isExport ? null : art;
  const rarityKey = (f['稀有度'] || '铁').trim();
  jobs.push({
    name: card.name, isUnit, nation,
    typeName: isUnit ? (f['类型'] || '步兵').trim() : ((f['类型'] || '指令').includes('反制') ? '反制' : '指令'),
    rarityName: RARITY_MAP[rarityKey] || '普通',
    set: SET_NAME,
    kredit: (f['部署花费'] ?? f['花费'] ?? '0').replace(/\D/g, '') || '0',
    opredit: (f['油费'] ?? '').replace(/\D/g, ''),
    attack: (f['攻击'] ?? '').replace(/\D/g, ''),
    defense: (f['血量'] ?? '').replace(/\D/g, ''),
    text: (f['效果'] ?? f['特效'] ?? ''),
    // 词条（如「重甲2」「闪击、烟幕」）：写在描述最前面并加粗；「无」视为没有
    keyword: (() => { const k = (f['词条'] || '').trim(); return (!k || k === '无') ? '' : k; })(),
    fontSize: (+(f['字号'] || 0)) || null,        // 描述字号（不填=30px 起自适应缩小到不溢出）
    titleSize: (+(f['卡名字号'] || 0)) || null,   // 卡名字号（不填=50px 起自适应）
    art: artPath, artSize: artPath ? imgSize(artPath) : null,
    // 取景纵向锚点：默认竖长图取上 38%、其余居中；文档里可加一行「构图：上/中/下」覆盖
    bias: ({ 上: 0.22, 中: 0.5, 下: 0.78 })[(f['构图'] || '').trim()] ?? null,
    factionName: nation ? NATION_MAP[nation] : null,
  });
}
console.log('待制作 ' + jobs.length + ' 张：');
for (const j of jobs) console.log('  · ' + j.name + ' | ' + (j.isUnit ? '单位' : '指令') + ' | 国家=' + (j.factionName || '未知') + ' | 稀有度=' + j.rarityName + ' | 费=' + j.kredit + (j.opredit ? ' 油=' + j.opredit : '') + (j.isUnit ? ' | ' + j.attack + '/' + j.defense : '') + ' | 美术=' + (j.art ? path.basename(j.art) + ' ' + j.artSize.w + 'x' + j.artSize.h + (j.bias != null ? ' 构图=' + j.bias : '') : '【缺图】'));
const bad = jobs.filter(j => !j.art || !j.factionName);
if (bad.length) { console.error('✗ 以下卡缺图或无法确定国家：' + bad.map(j => j.name).join(', ')); process.exit(1); }

/* 启动无头 Edge */
const profile = path.join(process.env.TEMP, 'edge-diymake');
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, URL], { stdio: 'ignore', detached: false });
process.on('exit', () => { try { proc.kill(); } catch {} });

async function pageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.url.includes('/DIY/'));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('未能连上 Edge 调试端口');
}
const cdp = await CDP.connect(await pageWs());
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

/* 等页面脚本就绪（onTypeClick 等全局函数可用） */
for (let i = 0; i < 60; i++) {
  const ok = await cdp.eval('typeof onTypeClick === "function" && !!document.getElementById("main")').catch(() => false);
  if (ok) break;
  await new Promise(r => setTimeout(r, 500));
}

fs.mkdirSync(OUT, { recursive: true });
const report = [];
for (const j of jobs) {
  const artB64 = fs.readFileSync(j.art).toString('base64');
  const mime = /\.png$/i.test(j.art) ? 'image/png' : 'image/jpeg';
  const expr = `(async () => {
    const TYPE=${JSON.stringify(TYPES)}, RAR=${JSON.stringify(RARITYS)}, SET=${JSON.stringify(SETS)}, FAC=${JSON.stringify(FACTIONS)};
    const need = (cur, idx, len) => (idx - cur + len) % len;
    const j = ${JSON.stringify({ typeName: j.typeName, rarityName: j.rarityName, set: j.set, factionName: j.factionName, kredit: j.kredit, opredit: j.opredit, attack: j.attack, defense: j.defense, text: j.text, keyword: j.keyword, fontSize: j.fontSize, titleSize: j.titleSize, name: j.name, aw: j.artSize.w, ah: j.artSize.h, bias: j.bias })};
    // 1) 选项：按网站的循环点击函数点够次数（差值必须先算成常量，否则循环中 cur_* 变化会让条件提前为假）
    const ti = TYPE.indexOf(j.typeName), ni = need(cur_type, ti, TYPE.length);
    for (let i=0;i<ni;i++) onTypeClick();
    const ri = RAR.indexOf(j.rarityName), nr = need(cur_rarity, ri, RAR.length);
    for (let i=0;i<nr;i++) onRarityClick();
    const si = SET.indexOf(j.set), ns = need(cur_set, si, SET.length);
    for (let i=0;i<ns;i++) onSetClick();
    const fi = FAC.indexOf(j.factionName), nf = need(cur_faction, fi, FAC.length);
    for (let i=0;i<nf;i++) onFactionClick();
    // 2) 文本与数字（派发 input 让网站自己的规格化逻辑生效：两位数字换小号样式等）
    const put = (id, v) => { const el = document.getElementById(id); el.innerText = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    put('kredit', j.kredit);
    if (j.opredit) put('opredit', j.opredit);
    if (j.attack) put('attack', j.attack);
    if (j.defense) put('defense', j.defense);
    put('title', j.name);
    // 描述：词条单独一行（加粗）+ 换行 + 特效正文
    const bt = document.getElementById('b-text');
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    bt.innerHTML = (j.keyword ? '<b>' + esc(j.keyword) + '</b><br>' : '') + esc(j.text);
    // 自适应字号：按「字数 ÷ 每行字数」估算所需高度，从默认值逐级缩小到刚好放下
    // 盒尺寸取网站 CSS 的固定值（无头环境下 getBoundingClientRect 可能量不准，会一路缩到底）：
    //   单位 卡名 320×75 / 描述 460×105；指令 卡名 460×50 / 描述 460×95
    const fitText = (el, len, boxW, boxH, startPx, minPx, lh, extraLines) => {
      let fs = startPx;
      while (fs > minPx) {
        const per = Math.max(1, Math.floor(boxW / fs));
        const lines = Math.max(1, Math.ceil(len / per)) + (extraLines || 0);
        if (lines * fs * lh <= boxH) break;
        fs--;
      }
      el.style.fontSize = fs + 'px';
      return fs;
    };
    const textFs = fitText(bt, [...j.text].length, 460, j.isUnit ? 105 : 95, j.fontSize || 30, 14, 1.12, j.keyword ? 1 : 0);
    const tlEl = document.getElementById('title');
    const titleFs = fitText(tlEl, [...j.name].length, j.isUnit ? 320 : 460, j.isUnit ? 75 : 50, j.titleSize || 50, 18, 1.0, 0);
    // 3) 美术：铺满取景区（cover，居中；竖图略微上移，避免裁掉主体）
    const img = document.getElementById('picture-img');
    await new Promise(res => { img.onload = res; img.onerror = res; img.src = 'data:${mime};base64,${artB64}'; });
    img.style.display = 'block';
    const box = document.getElementById('picture').getBoundingClientRect();
    const sc = Math.max(box.width / j.aw, box.height / j.ah);
    const tx = (box.width - j.aw * sc) / 2;
    const anchor = (j.bias == null) ? (j.ah / j.aw > 1.15 ? 0.38 : 0.5) : j.bias;   // 竖长图默认取上 38%（文档「构图：上/中/下」可覆盖）
    const ty = (box.height - j.ah * sc) * anchor;
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + sc + ')';
    // 4) 等字体与所有图片就绪（比网站自身更稳，导出不易出现字体回退/空图）
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await Promise.all([...document.images].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; })));
    await new Promise(r => setTimeout(r, 120));
    // 5) 导出（与网站同一管线：html2canvas）
    const cv = await html2canvas(document.getElementById('main'), { useCORS: true, backgroundColor: null, scale: ${SCALE} });
    const ico = el => decodeURIComponent(document.getElementById(el).src.split('/').pop()).replace('.png','');
    return JSON.stringify({ w: cv.width, h: cv.height, png: cv.toDataURL('image/png'),
      fonts: document.fonts ? document.fonts.check('30px SHSC') : null,
      title: document.getElementById('title').innerText, kredit: document.getElementById('kredit').innerText,
      textFs: textFs, titleFs: titleFs, keywordBold: !!bt.querySelector('b'), keywordBreak: bt.innerHTML.indexOf('<br>') > -1, descHtml: bt.innerHTML.slice(0, 60),
      bodySrc: decodeURIComponent(document.getElementById('body').src.split('/').pop()),
      opredit: document.getElementById('opredit').style.display === 'none' ? '(隐藏)' : document.getElementById('opredit').innerText,
      attack: document.getElementById('attack').style.display === 'none' ? '(隐藏)' : document.getElementById('attack').innerText,
      defense: document.getElementById('defense').style.display === 'none' ? '(隐藏)' : document.getElementById('defense').innerText,
      type: ico('type'), rarity: ico('rarity'), set: ico('set'), faction: ico('faction'),
      text: document.getElementById('b-text').innerText.slice(0, 40) });
  })()`;
  try {
    const raw = await cdp.eval(expr);
    const r = JSON.parse(raw);
    const outFile = path.join(OUT, j.name + '.png');
    writePng(outFile, r.png.split(',')[1]);
    report.push('  ✓ ' + j.name + ' → ' + path.basename(outFile) + ' (' + r.w + 'x' + r.h + ', ' + Math.round(fs.statSync(outFile).size / 1024) + ' KB)'
      + '\n      类型=' + r.type + ' 稀有度=' + r.rarity + ' 套装=' + r.set + ' 国家=' + r.faction + ' 底板=' + r.bodySrc
      + ' 费=' + r.kredit + ' 油=' + r.opredit + ' 攻=' + r.attack + ' 血=' + r.defense + ' 字体=' + (r.fonts ? 'OK' : '回退')
      + ' 描述字号=' + r.textFs + 'px 卡名字号=' + r.titleFs + 'px' + (j.keyword ? ' 词条加粗=' + (r.keywordBold ? '是' : '否') : '')
      + '\n      卡名=' + r.title + ' 描述=' + r.text + '…');
  } catch (e) {
    report.push('  ✗ ' + j.name + ' 失败：' + e.message);
  }
}
console.log('\n制作结果：'); report.forEach(l => console.log(l));
cdp.close(); try { proc.kill(); } catch {}
