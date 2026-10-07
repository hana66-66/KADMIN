#!/usr/bin/env node
// docDiff.mjs —— 文档 ↔ 代码 差异比对（卡牌/{国}/文档.txt vs src/cards.js NATIONS）
// 用法：node tools/docDiff.mjs [--json]
// 输出：每个国家：缺失卡（文档有、代码无）、数值不一致、代码有但文档无
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const C = require(path.join(ROOT, 'src', 'cards.js'));

const DIR_BY_KEY = { us:'美', de:'德', su:'苏', gb:'英', jp:'日', pl:'波', fr:'法', fi:'芬', it:'意' };
const SECTION_KIND = [['单 位','unit'], ['指 令','order'], ['反 制','counter'], ['衍生卡','derived']];

function parseDoc(txt){
  // 保留空行（用于识别「（老兵形态：…）」小段落：该段落的字段属于变体，不该并到本体卡上）
  const rawAll = txt.split(/\r?\n/).map(s=>s.replace(/\s+$/,''));
  const rawIdx = [];
  rawAll.forEach((s,i)=>{ if(s.trim()) rawIdx.push(i); });
  const rawLines = rawIdx.map(i=>rawAll[i]);
  const lines = rawLines.map(s=>s.trim());
  const cards = [];
  let kind = null, cur = null;
  let skipVariant = false;                          // 正在跳过「老兵形态」变体段落（直到下一个空行）
  const push = () => { if(cur && cur.name) cards.push(cur); cur = null; };
  const nextIsField = i => {                        // 卡名行的下一行必须是字段（稀有度/花费/特效）
    const nxt = (lines[i+1] || '').trim();
    return /^(稀有度|花费|特效)\s*[：:]/.test(nxt) || /^[❶-❿①-⑳]/.test(nxt);
  };
  for(let i=0;i<lines.length;i++){
    const t = lines[i];
    // 空行边界：rawIdx 相邻索引不连续即表示中间有空行 → 变体段落结束
    if(i > 0 && rawIdx[i] - rawIdx[i-1] > 1) skipVariant = false;
    if(/^（老兵形态|^\(老兵形态|老兵形态[：:]/.test(t)){ skipVariant = true; continue; }   // 变体说明行本身也不计
    if(skipVariant) continue;
    if(/^【.+】卡牌数据表/.test(t)) continue;              // 文件标题
    if(/^（与 .*一一对应/.test(t)) continue;               // 说明行
    // 小节标题：──────── 单 位 ──────── / ————衍生卡————————
    const sec = SECTION_KIND.find(([label]) => t.includes(label) && (t.includes('──') || t.includes('——')));
    if(sec){ push(); kind = sec[1]; continue; }
    // 字段行（允许冒号前有空格，如 "血量 :  2"）
    const fm = t.match(/^([^\s:：]{1,6})\s*[：:]\s*(.*)$/);
    if(fm){ if(cur) cur.fields[fm[1]] = fm[2].trim(); continue; }
    if(!nextIsField(i)){                                  // 效果续行：并入当前卡最后一个字段
      if(cur){ const ks = Object.keys(cur.fields); if(ks.length) cur.fields[ks[ks.length-1]] += t; else cur.append = (cur.append||'')+t; }
      continue;
    }
    push();
    const m = t.match(/^(?:[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*)?(.+?)(?:\.(?:png|jpg|jpeg|webp))?$/i);
    const name = (m ? m[1] : t).replace(/^名称\s*[：:]\s*/, '').replace(/^\{/, '').trim();
    cur = { name, kind, fields:{} };
  }
  push();
  return cards;
}
const norm = s => String(s||'').replace(/\s+/g,'').replace(/[（）()]/g,'').toLowerCase();
// 已知的内联实现（不进 NATIONS 卡池，但引擎里有对应形态）：
//   老兵形态（如 第7步枪兵团（老兵）/近卫步兵第216团（老兵））→ 引擎就地转换；衍生/特殊生成卡 → DERIVED_CARDS / RESIST 等
const INLINE_FORMS = /（老兵）|\(老兵\)/;
function isImplementedOutsideNations(name, C){
  const n = String(name||'');
  if(INLINE_FORMS.test(n)) return '老兵形态（引擎就地转换）';
  const norm2 = norm(n);
  for(const d of Object.values(C.DERIVED_CARDS || {})) if(norm(d.n) === norm2) return '衍生卡 ' + d.id;
  for(const [tag, d] of [['BAOPO', C.BAOPO], ['PLAN', C.PLAN], ['RESIST', C.RESIST]]) if(d && norm(d.n) === norm2) return '特殊生成卡 ' + tag;
  return null;
}
const num = v => { const m = String(v==null?'':v).match(/-?\d+/); return m ? +m[0] : null; };

const DIFFS = {};
for(const [key, dir] of Object.entries(DIR_BY_KEY)){
  const p = path.join(ROOT, '卡牌', dir, '文档.txt');
  if(!fs.existsSync(p)) continue;
  const cards = parseDoc(fs.readFileSync(p, 'utf8'));
  const n = C.NATIONS[key];
  if(!n){ DIFFS[key] = { nationMissing:true, docCards: cards.map(c=>c.name) }; continue; }
  const codeNames = new Set([...n.units, ...n.orders, ...n.counters].map(x=>x.n));
  const codeNamesNorm = new Set([...codeNames].map(norm));
  const codeByName = {}; [...n.units, ...n.orders, ...n.counters].forEach(x=>codeByName[x.n]=x);
  const missing = [], valueDiff = [], unmatched = [], noted = [];
  for(const c of cards){
    if(c.kind === 'derived'){
      // 衍生卡：允许存在于 DERIVED_CARDS / 特殊生成卡（不进 NATIONS）
      const dn = Object.values(C.DERIVED_CARDS||{}).map(d=>d.n).concat([C.BAOPO&&C.BAOPO.n, C.PLAN&&C.PLAN.n, C.RESIST&&C.RESIST.n, '生产'].filter(Boolean));
      if(!dn.includes(c.name)) unmatched.push(c.name + '(衍生未实现)');
      continue;
    }
    if(!codeNames.has(c.name)){
      const note = isImplementedOutsideNations(c.name, C);
      if(note){ noted.push(c.name + '（' + note + '）'); continue; }
      missing.push((c.kind||'?') + ':' + c.name); continue;
    }
    const d = codeByName[c.name] || [...n.units, ...n.orders, ...n.counters].find(x=>norm(x.n)===norm(c.name));
    const f = c.fields;
    const checks = [];
    if(c.kind === 'unit'){
      checks.push(['c', d.c, num(f['部署花费'])], ['f', d.f, num(f['油费'])], ['a', d.a, num(f['攻击'])], ['h', d.h, num(f['血量'])]);
    } else if(f['花费'] !== undefined){
      checks.push(['c', d.c, num(f['花费'])]);
    }
    const bad = checks.filter(([, codeV, docV]) => docV !== null && codeV !== undefined && +codeV !== docV);
    if(bad.length) valueDiff.push(c.name + ' ' + bad.map(([k2,a2,b2])=>k2+':'+a2+'≠'+b2).join(','));
  }
  const docNames = new Set(cards.map(c=>c.name));
  const extra = [...codeNames].filter(x=>!docNames.has(x));
  DIFFS[key] = { dir, docCount: cards.length, codeCount: codeNames.size, missing, valueDiff, extra, unmatched, noted };
}

if(process.argv.includes('--json')){ console.log(JSON.stringify(DIFFS, null, 2)); }
else if(process.argv.includes('--dump')){                  // 打印缺失卡全文（供数据录入）
  const only = (process.argv.find(a=>a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  for(const [key, dir] of Object.entries(DIR_BY_KEY)){
    if(only.length && !only.includes(key)) continue;
    const p = path.join(ROOT, '卡牌', dir, '文档.txt');
    if(!fs.existsSync(p)) continue;
    const cards = parseDoc(fs.readFileSync(p, 'utf8'));
    const n = C.NATIONS[key];
    const codeNames = new Set(n ? [...n.units, ...n.orders, ...n.counters].map(x=>norm(x.n)) : []);
    const miss = cards.filter(c => c.kind !== 'derived' && !codeNames.has(norm(c.name)));
    if(!miss.length) continue;
    console.log('\n########## ' + key + ' ' + dir + ' 缺失 ' + miss.length + ' 张 ##########');
    for(const c of miss){
      console.log('— ' + c.name + '   [' + (c.kind||'?') + ']');
      for(const [k2,v2] of Object.entries(c.fields)) console.log('    ' + k2 + '：' + v2);
      if(c.append) console.log('    (续)：' + c.append);
    }
  }
}
else {
  for(const [key, d] of Object.entries(DIFFS)){
    if(d.nationMissing){ console.log(`\n【${key}】代码中不存在该国家（文档 ${d.docCards.length} 张）`); continue; }
    console.log(`\n【${key} ${d.dir}】文档 ${d.docCount} 张 / 代码 ${d.codeCount} 张`);
    if(d.missing.length) console.log('  ✗ 缺失卡(' + d.missing.length + '): ' + d.missing.join(' ; '));
    if(d.noted && d.noted.length) console.log('  · 已知内联实现: ' + d.noted.join(' ; '));
    if(d.unmatched.length) console.log('  ✗ 衍生/特殊卡未实现: ' + d.unmatched.join(' ; '));
    if(d.valueDiff.length) console.log('  ! 数值不一致: ' + d.valueDiff.join(' ; '));
    if(d.extra.length) console.log('  · 代码有文档无(' + d.extra.length + '): ' + d.extra.join(' ; '));
    if(!d.missing.length && !d.valueDiff.length && !d.unmatched.length) console.log('  ✓ 无缺口');
  }
}
