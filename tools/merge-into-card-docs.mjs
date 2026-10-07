// merge-into-card-docs.mjs —— 把识别出的新卡（含研发卡）并进 卡牌\<国>\文档.txt
//   依据：
//     · 目标格式沿用各国既有 文档.txt：节标题「──────── 单 位 / 指 令 / 反 制 ────────」+ 末尾「—————衍生卡————————」
//     · 追加条目与既有「后来补的」写法一致：卡名一行（无编号、无扩展名）+ 4 空格缩进字段
//     · 指令/反制/衍生（指令类）只写 稀有度/花费/效果（用户指令规范）
//     · 括号注释全部删除（用户已确认过识别结果）
//   用法: node tools/merge-into-card-docs.mjs --docs=<用户改过的文档.json?> ...
//     node tools/merge-into-card-docs.mjs --group=新卡 --doc=<文档.txt> --data=<卡牌数据.json> --dest='C:\...\开发\卡牌' [--apply]
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const APPLY = process.argv.includes('--apply');
const DEST = arg('dest'), DATA = arg('data'), DOC = arg('doc');
if (!DEST || !DATA || !DOC) { console.error('用法: --doc=<改过的文档.txt> --data=<卡牌数据.json> --dest=<卡牌目录> [--apply]'); process.exit(2); }
const groups = [{ v: DOC }];

// ---------- 解析「用户改过的文档」：以它为准（他手改过的值优先） ----------
const stripAnno = s => String(s)
  .replace(/（文件名：[^）]*）/g, '')
  .replace(/（按卡名推测）|（现有卡库）/g, '')
  .replace(/（卡面没有效果文本，白板单位，请核对）/g, '')
  .replace(/（卡面没有效果文本[^）]*）/g, '')
  .replace(/（与现有卡库不一致：[^）]*）/g, '')
  .replace(/（卡库同名同国[^）]*）/g, '')
  .replace(/（老兵形态[^）]*）/g, '')
  .replace(/（裁剪识别|燃油位裁剪|（存疑））/g, '')
  .replace(/[ \t]+$/g, '').trim();

function parseDoc(file) {
  const out = new Map();
  const CIRC = /^[\u2460-\u24FF\u3251-\u325F\u32B1-\u32BF]\s*/;       // ①-⑳ ㉑-㉟ ㊱-㊿ 都要认
  let cur = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^[【─—]/.test(raw.trim())) continue;                          // 标题/节标题
    const field = raw.match(/^\s{2,}([^：]+)：\s*(.*)$/);
    if (field && cur) {
      const k = field[1].trim(), v = stripAnno(field[2]);
      if (k === '文件名') { cur.srcFile = field[2].trim(); continue; } // 留作与识别数据对应用，不写进结果
      if (k && v) cur.fields[k] = v;
      continue;
    }
    if (raw.startsWith(' ') || raw.startsWith('\t')) continue;         // 其余缩进行忽略
    const name = raw.replace(CIRC, '').replace(/\.(png|jpe?g|webp)$/i, '').trim();
    if (!name) continue;
    cur = { name, fields: {} };
    out.set(name, cur);
  }
  return out;
}

// ---------- 生成目标国家的条目块 ----------
const SECTION = { unit: '──────── 单 位 ────────', order: '──────── 指 令 ────────', counter: '──────── 反 制 ────────' };
const DERIVED_HEAD = '—————衍生卡————————';
const block = c => {
  const L = [c.name];
  const f = c.f;
  if (c.kind === 'unit') {
    L.push(`    稀有度：${f['稀有度'] || '无'}`);
    L.push(`    类型：${f['类型'] || '?'}`);
    L.push(`    部署花费：${f['部署花费'] || f['花费'] || '?'}`);
    L.push(`    油费：${f['油费'] ?? '?'}`);
    L.push(`    攻击：${f['攻击'] ?? '?'}`);
    L.push(`    血量：${f['血量'] ?? '?'}`);
    L.push(`    词条：${f['词条'] || '无'}`);
    L.push(`    效果：${f['效果'] || '无'}`);
  } else {
    L.push(`    稀有度：${c.derived ? '无' : (f['稀有度'] || '?')}`);
    L.push(`    花费：${f['花费'] || f['部署花费'] || '?'}`);
    L.push(`    效果：${f['效果'] || '无'}`);
  }
  return L.join('\n');
};

const NAT_NAME = { 德: '德', 日: '日', 美: '美', 苏: '苏', 英: '英', 意: '意', 法: '法', 波: '波', 芬: '芬' };
const summary = [];
for (const d of groups) {
  const cards = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const edited = parseDoc(d.v);
  // 按「文件名」行建立 源文件名 → 文档条目 的索引（名字被改过也能对上）
  const bySrc = new Map();
  for (const e of edited.values()) if (e.srcFile) bySrc.set(e.srcFile.replace(/^.*[\\/]/, ''), e);
  const perNation = new Map();
  let matched = 0, notFound = [];
  for (const c of cards) {
    const e = edited.get(c.name) || bySrc.get(String(c.srcFile).replace(/^.*[\\/]/, ''));
    if (!e) { notFound.push(c.name); continue; }
    matched++;
    const nat = c.nation;
    if (!perNation.has(nat)) perNation.set(nat, { unit: [], order: [], counter: [], derived: [] });
    const tier = perNation.get(nat);
    const kind = c.derived ? 'derived' : (c.type === '反制' ? 'counter' : (c.type === '指令' ? 'order' : 'unit'));
    tier[kind].push({ name: c.name, derived: !!c.derived, kind, f: e.fields });
  }
  // 写入各国文档
  for (const [nat, tier] of perNation) {
    const target = path.join(DEST, NAT_NAME[nat] || nat, '文档.txt');
    if (!fs.existsSync(target)) { summary.push(`  ✗ 找不到 ${target}`); continue; }
    let txt = fs.readFileSync(target, 'utf8');
    const parts = [];
    for (const k of ['unit', 'order', 'counter']) if (tier[k].length) parts.push({ head: SECTION[k], blocks: tier[k].map(block) });
    if (tier.derived.length) parts.push({ head: DERIVED_HEAD, blocks: tier.derived.map(block) });
    // 逐个节插入：找到节标题，插到该节末尾（下一个节标题之前）
    for (const p of parts) {
      const lines = txt.split(/\r?\n/);
      let idx = lines.findIndex(l => l.trim() === p.head);
      const payload = p.blocks.join('\n');
      if (idx === -1) { txt = txt.replace(/\s*$/, '') + '\n' + p.head + '\n' + payload + '\n'; continue; }
      // 找该节结束位置
      let end = lines.length;
      for (let i = idx + 1; i < lines.length; i++) {
        if (/^[─—【]/.test(lines[i].trim())) { end = i; break; }
      }
      while (end > idx + 1 && !lines[end - 1].trim()) end--;          // 去掉节尾空行，稍后统一补
      lines.splice(end, 0, payload, '');
      txt = lines.join('\n');
    }
    const bak = target + '.bak-20260913';
    if (APPLY) {
      if (!fs.existsSync(bak)) fs.copyFileSync(target, bak);
      fs.writeFileSync(target, txt, 'utf8');
    }
    summary.push(`  ${nat}：单位 ${tier.unit.length} / 指令 ${tier.order.length} / 反制 ${tier.counter.length} / 衍生 ${tier.derived.length} → ${target}${APPLY ? '（已写入，原件备份 .bak-20260913）' : ''}`);
  }
  summary.push(`  [${path.basename(d.v)}] 匹配到 ${matched}/${cards.length} 张${notFound.length ? '；未匹配：' + notFound.slice(0, 10).join('、') : ''}`);
}
console.log(summary.join('\n'));
if (!APPLY) console.log('\n（演练，未写入；加 --apply 才真正合并）');
