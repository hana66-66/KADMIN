// rename-staging.mjs —— 按数据里的最终判定（衍生/老兵）对齐暂存目录里的文件名
//   背景：衍生关系有一部分是「从抉择效果反推」出来的，发生在重命名之后，
//   所以暂存目录里这些文件还缺「（衍生）」标记。本工具按 JSON 的 name/derived/veteran 重新命名。
//   用法: node tools/rename-staging.mjs --data=<组>_卡牌数据.json --staging=<暂存组目录>
import fs from 'node:fs';
import path from 'node:path';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const DATA = arg('data'), STAGING = arg('staging');
if (!DATA || !STAGING) { console.error('用法: --data=<json> --staging=<目录>'); process.exit(2); }
const cards = JSON.parse(fs.readFileSync(DATA, 'utf8'));
let renamed = 0, ok = 0, missing = 0;
for (const c of cards) {
  if (!c.newFile) continue;
  const ext = path.extname(c.newFile) || '.png';
  const want = c.name + (c.derived ? '（衍生）' : '') + (c.veteran ? '（老兵）' : '') + ext;
  if (want === c.newFile) { ok++; continue; }
  const from = path.join(STAGING, c.newFile), to = path.join(STAGING, want);
  if (!fs.existsSync(from)) { missing++; continue; }
  if (fs.existsSync(to)) { ok++; continue; }
  fs.renameSync(from, to);
  c.newFile = want;
  renamed++;
}
fs.writeFileSync(DATA, JSON.stringify(cards, null, 1), 'utf8');
console.log(`暂存目录命名对齐：重命名 ${renamed} 张；已正确 ${ok} 张；缺文件 ${missing} 张`);
