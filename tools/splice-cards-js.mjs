// splice-cards-js.mjs —— 把 gen-cards-js.mjs 生成的片段插进 src/cards.js（自动备份）
//   用法: node tools/splice-cards-js.mjs --snippet=<片段文件> [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARDS = path.join(__dirname, '..', 'src', 'cards.js');
const SNIP = arg('snippet');
if (!SNIP) { console.error('用法: --snippet=<片段文件> [--apply]'); process.exit(2); }
const snippet = fs.readFileSync(SNIP, 'utf8');
// 从片段里切出三块
const take = (startRe, endRe) => {
  const i = snippet.search(startRe);
  if (i < 0) return '';
  const rest = snippet.slice(i);
  const j = endRe ? rest.search(endRe) : -1;
  return j < 0 ? rest : rest.slice(0, j);
};
const unitsBlock = take(/\/\/ ---- \w+ 单位 ----/, /\/\* RARITY/);
const rarityBlock = take(/\/\* RARITY 追加 \*\//, /\/\* DERIVED_CARDS/);
const derivedBlock = take(/\/\* DERIVED_CARDS 追加（31 张） \*\//, /\/\* 老兵模板/);

let src = fs.readFileSync(CARDS, 'utf8');
const log = [];
// 1) 各国单位/指令/反制：按 `// ---- <key> <类别> ----` 分组插入
for (const m of unitsBlock.matchAll(/\/\/ ---- (\w+) (单位|指令|反制) ----\n([\s\S]*?)(?=\n\/\/ ---- |\n\/\* |$)/g)) {
  const [, key, kind, body] = m;
  const arrName = kind === '单位' ? 'units' : kind === '指令' ? 'orders' : 'counters';
  // 定位 NATIONS 里该国的该数组：`  <key>: {` 之后第一个 `<arrName>:[`
  const natStart = src.indexOf(`\n  ${key}: {`);
  if (natStart < 0) { log.push(`  ✗ 找不到国家键 ${key}`); continue; }
  const arrStart = src.indexOf(`${arrName}:[`, natStart);
  if (arrStart < 0) { log.push(`  ✗ ${key} 找不到 ${arrName}:[`); continue; }
  // 该数组的结束：从 arrStart 起配对中括号
  let i = src.indexOf('[', arrStart), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) { log.push(`  ✗ ${key}.${arrName} 括号不配对`); continue; }
  const before = src.slice(0, end);
  const needsComma = !/,\s*$/.test(before.trimEnd().slice(-1) === ',' ? ',' : before.slice(-1)) && !/\[\s*$/.test(before.slice(-2));
  const ins = (needsComma ? ',' : '') + '\n' + body.replace(/\n+$/, '') + '\n    ';
  src = before + ins + src.slice(end);
  log.push(`  ${key}.${arrName} 插入 ${(body.match(/\{id:/g) || []).length} 条`);
}
// 2) RARITY：在 `const RARITY = {` 之后插入
{
  const at = src.indexOf('const RARITY = {');
  const close = src.indexOf('\n};', at);
  if (at > 0 && close > 0) {
    const body = rarityBlock.replace(/^[^\n]*\n/, '').replace(/\n+$/, '');
    const needComma = !/,\s*$/.test(src.slice(0, close).trimEnd());
    src = src.slice(0, close) + (needComma ? ',' : '') + '\n' + body + src.slice(close);
    log.push(`  RARITY 插入 ${(body.match(/:/g) || []).length} 条`);
  } else log.push('  ✗ 找不到 RARITY');
}
// 3) DERIVED_CARDS：在 `const DERIVED_CARDS = {` 之后插入
{
  const at = src.indexOf('const DERIVED_CARDS = {');
  const close = src.indexOf('\n};', at);
  if (at > 0 && close > 0) {
    const body = derivedBlock.replace(/^[^\n]*\n/, '').replace(/\n+$/, '');
    const needComma = !/,\s*$/.test(src.slice(0, close).trimEnd());
    src = src.slice(0, close) + (needComma ? ',' : '') + '\n' + body + src.slice(close);
    log.push(`  DERIVED_CARDS 插入 ${(body.match(/img:/g) || []).length} 条`);
  } else log.push('  ✗ 找不到 DERIVED_CARDS');
}
console.log(log.join('\n'));
if (APPLY) {
  const bak = CARDS + '.bak-20260913';
  if (!fs.existsSync(bak)) fs.copyFileSync(CARDS, bak);
  fs.writeFileSync(CARDS, src, 'utf8');
  console.log('已写入 src/cards.js（原件备份 .bak-20260913）');
} else console.log('（演练，未写入；加 --apply 才真正插入）');
