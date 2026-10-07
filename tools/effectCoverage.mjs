#!/usr/bin/env node
// effectCoverage.mjs —— 卡牌效果覆盖率检查：
//   ① 每个国家的每张卡的 eff/deploy 是否在 engine 里有对应 case
//   ② 每张卡的 fx 是否在 engine 中出现（任意位置：光环/战斗/回合钩子）
//   ③ 每张指向卡的 target 是否被 orderTargets 支持
// 用法：node tools/effectCoverage.mjs [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const C = require(path.join(ROOT, 'src', 'cards.js'));
const ENG = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8');
const AI = fs.readFileSync(path.join(ROOT, 'src', 'ai.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');

const verbose = process.argv.includes('--verbose');
// engine 中所有 case 'xxx' 键
// 【口径修正 2026-09-13】原来的字符类 [A-Za-z0-9_\u4e00-\u9fa5]+ 会把带标点的卡名截断
// （'我们能做到！'→'我们能做到'、'38(t)坦克'→'38'、'IS-2'→'IS'、'蚊式MkVⅥ'→'蚊式MkV'），
// 于是 15 张明明接了线的卡被误报「缺 handler」。改成取引号内全部内容。
const cases = new Set([...ENG.matchAll(/case\s+'([^']+)'/g)].map(m => m[1]));
// 有些实现不走 switch：亡计/触发写成 if(b1Is(u,'X')) 或 hasFx(u,'X') 的链式判定
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hookHandled = (id) => new RegExp(`(?:b1Is|hasFx)\\([^)]*'${esc(id)}'`).test(ENG);
const handled = (id) => cases.has(id) || hookHandled(id);
// fx 判定：在 engine 中以字符串字面量出现即可（hasFx 判断/效果分支）
const fxSeen = fx => ENG.includes(`'${fx}'`) || ENG.includes(`"${fx}"`);
// 支持的指向类型：直接从 engine 的 orderTargets 源码解析（避免手写白名单失真）
const TARGET_OK = new Set([...ENG.matchAll(/card\.target === '([a-z-]+)'/g)].map(m => m[1]));
// HQ 选项白名单（orderTargets 内 out.push({hq:true}) 的 eff 列表）
const HQ_EFFS = new Set((ENG.match(/card\.eff === '([A-Za-z0-9_]+)'/g) || []).map(s => s.match(/'([A-Za-z0-9_]+)'/)[1]));
const HQ_TARGETS = new Set(['enemy-unit-hq']);
// 衍生/特殊生成卡（不走 NATIONS）
const SPECIAL = new Set([C.BAOPO && C.BAOPO.n, C.PLAN && C.PLAN.n, C.RESIST && C.RESIST.n, '生产'].filter(Boolean));
const DERIVED_IDS = new Set(Object.keys(C.DERIVED_CARDS || {}));

const missingEff = [], missingDeploy = [], missingFx = [], badTarget = [], aiNotHandled = [];
for(const [key, n] of Object.entries(C.NATIONS)){
  for(const o of n.orders){
    if(!handled(o.e)) missingEff.push(key + ':' + o.n + ' (eff=' + o.e + ')');
    if(o.target && !TARGET_OK.has(o.target)) badTarget.push(key + ':' + o.n + ' (target=' + o.target + ')');
    // AI 是否可能打出：指向型指令走通用 aiPickOrderTarget 分支，无需显式登记
    if(!o.target && !AI.includes(`'${o.e}'`)) aiNotHandled.push(key + ':' + o.n + ' (eff=' + o.e + ')');
  }
  for(const u of n.units){
    if(u.d && !handled(u.d)) missingDeploy.push(key + ':' + u.n + ' (deploy=' + u.d + ')');
    if(u.target && !TARGET_OK.has(u.target)) badTarget.push(key + ':' + u.n + ' (target=' + u.target + ')');
    for(const f of (u.e || [])){
      if(DERIVED_IDS.has(f)) continue;
      // 允许两种实现：fx 字符串判定（hasFx）或按卡 id 判定（x.def.id==='xxx'）
      if(fxSeen(f) || ENG.includes(`'${u.id}'`) || (AI.includes(`'${u.id}'`) && UI.includes(f))) continue;
      missingFx.push(key + ':' + u.n + ' (fx=' + f + ')');
    }
  }
  for(const cnt of n.counters){
    // 反制：eff 需在 buildDeck 的 COUNTER_EFFS 或触发点出现
    if(!ENG.includes(`'${cnt.e}'`)) missingEff.push(key + ':' + cnt.n + ' (counter eff=' + cnt.e + ')');
  }
}
const report = (title, arr) => {
  console.log((arr.length ? '✗ ' : '✓ ') + title + '：' + (arr.length ? arr.length + ' 项' : '全部通过'));
  if(arr.length && (verbose || true)) arr.forEach(x => console.log('    - ' + x));
};
console.log('=== 卡牌效果覆盖率（%d 国 / %d 单位 / %d 指令 / %d 反制）===',
  Object.keys(C.NATIONS).length,
  Object.values(C.NATIONS).reduce((s,n)=>s+n.units.length,0),
  Object.values(C.NATIONS).reduce((s,n)=>s+n.orders.length,0),
  Object.values(C.NATIONS).reduce((s,n)=>s+n.counters.length,0));
report('指令 eff 缺 handler', missingEff);
report('部署 deploy 缺 handler', missingDeploy);
report('单位 fx 未在引擎出现', missingFx);
report('指向 target 不受支持', badTarget);
report('AI 完全不知道的指令', aiNotHandled);
const fails = missingEff.length + missingDeploy.length + missingFx.length + badTarget.length;
process.exit(fails ? 1 : 0);
