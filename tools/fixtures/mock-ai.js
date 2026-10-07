// fixtures/mock-ai.js —— 契约样例 AI（仅用于工具链自检；正式验证以 src/ai.js 为准）
// 策略：生产优先 → 部署最"值"的单位 → 指令 → 反制；攻击选威胁最高的可击杀目标，否则最高威胁。

export function aiChoosePlay(eng, side) {
  const me = eng.state[side];
  if (!me) return null;
  const hand = me.hand || [];
  for (const c of hand) if (c.kind === 'order' && c.eff === 'produce') return { kind: 'order', card: c, tgt: null };
  // 部署
  let best = null, bs = -1;
  for (const c of hand) {
    if (c.kind !== 'unit' || (c.blood || 0) > me.kredit) continue;
    if (best && c.blood > best.card.blood) continue;
    const s = (c.atk || 0) * 2 + (c.hp || 0) - (c.blood || 0) * 3;
    if (s > bs) { bs = s; best = { kind: 'unit', card: c }; }
  }
  if (best) {
    const slot = eng.allyList(side) && (side === 'p' ? true : true);
    for (let c = 0; c < 5; c++) if (!eng.state.board[side === 'p' ? 2 : 0][c]) { best.slot = { row: side === 'p' ? 2 : 0, col: c }; break; }
    if (!best.slot) best = null;
    if (best) return best;
  }
  for (const c of hand) {
    if (c.kind !== 'order' || c.eff === 'produce' || (c.blood || 0) > me.kredit) continue;
    if (c.target) {
      const t = eng.attackTargets ? null : null;
      // 简化：指向型指令随机打一个敌方单位
      const foes = eng.enemyList(side);
      if (foes.length) return { kind: 'order', card: c, tgt: { row: foes[0].r, col: foes[0].c } };
      continue;
    }
    return { kind: 'order', card: c, tgt: null };
  }
  if (me.kredit >= 1) for (const c of hand) if (c.kind === 'counter' && (c.blood || 0) <= me.kredit) return { kind: 'counter', card: c };
  return null;
}

export function aiAttackTarget(eng, r, c, u, tgts) {
  const score = t => { const d = eng.unitAt(t.row, t.col); return d ? d.atk * 3 + d.hp : 0; };
  const pool = tgts.filter(t => !t.hq);
  if (!pool.length) return tgts[0] || null;
  const killable = pool.filter(t => { const d = eng.unitAt(t.row, t.col); return d && d.hp <= u.atk; });
  if (killable.length) return killable.sort((x, y) => score(y) - score(x))[0];
  return pool.sort((x, y) => score(y) - score(x))[0];
}

export function aiPushPlan(eng, side) {
  const out = [];
  const row = side === 'p' ? 2 : 0;
  for (let c = 0; c < 5; c++) {
    const u = eng.state.board[row][c];
    if (!u || u.owner !== side || u.movedThisTurn || u.suppressed) continue;
    if (u.def.sig && u.def.sig.includes('guard')) out.push({ row, col: c });
    else if (u.summonedThisTurn && u.def.sig && u.def.sig.includes('blitz')) out.push({ row, col: c });
  }
  return out.slice(0, 2);
}
