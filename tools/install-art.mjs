// install-art.mjs —— 把识别确认过的卡图按游戏目录约定装进开发（只放素材，不写任何代码）
//   目标路径：<dest>/<国家>/<卡名>.png（老兵形态为 <卡名>（老兵）.png）
//   用法: node tools/install-art.mjs --data=<组>_卡牌数据.json --src=<重命名后的图片目录> --dest='C:\...\开发\卡牌' [--apply]
//   默认只演练（不复制）；加 --apply 才真正写入。同名文件内容不同 → 不覆盖，备份到 <dest>/../素材备份_替换前/
import fs from 'node:fs';
import path from 'node:path';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const DATA = arg('data'), SRC = arg('src'), DEST = arg('dest');
const APPLY = process.argv.includes('--apply');
if (!DATA || !SRC || !DEST) { console.error('用法: --data=<json> --src=<图片目录> --dest=<卡牌目录> [--apply]'); process.exit(2); }

const cards = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const backupDir = path.join(path.dirname(DEST), '素材备份_替换前');
// 游戏里素材按「纯卡名」引用（如 卡牌/中立/溃军.png、卡牌/美/F2A 水牛.jpg），
// 所以把评审用的「（衍生）」标记去掉；「（老兵）」要保留（游戏既有写法 第7步枪兵团（老兵）.png）
const destName = f => String(f).replace(/（衍生）(\.[A-Za-z]+)$/, '$1');
let copied = 0, same = 0, conflict = 0, missing = 0, renamed = 0;
const conflicts = [], missingList = [];

for (const c of cards) {
  if (!c.newFile) continue;
  const src = path.join(SRC, c.newFile);
  const out = destName(c.newFile);
  if (out !== c.newFile) renamed++;
  const dir = path.join(DEST, c.nation || '未标注');
  const dst = path.join(dir, out);
  if (!fs.existsSync(src)) { missing++; missingList.push(c.newFile); continue; }
  if (fs.existsSync(dst)) {
    const a = fs.readFileSync(src), b = fs.readFileSync(dst);
    if (a.equals(b)) { same++; continue; }
    conflict++; conflicts.push(out);
    if (APPLY) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(dst, path.join(backupDir, c.nation + '_' + out));
      fs.copyFileSync(src, dst);
    }
    continue;
  }
  if (APPLY) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(src, dst); }
  copied++;
}

console.log(`${APPLY ? '【已写入】' : '【演练】'} 新增 ${copied} 张 → ${DEST}${renamed ? `（其中 ${renamed} 张去掉了「（衍生）」标记）` : ''}`);
console.log(`  同内容已存在跳过 ${same} 张；同名不同内容 ${conflict} 张${conflict ? '（' + (APPLY ? '已备份旧图到 素材备份_替换前/ 并覆盖' : '演练未处理') + '）' : ''}；源文件缺失 ${missing} 张`);
if (conflicts.length) conflicts.slice(0, 20).forEach(f => console.log('    ! ' + f));
if (missingList.length) missingList.slice(0, 20).forEach(f => console.log('    ? 缺源图 ' + f));
if (missing) console.log('  （源图缺失说明结果目录里没这张的重命名副本，需先重跑识别）');
