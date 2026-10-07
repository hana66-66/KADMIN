// sync-staging.mjs —— 把开发里（已压缩的）成品素材同步回暂存目录，保持两边字节一致
//   为什么需要：装完素材会按项目约定压缩（500→430 / JPEG q82），暂存目录若还是原图，
//   下次再 install-art 就会误判成「同名不同内容」而覆盖压缩结果。
//   处理「（衍生）」后缀差异：开发里是纯卡名，暂存目录保留标记。
//   用法: node tools/sync-staging.mjs --data=<组>_卡牌数据.json --staging=<暂存组目录> --dest='C:\...\开发\卡牌'
import fs from 'node:fs';
import path from 'node:path';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const DATA = arg('data'), STAGING = arg('staging'), DEST = arg('dest');
if (!DATA || !STAGING || !DEST) { console.error('用法: --data=<json> --staging=<暂存组目录> --dest=<卡牌目录>'); process.exit(2); }
const cards = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const destName = f => String(f).replace(/（衍生）(\.[A-Za-z]+)$/, '$1');
let synced = 0, same = 0, missing = 0;
for (const c of cards) {
  if (!c.newFile) continue;
  const src = path.join(DEST, c.nation || '未标注', destName(c.newFile));
  const dst = path.join(STAGING, c.newFile);
  if (!fs.existsSync(src) || !fs.existsSync(dst)) { missing++; continue; }
  if (fs.readFileSync(src).equals(fs.readFileSync(dst))) { same++; continue; }
  fs.copyFileSync(src, dst);
  synced++;
}
console.log(`同步压缩版到暂存目录：更新 ${synced} 张；已一致 ${same} 张；缺文件 ${missing} 张`);
