// docs-to-json.mjs —— 把 卡牌\<国>\文档.txt 里本次新加的 175 张解析回机器可读 JSON
//   为什么要它：卡牌数据已按用户要求并入各国 文档.txt（不再单独留 json 临时文件），
//   接线进 cards.js 时需要结构化的数据，故从文档反解析。
//   用法: node tools/docs-to-json.mjs --names=<本次新增卡名清单JSON或txt> --dest=<卡牌目录> --out=<json>
import fs from 'node:fs';
import path from 'node:path';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const DEST = arg('dest'), OUT = arg('out'), NAMES = arg('names');
if (!DEST || !OUT) { console.error('用法: --dest=<卡牌目录> --out=<json> [--names=<清单>] | [--from=<识别数据json> ...]'); process.exit(2); }
// --from：直接从识别数据（<组>_卡牌数据.json）推「本次新增」的文档条目名：
//   文档里老兵保留（老兵），衍生的（衍生）标记不写进文档 → 用 newFile 去掉（衍生）与扩展名
const FROM = process.argv.filter(x => x.startsWith('--from=')).map(x => x.slice(7));
let needSet = null;
if (FROM.length) {
  needSet = new Set();
  for (const f of FROM) for (const c of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    // 键带国家：同名不同国是两张卡（如 英/第5步兵团 与 美/第5步兵团）
    needSet.add(c.nation + '|' + String(c.newFile).replace(/（衍生）/g, '').replace(/\.[A-Za-z]+$/, ''));
  }
} else if (NAMES && fs.existsSync(NAMES)) {
  needSet = new Set(JSON.parse(fs.readFileSync(NAMES, 'utf8')));
}
const CIRC = /^[\u2460-\u24FF\u3251-\u325F\u32B1-\u32BF]\s*/;
const need = needSet;
const CIRC0 = /^[\u2460-\u24FF\u3251-\u325F\u32B1-\u32BF]\s*/;

const NATS = ['德', '日', '美', '苏', '英', '意', '法', '波', '芬', '中立'];
const out = [];
for (const nat of NATS) {
  const file = path.join(DEST, nat, '文档.txt');
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let section = 'unit';
  let cur = null;
  const push = () => { if (cur && (!need || need.has(cur.nation + '|' + cur.name))) out.push(cur); cur = null; };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^【/.test(t)) continue;
    if (/^[─—]{2,}/.test(t)) {
      const h = t.replace(/\s/g, '');                                // 「指 令」「反 制」标题里有空格，先去空格再判
      section = /单位/.test(h) ? 'unit' : /指令/.test(h) ? 'order' : /反制/.test(h) ? 'counter' : /衍生/.test(h) ? 'derived' : section;
      continue;
    }
    if (/^（/.test(t)) continue;                                     // 文档顶部的说明行
    const f = raw.match(/^\s{2,}([^：]+)：\s*(.*)$/);
    if (f && cur) { cur.fields[f[1].trim()] = f[2].trim(); continue; }
    if (/^\s/.test(raw)) continue;
    push();
    cur = { nation: nat, section, name: raw.replace(CIRC, '').replace(/\.(png|jpe?g|webp)$/i, '').trim(), fields: {} };
  }
  push();
}
const num = v => { const m = String(v ?? '').match(/\d+/); return m ? +m[0] : null; };
const json = out.map(c => {
  const f = c.fields;
  const isUnit = c.section === 'unit';
  const isVet = /（老兵）$/.test(c.name);
  return {
    name: c.name.replace(/（老兵）$/, ''), veteran: isVet, veteranName: isVet ? c.name : null,
    nation: c.nation,
    kind: c.section === 'derived' ? (f['类型'] ? 'unit' : 'order') : c.section,
    derived: c.section === 'derived',
    section: c.section,
    rarity: f['稀有度'] || null, type: f['类型'] || null,
    cost: num(f['花费'] ?? f['部署花费']), fuel: num(f['油费']), atk: num(f['攻击']), hp: num(f['血量']),
    keywords: (f['词条'] && f['词条'] !== '无') ? f['词条'].split(/[、,，]/).map(s => s.trim()).filter(Boolean) : [],
    effect: f['效果'] || null,
    raw: f,
  };
});
fs.writeFileSync(OUT, JSON.stringify(json, null, 1), 'utf8');
const by = {};
for (const c of json) by[c.nation] = (by[c.nation] || 0) + 1;
console.log(`解析出 ${json.length} 张 → ${OUT}`);
console.log('  按国家：' + Object.entries(by).map(([k, v]) => k + ' ' + v).join('、'));
console.log('  按类别：' + ['unit', 'order', 'counter', 'derived'].map(k => k + ' ' + json.filter(c => c.section === k).length).join('、'));
