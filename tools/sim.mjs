#!/usr/bin/env node
// sim.mjs —— 无头对局模拟器（AI vs AI）
// 用法：
//   node tools/sim.mjs                # 5×5 国对阵矩阵 × 默认 200 局/对
//   node tools/sim.mjs 50             # 每对 50 局
//   node tools/sim.mjs 200 --pairs=us,de,su   # 仅指定国家参与的矩阵
//   node tools/sim.mjs 200 --seed=42  # 确定性随机种子
//   node tools/sim.mjs 200 --max-turns=400
//   node tools/sim.mjs --selftest     # 用 fixtures/mock-engine 自检工具链（不依赖 t1）
// 要求：src/engine.js + src/ai.js 遵循 tools/ENGINE_CONTRACT.md；零 npm 依赖（node 原生 ESM）。

import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine, cardDefs, TOOLS_DIR } from './engineAdapter.mjs';

const NATIONS_KEYS = ['us', 'de', 'su', 'gb', 'jp'];

/* ---------------- 参数解析 ---------------- */
const args = process.argv.slice(2);
const opt = {
  games: 200, pairs: null, seed: null, maxTurns: 300, selftest: false, json: true, quiet: false,
  enginePath: null, aiPath: null, difficulty: null,
};
for (const a of args) {
  if (a === '--selftest') opt.selftest = true;
  else if (a === '--no-json') opt.json = false;
  else if (a === '--quiet') opt.quiet = true;
  else if (a.startsWith('--pairs=')) opt.pairs = a.slice(8).split(',').map(s => s.trim()).filter(Boolean);
  else if (a.startsWith('--seed=')) opt.seed = parseInt(a.slice(7), 10);
  else if (a.startsWith('--max-turns=')) opt.maxTurns = parseInt(a.slice(12), 10);
  else if (a.startsWith('--engine=')) opt.enginePath = a.slice(9);
  else if (a.startsWith('--ai=')) opt.aiPath = a.slice(5);
  else if (a.startsWith('--difficulty=')) opt.difficulty = a.slice(13);
  else if (/^\d+$/.test(a)) opt.games = parseInt(a, 10);
  else { console.error(`未知参数: ${a}`); process.exit(2); }
}

function makeRng(seed) {
  if (seed === null) return Math.random;
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* ---------------- 加载引擎 ---------------- */
const load = async () => {
  if (opt.selftest) {
    const engine = path.join(TOOLS_DIR, 'fixtures', 'mock-engine.js');
    const ai = path.join(TOOLS_DIR, 'fixtures', 'mock-ai.js');
    return loadEngine({ enginePath: engine, aiPath: ai });
  }
  return loadEngine({ enginePath: opt.enginePath || undefined, aiPath: opt.aiPath || undefined });
};

/* ---------------- 单局模拟 ---------------- */
// 返回 { winner, turns, ms, errors:[], stats }  stats.cards = Map
function playGame(eng) {
  const ai = eng.ai || { choose: () => null, attack: (s, r, c, u, t) => (t && t[0]) || null, push: () => [] };
  const t0 = performance.now();
  const errors = [];
  const cardStats = new Map(); // cardId+n 组合 → {plays, spawns, orders, counters, attacks}
  const bump = (card, side, kind) => {
    const k = `${card.id}:${card.n}`;
    const st = cardStats.get(k) || { id: card.id, n: card.n, plays: 0, spawns: 0, orders: 0, counters: 0, attacks: 0 };
    st[kind]++; st.plays++;
    cardStats.set(k, st);
  };
  const S = eng.state;
  const safe = (label, fn) => {
    try { return { ok: true, v: fn() }; } catch (e) {
      errors.push({ label, turn: S.turn, msg: e.message, stack: (e.stack || '').split('\n').slice(0, 4).join(' | ') });
      return { ok: false, v: null };
    }
  };
  try {
    // 初始摸 5 张
    safe('draw-init-p', () => eng.drawCards('p', 5));
    safe('draw-init-a', () => eng.drawCards('a', 5));
    let guard = 0;
    while (!S.over && guard++ < 1000) {
      for (const side of ['p', 'a']) {
        if (S.over) break;
        // 回合开始
        const bt = safe(`beginTurn-${side}`, () => eng.beginTurn(side));
        if (!bt.ok) break;
        if (S.over) break;
        // 摸牌：前 4 回合优先生产（沿用原 AI 策略），否则卡组
        const me = S[side];
        const drawAct = safe(`draw-${side}`, () =>
          (me.prodDeck.length > 0 && S.turn <= 4 && me.hand.length < 9) ? eng.drawProduce(side) : eng.drawCards(side, 1));
        if (eng.hideDraw) safe(`hideDraw-${side}`, () => eng.hideDraw());
        if (S.over) break;
        // 行动循环（部署/指令/反制）
        for (let i = 0; i < 12 && !S.over; i++) {
          const pl = safe(`aiChoosePlay-${side}`, () => ai.choose(side));
          if (!pl.ok || !pl.v) break;
          const card = pl.v.card;
          if (pl.v.kind === 'unit') {
            const slot = pl.v.slot || { row: side === 'p' ? 2 : 0, col: 0 };
            const ok = safe(`spawn-${side}:${card.n}`, () => eng.spawnUnit(side, card, slot.row, slot.col));
            if (!ok.ok || !ok.v) break;
            bump(card, side, 'spawns');
            const idx = (me.hand || []).indexOf(card);
            if (idx > -1) me.hand.splice(idx, 1);
          } else if (pl.v.kind === 'order') {
            const ok = safe(`order-${side}:${card.n}`, () => eng.orderEffect(card, pl.v.tgt || null, side));
            if (!ok.ok) break;
            bump(card, side, 'orders');
            const idx = (me.hand || []).indexOf(card);
            if (idx > -1) me.hand.splice(idx, 1);
          } else if (pl.v.kind === 'counter') {
            const ok = safe(`counter-${side}:${card.n}`, () => eng.activateCounter(side, card));
            if (!ok.ok) break;
            bump(card, side, 'counters');
            const idx = (me.hand || []).indexOf(card);
            if (idx > -1) me.hand.splice(idx, 1);
          }
        }
        if (S.over) break;
        // 推进
        const plan = safe(`pushPlan-${side}`, () => {
          if (ai.push) return ai.push(side) || [];
          return builtinPushPlan(eng, side);
        });
        if (plan.ok && Array.isArray(plan.v)) {
          for (const pc of plan.v.slice(0, 2)) {
            if (S.over) break;
            const mv = safe(`move-${side}`, () => eng.moveForward(side, pc.row, pc.col));
            if (!mv.ok) break;
          }
        }
        if (S.over) break;
        // 攻击
        const units = safe(`units-${side}`, () => {
          const out = [];
          const board = S.board;
          for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) {
            const u = board[r][c];
            if (u && u.owner === side) out.push({ u, r, c });
          }
          return out;
        });
        if (units.ok) {
          for (const { u, r, c } of units.v) {
            if (S.over) break;
            const act = safe(`canAct-${side}@${r},${c}`, () => eng.canAct(side, r, c));
            if (!act.ok || !act.v) continue;
            const tgts = safe(`targets-${side}@${r},${c}`, () => eng.attackTargets(side, r, c));
            if (!tgts.ok || !tgts.v || !tgts.v.length) continue;
            const t = safe(`aiAttack-${side}`, () => ai.attack(side, r, c, u, tgts.v));
            if (!t.ok || !t.v) continue;
            bump(u.def, side, 'attacks');
            safe(`combat-${side}@${r},${c}`, () => eng.combat({ row: r, col: c }, t.v));
          }
        }
        if (S.over) break;
        safe(`endTurn-${side}`, () => eng.endTurn(side));
        if (S.turn > opt.maxTurns) { S.over = true; S.winner = 'draw'; }
      }
    }
    if (!S.over) { S.winner = 'draw'; }
  } catch (e) {
    errors.push({ label: 'game-fatal', turn: S.turn, msg: e.message, stack: (e.stack || '').split('\n').slice(0, 6).join(' | ') });
    S.winner = 'crash';
  }
  return { winner: S.winner, turns: S.turn, ms: performance.now() - t0, errors, cards: cardStats };
}

function builtinPushPlan(eng, side) {
  const row = side === 'p' ? 2 : 0;
  const out = [];
  for (let c = 0; c < 5; c++) {
    const u = eng.state.board[row][c];
    if (!u || u.owner !== side || u.movedThisTurn || u.suppressed) continue;
    const sig = u.def.sig || [];
    if (sig.includes('guard')) out.push({ row, col: c });
    else if (u.summonedThisTurn && sig.includes('blitz')) out.push({ row, col: c });
  }
  return out.sort((a, b) => (eng.state.board[row][a.col].def.sig.includes('guard') ? -1 : 1) - (eng.state.board[row][b.col].def.sig.includes('guard') ? -1 : 1)).slice(0, 2);
}

/* ---------------- 统计输出 ---------------- */
const pw = s => { let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1; return w; };
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - pw(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - pw(s))) + s;

function fmtPct(x) { return Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—'; }

function printMatrix(title, keys, cell) {
  console.log(`\n${title}`);
  console.log('  ' + pad('', 12) + keys.map(h => pad(h, 9)).join(''));
  for (const a of keys) {
    const rowEls = [];
    for (const b of keys) rowEls.push(pad(cell(a, b), 9));
    console.log('  ' + pad(a, 12) + rowEls.join(''));
  }
}

async function main() {
  const loaded = await load();
  if (!loaded.ok) {
    console.error(`\n[sim.mjs] 引擎不可用：${loaded.reason}`);
    if (loaded.foundKeys) console.error(`[sim.mjs] 引擎实际导出键: ${loaded.foundKeys.join(', ')}`);
    console.error('[sim.mjs] 参照 tools/ENGINE_CONTRACT.md 对齐；或先用 --selftest 自检工具链。\n');
    process.exit(2);
  }
  const rngBase = makeRng(opt.seed);
  // AI 难度档（t2 三档：recruit/veteran/warder；缺省 veteran = 引擎默认）
  if (opt.difficulty) {
    if (loaded.ai && typeof loaded.ai.setAI_DIFFICULTY === 'function') loaded.ai.setAI_DIFFICULTY(opt.difficulty);
    else { console.error(`[sim.mjs] --difficulty=${opt.difficulty} 但 src/ai.js 未导出 setAI_DIFFICULTY`); process.exit(2); }
  }
  if (opt.selftest) opt.games = Math.min(opt.games, 8);
  // 矩阵国家 = 引擎实际卡池 ∩ 用户指定（默认全卡池）
  const avail = Object.keys(loaded.NATIONS || {});
  const keys = opt.pairs ? opt.pairs.filter(k => avail.includes(k)) : avail;
  const missing = opt.pairs ? opt.pairs.filter(k => !avail.includes(k)) : [];
  if (!keys.length) { console.error('[sim.mjs] 引擎卡池不含任何可用国家（NATIONS 为空）'); process.exit(2); }
  if (missing.length) console.warn(`[sim.mjs] 引擎卡池缺少国家: ${missing.join(', ')}（跳过）`);
  const N = opt.games;
  const nationNames = Object.fromEntries(Object.entries(loaded.NATIONS).map(([k, v]) => [k, v.name]));

  const results = {};   // "a_bb" → {aWins,bWins,draws,crashes,turns[],ms[],cards}
  const allErrors = [];
  const total = keys.length * keys.length * N;
  let done = 0;
  for (const a of keys) for (const b of keys) {
    const key = `${a}_${b}`;
    results[key] = { aWins: 0, bWins: 0, draws: 0, crashes: 0, turns: [], ms: [], cards: new Map() };
    for (let i = 0; i < N; i++) {
      const rng = makeRng(rngBase());
      let eng;
      try {
        eng = loaded.factory.fn({ pNation: a, aNation: b, rng, hooks: {}, log: false });
      } catch (e) {
        results[key].crashes++; allErrors.push({ key, kind: 'init', msg: e.message, stack: (e.stack || '').slice(0, 500) });
        continue;
      }
      const g = playGame(eng);
      results[key].turns.push(g.turns); results[key].ms.push(g.ms);
      if (g.winner === 'p') results[key].aWins++;
      else if (g.winner === 'a') results[key].bWins++;
      else if (g.winner === 'draw') results[key].draws++;
      else results[key].crashes++;
      for (const e of g.errors) allErrors.push({ key, side: e.label, turn: e.turn, msg: e.msg, stack: e.stack });
      for (const [k, st] of g.cards) {
        const cur = results[key].cards.get(k) || { id: st.id, n: st.n, plays: 0, spawns: 0, orders: 0, counters: 0, attacks: 0 };
        cur.plays += st.plays; cur.spawns += st.spawns; cur.orders += st.orders; cur.counters += st.counters; cur.attacks += st.attacks;
        results[key].cards.set(k, cur);
      }
      done++;
      if (!opt.quiet && done % 500 === 0) console.log(`  … 已完成 ${done}/${total} 局`);
    }
  }

  /* ---- 胜率矩阵 ---- */
  console.log(`\n===== 无头模拟：AI vs AI（每对 ${N} 局，seed=${opt.seed ?? 'random'}，难度=${opt.difficulty ?? 'veteran(默认)'}，共 ${total} 局） =====`);
  printMatrix('① 先手方(行) 胜率', keys, (a, b) => {
    const r = results[`${a}_${b}`]; const total1 = r.aWins + r.bWins + r.draws + r.crashes;
    return fmtPct(total1 ? r.aWins / total1 : NaN);
  });
  console.log('  （行=先手国 A，列=后手国 B；平局/崩溃计入分母）');

  /* ---- 平均回合 / 平均时长 ---- */
  printMatrix('② 平均回合数', keys, (a, b) => {
    const r = results[`${a}_${b}`];
    return r.turns.length ? (r.turns.reduce((x, y) => x + y, 0) / r.turns.length).toFixed(1) : '—';
  });
  printMatrix('③ 平均对局时长 (ms)', keys, (a, b) => {
    const r = results[`${a}_${b}`];
    return r.ms.length ? (r.ms.reduce((x, y) => x + y, 0) / r.ms.length).toFixed(1) : '—';
  });

  /* ---- 异常统计 ---- */
  const errTotal = allErrors.length;
  console.log(`\n④ 引擎异常：共 ${errTotal} 次抛错（已捕获并继续${errTotal ? '；前 5 条明细如下' : ''}）`);
  for (const e of allErrors.slice(0, 5)) {
    console.log(`   - [${e.key}] 回合${e.turn ?? '?'} ${e.label} → ${e.msg}`);
    if (e.stack) console.log(`       ${e.stack}`);
  }
  const crashPairs = keys.flatMap(a => keys.filter(b => results[`${a}_${b}`].crashes > 0).map(b => `${a} vs ${b}`));
  if (crashPairs.length) console.log(`   ⚠ 出现崩溃/未分胜负的对: ${crashPairs.join(', ')}`);

  /* ---- 卡牌使用统计 ---- */
  const agg = new Map();
  const gamesPlayed = total;
  for (const key of keys.flatMap(a => keys.map(b => `${a}_${b}`))) {
    for (const [k, st] of results[key].cards) {
      const cur = agg.get(k) || { id: st.id, n: st.n, plays: 0, spawns: 0, orders: 0, counters: 0, attacks: 0 };
      cur.plays += st.plays; cur.spawns += st.spawns; cur.orders += st.orders; cur.counters += st.counters; cur.attacks += st.attacks;
      agg.set(k, cur);
    }
  }
  const sorted = [...agg.values()].sort((x, y) => y.plays - x.plays);
  console.log(`\n⑤ 卡牌使用统计（全矩阵合计；出场率=部署次数/总局数，使用次数=部署+指令+反制+攻击）`);
  console.log('   ' + pad('卡牌', 22) + pad('部署', 8) + pad('指令', 7) + pad('反制', 7) + pad('攻击', 7) + pad('出场率', 9));
  for (const st of sorted.slice(0, 30)) {
    console.log('   ' + pad(st.n, 22) + pad(String(st.spawns), 8) + pad(String(st.orders), 7) + pad(String(st.counters), 7) + pad(String(st.attacks), 7) + pad(fmtPct(gamesPlayed ? st.spawns / gamesPlayed : 0), 9));
  }

  /* ---- 汇总 ---- */
  let sumT = 0, sumM = 0, nG = 0;
  for (const k of Object.keys(results)) { for (const t of results[k].turns) { sumT += t; nG++; } for (const m of results[k].ms) sumM += m; }
  const playsCount = [...agg.values()].reduce((x, s) => x + s.plays, 0);
  console.log(`\n⑥ 汇总：完成 ${nG} 局；平均回合 ${nG ? (sumT / nG).toFixed(1) : '—'}；平均时长 ${nG ? (sumM / nG).toFixed(1) : '—'} ms；卡牌动作合计 ${playsCount} 次；异常 ${errTotal} 次。`);

  if (opt.json) {
    const outDir = path.join(TOOLS_DIR, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `sim_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({
      meta: { games: N, seed: opt.seed, keys, maxTurns: opt.maxTurns },
      results: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { ...r, turns: undefined, ms: undefined, avgTurns: r.turns.length ? r.turns.reduce((x, y) => x + y, 0) / r.turns.length : null, avgMs: r.ms.length ? r.ms.reduce((x, y) => x + y, 0) / r.ms.length : null }])),
      errors: allErrors.slice(0, 200),
    }, null, 2));
    console.log(`\n[JSON 已保存] ${file}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
