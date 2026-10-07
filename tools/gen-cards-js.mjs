// gen-cards-js.mjs —— 把解析出的新卡数据转成 cards.js 代码块（按国家分组）
//   用法: node tools/gen-cards-js.mjs --data=<new175.json> --out=<片段文件>
//   产物：<out> 里按国家给出可直接粘进 NATIONS.<key>.units / .orders / .counters 的条目，
//         以及 RARITY 追加项、DERIVED_CARDS 追加项、老兵模板清单、未实现效果的清单。
import fs from 'node:fs';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const DATA = arg('data'), OUT = arg('out');
if (!DATA || !OUT) { console.error('用法: --data=<json> --out=<片段文件>'); process.exit(2); }
const cards = JSON.parse(fs.readFileSync(DATA, 'utf8'));

const NAT = { 德: 'de', 日: 'jp', 美: 'us', 苏: 'su', 英: 'gb', 意: 'it', 法: 'fr', 波: 'pl', 芬: 'fi' };
const TYPE = { 步兵: 'infantry', 坦克: 'tank', 炮兵: 'artillery', 战斗机: 'fighter', 轰炸机: 'bomber' };
const KW = { 闪击: 'blitz', 烟幕: 'smoke', 守护: 'guard', 奋战: 'fight', 伏击: 'ambush', 冲击: 'impact', 协力: 'coop', 老兵: 'veteran' };

const lines = { units: {}, orders: {}, counters: {} };
const rarity = [], derived = [], veterans = [], todo = [], unmappedKw = new Set();

for (const c of cards) {
  const key = NAT[c.nation];
  const kws = [], armor = [];
  for (const k of c.keywords || []) {
    const m = k.match(/^重甲(\d+)$/);
    if (m) { armor.push(+m[1]); continue; }
    if (KW[k]) { kws.push(`'${KW[k]}'`); continue; }
    if (/^情报\d+$/.test(k)) { kws.push(`'${k}'`); continue; }
    unmappedKw.add(k);
  }
  const id = c.name;                                        // id 用卡名（中文），保证唯一稳定
  const base = { id, n: c.name, c: c.cost };
  if (c.section === 'unit') { base.t = TYPE[c.type] || 'infantry'; base.f = c.fuel; base.a = c.atk; base.h = c.hp; }
  const sPart = kws.length ? `, s:[${kws.join(',')}]` : '';
  const rPart = armor.length ? `, r:${armor[0]}` : '';
  const fxPart = c.section === 'unit' ? `, d:'${id}'` : `, e:'${id}'`;   // 单位=部署效果 d:，指令/反制=效果 e:
  const vetPart = c.veteran ? `, vet:true` : '';
  const entry = `      {${Object.entries(base).map(([k, v]) => `${k}:${typeof v === 'string' ? `'${v}'` : v}`).join(', ')}${sPart}${rPart}${fxPart}${vetPart}},`;
  if (c.section === 'counter') lines.counters[key] = (lines.counters[key] || []).concat(entry);
  else if (c.section === 'order') lines.orders[key] = (lines.orders[key] || []).concat(entry);
  else if (c.section === 'derived') derived.push({ ...c, key, id });
  else lines.units[key] = (lines.units[key] || []).concat(entry);
  if (!c.derived && !c.veteran) rarity.push(`  '${id}': '${c.rarity}',`);   // 老兵形态不进卡池，不登记稀有度
  if (c.veteran) veterans.push(`  ${key}: ${c.name} → 老兵 ${c.cost}费 ${c.atk}/${c.hp}${c.keywords.length ? ' ' + c.keywords.join('、') : ''}`);
  todo.push(`${c.nation} ${c.name}${c.derived ? '（衍生）' : ''}：${c.effect}`);
}

const L = [];
L.push('/* ===== 本次新增（自动生成，勿手改；改数据请改 tools/gen-cards-js.mjs 的输入） ===== */');
for (const k of Object.keys(lines.units)) { L.push(`\n// ---- ${k} 单位 ----`); L.push(...lines.units[k]); }
for (const k of Object.keys(lines.orders)) { L.push(`\n// ---- ${k} 指令 ----`); L.push(...lines.orders[k]); }
for (const k of Object.keys(lines.counters)) { L.push(`\n// ---- ${k} 反制 ----`); L.push(...lines.counters[k]); }
L.push('\n/* RARITY 追加 */'); L.push(...rarity);
L.push('\n/* DERIVED_CARDS 追加（31 张） */');
for (const d of derived) L.push(`  '${d.id}': { n:'${d.name}', c:${d.cost}${d.type ? `, t:'${TYPE[d.type] || 'infantry'}'` : ''}, img:R+'${d.nation}/${d.name}.png', e:'${d.id}' },`);
L.push('\n/* 老兵模板（5 张，与本体同一张卡，不进卡池） */'); L.push(...veterans);
fs.writeFileSync(OUT, L.join('\n'), 'utf8');

console.log(`已生成 ${cards.length} 张的代码片段 → ${OUT}`);
console.log(`  单位 ${Object.values(lines.units).flat().length} / 指令 ${Object.values(lines.orders).flat().length} / 反制 ${Object.values(lines.counters).flat().length} / 衍生 ${derived.length}`);
console.log(`  未映射词条：${unmappedKw.size ? [...unmappedKw].join('、') : '（无）'}`);
console.log(`  待实现效果：${todo.length} 条（明细已列在片段文件末尾注释之外，下一步逐个补引擎 case）`);
