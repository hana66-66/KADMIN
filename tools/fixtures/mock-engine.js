// fixtures/mock-engine.js —— 契约样例引擎（仅用于 tools 工具链自检）
// ⚠️ 这不是正式引擎！只是让 sim.mjs/verify.mjs 在 t1 交付前能跑通自身机制。
// 规则为极简近似（无伏击/守护/拦截/光环/溢出/亡计/压制免疫等完整规则），正式验证以 src/engine.js 为准。
// makeEngine(nations) 支持注入任意卡池数据（见 mock-engine-full.js / card-data.js）。

export const NATIONS = {
  us: { name: '麦国', hq: '', units: [
    { id: 'u_inf', n: '步兵', t: 'infantry', c: 1, f: 1, a: 2, h: 2 },
    { id: 'u_tank', n: '坦克', t: 'tank', c: 2, f: 1, a: 3, h: 3 },
    { id: 'u_fly', n: '战斗机', t: 'fighter', c: 2, f: 1, a: 2, h: 2 },
    { id: 'u_guard', n: '守护兵', t: 'infantry', c: 1, f: 1, a: 1, h: 4, s: ['guard'] },
  ], orders: [ { id: 'o_shell', n: '炮击', c: 1, e: 'mockShell', target: 'enemy-unit' } ],
    counters: [ { id: 'c_spot', n: '发现', c: 1, e: 'spotEnemy' } ] },
  de: { name: '德盟', hq: '', units: [
    { id: 'v_inf', n: '掷弹兵', t: 'infantry', c: 1, f: 1, a: 2, h: 3 },
    { id: 'v_tank', n: '装甲', t: 'tank', c: 3, f: 1, a: 3, h: 3 },
    { id: 'v_fly', n: '零式', t: 'fighter', c: 2, f: 1, a: 2, h: 3 },
    { id: 'v_smoke', n: '烟幕兵', t: 'infantry', c: 1, f: 1, a: 1, h: 2, s: ['smoke'] },
  ], orders: [ { id: 'o_raid', n: '空袭', c: 2, e: 'mockRaid' } ],
    counters: [ { id: 'c_talk', n: '漫谈', c: 1, e: 'enemyDeployDmg' } ] } };

let _uid = 1;
function shuffle(a, rng) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function mkUnitDef(u) { return { kind: 'unit', id: u.id, n: u.n, t: u.t, blood: u.c ?? 0, fuel: u.f ?? 0, atk: u.a, hp: u.h, sig: u.s || [], armor: u.r || 0, fx: u.e || [], deploy: u.d || null, target: u.target || null }; }
function mkOrderDef(o) { return { kind: 'order', id: o.id, n: o.n, blood: o.c ?? 0, target: o.target || null, eff: o.e }; }
function mkCounterDef(o) { return { kind: 'counter', id: o.id, n: o.n, blood: o.c ?? 0, eff: o.e }; }
const produceDef = { kind: 'order', id: 'produce', n: '生产', blood: 0, eff: 'produce' };

export function buildDeckFor(nations, key, rng = Math.random) {
  const n = nations[key]; if (!n) return [];
  const cards = [];
  n.units.forEach(u => { const d = mkUnitDef(u); cards.push(d); cards.push(JSON.parse(JSON.stringify(d))); });
  n.orders.forEach(o => cards.push(mkOrderDef(o)));
  n.counters.forEach(o => cards.push(mkCounterDef(o)));
  return shuffle(cards, rng);
}

export function makeEngine(nations) {
  function createGame({ pNation = 'us', aNation = 'de', rng = Math.random, hooks = {}, log = false } = {}) {
    const state = {
      turn: 0, phase: 'p', over: false, winner: null,
      board: [[null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null]],
      p: newPlayer(buildDeckFor(nations, pNation, rng)), a: newPlayer(buildDeckFor(nations, aNation, rng)),
      log: log ? [] : [],
    };
    function newPlayer(deck) {
      const prod = JSON.parse(JSON.stringify(produceDef));
      return { hp: 20, maxHp: 20, kredit: 0, kreditSlots: 0, hand: [], deck, counters: [], prodDeck: Array.from({ length: 5 }, () => JSON.parse(JSON.stringify(prod))), fatigue: 0 };
    }
    const backRow = s => s === 'p' ? 2 : 0;
    const other = s => s === 'p' ? 'a' : 'p';
    const playerOf = s => s === 'p' ? state.p : state.a;
    const enemyOf = s => s === 'p' ? state.a : state.p;
    const logMsg = m => { if (state.log) state.log.push(m); };

    function makeUnit(def, owner) {
      return { uid: 'u' + (_uid++), owner, def, atk: def.atk, hp: def.hp, maxHp: def.hp, armor: def.armor || 0,
        attackedN: 0, movedThisTurn: false, summonedThisTurn: false, suppressed: false, smokeOut: false, ambushUsed: false, bound: null };
    }
    function unitAt(r, c) { return state.board[r] ? state.board[r][c] : null; }
    function allUnits(side = null) { const out = []; for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) { const u = unitAt(r, c); if (u && (!side || u.owner === side)) out.push({ u, r, c }); } return out; }
    function drawCards(side, n) {
      const me = playerOf(side); let drawn = 0;
      for (let i = 0; i < n; i++) {
        if (!me.deck.length) { me.fatigue = (me.fatigue || 0) + 1; me.hp -= me.fatigue; logMsg(`疲劳 ${me.fatigue}`); checkGameOver(); break; }
        if (me.hand.length >= 9) break;
        me.hand.push(me.deck.pop()); drawn++;
      }
      return drawn;
    }
    function drawProduce(side) { const me = playerOf(side); if (!me.prodDeck.length) return false; if (me.hand.length >= 9) { me.prodDeck.pop(); return false; } me.hand.push(me.prodDeck.pop()); return true; }
    function spawnUnit(side, card, row, col) {
      const me = playerOf(side); const r = row === undefined ? backRow(side) : row;
      if (r === undefined) return false;
      if (row === undefined) { for (let c = 0; c < 5; c++) if (!state.board[r][c]) return spawnUnit(side, card, r, c); return false; }
      if (state.board[r][col]) return false;
      if ((card.blood || 0) > me.kredit) return false; // 费用扣除在引擎内部
      me.kredit -= card.blood || 0;
      const u = makeUnit(JSON.parse(JSON.stringify(card)), side);
      u.summonedThisTurn = true;
      state.board[r][col] = u;
      if (hooks.onSpawn) hooks.onSpawn(u, side, r, col);
      // 无心漫谈（击杀才消耗）
      const foe = enemyOf(side);
      if (foe.counters.includes('enemyDeployDmg')) { u.hp -= 3; if (u.hp <= 0) { killUnit(r, col); foe.counters = foe.counters.filter(x => x !== 'enemyDeployDmg'); } }
      return true;
    }
    function moveForward(side, row, col) {
      const u = unitAt(row, col);
      if (!u || u.owner !== side || row !== backRow(side)) return false;
      if (u.suppressed || u.movedThisTurn) return false;
      if (state.board[1].some(x => x && x.owner !== side)) return false;
      const fuel = u.def.fuel || 0; const me = playerOf(side);
      if (me.kredit < fuel) return false;
      let t = null; if (!state.board[1][col]) t = col; else for (let c = 0; c < 5; c++) if (!state.board[1][c]) { t = c; break; }
      if (t === null) return false;
      me.kredit -= fuel; state.board[1][t] = u; state.board[row][col] = null; u.movedThisTurn = true;
      if ((u.def.sig || []).includes('smoke')) u.smokeOut = true;
      const foe = enemyOf(side);
      if (foe.counters.includes('spotEnemy')) { foe.counters = foe.counters.filter(x => x !== 'spotEnemy'); drawCards(foe === state.p ? 'p' : 'a', 3); }
      if (hooks.onMove) hooks.onMove(u, side);
      return true;
    }
    function killUnit(r, c) { const u = unitAt(r, c); if (!u) return; state.board[r][c] = null; if (hooks.onKill) hooks.onKill(u, u.owner); }
    function canAct(side, r, c) { const u = typeof r === 'object' ? r : unitAt(r, c); if (!u || u.owner !== side) return false; if (u.summonedThisTurn && !(u.def.sig || []).includes('blitz')) return false; if (u.suppressed) return false; if (u.attackedN >= 1) return false; return true; }
    function attackTargets(side, row, col) {
      const u = unitAt(row, col); if (!u) return [];
      const out = []; const foeBack = backRow(other(side));
      const spawn = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) {
        const x = unitAt(r, c);
        if (!x || x.owner === side) continue;
        // 烟幕：未移动/未攻击/未落地且未失去烟幕 → 不可被选
        const hidden = (x.def.sig || []).includes('smoke') && !x.smokeOut && !x.movedThisTurn && !x.attackedN && !x.summonedThisTurn;
        if (!hidden) spawn.push({ row: r, col: c });
      }
      const t = u.def.t;
      if (t === 'infantry' || t === 'tank') { const tr = row === 1 ? foeBack : 1; for (const s of spawn) if (s.row === tr) out.push(s); }
      else for (const s of spawn) out.push(s);
      if ((t === 'fighter' || t === 'artillery' || t === 'bomber' || row === 1)) out.push({ hq: true });
      return out;
    }
    function combat(att, tgt) {
      const a = unitAt(att.row, att.col); if (!a || !canAct(a.owner, att.row, att.col)) return false;
      const me = playerOf(a.owner); const fuel = a.def.fuel || 0;
      if (me.kredit < fuel) return false;
      const valid = attackTargets(a.owner, att.row, att.col);
      if (!valid.some(v => v.hq ? tgt.hq : (v.row === tgt.row && v.col === tgt.col))) return false;
      a.attackedN++; me.kredit -= fuel;
      if (hooks.onCombat) hooks.onCombat(att, tgt, a.owner);
      if (tgt.hq) { enemyOf(a.owner).hp -= a.atk; logMsg('直击总部'); checkGameOver(); return true; }
      const d = unitAt(tgt.row, tgt.col); if (!d || d.owner === a.owner) return false;
      let dd = Math.max(0, a.atk - d.armor); d.hp -= dd;
      if (!(d.def.t === 'bomber') && !(a.def.t === 'artillery')) { const rd = Math.max(0, d.atk - a.armor); a.hp -= rd; }
      const killed = dd > 0 && d.hp <= 0;
      if (killed) killUnit(tgt.row, tgt.col);
      if (a.hp <= 0) killUnit(att.row, att.col);
      checkGameOver(); return true;
    }
    function orderEffect(card, tgt, side) {
      const me = playerOf(side);
      if ((card.blood || 0) > me.kredit) return false;
      me.kredit -= card.blood || 0;
      if (card.eff === 'produce') { me.kredit += 1; return true; }
      if (card.eff === 'mockShell' || card.eff === 'mockRaid') {
        const d = tgt ? unitAt(tgt.row, tgt.col) : null;
        if (!d) return false;
        d.hp -= (card.eff === 'mockShell' ? 2 : 3); if (d.hp <= 0) killUnit(tgt.row, tgt.col); return true;
      }
      if (card.eff === 'spotEnemy' || card.eff === 'enemyDeployDmg') { me.counters.push(card.eff); return true; }
      return false;
    }
    function activateCounter(side, card) {
      const me = playerOf(side);
      if ((card.blood || 0) > me.kredit) return false;
      me.kredit -= card.blood || 0;
      me.counters.push(card.eff); return true;
    }
    function beginTurn(side) {
      state.turn++; state.phase = side;
      for (const { u } of allUnits(side)) { u.attackedN = 0; u.movedThisTurn = false; u.summonedThisTurn = false; u.ambushUsed = false; }
      const me = playerOf(side); me.kreditSlots = Math.min(12, me.kreditSlots + 1); me.kredit = me.kreditSlots;
      return true;
    }
    function endTurn(side) { for (const { u } of allUnits(side)) u.suppressed = false; return true; }
    function checkGameOver() {
      if (state.over) return;
      if (state.a.hp <= 0) { state.over = true; state.winner = 'p'; }
      else if (state.p.hp <= 0) { state.over = true; state.winner = 'a'; }
    }
    return {
      state, hooks, rng: () => rng(), NATIONS: nations,
      unitAt, makeUnit, allUnits,
      drawCards, drawProduce, spawnUnit, moveForward, combat, orderEffect, activateCounter,
      attackTargets, canAct: (side, r, c) => canAct(side, r, c), killUnit, beginTurn, endTurn, checkGameOver,
      enemyList: s => allUnits(other(s)), allyList: s => allUnits(s),
    };
  }
  return { NATIONS: nations, buildDeck: (k, rng) => buildDeckFor(nations, k, rng), createGame };
}

const _engine = makeEngine(NATIONS);
export const buildDeck = _engine.buildDeck;
export const createGame = _engine.createGame;
