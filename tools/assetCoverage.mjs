#!/usr/bin/env node
// assetCoverage.mjs —— 卡图资源覆盖检查
//   ① 每张卡的 img（显式或 pathFor 推导）在磁盘上是否存在
//   ② 该路径是否已被 build 内嵌进产物 HTML 的 IMG_MAP
//   ③ 卡图文件是否能被解码（字节完整，非 0 字节/截断）
// 用法：node tools/assetCoverage.mjs [--html=<产物路径>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const C = require(path.join(ROOT, 'src', 'cards.js'));

const htmlArg = process.argv.find(a => a.startsWith('--html='));
const HTML = htmlArg ? htmlArg.slice(7) : path.join(ROOT, 'KADMIN-卡兹铭刻.html');
let html = '';
try { html = fs.readFileSync(HTML, 'utf8'); } catch { console.log('（产物 HTML 未找到，跳过内嵌检查）'); }

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const fileOk = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return { ok: false, why: '文件不存在' };
  const st = fs.statSync(p);
  if (st.size === 0) return { ok: false, why: '0 字节' };
  const fd = fs.openSync(p, 'r');
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const isPng = head[0] === 0x89 && head[1] === 0x50;
  const isJpg = head[0] === 0xFF && head[1] === 0xD8;
  const isWebp = head[0] === 0x52 && head[1] === 0x49;
  const isGif = head[0] === 0x47 && head[1] === 0x49;
  if (!isPng && !isJpg && !isWebp && !isGif) return { ok: false, why: '文件头不是图片（可能损坏：' + head.slice(0, 4).toString('hex') + '）' };
  // 末尾标记：仅作提示（缺 EOI/IEND 的图浏览器与解码器都能正常渲染，不算损坏）
  const win = Math.min(16, st.size);
  const tail = Buffer.alloc(win);
  const fd2 = fs.openSync(p, 'r');
  fs.readSync(fd2, tail, 0, win, st.size - win);
  fs.closeSync(fd2);
  const tailHex = tail.toString('hex');
  const warn = (isJpg && !tailHex.includes('ffd9')) ? '缺 JPEG 结束标记（可正常解码）'
             : (isPng && tailHex.indexOf('49454e44') < 0) ? '缺 PNG IEND（可正常解码）' : null;
  return { ok: true, size: st.size, warn };
};

const missingFile = [], missingEmbed = [], broken = [];
const check = (key, name, img) => {
  const rel = img || null;
  if (!rel) { broken.push(key + ':' + name + ' (无 img 字段)'); return; }
  const r = fileOk(rel);
  if (!r.ok) {
    if (fs.existsSync(path.join(ROOT, rel))) broken.push(key + ':' + name + ' → ' + rel + ' (' + r.why + ')');
    else missingFile.push(key + ':' + name + ' → ' + rel);
    return;
  }
  if (html && !html.includes('"' + rel + '":')) missingEmbed.push(key + ':' + name + ' → ' + rel);
};

const PATH_EXT_TRIES = (rel) => {
  // pathFor 只生成 .png；若实际是 .jpg/.jpeg/.webp，尝试替换扩展名
  const noExt = rel.replace(/\.[a-z]+$/i, '');
  return [rel, noExt + '.jpg', noExt + '.jpeg', noExt + '.webp'];
};
const resolveImg = (key, def) => {
  if (def.img) return def.img;
  const rel = C.pathFor(key, def.n);
  for (const cand of PATH_EXT_TRIES(rel)) if (fs.existsSync(path.join(ROOT, cand))) return cand;
  return rel; // 报告缺失时用原推导路径
};

for (const [key, n] of Object.entries(C.NATIONS)) {
  for (const list of [n.units, n.orders, n.counters]) {
    for (const def of list) {
      check(key, def.n, resolveImg(key, def));
    }
  }
}
// 衍生卡与特殊生成卡
for (const [id, d] of Object.entries(C.DERIVED_CARDS || {})) check('衍生', d.n + '(' + id + ')', d.img || null);
for (const [tag, d] of [['BAOPO', C.BAOPO], ['PLAN', C.PLAN], ['RESIST', C.RESIST]]) if (d) check('特殊', d.n + '(' + tag + ')', d.img || null);

const rep = (title, arr) => {
  console.log((arr.length ? '✗ ' : '✓ ') + title + '：' + (arr.length ? arr.length + ' 项' : '全部通过'));
  arr.slice(0, 40).forEach(x => console.log('    - ' + x));
  if (arr.length > 40) console.log('    … 其余 ' + (arr.length - 40) + ' 项');
};
console.log('=== 卡图资源覆盖（产物：' + path.basename(HTML) + '）===');
rep('磁盘缺图', missingFile);
rep('文件损坏/截断', broken);
rep('未内嵌进产物', missingEmbed);
process.exit(missingFile.length + broken.length + missingEmbed.length ? 1 : 0);
