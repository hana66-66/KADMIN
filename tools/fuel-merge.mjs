// fuel-merge.mjs —— 把「燃油位 2×2 网格图」的 OCR 结果映射回每张卡
//   用法: node tools/fuel-merge.mjs --grid=<网格目录(含 gridmap.json)> --ocr=<jsonl> --out=<fuel.json>
//   已存在 --out 时按「先到先得、不覆盖」合并（多批结果可累积）
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const GRID = arg('grid'), OCR = arg('ocr'), OUT = arg('out');
if (!GRID || !OCR || !OUT) { console.error('用法: --grid=<网格目录> --ocr=<jsonl> --out=<fuel.json>'); process.exit(2); }

const map = JSON.parse(fs.readFileSync(path.join(GRID, 'gridmap.json'), 'utf8').replace(/^\uFEFF/, ''));
const sheets = map.sheets || [];
const recs = new Map();
for (const line of fs.readFileSync(OCR, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { const r = JSON.parse(line); if (r.ok) recs.set(String(r.file).replace(/\.(png|jpe?g|webp|bmp)$/i, ''), r); } catch {}
}

const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
let got = 0, miss = 0, conflict = 0;

for (const s of sheets) {
  const key = String(s.sheet).replace(/\.(png|jpe?g|webp|bmp)$/i, '');
  const rec = recs.get(key);
  const words = rec ? (rec.words || []) : [];
  for (const c of s.cells) {
    const cx = c.j % s.cols, cy = Math.floor(c.j / s.cols);
    const hits = words.filter(w => {
      const mx = w.x + w.w / 2, my = w.y + w.h / 2;
      return Math.floor(mx / s.cw) === cx && Math.floor(my / s.ch) === cy && /^\d{1,2}$/.test(String(w.t).trim());
    }).sort((a, b) => (b.w * b.h) - (a.w * a.h));
    const prev = out[c.file];
    if (!hits.length) { if (prev == null) { out[c.file] = null; miss++; } continue; }
    const val = String(hits[0].t).trim();
    const amb = hits.length > 1 && new Set(hits.map(h => String(h.t).trim())).size > 1;
    if (prev == null) { out[c.file] = val; got++; if (amb) out['__amb_' + c.file] = hits.map(h => h.t).join('/'); }
    else if (prev !== val) { conflict++; out['__conf_' + c.file] = prev + '/' + val; }
  }
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');
const vals = Object.entries(out).filter(([k]) => !k.startsWith('__'));
console.log(`燃油位：读出 ${vals.filter(([, v]) => v != null).length} 张 / 空 ${vals.filter(([, v]) => v == null).length} 张（本轮新增 ${got}，空缺 ${miss}，冲突 ${conflict}）`);
console.log('  ' + OUT);
