/* ============================================================
   铭刻前线 —— AI 策略层（src/ai.js）
   零 DOM 依赖；仅操作全局 S 与引擎函数（浏览器靠全局变量，
   Node 无头加载时自动 require engine.js 并注入 globalThis）。
   行为与 铭刻前线.v1.html.bak 的 AI 流程逐行为等价
   （aiNeedBlood 保留未来难度档位参数位，当前无外部调用）。
   ============================================================ */

/* ---------- Node 无头加载兼容 ---------- */
if (typeof module !== 'undefined' && typeof require === 'function') {
  Object.assign(globalThis, require('./engine.js'));
}
/* 浏览器下靠全局变量；Node 下需把本文件函数发布到 globalThis，
   引擎 startAiTurn 以裸标识符调用 aiChoosePlay/aiAttackTarget。 */
if (typeof module !== 'undefined') {
  Object.assign(globalThis, { aiChoosePlay, aiAttackTarget, aiPickOrderTarget, aiFindSlot, aiNeedBlood, aiLethalPlan, aiPlayRemoval, aiRefreshIntel, aiIntel });
}

/* ---------- AI 难度档位（v2 预留；默认 'veteran' = 现有行为完全等价） ----------
   'recruit'  新兵：每决策点 20% 概率执行失误模板（乱打目标/乱部署/不出指令/不布反制）
   'veteran'  老练：现有行为（基线）
   'warder'   老牧师：先布反制再出手（'watchman' 为别名，兼容 captain 契约命名）
   'marshal'  元帅：老牧师之上——保关键单位（最强单位优先出场、不当祭品）+ 拖血线（不做亏本交换）
              + 最优顺序斩杀（模拟指令→单位坠落，不留机会）。c7 专属，'general' 为别名。
   切换接口：setAI_DIFFICULTY(d)；读取：全局 AI_DIFFICULTY（浏览器/Node 均可用）。 */
let AI_DIFFICULTY = 'veteran';
function setAI_DIFFICULTY(d){
  if(d === 'watchman') d = 'warder';
  if(d === 'general') d = 'marshal';
  if(['recruit','veteran','warder','marshal'].includes(d)){
    AI_DIFFICULTY = d;
    if(typeof globalThis !== 'undefined') globalThis.AI_DIFFICULTY = d; // 与浏览器/其他模块可见性一致
  }
}
const aiMistake = () => AI_DIFFICULTY === 'recruit' && Math.random() < 0.2;
const aiIsMarshal = () => AI_DIFFICULTY === 'marshal';

/* ============================================================
   元帅 · 战术中央（c7 专属翻倍强化）
   ------------------------------------------------------------
   aiRefreshIntel()：每回合开始时评估一次棋盘，得出本回合战术结论。
   评估维度：
     · myDmg  我方当前回合对玩家 HQ 的理论最大伤害（可行动单位攻击之和 + 手牌直击 HQ 指令）
     · thrP   玩家下回合对我方 HQ 的理论最大威胁（玩家可行动单位攻击之和 + 手牌估算）
     · 结论级别：
         KILL    —— myDmg ≥ 玩家血：应立刻执行斩杀（配合引擎 aiLethalPlan 截获）
         DEFEND  —— thrP ≥ 我血：全面防御（解场拆威胁 > 铺墙 > 不打 HQ 换血）
         GUARD   —— thrP ≥ 我血 - 4：半防御（优先杀高威胁目标，能不亏就不亏）
         NORMAL  —— 其余：维持进攻，但加「击杀高威胁优先于磨 HQ」的取舍判断
   整回合缓存（turnIntel），由 startAiTurn 入口在摸牌后调用一次刷新。
   ============================================================ */
const HQ_DIRECT = { airStrike:3, bismarck:8, tirpitz:4, gunboat:2, bombRaid:3, winterWar:1, winterOffensive:4 };
let turnIntel = null;   // { level, myDmg, thrP } 缓存本回合战术结论
/* 引擎函数全局解析（浏览器=裸标识符；Node 无头=globalThis） */
const _eng = (name, fb) => {
  try {
    if (typeof globalThis !== 'undefined' && globalThis[name]) return globalThis[name];
  } catch(e){}
  return fb;
};
const _atkOfG = _eng('atkOf', u => u ? u.atk : 0);
const _canActG = _eng('canAct', () => false);
const _attackTargetsG = _eng('attackTargets', () => []);
function aiRefreshIntel(){
  if(!aiIsMarshal()){ turnIntel = null; return null; }
  const foe = S.p, me = S.a;
  const canActF = (typeof canAct === 'function') ? canAct : _canActG;
  const atkF = (typeof atkOf === 'function') ? atkOf : _atkOfG;
  const atkTargetF = (typeof attackTargets === 'function') ? attackTargets : _attackTargetsG;
  /* 我方本回合总伤害：可行动单位（能直击 HQ 的才算进有效输出 + 手牌指令） */
  let myDmg = 0;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner!=='a' || !canActF(u)) continue;
    if(atkTargetF('a', r, c).some(t=>t.hq)){
      const atk = atkF(u);
      myDmg += atk * ((u.def.sig||[]).includes('fight') ? 2 : 1);  // 奋战双刀
    }
  }
  for(const c of me.hand){
    if(c.kind==='order' && HQ_DIRECT[c.eff]) myDmg += HQ_DIRECT[c.eff];
  }
  /* 玩家下回合威胁：玩家可行动单位攻击之和（玩家单位攻击我方 HQ 的最大理论值） */
  let thrP = 0;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner!=='p') continue;
    const atk = atkF(u);
    thrP += atk * ((u.def.sig||[]).includes('fight') ? 2 : 1);
  }
  /* 玩家手牌威胁估算：只看玩家手牌数（指挥官费牌概率），不读具体牌（不做读牌外挂级别） */
  thrP += Math.floor(S.p.hand.length / 3);   // 约每 3 手牌按 1 点威胁估算
  let level = 'NORMAL';
  if(myDmg >= foe.hp) level = 'KILL';
  else if(thrP >= me.hp) level = 'DEFEND';        // 玩家理论输出 ≥ 我 HQ 血：必死局，全面防御
  else if(thrP >= me.hp - 6) level = 'GUARD';     // 威胁逼近残血线：半防御（拆威胁 > 磨血）
  turnIntel = { level, myDmg, thrP };
  return turnIntel;
}
function aiIntel(){ return turnIntel; }

/* 元帅威胁评分：玩家单位对我的综合威胁（攻血+类型，炮兵/轰炸机/战斗机加权） */
function aiThreatOf(u){
  const typeW = { artillery:4, bomber:3, fighter:2, tank:1, infantry:0 }[u.def.t] || 0;
  const atkF = (typeof atkOf === 'function') ? atkOf : _atkOfG;
  return atkF(u)*3 + u.hp + typeW;
}

function aiNeedBlood(){ return S.a.hand.some(c => c.kind==='unit' && playCost(S.a, c) > S.a.kredit && emptyBacklineSlot('a') !== null); }
function aiFindSlot(card){
  // 新兵失误：20% 随机空槽（乱部署）
  if(aiMistake()){
    const free = [];
    for(let c=0;c<COLS;c++) if(!S.board[0][c]) free.push(c);
    if(free.length) return {row:0, col:free[Math.floor(Math.random()*free.length)]};
  }
  for(let c=0;c<COLS;c++) if(!S.board[0][c]) return {row:0, col:c}; return null;
}
/* ===== 口径裁定（用户 2026-09-13）· target:'any' 改判后的 AI 目标优先级 =====
   cards.js 把「卡面只写 1 个目标 / 1 个单位」的增益牌从 friendly-* 改判为 'any'
   （口径：这类增益也能指向敌方）。改判后 orderTargets 对 'any' 返回**双方**单位，
   若沿用下面「非 friendly 前缀 = 打敌方」的老分支，AI 会把自己的增益/修复打在玩家单位上。
   故按卡牌标识把受影响的目标型卡分三类（新卡 eff=id=卡名，三个字段都试，兼容任一写法）： */
/* ① 增益 / 修复类：候选**只取己方单位**；己方没有合法目标 → 返回 null（本回合不打这张牌）。
      有意不做「己方没有就退到敌方」：这类卡贴给对面是纯亏（帝国指令 = 给对面奶满血 + 加身材），
      用户口径允许玩家手动这么打，但 AI 不主动亏 —— 这也正是本批要防的「增益打在玩家单位上」。
   注：'威尔士卫队' / '舍伍德森林人团' 是**单位**（指向走部署 applyDeploy，不进本函数），
      登记在此只为兜底与表意；engine 对「无预选」的单位部署已有随机己方兜底。 */
const AI_BUFF_ANY = new Set(['帝国指令','新式战法','坚决守护','袋鼠运输','空投补给','最光辉的时刻',
                             '陆军工程兵团','威尔士卫队','我们能做到！','爱国热忱','最后一击','深沟固垒']);
/* ② 指向对手做减法：优先对手的合法目标，对手侧为空时才退到自己人（防空弹幕：撤 1 个空军）。
   有意**不含**舍伍德森林人团：引擎语义是「本体留场 + 复制进**其所有者**卡组顶」，
   指对手 = 白送对面一张牌（engine.js 的自动结算也因此只随机己方单位）—— 见报告「发现但未动手」。 */
const AI_FOE_FIRST_ANY = new Set(['防空弹幕']);
/* ③ 其余 any（两难困境 / 消耗战 / 防火墙 / 胁迫 / 夜间轰炸…）：保持原逻辑（打敌方），不登记即走老分支。
      注：防火墙/消耗战是「给敌方上负面」，老分支选敌方本来就对。 */
/* ①/② 的合法目标类型：这些卡 target 已改判 'any' → orderTargets 不再按类型过滤，指错＝白打一张牌 */
const _aiHasSig = _eng('hasSig', (u, s) => !!(u && u.def && (u.def.sig || []).indexOf(s) >= 0));
const _aiIsTank = _eng('isTankUnit', u => !!(u && u.def && (u.def.t === 'tank' || (u.def.fx || []).indexOf('alsoTank') >= 0)));
const AI_ANY_LEGAL = {
  '陆军工程兵团': u => u.def.t === 'tank' || u.def.t === 'infantry',
  '空投补给':     u => _aiIsTank(u) || u.def.t === 'infantry',
  '袋鼠运输':     u => u.def.t === 'infantry' && u.def.nation === 'gb',
  '坚决守护':     u => _aiHasSig(u, 'guard'),
  '深沟固垒':     u => _aiHasSig(u, 'guard'),
  '最光辉的时刻': u => u.def.t === 'fighter' || u.def.t === 'bomber',
  '防空弹幕':     u => u.def.t === 'fighter' || u.def.t === 'bomber'
};
function aiAnyBucket(card){
  if(!card) return '';
  const keys = [card.eff, card.id, card.n];
  for(let i=0;i<keys.length;i++){
    if(keys[i] && AI_BUFF_ANY.has(keys[i])) return 'buff';
    if(keys[i] && AI_FOE_FIRST_ANY.has(keys[i])) return 'foeFirst';
  }
  return '';
}
function aiAnyLegalKey(card){
  if(!card) return '';
  const keys = [card.eff, card.id, card.n];
  for(let i=0;i<keys.length;i++) if(keys[i] && AI_ANY_LEGAL[keys[i]]) return keys[i];
  return '';
}
function aiPickOrderTarget(card, targets){
  // 友方指向：'friendly*' 前缀（含新增的 'friendly-any' 双面卡）；
  // 兼容：老卡里"目标写 any、实际是友方贴膜"的几张（白名单，保持原行为）
  const FRIENDLY_ANY = new Set(['forFreedom','quinine','motivate','coopOp','armorWedge','navalSupport','powerSurge']);
  const bucket = aiAnyBucket(card);                 // ① 'buff'（只认己方）/ ② 'foeFirst'（优先对手）/ ③ ''
  const lkey = aiAnyLegalKey(card);
  const legalU = lkey ? AI_ANY_LEGAL[lkey] : null;  // 类型预过滤（未登记 = 不过滤，老卡照旧）
  const friendly = (card.target || '').indexOf('friendly') === 0 || FRIENDLY_ANY.has(card.eff) || bucket === 'buff';
  // 友方增益（贴膜卡）：候选=己方单位；敌方/任意目标：候选=敌方单位（AI 绝不自伤/不打自己人）
  const pickU = t => !t.hq && t.u && (!legalU || legalU(t.u));
  let units = targets.filter(t => pickU(t) && (friendly ? t.u.owner === 'a' : t.u.owner !== 'a'));
  // ② 类（撤对手）：对手侧没有合法目标时才退到自己人 —— 用户口径「防空弹幕可以撤友军」
  if(!units.length && bucket === 'foeFirst') units = targets.filter(t => pickU(t) && t.u.owner === 'a');
  if(!units.length){
    const hq = friendly ? null : targets.find(t=>t.hq); // 总部选项仅敌方指向可用
    return hq || null;
  }
  if(friendly){
    // 海军支援：只贴攻<防的单位，差得越多越值得
    if(card.eff === 'navalSupport'){
      const cands = units.filter(t=>t.u.atk < t.u.hp);
      if(!cands.length) return null;
      return cands.slice().sort((x,y)=> (y.u.hp-y.u.atk) - (x.u.hp-x.u.atk))[0];
    }
    // 火力爆发：只能给友方战斗机；本回合还能行动的优先
    if(card.eff === 'powerSurge'){
      const cands = units.filter(t => t.u.def.t === 'fighter');
      if(!cands.length) return null;
      const act = cands.filter(t => canAct(t.u));
      if(act.length) return act.slice().sort((a,b)=> (b.u.atk||0) - (a.u.atk||0))[0];
      return cands.slice().sort((a,b)=> (b.u.atk||0) - (a.u.atk||0))[0];
    }
    // 帝国指令（完全修复 1 个单位 + 1/+1）：先修最残的己方单位（修复量优先，攻击力次之）——【新增】
    if(lkey === '帝国指令'){
      const miss = t => ((t.u.maxHp != null ? t.u.maxHp : t.u.hp) - t.u.hp);
      return units.slice().sort((a,b)=> (miss(b) - miss(a)) || ((b.u.atk||0) - (a.u.atk||0)))[0];
    }
    // 贴膜目标：攻高者优先（增益吃到攻击力上）——【新增】
    return units.slice().sort((a,b)=> (b.u.atk||0) - (a.u.atk||0))[0];
  }
  // 伤害量：老表 + §2 的 AI_ORDER_DMG（新卡补点）——【新增：Object.assign 合并】
  const dmg = Object.assign({fromPeople:3, burningSky:4, bloodSickle:1, bombRaid:3, gunboat:2, desertRat:1, hammer:6, buzzBomb:1, homeGuard:2},
                            (typeof AI_ORDER_DMG === 'object' ? AI_ORDER_DMG : {}))[card.eff] || 0;
  let pool = units;
  if(dmg > 0){ const killable = units.filter(t=>t.u.hp <= dmg); if(killable.length) pool = killable; }
  pool = pool.slice();
  // 威胁评分：优先击杀炮兵/轰炸机（远程与范围打击威胁最大），其次战斗机
  const threat = t => { const d=t.u; return d.atk*3 + d.hp + ({artillery:4, bomber:3, fighter:2}[d.def.t]||0); };
  pool.sort((a,b)=> threat(b) - threat(a));
  return pool[0];
}

/* ===== 舍伍德森林人团（英·铁 6费1油 5/6 守护，target:'any'）· AI 部署目标口径（用户 2026-09-13）=====
   引擎语义（engine.js applyDeploy '舍伍德森林人团'）：把「1 个单位的复制」放到**其所有者**的卡组顶，
   本体留场（是增殖，不是 bounceTop 那种移回）。所以两个方向都有意义、也都有坑：
     · 复制己方单位 = 自己卡组顶多一张 → 指己方**弱卡** = 白费这次部署效果（用户：不要复制自己的弱卡）；
     · 复制敌方单位 = 给对面卡组顶塞一张、卡住对面下一抽 → 指敌方**强卡** = 白送对面一张好牌（用户：不要复制敌方的强卡）。
   落地：强弱按**花费**判（费用就是这游戏的定价），同档内再用 worth = 花费*2+攻击+血 排序
     · 己方可复制：花费 ≥ 3（3费2/3、5费5/6…；1费2/2、2费2/2 这类小卡不复刻 = 用户说的「自己的弱卡」）
     · 敌方可复制：花费 ≤ 2（只有这种小垃圾塞给对面才划算；3费以上一律不塞 = 用户说的「敌方的强卡」）
   优先级：己方最值钱的可复制单位 → 敌方最不值钱的可复制单位 → 己方场上空场时照常打本体（此时部署效果
   结算时己方只有「舍伍德自己」可被引擎的默认兜底选中，花费 6 完全合规，白赚一张 5/6 守护）→ 仍不满足则不打出（留手等场面变化）。 */
const SHERWOOD_IDS = ['舍伍德森林人团'];
function aiSherwoodCost(u){
  if(!u || !u.def) return 0;
  const d = u.def;
  // 花费字段两套写法都要认：场上传给 makeUnit 的是规范化卡（blood），测试/脚本可能直接塞原始卡（c）
  return (d.blood != null) ? d.blood : (d.c || 0);
}
function aiSherwoodWorth(u){
  if(!u || !u.def) return 0;
  return aiSherwoodCost(u) * 2 + (u.atk || 0) + (u.hp || 0);
}
/* 返回 {need, play, pick}：need=false → 不是这张卡（调用方保持原逻辑）；
   need=true 时 play=false = 本回合不打（留手）；play=true 时 pick=单位对象（预选目标）或 null（交给引擎默认兜底） */
function aiUnitDeployPick(card){
  if(!card) return { need:false, play:false, pick:null };
  const hit = SHERWOOD_IDS.some(k => card.id === k || card.eff === k || card.n === k);
  if(!hit) return { need:false, play:false, pick:null };
  const mine = [], foes = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u) continue;
    (u.owner === 'a' ? mine : foes).push(u);
  }
  const okMine = mine.filter(u => aiSherwoodCost(u) >= 3).sort((x,y)=> aiSherwoodWorth(y) - aiSherwoodWorth(x));
  if(okMine.length) return { need:true, play:true, pick: okMine[0] };            // 复制自己最值钱的（增殖）
  const okFoes = foes.filter(u => aiSherwoodCost(u) <= 2).sort((x,y)=> aiSherwoodWorth(x) - aiSherwoodWorth(y));
  if(okFoes.length) return { need:true, play:true, pick: okFoes[0] };            // 给对面塞最垃圾的（卡对面下一抽）
  if(!mine.length) return { need:true, play:true, pick:null };                   // 己方空场：本体照打，默认兜底只会复制到它自己
  return { need:true, play:false, pick:null };                                  // 两条禁令都踩 → 不打
}

/* ---------- 贴膜增益（AI 优化）：贴膜卡先贴膜，再让被贴膜的单位攻击 ---------- */
const AI_BUFF_EFFS = new Set(['forFreedom','quinine','powerSurge','navalSupport','motivate','coopOp','tea','yamamoto','blazing','blitzKrieg','armorWedge']);
/* 全局贴膜（山本/烈日/红茶/闪电战…）：场上是否有本回合可行动的受益单位 */
function aiBuffCanActBenefit(eff){
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner!=='a' || !canAct(u)) continue;
    if(eff==='yamamoto' || eff==='blazing'){ if(u.def.t==='fighter' || u.def.t==='bomber') return true; }
    else if(eff==='blitzKrieg'){ if(r===1) return true; }
    else if(eff==='tea'){ if(u.def.nation==='gb') return true; }
  }
  return false;
}
/* 攻击前的贴膜阶段：只打能在本回合立刻转化为攻击的增益（目标=本回合可行动单位） */
function aiPlayBuff(){
  const h = S.a.hand;
  for(const c of h){
    if(c.kind!=='order' || !AI_BUFF_EFFS.has(c.eff)) continue;
    if(playCost(S.a, c) > S.a.kredit) continue;
    if(c.target){
      // 海军支援：贴膜阶段只做友方增益——本回合可行动、攻<防者（差值最大优先）
      if(c.eff === 'navalSupport'){
        let best = null, bgap = -1;
        for(let r=0;r<ROWS;r++) for(let cc=0;cc<COLS;cc++){
          const x = S.board[r][cc];
          if(!x || x.owner!=='a' || !canAct(x) || x.atk >= x.hp) continue;
          const gap = x.hp - x.atk;
          if(gap > bgap){ bgap = gap; best = {row:r, col:cc}; }
        }
        if(best) return {kind:'order', card:c, tgt:best};
        continue;
      }
      const tgts = orderTargets(c, 'a');
      if(!tgts.length) continue;
      const t = aiPickOrderTarget(c, tgts);
      if(!t || t.hq) continue;
      const tu = unitAt(t.row, t.col);
      // 贴膜目标本回合必须还能行动：贴完膜立刻轮到攻击阶段
      if(tu && tu.owner==='a' && canAct(tu)) return {kind:'order', card:c, tgt:{row:t.row, col:t.col}};
      continue;
    }
    if(aiBuffCanActBenefit(c.eff)) return {kind:'order', card:c};
  }
  return null;
}
/* 解场指令集合：消灭/伤害敌方单位的指令（优先级高于场上攻击与发育，低于致死打击） */
const AI_REMOVAL_EFFS = new Set(['missouri','killEnemy','deathFromAbove','amphibious','hammer','fromPeople','burningSky','desertRat','montgomery','bombRaid','gunboat','carpetBomb','eagleClaw','wolfPack','precisionBomb','eject','stratBomb','suppressOne','homeGuard','dustStorm','climax','frontObserver','monsoon']);
/* 解场阶段：生产牌 → 利奥波德（部署清场，优先）→ 解场指令（有合法目标才打） */
function aiPlayRemoval(){
  const h = S.a.hand;
  for(const c of h){
    if(c.kind==='order' && c.eff==='produce') return {kind:'order', card:c};
  }
  if(!deployBlocked('a')){
    for(const c of h){
      if(c.kind==='unit' && c.id==='leopold' && playCost(S.a, c) <= S.a.kredit){
        const slot = aiFindSlot(c);
        if(slot) return {kind:'unit', card:c, slot};
      }
    }
  }
  for(const c of h){
    if(c.kind!=='order' || !AI_REMOVAL_EFFS.has(c.eff)) continue;
    if(playCost(S.a, c) > S.a.kredit) continue;
    if(c.target){
      const tgts = orderTargets(c, 'a');
      if(!tgts.length) continue;
      if(c.eff === 'missouri'){
        const front = tgts.filter(t=>!t.hq);
        if(!front.length) continue;
        front.sort((x,y)=> (unitAt(y.row,y.col).atk||0) - (unitAt(x.row,x.col).atk||0));
        return {kind:'order', card:c, tgt:{row:front[0].row, col:front[0].col}};
      }
      const t = aiPickOrderTarget(c, tgts);
      if(t) return {kind:'order', card:c, tgt: t.hq ? {hq:true} : {row:t.row, col:t.col}};
      continue;
    }
    if(['carpetBomb','eagleClaw','stratBomb','climax','frontObserver','monsoon'].includes(c.eff) && countEnemy('a')>0) return {kind:'order', card:c};
  }
  return null;
}
/* ===== 新卡接线（2026-09 批次）· §2 条件表 + 已知伤害表 ===== */
/* 注：原「§1 通用兜底 aiOrderFallback()」已于 2026-09-13 清理删除——全工程没有调用点，
   指令兜底统一走 aiChoosePlay 里的 AI_ORDER_COND 条件表 + 逐卡分支。 */
/* 有前置条件的指令：返回 false = 现在不打 */
const AI_ORDER_COND = {
  /* ---- 引擎已实现、但当前不在任何名单里的 6 条（立刻受益）---- */
  routCheap:      () => countEnemy('a') > 0,                        // 溃敌：需要敌方单位当目标
  bloodSickle:    () => countEnemy('a') > 0,                        // 血红镰刀：同上
  rampage:        () => countEnemy('a') > 0,                        // 猛袭：只打敌方步兵
  diplomat:       () => S.p.hand.length > 0,                        // 外交专员
  honorLoyalty:   () => countEnemy('a') > 0,                        // 荣誉与忠诚：需要目标
  /* ---- 研发链入口（起手加牌，随时可打）---- */
  '德意志帝国研发': () => true,
  '帝国研发':      () => true,
  '苏联军事研发':  () => true,
  '美国军事研发':  () => true,
  '皇家研发':      () => true,
  /* ---- 新指令里有前置条件的（按 batch 效果文本归纳）---- */
  'hqCap':         () => S.a.hp <= S.p.hp,                           // 国家消防局是反制（eff=hqCap），留键仅为一致性
  '防空弹幕':      () => countEnemy('a') > 0,
  '停飞':          () => countEnemy('a') > 0,
  '炮击':          () => countEnemy('a') > 0,
  '消耗战':        () => countEnemy('a') > 0,
  '黑夜巡视':      () => countEnemy('a') > 0,
  '战时美利坚':    () => countEnemy('a') > 0,
  '星条旗':        () => countEnemy('a') > 0,
  '我们能做到！':  () => allyList('a').length > 0,
  '同盟国':        () => allyList('a').length > 0,
  '掩护部队':      () => allyList('a').length > 0,
  '爱国热忱':      () => allyList('a').length > 0,
  '陆军工程兵团':  () => countEnemy('a') > 0 || allyList('a').length > 0,
  '战略规划':      () => S.a.kreditSlots >= 8,
  '俯冲轰炸':      () => countEnemy('a') > 0,
  '转变攻击':      () => allyList('a').length > 0,
  '第二战线':      () => allyList('a').length > 0,
  '交叉火力':      () => countEnemy('a') >= 1,
  '斩草除根':      () => true,                                       // 双方单位都 -1-2：近似为"随便打"
  '大混战':        () => countEnemy('a') > allyList('a').length,      // 只杀非老兵：敌方更多才划算
  '背水一战':      () => S.a.hp <= S.p.hp,
  '最后一击':      () => allyList('a').length > 0,
  '暴风雪':        () => countEnemy('a') > 0,
  '焦土政策':      () => countEnemy('a') >= 1,
  '以剑之名':      () => countEnemy('a') > 0,
  '胜利旗帜':      () => allyList('a').length > 0 && countEnemy('a') > 0,
  '两难困境':      () => allyList('a').length > 0,
  '坚决守护':      () => allyList('a').length > 0,
  '袋鼠运输':      () => allyList('a').length > 0,
  '观察团':        () => countEnemy('a') > 0,
  '战术撤退':      () => allyList('a').length > 0 && S.a.hp <= S.p.hp,
  '妇女预备队':    () => S.a.deck.length > 0,
  '为了国王':      () => allyList('a').length > 0,
  '咬紧牙关':      () => S.a.hp <= S.p.hp,
  '拖延战术':      () => S.a.hp <= S.p.hp,
  '深沟固垒':      () => allyList('a').length > 0,
  '空投补给':      () => S.a.hand.length <= 6,
  '最光辉的时刻':  () => allyList('a').length > 0,
  'HMS光辉号':     () => allyList('a').some(t => t.u.def.t === 'fighter' || t.u.def.t === 'bomber'),
  'HMS塔尔伯特':   () => allyList('a').length > 0,
  '军情五处':      () => S.p.hand.length > 0,
  '渗透':          () => S.p.hand.some(c => c && c.revealed),
  '突击队突击':    () => allyList('a').length > 0,
  '参谋长联席会议': () => S.a.hand.length <= 7,
  'HMS竞技神号':   () => allyList('a').length > 0,
  '合作关系':      () => allyList('a').length > 0,
  '战时盟国':      () => countEnemy('a') > 0,
  '租借法案':      () => S.a.hand.length <= 7,
  '统治吧！不列颠尼亚！': () => allyList('a').length >= 2,
  '调整':          () => S.a.hand.length >= 3,
  '帝国指令':      () => true,
  '扩张':          () => allyList('a').length > 0,
  '新式战法':      () => allyList('a').some(t => t.u.def.t === 'infantry' || t.u.def.t === 'tank'),
  '极限使命':      () => allyList('a').length > 0,
  '责无旁贷':      () => allyList('a').length > 0,
  '为了天皇':      () => allyList('a').length > 0,
  '穷兵黩武':      () => countEnemy('a') > 0,
  '最后的仪式':    () => countEnemy('a') > 0,
  '枪林弹雨':      () => countEnemy('a') > 0,
  '玉碎':          () => allyList('a').length > 0,
  '指挥不当':      () => countEnemy('a') > 0,
  '侦察队':        () => S.a.deck.length > 0,
  '暴风雨前的宁静': () => countEnemy('a') > 0,
  /* ---- 研发链衍生指令（选哪张由引擎 aiResearchPick 决定，这里只管"打不打"）---- */
  'V-1飞行炸弹':   () => countEnemy('a') > 0,
  '合成机油':      () => true,
  'XXⅪ级U型潜艇': () => countEnemy('a') > 0,
  '铀工程':        () => countEnemy('a') >= 1,
  '神风特攻队':    () => countEnemy('a') > 0,
  '氧气鱼雷':      () => countEnemy('a') > 0,
  '皇国二号兵器':  () => countEnemy('a') > 0,
  '气球炸弹':      () => countEnemy('a') > 0,
  '7075铝':        () => true,
  '加压舱':        () => countEnemy('a') > 0,
  '深水炸弹':      () => countEnemy('a') > 0,
  '青霉素':        () => S.a.hp < S.a.maxHp,
  '曼哈顿计划':    () => countEnemy('a') > 0,
  '倾斜装甲':      () => countEnemy('a') > 0,
  '标准弹药':      () => allyList('a').length > 0,
  '气动雪橇':      () => countEnemy('a') > 0,
  '斯大林管风琴':  () => countEnemy('a') > 0,
  '合成橡胶':      () => allyList('a').length > 0,
  '雷达':          () => true,
  '主动声呐':      () => true,
  '布莱切利庄园':  () => S.a.deck.length > 0,
  /* ---- 【集成补充·非补丁原文】老分支里"带条件"的指令（约 60 条）----
     为什么必须补：§3 的通用兜底在指令循环体末尾，条件表没登记的 eff 一律放行；
     而老分支是"条件成立才 return"，条件不成立时会落到兜底 → 老条件被绕过。
     实测（A/B 逐张比对备份 ai.js）有 35 张老卡因此改变行为，例如
     「最后一搏/至死方休」在槽位不足、己方单位更多时照打，「泥泞季」在无敌方单位时照打（纯自伤），
     「茶/山本五十六/烈日」在没有受益单位时空烧指挥点。
     这里**逐行复刻**老分支的条件（键是 eff，不是卡 id）→ 老卡行为与集成前 100% 一致
     （复刻后重跑 A/B：老卡差异 0 条）。恒真条件（fortify/attackColony）不再登记。
     ★ 若日后引擎重写某张老卡的分支，请同步此表，否则条件仍按这里判定。 */
  deathFromAbove: () => countEnemy('a') > 0,                                     // L316 老分支
  mudSeason:      () => countEnemy('a') > 0,                                     // L319
  yamamoto:       () => allyList('a').some(t => t.u.def.t === 'fighter' || t.u.def.t === 'bomber'),  // L323
  tea:            () => allyList('a').some(t => t.u.def.nation === 'gb'),        // L325
  winterWar:      () => S.p.hp >= S.a.hp,                                        // L327
  winterOffensive:() => S.p.hp >= S.a.hp,                                        // L327
  convoy:         () => S.a.hand.length <= 6,                                    // L335
  plan:           () => S.a.hand.length <= 5,                                    // L337
  landGirl:       () => S.a.hand.length <= 5,                                    // L337
  wipeAll:        () => countEnemy('a') > allyList('a').length && S.a.kreditSlots >= 7,  // L339
  lastPush:       () => countEnemy('a') > allyList('a').length && S.a.kreditSlots >= 7,  // L339
  carrierGroup:   () => allyList('a').some(t => t.u.def.t === 'fighter' || t.u.def.t === 'bomber'),  // L340
  carrierCover:   () => allyList('a').some(t => t.u.def.t === 'fighter'),        // L341
  blazing:        () => allyList('a').some(t => t.u.def.t === 'fighter' || t.u.def.t === 'bomber'),  // L343
  draw2:          () => S.a.hand.length <= 4,                                    // L344
  shortage:       () => countEnemy('a') >= 2,                                    // L346
  blitzKrieg:     () => allyList('a').some(t => t.r === 1),                      // L360
  /* 战略重心：老分支是整段局势计算，这里原样复刻（领先度 < 0 且该类型净收益 ≥ 0 才打） */
  strategicFocus: () => {
    if(!(countEnemy('a') > 0)) return false;
    let aArmy = 0, aAir = 0, pArmy = 0, pAir = 0, pPow = 0, aPow = 0;
    for(let r=0;r<ROWS;r++) for(let cc=0;cc<COLS;cc++){
      const x = S.board[r][cc];
      if(!x) continue;
      const pow = atkOf(x) + x.hp;
      if(x.owner === 'p'){ pPow += pow; if(x.def.t==='infantry'||x.def.t==='tank'||x.def.t==='artillery') pArmy++; else if(x.def.t==='fighter'||x.def.t==='bomber') pAir++; }
      else { aPow += pow; if(x.def.t==='infantry'||x.def.t==='tank'||x.def.t==='artillery') aArmy++; else if(x.def.t==='fighter'||x.def.t==='bomber') aAir++; }
    }
    const lead = (S.a.hp - S.p.hp) + (aPow - pPow);
    const armyEdge = pArmy - aArmy, airEdge = pAir - aAir;
    return lead < 0 && Math.max(armyEdge, airEdge) >= 0;
  },
  reserve:        () => S.a.hand.length < 7,                                     // L380
  deepOp:         () => S.a.hand.length < 7,                                     // L380
  frontalAssault: () => S.a.hand.length < 7,                                     // L380
  enigma:         () => S.a.hand.length < S.p.hand.length,                       // L382
  buzzBomb:       () => countEnemy('a') > 0,                                     // L384
  tora:           () => countEnemy('a') > 0,                                     // L384
  lastResort:     () => countEnemy('a') > 0,                                     // L385
  warNavy:        () => S.p.hand.length >= 1,                                    // L389
  commonwealth:   () => S.a.maxHp >= 30,                                         // L391
  totalWar:       () => allyList('a').some(t=>t.u.def.t==='fighter'||t.u.def.t==='bomber') || S.a.hand.some(cd=>cd && cd.kind==='unit' && (cd.t==='fighter'||cd.t==='bomber')) || S.a.deck.some(cd=>cd && cd.kind==='unit' && (cd.t==='fighter'||cd.t==='bomber')),  // L393
  lastJourney:    () => S.a.deck.some((cd,i)=> i>=S.a.deck.length-4 && cd && cd.kind==='unit' && (cd.t==='fighter'||cd.t==='bomber')),  // L395
  highBomb:       () => countEnemy('a') > 0,                                     // L398
  nightBomb:      () => countEnemy('a') > 0,                                     // L398
  coerce:         () => countEnemy('a') > 0,                                     // L398
  massRout:       () => countEnemy('a') > 0,                                     // L398
  navalBattle:    () => countEnemy('a') > 0,                                     // L398
  ironOre:        () => allyList('a').some(t => t.r === 1),                      // L401
  guderian:       () => allyList('a').some(t => t.r === 1 && t.u.def.t === 'tank' && t.u.def.nation === 'de'),  // L403
  inhibitOne:     () => countEnemy('a') > 0,                                     // L405
  sneakAttack:    () => countEnemy('a') > 0,                                     // L405
  directStrike:   () => countEnemy('a') > 0,                                     // L405
  exploitGain:    () => allyList('a').some(t=>t.r===1) && S.a.deck.some(cd=>cd && cd.kind==='unit'),  // L407
  alpineFort:     () => S.a.hp <= S.p.hp,                                        // L409
  islandDef:      () => S.a.hp <= S.p.hp,                                        // L409
  weighOptions:   () => S.a.hand.length <= 6,                                    // L413
  harshWinter:    () => countEnemy('a') >= 2,                                    // L415
  dayBomb:        () => countEnemy('a') > 0,                                     // L417
  longRange:      () => countEnemy('a') > 0,                                     // L417
  hakkoIchiu:     () => S.a.hand.length <= 7,                                    // L419
  steelPact:      () => S.a.hand.length <= 7,                                    // L421
  colonialDream:  () => S.a.hand.length <= 7,                                    // L421
  punish:         () => S.p.hand.length > 0,                                     // L425
  deepDefense:    () => countEnemy('a') > 0,                                     // L431
  saarOffensive:  () => countEnemy('a') > 0,                                     // L431
  lorraine:       () => countEnemy('a') > 0,                                     // L431
  ruinHand:       () => countEnemy('a') > 0,                                     // L431
  maginot:        () => allyList('a').some(t => ['infantry','tank','artillery'].includes(t.u.def.t)),  // L432
  molotov:        () => countEnemy('a') > 0,                                     // L434
  whiteDeath:     () => countEnemy('a') > 0,                                     // L434
  freeze:         () => allyList('a').length > 0,                                // L435
  longSiege:      () => S.a.hand.length <= 6,                                    // L436
  lionOfDay:      () => countEnemy('a') > 0,                                     // L439
  /* 老分支在 aiPlayRemoval 里的条件（无目标型：有敌方单位才值得清场） */
  stratBomb:      () => countEnemy('a') > 0,
  climax:         () => countEnemy('a') > 0,
  frontObserver:  () => countEnemy('a') > 0,
  monsoon:        () => countEnemy('a') > 0
};
/* 已知伤害点数的指令（供挑选"能一击打死"的目标；量纲=点伤害） */
const AI_ORDER_DMG = {
  gunboat: 2, bombRaid: 3, airStrike: 3, hammer: 6, fromPeople: 3, burningSky: 4,
  bloodSickle: 1, desertRat: 1, buzzBomb: 1, homeGuard: 2, dayBomb: 2, longRange: 2,
  '炮击': 3, '交叉火力': 1, '俯冲轰炸': 1, '枪林弹雨': 1, '消耗战': 2,
  'V-1飞行炸弹': 3, '氧气鱼雷': 3, '深水炸弹': 3, '曼哈顿计划': 6, '气动雪橇': 2
};
function aiOrderAllowed(eff){
  const f = AI_ORDER_COND[eff];
  if(!f) return true;                              // 未登记 = 无条件可打（新卡默认放行）
  try { return !!f(); } catch(e){ return true; }    // 判定出错时不拦（保守放行）
}
/* ---------- 最终 Boss「hana」的科技树出牌优先级（用户 2026-09-16） ----------
   研发系判定：牌上有 engine 打的 research 标记（研发所得）、或卡名/id 含「研发」（链上本体）、
   或描述以「抉择」开头（扩展/高级研发）。出手顺序：研发链本体（3→6→9 费）优先，其次衍生牌。
   付不起 / 无合法目标 / 无空槽 → 返回 null，让常规 AI 逻辑接手。 */
function aiPickResearchPlay(hand){
  const fam = c => !!c && (c.research === true || /研发/.test(String(c.id || '')) || /抉择/.test(String(c.desc || '')));
  const rank = c => /研发/.test(String(c.id || '')) ? 0 : 1;
  const cands = (hand || []).filter(c => fam(c) && playCost(S.a, c) <= S.a.kredit);
  if(!cands.length) return null;
  cands.sort((a, b) => (rank(a) - rank(b)) || ((b.blood || 0) - (a.blood || 0)));   // 先链上本体，再高费的衍生牌
  for(const c of cands){
    if(c.kind === 'unit'){
      const slot = aiFindSlot(c);
      if(!slot) continue;
      const dp = aiUnitDeployPick(c);
      if(dp.need && !dp.play) continue;
      return { kind:'unit', card:c, slot, pick: dp.need ? (dp.pick || null) : null };
    }
    if(c.kind === 'order'){
      if(c.target){
        const tgts = orderTargets(c, 'a');
        if(!tgts.length) continue;
        const t = aiPickOrderTarget(c, tgts);
        if(!t) continue;
        return { kind:'order', card:c, tgt: t.hq ? { hq:true } : { row:t.row, col:t.col } };
      }
      return { kind:'order', card:c };
    }
  }
  return null;
}
function aiChoosePlay(skip){  const h = S.a.hand, foe = S.p;
  const mis = aiMistake();
  const intel = turnIntel || { level: 'NORMAL' };
  const defending = intel.level === 'DEFEND' || intel.level === 'GUARD';
  // 生产卡：0 费白赚指挥点，优先打出（任何档位都不受失误影响）
  for(const c of h){
    if(c.kind==='order' && c.eff==='produce') return {kind:'order', card:c};
  }
  /* 最终 Boss「hana」：优先走科技树（用户 2026-09-16：「优先使用手上的研发及其衍生牌，减少对玩家的压力」）
     —— 手上有「研发」本体或它衍生出来的牌（engine 加牌时打了 research 标记）就先出它们，
     把指挥点花在科技树上，而不是一上来就铺场压玩家。 */
  if(S.bossKind === 'hana'){
    const r = aiPickResearchPlay(h);
    if(r) return r;
  }
  // 元帅战术中央：非 KILL 状态下，先看防御解场 —— 玩家有大威胁单位时优先拆，而非盲目铺场
  if(aiIsMarshal() && defending && !mis && S.a.kredit >= 1){
    const removal = aiPlayRemoval();
    if(removal) return removal;
  }
  // 老牧师：先布反制再出手（T4 语义；老练/新兵：反制最后）
  if(!mis && AI_DIFFICULTY === 'warder' && S.a.kredit >= 1){
    for(const c of h){
      if(c.kind==='counter' && (c.blood||0) <= S.a.kredit) return {kind:'counter', card:c};
    }
  }
  // 先部署单位（性价比；不设铺场门槛——后期也持续出牌，避免卡手）
  const depBlocked = deployBlocked('a'); // 提尔皮茨部署封锁：本回合不能部署单位
  const pwr = c => (c.atk||0)*2 + (c.hp||0) + ((c.sig||[]).includes('guard')?4:0) + ((c.sig||[]).includes('blitz')?2:0) - (c.blood||0)*2;
  let best=null, bs=-Infinity;   // 门槛从 -1 改为 -∞：否则 pwr*0.7 为负的「贵而身材一般」的单位（如 45英寸中型火炮 -2.1、92英寸岸防炮/Ki-49 -1.4）永远选不中，AI 会把手牌攥到死
  // 元帅防御态：铺墙权重——守护/高血单位优先（挡玩家冲锋），攻击力权重削弱
  const defWeight = c => (defending ? ((c.sig||[]).includes('guard') ? 10 : 0) + (c.hp||0)*0.8 : 0);
  for(const c of h){
    if(c.kind!=='unit') continue;
    if(depBlocked) break; // 部署被封锁：不出单位
    if(playCost(S.a, c) > S.a.kredit) continue;
    const slot = aiFindSlot(c);
    if(!slot) continue;
    // 舍伍德森林人团：预选目标（用户口径见 aiUnitDeployPick）；没有合规目标 → 本回合不打这张
    const dp = aiUnitDeployPick(c);
    if(dp.need && !dp.play) continue;
    const s = pwr(c)*0.7 + defWeight(c);   // 防御态略削攻性、加防性
    if(s > bs){ bs=s; best={kind:'unit', card:c, slot, pick: dp.need ? (dp.pick || null) : null}; }
  }
  if(best) return best;
  // 指令（新兵失误：不出指令）
  if(!mis) for(const c of h){
    if(c.kind!=='order') continue;
    if(skip && skip.has(c.eff)) continue; // 跳过已优先处理的解场指令
    if(playCost(S.a, c) > S.a.kredit) continue;
    if(c.target){
      // 指向型指令：无合法目标则无法打出（跳过）
      const tgts = orderTargets(c, 'a');
      if(!tgts.length) continue;
      // 密苏里号：优先选敌方前线攻击力最高的单位
      if(c.eff === 'missouri'){
        const front = tgts.filter(t=>!t.hq);
        if(!front.length) continue;
        front.sort((x,y)=> (unitAt(y.row,y.col).atk||0) - (unitAt(x.row,x.col).atk||0));
        return {kind:'order', card:c, tgt:{row:front[0].row, col:front[0].col}};
      }
      // 海军支援（可指任意单位）：优先友方攻<防（提攻）；其次敌方攻>防（削攻）
      if(c.eff === 'navalSupport'){
        const buffs = tgts.filter(t=>!t.hq && t.u.owner==='a' && t.u.atk < t.u.hp);
        if(buffs.length){ buffs.sort((x,y)=> (y.u.hp-y.u.atk) - (x.u.hp-x.u.atk)); return {kind:'order', card:c, tgt:{row:buffs[0].row, col:buffs[0].col}}; }
        const cuts = tgts.filter(t=>!t.hq && t.u.owner!=='a' && t.u.atk > t.u.hp);
        if(cuts.length){ cuts.sort((x,y)=> (y.u.atk-y.u.hp) - (x.u.atk-x.u.hp)); return {kind:'order', card:c, tgt:{row:cuts[0].row, col:cuts[0].col}}; }
        continue;
      }
      // 火力爆发：只能给本回合还能行动的友方战斗机（不给轰炸机/已行动单位）
      if(c.eff === 'powerSurge'){
        const fighters = tgts.filter(t => !t.hq && t.u && t.u.owner==='a' && t.u.def.t === 'fighter' && canAct(t.u));
        if(!fighters.length) continue;
        fighters.sort((x,y)=> (y.u.atk||0) - (x.u.atk||0));
        return {kind:'order', card:c, tgt:{row:fighters[0].row, col:fighters[0].col}};
      }
      const t = aiPickOrderTarget(c, tgts);
      if(t) return {kind:'order', card:c, tgt: t.hq ? {hq:true} : {row:t.row, col:t.col}};
      continue;
    }
    if(['airStrike','bismarck','tirpitz'].includes(c.eff)) return {kind:'order', card:c};
    if(['deathFromAbove'].includes(c.eff) && countEnemy('a')>0) return {kind:'order', card:c};
    if(['carpetBomb','eagleClaw','greatWar'].includes(c.eff)) return {kind:'order', card:c};
    // 泥泞季：全场单位按行动花费受伤（伤敌亦伤己）——场上有敌方单位才值得打
    if(['mudSeason'].includes(c.eff) && countEnemy('a')>0) return {kind:'order', card:c};
    // 美国陆军航空队：白赚 2 张（轰炸机+战斗机）
    if(['usArmyAir'].includes(c.eff)) return {kind:'order', card:c};
    // 山本五十六：有友方空军且能支付时打
    if(['yamamoto'].includes(c.eff) && allyList('a').some(t=>t.u.def.t==='fighter' || t.u.def.t==='bomber')) return {kind:'order', card:c};
    // 红茶：场上任一友方英国单位且能支付时打
    if(['tea'].includes(c.eff) && allyList('a').some(t=>t.u.def.nation==='gb')) return {kind:'order', card:c};
    // 冬季战争/冬季攻势：对所有目标（含双方总部）造成伤害，伤敌亦伤己——敌方总部不落后才值得打
    if(['winterWar','winterOffensive'].includes(c.eff) && foe.hp >= S.a.hp) return {kind:'order', card:c};
    if(['fortify'].includes(c.eff) && S.a.hp > 0) return {kind:'order', card:c};
    if(['warMachine'].includes(c.eff)) return {kind:'order', card:c};
    if(['warNeed','warBond','aswPatrol','southPlan'].includes(c.eff)) return {kind:'order', card:c};
    if(['airCover','yorktown'].includes(c.eff)) return {kind:'order', card:c};
    // 本土决战/伞降突袭：铺场型指令（费用条件由 playCost 动态结算，可随时打）
    if(['homelandDef','paraDrop'].includes(c.eff)) return {kind:'order', card:c};
    // 护送航运：1 张换 2 张（生产+计划），手牌有空间才打
    if(['convoy'].includes(c.eff) && S.a.hand.length <= 6) return {kind:'order', card:c};
    // 计划/土地女孩：抽牌类（土地女孩带协力自伤风险），手牌偏少才打
    if(['plan','landGirl'].includes(c.eff) && S.a.hand.length <= 5) return {kind:'order', card:c};
    // 至死方休/最后一搏：敌方场面多于己方时的清场（最后一搏连带 -6 指挥点槽，槽够多才打）
    if(['wipeAll','lastPush'].includes(c.eff) && countEnemy('a') > allyList('a').length && S.a.kreditSlots >= 7) return {kind:'order', card:c};
    if(['carrierGroup'].includes(c.eff) && allyList('a').some(t=>t.u.def.t==='fighter' || t.u.def.t==='bomber')) return {kind:'order', card:c};
    if(['carrierCover'].includes(c.eff) && allyList('a').some(t=>t.u.def.t==='fighter')) return {kind:'order', card:c};
    if(['dawnOp','backlight'].includes(c.eff)) return {kind:'order', card:c};
    if(['blazing'].includes(c.eff) && allyList('a').some(t=>t.u.def.t==='fighter' || t.u.def.t==='bomber')) return {kind:'order', card:c};
    if(['draw2'].includes(c.eff) && h.length<=4) return {kind:'order', card:c};   // MX 175 护航队
    // 物资短缺：敌方单位多时铺削弱（每个敌方单位回合开始自伤 1）
    if(['shortage'].includes(c.eff) && countEnemy('a') >= 2) return {kind:'order', card:c};
    // 巴顿：1 费白赚（本回合单位 -1 费 + 部署闪击）
    if(['patton'].includes(c.eff)) return {kind:'order', card:c};
    // 为了自由：有友方单位可增益
    if(c.eff === 'forFreedom'){
      const cand = allyList('a')[0];
      if(cand) return {kind:'order', card:c, tgt:{row:cand.r, col:cand.c}};
    }
    // 奎宁：有友方步兵可增益
    if(c.eff === 'quinine'){
      const cand = allyList('a').find(t=>t.u.def.t==='infantry');
      if(cand) return {kind:'order', card:c, tgt:{row:cand.r, col:cand.c}};
    }
    // 闪电战：前线有友方单位才值得打
    if(['blitzKrieg'].includes(c.eff) && allyList('a').some(t=>t.r===1)) return {kind:'order', card:c};
    // 遥远的桥：5 费延迟结算，随时可打
    if(['bridgeTooFar'].includes(c.eff)) return {kind:'order', card:c};
    // 战略重心：处于劣势才打——综合领先度 =（己方血量差）+（己方板面战力差）< 0；
    // 战略重心：伤及双方，处于劣势且该类型净收益 ≥ 0（敌方单位数 ≥ 己方）才打；
    // 抉择由 aiResolveChoice 按净收益最大的一类自动结算
    if(['strategicFocus'].includes(c.eff) && countEnemy('a')>0){
      let aArmy = 0, aAir = 0, pArmy = 0, pAir = 0, pPow = 0, aPow = 0;
      for(let r=0;r<ROWS;r++) for(let cc=0;cc<COLS;cc++){
        const x = S.board[r][cc];
        if(!x) continue;
        const pow = atkOf(x) + x.hp;
        if(x.owner === 'p'){ pPow += pow; if(x.def.t==='infantry'||x.def.t==='tank'||x.def.t==='artillery') pArmy++; else if(x.def.t==='fighter'||x.def.t==='bomber') pAir++; }
        else { aPow += pow; if(x.def.t==='infantry'||x.def.t==='tank'||x.def.t==='artillery') aArmy++; else if(x.def.t==='fighter'||x.def.t==='bomber') aAir++; }
      }
      const lead = (S.a.hp - S.p.hp) + (aPow - pPow);
      const armyEdge = pArmy - aArmy, airEdge = pAir - aAir;
      if(lead < 0 && Math.max(armyEdge, airEdge) >= 0) return {kind:'order', card:c};
    }
    // 预备役/大纵深作战/正面突击：轻步兵体系（手牌有空间才打）
    if(['reserve','deepOp','frontalAssault'].includes(c.eff) && S.a.hand.length < 7) return {kind:'order', card:c};
    // 恩尼格玛：手牌落后敌方才值得打
    if(['enigma'].includes(c.eff) && S.a.hand.length < S.p.hand.length) return {kind:'order', card:c};
    // 嗡嗡炸弹/虎虎虎/亡命之计：场上有敌方单位或血量领先时打
    if(['buzzBomb','tora'].includes(c.eff) && countEnemy('a') > 0) return {kind:'order', card:c};
    if(['lastResort'].includes(c.eff) && countEnemy('a') > 0) return {kind:'order', card:c};
    // 快速胜利/帝国之力/航母战/天皇诏令/外交专员：随时可打（外交专员走指向路径，不会到这里）
    if(['quickWin','empireForce','carrierWar','edict'].includes(c.eff)) return {kind:'order', card:c};
    // 战争海军：敌方手牌 ≥1 时打（伤害=敌方手牌数并随机弃1）
    if(['warNavy'].includes(c.eff) && S.p.hand.length >= 1) return {kind:'order', card:c};
    // 英联邦：友方总部防御力(最大生命)≥30 才可打出
    if(['commonwealth'].includes(c.eff) && S.a.maxHp >= 30) return {kind:'order', card:c};
    // 全域战争：卡组/手牌/场上有空军潜力才铺
    if(['totalWar'].includes(c.eff) && (allyList('a').some(t=>t.u.def.t==='fighter'||t.u.def.t==='bomber') || S.a.hand.some(cd=>cd && cd.kind==='unit' && (cd.t==='fighter'||cd.t==='bomber')) || S.a.deck.some(cd=>cd && cd.kind==='unit' && (cd.t==='fighter'||cd.t==='bomber')))) return {kind:'order', card:c};
    // 终焉之行：卡组顶有空军才打
    if(['lastJourney'].includes(c.eff) && S.a.deck.some((cd,i)=> i>=S.a.deck.length-4 && cd && cd.kind==='unit' && (cd.t==='fighter'||cd.t==='bomber'))) return {kind:'order', card:c};
    /* ===== 新增卡（2026-09 文档）===== */
    // 直伤/清场类：随时可打
    if(['highBomb','nightBomb','coerce','massRout','navalBattle'].includes(c.eff) && countEnemy('a') > 0) return {kind:'order', card:c};
    if(['greetings','closeCombat','lotta'].includes(c.eff)) return {kind:'order', card:c};
    // 北方铁矿：前线有友方单位才有收益
    if(['ironOre'].includes(c.eff) && allyList('a').some(t=>t.r===1)) return {kind:'order', card:c};
    // 古德里安：前线有友方德国坦克
    if(['guderian'].includes(c.eff) && allyList('a').some(t=>t.r===1 && t.u.def.t==='tank' && t.u.def.nation==='de')) return {kind:'order', card:c};
    // 抑制：有敌方单位就值得（有友方空军还能抽牌）
    if(['inhibitOne','sneakAttack','directStrike'].includes(c.eff) && countEnemy('a') > 0) return {kind:'order', card:c};
    // 扩大优势：前线有友方单位 + 卡组有单位
    if(['exploitGain'].includes(c.eff) && allyList('a').some(t=>t.r===1) && S.a.deck.some(cd=>cd && cd.kind==='unit')) return {kind:'order', card:c};
    // 阿尔卑斯要塞：总部有压力时才打（防守牌）
    if(['alpineFort','islandDef'].includes(c.eff) && S.a.hp <= S.p.hp) return {kind:'order', card:c};
    // 柏林之路 / 朱可夫 / 拖拉机厂 / 方面军：铺场与增益
    if(['roadBerlin','zhukov','tractorPlant','frontArmy'].includes(c.eff)) return {kind:'order', card:c};
    // 权衡：手牌有空间才抽（弃 1 张的代价）
    if(['weighOptions'].includes(c.eff) && S.a.hand.length <= 6) return {kind:'order', card:c};
    // 严冬：双方单位都不少时才换场（等量轻步兵）
    if(['harshWinter'].includes(c.eff) && countEnemy('a') >= 2) return {kind:'order', card:c};
    // 日间轰炸：有敌方目标（走指向路径，这里兜底）
    if(['dayBomb','longRange'].includes(c.eff) && countEnemy('a') > 0) return {kind:'order', card:c};
    // 八纮一宇：抽牌 + 按失去的指挥点槽补点
    if(['hakkoIchiu'].includes(c.eff) && S.a.hand.length <= 7) return {kind:'order', card:c};
    // 钢铁条约 / 殖民梦：抽牌向
    if(['steelPact','colonialDream'].includes(c.eff) && S.a.hand.length <= 7) return {kind:'order', card:c};
    // 波兰：西线计划/延长战线（铺军团）
    if(['westPlan','extendLine'].includes(c.eff)) return {kind:'order', card:c};
    // 波兰：严惩（弃敌方牌）
    if(['punish'].includes(c.eff) && S.p.hand.length > 0) return {kind:'order', card:c};
    // 法国：抵抗万岁/武装抵抗/解放（给敌方塞抵抗；自己手牌不吃紧时打）
    if(['resistanceHail','armedResistance','liberation','phonyWar'].includes(c.eff)) return {kind:'order', card:c};
    // 法国：抉择类（AI 走 aiResolveChoice 自动结算）
    if(['compromise','callColony','resistance'].includes(c.eff)) return {kind:'order', card:c};
    // 法国：纵深防御/萨尔攻势/洛林十字/毁坏/马奇诺防线（指向路径处理，这里兜底已有单位目标）
    if(['deepDefense','saarOffensive','lorraine','ruinHand'].includes(c.eff) && countEnemy('a') > 0) return {kind:'order', card:c};
    if(['maginot'].includes(c.eff) && allyList('a').some(t=>['infantry','tank','artillery'].includes(t.u.def.t))) return {kind:'order', card:c};
    // 芬兰：莫洛托夫鸡尾酒/白色死神/强制冻结/长久围困
    if(['molotov','whiteDeath'].includes(c.eff) && countEnemy('a') > 0) return {kind:'order', card:c};
    if(['freeze'].includes(c.eff) && allyList('a').length > 0) return {kind:'order', card:c};
    if(['longSiege'].includes(c.eff) && S.a.hand.length <= 6) return {kind:'order', card:c};
    // 意大利：进攻殖民地（指向）/ 一日之狮
    if(['attackColony'].includes(c.eff) && (countEnemy('a') > 0 || true)) return {kind:'order', card:c};
    if(['lionOfDay'].includes(c.eff) && countEnemy('a') > 0) return {kind:'order', card:c};
    /* ===== 新卡兜底（2026-09 批次）：已登记分支之后、反制之前扫一遍 ===== */
    for(const c of h){
      if(c.kind !== 'order' || (skip && skip.has(c.eff))) continue;
      if(playCost(S.a, c) > S.a.kredit) continue;
      if(!aiOrderAllowed(c.eff)) continue;              // §2 条件表：不值得打就跳过
      if(c.target){
        const tgts = orderTargets(c, 'a');
        if(!tgts.length) continue;                       // 没有合法目标 = 打不出去
        const t = aiPickOrderTarget(c, tgts);
        if(t) return {kind:'order', card:c, tgt: t.hq ? {hq:true} : {row:t.row, col:t.col}};
        continue;
      }
      return {kind:'order', card:c};                     // 无目标型：直接出
    }
  }
  // 反制：最后才激活（避免烧指挥点导致放不出单位；老牧师已提前布防）
  if(!mis && AI_DIFFICULTY !== 'warder' && S.a.kredit >= 1){
    for(const c of h){
      if(c.kind==='counter' && (c.blood||0) <= S.a.kredit) return {kind:'counter', card:c};
    }
  }
  return null;
}
function aiAttackTarget(r, c, u, tgts){
  const atkF = (typeof atkOf === 'function') ? atkOf : _atkOfG;
  // 元帅战术中央：不无脑打 HQ —— 玩家单位威胁大时先拆单位
  const intel = turnIntel || { level: 'NORMAL' };
  const hq = tgts.find(t=>t.hq);
  const unitTargets = tgts.filter(t=>!t.hq);
  if(aiIsMarshal() && hq && unitTargets.length){
    const atk = atkF(u);
    const killable = unitTargets.filter(t=>unitAt(t.row,t.col).hp <= atk);
    // 防御态：有能击杀的威胁单位 → 击杀优先（不磨 HQ）
    if((intel.level === 'DEFEND' || intel.level === 'GUARD') && killable.length){
      const sorted = killable.slice().sort((a,b)=> aiThreatOf(unitAt(b.row,b.col)) - aiThreatOf(unitAt(a.row,a.col)));
      return {row:sorted[0].row, col:sorted[0].col};
    }
    // 均衡态：能击杀且该单位威胁 ≥ 磨 2 血的价值 → 击杀优先；否则打 HQ
    if(intel.level === 'NORMAL' && killable.length){
      const topThreat = Math.max(...killable.map(t=> aiThreatOf(unitAt(t.row,t.col))));
      // 威胁评分阈值：攻高/血高的单位值得拆；低威胁单位不如直接磨 HQ
      if(topThreat >= 10) {   // atk*3+hp+typeW ≥ 10（如 2/3 步兵=6+3=9 <10 → 不拆，磨HQ）
        const sorted = killable.slice().sort((a,b)=> aiThreatOf(unitAt(b.row,b.col)) - aiThreatOf(unitAt(a.row,a.col)));
        return {row:sorted[0].row, col:sorted[0].col};
      }
    }
    return {hq:true};
  }
  // 能直击玩家总部就打（压低玩家血线）：总部在攻击目标里时优先打总部（0 攻击单位不打总部）
  if(atkOf(u) > 0 && tgts.some(t=>t.hq)) return {hq:true};
  const guard = tgts.filter(t=>!t.hq && unitAt(t.row,t.col) && hasSig(unitAt(t.row,t.col),'guard') && !unitAt(t.row,t.col).guardLost);
  const pool = guard.length ? guard : tgts.filter(t=>!t.hq);
  if(!pool.length){
    // 只剩总部可打：0 攻击单位放弃攻击
    if(tgts[0] && tgts[0].hq && atkOf(u) <= 0) return null;
    return tgts[0];
  }
  // 新兵失误：随机目标（乱打）
  if(aiMistake()) return pool[Math.floor(Math.random()*pool.length)];
  // 威胁评分：优先击杀炮兵/轰炸机，其次战斗机
  const threat = t => { const d=unitAt(t.row,t.col); return d.atk*3 + d.hp + ((hasSig(d,'guard') && !d.guardLost)?2:0) + ({artillery:4, bomber:3, fighter:2}[d.def.t]||0); };
  const killable = pool.filter(t=>unitAt(t.row,t.col).hp <= atkOf(u));
  if(killable.length){
    // 能击杀就踩（含伏击单位）：选威胁最高的可击杀目标
    const sorted = killable.slice().sort((x,y)=>threat(y)-threat(x));
    return sorted[0];
  }
  // 无法击杀：避免白送伏击单位（优先非伏击目标）
  const nonAmbush = pool.filter(t=>!hasSig(unitAt(t.row,t.col),'ambush'));
  const set = nonAmbush.length ? nonAmbush : pool;
  set.sort((x,y)=>threat(y)-threat(x));
  return set[0];
}

/* ---------- 致死打击（AI 加强）：场上可直击敌方总部的单位攻击力之和 + 手牌可直击总部的指令
   伤害 ≥ 敌方总部当前血量 → 引擎放弃其他操作，先打致命指令，再全体直击总部 ---------- */
const HQ_DIRECT_DMG = { airStrike:3, bismarck:8, tirpitz:4, gunboat:2, bombRaid:3, winterWar:1, winterOffensive:4 };
function aiLethalPlan(){
  const foe = S.p;
  // 注：玩家的总部带烟幕时**仍可**用指令凑斩杀（用户 2026-09-17：指令能指向带烟幕的总部）；
  // 单位那部分天然被 attackTargets 排除（烟幕期间单位打不到总部），无需在这里特判。
  const produceN = S.a.hand.filter(c => c.kind==='order' && c.eff==='produce').length;
  const kredit = S.a.kredit + produceN;                 // 生产牌白赚的指挥点计入预算
  // 指令：伤害从高到低；冬季牌伤敌亦伤己——别把自己先打死
  const orders = S.a.hand.filter(c => {
    if(c.kind !== 'order') return false;
    const dmg = HQ_DIRECT_DMG[c.eff];
    if(!dmg) return false;
    if(playCost(S.a, c) > kredit) return false;
    if(c.eff==='winterWar' && S.a.hp <= 1) return false;
    if(c.eff==='winterOffensive' && S.a.hp <= 4) return false;
    return true;
  }).sort((a,b)=> HQ_DIRECT_DMG[b.eff] - HQ_DIRECT_DMG[a.eff]);
  let total = 0;
  orders.forEach(c => { total += HQ_DIRECT_DMG[c.eff]; });
  // 单位：能行动且可直达敌方总部（攻击目标列表含总部=没被守护/阵线挡住）。
  // **油费必须真的付得起**：旧版不做油费预算，高估斩杀线 → 引擎进了斩杀分支却打不动，
  // 又不做别的操作 = 白费一回合（用户 2026-09-17「他推不了就攻击前线单位啊」）。
  // 先扣掉指令要花的指挥点，再按攻击力从高到低贪心计入付得起油费的单位。
  let budget = kredit;
  orders.forEach(c => { budget -= playCost(S.a, c); });
  const units = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner!=='a' || !canAct(u)) continue;
    if(atkOf(u) <= 0) continue; // 0 攻击单位不打总部（布良斯克游击队）
    if(!attackTargets('a', r, c).some(t=>t.hq)) continue;
    units.push({r, c, u});
  }
  units.sort((x,y)=> atkOf(y.u) - atkOf(x.u));
  const payable = [];
  for(const at of units){
    const cost = (typeof actFuelCost === 'function') ? actFuelCost('a', at.u) : 0;
    if(cost > budget) continue;         // 这一步油费付不起 → 不计入斩杀线（combat 会直接失败）
    budget -= cost;
    payable.push(at);
  }
  // 奋战单位一回合可攻击两次：斩杀伤害按双倍计（如 N1K-J紫电）；
  // 豹式坦克D型直击总部 = 2 次伤害（用户 2026-09-17 拍板），同样按双倍计
  payable.forEach(at => {
    const mult = (hasSig(at.u,'fight') ? 2 : 1) * (hasFx(at.u,'pantherD') ? 2 : 1);
    total += atkOf(at.u) * mult;
  });
  // 西苏精神（芬·反制）：玩家总部受到的伤害会全部转回 AI 自己的总部 —— 斩杀计划反而会把自己打死
  if(S.p && Array.isArray(S.p.counters) && S.p.counters.indexOf('sisuSpirit') >= 0) return null;
  if((orders.length || payable.length) && total >= foe.hp) return { orders, units: payable };
  return null;
}

/* Node 导出（浏览器下跳过，靠全局变量） */
if (typeof module !== 'undefined') {
  Object.assign(globalThis, { AI_DIFFICULTY, setAI_DIFFICULTY, aiLethalPlan, aiPlayRemoval, aiPlayBuff, aiRefreshIntel, aiIntel }); // 无头下可 global 设置/读取
  module.exports = {
    aiChoosePlay, aiAttackTarget, aiPickOrderTarget, aiFindSlot, aiNeedBlood, aiLethalPlan, aiPlayRemoval, aiPlayBuff,
    AI_DIFFICULTY, setAI_DIFFICULTY, aiRefreshIntel, aiIntel
  };
}
