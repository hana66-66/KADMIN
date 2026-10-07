#!/usr/bin/env node
// gen-card-docs.mjs —— 由白描 OCR 结果（含坐标）生成卡牌文档 + 重命名图片
//   输入：OCR jsonl（bm-web.mjs ocr 产出）+ 源文件夹
//   输出（默认写到桌面「新卡_识别结果」，不动 开发）：
//     <out>\<组名>\<识别卡名>.png        重命名后的卡图
//     <out>\<组名>\文档.txt              按国家分节、单位/指令/衍生分区
//     <out>\重命名对照.txt               原文件名 → 新文件名 + 识别结果 + 待补字段
// 用法：node tools/gen-card-docs.mjs --src=<源文件夹> --ocr=<jsonl> --out=<输出目录> --group=新卡
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as require$crypto from 'node:crypto';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const SRC = arg('src'), OCR = arg('ocr'), OUT = arg('out'), GROUP = arg('group', '新卡'), FUEL = arg('fuel');
const DROP_KNOWN = process.argv.includes('--drop-known');   // 卡库已有且数值一致 → 不复制图片、不进文档
const NO_COPY = process.argv.includes('--no-copy');         // 只出文档/数据，不复制图片（源图已清理时用）
const MINIMAL = process.argv.includes('--minimal');         // 精简输出：不写重命名对照/映射/一键改名脚本/剔除清单
// 源图尺寸快照：源文件夹清掉后仍能正确换算 OCR 坐标（由 --dims= 指定，缺省读 <输出目录>/源图尺寸.json）
const DIMS = (() => { try { return JSON.parse(fs.readFileSync(arg('dims', path.join(OUT, '源图尺寸.json')), 'utf8')); } catch { return {}; } })();
const CODE_DIR = arg('code', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src'));
if (!SRC || !OCR || !OUT) { console.error('用法: --src=<文件夹> --ocr=<jsonl> --out=<输出目录> [--group=新卡] [--fuel=fuel.json]'); process.exit(2); }
// 燃油位：整卡 OCR 读不到（K 图标常把油费数字挤掉），由 fuel-merge.mjs 用「燃油位裁剪放大」单独识别
const fuelMap = FUEL && fs.existsSync(FUEL) ? JSON.parse(fs.readFileSync(FUEL, 'utf8')) : {};
// 攻击/血量位裁剪识别结果（军标数字偶尔读不到，用裁剪放大补一遍）
const cropMap = k => { const p = arg(k); return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}; };
const atkMap = cropMap('atk'), hpMap = cropMap('hp');
// 人工覆盖表（哈希命名/文件名没写国家的卡，用 tools/overrides.json 补）
const OV = (() => { try { return JSON.parse(fs.readFileSync(path.join(CODE_DIR, '..', 'tools', 'overrides.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
const natOverride = file => {
  for (const [frag, nat] of Object.entries(OV.nations || {})) if (String(file).includes(frag)) return nat;
  return null;
};
// 人工覆盖表也支持花费/稀有度（哈希命名、卡面读不出的情况）；生成器每次都会套用，不会被重跑冲掉
const ovLookup = (sec, file) => {
  for (const [frag, val] of Object.entries(OV[sec] || {})) if (String(file).includes(frag)) return val;
  return null;
};

const KEYWORDS = ['闪击', '烟幕', '守护', '奋战', '伏击', '冲击', '动员', '老兵', '协力', '免疫', '山地', '流亡',
  '开发', '抽取', '收缴', '控制', '转换', '情报', '重甲', '压制', '被压制', '被守护', '被收缴', '烟幕', '隐蔽', '钳击'];

const tidy = s => String(s || '')
  .replace(/(\S) (?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g, '$1')
  .replace(/([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]) (?=\S)/g, '$1')
  .replace(/\s+/g, ' ').trim();
const isNum = s => /^\d{1,2}$/.test(String(s).trim()) || /^[oO0]$/.test(String(s).trim());
const numOf = s => { const t = String(s).trim(); if (/^\d{1,2}$/.test(t)) return t; if (/^[oO]$/.test(t)) return '0'; return null; };

// 文件名解析：{cost}费【{nation}】{rarity} {name}[备]；研发卡还有 "XXX"衍生 前缀
function parseName(base) {
  let b = base.replace(/\.(png|jpe?g|webp|bmp)$/i, '');
  const derivedBy = (b.match(/[“”"](.+?)[“”"]\s*衍生/) || [])[1] || null;   // 首尾引号都可能写成 “ 或 ”（用户文件里两种都有）
  const m = b.match(/^(\d+)费\s*【(.+?)】\s*(金|银|铜|铁|衍生|)\s*(.+)$/);
  if (!m) return { cost: null, nation: '未标注', rarity: '?', name: b.replace(/\s*\[备\]\s*$/, ''), backup: /\[备\]/.test(b), derivedBy };
  return {
    cost: Number(m[1]), nation: m[2], rarity: m[3] || '?',
    name: m[4].replace(/\[备\]/g, '').trim(), backup: /\[备\]/.test(b), derivedBy,
  };
}

// 单卡字段提取（坐标基于 500×702 卡面；自动按实际尺寸换算）
// 实测校准（白描网页版 words_result）：费用 y≈30 x≈16；卡名 单位 y≈21 x≈200 h≈57 / 指令 y≈504；
//   K 图标常被识别成 + / к / K；攻 y≈497 x≈107；血 y≈496 x≈347；效果 y≥558
function extract(rec, W, H, metaCost) {
  const k = W / 500;
  const ws = (rec.words || []).map(w => ({ ...w, kx: w.x / k, ky: w.y / k, kw: w.w / k, kh: w.h / k }));
  const inBox = (x0, y0, x1, y1) => ws.filter(w => w.kx >= x0 && w.kx < x1 && w.ky >= y0 && w.ky < y1);
  const join = arr => tidy(arr.sort((a, b) => a.ky - b.ky || a.kx - b.kx).map(w => w.t).join(''));
  const out = {};

  // 费用 / 油费：左上徽章里的数字。K 图标极易被误读（常并进费用读成 15/25），
  //   故以文件名标注的费用为准；徽章里剩下的数字才当油费，且标记可信度。
  const badgeNums = inBox(0, 0, 130, 115).filter(w => numOf(w.t) !== null).sort((a, b) => a.kx - b.kx);
  const bn = badgeNums.map(w => numOf(w.t));
  out.cost = null; out.fuel = null; out.fuelSure = false;
  if (bn.length) {
    const fc = metaCost;
    if (fc != null) {
      out.cost = String(fc);
      const one = v => (/^\d$/.test(String(v)) ? String(v) : null);   // 油费只可能是单个数字，多位数是卡面杂讯
      if (bn[0] === String(fc)) { const f1 = one(bn[1]); if (f1) { out.fuel = f1; out.fuelSure = true; } }
      else if (bn[0] === String(fc) + '5') { out.fuel = '5'; out.fuelSure = false; }  // 费用+K图标(误读为5)
      else { const f1 = one(bn[1]); if (f1) { out.fuel = f1; out.fuelSure = true; } }
    } else {
      out.cost = bn[0];
      if (/^\d$/.test(String(bn[1] || ''))) { out.fuel = String(bn[1]); out.fuelSure = true; }
    }
  } else if (metaCost != null) out.cost = String(metaCost);

  // 攻 / 血：卡面下部的两个军标数字
  const atkW = inBox(80, 465, 270, 565).filter(w => numOf(w.t) !== null);
  const hpW = inBox(300, 465, 440, 565).filter(w => numOf(w.t) !== null);
  out.atk = atkW.length ? numOf(atkW.sort((a, b) => a.kx - b.kx)[0].t) : null;
  out.hp = hpW.length ? numOf(hpW.sort((a, b) => a.kx - b.kx)[0].t) : null;

  // 卡名：单位卡在顶部标题带（x≥60 排除徽章；标题字号是卡面最大的，故按高度取"最大簇"，
  //   并卡住 y≤80、25≤h≤75，避免把美术里的英文/竖排文字（如「三月十日」「COAST GUA.」）当卡名）；
  //   指令卡在下部标题带（y 478–556，不能再往下——效果正文从 y≈558 开始）
  const cjk = s => /[\u4e00-\u9fffA-Za-z]/.test(s);
  const pickTitle = arr => {
    if (!arr.length) return [];
    const maxH = Math.max(...arr.map(w => w.kh));
    return arr.filter(w => w.kh >= Math.max(25, maxH * 0.72));
  };
  const topTitle = pickTitle(inBox(60, 5, 490, 82).filter(w => cjk(w.t) && w.kh >= 25 && w.kh <= 75 && w.kw >= 25));
  const botTitle = pickTitle(inBox(15, 478, 490, 545).filter(w => cjk(w.t) && w.kh >= 38 && w.kw >= 24));
  // 指令卡的美术里常有英文/花体标题（如「USELESSASISIA」压在 y=11），若下方有中文标题、上方又无中文，按下方的算
  const topHasCJK = topTitle.some(w => /[\u4e00-\u9fff]/.test(w.t));
  const isOrder = botTitle.length > 0 && (topTitle.length === 0 || !topHasCJK);
  out.kind = isOrder ? 'order' : 'unit';
  out.name = join(isOrder ? botTitle : topTitle)
    .replace(/[“”"'.。，、]/g, '')
    .replace(/[★☆+＋›»]+$/g, '')                    // 卡框装饰被并进名字
    .replace(/(?<=[\u4e00-\u9fff])十$/g, '');        // 同上，被识别成「十」的情况

  // 关键词与效果文本（按行聚合；过滤孤立单字噪声，如卡框上的「女」）
  const textBox = isOrder ? inBox(15, 545, 492, 694) : inBox(15, 550, 492, 694);
  const byLine = new Map();
  for (const w of textBox) {
    const key = Math.round(w.ky / 20);
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(w);
  }
  const lines = [], kws = [];
  for (const key of [...byLine.keys()].sort((a, b) => a - b)) {
    const arr = byLine.get(key).sort((a, b) => a.kx - b.kx);
    const lineTxt = tidy(arr.map(w => w.t).join(''));
    if (!lineTxt) continue;
    const flat = lineTxt.replace(/\s/g, '');
    // 关键词行：整行由“词条(+数字)”构成，允许逗号/顿号分隔多个（如「闪击，重甲2」）
    const parts = flat.split(/[，,、;；]+/).filter(Boolean);
    const kwParts = parts.filter(p => KEYWORDS.some(kw => new RegExp('^' + kw + '\\d*$').test(p)));
    if (kwParts.length && kwParts.length === parts.length && flat.length <= 16) { kws.push(...kwParts); continue; }
    if (flat.length <= 1 && arr.length === 1) continue;      // 孤立单字：卡框装饰噪声
    lines.push(lineTxt);
  }
  out.keywords = [...new Set(kws)];
  out.effect = tidy(lines.join('')).replace(/\s+([，。、；：！？）」】%])/g, '$1');
  return out;
}

const circles = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿';

/* ---------- 现有卡库索引（src/cards.js）：用来标注「已收录 / 新卡」并补权威字段 ---------- */
const TYPE_CN = { infantry: '步兵', tank: '坦克', artillery: '炮兵', fighter: '战斗机', bomber: '轰炸机' };
const CODE_INDEX = new Map();
const NAT_CN = { us: '美', de: '德', su: '苏', gb: '英', jp: '日', pl: '波', fr: '法', fi: '芬', it: '意', cn: '中' };
try {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const C = req(path.join(CODE_DIR, 'cards.js'));
  const add = (entry, kind, nat) => {
    const key = String(entry.n).replace(/[\s·]/g, '');
    if (!CODE_INDEX.has(key)) CODE_INDEX.set(key, { ...entry, kind, nat: NAT_CN[nat] || nat });
  };
  for (const [key, nat] of Object.entries(C.NATIONS || {})) {
    for (const u of nat.units || []) add(u, 'unit', key);
    for (const o of nat.orders || []) add(o, 'order', key);
    for (const o of nat.counters || []) add(o, 'counter', key);
  }
  for (const [k, v] of Object.entries(C.DERIVED_CARDS || {})) add({ ...v, id: k }, 'derived', v.nation || '?');
} catch (e) { console.error('（未能加载现有卡库，跳过交叉核对：' + e.message + '）'); }
// 同一张卡的判定：**卡名完全相同 + 国家相同**（用户口径：名字不同、或名字同但国家不同，都是另一张卡）
const codeOf = (name, nation) => {
  const raw = String(name || '').replace(/[\s·]/g, '');
  const nat = nation && nation !== '未标注' ? nation : null;
  const hit = CODE_INDEX.get(raw);
  if (hit && (!nat || hit.nat === nat)) return { entry: hit, exact: true, nationDiff: false };
  if (hit) return { entry: hit, exact: false, nationDiff: true };      // 同名但国家不同 → 不是同一张卡
  // 名字相近（虎王 ↔ 虎王坦克II型）：同样只作提示，按新卡处理
  const strip = s => s.replace(/[（(].*?[)）]/g, '').replace(/(坦克|步兵|炮兵|战斗机|轰炸机|型|式|Mk|MK|II|III|IV|I)+$/g, '');
  const s0 = strip(raw);
  for (const [, v] of CODE_INDEX) if (strip(String(v.n).replace(/[\s·]/g, '')) === s0 && s0.length >= 2) return { entry: v, exact: false, nationDiff: !!(nat && v.nat !== nat) };
  return null;
};

// 兵种推测（用户约定：单位类型按卡名猜，标「推测」，拿不准留 ?）
const TYPE_RULES = [
  ['步兵', /掷弹兵|伞兵|空降|陆战|山地兵|滑雪|游击队?|民兵|工兵|突击队|别动队|卫队|警卫|步兵|步兵团|国民|青年团/],
  ['战斗机', /战斗机|歼击机|喷火|零式|野马|雷电|飓风|台风|暴风|海火|海怒|地狱猫|海盗船|野猫|水牛|战鹰|小鹰|眼镜蛇|角斗士|英俊战士|橘花|喷气|Me\s?\d|Bf\s?\d|Fw\s?\d|P-?\d|F4U|F6F|雅克|拉-\d|米格|流星|闪电|紫电|疾风|钟馗|飞燕|一式战|二式战|三式战|四式战/],
  ['轰炸机', /轰炸机|俯冲|斯图卡|斯图|兰开斯特|惠灵顿|威灵顿|哈利法克斯|斯特林|布伦亨|布伦海姆|汉普登|惠特利|桑德兰|蚊式|剑鱼|梭鱼|大青花鱼|无畏|复仇者|伊尔|牛津|一式陆攻|九七式|九九式|百式重爆|吞龙|银河|飞龙|连山|深山|He\s?1\d\d|Ju\s?\d|B-?\d\d|佩-?2|Tu-?2|Ki-?\d+/],
  ['炮兵', /火炮|炮兵|榴弹|加农|迫击|火箭|喀秋莎|重炮|野战炮|高射炮|反坦克炮|掷弹筒|山炮|铁道炮|岸防炮|多管|主教|牧师|野蜂|黄蜂|喀秋|B-?4|M7|安德柳沙|英寸|炮$/],
  ['坦克', /坦克|装甲|亨伯|戴姆勒|猎鹿犬|灰狗|虎|豹|鼠|象式|犀牛|潘兴|谢尔曼|斯图亚特|甜心|格兰特|瓦伦丁|丘吉尔|玛蒂尔达|十字军|克伦威尔|彗星|半履带|装甲车|自行|突击炮|山猫|美洲狮|旋风|IS-?\d|KV-?\d|SU-?\d|T-?\d\d?|M\d+A?\d|M6(?![0-9])|四号|三号|黑豹/],
  ['步兵', /联队|独立团|兵团|军团|团$|营$|师$|旅$|大队|中队|小队|第\d+/],
];
function guessType(name) {
  const n = String(name || '').replace(/\s/g, '');
  for (const [t, re] of TYPE_RULES) if (re.test(n)) return t;
  return '?';
}
const NATION_LABEL = { 德: '德国', 日: '日本', 意: '意大利', 美: '美国', 苏: '苏联', 英: '英国', 法: '法国', 波: '波兰', 芬: '芬兰', 中立: '中立', 未标注: '未标注' };

/* ---------- 主流程 ---------- */
const raw = fs.readFileSync(OCR, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
// 同一文件可能有多条记录（重跑修正串号）→ 每个文件只保留最后一条
const lastBy = new Map();
for (const r of raw) lastBy.set(r.file, r);
const rows = [...lastBy.values()];
const ok = rows.filter(r => r.ok);
const failed = rows.filter(r => !r.ok);
const cards = [];
const renameLog = [];
const pending = [];
const suspects = [];
const skipped = [];   // 源目录里的辅助图（不是卡牌），不参与文档/改名
const dropped = [];   // 卡库已有且数值一致 → 从结果里剔除
const nearNames = []; // 与卡库卡名相近但名字不同（按新卡处理，仅作提示）
const SKIP_RE = /识别参考|参考图|截图|screenshot|示例|模板|底图|temp|副本/i;
// 串号检测用：源目录里所有文件名包含的卡名 → 文件（含 OCR 失败的，失败的那张也可能被别人读走）
const normName = s => String(s || '')
  .replace(/[\s·]/g, '').replace(/[“”"']/g, '')
  .replace(/[（(\[](老兵|备|备选)[)）\]]/g, '');
const fileNames = new Map();
try {
  for (const fn of fs.readdirSync(SRC)) {
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(fn)) continue;
    const nm = normName(parseName(fn.replace(/\.(png|jpe?g|webp|bmp)$/i, '')).name);
    if (nm && !fileNames.has(nm)) fileNames.set(nm, fn);
  }
} catch {}

for (const r of ok) {
  const base = r.file.replace(/\.(png|jpe?g|webp|bmp)$/i, '');
  if (SKIP_RE.test(base)) { skipped.push(r.file); continue; }
  const meta = parseName(base);
  const ovNat = natOverride(r.file);
  if (ovNat && (meta.nation === '未标注' || !meta.nation)) { meta.nation = ovNat; meta.nationFrom = '人工覆盖表'; }
  const ovRar = ovLookup('rarities', r.file);
  if (ovRar) meta.rarity = ovRar;
  const src = path.join(SRC, r.file);
  let W = 500, H = 702;
  const dim = DIMS[r.file];
  if (dim && dim[0]) { W = dim[0]; H = dim[1]; }
  else { try { const b = fs.readFileSync(src); if (b[0] === 0x89) { W = b.readUInt32BE(16); H = b.readUInt32BE(20); } } catch {} }
  const f = extract(r, W, H, meta.cost);
  // 卡名以「卡面识别」为准；识别不到才退回文件名
  let name = (f.name || '').replace(/\s/g, '');
  let nameSrc = '卡面';
  if (!name || name.length < 2) { name = meta.name.replace(/\s/g, ''); nameSrc = '文件名'; }
  // 类型：指令/单位由版式判定；单位细分按卡名推测；反制按效果文本判定（已人工确认「规避动作/拦截」两张）
  let type = f.kind === 'order' ? '指令' : guessType(name);
  if (f.kind === 'order' && /反制/.test(f.effect || '')) type = '反制';
  // 与现有卡库交叉核对：只有「完全同名」才算卡库已有（拿权威兵种/补数值）；
  //   名字相近但不同的（虎王 vs 虎王坦克II型）按新卡处理，只记个提示
  const codeHit = codeOf(name, meta.nation) || codeOf(meta.name, meta.nation);
  const code = codeHit ? codeHit.entry : null;
  let kindCode = null, known = !!(codeHit && codeHit.exact), filledFrom = [];
  if (known) {
    kindCode = code.kind;
    if (code.kind === 'counter') type = '反制';
    else if (code.kind === 'order') type = '指令';
    else if (code.kind === 'unit' && TYPE_CN[code.t]) type = TYPE_CN[code.t];
  } else if (code) {
    nearNames.push({ face: name, code: code.n, cardNat: meta.nation, codeNat: code.nat, nationDiff: !!codeHit.nationDiff, nameDiff: String(code.n).replace(/[\s·]/g, '') !== String(name).replace(/[\s·]/g, '') });
  }
  const ovCost = ovLookup('costs', r.file);
  const card = {
    ...meta, file: r.file, name, nameSrc, type,
    cost: ovCost != null ? String(ovCost) : (f.cost ?? (meta.cost != null ? String(meta.cost) : '?')),
    fuel: f.fuel, fuelSure: !!f.fuelSure, atk: f.atk, hp: f.hp,
    keywords: f.keywords, effect: f.effect,
    isDerived: !!meta.derivedBy || meta.rarity === '衍生',
    derivedBy: meta.derivedBy, veteran: /\(老兵\)/.test(base),
    known, kindCode, codeName: known ? code.n : null, nearCode: !known && code ? code.n : null, filledFrom,
    codeC: code && code.c != null ? String(code.c) : null,
    codeF: code && code.f != null ? String(code.f) : null,
    codeA: code && code.a != null ? String(code.a) : null,
    codeH: code && code.h != null ? String(code.h) : null,
  };
  // 数据完整性：识别名撞上「别的卡」的文件名 → 极可能是上一张的残留结果（串号）
  // 文件名里的「"XXX"衍生 卡名」前缀不算不一致，比较时取「衍生」之后的部分
  const cleanFile = meta.derivedBy ? meta.name.replace(/^.*?衍生\s*/, '') : meta.name;
  const gotName = normName(name), ownName = normName(cleanFile);
  if (gotName !== ownName) {
    const other = fileNames.get(gotName);
    if (other && other !== r.file) { card.suspect = other; suspects.push({ file: r.file, got: name, other }); }
    else card.nameDiffers = true;
  }
  // OCR 没读到的字段，用现有卡库补（并注明来源）
  if (known && type !== '反制' && type !== '指令') {
    if (!card.atk && code.a != null) { card.atk = String(code.a); filledFrom.push('攻击'); }
    if (!card.hp && code.h != null) { card.hp = String(code.h); filledFrom.push('血量'); }
    if (!card.fuel && code.f != null) { card.fuel = String(code.f); card.fuelSure = true; card.fuelSrc = '现有卡库'; filledFrom.push('油费'); }
  }
  cards.push(card);
  // 油费优先级：燃油位裁剪专读 > 徽章 > 现有卡库（老兵形态数值不同，不套用卡库）
  const crop = fuelMap[r.file];
  if (crop != null && /^\d{1,2}$/.test(String(crop))) { card.fuel = String(crop); card.fuelSure = true; card.fuelSrc = '燃油位裁剪'; }
  else if (card.fuel) card.fuelSrc = card.fuelSure ? '徽章' : '徽章(存疑)';
  else card.fuelSrc = '';
  // 攻/血：整卡 OCR 漏读或读歪时，用裁剪位专读结果补/纠正
  const isUnitCard = card.type !== '指令' && card.type !== '反制';
  const cv = m => { const v = m[r.file]; return v != null && /^\d{1,2}$/.test(String(v)) ? String(v) : null; };
  if (isUnitCard) {
    const ca = cv(atkMap), ch = cv(hpMap);
    if (ca && !card.atk) { card.atk = ca; card.filledFrom.push('攻击(裁剪)'); }
    else if (ca && card.atk && ca !== card.atk) { card.filledFrom.push(`攻击(裁剪修正 原读${card.atk})`); card.atk = ca; }
    if (ch && !card.hp) { card.hp = ch; card.filledFrom.push('血量(裁剪)'); }
    else if (ch && card.hp && ch !== card.hp) { card.filledFrom.push(`血量(裁剪修正 原读${card.hp})`); card.hp = ch; }
  }
  if (known && isUnitCard && !card.veteran) {
    if (!card.atk && code.a != null) { card.atk = String(code.a); filledFrom.push('攻击'); }
    if (!card.hp && code.h != null) { card.hp = String(code.h); filledFrom.push('血量'); }
    if (!card.fuel && code.f != null) { card.fuel = String(code.f); card.fuelSure = true; card.fuelSrc = '现有卡库'; filledFrom.push('油费'); }
  }
  // 卡库去重：卡库已有、且费用/油费/攻击/血量都与卡库一致（或卡面没读到）→ 纯重复，整张剔除
  //   注意：卡库已有但数值不同的属于「改版」，必须保留
  const diffsFromCode = [];
  if (card.known && isUnitCard) {
    const cmp = (label, mine, codeV) => { if (mine != null && codeV != null && String(mine) !== String(codeV)) diffsFromCode.push(`${label} 卡面${mine}/卡库${codeV}`); };
    cmp('花费', card.cost, card.codeC);
    cmp('油费', card.fuel, card.codeF);
    cmp('攻击', card.atk, card.codeA);
    cmp('血量', card.hp, card.codeH);
  }
  card.diffsFromCode = diffsFromCode;
  const isDuplicate = DROP_KNOWN && card.known && !card.veteran && !diffsFromCode.length;
  if (isDuplicate) { cards.pop(); dropped.push({ name: card.name, file: card.file, codeName: card.codeName }); continue; }
  // 待补字段在「衍生推断」之后统一重算（见下方），这里不动
  // 重命名：识别名 + 类型后缀（衍生/老兵/备选），仅在本批内部去重（不参考上次跑留下的同名文件）
  const suffix = (card.isDerived ? '（衍生）' : '') + (card.veteran ? '（老兵）' : '');
  const newName = name + suffix;
  const ext = path.extname(r.file);
  let target = newName + ext, i = 2;
  while (renameLog.some(x => x.to === target)) { target = newName + '(' + (i++) + ')' + ext; }
  renameLog.push({ from: r.file, to: target, name, nameSrc, type: card.type, known: card.known, derived: card.isDerived, derivedBy: card.derivedBy || '', veteran: card.veteran });
  card.newFile = target;
}

/* ---------- 安全写入：绝不覆盖用户手改过的文件 ----------
   规则（用户明确要求）：文件已存在且内容与"我们上次生成的"不一致 → 认为用户改过 → 不覆盖，
   改写到 <文件名>.新生成，并在日志里大声提示；只有内容一致（无变化）或加 --force 才覆盖。 */
const STATE_PATH = path.join(OUT, '.生成状态.json');
const FORCE = process.argv.includes('--force');
const sha1 = s => { const h = require$crypto.createHash('sha1'); h.update(String(s), 'utf8'); return h.digest('hex'); };
const conflicts = [];
function safeWrite(file, content, label) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  const key = path.relative(OUT, file).replace(/\\/g, '/');
  const prevHash = state[key];
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur === content) { state[key] = sha1(cur); fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1), 'utf8'); return 'same'; }
    const curHash = sha1(cur);
    const userTouched = FORCE ? false : (prevHash !== curHash);
    if (userTouched) {
      const alt = file + '.新生成';
      fs.writeFileSync(alt, content, 'utf8');
      conflicts.push({ file: key, alt: path.basename(alt) });
      return 'conflict';
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  state[key] = sha1(content);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1), 'utf8');
  return fs.existsSync(file) ? 'ok' : 'ok';
}

// 判定依据很窄、很安全：只认「抉择：将1张“X”或1张“Y”…」这种从牌库外生成的写法。
//   被引用的卡 = 该卡的衍生卡；引用者 = 母卡。
const zhRefs = [];
for (const c of cards) {
  const eff = String(c.effect || '');
  if (!/抉择/.test(eff)) continue;
  for (const m of eff.matchAll(/[“「"]([^”」"]{2,20})[”」"]/g)) zhRefs.push({ child: m[1].replace(/\s/g, ''), parent: c.name, parentFile: c.file });
}
const byName = new Map(cards.map(c => [c.name, c]));
let inferred = 0;
for (const r of zhRefs) {
  const child = byName.get(r.child);
  if (!child || child === byName.get(r.parent)) continue;
  if (!child.isDerived) { child.isDerived = true; inferred++; }
  if (!child.derivedBy) child.derivedBy = r.parent;
}
// 另外两种「从牌库外生成」的安全写法：洗入卡组 / 置于卡组顶（不含「加入支援阵线」——那也可能是从牌库里拿）
const genRefs = [];
for (const c of cards) {
  const eff = String(c.effect || '');
  if (!/洗入卡组|置于卡组顶/.test(eff)) continue;
  for (const m of eff.matchAll(/[“「"]([^”」"]{2,20})[”」"]/g)) genRefs.push({ child: m[1].replace(/\s/g, ''), parent: c.name });
}
for (const r of genRefs) {
  const child = byName.get(r.child);
  if (!child || child === byName.get(r.parent)) continue;
  if (!child.isDerived) { child.isDerived = true; inferred++; }
  if (!child.derivedBy) child.derivedBy = r.parent;
}
// 待补字段（衍生推断之后统一重算；衍生卡在 KARDS 里没有稀有度，不进卡池，故不查稀有度）
pending.length = 0;
for (const c of cards) {
  const isUnit = c.type !== '指令' && c.type !== '反制';
  const miss = [];
  if (!c.isDerived && (!c.rarity || c.rarity === '?')) miss.push('稀有度');
  if (!c.cost || c.cost === '?') miss.push('花费');
  if (c.type === '?') miss.push('类型(卡名猜不出)');
  if (isUnit && !c.fuel) miss.push('油费');
  else if (isUnit && !c.fuelSure) miss.push('油费(读数存疑)');
  if (isUnit && !c.atk) miss.push('攻击');
  if (isUnit && !c.hp) miss.push('血量');
  if (!c.keywords.length && isUnit) miss.push('词条(可能无，请核对)');
  if (!c.effect) miss.push('效果');
  if (miss.length) pending.push(`${c.name}（${c.file}）：` + miss.join('、'));
}

// 其它「从牌库外生成」的引用（洗入卡组 / 置于卡组顶 / 加入支援阵线 / 加入手中）——只作提示，不自动判定是否衍生
const refHints = [];
for (const c of cards) {
  const eff = String(c.effect || '');
  if (!/洗入卡组|置于卡组顶|加入支援阵线|加入手中|加入手牌/.test(eff)) continue;
  for (const m of eff.matchAll(/[“「"]([^”」"]{2,20})[”」"]/g)) {
    const nm = m[1].replace(/\s/g, '');
    const t = byName.get(nm);
    if (t && t !== c) refHints.push({ child: nm, parent: c.name, derived: !!t.isDerived });
  }
}

if (process.argv.includes('--dry')) {
  for (const c of cards) {
    console.log(`\n${c.file}\n  名=[${c.name}](${c.nameSrc}) ${c.known ? '已收录' : '★新卡'} ${c.type} 费=${c.cost} 油=${c.fuel ?? '-'}(${c.fuelSrc || '无'}) 攻=${c.atk ?? '-'} 血=${c.hp ?? '-'} 词条=[${c.keywords.join(',')}]${c.veteran ? ' [老兵]' : ''}${c.isDerived ? ' [衍生]' : ''}`);
    console.log(`  效=[${c.effect}]`);
  }
  console.log(`\n共 ${cards.length}，待补 ${pending.length}：\n  ` + pending.join('\n  '));
  process.exit(0);
}

/* 写文件（先清空本组目录，避免上次跑剩下的同名文件把新结果挤成 (2)(3)） */
const groupDir = path.join(OUT, GROUP);
if (!NO_COPY) fs.mkdirSync(groupDir, { recursive: true });      // 要复制图片时才建组目录（--no-copy 不留空目录）
let wiped = 0;
if (!NO_COPY) {          // 只有真要复制时才清空目标目录（--no-copy 时绝不动已有图片）
  for (const f of fs.readdirSync(groupDir)) {
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(f)) continue;
    try { fs.unlinkSync(path.join(groupDir, f)); wiped++; } catch {}
  }
  if (wiped) console.log(`（清掉上次遗留图片 ${wiped} 张）`);
}
let copied = 0;
for (const c of cards) {
  if (!c.newFile || NO_COPY) continue;
  if (!fs.existsSync(path.join(SRC, c.file))) continue;
  const s = path.join(SRC, c.file), d = path.join(groupDir, c.newFile);
  try { fs.copyFileSync(s, d); copied++; } catch (e) { console.error('复制失败 ' + c.file + ' : ' + e.message); }
}

/* 文档：先按国家，国家内再分 单位 / 指令 / 衍生卡 */
const byNation = new Map();
for (const c of cards) {
  if (!byNation.has(c.nation)) byNation.set(c.nation, []);
  byNation.get(c.nation).push(c);
}
const NATION_ORDER = ['德', '日', '美', '苏', '英', '法', '波', '芬', '意', '中立', '未标注'];
const nations = [...byNation.keys()].sort((a, b) => (NATION_ORDER.indexOf(a) + 99) % 100 - (NATION_ORDER.indexOf(b) + 99) % 100);

let doc = `【${GROUP}】卡牌数据表（由白描网页版 OCR 自动生成）
（卡名取自卡面文字识别；稀有度/花费优先取文件名与卡面徽章；词条、效果取自卡面；
  兵种：现有卡库里有同名卡的取卡库权威值，其余按卡名推测；油费由「燃油位裁剪放大」单独识别；
  仍有个别字段需人工核对，见文末「待人工补」）

共 ${cards.length} 张
  单位 ${cards.filter(c => c.type !== '指令' && c.type !== '反制').length} / 指令 ${cards.filter(c => c.type === '指令').length} / 反制 ${cards.filter(c => c.type === '反制').length}
  衍生卡 ${cards.filter(c => c.isDerived).length} 张；老兵形态 ${cards.filter(c => c.veteran).length} 张；OCR 失败 ${failed.length} 张
${(() => {
  const kept = cards.filter(c => c.known).length, totalKnown = kept + dropped.length;
  if (!totalKnown) return `  卡库没有同名同国的卡（本次全是要新建的卡）：${cards.length} 张`;
  return `  卡库中「卡名+国家都相同」的卡 ${totalKnown} 张：其中 ${dropped.length} 张数值也一致 → 已剔除；保留 ${kept} 张数值有出入的（同一张卡的数值更新）`;
})()}
  油费：裁剪识别 ${cards.filter(c => c.fuelSrc === '燃油位裁剪').length} 张 / 卡库补 ${cards.filter(c => c.fuelSrc === '现有卡库').length} 张 / 待补 ${cards.filter(c => (c.type === '步兵' || c.type === '坦克' || c.type === '炮兵' || c.type === '战斗机' || c.type === '轰炸机' || c.type === '?') && !c.fuel).length} 张
  卡名：卡面识别 ${cards.filter(c => c.nameSrc === '卡面').length} 张，退回文件名 ${cards.filter(c => c.nameSrc === '文件名').length} 张
  与文件名标注不一致 ${cards.filter(c => c.nameDiffers || c.suspect).length} 张（其中疑似串号 ${suspects.length} 张，见文末）
${dropped.length ? `  已剔除「卡名+国家都相同且数值一致」的重复卡 ${dropped.length} 张（不需要再做；同名同国但数值不同的会保留并标注）\n` : ''}${skipped.length ? `  已跳过非卡牌辅助图 ${skipped.length} 张：${skipped.join('、')}\n` : ''}`;
for (const nation of nations) {
  const list = byNation.get(nation);
  const units = list.filter(c => !c.isDerived && c.type !== '指令' && c.type !== '反制');
  const orders = list.filter(c => !c.isDerived && c.type === '指令');
  const counters = list.filter(c => !c.isDerived && c.type === '反制');
  const derived = list.filter(c => c.isDerived);
  doc += `\n\n════════ 【${nation}】${NATION_LABEL[nation] || nation} · ${list.length} 张 ════════\n`;
  const section = (title, arr, unitStyle) => {
    if (!arr.length) return '';
    let s = `\n──────── ${title}（${arr.length}） ────────\n`;
    arr.sort((a, b) => (+a.cost || 99) - (+b.cost || 99) || a.name.localeCompare(b.name, 'zh'));
    arr.forEach((c, i) => {
      const tags = [];
      if (c.veteran) tags.push('老兵形态·与本体同一张卡，不进卡池');
      if (c.diffsFromCode && c.diffsFromCode.length) tags.push('卡库同名同国，数值有出入');
      if (c.nameSrc === '文件名') tags.push('卡名取自文件名');
      s += `\n${circles[i] || '(' + (i + 1) + ')'} ${c.name}${tags.length ? '（' + tags.join('，') + '）' : ''}\n`;
      if (!c.isDerived) s += `    稀有度：${c.rarity}\n`;      // 衍生卡没有稀有度（下面统一写「无」）
      else s += `    稀有度：无\n`;
      if (unitStyle) {
        s += `    类型：${c.type}${c.known ? '（现有卡库）' : c.type === '?' ? '' : '（按卡名推测）'}\n`;
        s += `    部署花费：${c.cost}\n`;
        s += `    油费：${c.fuel ?? '?'}${c.fuelSrc === '徽章(存疑)' ? '（存疑）' : ''}\n`;
        s += `    攻击：${c.atk ?? '?'}\n`;
        s += `    血量：${c.hp ?? '?'}\n`;
        s += `    词条：${c.keywords.length ? c.keywords.join('、') : '无'}\n`;
      } else {
        s += `    花费：${c.cost}\n`;
      }
      if (c.isDerived && c.derivedBy) s += `    来源：${c.derivedBy}（衍生）\n`;
      if (c.filledFrom.length) s += `    （${c.filledFrom.join('、')}取自现有卡库/裁剪识别）\n`;
      if (c.diffsFromCode && c.diffsFromCode.length) s += `    （与现有卡库不一致：${c.diffsFromCode.join('；')}）\n`;
      s += `    效果：${c.effect || (unitStyle ? '无（卡面没有效果文本，白板单位，请核对）' : '?')}\n`;
      s += `    （文件名：${c.file}）\n`;
    });
    return s;
  };
  doc += section('单 位', units, true);
  doc += section('指 令', orders, false);
  doc += section('反 制', counters, false);
  doc += section('衍 生 卡', derived, derived.some(d => d.type !== '指令' && d.type !== '反制'));
}
// 附录零：疑似串号（识别结果疑似是上一张卡的）——排在最前，必须先处理再谈其它
if (suspects.length) {
  doc += `\n\n──────── ⚠ 疑似串号（识别名撞上了别的卡的文件名，需重识别；共 ${suspects.length} 张） ────────\n`;
  for (const s of suspects) doc += `  ✗ ${s.file}\n      识别成「${s.got}」，而这是 ${s.other} 的卡名 → 本张需重跑\n`;
}
if (failed.length) {
  doc += `\n\n──────── OCR 失败（${failed.length}） ────────\n`;
  failed.forEach(r => { doc += `  ✗ ${r.file}  ${r.err || ''}\n`; });
}
// 附录一：卡库未收录清单（全部都要用，这里只作「还没写进 cards.js」的进度清单）
const newCards = cards.filter(c => !c.known);
doc += `\n\n──────── 附：尚未写入卡库清单（共 ${newCards.length} 张，全部都会用，逐步补齐） ────────\n`;
for (const nation of nations) {
  const arr = newCards.filter(c => c.nation === nation);
  if (!arr.length) continue;
  doc += `\n【${NATION_LABEL[nation] || nation}】${arr.length} 张\n`;
  arr.sort((a, b) => (+a.cost || 99) - (+b.cost || 99) || a.name.localeCompare(b.name, 'zh'));
  for (const c of arr) {
    const stat = c.type === '指令' || c.type === '反制'
      ? `${c.cost}费`
      : `${c.cost}费/${c.fuel ?? '?'}油/${c.atk ?? '?'}攻/${c.hp ?? '?'}血`;
    doc += `  ${c.name}${c.veteran ? '（老兵）' : ''}${c.isDerived ? '（衍生）' : ''} — ${c.rarity}/${c.type}/${stat}${c.keywords.length ? '/' + c.keywords.join('、') : ''}\n`;
  }
}
// 附录：与卡库卡名相同/相近但**不是同一张卡**（按新卡处理，提醒别搞混）
if (nearNames.length) {
  doc += `\n\n──────── 附：与卡库卡名相同或相近、但不是同一张卡（按新卡处理，共 ${nearNames.length} 张） ────────\n`;
  for (const n of nearNames) {
    const why = [];
    if (n.nationDiff) why.push(`国家不同（卡面${n.cardNat} / 卡库${n.codeNat}）`);
    if (n.nameDiff) why.push('名字不同');
    doc += `  · 卡面「${n.face}」（${n.cardNat}） ↔ 卡库另有「${n.code}」（${n.codeNat}）：${why.join('，')} → 各算一张\n`;
  }
}
// 附录：被别的卡「从牌库外生成/洗入」的卡名（判断衍生的线索，供核对）
if (refHints.length) {
  doc += `\n\n──────── 附：被其他卡效果生成/洗入的卡（${refHints.length} 处，用于核对衍生关系） ────────\n`;
  for (const h of refHints) doc += `  · 「${h.child}」 ← 由「${h.parent}」生成${h.derived ? '（已标为衍生）' : '（未标衍生，请核对）'}\n`;
}
// 附录：老兵形态（与本体同一张卡；素材按「卡名（老兵）.png」放同国目录）
const vets = cards.filter(c => c.veteran);
if (vets.length) {
  doc += `\n\n──────── 附：老兵形态（${vets.length} 张，与本体是同一张卡，不进卡池；素材名「卡名（老兵）.png」） ────────\n`;
  for (const v of vets) {
    const baseFile = parseName(v.file.replace(/\.(png|jpe?g|webp|bmp)$/i, '')).name.replace(/[（(]老兵[)）]/, '').trim();
    doc += `  · ${v.nation} ${v.name}（老兵） ${v.cost}费 ${v.atk ?? '?'}/${v.hp ?? '?'}${v.keywords.length ? ' ' + v.keywords.join('、') : ''} —— 本体：${baseFile}${/老兵/.test(v.srcFile) && !fileNames.has(normName(baseFile)) ? '（本批没有本体素材）' : ''}\n`;
  }
}
// 附录：重命名记录（卡面名与原文件名标注不同，改名时以卡面名为准）
const nameDiffs = cards.filter(c => c.nameDiffers && !c.suspect);
if (nameDiffs.length) {
  doc += `\n\n──────── 附：重命名记录（卡面名与原文件名标注不同，共 ${nameDiffs.length} 处，改名按卡面名） ────────\n`;
  for (const c of nameDiffs) { const pn = parseName(c.file.replace(/\.(png|jpe?g|webp|bmp)$/i, '')); doc += `  · 卡面「${c.name}」 ←→ 原文件名「${pn.derivedBy ? pn.name.replace(/^.*?衍生\s*/, '') : pn.name}」\n`; }
}
doc += `\n\n──────── 待人工补（${pending.length} 项） ────────\n`;
pending.forEach(p => { doc += `  · ${p}\n`; });
safeWrite(path.join(OUT, `${GROUP}_文档.txt`), doc, '文档');

/* 重命名对照表（--minimal 不写） */
if (!MINIMAL) {
  const cmp = `【${GROUP}】重命名对照（${renameLog.length} 张；卡名以卡面 OCR 为准）
${renameLog.map(r => `${r.from}\n    → ${r.to}    卡名=${r.name}（${r.nameSrc}） 类型=${r.type}${r.derived ? ' [衍生' + (r.derivedBy ? '·' + r.derivedBy : '') + ']' : ''}${r.veteran ? ' [老兵]' : ''}`).join('\n')}
`;
  fs.writeFileSync(path.join(OUT, `${GROUP}_重命名对照.txt`), cmp, 'utf8');
}

/* 被剔除的重复卡清单（--minimal 不写） */
if (dropped.length && !MINIMAL) {
  const t = `【${GROUP}】已从结果中剔除的卡（卡库已有且数值一致，不需要再做）：${dropped.length} 张\n`
    + dropped.map(d => `  ${d.name}${d.codeName && d.codeName !== d.name ? '（卡库名：' + d.codeName + '）' : ''}\n      原图：${d.file}\n`).join('');
  fs.writeFileSync(path.join(OUT, `${GROUP}_已剔除_卡库已有.txt`), t, 'utf8');
}

/* 机器可读数据（下一步研发直接用来建卡） */
const jsonOut = cards.map(c => ({
  name: c.name, nameFrom: c.nameSrc === '卡面' ? 'card-face' : 'filename',
  nation: c.nation, rarity: c.rarity, type: c.type, cost: c.cost,
  fuel: c.fuel ?? null, fuelFrom: c.fuelSrc || null,
  atk: c.atk ?? null, hp: c.hp ?? null,
  keywords: c.keywords, effect: c.effect || null,
  derived: c.isDerived, derivedFrom: c.derivedBy || null, veteran: !!c.veteran,
  inCode: !!c.known, codeName: c.codeName || null, nearCode: c.nearCode || null, filledFromCode: c.filledFrom,
  srcFile: c.file, newFile: c.newFile,
  flags: [c.suspect ? 'SUSPECT_STALE:' + c.suspect : '', c.nameDiffers ? 'NAME_DIFFERS_FROM_FILENAME' : ''].filter(Boolean),
}));
safeWrite(path.join(OUT, `${GROUP}_卡牌数据.json`), JSON.stringify(jsonOut, null, 1), '数据');

/* 机器可读的重命名映射 + 一键重命名脚本（--minimal 不写；改名早已完成、源文件夹也清了） */
if (!MINIMAL) {
fs.writeFileSync(path.join(OUT, `${GROUP}_重命名映射.tsv`), renameLog.map(r => r.from + '\t' + r.to).join('\r\n') + '\r\n', 'utf8');
const ps1 = [
  'param([Parameter(Mandatory=$true)][string]$Src, [Parameter(Mandatory=$true)][string]$Map)',
  '# Rename card images in place according to <name>_rename-map.tsv (from<TAB>to).',
  '$ErrorActionPreference = "Stop"',
  '$rows = Get-Content -LiteralPath $Map -Encoding UTF8 | Where-Object { $_ -match "\\t" }',
  '$n = 0; $skip = 0',
  'foreach ($r in $rows) {',
  '  $p = $r -split "`t"',
  '  $from = $p[0]; $to = $p[1]',
  '  $f = Join-Path $Src $from',
  '  if (-not (Test-Path -LiteralPath $f)) { $skip++; continue }',
  '  if ($from -eq $to) { continue }',
  '  $t = Join-Path $Src $to',
  '  if (Test-Path -LiteralPath $t) {',
  '    $base = [System.IO.Path]::GetFileNameWithoutExtension($to)',
  '    $ext = [System.IO.Path]::GetExtension($to)',
  '    $i = 2',
  '    while (Test-Path -LiteralPath $t) { $t = Join-Path $Src ($base + "(" + $i + ")" + $ext); $i++ }',
  '  }',
  '  Rename-Item -LiteralPath $f -NewName ([System.IO.Path]::GetFileName($t))',
  '  Write-Output ("renamed: " + $from + "  ->  " + [System.IO.Path]::GetFileName($t))',
  '  $n++',
  '}',
  'Write-Output ("DONE: " + $n + " renamed, " + $skip + " missing, in " + $Src)',
  '',
].join('\r\n');
fs.writeFileSync(path.join(OUT, '就地重命名.ps1'), ps1, 'ascii');
}

console.log(`[${GROUP}] 卡 ${cards.length}（衍生 ${cards.filter(c => c.isDerived).length}，新卡 ${cards.filter(c => !c.known).length}）→ 复制 ${copied} 张；OCR 失败 ${failed.length}；待补 ${pending.length} 项${suspects.length ? '；⚠ 疑似串号 ' + suspects.length + ' 张' : ''}`);
console.log('  ' + path.join(OUT, `${GROUP}_文档.txt`));
console.log('  ' + path.join(OUT, `${GROUP}_卡牌数据.json`));
if (!MINIMAL) {
  console.log('  ' + path.join(OUT, `${GROUP}_重命名对照.txt`));
  console.log('  ' + path.join(OUT, `${GROUP}_重命名映射.tsv`));
}
// 关键提示：有用户手改过的文件被保护住了（绝不覆盖）
if (conflicts.length) {
  console.log('');
  console.log('  ⚠ 以下文件检测到「你手改过的内容」，已原样保留、没有被覆盖：');
  for (const cf of conflicts) console.log(`     · ${cf.file}   （本次新内容写到 ${cf.alt}）`);
  console.log('     要把手改内容并进生成器（以后不再冲突），请把值告诉我，我写进 人工覆盖表_overrides.json。');
  console.log('     确认要覆盖时再跑一次并加 --force。');
}
