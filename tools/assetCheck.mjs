// assetCheck.mjs —— 资源路径完整性检查（t5；零依赖）
// 用法：node tools/assetCheck.mjs
// 检查：① 5 国全部卡牌（单位/指令/反制）计算出的图片路径存在；② 5 张总部图存在；
//       ③ 生产牌图存在。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const req = createRequire(import.meta.url);
const cards = req(path.join(root, 'src', 'cards.js'));
const NATIONS = cards.NATIONS || cards.nations;
if (!NATIONS) { console.error('[assetCheck] cards.js 未导出 NATIONS'); process.exit(2); }

const missing = [];
const count = { checked: 0, img: 0, hq: 0, byName: 0 };
const exists = (rel) => { count.checked++; return fs.existsSync(path.join(root, rel)); };
const check = (rel, what) => {
  if (!exists(rel)) missing.push(`${what}: ${rel}`);
  else count.img++;
};
// 9 国全量映射（2026-09-13：原表只有 5 国，pl/fr/fi/it 会退化成用 key 当目录名 → 44 项假缺失）
const nameOf = (key) => ({ us: '美', de: '德', su: '苏', gb: '英', jp: '日', pl: '波', fr: '法', fi: '芬', it: '意' })[key] || key;

for (const [key, n] of Object.entries(NATIONS)) {
  for (const u of (n.units || [])) {
    const rel = u.img || `卡牌/${nameOf(key)}/${u.n}.png`;
    check(rel, `[${key}] 单位 ${u.n}`);
  }
  for (const o of (n.orders || [])) check(o.img || `卡牌/${nameOf(key)}/${o.n}.png`, `[${key}] 指令 ${o.n}`);
  for (const c of (n.counters || [])) check(c.img || `卡牌/${nameOf(key)}/${c.n}.png`, `[${key}] 反制 ${c.n}`);
  if (n.hq) { const ok = exists(n.hq); if (!ok) missing.push(`[${key}] 总部: ${n.hq}`); else count.hq++; }
}
check('卡牌/中立/生产.jpg', '生产牌');

console.log(`[assetCheck] 检查 ${count.checked} 个引用（卡图/总部），缺失 ${missing.length} 个`);
if (missing.length) {
  console.log('缺失清单:');
  for (const m of missing) console.log('  ✗ ' + m);
  process.exit(1);
}
console.log('[assetCheck] PASS：全部资源路径有效 ✓');
