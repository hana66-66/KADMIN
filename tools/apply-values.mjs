// apply-values.mjs —— 把「按暂存卡名」读到的数值，落到生成器真正认的地方
//   为什么要这层映射：识别记录（jsonl）里用的是**原始文件名**，而裁图识别是按**识别名**命名的；
//   生成器读的是原始文件名为键的 fuel/atk/hp JSON 与 tools/overrides.json 的 costs/rarities。
//   用法:
//     node tools/apply-values.mjs --field=fuel --values=<键为卡名的json> --out=<fuel.json> --data=<组json> [--data=<组json2>]
//     node tools/apply-values.mjs --field=cost|rarity --values=<键为卡名的json> --data=...      # 写进 tools/overrides.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const argAll = k => process.argv.filter(x => x.startsWith('--' + k + '=')).map(x => x.slice(k.length + 3));
const FIELD = (argAll('field')[0] || 'fuel');
const VALUES = argAll('values')[0];
const OUT = argAll('out')[0];
const DATA = argAll('data');
if (!VALUES || !DATA.length) { console.error('用法: --field=fuel|atk|hp|cost|rarity --values=<json> [--out=<json>] --data=<组json>...'); process.exit(2); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cards = DATA.flatMap(p => JSON.parse(fs.readFileSync(p, 'utf8')));
const byName = new Map();
for (const c of cards) {
  byName.set(c.name, c);
  byName.set(String(c.newFile).replace(/\.[A-Za-z]+$/, ''), c);
  byName.set(String(c.newFile).replace(/（衍生）|（老兵）/g, '').replace(/\.[A-Za-z]+$/, ''), c);
}
const vals = JSON.parse(fs.readFileSync(VALUES, 'utf8'));
let n = 0; const miss = [];
if (FIELD === 'cost' || FIELD === 'rarity') {
  const OVP = path.join(__dirname, 'overrides.json');
  const ov = JSON.parse(fs.readFileSync(OVP, 'utf8').replace(/^\uFEFF/, ''));
  const sec = FIELD === 'cost' ? 'costs' : 'rarities';
  ov[sec] = ov[sec] || {};
  for (const [k, v] of Object.entries(vals)) {
    if (k.startsWith('__') || v == null) continue;
    const c = byName.get(k) || byName.get(k.replace(/\.[A-Za-z]+$/, ''));
    if (!c) { miss.push(k); continue; }
    ov[sec][c.name] = String(v);       // 以卡名为键：改名也不影响
    n++;
  }
  fs.writeFileSync(OVP, JSON.stringify(ov, null, 2), 'utf8');
  console.log(`写入 overrides.json 的 ${sec}：${n} 条`);
} else {
  const target = OUT || path.join(process.env.TEMP || '.', FIELD + '.json');
  const cur = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
  for (const [k, v] of Object.entries(vals)) {
    if (k.startsWith('__') || v == null) continue;
    const c = byName.get(k) || byName.get(k.replace(/\.[A-Za-z]+$/, ''));
    if (!c) { miss.push(k); continue; }
    if (cur[c.srcFile] == null) { cur[c.srcFile] = String(v); n++; }
  }
  fs.writeFileSync(target, JSON.stringify(cur, null, 1), 'utf8');
  console.log(`写入 ${target} 的 ${FIELD}：${n} 条`);
}
if (miss.length) console.log('  未匹配到卡：' + miss.join('、'));
