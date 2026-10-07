// ocr-dump.mjs —— 打印某张卡的原始 OCR 词条坐标（排查版式用）
// 用法: node tools/ocr-dump.mjs --ocr=<jsonl> --src=<图片目录> --find=调整
import fs from 'node:fs';
import path from 'node:path';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const OCR = arg('ocr'), SRC = arg('src'), FIND = arg('find');
const rows = fs.readFileSync(OCR, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
for (const r of rows) {
  if (FIND && !r.file.includes(FIND)) continue;
  let W = 0, H = 0;
  try { const b = fs.readFileSync(path.join(SRC, r.file)); if (b[0] === 0x89) { W = b.readUInt32BE(16); H = b.readUInt32BE(20); } } catch {}
  console.log(`\n=== ${r.file}   实际尺寸 ${W}x${H}   words=${(r.words || []).length}`);
  for (const w of (r.words || []).slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    console.log(`  y=${String(w.y).padStart(4)} x=${String(w.x).padStart(4)} w=${String(w.w).padStart(4)} h=${String(w.h).padStart(3)}  [${w.t}]`);
  }
}
