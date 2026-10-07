// engineAdapter.mjs —— t3/t5 与 t1 引擎的唯一对接层
// 用法：const a = await loadEngine();  a.ok ? (a.factory.fn(opts) → 规范引擎实例) : 打印 a.reason
// 实际落地 API（t1）：src/engine.js = 模块态（全局 S + HOOKS 解耦，CJS require，与 v1.html 逐行为等价）；
//                    src/ai.js  = 全局函数（仅 a 侧；Node 下发布到 globalThis）。
// 本适配器把上述模块态 API 归一化为规范接口（见 ENGINE_CONTRACT.md §2/§3/§4）：
//   factory.fn({pNation,aNation,rng,hooks,log}) → eng{ state, 方法..., ai:{choose,attack,push} }
// 若引擎换成新式工厂（createGame 导出）也兼容（instance 模式）。

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function defaultPaths() {
  return {
    engine: path.join(TOOLS_DIR, '..', 'src', 'engine.js'),
    ai: path.join(TOOLS_DIR, '..', 'src', 'ai.js'),
  };
}

function requireFresh(req, p) {
  const resolved = req.resolve(path.resolve(p));
  delete req.cache[resolved];
  return req(resolved);
}

// 新式工厂：createGame/newGame/initGame/newEngine/createGameState 之一
function pickFactory(mod) {
  for (const k of ['createGame', 'newGame', 'initGame', 'newEngine', 'createGameState']) {
    if (typeof mod[k] === 'function') return { name: k, fn: mod[k] };
  }
  return null;
}

export async function loadEngine({ enginePath, aiPath } = {}) {
  const p = enginePath || defaultPaths().engine;
  const aip = aiPath || defaultPaths().ai;
  if (!existsSync(p)) {
    return { ok: false, reason: `引擎文件不存在: ${p}（t1 尚未交付？）`, foundKeys: null };
  }
  const req = createRequire(import.meta.url);
  let mod = null;
  try {
    mod = requireFresh(req, p);
  } catch (e) {
    return { ok: false, reason: `引擎加载抛错: ${e.message}`, error: e, foundKeys: Object.keys(mod || {}) };
  }
  // 卡池数据：引擎自导出 / cards.js 旁路 / globalThis（engine.js 在 Node 下 Object.assign(globalThis, cards)）
  let NATIONS = mod.NATIONS || null;
  if (!NATIONS && existsSync(path.join(path.dirname(p), 'cards.js'))) {
    try { NATIONS = requireFresh(req, path.join(path.dirname(p), 'cards.js')).NATIONS || null; } catch { /* ignore */ }
  }
  if (!NATIONS) NATIONS = globalThis.NATIONS || null;
  let aiMod = null;
  if (existsSync(aip)) {
    try { aiMod = requireFresh(req, aip); } catch (e) {
      return { ok: false, reason: `ai.js 加载抛错: ${e.message}`, error: e };
    }
  }
  const factory = pickFactory(mod);
  if (factory) {
    // —— 新式工厂（实例态）：直接包一层，挂 ai ——
    return { ok: true, reason: 'ok', source: { engine: p, ai: existsSync(aip) ? aip : '(缺)' }, mod, ai: aiMod, NATIONS,
      factory: { name: 'instance', fn: (opts = {}) => {
        const raw = factory.fn(opts);
        return attachAi(raw, aiMod, false);
      } } };
  }
  // —— 模块态（t1 实际交付形态）——
  const needed = ['spawnUnit', 'moveForward', 'combat', 'orderEffect', 'resetGameState', 'drawCards', 'S', 'HOOKS'];
  const missing = needed.filter(k => !(k in mod));
  if (missing.length) {
    return { ok: false, reason: `引擎缺少核心导出: ${missing.join(', ')}（模块态 API 未对齐）`, foundKeys: Object.keys(mod || {}) };
  }
  return { ok: true, reason: 'ok (module-state)', source: { engine: p, ai: existsSync(aip) ? aip : '(缺)' }, mod, ai: aiMod, NATIONS,
    factory: { name: 'module-state', fn: (opts = {}) => makeEng(mod, aiMod, NATIONS, opts) } };
}

/* ---------------- 规范 AI（对 p/a 同策略的镜像；a 侧优先走 ai.js 原实现） ---------------- */
function makeAI(eng, mod, aiMod, mode) {
  const S = eng.state === undefined ? null : (typeof eng.state === 'function' ? eng.state() : eng.state);
  const dmgMap = { fromPeople: 3, burningSky: 4, bloodSickle: 1, bombRaid: 3, gunboat: 2, desertRat: 1 };
  const sideChooserGeneric = (side) => {
    const me = S[side]; const h = me.hand;
    for (const c of h) if (c.kind === 'order' && c.eff === 'produce') return { kind: 'order', card: c, tgt: null };
    const pwr = c => (c.atk || 0) * 2 + (c.hp || 0) + ((c.sig || []).includes('guard') ? 4 : 0) + ((c.sig || []).includes('blitz') ? 2 : 0) - (c.blood || 0) * 2;
    let best = null, bs = -1;
    for (const c of h) {
      if (c.kind !== 'unit' || (c.blood || 0) > me.kredit) continue;
      const slot = mod.emptyBacklineSlot ? mod.emptyBacklineSlot(side) : null;
      if (!slot) continue;
      const s = pwr(c);
      if (s > bs) { bs = s; best = { kind: 'unit', card: c, slot }; }
    }
    if (best) return best;
    for (const c of h) {
      if (c.kind !== 'order' || (c.blood || 0) > me.kredit) continue;
      if (c.target) {
        const tgts = mod.orderTargets ? mod.orderTargets(c, side) : [];
        if (!tgts.length) continue;
        const t = pickTarget(c, tgts);
        if (t) return { kind: 'order', card: c, tgt: { row: t.row, col: t.col } };
        continue;
      }
      if (['airStrike', 'bismarck'].includes(c.eff)) return { kind: 'order', card: c, tgt: null };
      if (c.eff === 'deathFromAbove' && mod.countEnemy && mod.countEnemy(side) > 0) return { kind: 'order', card: c, tgt: null };
      if (['winterWar', 'carpetBomb', 'eagleClaw', 'greatWar'].includes(c.eff)) return { kind: 'order', card: c, tgt: null };
      if (c.eff === 'fortify' && S[side].hp > 0) return { kind: 'order', card: c, tgt: null };
      if (c.eff === 'warMachine') return { kind: 'order', card: c, tgt: null };
      if (c.eff === 'mx175' && h.length <= 4) return { kind: 'order', card: c, tgt: null };
    }
    if (me.kredit >= 1) for (const c of h) if (c.kind === 'counter' && (c.blood || 0) <= me.kredit) return { kind: 'counter', card: c };
    return null;
  };
  const pickTarget = (card, targets) => {
    const dmg = dmgMap[card.eff] || 0;
    // 总部目标没有 u（t.hq=true）——旧写法直接 t.u.hp 会在选到总部时抛错（sim 里表现为大量「异常」）
    const stat = t => t.u || { atk: 0, hp: 0 };
    let pool = targets;
    if (dmg > 0) { const k = targets.filter(t => stat(t).hp <= dmg); if (k.length) pool = k; }
    pool = pool.slice().sort((a, b) => (stat(b).atk * 3 + stat(b).hp) - (stat(a).atk * 3 + stat(a).hp));
    return pool[0];
  };
  const attackGeneric = (side, r, c, u, tgts) => {
    const at = (t) => (t.hq ? null : mod.unitAt ? mod.unitAt(t.row, t.col) : null);
    const guard = tgts.filter(t => !t.hq && at(t) && mod.hasSig(at(t), 'guard'));
    const pool = guard.length ? guard : tgts.filter(t => !t.hq);
    if (!pool.length) return tgts[0] || null;
    const threat = t => { const d = at(t); return d ? d.atk * 3 + d.hp + (mod.hasSig(d, 'guard') ? 2 : 0) : 0; };
    const killable = pool.filter(t => { const d = at(t); return d && d.hp <= u.atk; });
    if (killable.length) return killable.slice().sort((x, y) => threat(y) - threat(x))[0];
    const nonAmbush = pool.filter(t => !mod.hasSig(at(t), 'ambush'));
    const set = nonAmbush.length ? nonAmbush : pool;
    return set.slice().sort((x, y) => threat(y) - threat(x))[0];
  };
  const pushPlan = (side) => {
    if (!mod.backRowOf) return [];
    const row = mod.backRowOf(side);
    const out = [];
    for (let c = 0; c < mod.COLS; c++) {
      const u = S.board[row][c];
      if (!u || u.owner !== side || u.movedThisTurn || u.suppressed) continue;
      const sig = u.def.sig || [];
      const canPush = sig.includes('blitz') || u.def.t === 'tank' || !u.summonedThisTurn;
      if (!canPush) continue;
      if (sig.includes('guard')) out.push({ row, col: c, score: 99 });
      else if (u.summonedThisTurn && sig.includes('blitz')) out.push({ row, col: c, score: 55 });
    }
    return out.sort((a, b) => b.score - a.score).map(({ row, col }) => ({ row, col })).slice(0, 2);
  };
  const choose = mode === 'module-state' && aiMod && typeof aiMod.aiChoosePlay === 'function'
    ? (side) => (side === 'a' ? aiMod.aiChoosePlay() : sideChooserGeneric(side))
    : (side) => sideChooserGeneric(side);
  const attack = mode === 'module-state' && aiMod && typeof aiMod.aiAttackTarget === 'function'
    ? (side, r, c, u, tgts) => (side === 'a' ? aiMod.aiAttackTarget(r, c, u, tgts) : attackGeneric(side, r, c, u, tgts))
    : attackGeneric;
  return { choose, attack, push: pushPlan };
}

function attachAi(eng, aiMod, isModuleMode) {
  if (aiMod && typeof aiMod.aiChoosePlay === 'function' && typeof aiMod.aiChoosePlay.length === 'number' && aiMod.aiChoosePlay.length >= 2) {
    // 实例态 ai：aiChoosePlay(eng, side) 自含 side
    eng.ai = {
      choose: (side) => aiMod.aiChoosePlay(eng, side),
      attack: (side, r, c, u, tgts) => (aiMod.aiAttackTarget ? aiMod.aiAttackTarget(eng, r, c, u, tgts) : tgts[0]),
      push: (side) => (aiMod.aiPushPlan ? aiMod.aiPushPlan(eng, side) : []),
    };
  } else {
    eng.ai = makeAI(eng, eng.mod || {}, aiMod, isModuleMode);
  }
  return eng;
}

/* ---------------- 模块态引擎 → 规范引擎实例 ---------------- */
export function makeEng(mod, aiMod, NATIONS, opts = {}) {
  const S = mod.S;
  const H = mod.HOOKS;
  H.wait = () => undefined; // 无头：同步（引擎 await 它时立即返回）
  H.onGameEnd = (w) => { S.winner = w; }; // 引擎 endGame 只发钩子；这里落库到 state.winner
  // v2 战场规则钩子：每局强制归零（默认值 = 现有行为完全等价；sim/verify 以零加成对局为准）
  if (typeof mod.setGAME_RULES_OFF === 'function') mod.setGAME_RULES_OFF();
  else if (mod.GAME_RULES && mod.GAME_RULES.hqHpBonus) {   // 已只剩总部生命加成（其余钩子 2026-09-13 拆除）
    mod.GAME_RULES.hqHpBonus.a = 0;
    mod.GAME_RULES.hqHpBonus.p = 0;
  }
  // v2 卡组覆盖：每局复位（杜绝 t4 组卡/战役卡组泄漏到模拟局）
  if (typeof mod.setDeckOverride === 'function') mod.setDeckOverride({ p: null, a: null });
  if (opts.rng) Math.random = opts.rng; // 确定性随机（shuffle/战斗随机）
  if (opts.pNation) S.pNation = opts.pNation;
  if (opts.aNation) S.aNation = opts.aNation;
  mod.resetGameState();
  S.winner = null;
  mod.drawCards(S.p, 5);
  mod.drawCards(S.a, 5);
  const ph = side => { S.phase = side === 'a' ? 'ai' : 'player'; };

  const eng = {
    mode: 'module-state', state: S, NATIONS, mod, HOOKS: H,
    GAME_RULES: mod.GAME_RULES || null,
    rng: () => Math.random(),
    drawCards: (side, n) => mod.drawCards(S[side], n),
    drawProduce: (side) => {
      const me = S[side];
      if (!me.prodDeck.length) return false;
      if (me.hand.length >= 9) { me.prodDeck.pop(); return false; }
      me.hand.push(me.prodDeck.pop()); return true;
    },
    hideDraw: () => { try { mod.hideDrawChoice(); } catch { /* 无 UI */ } },
    spawnUnit: (side, card, row, col) => {
      const me = S[side];
      if ((card.blood || 0) > me.kredit) return false;
      const r = row === undefined ? mod.backRowOf(side) : row;
      if (row === undefined) { for (let c = 0; c < mod.COLS; c++) if (!S.board[r][c]) return eng.spawnUnit(side, card, r, c); return false; }
      if (S.board[r][col]) return false;
      ph(side);
      const ok = mod.spawnUnit(side, card, r, col);
      if (ok) me.kredit -= card.blood || 0;
      return ok;
    },
    moveForward: (side, row, col) => mod.moveForward(side, row, col),
    combat: (att, tgt) => mod.combat(att, tgt),
    orderEffect: (card, tgt, side) => {
      const me = S[side];
      if ((card.blood || 0) > me.kredit) return false;
      ph(side);
      const ok = mod.orderEffect(card, tgt || null);
      if (ok) me.kredit -= card.blood || 0;
      return ok;
    },
    activateCounter: (side, card) => {
      const me = S[side];
      if ((card.blood || 0) > me.kredit) return false;
      me.kredit -= card.blood || 0;
      if (side === 'p') mod.activateCounter(card);
      else {
        const idx = me.hand.indexOf(card);
        if (idx > -1) me.hand.splice(idx, 1);
        me.counters.push(card.eff);
      }
      return true;
    },
    attackTargets: (side, row, col) => mod.attackTargets(side, row, col),
    canAct: (side, row, col) => {
      const u = S.board[row] && S.board[row][col];
      return !!u && u.owner === side && mod.canAct(u);
    },
    applySuppress: (u) => mod.applySuppress(u),
    killUnit: (row, col, o) => mod.killUnit(row, col, o),
    beginTurn: (side) => {
      if (side === 'p') {
        mod.beginPlayerTurn();
        S.p.counters = S.p.counters.filter(x => x !== 'hqCap'); // 消防局持续到所有者下回合开始（与 HTML 行 1023 等价）
      } else {
        S.phase = 'ai';
        S.a.counters = S.a.counters.filter(x => x !== 'hqCap'); // HTML 行 951
        mod.resetUnitFlags('a');
        S.a.kreditSlots = Math.min(12, S.a.kreditSlots + 1);
        S.a.kredit = S.a.kreditSlots;
      }
      return true;
    },
    endTurn: (side) => {
      mod.clearSuppress(side); // 压制：所有者回合结束移除（HTML 行 946/1024）
      if (side === 'a') S.p.counters = S.p.counters.filter(x => x !== 'hqCap'); // HTML 行 1023
      return true;
    },
    checkGameOver: () => mod.checkGameOver(),
    unitAt: (r, c) => mod.unitAt(r, c),
    makeUnit: (def, side) => mod.makeUnit(def, side),
    enemyList: (s) => mod.enemyList(s),
    allyList: (s) => mod.allyList(s),
    orderTargets: (c, s) => (mod.orderTargets ? mod.orderTargets(c, s) : []),
    emptyBacklineSlot: (s) => (mod.emptyBacklineSlot ? mod.emptyBacklineSlot(s) : null),
    destroy: () => {},
  };
  eng.ai = makeAI(eng, mod, aiMod, true);
  return eng;
}

/* ---------------- 卡牌索引 / 场景摆放（verify 用） ---------------- */
export function cardDefs(raw) {
  const map = new Map();
  const ROW = { us: '美', de: '德', su: '苏', gb: '英', jp: '日' };
  const norm = (u, key) => ({
    kind: 'unit', id: u.id, n: u.n, t: u.t, blood: u.c ?? 0, fuel: u.f ?? 0,
    atk: u.a, hp: u.h, sig: u.s || [], armor: u.r || 0, fx: u.e || [],
    deploy: u.d || null, target: u.target || null, img: (u.img || `${ROW[key] || key}/${u.n}.png`), desc: u.n,
  });
  const normO = (o, key) => ({ kind: 'order', id: o.id, n: o.n, blood: o.c ?? 0, target: o.target || null, eff: o.e, sig: (o.s || []).slice(), img: '', desc: o.n });
  const normC = (o, key) => ({ kind: 'counter', id: o.id, n: o.n, blood: o.c ?? 0, eff: o.e, img: '', desc: o.n });
  for (const [key, n] of Object.entries(raw)) {
    for (const u of (n.units || [])) map.set(`${key}:${u.id}`, norm(u, key));
    for (const o of (n.orders || [])) map.set(`${key}:${o.id}`, normO(o, key));
    for (const c of (n.counters || [])) map.set(`${key}:${c.id}`, normC(c, key));
  }
  return map;
}

// 场景摆放：优先引擎 makeUnit 直摆（无部署效果/无反制/无旗标），否则 spawnUnit + 清理旗标
export function placeUnit(eng, side, def, row, col, opts = {}) {
  const board = eng.state.board;
  if (board[row] && board[row][col]) return null; // 占位
  let u = null;
  if (typeof eng.makeUnit === 'function') u = eng.makeUnit(def, side);
  else if (typeof eng.spawnUnit === 'function' && eng.spawnUnit(side, def, row, col)) u = eng.unitAt ? eng.unitAt(row, col) : board[row][col];
  if (!u) return null;
  board[row][col] = u;
  u.summonedThisTurn = !!opts.summoned;
  u.movedThisTurn = !!opts.moved;
  u.attackedN = opts.attackedN ?? 0;
  u.ambushUsed = !!opts.ambushUsed;
  u.suppressed = !!opts.suppressed;
  u.smokeOut = !!opts.smokeOut;
  if (opts.atk !== undefined) u.atk = opts.atk;
  if (opts.hp !== undefined) u.hp = opts.hp;
  if (opts.maxHp !== undefined) u.maxHp = opts.maxHp;
  return u;
}

export function defOf(cardIndex, key) {
  const d = cardIndex.get(key);
  return d ? JSON.parse(JSON.stringify(d)) : null;
}
