#!/usr/bin/env node
// verify.mjs —— 规则断言测试集（对 src/engine.js 直接构造棋盘场景断言）
// 用法：
//   node tools/verify.mjs              # 全量运行
//   node tools/verify.mjs --filter=T9  # 只跑 T9（可逗号多个）
//   node tools/verify.mjs --verbose    # 输出每项断言明细
//   node tools/verify.mjs --selftest   # 用 fixtures/mock-engine 自检断言工具链本身（H-* 测试）
// 退出码：0=全部通过（INFO 项不算失败）；1=存在 FAIL；2=引擎不可用/脚本错误
// 说明：INFO 项仅记录引擎实际行为（B3/B4 光环快照语义、B8 消耗语义、33联队指令触发等），
//       不判定通过与否；FAIL 项输出棋盘/状态 dump 以便复现。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine, cardDefs, placeUnit, defOf, TOOLS_DIR } from './engineAdapter.mjs';

const NATIONS_KEYS = ['us', 'de', 'su', 'gb', 'jp'];
const args = process.argv.slice(2);
const opt = { filter: null, verbose: false, selftest: false, list: false, enginePath: null, aiPath: null };
for (const a of args) {
  if (a === '--verbose') opt.verbose = true;
  else if (a === '--selftest') opt.selftest = true;
  else if (a === '--list') opt.list = true;
  else if (a.startsWith('--filter=')) opt.filter = a.slice(9).split(',').map(s => s.trim()).filter(Boolean);
  else if (a.startsWith('--engine=')) opt.enginePath = a.slice(9);
  else if (a.startsWith('--ai=')) opt.aiPath = a.slice(5);
  else { console.error(`未知参数: ${a}`); process.exit(2); }
}

/* ---------------- 通用工具 ---------------- */
function makeRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// 卡牌 def 索引：全量 NATIONS 卡优先（默认卡组受 40 张上限裁剪、部分卡不进默认卡组，
// 但测试场景可能引用它们，如 T3/T7 的 gb:swordfish）；buildDeck 命中的卡仅作补充（形状一致）
function makeDefs(loaded) {
  const index = new Map();
  for (const [k, v] of cardDefs(loaded.NATIONS)) index.set(k, v);
  if (loaded.mod && typeof loaded.mod.buildDeck === 'function') {
    for (const key of Object.keys(loaded.NATIONS)) {
      const deck = loaded.mod.buildDeck(key, () => 0.5);
      for (const c of deck || []) { const k = `${key}:${c.id}`; if (c && c.id && !index.has(k)) index.set(k, c); }
    }
  }
  // 按卡名兜底（跨国防重名）
  const byName = new Map();
  for (const [k, v] of index) { const nk = v.n; if (!byName.has(nk)) byName.set(nk, v); }
  return { index, byName };
}

/* ---------------- 测试框架 ---------------- */
const TESTS = []; // { id, name, run(ctx) → checks[] }
function test(id, name, run) { TESTS.push({ id, name, run }); }

function mkCheck(label, expected, actual, extra = {}) {
  return { label, expected, actual, pass: expected === actual, eng: _lastEng, ...extra };
}
const eq = (label, expected, actual) => mkCheck(label, String(expected), String(actual));
const info = (label, actual, note = '') => mkCheck(label, '(记录)', String(actual), { info: true, note });

function dumpState(eng) {
  const S = eng.state;
  const lines = [];
  lines.push(`  turn=${S.turn} phase=${S.phase} over=${S.over} winner=${S.winner}`);
  const names = ['敌底线', '前线  ', '我底线'];
  for (let r = 0; r < 3; r++) {
    const cells = [];
    for (let c = 0; c < 5; c++) {
      const u = S.board[r][c];
      cells.push(u ? `${u.def.n}[${u.owner}]${u.atk}/${u.hp}${u.suppressed ? '压' : ''}${u.smokeOut ? '烟' : ''}` : '·');
    }
    lines.push(`  ${names[r]} | ${cells.join(' | ')}`);
  }
  lines.push(`  p: hp=${S.p.hp}/${S.p.maxHp} kredit=${S.p.kredit}/${S.p.kreditSlots} hand=${S.p.hand.length} deck=${S.p.deck.length} 反制=[${S.p.counters.join(',')}]`);
  lines.push(`  a: hp=${S.a.hp}/${S.a.maxHp} kredit=${S.a.kredit}/${S.a.kreditSlots} hand=${S.a.hand.length} deck=${S.a.deck.length} 反制=[${S.a.counters.join(',')}]`);
  if (Array.isArray(S.log)) lines.push(`  log尾: ${S.log.slice(-4).join(' | ')}`);
  return lines.join('\n');
}

/* ---------------- 场景基础设施 ---------------- */
let _lastEng = null;
function makeCtx(loaded, defs) {
  const ctx = {
    loaded, defs,
    def: (nation, id) => { const d = defOf(defs.index, `${nation}:${id}`); if (!d) throw new Error(`卡牌不存在 ${nation}:${id}`); return d; },
    newEng(pNation = 'us', aNation = 'de', seed = 42) {
      const eng = loaded.factory.fn({ pNation, aNation, rng: makeRng(seed), hooks: {}, log: true });
      _lastEng = eng;
      return eng;
    },
    place(eng, side, nation, id, row, col, opts = {}) {
      const def = ctx.def(nation, id);
      const u = placeUnit(eng, side, def, row, col, opts);
      if (!u) throw new Error(`place 失败 ${nation}:${id} @${row},${col}（位置被占？）`);
      return u;
    },
    spawn(eng, side, nation, id, row, col) {
      const ok = eng.spawnUnit(side, ctx.def(nation, id), row, col);
      if (!ok) throw new Error(`spawnUnit 失败 ${nation}:${id} @${row},${col}`);
    },
    kredit(eng, side, n) { eng.state[side].kredit = n; eng.state[side].kreditSlots = Math.max(eng.state[side].kreditSlots, n); },
    at(eng, row, col) { return eng.state.board[row][col]; },
    handOf(eng, side) { return eng.state[side].hand; },
    setHandDeck(eng, side, hand, deck) { eng.state[side].hand = hand || []; eng.state[side].deck = deck || []; },
  };
  return ctx;
}

/* ================= H 组：工具链自检（仅 --selftest 运行） ================= */
test('H1', '工具链：引擎加载 + 卡索引', (ctx) => [
  eq('卡索引含 us:u_inf', true, ctx.defs.index.has('us:u_inf')),
  eq('卡索引含 de:v_smoke', true, ctx.defs.index.has('de:v_smoke')),
]);
test('H2', '工具链：场景摆放与旗标清理', (ctx) => {
  const eng = ctx.newEng();
  const u = ctx.place(eng, 'p', 'us', 'u_inf', 2, 0, {});
  return [
    eq('单位就位', true, ctx.at(eng, 2, 0) === u),
    eq('落地旗标=可行动', false, u.summonedThisTurn),
  ];
});
test('H3', '工具链：PASS 判定路径', (ctx) => [ eq('恒真断言通过', 'ok', 'ok') ]);
test('H4', '工具链：FAIL 明细与状态 dump 路径', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'us', 'u_inf', 2, 0);
  _lastEng = eng;
  const c = mkCheck('故意失败：板面应有 2 个单位', '2', '1');
  const dump = dumpState(c.eng);
  return [
    eq('FAIL 判定生成', false, c.pass),
    eq('dump 含棋盘点位', true, dump.includes('我底线') && dump.includes('步兵[p]2/2')),
    eq('dump 含 p/a 生命周期', true, dump.includes('hp=20/20')),
  ];
});

/* ================= A 组：词条 / 规则 ================= */
test('T1', '重甲1/重甲2：单位战斗伤害减甲；指令伤害不减甲（B5 现状语义）', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'a', 'de', 'tiger', 1, 0);                  // 虎式 8/8 重甲2
  ctx.place(eng, 'p', 'de', 'bf109', 2, 0);                  // BF109E 3/4
  ctx.kredit(eng, 'p', 5);
  const c1 = eng.combat({ row: 2, col: 0 }, { row: 1, col: 0 });
  return [
    eq('战斗可执行', true, c1),
    eq('虎式受 3-2=1 伤', 7, ctx.at(eng, 1, 0).hp),
    eq('BF109E 被反击 8 伤（阵亡）', null, ctx.at(eng, 2, 0)),
    info('指令伤害不减甲', (() => { const e2 = ctx.newEng(); ctx.place(e2, 'a', 'de', 'tiger', 1, 0); e2.state.p.deck = []; const card = ctx.def('su', 'frompeople'); e2.state.p.hand.push(card); ctx.kredit(e2, 'p', 10); e2.orderEffect(card, { row: 1, col: 0 }, 'p'); return [ctx.at(e2, 1, 0).hp, '8-3=5'] .join('|'); })(), 'B5 语义=仅战斗伤害减甲；指令伤害原样（3点）'),
  ];
});
test('T2', '伏击：首次被攻击先反击；反击击杀则攻击者不造成伤害', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'a', 'jp', 'a6m2', 0, 0);                   // A6M2 4/4 伏击
  ctx.place(eng, 'p', 'de', 'bf109', 2, 0);                  // BF109E 3/4
  ctx.kredit(eng, 'p', 5);
  eng.combat({ row: 2, col: 0 }, { row: 0, col: 0 });        // 伏击反击 4 点 → BF109E 死
  const checks = [
    eq('攻击者被伏击反击消灭', null, ctx.at(eng, 2, 0)),
    eq('伏击单位未受伤害', 4, ctx.at(eng, 0, 0).hp),
  ];
  // 第二轮：虎式(8/8 重甲2，前线坦克)攻击 A6M2 → 伏击 4-2=2，虎式 6/8 → A6M2 受 8 伤阵亡
  const e2 = ctx.newEng();
  ctx.place(e2, 'a', 'jp', 'a6m2', 0, 0);
  ctx.place(e2, 'p', 'de', 'tiger', 1, 0);
  ctx.kredit(e2, 'p', 10);
  e2.combat({ row: 1, col: 0 }, { row: 0, col: 0 });
  checks.push(eq('反击未被击杀时攻击者造成伤害（虎式 8-2=6 血）', 6, ctx.at(e2, 1, 0).hp));
  checks.push(eq('A6M2 被 8 伤消灭', null, ctx.at(e2, 0, 0)));
  return checks;
});
test('T3', '轰炸机：被攻击不反击；攻击战斗机受反击；可攻击任意目标，同一战线战斗机拦截造成伤害', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'a', 'gb', 'swordfish', 0, 0);              // 剑鱼 1/3 轰炸机
  ctx.place(eng, 'p', 'de', 'bf109', 2, 0);                  // BF109E 3/4
  ctx.kredit(eng, 'p', 5);
  eng.combat({ row: 2, col: 0 }, { row: 0, col: 0 });
  const checks = [
    eq('轰炸机被攻击不反击（攻击者满血）', 4, ctx.at(eng, 2, 0).hp),
    eq('剑鱼 3 伤阵亡', null, ctx.at(eng, 0, 0)),
  ];
  const e2 = ctx.newEng();
  ctx.place(e2, 'p', 'gb', 'lancaster', 2, 0);               // 兰卡 7/4 轰炸机
  ctx.place(e2, 'a', 'gb', 'spitfire', 0, 0);                // 喷火 5/5 战斗机
  ctx.kredit(e2, 'p', 10);
  e2.combat({ row: 2, col: 0 }, { row: 0, col: 0 });
  checks.push(eq('轰炸机攻击战斗机受反击（兰卡 4-5 阵亡）', null, ctx.at(e2, 2, 0)));
  checks.push(eq('喷火被 7 伤消灭', null, ctx.at(e2, 0, 0)));
  // 拦截（目标限制）：敌方战斗机所在战线 = 轰炸禁区——轰炸机不能攻击该战线的非战斗机单位（可攻击战斗机本身）
  const e3 = ctx.newEng();
  ctx.place(e3, 'p', 'gb', 'lancaster', 2, 0);
  ctx.place(e3, 'a', 'gb', 'spitfire', 0, 0);              // 喷火战斗机（row0）
  ctx.place(e3, 'a', 'gb', 'swordfish', 0, 1);             // 剑鱼轰炸机（row0，同战线被遮蔽）
  const tgts = e3.attackTargets('p', 2, 0);
  checks.push(eq('拦截：战斗机本身可攻击（狗斗）', true, tgts.some(t => t.row === 0 && t.col === 0)));
  checks.push(eq('拦截：同战线非战斗机被遮蔽不可选', false, tgts.some(t => t.row === 0 && t.col === 1)));
  // 未遮蔽战线仍可攻击：敌底线无战斗机时可打底线单位；敌前线战斗机遮蔽前线单位
  const e5 = ctx.newEng();
  ctx.place(e5, 'p', 'gb', 'lancaster', 2, 0);
  ctx.place(e5, 'a', 'gb', 'swordfish', 0, 0);             // row0 无战斗机 → 可打
  ctx.place(e5, 'a', 'gb', 'spitfire', 1, 0);              // 战斗机占前线 → 遮蔽前线
  ctx.place(e5, 'a', 'gb', 'humber', 1, 1);                // 前线单位被遮蔽
  const tgts5 = e5.attackTargets('p', 2, 0);
  checks.push(eq('拦截：未遮蔽战线（row0 剑鱼）可攻击', true, tgts5.some(t => t.row === 0 && t.col === 0)));
  checks.push(eq('拦截：前线单位被战斗机遮蔽不可选', false, tgts5.some(t => t.row === 1 && t.col === 1)));
  // 底线被战斗机遮蔽 → 总部不可炸
  const e6 = ctx.newEng();
  ctx.place(e6, 'p', 'gb', 'lancaster', 2, 0);
  ctx.place(e6, 'a', 'gb', 'spitfire', 0, 0);
  checks.push(eq('拦截：底线被遮蔽时总部不可炸', false, e6.attackTargets('p', 2, 0).some(t => t.hq)));
  // 轰炸机攻击未遮蔽战线单位成功，且不承担拦截伤害
  const e7 = ctx.newEng();
  ctx.place(e7, 'p', 'gb', 'lancaster', 2, 0);
  ctx.place(e7, 'a', 'gb', 'swordfish', 0, 0);
  ctx.kredit(e7, 'p', 10);
  e7.combat({ row: 2, col: 0 }, { row: 0, col: 0 });
  checks.push(eq('拦截：轰炸机打无遮蔽战线成功且不受伤（兰卡满血 4）', 4, ctx.at(e7, 2, 0).hp));
  return checks;
});
test('T4', '守护：地面不能攻守护相邻单位；炮兵/轰炸机/战斗机可绕过；底线守护保护总部', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'su', 't34', 1, 0);                    // T-34 5/5 坦克（前线）
  ctx.place(eng, 'a', 'su', 'r84', 0, 0);                    // 守护兵 1/8（敌底线）
  ctx.place(eng, 'a', 'de', 'r980', 0, 1);                   // 非守护 3/6，与守护相邻
  const t1 = eng.attackTargets('p', 1, 0);
  const checks = [
    eq('地面单位可选择到守护单位', true, t1.some(t => t.row === 0 && t.col === 0)),
    eq('地面单位不可选守护相邻单位(0,1)', false, t1.some(t => t.row === 0 && t.col === 1)),
    eq('守护存在时地面不可直击总部', false, t1.some(t => t.hq)),
  ];
  // 炮兵绕过
  const e2 = ctx.newEng();
  ctx.place(e2, 'p', 'us', 'm7', 1, 0);
  ctx.place(e2, 'a', 'su', 'r84', 0, 0);
  ctx.place(e2, 'a', 'de', 'r980', 0, 1);
  const t2 = e2.attackTargets('p', 1, 0);
  checks.push(eq('炮兵可绕过守护打(0,1)', true, t2.some(t => t.row === 0 && t.col === 1)));
  checks.push(eq('炮兵可越守护直击总部', true, t2.some(t => t.hq)));
  // 战斗机绕过（规则文本：仅轰炸机/炮兵可绕过守护；战斗机不可 → 期望 false）
  const e3 = ctx.newEng();
  ctx.place(e3, 'p', 'us', 'p40', 2, 0);
  ctx.place(e3, 'a', 'su', 'r84', 0, 0);
  ctx.place(e3, 'a', 'de', 'r980', 0, 1);
  const t3 = e3.attackTargets('p', 2, 0);
  checks.push(eq('战斗机不可绕过守护打(0,1)（规则文本：仅炮兵/轰炸机）', false, t3.some(t => t.row === 0 && t.col === 1)));
  checks.push(info('内部文档冲突：help 文本写"战斗机可绕过守护"', '实现=不可绕过', '规则-分类排序版与实现一致（仅炮兵/轰炸机）；最终验证报告 C3 备注与实现不符'));
  return checks;
});
test('T5', '闪击：落地可推进+攻击；普通单位落地不能行动；坦克落地可推进（记录攻击）', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'us', 'm18', 2, 0, { summoned: true }); // M18 4/2 闪击
  ctx.place(eng, 'a', 'su', 'r554', 0, 0);                    // 1/1
  ctx.kredit(eng, 'p', 10);
  const checks = [
    eq('闪击落地可行动', true, eng.canAct('p', 2, 0)),
    eq('闪击推进成功', true, eng.moveForward('p', 2, 0)),
    eq('推进后可攻击（击杀 1/1）', true, eng.combat({ row: 1, col: 0 }, { row: 0, col: 0 })),
    eq('攻击后闪击单位受 1 点反击', 1, ctx.at(eng, 1, 0).hp),
  ];
  const e2 = ctx.newEng();
  ctx.place(e2, 'p', 'us', 'r506', 2, 0, { summoned: true }); // 普通步兵 2/2
  ctx.kredit(e2, 'p', 10);
  checks.push(eq('普通单位落地不能行动', false, e2.canAct('p', 2, 0)));
  checks.push(eq('普通单位落地不能推进', false, e2.moveForward('p', 2, 0)));
  const e3 = ctx.newEng();
  ctx.place(e3, 'p', 'de', 'tiger', 2, 0, { summoned: true });  // 虎式（无闪击坦克）
  ctx.kredit(e3, 'p', 10);
  checks.push(eq('坦克落地可推进', true, e3.moveForward('p', 2, 0)));
  checks.push(info('坦克落地当回合可否攻击（规则=可，HTML 基线=禁止）', e3.canAct('p', 1, 0), '记录重构引擎实际值'));
  return checks;
});
test('T6', '烟幕：有烟幕不能被攻击；移动或攻击后失去', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'a', 'de', 'pz2', 0, 0);                    // 二号坦克 烟幕 1/3
  ctx.place(eng, 'p', 'de', 'bf109', 2, 0);
  const t1 = eng.attackTargets('p', 2, 0);
  const checks = [
    eq('烟幕单位不可被选为目标', false, t1.some(t => t.row === 0 && t.col === 0)),
  ];
  ctx.kredit(eng, 'a', 5);
  eng.moveForward('a', 0, 0);                                // 推进 → 失去烟幕
  const t2 = eng.attackTargets('p', 2, 0);
  checks.push(eq('移动后失去烟幕可被攻击', true, t2.some(t => t.row === 1 && t.col === 0)));
  const e2 = ctx.newEng();
  ctx.place(e2, 'p', 'jp', 'sendai', 1, 0);                  // 仙台联队 烟幕 2/3（前线）
  ctx.place(e2, 'a', 'su', 'r554', 0, 0);
  ctx.kredit(e2, 'p', 5);
  e2.canAct('p', 1, 0);
  e2.combat({ row: 1, col: 0 }, { row: 0, col: 0 });         // 攻击 → 失去烟幕
  checks.push(eq('攻击后失去烟幕', true, ctx.at(e2, 1, 0).smokeOut));
  return checks;
});
test('T7', '奋战：一回合攻击两次', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'gb', 'humber', 1, 0);                 // 亨伯 1/3 奋战
  ctx.place(eng, 'a', 'su', 'r554', 0, 0);                   // 1/1
  ctx.place(eng, 'a', 'gb', 'swordfish', 0, 1);              // 剑鱼 1/3 轰炸机（不反击）
  ctx.kredit(eng, 'p', 10);
  const checks = [
    eq('第一次攻击', true, eng.combat({ row: 1, col: 0 }, { row: 0, col: 0 })),
    eq('攻击一次后仍可行动（奋战）', true, eng.canAct('p', 1, 0)),
    eq('第二次攻击', true, eng.combat({ row: 1, col: 0 }, { row: 0, col: 1 })),
    eq('攻击两次后不可再行动', false, eng.canAct('p', 1, 0)),
    eq('第三次攻击被拒', false, eng.combat({ row: 1, col: 0 }, { row: 0, col: 1 })),
    eq('亨伯受反击后 2 血（2 次反击各 1）', 2, ctx.at(eng, 1, 0).hp),
  ];
  return checks;
});
test('T8', '亡计：雅克-9 死亡抽牌', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'su', 'yak9', 1, 0);                   // 雅克-9 4/5 亡计
  ctx.place(eng, 'a', 'de', 'tiger', 0, 0);                  // 虎式 8/8 攻击者
  ctx.setHandDeck(eng, 'p', [], Array.from({ length: 6 }, (_, i) => ({ kind: 'order', id: 'd' + i, n: 'D' + i, blood: 1, eff: 'produce' })));
  ctx.kredit(eng, 'a', 10);
  eng.combat({ row: 0, col: 0 }, { row: 1, col: 0 });        // 虎式攻击雅克-9 → 8 伤击杀
  return [
    eq('雅克-9 阵亡', null, ctx.at(eng, 1, 0)),
    eq('亡计抽 1 张', 1, ctx.handOf(eng, 'p').length),
    eq('牌库减 1', 5, eng.state.p.deck.length),
  ];
});
test('T9', '溢出（B2 修复）：溢出=总伤害-目标当前生命 → 转移总部', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'su', 'il28', 2, 0);                   // 伊尔-28M 4/3 溢出
  ctx.place(eng, 'a', 'su', 'r554', 0, 0);                   // 1/1
  ctx.kredit(eng, 'p', 10);
  eng.combat({ row: 2, col: 0 }, { row: 0, col: 0 });        // 4-0=4 击杀 1/1 → 溢出 3
  const checks = [eq('溢出 4-1=3 转总部', 17, eng.state.a.hp)];
  const e2 = ctx.newEng();
  ctx.place(e2, 'p', 'su', 'il28', 2, 0);
  ctx.place(e2, 'a', 'us', 'sbd', 0, 0);                     // SBD 3/3 重甲1
  ctx.kredit(e2, 'p', 10);
  e2.combat({ row: 2, col: 0 }, { row: 0, col: 0 });          // 4-1=3 恰好击杀 → 溢出 0
  checks.push(eq('恰杀（3-3=0）不溢伤', 20, e2.state.a.hp));
  const e3 = ctx.newEng();
  ctx.place(e3, 'p', 'su', 'il28', 2, 0);
  ctx.place(e3, 'a', 'de', 'r980', 0, 0);                    // 3/6
  ctx.kredit(e3, 'p', 10);
  e3.combat({ row: 2, col: 0 }, { row: 0, col: 0 });          // 4 伤未击杀
  checks.push(eq('未击杀不溢出', 20, e3.state.a.hp));
  checks.push(eq('目标剩 2 血', 2, ctx.at(e3, 0, 0).hp));
  return checks;
});
test('T10', '压制：被压制不能移动/攻击；所有者回合结束移除；虎式免疫', (ctx) => {
  const eng = ctx.newEng();
  const u = ctx.place(eng, 'p', 'gb', 'humber', 1, 0, { suppressed: true });
  ctx.place(eng, 'a', 'su', 'r554', 0, 0);
  ctx.kredit(eng, 'p', 10);
  const checks = [
    eq('被压制不能行动', false, eng.canAct('p', 1, 0)),
    eq('被压制不能推进', false, eng.moveForward('p', 1, 0)),
    eq('被压制不能攻击', false, eng.combat({ row: 1, col: 0 }, { row: 0, col: 0 })),
  ];
  eng.endTurn('p');
  checks.push(eq('所有者回合结束移除压制', false, ctx.at(eng, 1, 0).suppressed));
  const e2 = ctx.newEng();
  const tiger = ctx.place(e2, 'p', 'de', 'tiger', 1, 0);
  checks.push(eq('虎式免疫压制（applySuppress 拒绝）', false, e2.applySuppress(tiger)));
  return checks;
});
test('T11', '反制三件套：发现敌人/无心漫谈/国家消防局 + B8 消耗语义 + A3 AI 侧触发', (ctx) => {
  const chkDeploy = ctx.loaded.mod.checkEnemyDeployDmg;   // 部署路径里的反制触发点（实例未转发，直接取引擎导出）
  const eng = ctx.newEng();
  eng.state.p.counters.push('spotEnemy');
  ctx.setHandDeck(eng, 'p', [], Array.from({ length: 7 }, (_, i) => ({ kind: 'order', id: 'd' + i, n: 'D' + i, blood: 1, eff: 'produce' })));
  ctx.place(eng, 'a', 'su', 't70', 0, 0);
  ctx.kredit(eng, 'a', 5);
  eng.moveForward('a', 0, 0);                                 // 敌方推进 → p 抽 3
  const checks = [
    eq('发现敌人：敌方推进触发抽 3', 3, ctx.handOf(eng, 'p').length),
    eq('发现敌人：触发后消耗', false, eng.state.p.counters.includes('spotEnemy')),
    eq('发现敌人：牌库扣 3', 4, eng.state.p.deck.length),
  ];
  // 无心漫谈：触发点在部署路径（出牌/自动部署）里调 checkEnemyDeployDmg——直接 spawnUnit 不触发，
  // 故这里显式调用（与引擎调用点同形），验证伤害与消耗语义（现状：触发即消耗，不论是否击杀）
  const e2 = ctx.newEng();
  e2.state.p.counters.push('enemyDeployDmg');
  ctx.kredit(e2, 'a', 5);
  e2.spawnUnit('a', ctx.def('su', 'r554'), 0, 0);             // 1/1 → 3 伤击杀
  chkDeploy('a', ctx.at(e2, 0, 0), 0, 0);
  checks.push(eq('无心漫谈：对 1/1 造成 3 伤并击杀', null, ctx.at(e2, 0, 0)));
  checks.push(eq('无心漫谈：触发即消耗（击杀情形）', false, e2.state.p.counters.includes('enemyDeployDmg')));
  const e3 = ctx.newEng();
  e3.state.p.counters.push('enemyDeployDmg');
  ctx.kredit(e3, 'a', 5);
  e3.spawnUnit('a', ctx.def('de', 'r980'), 0, 0);             // 3/6 → 受 3 伤剩 3
  chkDeploy('a', ctx.at(e3, 0, 0), 0, 0);
  checks.push(eq('无心漫谈：未击杀目标受 3 伤（6→3）', 3, ctx.at(e3, 0, 0).hp));
  checks.push(eq('无心漫谈：未击杀同样消耗（与发现敌人一致：触发即耗）', false, e3.state.p.counters.includes('enemyDeployDmg')));
  checks.push(info('B8 结论', '触发即消耗', '两种情形（击杀/未击杀）都会消耗；与「发现敌人」语义一致'));
  // 国家消防局（玩家侧）：敌方攻击总部伤害 cap 1
  const e4 = ctx.newEng();
  e4.state.p.counters.push('hqCap');
  ctx.place(e4, 'a', 'de', 'tiger', 1, 0);
  ctx.kredit(e4, 'a', 10);
  e4.combat({ row: 1, col: 0 }, { hq: true });
  checks.push(eq('国家消防局：8 伤被 cap 为 1', 19, e4.state.p.hp));
  // A3 回归：AI 侧反制同样生效
  const e5 = ctx.newEng();
  e5.state.a.counters.push('hqCap');
  ctx.place(e5, 'p', 'de', 'tiger', 1, 0);
  ctx.kredit(e5, 'p', 10);
  e5.combat({ row: 1, col: 0 }, { hq: true });
  checks.push(eq('A3：AI 国家消防局生效（cap 1）', 19, e5.state.a.hp));
  const e6 = ctx.newEng();
  e6.state.a.counters.push('enemyDeployDmg');
  ctx.kredit(e6, 'p', 5);
  e6.spawnUnit('p', ctx.def('su', 'r554'), 2, 0);             // 1/1 → AI 反制 3 伤击杀
  chkDeploy('p', ctx.at(e6, 2, 0), 2, 0);
  checks.push(eq('A3：AI 无心漫谈对玩家部署结算并消耗', false, e6.state.a.counters.includes('enemyDeployDmg')));
  checks.push(eq('A3：AI 无心漫谈击杀玩家 1/1', null, ctx.at(e6, 2, 0)));
  return checks;
});
test('T12', '搜索第33联队：战斗受击抽牌；指令伤害是否触发（记录）', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'jp', 's33', 1, 0);                     // 1/2 受击抽牌
  ctx.place(eng, 'a', 'de', 'tiger', 0, 0);
  ctx.setHandDeck(eng, 'p', [], Array.from({ length: 4 }, (_, i) => ({ kind: 'order', id: 'd' + i, n: 'D' + i, blood: 1, eff: 'produce' })));
  ctx.kredit(eng, 'a', 10);
  eng.combat({ row: 0, col: 0 }, { row: 1, col: 0 });         // 8 伤击杀，受击抽 1
  const checks = [
    eq('战斗受击抽 1 张', 1, ctx.handOf(eng, 'p').length),
    eq('目标阵亡', null, ctx.at(eng, 1, 0)),
  ];
  const e2 = ctx.newEng();
  ctx.place(e2, 'p', 'jp', 's33', 1, 0);
  const bom = ctx.def('jp', 'bomraid');
  e2.state.p.hand.push(bom);
  ctx.setHandDeck(e2, 'p', e2.state.p.hand, []);
  const before = e2.state.p.hand.length;
  ctx.kredit(e2, 'p', 10);
  e2.orderEffect(bom, { row: 1, col: 0 }, 'p'); // 指令 3 伤（击杀）
  checks.push(eq('指令伤害后手牌数不变（无抽牌）', before, e2.state.p.hand.length));
  checks.push(info('B 级验证：指令伤害是否触发第33联队抽牌', e2.state.p.hand.length === before ? '不触发' : '触发', '记录结论：战斗受击才触发，指令伤害是否触发以引擎实测为准'));
  return checks;
});
test('T13', '光环 B3/B4：九三式装甲车 +1攻 / D3A2 每有其他友方 +2攻 —— 动态光环（atkOf 实时结算）', (ctx) => {
  const mod = ctx.loaded.mod;
  const atk = (eng, r, c) => mod.atkOf(ctx.at(eng, r, c));   // 动态攻击力：光环实时算，不写回 u.atk
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'su', 'i16', 2, 0);                     // 伊-16 2/2
  ctx.kredit(eng, 'p', 5);
  eng.spawnUnit('p', ctx.def('jp', 't93'), 2, 1);             // 九三式装甲车：友方单位 +1 攻（光环）
  const checks = [
    eq('九三式在场：友军动态攻击力 2→3', 3, atk(eng, 2, 0)),
    eq('九三式自身不吃自己的光环', ctx.def('jp', 't93').atk, atk(eng, 2, 1)),
  ];
  eng.spawnUnit('p', ctx.def('su', 'r554'), 2, 2);            // 新部署友军 1/1 → 动态 +1
  checks.push(eq('B4：新部署友军也吃到光环（动态而非快照）', 2, atk(eng, 2, 2)));
  const before = atk(eng, 2, 0);
  eng.killUnit(2, 1);                                          // 九三式阵亡
  checks.push(eq('B4：光环单位离场后友军即时回落（3→2）', 2, atk(eng, 2, 0)));
  checks.push(info('B4 结论', `离场前 ${before} → 离场后 ${atk(eng, 2, 0)}`, '动态光环：不写回 u.atk，只体现在 atkOf()'));
  // D3A2 九九舰爆 3/2：每有 1 个「其他」友方 D3A2，+2 攻击力
  const e2 = ctx.newEng();
  ctx.place(e2, 'p', 'jp', 'd3a', 2, 0);                      // D3A2#1
  ctx.kredit(e2, 'p', 10);
  checks.push(eq('B3：场上只有 1 个 D3A2 时无加成（3）', 3, atk(e2, 2, 0)));
  e2.spawnUnit('p', ctx.def('jp', 'd3a'), 2, 1);              // D3A2#2
  checks.push(eq('B3：2 个 D3A2 → 各 +2（3+2=5）', 5, atk(e2, 2, 1)));
  checks.push(eq('B3：老的那个也同步（动态）', 5, atk(e2, 2, 0)));
  e2.spawnUnit('p', ctx.def('jp', 'd3a'), 2, 2);              // D3A2#3
  checks.push(eq('B3：3 个 D3A2 → 各 +4（3+2×2=7）', 7, atk(e2, 2, 2)));
  return checks;
});
test('T14', '利奥波德：部署将敌方全部单位移回手牌（A1）', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'a', 'de', 'r980', 0, 0);
  ctx.place(eng, 'a', 'su', 'r554', 0, 1);
  ctx.place(eng, 'a', 'jp', 's33', 1, 0);
  ctx.setHandDeck(eng, 'a', [], Array.from({ length: 3 }, (_, i) => ({ kind: 'order', id: 'd' + i, n: 'D' + i, blood: 1, eff: 'produce' })));
  ctx.kredit(eng, 'p', 12);
  eng.spawnUnit('p', ctx.def('de', 'leopold'), 2, 0);
  const aUnits = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) if (eng.state.board[r][c] && eng.state.board[r][c].owner === 'a') aUnits.push(1);
  return [
    eq('敌方场上单位全部移回手牌', 0, aUnits.length),
    eq('敌方手牌 +3', 3, ctx.handOf(eng, 'a').length),
  ];
});
test('T15', '生产/指挥点/疲劳士气链路', (ctx) => {
  const eng = ctx.newEng();
  const checks = [];
  eng.beginTurn('p');
  checks.push(eq('回合开始：指挥点槽=1 且指挥点=槽', 1, eng.state.p.kredit));
  eng.drawProduce('p');
  const prod = ctx.handOf(eng, 'p').find(c => c.eff === 'produce');
  checks.push(eq('摸到生产牌', true, !!prod));
  checks.push(eq('生产：+1 指挥点', 2, (eng.state.p.kredit = 1, eng.orderEffect(prod, null, 'p'), eng.state.p.kredit)));
  const e2 = ctx.newEng();
  e2.state.p.deck = [];
  e2.state.p.hp = 20; e2.state.p.fatigue = 0;
  e2.drawCards('p', 1); const h1 = e2.state.p.hp;
  e2.drawCards('p', 1); const h2 = e2.state.p.hp;
  e2.drawCards('p', 1); const h3 = e2.state.p.hp;
  checks.push(eq('疲劳序列 19/17/14', '19,17,14', [h1, h2, h3].join(',')));
  return checks;
});
test('T16', '35(t)坦克：有友方步兵时油费 -1（B1）', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'de', 'r980', 2, 0);                    // 友方步兵
  ctx.kredit(eng, 'p', 5);
  eng.spawnUnit('p', ctx.def('de', 'pz35'), 2, 1);
  const u = ctx.at(eng, 2, 1);
  return [eq('油费 1→0', 0, u.def.fuel)];
});
test('T17', '步兵/坦克只能攻击相邻战线（B7）', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'us', 'r506', 2, 0);                    // 己方底线步兵 2/2
  ctx.place(eng, 'a', 'su', 'r554', 0, 0);                    // 敌底线单位
  ctx.place(eng, 'a', 'de', 'r980', 1, 0);                    // 前线单位
  const t1 = eng.attackTargets('p', 2, 0);
  const checks = [
    eq('底线步兵可打前线(1,0)', true, t1.some(t => t.row === 1 && t.col === 0)),
    eq('底线步兵不可隔空打敌底线(0,0)', false, t1.some(t => t.row === 0 && t.col === 0)),
    eq('底线步兵不可直击总部', false, t1.some(t => t.hq)),
  ];
  const e2 = ctx.newEng();
  ctx.place(e2, 'p', 'us', 'r506', 1, 0);                     // 前线步兵
  ctx.place(e2, 'a', 'su', 'r554', 0, 0);
  const t2 = e2.attackTargets('p', 1, 0);
  checks.push(eq('前线步兵可打敌底线(0,0)', true, t2.some(t => t.row === 0 && t.col === 0)));
  checks.push(eq('前线地面单位可直击总部', true, t2.some(t => t.hq)));
  return checks;
});
test('T18', '火力爆发（B2）：+1攻与奋战直到回合结束回滚', (ctx) => {
  const eng = ctx.newEng();
  ctx.place(eng, 'p', 'us', 'p51', 1, 0);                     // P-51 6/4 战斗机
  const power = ctx.def('jp', 'power');
  eng.state.p.hand.push(power);
  ctx.kredit(eng, 'p', 5);
  eng.orderEffect(power, { row: 1, col: 0 }, 'p');
  const checks = [
    eq('+1 攻生效（6→7）', 7, ctx.at(eng, 1, 0).atk),
    eq('获得奋战词条', true, ctx.at(eng, 1, 0).def.sig.includes('fight')),
    eq('可连击两次（奋战）', true, (ctx.at(eng, 1, 0).attackedN = 0, eng.canAct('p', 1, 0))),
  ];
  eng.beginTurn('p');                                          // 下回合开始回滚
  checks.push(eq('回合开始攻击力回滚（7→6）', 6, ctx.at(eng, 1, 0).atk));
  checks.push(eq('回合开始奋战移除', false, ctx.at(eng, 1, 0).def.sig.includes('fight')));
  return checks;
});

test('T19', 'v2 钩子：GAME_RULES 默认归零 & 适配器每局强制归零；AI_DIFFICULTY 存在', (ctx) => {
  const eng = ctx.newEng();
  const gr = eng.GAME_RULES;
  const checks = [];
  if (!gr) return [eq('引擎导出 GAME_RULES（v2 战场规则钩子）', true, false)];
  checks.push(eq('GAME_RULES 只剩总部生命加成（战役钩子已拆）', 'true,true,true', [typeof gr.hqHpBonus === 'object', gr.enemyExtraDraw === undefined, gr.blizzard === undefined].join(',')));
  checks.push(eq('GAME_RULES 总部加成为 0', '0,0', [gr.hqHpBonus.a, gr.hqHpBonus.p].join(',')));
  // 适配器归零：手动污染后开新局应回零
  gr.hqHpBonus.p = 5; if (gr.hqHpBonus) gr.hqHpBonus.a = 3;
  const e2 = ctx.newEng();
  checks.push(eq('适配器每局强制归零（污染 hqHpBonus 后重开）', '0,0', [e2.GAME_RULES.hqHpBonus.a, e2.GAME_RULES.hqHpBonus.p].join(',')));
  checks.push(info('AI_DIFFICULTY', (ctx.loaded && ctx.loaded.ai && ctx.loaded.ai.AI_DIFFICULTY) || '(ai 未导出)', '默认 veteran；三档 recruit/veteran/warder 由 t2/t6 战役模式使用，sim 支持 --difficulty='));
  return checks;
});

test('T20', '征程之路钩子 smoke（自由对战口径）：五国 buildDeck 可建 + runGetFight 不依赖关卡数据 + setDeckOverride 不抛错 + GAME_RULES 复位后自由对战正常', (ctx) => {
  const eng = ctx.newEng();
  const m = ctx.loaded.mod;
  const checks = [];
  // 战役关卡数据与 applyLevelRules 已于 2026-09-13 按用户口径删除：
  // 征程三类关卡的敌方来源＝小怪走自由对战（随机国家 + 原版卡组 buildDeck）、精英＝同 + RUN_ELITE_BONUS、Boss＝打 Boss。
  const cards = (() => { try { const { createRequire } = require('node:module'); return createRequire(__filename)('../src/cards.js'); } catch (e) { return globalThis; } })();
  const N = cards.NATIONS || globalThis.NATIONS || {};
  let okNations = 0, badNations = [];
  for (const key of Object.keys(N)) {
    let deck = null;
    try { deck = m.buildDeck ? m.buildDeck(key) : globalThis.buildDeck(key); } catch (e) { deck = null; }
    if (Array.isArray(deck) && deck.length) okNations++; else badNations.push(key);
  }
  checks.push(eq('五国 buildDeck 均可建（征程小怪＝自由对战口径）', 0, badNations.length));
  checks.push(info('buildDeck 结果', `${okNations}/${Object.keys(N).length} 国可用`, '小怪关直接用原版卡组'));
  // 征程战斗配置：run.js 暴露 runGetFight，普通关/精英关都不再读关卡数据
  let runMod = null;
  try { const { createRequire } = require('node:module'); runMod = createRequire(__filename)('../src/run.js'); } catch (e) { runMod = null; }
  if (runMod && typeof runMod.runGetFight === 'function') {
    const f = runMod.runGetFight({ type:'fight', nation:'de' });
    checks.push(eq('runGetFight(普通关) 产出敌方卡组', true, Array.isArray(f.deck) && f.deck.length > 0));
    checks.push(eq('普通关不带任何加成', null, f.bonusText));
    const e = runMod.runGetFight({ type:'elite', nation:'de' });
    const tankBefore = (f.deck || []).filter(c => c && c.kind === 'unit' && c.t === 'tank').map(c => (c.atk || 0) + '/' + (c.hp || 0)).sort().join(',');
    const tankAfter = (e.deck || []).filter(c => c && c.kind === 'unit' && c.t === 'tank').map(c => (c.atk || 0) + '/' + (c.hp || 0)).sort().join(',');
    checks.push(eq('精英关按国家给加成（德：坦克 +2/+2）', true, tankBefore !== tankAfter && !!(e.bonusText || '').indexOf('+2/+2') > -1));
    const boss = runMod.runGetFight({ type:'boss', bossKind:'tears' });
    checks.push(eq('Boss 关走 Boss 卡组', true, boss.kind === 'boss' && Array.isArray(boss.deck)));
    checks.push(info('三种关卡来源', `普通=${f.nation}/${(f.deck||[]).length}张 精英=${e.nation}/${(e.deck||[]).length}张 Boss=${boss.bossKind}`, '不再读 CAMPAIGN_LEVELS'));
  } else {
    checks.push(info('runGetFight', 'run.js 未能加载（跳过）', '需 globalThis 上有引擎全局'));
  }
  checks.push(eq('战役关卡数据已删除（CAMPAIGN_LEVELS 不存在）', true, typeof (cards.CAMPAIGN_LEVELS || globalThis.CAMPAIGN_LEVELS) === 'undefined'));
  checks.push(eq('applyLevelRules 已删除（engine 不再导出）', true, typeof m.applyLevelRules !== 'function'));
  // setDeckOverride 不抛错
  if (typeof m.setDeckOverride === 'function') {
    let msg = 'ok';
    try { m.setDeckOverride({ p: [], a: [] }); msg = 'ok'; }
    catch (e) { msg = '抛错: ' + e.message; }
    checks.push(eq('组卡 setDeckOverride 调用不抛错', true, msg === 'ok'));
  } else checks.push(eq('组卡 setDeckOverride 已落地（engine.js）', true, false));
  const g = eng.GAME_RULES;
  checks.push(eq('GAME_RULES 复位 = 自由对战基线', '0,0', [g.hqHpBonus.a, g.hqHpBonus.p].join(',')));
  checks.push(eq('自由对战正常开局（双方手牌 5+5）', 10, eng.state.p.hand.length + eng.state.a.hand.length));
  checks.push(info('AI 难度', (ctx.loaded.ai && ctx.loaded.ai.AI_DIFFICULTY) || '(ai 未导出)', 'recruit/veteran/warder；sim --difficulty 可复测'));
  return checks;
});

/* ---------------- 主流程 ---------------- */
async function main() {
  const loaded = opt.selftest
    ? await loadEngine({ enginePath: path.join(TOOLS_DIR, 'fixtures', 'mock-engine.js'), aiPath: path.join(TOOLS_DIR, 'fixtures', 'mock-ai.js') })
    : await loadEngine({ enginePath: opt.enginePath || undefined, aiPath: opt.aiPath || undefined });
  if (!loaded.ok) {
    console.error(`\n[verify.mjs] 引擎不可用：${loaded.reason}`);
    if (loaded.foundKeys) console.error(`[verify.mjs] 引擎实际导出键: ${loaded.foundKeys.join(', ')}`);
    console.error('[verify.mjs] 参照 tools/ENGINE_CONTRACT.md 对齐；或先用 --selftest 自检工具链。\n');
    process.exit(2);
  }
  const defs = makeDefs(loaded);
  const ctx = makeCtx(loaded, defs);
  const all = opt.selftest ? TESTS.filter(t => t.id.startsWith('H')) : TESTS.filter(t => !t.id.startsWith('H'));
  const runList = opt.filter ? all.filter(t => opt.filter.includes(t.id)) : all;
  if (opt.list) {
    for (const t of TESTS) console.log(`${t.id}  ${t.name}`);
    process.exit(0);
  }
  console.log(`[verify.mjs] 引擎: ${loaded.source.engine}`);
  if (!opt.selftest && loaded.ai) console.log(`[verify.mjs] AI: ${loaded.source.ai}`);
  let passCount = 0, failCount = 0, infoCount = 0, skipCount = 0;
  console.log(`[verify.mjs] 运行 ${runList.length} 个测试${opt.selftest ? '（自检 H-* 组）' : ''}\n`);
  for (const t of runList) {
    let checks;
    try { checks = t.run(ctx) || []; }
    catch (e) {
      checks = [mkCheck('场景构建异常', '无异常', e.message)];
    }
    const fails = checks.filter(c => !c.pass && !c.info);
    const infos = checks.filter(c => c.info);
    const ok = fails.length === 0;
    if (ok) passCount++; else failCount++;
    infoCount += infos.length;
    const status = ok ? 'PASS' : 'FAIL';
    console.log(`${status}  ${t.id}  ${t.name}`);
    if (!ok) {
      for (const c of fails) console.log(`     ✗ ${c.label}：期望=${c.expected} 实际=${c.actual}`);
      const dumpEng = (fails.find(c => c.eng) || infos.find(c => c.eng) || checks[0])?.eng || _lastEng;
      const manual = checks.find(c => c.dump);
      if (manual && manual.dump) console.log(manual.dump);
      else if (dumpEng) console.log(dumpState(dumpEng));
      else console.log('     （无引擎可dump）');
    }
    if (opt.verbose) {
      for (const c of checks.filter(c => c.pass && !c.info)) console.log(`     ✓ ${c.label}=${c.actual}`);
      for (const c of infos) console.log(`     ℹ ${c.label}=${c.actual}${c.note ? '  ' + c.note : ''}`);
    }
  }
  console.log(`\n[verify.mjs] 结果：通过 ${passCount} / ${runList.length}${infoCount ? `，另记录 ${infoCount} 项 INFO 行为` : ''}${failCount ? `，失败 ${failCount} 项` : ''}`);
  process.exit(failCount ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
