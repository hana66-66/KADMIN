// effectGaps.mjs —— 统计「新卡的效果 id」在 engine.js 里是否已有实现
//   判定：engine.js 里出现 case '<id>' / case "<id>" / if (… '<id>' …) 等引用即视为已接线
//   用法: node tools/effectGaps.mjs [--batch=<batch-xx.txt>] [--missing]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CARDS = path.join(ROOT, 'src', 'cards.js');
const ENGINE = path.join(ROOT, 'src', 'engine.js');

const engineSrc = fs.readFileSync(ENGINE, 'utf8');
const hasId = id => engineSrc.includes(`'${id}'`) || engineSrc.includes(`"${id}"`);

import { createRequire } from 'node:module';
const cards = createRequire(import.meta.url)(CARDS);
// 新卡名单（历史批次切分脚本产出，文件名固定为 %TEMP%\newids.json）：优先用名单，避免靠「id 含中文」误判纯英文名卡（M10A1/M6/IS-2/SU-85）
const idsFile = process.env.TEMP ? path.join(process.env.TEMP, 'newids.json') : null;
const NEW_IDS = idsFile && fs.existsSync(idsFile) ? JSON.parse(fs.readFileSync(idsFile, 'utf8')) : null;
const isNew = id => NEW_IDS ? NEW_IDS.some(x => x.id === id && !x.veteran) : /[\u4e00-\u9fff]/.test(id);
const list = [];
for (const [key, nat] of Object.entries(cards.NATIONS)) {
  for (const arr of ['units', 'orders', 'counters']) {
    for (const c of nat[arr] || []) {
      const fx = c.d || c.e;
      if (!fx || typeof fx !== 'string' || !isNew(c.id)) continue;
      list.push({ nation: key, name: c.n, kind: arr, fx });
    }
  }
}
// 老兵形态（VETERAN_FORMS 走机制，不单独算）
// 衍生卡（DERIVED_CARDS 里的 31 张衍生指令）也算在内
if (NEW_IDS) {
  for (const x of NEW_IDS) {
    if (!x.derived) continue;
    const d = cards.DERIVED_CARDS[x.id];
    if (!d) continue;
    list.push({ nation: (d.nation || '?'), name: d.n, kind: 'derived', fx: d.e });
  }
}
const vet = Object.keys(cards.VETERAN_FORMS || {});
const done = list.filter(x => hasId(x.fx));
const todo = list.filter(x => !hasId(x.fx));
let title = '新卡效果接线进度';
if (process.argv.some(x => x.startsWith('--batch='))) {
  const bf = arg('batch');
  const names = fs.readFileSync(bf, 'utf8').split('\n').filter(l => l.startsWith('## ')).map(l => l.replace(/^## /, '').replace(/^.+ \/ /, '').replace(/（衍生）$/, '').trim());
  const sub = list.filter(x => names.includes(x.name));
  const sd = sub.filter(x => hasId(x.fx)), st = sub.filter(x => !hasId(x.fx));
  console.log(`批次 ${path.basename(bf)}：${sub.length} 张，已实现 ${sd.length}，未实现 ${st.length}`);
  st.forEach(x => console.log('   ✗ ' + x.nation + ' ' + x.name));
  process.exit(0);
}
console.log(`${title}：新卡 ${list.length} 张，已实现 ${done.length}，未实现 ${todo.length}`);
console.log(`老兵形态 ${vet.length} 张（走 VETERAN_FORMS 机制，${hasId('VETERAN_FORMS') || engineSrc.includes('VETERAN_FORMS') ? '引擎已引用' : '引擎尚未引用'}）`);
const byNat = {};
for (const x of todo) byNat[x.nation] = (byNat[x.nation] || 0) + 1;
console.log('未实现分布：' + Object.entries(byNat).map(([k, v]) => k + ' ' + v).join('、'));
if (process.argv.includes('--missing')) {
  console.log('\n未实现清单：');
  for (const x of todo) console.log(`  [${x.nation}/${x.kind}] ${x.name}  → ${x.fx}`);
}
