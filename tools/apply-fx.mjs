// apply-fx.mjs —— 把生产者产出的效果片段（%TEMP%\fx-*.js）插进 src/engine.js
//   片段格式：若干 `case '<效果id>': { ... break; }` 块（可含注释），可选顶层辅助函数（以 `function ` 开头）
//   用法:
//     node tools/apply-fx.mjs --snippet=%TEMP%\fx-A1.js --before="case 'routUnit': {" [--apply]
//     node tools/apply-fx.mjs --snippet=%TEMP%\fx-F1.js --before="case 'totalWar': {"  [--apply]
//   同一效果 id 已存在则跳过（幂等）；写入前自动备份 engine.js.bak-<日期>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const APPLY = process.argv.includes('--apply');
const SNIP = arg('snippet'), BEFORE = arg('before', "case 'routUnit': {");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(__dirname, '..', 'src', 'engine.js');
if (!SNIP || !fs.existsSync(SNIP)) { console.error("用法: --snippet=<片段文件> [--before=\"case 'xxx': {\"] [--apply]"); process.exit(2); }
const raw = fs.readFileSync(SNIP, 'utf8');

// 切块：以 `case '` 开头的顶层块为一组；顶层 function 另外收集
const lines = raw.split(/\r?\n/);
const cases = [];
let cur = null, depth = 0;
const helpers = [];
let helperBuf = null;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^function\s/.test(l)) { helperBuf = [l]; depth = (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length; helpers.push(helperBuf); continue; }
  if (helperBuf) {
    helperBuf.push(l);
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    if (depth <= 0) helperBuf = null;
    continue;
  }
  const m = l.match(/^\s*case\s+'([^']+)'\s*:\s*\{/);
  if (m) { if (cur) cases.push(cur); cur = { id: m[1], lines: [l], depth: 0 }; }
  else if (cur) cur.lines.push(l);
  if (cur) {
    cur.depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    if (cur.depth <= 0 && cur.lines.length > 1) { cases.push(cur); cur = null; }
  }
}
if (cur) cases.push(cur);

let src = fs.readFileSync(ENGINE, 'utf8');
const toAdd = cases.filter(c => !src.includes(`case '${c.id}':`));
const skipped = cases.length - toAdd.length;
const block = toAdd.map(c => c.lines.join('\n')).join('\n');
console.log(`片段 ${path.basename(SNIP)}：解析出 ${cases.length} 个 case（新 ${toAdd.length}，已存在跳过 ${skipped}）` +
  (helpers.length ? `，另有 ${helpers.length} 个顶层函数` : ''));
toAdd.forEach(c => console.log('   + ' + c.id));
if (!toAdd.length && !helpers.length) { console.log('（无需改动）'); process.exit(0); }
if (!APPLY) { console.log('（演练；加 --apply 才写入）'); process.exit(0); }
// 顶层函数插到 engine.js 末尾之前，case 插到锚点之前
// ★ 关键：必须插在 `if (typeof module !== 'undefined') {` **这行之前**，不能只插到 `module.exports` 之前——
//   后者会把 function 声明塞进那个 if 块里；浏览器（build.mjs 原样拼 <script>，没有 module 垫片）不执行该块，
//   块内 function 只会留下 undefined 绑定（Annex B），一调用就 TypeError，而 Node 无头测试（走 require）发现不了。
if (helpers.length) {
  const guard = src.lastIndexOf("if (typeof module !== 'undefined')");
  const at = guard >= 0 ? guard : src.lastIndexOf('module.exports');
  if (at < 0) { console.error('✗ 找不到模块导出块，顶层函数未插入'); } else {
    src = src.slice(0, at) + '/* ==== 新增辅助函数（apply-fx 插入） ==== */\n' + helpers.map(h => h.join('\n')).join('\n\n') + '\n\n' + src.slice(at);
  }
}
const at = src.indexOf(BEFORE);
if (at < 0) { console.error(`✗ 找不到锚点 ${BEFORE}，case 未插入`); process.exit(1); }
src = src.slice(0, at) + block + '\n      ' + src.slice(at);
const bak = ENGINE + '.bak-20260913';
if (!fs.existsSync(bak)) fs.copyFileSync(ENGINE, bak);
fs.writeFileSync(ENGINE, src, 'utf8');
console.log(`已写入 ${toAdd.length} 个 case（锚点 ${BEFORE}）；原件备份 ${path.basename(bak)}`);
