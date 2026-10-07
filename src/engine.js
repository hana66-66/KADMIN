/* ============================================================
   铭刻前线 —— 核心规则引擎（src/engine.js）
   零 DOM 依赖：不引用任何浏览器全局（DOM 文档/窗口/存储/弹窗）。
   与 UI 的全部耦合点收口为全局 HOOKS（见下）；默认实现均为
   空操作/同步 Promise，Node 无头加载（模拟器）可直接 require。
   浏览器下由 src/ui.js 在启动时注入真实实现（installHooks）。
   规则逻辑与 铭刻前线.v1.html.bak 逐行为等价。
   ============================================================ */

/* ---------- 钩子：engine/ai 与 DOM 的全部解耦点 ----------
   契约键：onLog/onSfx/onRender/wait/toast；另含 onGameEnd（QA 适配器
   已依赖：落库 S.winner）。默认均为 no-op / 同步 Promise。 */
const HOOKS = {
  onLog(msg) {},            // 日志旁路（引擎内部 logMsg 已写入 S.log）
  onSfx(kind) {},           // 音效
  onRender() {},            // 每次画面刷新
  wait(ms) { return Promise.resolve(); }, // 等待（浏览器=setTimeout；无头=同步）
  toast(msg) {},            // 浮动提示（UI 专属文案，无头下为 no-op）
  onGameEnd(winner) {},     // 对局结束：覆盖层/结算面板（UI 专属）
  onOrderPlayed(card) {},   // 双方打出指令：牌桌中央动画（UI 专属，无头下为 no-op）
  onDrawnReveal(card, side) {},   // 抽取：抽到时向对手展示（UI 专属，无头下为 no-op）；side='p'|'a' 表示抽到方
  onCardBurst(cardDef, side) {},  // 满手爆牌：卡/单位因手牌已满被丢弃或摧毁（UI 专属，无头下为 no-op）；cardDef=被爆掉的卡面对象，side=所属方 'p'|'a'
  onFoeDiscard(card, reason) {},  // 敌方（AI）手牌被效果夺走：弃牌/返回卡组顶（用户 2026-09-13：要能看到弃掉的是哪张；UI 专属，无头下为 no-op）
  onHqHpChange(side, kind, prev, next) {}, // 总部血量变化事件：kind='damage'(受伤)/'heal'(加血)/'set'(直接更改)；UI 用于数字变色
  onAttack(info) {},    // 攻击行动：{hq,atkRow,atkCol,tgtRow,tgtCol,dd,rd,atkN,atkDef,tgtDef,proc,killed}——UI 做攻击可见动画与攻击音效（atkDef=攻击者卡面，proc=是否触发额外伤害）
  onCounterTrigger(info) {},  // 反制触发：{side:'p'|'a', eff, def}——UI 把卡牌滑出展示（无头下 no-op）
  onUnitDeploy(info) {},      // 单位上线：{row,col,def,hasDeploy}——UI 播放入场/部署特效动画（无头下 no-op）
  onUnitDeath(info) {},       // 单位死亡：{row,col,def}——UI 播放死亡动画（无头下 no-op）
  onMoveForward(info) {},     // 单位推进：{side,fromRow,fromCol,toRow,toCol,def}——UI 播放推进移动动画（无头下 no-op）
  onHqExplode(info) {},       // 总部被摧毁：{side}——UI 播放总部爆炸（无头下 no-op）
  onBossPhase2(info) {},      // Boss 进入二阶段（第一次被击败后重生）：{kind}——UI 播放屏幕震动（无头下 no-op）
  onBossGrant(info) {},       // Boss 获得卡牌：{side, cards:[{n,img}]}——UI 播放「飞入敌方手牌 → 移入左侧敌方卡组」动画
  onChoice(options) {}  // 抉择：弹出抉择选项（UI 专属，无头下为 no-op）
};

/* ---------- v2 战场钩子（只剩总部生命加成；其余战役规则钩子已于 2026-09-13 随战役数据一并拆除） ---------- */
const GAME_RULES = { hqHpBonus: { a: 0, p: 0 } };

/* ---------- v2 卡组覆盖（组卡器/战役自定义卡组；setDeckOverride 写入，resetGameState 消费） ---------- */
const DECK_OVERRIDE = { p: null, a: null };
let BOSS_KIND = null; // Boss 挑战种类（'tears'/'alps'）：UI 在 startGame 前 setBossKind，resetGameState 读入 S
function setBossKind(k){ BOSS_KIND = k || null; }
function getBossKind(){ return BOSS_KIND; }
function setDeckOverride(o){
  DECK_OVERRIDE.p = (o && o.p) || null;
  DECK_OVERRIDE.a = (o && o.a) || null;
}
function getDeckOverride(){ return DECK_OVERRIDE; }
/* 战场规则复位（自由对战/征程/Boss 入口调用；保持与默认值一致） */
function setGAME_RULES_OFF(){
  Object.assign(GAME_RULES, { hqHpBonus: { a: 0, p: 0 } });
}
/* ---------- Node 无头加载兼容 ---------- */
if (typeof module !== 'undefined' && typeof require === 'function') {
  Object.assign(globalThis, require('./cards.js'));
}

/* ---------- 基础 ---------- */
let _uid = 1; const uid = () => 'u' + (_uid++);
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

const MAX_HAND = 9, ROWS = 3, COLS = 5, OIL_DEF = 5;
function mkBoard(){ return [[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null]]; }

/* ---------- 状态 ---------- */
const S = {
  turn: 0, wins: 0, losses: 0, phase: 'idle', mode: null, over: false, log: [],
  deployBlock: null, // 提尔皮茨：{side:被封锁方}——该方下一个回合无法部署单位
  guard216Pending: false, // 216团：玩家摸牌完成后才触发回合开始特效（特效不得先于玩家摸牌）
  pendingChoice: null,    // 抉择：{eff, side, options}——等待玩家选择
  bossMode: false,        // Boss 挑战：专用 AI 与规则（梦之泪伤/阿尔卑斯要塞/北北布次香菜）
  bossKind: null,         // 'tears'=梦之泪伤（两条命）｜'alps'=阿尔卑斯要塞（开局脚本）｜'meme'=北北布次香菜（固定行动）
  bossRevived: false,     // 已重生（梦之泪伤第一次被击败后）
  bossSkipNext: false,    // 重生后跳过接下来的敌方回合
  alpsOpened: false,      // 阿尔卑斯要塞：开局脚本是否已执行
  memeTurn: 0,            // 北北布次香菜：固定行动回合计数
  pNation: 'us', aNation: 'de',
  board: mkBoard(),
  p: makeHqProxy(newPlayer([]), 'p'),
  a: makeHqProxy(newPlayer([]), 'a')
};
/* 总部血量代理：拦截 S.p/S.a 的 hp 赋值，按增减方向发出 HQ 血量事件（受伤/加血/直接更改），
   UI 据此给数字上色（红/绿/白）；_hqSilent 标记用于「直接更改」类赋值（不按增减归类） */
function makeHqProxy(player, side){
  return new Proxy(player, {
    set(t, prop, value){
      if(prop === 'hp' && typeof value === 'number' && value !== t.hp && !t._hqSilent){
        const kind = value < t.hp ? 'damage' : 'heal';
        try{ HOOKS.onHqHpChange(side, kind, t.hp, value); }catch(e){ /* 钩子异常不容忍 */ }
      }
      t[prop] = value;
      return true;
    }
  });
}
/* ---------- 开发者模式开关（开发者模式\ 目录里的外挂面板经 dev.js 改这里） ----------
   默认全关 = 正常游戏零影响；只有面板连上才会被打开。
     infiniteKredit  无限指挥点（dev.js 定时把玩家指挥点顶到 99）
     hqImmuneSide    'p' / 'a'：该侧总部免疫伤害（applyHqDamage 早退）
     skipAiTurns     还有几个敌方回合要被跳过（startAiTurn 开头消费） */
const DEV = { enabled: false, infiniteKredit: false, hqImmuneSide: null, skipAiTurns: 0 };

function newPlayer(deck){
  const produce = { kind:'order', id:'produce', n:'生产', blood:0, eff:'produce', img:'卡牌/中立/生产.jpg', desc:'获得 1 个指挥点' };
  return { hp:20, maxHp:20, kredit:0, kreditSlots:0, hand:[], deck, counters:[], counterHit:{}, prodDeck: Array.from({length:5}, ()=>JSON.parse(JSON.stringify(produce))), fatigue:0, extraDrawNext:0,
    airFuel0:false, airFuelMinus1:false, airAtk3:false, airAtk2:false, blazingUsed:false,
    patton:false,        // 巴顿：本回合手牌单位部署花费 -1，部署后具有闪击
    coopNations:null,    // 协力：回合开始时的友方单位国家快照（Set）
    frontBuff3:false,    // 闪电战：前线所有友方单位 +3 攻击力（直到回合结束）
    frontFuelMinus1:false, // 闪电战：前线所有友方单位 -1 行动花费（直到回合结束）
    bridgeTooFar:false,  // 遥远的桥：敌方回合结束时结算（坦克入前线或前线尽灭）
    reserveUsed:0,       // 预备役：本局已使用的张数（决定额外生成）
    diplomatUsed:0,      // 外交专员：本局已使用的张数（伤害累计）
    edictNext:false,     // 天皇诏令：下个友方伤害指令 +1
    ordersThisTurn:0,    // 高潮迭起：本回合已使用的指令数（回合开始清零）
    gbInfThis:0,         // 前线观察员：本回合友方部署的英国步兵数（回合开始轮换到 Last）
    gbInfLast:0,         // 前线观察员：上回合友方部署的英国步兵数（>0 即抽牌）
    /* ↓↓↓ batch-E2 新增 ↓↓↓ */
    totalDraws:0,            // 抽牌累计（本局）：近卫步兵第4团「敌方每抽 1 张牌 -1 花费」
    // ↓↓↓ batch-F4 新增 ↓↓↓
    blizzardFuel4:false,     // 暴风雪：所有单位行动花费为 4（施放方下个回合开始时清除）
    scorchedFuel4:false,     // 焦土政策：所有单位行动花费为 4（本局持续）
    lastStrikeUnits:[],      // 最后一击：友方回合结束时被消灭的单位
    /* ↓↓↓ batch-E4 新增 ↓↓↓ */
    hmsTalbot:false,         // HMS塔尔伯特（英·指令）：友方总部即将受到致命伤害时，先获得 +6 防御力（常驻旗标）
    hmsTalbotUsed:false      // 用户 2026-09-13 裁定：致命保护**仅 1 次**（用掉后不再触发；新的一局随本对象重建复位）
  };
}
const enemyOf = side => side === 'p' ? S.a : S.p;
const playerOf = side => side === 'p' ? S.p : S.a;
const nationOf = side => NATIONS[side === 'p' ? S.pNation : S.aNation];
const backRowOf = side => side === 'p' ? 2 : 0;
/* 部署封锁（提尔皮茨）：deployBlock={side:被封锁方}，该方下个回合无法部署单位 */
function deployBlocked(side){ return !!(S.deployBlock && S.deployBlock.side === side); }

/* ---------- 卡池构建 ---------- */
function buildDeck(key, list){
  // v2：可选自定义卡组（组卡器/战役变体）。list 元素可为：
  //   ① 全量 def（含 kind，原样入组）；② 原始定义对象（NATIONS 同构，自动按形状判型）；
  //   ③ 卡名字符串（经 cards.js mkByName 解析）。缺省 = 原版卡池（与原 HTML 行为一致）。
  if(Array.isArray(list)){
    const cards = [];
const COUNTER_EFFS = new Set(['spotEnemy','enemyDeployDmg','hqCap','enemyDrawPunish','ultra','fromDeep','frostTrap','friendlyFire','sisuSpirit']);
    for(const item of list){
      let raw = item;
      if(typeof item === 'string') raw = mkByName(key, item);
      if(!raw) continue;
      const nat = (typeof item === 'object' && item.nation) ? item.nation : key; // 跨阵营卡（Boss 虚空卡组）保留原国籍
      if(raw.kind){ cards.push(JSON.parse(JSON.stringify(raw))); continue; }
      if(raw.t){ cards.push(mkUnitDef(raw, nat)); continue; }
      if(COUNTER_EFFS.has(raw.e)){ cards.push(mkCounterDef(raw, nat)); continue; }
      cards.push(mkOrderDef(raw, nat));
    }
    return shuffle(cards);
  }
  const n = NATIONS[key];
  /* 默认卡组（自由对战 AI 与征程小怪都用它）：
     反制全留 → 单位优先（按稀有度上限、每人最多 2 份）→ 指令按顺序补足到 DECK_RULES.totalMax。
     旧写法是「超 40 张就从单位末尾删副本」，对指令很多的英/日会把单位删到一个不剩
     （实测 gb/jp 变成 0 单位、gb 还超到 54 张）——2026-09-13 改成按预算分配：
     每个国家都保证有单位，且总张数不超过上限。 */
  const cap = DECK_RULES.totalMax;
  const counters = n.counters.map(o => mkCounterDef(o, key));
  const unitDefs = [];
  n.units.forEach(u => {
    const copies = Math.min(2, maxCopiesOf(u.id));   // 原版预组至多 2 张
    for(let i=0;i<copies;i++) unitDefs.push(mkUnitDef(u, key));
  });
  const orderDefs = n.orders.map(o => mkOrderDef(o, key));
  const unitBudget = Math.max(1, Math.floor(cap * 0.6) - counters.length);   // 单位预算 ≈ 60%（让出反制占位）
  const units = unitDefs.slice(0, unitBudget);
  const orders = orderDefs.slice(0, Math.max(0, cap - counters.length - units.length));
  return shuffle(units.concat(orders, counters));
}
function mkUnitDef(u, key){
  // 词条/效果数组必须拷贝（slice），否则就地修改会污染 NATIONS 原始数据（如征程火堆/冲击移除）
  return { kind:'unit', id:u.id, n:u.n, t:u.t, blood:u.c, fuel:u.f, atk:u.a, hp:u.h, sig:(u.s||[]).slice(), armor:u.r||0, fx:(u.e||[]).slice(), deploy:u.d||null, target:u.target||null, nation:key, rarity:rarityOf(u.id), img:u.img || pathFor(key,u.n), desc:unitDesc(u) };
}
function mkOrderDef(o, key){
  const sig = (o.s || []).slice();
  let desc = orderDesc(o);
  // 词条前缀（协力等）：与单位卡「词条·」展示风格对齐
  if(sig.length){
    const sigTxt = sig.map(s => SIGINFO[s] ? SIGINFO[s].n : s).join('·');
    desc = desc ? sigTxt + '，' + desc : sigTxt;
  }
  return { kind:'order', id:o.id, n:o.n, blood:o.c||0, target:o.target||null, eff:o.e, sig, nation:key, rarity:rarityOf(o.id), img:o.img || pathFor(key,o.n), desc };
}
function mkCounterDef(o, key){
  return { kind:'counter', id:o.id, n:o.n, blood:o.c||0, eff:o.e, nation:key, rarity:rarityOf(o.id), img:o.img || pathFor(key,o.n), desc:counterDesc(o) };
}

/* ---------- 单位实体 ---------- */
function makeUnit(def, side){
  const u = { uid:uid(), owner:side, def, atk:def.atk, hp:def.hp, maxHp:def.hp, armor:def.armor,
    baseAtk:def.atk, baseMaxHp:def.hp, baseFuel:def.fuel||0, // 基础值快照（抑制/重置用）
    attackedN:0, movedThisTurn:false, summonedThisTurn:false, suppressed:false, smokeOut:false, ambushUsed:false, bound:null };
  return u;
}
function hasSig(u,s){
  if(!u || !u.def) return false;
  if((u.def.sig||[]).includes(s)) return true;
  /* 四号坦克H型（老兵）光环：「友方攻击力为4以上的陆军具有闪击」（口径见 卡牌/德/文档.txt，用户手补勿覆盖）
     —— 现算：光环源（带 vetBlitzAura4 标记的友方单位）在场即生效、离场即失效；攻击力用 atkOf（含光环）*/
  if(s === 'blitz' && u.owner && isArmyType(u.def.t) && atkOf(u) >= 4 && onboardHasFx(u.owner, 'vetBlitzAura4')) return true;
  return false;
}
function hasFx(u,f){ return (u.def.fx||[]).includes(f); }
const isArmyType = t => t==='infantry'||t==='tank'||t==='artillery';
const canBypassGuard = t => t==='artillery'||t==='bomber'||t==='fighter';
/* 动态攻击力（常驻光环）：九三式装甲车在场，其他友方单位 +1 攻击；D3A2 每有 1 个其他友方 D3A2 +2 攻击 */
function atkOf(u){
  if(!u) return 0;
  let bonus = 0;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const x = S.board[r][c];
    if(!x || x.owner!==u.owner || x===u) continue;
    if(hasFx(x,'auraAtk1')) bonus += 1;
    if(x.def.id==='d3a' && hasFx(u,'perAllyD3')) bonus += 2;
    // PB2Y卡罗纳多：友方战斗机 +1 攻击力
    if(x.def.id==='pb2y' && u.def.t==='fighter') bonus += 1;
  }
  // F2A 水牛：在前线时 +1 攻击力
  if(hasFx(u,'frontAtk1')){
    const pos = findPosOf(u);
    if(pos && pos.r === 1) bonus += 1;
  }
  // 暴风MkV（英）：敌方回合中，具有 +4 攻击力
  // 「敌方回合」= 当前阶段不属于本单位所有者（p 侧看 S.phase==='ai'，a 侧看 'player'）。
  // 注意不要用 enemyOf()：它返回玩家对象而不是 side 字符串。
  if(hasFx(u,'stormAtk4FoeTurn') && ((u.owner === 'p') ? S.phase === 'ai' : S.phase === 'player')) bonus += 4;
  // 闪电战：前线所有友方单位 +3 攻击力（直到回合结束）
  const me = playerOf(u.owner);
  if(me.frontBuff3){
    const pos = findPosOf(u);
    if(pos && pos.r === 1) bonus += 3;
  }
  // 为了天皇（日）：本回合所有友方日本单位 +1 攻击力（直到回合结束）
  if(me.jpBuff1 && u.def.nation === 'jp') bonus += 1;
  // 烈日/逆光攻击：本回合友方空军临时加成（仅对空军单位）
  if(u.def.t === 'fighter' || u.def.t === 'bomber'){
    if(me.airAtk3) bonus += 3;                    // 烈日
    if(me.airAtk2) bonus += 2;                    // 逆光攻击（烈日联动）
  }
  // 马基 C.205 N1K：对战空军时 +2 攻击力（vsAir2）；T-26 FI：对战攻击力更高的单位时 +2（vsStronger2，见 combat）
  if(hasFx(u,'vsAir2') && u._vsAir) bonus += 2;
  if(hasFx(u,'vsStronger2') && u._vsStronger) bonus += 2;
  // 三号坦克L型：友方单位每有一种非坦克类型，本单位具有 +1 攻击力
  // （自身增益光环，写在此处与 D3A2 的 perAllyD3、F2A水牛 的 frontAtk1 同族；抑制后失效）
  if(u.def && u.def.id === '三号坦克L型' && !u.inhibited){
    const kinds = new Set();
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const x = S.board[r][c];
      if(x && x.owner === u.owner && x.def.t !== 'tank') kinds.add(x.def.t);
    }
    bonus += kinds.size;
  }
  return u.atk + bonus;
}
function findPosOf(u){
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===u) return {r, c};
  return null;
}
/* 行动花费（油费）：拂晓行动（本回合空军 0 费）/ 逆光攻击（本回合空军 -1 费）/ 闪电战（前线 -1 费） */
function actFuelCost(side, u){
  // batch-F4·暴风雪 / 焦土政策：所有单位的行动花费为 4（取固定值，先于一切减免计算）
  if(S.p.blizzardFuel4 || S.a.blizzardFuel4 || S.p.scorchedFuel4 || S.a.scorchedFuel4) return 4;
  let cost = (u.fuelOverride != null) ? u.fuelOverride : (u.def.fuel || 0); // 皇家燧发枪团：攻/油互换的行动花费覆盖值（单位级，离场即消失）
  const me = playerOf(side);
  const isAir = u.def.t === 'fighter' || u.def.t === 'bomber';
  if(isAir && me.airFuel0) cost = 0;
  else if(isAir && me.airFuelMinus1) cost = Math.max(0, cost - 1);
  // 闪电战：前线所有友方单位 -1 行动花费（直到回合结束）
  if(me.frontFuelMinus1){
    const pos = findPosOf(u);
    if(pos && pos.r === 1) cost = Math.max(0, cost - 1);
  }
  // 为了天皇（日）：本回合所有友方日本单位 -1 行动花费（直到回合结束）
  if(me.jpFuelMinus1 && u.def.nation === 'jp') cost = Math.max(0, cost - 1);
  // 狮鹫指挥车：其他友方坦克 -1 行动花费
  if(u.def.t === 'tank'){
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const x = S.board[r][c];
      if(x && x.owner===side && x!==u && hasFx(x,'gryphon')) cost = Math.max(0, cost - 1);
    }
  }
  return cost;
}

/* ---------- 部署 / 推进 ---------- */
function spawnUnit(side, def, row, col, noDeploy){
  if(row === undefined){
    const r = backRowOf(side);
    for(let c=0;c<COLS;c++) if(!S.board[r][c]) return spawnUnit(side, def, r, c, noDeploy);
    return false;
  }
  const u = makeUnit(def, side);
  u.summonedThisTurn = true;
  // v2 战场规则：敌方单位属性倍率（默认 1 = 无变化）
  // 全域战争（英）：友方空军部署时，获得 +1 攻击力和闪击
  if(!noDeploy && playerOf(side).totalWar && (def.t === 'fighter' || def.t === 'bomber')){
    u.atk += 1;
    if(!hasSig(u,'blitz')) u.def.sig.push('blitz');
    logMsg('全域战争：'+def.n+' 部署时获得 +1 攻击力与闪击。');
  }
  S.board[row][col] = u;
  // 部署直接落前线（效果召唤等）：烟幕同样永久散去（词条移除）
  if(row === 1 && (u.def.sig || []).indexOf('smoke') >= 0){
    u.def.sig = (u.def.sig || []).filter(s => s !== 'smoke');
    u.smokeOut = true;
    logMsg(u.def.n + ' 落在前线，烟幕散去（烟幕词条移除）。');
  }
  // 反制·规避动作（英·0 费）：「敌方部署单位部署时，**反制其部署**」——单位**照常留在场上**，
  // 只是**部署效果不结算**。（口径来源：用户 2026-09-13；「消灭部署单位」是另一张反制「来自深处」，
  // 在下面的 checkEnemyDeployDmg 里，两者不要混。）
  // 位置必须在 applyDeploy **之前**：原来放在 checkEnemyDeployDmg 里是「效果已结算之后再杀单位」，
  // 既不等于「反制部署」，也把「消灭」的活抢了。
  let deployCountered = false;
  if(!noDeploy){
    const evSide = (side === 'a') ? 'p' : 'a';
    const evOwner = playerOf(evSide);
    if(evOwner && Array.isArray(evOwner.counters) && evOwner.counters.includes('规避动作') && !evOwner.counterHit['规避动作']){
      evOwner.counterHit['规避动作'] = true;
      if(evSide === 'p') consumePlayerCounter('规避动作');
      else { S.a.counters = S.a.counters.filter(e => e !== '规避动作'); emitCounterFx('a', '规避动作'); }
      logMsg('反制·规避动作：' + def.n + ' 的部署效果被反制（单位仍在场）。');
      deployCountered = true;
    }
  }
  // 部署效果（指向类用预先选中的目标）；noDeploy=true 时跳过（虚空印卡/脚本生成的单位不触发部署特效）
  if(!noDeploy && !deployCountered) applyDeploy(side, u, S.pickTarget);
  S.pickTarget = null;
  // 近卫机械化第12旅：攻击力不小于 4 的友方坦克部署时，升为老兵（部署效果结算后判定，含效果生成物）
  checkTank12Veteran(side, u);
  // 牛津（英）：友方陆军部署时，使其攻击力等同于其防御力（写在本单位自身部署效果之后，取最终防御力）
  if(!noDeploy) oxfordEqualize(side, u);
  // 协力：使用该卡牌时，除非回合开始时场上有相同国家的友方单位，否则总部受到士气伤害
  if(!noDeploy) coopCheck(side, u.def);
  syncRowSig(u); // 三式中战车：支援战线（己方底线）时具有伏击与守护（所有行变更点同步调用）
  // 前线观察员：本回合从手牌部署英国步兵（含卫戍）计数——直接加入战场的生成物（noDeploy=true）不计
  if(!noDeploy && ((def.nation === 'gb' && def.t === 'infantry') || def.id === 'garrison')){
    playerOf(side).gbInfThis = (playerOf(side).gbInfThis || 0) + 1;
  }
  // 情报Ⅹ（搜索第七联队等）：部署时随机显示敌方 N 张手牌
  if(!noDeploy) intelDeploy(side, def);
  HOOKS.onUnitDeploy({ row, col, def, hasDeploy: !!(def && def.deploy) }); // 单位上线：UI 播放入场/部署特效动画
  checkGameOver(); // 部署特效可直伤总部（零战等）：斩杀必须结算对局
  return true;
}
/* 部署特效能否触发（与指令不同）：单位部署特效没有合法目标时仍可直接部署，效果不触发；
   指令则必须有合法目标才能打出 */
/* 指向型卡对「某个单位」是否合法（归属 + 兵种/战线）。
   指令路径（orderTargets）一直按兵种过滤，但**单位部署效果**那条路径过去只判归属 →
   例：P-40小鹰 target='enemy-army' 时，敌方场上只有战斗机也会开放点选、效果落到错对象（2026-09-16 自查发现）。
   现在两条路径共用这一份判定，取值口径与 orderTargets 一致。 */
function targetUnitOk(card, x, row, side){
  if(!card || !x) return false;
  const t = String(card.target || '');
  const mine = x.owner === side;
  const isAir = x.def.t === 'fighter' || x.def.t === 'bomber';
  switch(t){
    case 'any': return true;
    case 'friendly': case 'friendly-unit': return mine;
    case 'friendly-fighter': return mine && x.def.t === 'fighter';
    case 'friendly-infantry': return mine && x.def.t === 'infantry';
    case 'friendly-tank': return mine && isTankUnit(x);
    case 'friendly-ground': return mine && (x.def.t === 'tank' || x.def.t === 'infantry');
    case 'friendly-guard': return mine && hasSig(x,'guard');
    case 'friendly-air': return mine && isAir;
    case 'friendly-army': return mine && isArmyType(x.def.t);
    case 'enemy': case 'enemy-unit': case 'enemy-unit-hq': case 'enemy-any': return !mine;
    case 'enemy-infantry': return !mine && x.def.t === 'infantry';
    case 'enemy-tank': return !mine && isTankUnit(x);
    case 'enemy-army': return !mine && isArmyType(x.def.t);
    case 'enemy-fly': return !mine && isAir;
    case 'enemy-backline': return !mine && row === backRowOf(side === 'p' ? 'a' : 'p');
    case 'enemy-frontline': return !mine && row === 1;
    default: return !mine;   // 未登记取值按「敌方任意单位」兜底（与旧行为一致）
  }
}
function deployCanTarget(card, side){
  if(!card || !card.target) return false;
  if(card.target === 'any') return true; // 零战/威尔士卫队：双方单位（敌方总部也算）皆可点
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const x=S.board[r][c];
    if(!x) continue;
    if(card.deploy === 'destroyAtk2' && (x.owner === side || x.atk > 2)) continue; // 第二挺进团：只可消灭敌方攻击力≤2
    if(targetUnitOk(card, x, r, side)) return true;
  }
  return false;
}
/* 「单位部署」类反制的统一入口（仅从手牌部署时调用；效果生成物/加入战场的单位不触发）：
   反制·规避动作（英：反制其部署）、反制·无心漫谈（美：3 点伤害，触发一次）、反制·来自深处（德：消灭）。
   触发即消耗——第二个及其之后的单位部署不再触发 */
function checkEnemyDeployDmg(side, u, row, col){
  if(!u) return;
  // 【口径修正 2026-09-13】「规避动作」不再在这里处理：它的卡面是「反制其部署」＝单位留场、部署效果不结算，
  // 拦截点已前移到 spawnUnit 里 applyDeploy **之前**（见那里的 deployCountered）。
  // 本函数只负责「部署时」的伤害/消灭类反制：无心漫谈（3 点伤害）与来自深处（消灭）。
  if(side==='a' && S.p.counters.includes('enemyDeployDmg') && !S.p.counterHit.enemyDeployDmg){
    u.hp -= 3; S.p.counterHit.enemyDeployDmg = true;
    consumePlayerCounter('enemyDeployDmg'); // 敌方触发 → 视做打出（从手牌移除）
    logMsg('反制·无心漫谈：' + u.def.n + ' 受到 3 点伤害');
    if(u.hp <= 0) killUnit(row, col);
  } else if(side==='p' && S.a.counters.includes('enemyDeployDmg') && !S.a.counterHit.enemyDeployDmg){
    u.hp -= 3; S.a.counterHit.enemyDeployDmg = true;
    S.a.counters = S.a.counters.filter(e => e !== 'enemyDeployDmg'); // 只触发一次
    emitCounterFx('a', 'enemyDeployDmg');
    logMsg('敌方反制·无心漫谈：' + u.def.n + ' 受到 3 点伤害');
    if(u.hp <= 0) killUnit(row, col);
  }
  // 反制·来自深处（德）：敌方单位部署时，将其消灭
  if(side==='a' && S.p.counters.includes('fromDeep') && !S.p.counterHit.fromDeep){
    S.p.counterHit.fromDeep = true;
    consumePlayerCounter('fromDeep');
    logMsg('反制·来自深处：' + u.def.n + ' 被消灭。');
    killUnit(row, col);
    return true;
  }
  if(side==='p' && S.a.counters.includes('fromDeep') && !S.a.counterHit.fromDeep){
    S.a.counterHit.fromDeep = true;
    S.a.counters = S.a.counters.filter(e => e !== 'fromDeep');
    emitCounterFx('a', 'fromDeep');
    emitCounterFx('a', 'fromDeep');
    logMsg('敌方反制·来自深处：' + u.def.n + ' 被消灭。');
    killUnit(row, col);
    return true;
  }
  return false;
}
/* 敌方触发了玩家的反制：撤下计数器（从手牌移除那张已激活的反制卡，视做打出） */
function consumePlayerCounter(eff){
  const me = S.p;
  // 罗得突击旅（德）：每次友方反制触发，手牌中的它获得 -2 花费
  me.counterTriggers = (me.counterTriggers || 0) + 1;
  // 同名反制可能有 2 张（一张已激活、一张还在手里待激活）：必须撤下**已激活**的那张——
  // 旧写法 findIndex 只按 eff 取第一张，会误删未激活的那张，而激活的那张留在手里还能点「收回」白退指挥点。
  let idx = me.hand.findIndex(c => c && c.kind === 'counter' && c.eff === eff && c.armed);
  if(idx < 0) idx = me.hand.findIndex(c => c && c.kind === 'counter' && c.eff === eff);
  if(idx > -1){
    const c = me.hand[idx];
    me.hand.splice(idx, 1);
    if(c.armed) logMsg('反制「' + c.n + '」打出了。');
  }
  // 若还有同种反制仍处于激活，保留待机；否则撤下
  if(!me.hand.some(c => c && c.kind === 'counter' && c.armed && c.eff === eff)){
    me.counters = (me.counters || []).filter(e => e !== eff);
  }
  emitCounterFx('p', eff);
}
/* 反制触发展示：把打出的反制卡卡面滑出到屏幕（UI 专属；无头 no-op） */
function emitCounterFx(side, eff){
  const key = side === 'p' ? S.pNation : S.aNation;
  const raw = (NATIONS[key] || {}).counters ? NATIONS[key].counters.find(c => (c.eff || c.e) === eff) : null;
  if(side === 'a') S.a.counterTriggers = (S.a.counterTriggers || 0) + 1; // 罗得突击旅（AI 侧）
  HOOKS.onCounterTrigger({ side, eff, def: raw ? mkCounterDef(raw, key) : null });
}
function applyDeploy(side, u, pick){
  const foe = enemyOf(side), me = playerOf(side);
  const d = u.def.deploy;
  if(!d) return;
  // 旋风（英）：敌方部署效果指向本单位时，对其总部造成 3 点伤害。
  // 口径（用户 2026-09-13）：「指向」= 指令 + 部署；攻击那一半由 combat 的独立触发点结算（不在此处）。
  // pick 的两种形状：① 单位对象（ui.js 的 S.pickTarget = u）；② {hq:true, hqSide}（指向总部的部署）。
  // 取位置一律走 findPosOf（不假设 pick 带 row/col），只在「目标确实在场」时才判定指向。
  if(pick && !pick.hq && pick !== u){
    const pp = findPosOf(pick);
    if(pp && pick.owner !== side && hasFx(pick,'whirlwindAura')){
      applyHqDamage(me, 3);
      logMsg('旋风：' + u.def.n + ' 的部署效果指向本单位，' + (side === 'p' ? '你' : '老牧师') + '的总部受到 3 点伤害。');
      checkGameOver();
    }
  }
  const randEnemy = () => { const list=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side) list.push({u:x,r,c}); } return list.length?list[Math.floor(Math.random()*list.length)]:null; };
  switch(d){
    case 'elimRand': { const t=randEnemy(); if(t){ logMsg(u.def.n+' 部署：随机消灭 '+t.u.def.n); killUnit(t.r,t.c); } break; }
    case 'dmgFlyRand5': {
      const list=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side && (x.def.t==='fighter'||x.def.t==='bomber')) list.push({u:x,r,c}); }
      if(list.length){ const t=list[Math.floor(Math.random()*list.length)]; damageUnit(t.u, 5, u); logMsg(u.def.n+' 部署：对敌方空军 '+t.u.def.n+' 造成 5 点伤害'); } break; }
    case 'frontAlly11': {
      let ok=false; for(let c=0;c<COLS;c++){ const x=S.board[1][c]; if(x && x.owner===side) ok=true; }
      if(ok){ u.atk+=1; u.hp+=1; u.maxHp+=1; logMsg(u.def.n+' 部署：前线有友方单位，获得 +1/+1'); } break; }
    case 'dmgRand3': { const t=randEnemy(); if(t){ damageUnit(t.u, 3, u); logMsg(u.def.n+' 部署：对 '+t.u.def.n+' 造成 3 点伤害'); } break; }
    case 'ally11': {
      let t = null;
      if(pick && pick.owner===side && pick !== u) t = pick;
      if(!t){ const list=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && x!==u) list.push(x); }
        if(list.length) t = list[Math.floor(Math.random()*list.length)]; }
      if(t){ t.atk+=1; t.hp+=1; t.maxHp+=1; logMsg(u.def.n+' 部署：使 '+t.def.n+' +1/+1'); }
      else logMsg(u.def.n+' 部署：没有可增益的友方单位，效果不触发。');
      break; }
    case 'enemiesBack': {
      const foeUnits = enemyList(side);
      foeUnits.forEach(t => {
        const u = t.u;
        S.board[t.r][t.c] = null;
        if(handReturnsToHand(u.owner, u.def, { row:t.r, col:t.c })){
          logMsg('利奥波德：'+u.def.n+' 被移回'+(u.owner==='a'?'老牧师的':'你的')+'手牌');
        } else { logMsg('利奥波德：'+u.def.n+' 手牌已满，无处可去！'); HOOKS.onCardBurst(u.def, u.owner); } // 满手爆牌：被移单位无处可归而丢失
      });
      break; }
    case 'allyInfantryOil': {
      let has=false; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && x.def.t==='infantry') has=true; }
      if(has){ u.def.fuel = Math.max(0, (u.def.fuel||0)-1); logMsg(u.def.n+' 部署：有友方步兵，油费 -1'); } break; }
    case 'hqDmg2': { me.hp -= 2; logMsg(u.def.n+' 部署：对友方总部造成 2 点伤害'); checkGameOver(); break; }
    case 'dmgRand1': {
      let t = null;
      const findU = u => { for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===u) return {r,c}; return null; };
      // 零战：可指向任意单位（含友方）或敌方总部
      if(pick && pick.hq){
        if(pick.hqSide !== side){ abilityHqDamage(u, foe, 1); logMsg(u.def.n+' 部署：对敌方总部造成 1 点伤害'); }
      } else if(pick){ const p=findU(pick); if(p) t={u:pick, r:p.r, c:p.c}; }
      if(!t) t = randEnemy();
      if(t){ damageUnit(t.u, 1, u); logMsg(u.def.n+' 部署：对 '+t.u.def.n+' 造成 1 点伤害'); }
      else logMsg(u.def.n+' 部署：没有可伤害的单位，效果不触发。');
      break; }
    case 'destroyAtk2': {
      let t = null;
      const findU = u => { for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===u) return {r,c}; return null; };
      if(pick && pick.owner!==side && pick.atk<=2){ const p=findU(pick); if(p) t={u:pick, r:p.r, c:p.c}; }
      if(!t){ const list=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side && x.atk<=2) list.push({u:x,r,c}); }
        if(list.length) t = list[Math.floor(Math.random()*list.length)]; }
      if(t){ logMsg(u.def.n+' 部署：消灭攻击力≤2 的 '+t.u.def.n); killUnit(t.r,t.c); }
      else logMsg(u.def.n+' 部署：没有攻击力≤2 的敌方单位，效果不触发。');
      break; }
    case 'exile': {
      let t = null;
      const findU = u => { for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===u) return {r,c}; return null; };
      if(pick && pick.owner!==side){ const p=findU(pick); if(p) t={u:pick, r:p.r, c:p.c}; }
      if(!t){ const list=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side) list.push({u:x,r,c}); }
        if(list.length) t = list[Math.floor(Math.random()*list.length)]; }
      if(t){ u.bound={r:t.r,c:t.c,u:t.u}; S.board[t.r][t.c]=null; logMsg(u.def.n+' 部署：将 '+t.u.def.n+' 移出战场（直至本单位离开）'); }
      else logMsg(u.def.n+' 部署：没有敌方单位，效果不触发。');
      break; }
    /* ======================= 盟国（波/法/芬/意）部署 ======================= */
    case 'routUnit': {
      // 第15狼步兵团：将 1 个单位转换为「溃军」；若为友方单位，抽 2 张牌
      let t = pick || null;
      if(!t || !S.board.some(row => row.includes(t))){
        const list = enemyList(side);                      // AI/无目标：随机取 1 个敌方单位
        t = list.length ? list[Math.floor(Math.random()*list.length)].u : null;
      }
      if(!t){ logMsg(u.def.n + ' 部署：没有可用目标。'); break; }
      const wasFriendly = t.owner === side;
      const nm = t.def.n;
      convertToRout(t);
      logMsg(u.def.n + ' 部署：' + nm + ' 被转换为「溃军」。');
      if(wasFriendly){ drawCards(me, 2); logMsg('第15狼步兵团：目标为友方，抽 2 张牌。'); }
      break; }
    case 'addResistance': {
      addResistToEnemy(side, 1);
      logMsg(u.def.n + ' 部署：将 1 张「抵抗」加入敌方手牌。');
      break; }
    case 'perEnemy11': {
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side) n++; }
      if(n){ u.atk += n; u.hp += n; u.maxHp += n; }
      logMsg(u.def.n + ' 部署：每有 1 个敌方单位获得 +1/+1（共 +' + n + '/+' + n + '）。');
      break; }
    case 'cr42Buff': {
      let mine = 0, his = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x){ if(x.owner===side) mine++; else his++; } }
      if(mine > his){ u.atk += 1; logMsg(u.def.n + ' 部署：友方单位数较多（' + mine + ' vs ' + his + '），+1 攻击力。'); }
      else logMsg(u.def.n + ' 部署：友方单位数不占优，不获得加成。');
      break; }
    case 'perAllyAir11': {
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && x!==u && (x.def.t==='fighter'||x.def.t==='bomber')) n++; }
      if(n){ u.atk += n; u.hp += n; u.maxHp += n; }
      logMsg(u.def.n + ' 部署：每有 1 个其他友方空军获得 +1/+1（共 +' + n + '/+' + n + '）。');
      break; }
    case 'g55Buff': {
      if(me.maxHp - foe.maxHp >= 5){ u.atk += 2; u.hp += 2; u.maxHp += 2; logMsg(u.def.n + ' 部署：友方总部防御力领先 5 点以上，获得 +2/+2。'); }
      else logMsg(u.def.n + ' 部署：总部防御力领先不足 5 点，不获得加成。');
      break; }
    case 'masKill': {
      const br = backRowOf(side === 'p' ? 'a' : 'p');
      const list = [];
      for(let c=0;c<COLS;c++){ const x=S.board[br][c]; if(x && x.owner!==side) list.push({x, c}); }
      if(list.length){ const t = list[Math.floor(Math.random()*list.length)]; logMsg(u.def.n + ' 部署：消灭敌方支援阵线 ' + t.x.def.n + '。'); killUnit(br, t.c); }
      else logMsg(u.def.n + ' 部署：敌方支援阵线没有单位。');
      break; }
    case 'spitfireMk2': {
      // 喷火 MkIIa：若有敌方空军，获得 +2/+2；否则获得奋战
      let air = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side && (x.def.t==='fighter'||x.def.t==='bomber')) air++; }
      if(air){ u.atk += 2; u.hp += 2; u.maxHp += 2; logMsg(u.def.n + ' 部署：敌方有空军，获得 +2/+2。'); }
      else { if(!hasSig(u,'fight')) u.def.sig = (u.def.sig||[]).concat(['fight']); logMsg(u.def.n + ' 部署：敌方没有空军，获得奋战。'); }
      break; }
    case 'bp42': {
      // BP-42装甲列车：将 2 个具有闪击的「第59装甲掷弹兵团」加入支援阵线
      const r59 = NATIONS.de.units.find(x => x.id === 'r59');
      let n = 0;
      for(let i=0;i<2;i++){
        const def = mkUnitDef(r59, 'de');
        if(!hasSig({ def, owner:side }, 'blitz')) def.sig = (def.sig||[]).concat(['blitz']);
        const br = backRowOf(side);
        let ok = false;
        for(let c=0;c<COLS;c++) if(!S.board[br][c]){ if(spawnUnit(side, def, br, c)){ ok = true; break; } }
        if(!ok) break;
        n++;
      }
      logMsg(u.def.n + ' 部署：' + n + ' 个具有闪击的「第59装甲掷弹兵团」加入支援阵线。');
      break; }
    case 'holm99': {
      // 霍尔姆第99团：下个友方回合开始时，失去 1 个指挥点
      me.pendingKreditLoss = (me.pendingKreditLoss || 0) + 1;
      logMsg(u.def.n + ' 部署：下个友方回合开始时失去 1 个指挥点。');
      break; }
    case 'p39': {
      // P-39 小蛇：随机消灭另 1 个友方单位
      const list = allyList(side).filter(t => t.u !== u);
      if(list.length){ const t = list[Math.floor(Math.random()*list.length)]; logMsg(u.def.n + ' 部署：随机消灭友方 ' + t.u.def.n + '。'); killUnit(t.r, t.c); }
      else logMsg(u.def.n + ' 部署：没有其他友方单位。');
      break; }
    case 'type94': {
      // 九四式轻装甲车：将 1 张「偷袭」加入手牌
      const raw = NATIONS.jp.orders.find(o => o.id === 'sneak');
      if(raw && me.hand.length < MAX_HAND){ handPushRevealed(me, mkOrderDef(raw, 'jp')); logMsg(u.def.n + ' 部署：将 1 张「偷袭」加入手牌。'); }
      else logMsg(u.def.n + ' 部署：手牌已满，无法加入「偷袭」。');
      break; }
    case 'ki44Discard': {
      // 二式战：敌方随机弃掉手牌中 1 张轰炸机（没有则不触发）
      const bombers = foe.hand.filter(c => c.kind==='unit' && c.t==='bomber');
      if(bombers.length){
        const pick = bombers[Math.floor(Math.random()*bombers.length)];
        const ix = foe.hand.indexOf(pick); if(ix>-1) foe.hand.splice(ix,1);
        logMsg(u.def.n+' 部署：敌方弃掉手牌中的轰炸机「'+pick.n+'」');
        if(foe === S.a) HOOKS.onFoeDiscard(pick, '弃牌');   // 用户 2026-09-13：敌方弃牌要看得见是哪张
      } else logMsg(u.def.n+' 部署：敌方手牌没有轰炸机，效果不触发。');
      break; }
    case 'coldstream': {
      // 冷溪卫队：将 1 张「海军支援」加入拥有者手牌（正在部署的本卡尚未移出手，不计入占用）
      const ns = (NATIONS.gb.orders || []).find(o => o.id === 'navalsupport');
      if(!ns){ logMsg(u.def.n+' 部署：海军支援尚未加入卡池，效果未触发。'); break; }
      if(handFree(me, u.def) > 0){
        handPushRevealed(me, mkOrderDef(ns, 'gb'));
        logMsg(u.def.n+' 部署：获得 1 张「'+ns.n+'」。');
      } else logMsg(u.def.n+' 部署：手牌已满（9张），无法获得海军支援。');
      break; }
    case 'r32Copy': {
      // 第32步兵团：部署：抽取卡组里的同名单位（不是复制；手牌满 9 则留在卡组）
      const ix = me.deck.findIndex(c => c && c.kind==='unit' && c.id==='r32');
      if(ix >= 0){
        if(handFree(me, u.def) > 0){
          me.hand.push(me.deck.splice(ix,1)[0]);
          logMsg(u.def.n+' 部署：从卡组抽取 1 张「第32步兵团」。');
        } else logMsg(u.def.n+' 部署：手牌已满（9张），第32步兵团留在卡组。');
      } else logMsg(u.def.n+' 部署：卡组中没有第32步兵团，效果不触发。');
      break; }
    case 'r1defBuff': {
      // 第1防卫营：部署：若前线有友方美国单位，获得 +1 攻击力
      let ok = false;
      for(let c=0;c<COLS;c++){ const x=S.board[1][c]; if(x && x.owner===side && x.def.nation==='us') ok = true; }
      if(ok){ u.atk += 1; logMsg(u.def.n+' 部署：前线有友方美国单位，获得 +1 攻击力。'); }
      else logMsg(u.def.n+' 部署：前线没有友方美国单位，效果不触发。');
      break; }
    case 'r20Add': {
      // 第20装甲掷弹兵团：部署：将 1 张「35（t）坦克」和 1 张「协同作战」加入手牌
      // （正在部署的本卡不计入占用；两张都放不下才放弃第二张）
      const pz = NATIONS.de.units.find(x=>x.id==='pz35');
      const co = NATIONS.de.orders.find(x=>x.id==='coopop');
      let room = handFree(me, u.def);
      if(pz){ if(room > 0){ handPushRevealed(me, mkUnitDef(pz,'de')); room--; logMsg(u.def.n+' 部署：获得 1 张「35（t）坦克」。'); } else logMsg(u.def.n+' 部署：手牌已满，35（t）坦克无法加入。'); }
      if(co){ if(room > 0){ handPushRevealed(me, mkOrderDef(co,'de')); room--; logMsg(u.def.n+' 部署：获得 1 张「协同作战」。'); } else logMsg(u.def.n+' 部署：手牌已满，协同作战无法加入。'); }
      break; }
    case 'hs129Fight': {
      // Hs 129：部署：与 1 个敌方单位战斗（部署时点选目标；未经点选则随机）
      // 纯数值交换：双方各按攻击力互相造成伤害——不受敌方单位类型影响（炮兵/轰炸机同样反击，
      // 战败也照常反击），重甲不减免任何一方伤害
      let t = null;
      const findU = uu => { for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===uu) return {r,c}; return null; };
      if(pick && pick.owner !== side){ const p=findU(pick); if(p) t={u:pick, r:p.r, c:p.c}; }
      if(!t) t = randEnemy();
      if(t){
        // 被动保留：对抗陆军（步兵/坦克/炮兵）时 +2 攻击力
        const dd = atkOf(u) + (hasFx(u,'hs129Atk') && isArmyType(t.u.def.t) ? 2 : 0);
        const rd = atkOf(t.u);
        if(dd > 0){ damageUnit(t.u, dd); logMsg(u.def.n+' 部署：与 '+t.u.def.n+' 交换伤害，造成 '+dd+' 点伤害'); }
        if(rd > 0){ damageUnit(u, rd); logMsg(t.u.def.n+' 反击，'+u.def.n+' 受到 '+rd+' 点伤害'); }
        if(t.u.hp <= 0) killUnit(t.r, t.c);
        if(u.hp <= 0){ for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===u) killUnit(r,c); }
        checkGameOver();
      } else logMsg(u.def.n+' 部署：没有敌方单位可战斗。');
      break; }
    case 'm503Buff': {
      // 摩托化步兵第503团：部署：使所有友方「轻步兵」获得 +1/+1
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && x.def.id==='lightinf'){ x.atk+=1; x.hp+=1; x.maxHp+=1; n++; } }
      logMsg(u.def.n+' 部署：'+(n||'无')+' 个友方轻步兵获得 +1/+1。');
      break; }
    case 'me262Clear': {
      // Me 262 A飞燕：部署：消灭所有敌方空军
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side && (x.def.t==='fighter'||x.def.t==='bomber')){ killUnit(r,c); n++; } }
      logMsg(u.def.n+' 部署：消灭敌方空军 '+(n||'无')+' 个。');
      break; }
    case 'bounceTop': {
      // 女王直属卡梅伦高地人团：部署：将 1 个敌方单位返回其所有者卡组顶
      let t = null;
      const findU = uu => { for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===uu) return {r,c}; return null; };
      if(pick && pick.owner !== side){ const p=findU(pick); if(p) t={u:pick, r:p.r, c:p.c}; }
      if(!t){ const list=enemyList(side); if(list.length) t = list[Math.floor(Math.random()*list.length)]; }
      if(t){
        S.board[t.r][t.c] = null;
        playerOf(t.u.owner).deck.push(JSON.parse(JSON.stringify(t.u.def)));
        logMsg(u.def.n+' 部署：将 '+t.u.def.n+' 返回其所有者卡组顶。');
      } else logMsg(u.def.n+' 部署：没有敌方单位，效果不触发。');
      break; }
    case 'ktigerCrush': {
      // 虎王坦克II型：部署：获得等同于敌方单位数的指挥点，消灭敌方所有陆军单位
      const cnt = enemyList(side).length;
      if(cnt > 0){ me.kredit += cnt; logMsg(u.def.n+' 部署：获得 '+cnt+' 指挥点（敌方有 '+cnt+' 个单位）。'); }
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const x = S.board[r][c];
        if(x && x.owner!==side && isArmyType(x.def.t)){ killUnit(r,c); n++; }
      }
      logMsg(u.def.n+' 部署：消灭敌方陆军 '+(n||'无')+' 个。');
      break; }
    case 'manchesterPrec': {
      // 曼彻斯特 Mk Ia：部署：将 1 张「精准轰炸」加入手牌（正在部署的本卡不计入占用）
      const prec = NATIONS.gb.orders.find(o=>o.id==='precision');
      if(handFree(me, u.def) > 0 && prec){ handPushRevealed(me, mkOrderDef(prec,'gb')); logMsg(u.def.n+' 部署：获得 1 张「精准轰炸」。'); }
      else logMsg(u.def.n+' 部署：手牌已满，无法获得「精准轰炸」。');
      break; }
    case 'stirlingCarpet': {
      // 斯特林 MK III：部署：将 1 张「地毯式轰炸」洗入卡组（随机位置）
      const carpet = NATIONS.gb.orders.find(o=>o.id==='carpet');
      if(carpet){
        const cd = mkOrderDef(carpet,'gb');
        const pos = me.deck.length ? Math.floor(Math.random()*(me.deck.length+1)) : 0;
        me.deck.splice(pos,0,cd);
        logMsg(u.def.n+' 部署：1 张「地毯式轰炸」洗入卡组。');
      }
      break; }
    case 'avreRetreat': {
      // 丘吉尔 MKIII AVRE：部署：使所有敌方陆军撤退——前线陆军→敌方底线空位（底线满则回其手牌）；
      // 底线陆军无处可退→直接返回其手牌；手牌已满则丢失并播爆牌
      const foeSide = side === 'p' ? 'a' : 'p';
      const moved = new Set();
      let n = 0;
      // 前线陆军优先
      for(let c=0;c<COLS;c++){
        const x = S.board[1][c];
        if(!x || x.owner!==foeSide || !isArmyType(x.def.t)) continue;
        const slot = emptyBacklineSlot(foeSide);
        if(slot){
          S.board[1][c]=null; S.board[slot.row][slot.col]=x; moved.add(x); syncRowSig(x); n++;
        } else {
          S.board[1][c]=null;
          if(handReturnsToHand(foeSide, x.def, { row:1, col:c })) n++;
          else { logMsg('AVRE：'+x.def.n+' 手牌已满，无处可去。'); HOOKS.onCardBurst(x.def, x.owner); }
        }
      }
      // 底线陆军（刚从前线撤下来的除外）全部返回其手牌
      const br = backRowOf(foeSide);
      for(let c=0;c<COLS;c++){
        const x = S.board[br][c];
        if(!x || x.owner!==foeSide || !isArmyType(x.def.t) || moved.has(x)) continue;
        S.board[br][c]=null;
        if(handReturnsToHand(foeSide, x.def, { row:br, col:c })) n++;
        else { logMsg('AVRE：'+x.def.n+' 手牌已满，无处可去。'); HOOKS.onCardBurst(x.def, x.owner); }
      }
      logMsg(u.def.n+' 部署：敌方陆军撤退 '+(n||'无')+' 个。');
      break; }
    case 'gordonPick': {
      // 戈登高人团：部署：友方指令向上浮起亮起——点击要加持的指令，花费设为 0 并置于卡组顶（不再是抉择面板）
      const orders = me.hand.filter(c=>c.kind==='order');
      if(!orders.length){ logMsg(u.def.n+' 部署：手里没有指令可加持。'); break; }
      if(side === 'a'){
        // AI：直接选花费最高的指挥
        const g = orders.sort((a,b)=>(b.blood||0)-(a.blood||0))[0];
        const gi = me.hand.indexOf(g);
        me.hand.splice(gi,1);
        g.blood = 0;
        me.deck.push(g);
        logMsg(u.def.n+' 部署：将「'+g.n+'」花费设为 0 并置于卡组顶。');
      } else {
        S.gordonPick = true;
        logMsg(u.def.n+' 部署：指令们浮起了——点击一张指令（花费→0 并置于卡组顶）。');
      }
      break; }
    case 'wafrica': {
      // 第2西非旅：抽取卡组中花费最低的指令；抽到「构筑之外」的特殊指令（计划/爆破/生产）则重复，直到抽到常规指令或卡组抽空
      let last = null;
      for(let i = 0; i < 12; i++){
        let ix = -1, best = 1e9;
        for(let j = 0; j < me.deck.length; j++){
          const c = me.deck[j];
          if(c && c.kind === 'order' && (c.blood||0) < best){ best = c.blood||0; ix = j; }
        }
        if(ix < 0) break;
        const cd = me.deck.splice(ix, 1)[0];
        if(handFree(me, u.def) <= 0){ me.deck.push(cd); logMsg(u.def.n+' 部署：手牌已满，指令「'+cd.n+'」留在卡组。'); break; }
        me.hand.push(cd);   // 「抽到」不是「加入手牌」：不进明牌口径
        last = cd;
        logMsg(u.def.n+' 部署：抽到指令「'+cd.n+'」。');
        if(!EXTRA_ORDER_EFFS.has(cd.eff)) break; // 抽到常规指令：停止
      }
      if(!last) logMsg(u.def.n+' 部署：卡组中没有指令，效果不触发。');
      break; }
    case 'middlesexAdd': {
      // 米德尔赛克斯团：将 1 张「卫戍」加入手牌（正在部署的本卡不计入占用）
      const g = makeDerived('garrison');
      if(handFree(me, u.def) > 0 && g){ handPushRevealed(me, g); logMsg(u.def.n+' 部署：获得 1 张「卫戍」。'); }
      else logMsg(u.def.n+' 部署：手牌已满，无法获得「卫戍」。');
      break; }
    case 'def1Pick': {
      // 第9突击队：使 1 个敌方单位的防御力为 1（可预先指定；没有合法目标也可直接部署，效果不触发）
      let t = null;
      const findU = uu => { for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===uu) return {r,c}; return null; };
      if(pick && !pick.hq && pick.owner !== side){ const p = findU(pick); if(p) t = {u:pick, r:p.r, c:p.c}; }
      if(!t){ const list = enemyList(side); if(list.length) t = list[Math.floor(Math.random()*list.length)]; }
      if(t){ t.u.maxHp = 1; t.u.hp = 1; logMsg(u.def.n+' 部署：'+t.u.def.n+' 的防御力变为 1。'); }
      else logMsg(u.def.n+' 部署：没有敌方单位，效果不触发。');
      break; }
    case 'charmHq': {
      // 魅力男孩高地人团：使友方总部 +4 防御力（并回复等量）
      me.hp += 4; me.maxHp += 4;
      logMsg(u.def.n+' 部署：友方总部 +4 防御力。');
      break; }
    case 'cmdo46Add': {
      // 第46突击队：将 1 张「爆破」和 1 张「计划」加入手牌（正在部署的本卡不计入占用）
      let room = handFree(me, u.def);
      if(room > 0){ handPushRevealed(me, makeBaopo()); room--; logMsg(u.def.n+' 部署：获得 1 张「爆破」。'); }
      else logMsg(u.def.n+' 部署：手牌已满，「爆破」无法加入。');
      if(room > 0){ handPushRevealed(me, makePlan()); logMsg(u.def.n+' 部署：获得 1 张「计划」。'); }
      else logMsg(u.def.n+' 部署：手牌已满，「计划」无法加入。');
      break; }
    /* ======================= 新卡部署（batch-A1；四号坦克H型见上方） ======================= */

    /* ------------------ 德 ------------------ */
    case '豹式坦克A型': {
      if(!hasFx(u,'pantherA')) u.def.fx = (u.def.fx||[]).concat(['pantherA']);
      break; }
    case '鼠式': {
      // 鼠式（德·金 12费4油 12/10 重甲3）：部署：消灭花费小于4的单位。每有1个，对1个敌方造成2点伤害。
      // 口径：双方场上花费<4 的单位全部被消灭；每消灭 1 个 → 对 1 个随机敌方单位造成 2 点伤害。
      // 先取「名单 → 计数 → 统一消灭」，避免先死单位污染战场遍历
      const low = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const x = S.board[r][c];
        if(x && x !== u && (x.def.blood || 0) < 4) low.push({x, r, c});
      }
      let n = 0;
      for(const t of low){ if(S.board[t.r][t.c] === t.x){ logMsg('鼠式：'+t.x.def.n+' 被消灭。'); killUnit(t.r, t.c); n++; } }
      logMsg(u.def.n + ' 部署：消灭花费小于 4 的单位 ' + (n || '无') + ' 个。');
      if(n > 0){
        let hits = 0;
        for(let i=0;i<n;i++){
          const t = randEnemy();
          if(!t) break;
          damageUnit(t.u, 2, u);
          hits++;
        }
        logMsg(u.def.n + ' 部署：对敌方造成 ' + hits + ' 次 2 点伤害（随机目标）。');
      }
      checkGameOver();
      break; }
    case '38(t)坦克': {
      // 38(t)坦克（德·铁 3费1油 2/3）：部署：抽1张牌。
      drawCards(me, 1);
      logMsg(u.def.n + ' 部署：抽 1 张牌。');
      break; }
    case '三号坦克H型': {
      // 三号坦克H型（德·银 4费1油 2/4）：部署：从卡组顶的3张牌中选择1张并抽取，将其余2张置于卡组底。
      // 抉择面板口径与「扩大优势(exploitGain)」一致：展示 3 张 → 玩家点选；AI 直接取随机 1 张。
      // 玩家侧：正在部署的本卡此刻仍在手里，手牌满 9 时视为「本卡占位」，故用 handFree(me, u.def) 判定
      const top3 = me.deck.splice(Math.max(0, me.deck.length - 3), 3);
      if(!top3.length){ logMsg(u.def.n + ' 部署：卡组已空，效果不触发。'); break; }
      if(side === 'a' || GAME_RULES.headless){
        const ch = top3.pop(); // 卡组顶 = 末尾
        me.deck = top3.concat(me.deck); // 其余置于卡组底（deck 头部）
        if(handFree(me, u.def) > 0){ me.hand.push(ch); logMsg(u.def.n + ' 部署：抽到「' + ch.n + '」，其余 ' + top3.length + ' 张置于卡组底。'); }
        else { me.deck.push(ch); logMsg(u.def.n + ' 部署：手牌已满，「' + ch.n + '」留在卡组。'); }
        break;
      }
      const options = top3.map((c, i) => ({
        id:'c' + i, n:c.n, img:c.img || '',
        desc:'抽到手中（其余 ' + Math.max(0, top3.length - 1) + ' 张置于卡组底）'
      }));
      S.pendingChoice = { eff:'pz3hTop3', side:'p', options, picks:top3, card:u.def, fromDeck:true };
      HOOKS.onChoice(options);
      logMsg(u.def.n + ' 部署：展示卡组顶 ' + top3.length + ' 张——选择 1 张抽到手中。');
      break; }
    case 'Fw190A百舌鸟': {
      // Fw190A百舌鸟（德·铁 6费2油 5/5）：部署：抽1张牌。
      drawCards(me, 1);
      logMsg(u.def.n + ' 部署：抽 1 张牌。');
      break; }
    /* case '四号坦克H型' 已由他人实现（见上方），本批不重复下发 */
    /* ------------------ 日 ------------------ */
    case '京都联队': {
      // 京都联队（日·铜 3费1油 2/4 守护·情报1）：部署：移除1个敌方单位，直到本单位离开战场。
      // 完全沿用仙台联队 exile 的 u.bound 机制（killUnit 内「离场时返回」统一结算），
      // 只是本卡数据没有 target 字段（不预先点选），故部署后自动指向 1 个随机敌方单位
      let t = null;
      const findU = uu => { for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===uu) return {r,c}; return null; };
      if(pick && !pick.hq && pick.owner !== side){ const p = findU(pick); if(p) t = {u:pick, r:p.r, c:p.c}; }
      if(!t) t = randEnemy();
      if(t){
        if(u.bound && u.bound.u && !S.board[u.bound.r][u.bound.c]) S.board[u.bound.r][u.bound.c] = u.bound.u; // 保险：已有绑定先放回
        u.bound = { r:t.r, c:t.c, u:t.u };
        S.board[t.r][t.c] = null;
        logMsg(u.def.n + ' 部署：将 ' + t.u.def.n + ' 移出战场（直至本单位离开）。');
      } else logMsg(u.def.n + ' 部署：没有敌方单位，效果不触发。');
      break; }

    /* ------------------ 日（卡面效果：无 → 白板单位，显式登记为空实现） ------------------ */
    case '姬路联队':
    case '熊本联队':
    case 'Ki-61三式战飞燕': {
      break; }

    case '第5步兵团': {
      // 第5步兵团（美·铁 2费1油 2/3 步兵）：「移至前线时，获得 +1/+1」——**不是部署效果，是「移至前线」被动**。
      // 手法与 F1 的「豹式坦克A型」/「近卫机械化第12旅」一致：部署时补挂 fx 标记 r5Buff，
      // 实际触发点在 moveForward（F4F-4 野猫 f4fBuff 同位置，见 §P1）。
      // 此处补挂标记的好处：即使 cards.js 忘了写 e:['r5Buff']，被动照样生效。
      if(!hasFx(u,'r5Buff')) u.def.fx = (u.def.fx||[]).concat(['r5Buff']);
      break; }

    /* ------------------ 美 ------------------ */
    case '霹雳师': {
      // 霹雳师（美·金 3费1油 3/5 烟幕·冲击）：部署：抽2张牌。选择1张手牌并将其返回卡组顶。
      drawCards(me, 2);
      logMsg(u.def.n + ' 部署：抽 2 张牌。');
      // 选牌口径与「权衡(weighOptions)」一致：手牌上浮，点击一张即结算（走 S.discardPick 槽位）
      if(side === 'a' || GAME_RULES.headless){
        const pool = foe === me ? [] : me.hand.filter(c => c && c !== u.def);
        if(pool.length){
          const ch = pool[Math.floor(Math.random()*pool.length)];
          handCardToDeckTop(me, ch);
          logMsg(u.def.n + ' 部署：将「' + ch.n + '」置于卡组顶。');
        } else logMsg(u.def.n + ' 部署：没有可返回的手牌。');
      } else {
        S.discardPick = { card:u.def, n:1, label:'霹雳师', toDeck:true };
        logMsg(u.def.n + ' 部署：请点击 1 张手牌，将其返回卡组顶（按 ESC 或结束回合将自动选择）。');
      }
      break; }
    case '第175步兵团': {
      // 第175步兵团（美·铁 3费1油 6/6 闪击）：部署：选择1张手牌。将其返回卡组顶。
      if(side === 'a' || GAME_RULES.headless){
        const pool = me.hand.filter(c => c && c !== u.def);
        if(pool.length){
          const ch = pool[Math.floor(Math.random()*pool.length)];
          handCardToDeckTop(me, ch);
          logMsg(u.def.n + ' 部署：将「' + ch.n + '」置于卡组顶。');
        } else logMsg(u.def.n + ' 部署：没有可返回的手牌。');
      } else {
        S.discardPick = { card:u.def, n:1, label:'第175步兵团', toDeck:true };
        logMsg(u.def.n + ' 部署：请点击 1 张手牌，将其返回卡组顶（按 ESC 或结束回合将自动选择）。');
      }
      break; }
    case 'M10A1': {
      // M10A1（美·铜 3费1油 4/2）：部署：抑制1个敌方单位。
      // 目标选择沿用 def1Pick/dmgRand1 的写法；生效沿用 applySuppress（免疫抑制者不生效，如实记录）
      let t = null;
      if(pick && !pick.hq && pick.owner !== side){ const p = findPosOf(pick); if(p) t = {u:pick, r:p.r, c:p.c}; }
      if(!t) t = randEnemy();
      if(t){
        if(applySuppress(t.u)) logMsg(u.def.n + ' 部署：抑制 ' + t.u.def.n + '。');
        else logMsg(u.def.n + ' 部署：' + t.u.def.n + ' 免疫抑制，效果不触发。');
      } else logMsg(u.def.n + ' 部署：没有敌方单位，效果不触发。');
      break; }
    case '超级堡垒B-29': {
      // 超级堡垒B-29（美·金 12费4油 9/9 重甲2 闪击）：部署：造成6点伤害，随机分配至所有敌方目标。
      // 伤害分配沿用「终焉之行(lastJourney)」的随机池写法（含敌方总部；每点伤害随机落在当前存活目标上）
      const pool = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const b = S.board[r][c]; if(b && b.owner !== side) pool.push(b); }
      const foeP = playerOf(foe);
      pool.push(foeP); // 目标包含敌方总部：场上无单位时 6 点全打总部
      let dealt = 0;
      for(let i=0;i<6 && pool.length;i++){
        // 剔除已阵亡的单位目标，剩余伤害继续随机分配
        for(let j=pool.length-1;j>=0;j--){ const pj = pool[j]; if(pj !== foeP && (!pj.def || pj.hp <= 0)) pool.splice(j, 1); }
        if(!pool.length) break;
        const t = pool[Math.floor(Math.random()*pool.length)];
        dealt++;
        if(t === foeP){ applyHqDamage(foeP, 1); }
        else { damageUnit(t, 1, u); }
      }
      logMsg(u.def.n + ' 部署：6 点伤害随机分配至敌方目标（实际分配 ' + dealt + ' 点）。');
      checkGameOver();
      break; }
    case 'BP-43装甲列车': {
      // BP-43装甲列车（苏·金 5费5油 3/7 坦克·守护·重甲1）：
      // 「无法攻击。友方回合结束时，将 1 张「轻步兵」加入同一阵线。」= 两条被动，不是部署效果。
      // 手法同「豹式坦克A型（fx-F1）」：部署时补挂 fx 标记，真实触发点在
      //   ① 无法攻击 → attackTargets / canAct（补丁 P1 / P2）
      //   ② 回合结束生成轻步兵 → triggerFriendlyTurnEnd 调用的 f4TurnEndSettle（补丁 P4）
      // 这样即使 cards.js 忘了写 e:['noAttack','bp43LightInf']，被动照样生效
      u.def.fx = (u.def.fx || []).slice();
      if(!hasFx(u,'noAttack'))     u.def.fx.push('noAttack');
      if(!hasFx(u,'bp43LightInf')) u.def.fx.push('bp43LightInf');
      break; }
    /* ======================= 老兵形态（就地转换；模板见 cards.js VETERAN_FORMS） ======================= */
        case '虎王': {
      // 虎王（德·金 12费4油 10/10 重甲2）：友方支援阵线卡牌无法成为敌方指令或部署的目标。
      // 光环类：不落标记，取目标时实时判定 —— 真正干活的是 PART 2 的 HOOK-2 / HOOK-3 / HOOK-4。
      // 口径：「支援阵线」= 该方底线 backRowOf（'p'→2 / 'a'→0，与「战略轰炸/鹰爪」同口径）；
      //       只挡「指令」与「部署」的目标选取，不挡攻击、不挡无指向的群体效果
      //       （与既有虎式坦克E型 tigerE 的拦截范围一致，只是多了部署目标与整条支援阵线）。
      logMsg(u.def.n + ' 部署：友方支援阵线进入掩护（无法成为敌方指令/部署的目标）。');
      break; }
    case '第158补给营': {
      // 第158补给营（德·金 1费4油 0/4 烟幕）：友方回合中，消灭第一个敌方单位时，获得2个指挥点。
      // 触发类：真正干活的是 PART 2 的 HOOK-9（killUnit 里，受益方=被消灭单位的对手）
      // 与 HOOK-10 第二处（resolveOwnerTurnStart 里把 me.supply158Used 清零）。
      logMsg(u.def.n + ' 部署：友方回合中消灭第一个敌方单位时，获得 2 个指挥点。');
      break; }
    case '三号坦克L型': {
      // 三号坦克L型（德·金 3费2油 3/5 闪击）：友方单位每有一种非坦克类型，具有+1攻击力。
      // 口径（**本批最需要拍板的一条，见 PART 5-①**）：读作「本单位自己 +1」——
      //   卡面「每有…，具有 +X」是本项目表达**自身增益**的固定句式（对照卡面库：
      //   「每有 1 个其他友方 D3A2 九九舰爆，具有 +2 攻击力」= D3A2 自身；
      //   「在前线时，具有 +1 攻击力」= F2A水牛自身；「对战空军时，具有+2攻击力」= 马基 C.205 自身）。
      //   若写成光环，卡面会是「其他友方单位具有 +1 攻击力」（九三式装甲车就是这么写的）。
      // 光环类：真正干活的是 PART 2 的 HOOK-1（atkOf 里实时统计非坦克类型数）。
      logMsg(u.def.n + ' 部署：友方每有一种非坦克类型，本单位 +1 攻击力。');
      break; }
    case '九二式重装甲车': {
      // 九二式重装甲车（日·铁 1费0油 1/2 烟幕）：本单位对敌方总部造成伤害后，获得+1攻击力。
      // 触发类：真正干活的是 PART 2 的 HOOK-7（攻击总部分支，用「总部血量差」判实际落地伤害）。
      logMsg(u.def.n + ' 部署：直击敌方总部后，永久 +1 攻击力。');
      break; }
    case 'M26潘兴': {
      // M26潘兴（美·金 10费3油 8/8 闪击·重甲2）：本单位在前线时，友方总部的防御力无法降为1以下。
      // 光环类：真正干活的是 PART 2 的 HOOK-5（applyHqDamage 里把「总部血量-伤害」的下限钳在 1）
      // 与 HOOK-6（西苏精神转伤时同样守下限）。
      logMsg(u.def.n + ' 部署：本单位在前线时，友方总部防御力不会降到 1 以下。');
      break; }
    case '第142步兵团': {
      // 第142步兵团（美·铁 2费1油 2/3 闪击）：本单位消灭1个敌方单位时，使友方总部获得+2防御力。
      // 触发类：真正干活的是 PART 2 的 HOOK-8（combat 的 killed 分支，紧邻 g50HqHeal / overflowHq）。
      logMsg(u.def.n + ' 部署：本单位消灭敌方单位时，友方总部 +2 防御力。');
      break; }
    case '红牛师': {
      // 红牛师（美·铁 3费1油 1/6）：友方回合开始时，攻击力翻倍。
      // 触发类：真正干活的是 PART 2 的 HOOK-10 第一处（resolveOwnerTurnStart 的单位循环里）。
      // 口径：常驻累积（1→2→4→8…），卡面没有「直到回合结束」；与豹式坦克D型 panzerActs 同属永久成长。
      logMsg(u.def.n + ' 部署：友方回合开始时攻击力翻倍。');
      break; }
case '第119掷弹兵团': {
      // 第119掷弹兵团（德·金 6费2油 6/6 奋战）：若有友方「第35掷弹兵团」，升为老兵
      // （老兵形态：6费2油 6/6 老兵·伏击·奋战）
      // 用户口径（2026-09-13）：**两个兵同时升老兵** —— 不只新落地的这个，场上已有的那个也一起升。
      // 已升过的一方 promoteToVeteran 会因卡名带「（老兵）」查不到模板而返回 false → 天然幂等，不会二次转换。
      { const mate = allyWithId(side, '第35掷弹兵团', u);
        if(mate){
          logMsg(u.def.n + '：有友方「第35掷弹兵团」——两个掷弹兵团同时升为老兵！');
          promoteToVeteran(u);
          promoteToVeteran(mate);
        } }
      break; }
    case '第35掷弹兵团': {
      // 第35掷弹兵团（德·金 6费2油 6/6 闪击）：若有友方「第119掷弹兵团」，升为老兵
      // （老兵形态：6费2油 6/6 老兵·伏击·闪击）
      // 用户口径（2026-09-13）：两个兵同时升老兵（同上，两个方向都成立）
      { const mate = allyWithId(side, '第119掷弹兵团', u);
        if(mate){
          logMsg(u.def.n + '：有友方「第119掷弹兵团」——两个掷弹兵团同时升为老兵！');
          promoteToVeteran(u);
          promoteToVeteran(mate);
        } }
      break; }
    case '四号坦克H型': {
      // 四号坦克H型（德·铜 7费2油 5/5）：部署：与 1 个敌方单位战斗，若将其消灭，升为老兵。
      // 「战斗」沿用 Hs 129（hs129Fight）的既有口径：纯数值交换（双方各按攻击力互相造成伤害，
      // 不受兵种反击规则/重甲影响）；未经点选则随机取 1 个敌方单位
      let t = null;
      const findU = uu => { for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===uu) return {r,c}; return null; };
      if(pick && !pick.hq && pick.owner !== side){ const p = findU(pick); if(p) t = {u:pick, r:p.r, c:p.c}; }
      if(!t) t = randEnemy();
      if(t){
        const foeName = t.u.def.n;
        const dd = atkOf(u), rd = atkOf(t.u);
        if(dd > 0){ damageUnit(t.u, dd); logMsg(u.def.n+' 部署：与 '+foeName+' 战斗，造成 '+dd+' 点伤害'); }
        if(rd > 0){ damageUnit(u, rd); logMsg(foeName+' 反击，'+u.def.n+' 受到 '+rd+' 点伤害'); }
        const killed = t.u.hp <= 0;
        if(killed) killUnit(t.r, t.c);
        if(u.hp <= 0){ const p = findU(u); if(p) killUnit(p.r, p.c); }
        else if(killed){
          logMsg(u.def.n + '：消灭了 ' + foeName + '——');
          promoteToVeteran(u);   // 老兵形态：7费2油 5/5 老兵
        }
        checkGameOver();
      } else logMsg(u.def.n+' 部署：没有敌方单位可战斗。');
      break; }
    case '近卫机械化第12旅': {
      // 近卫机械化第12旅（苏·铁 1费1油 2/1 烟幕）：攻击力不小于 4 的友方坦克部署时，升为老兵。
      // 挂监听标记，实际结算在 spawnUnit → checkTank12Veteran（老兵形态：1费1油 2/2 老兵·闪击）
      if(!hasFx(u,'vetTank12')) u.def.fx = (u.def.fx||[]).concat(['vetTank12']);
      break; }
        case '柴郡团': {
      // ↓↓↓ batch-E3：英 新增 9 个单位效果（触发/光环类；真正干活在 PART 2 的各处钩子） ↓↓↓
      // 英 柴郡团（铜·步兵 2费1油 0/5）：友方回合开始时，若上回合没有被攻击，对敌方总部造成2点伤害。
      // 触发类：真正干活的是 HOOK-1（resolveOwnerTurnStart，与紧邻的「卫戍 garrisonTick」同一钩子）
      if(!hasFx(u,'cheshireTick')) u.def.fx = (u.def.fx||[]).concat(['cheshireTick']);
      break; }
    case '第10突击队': {
      // 英 第10突击队（铜·步兵 2费1油 2/1 烟幕）：友方使用指令时，随机对1个敌方目标造成1点伤害。
      // 触发类：真正干活的是 HOOK-2（orderEffect 的「友方使用指令」触发段）
      if(!hasFx(u,'commandoOrder')) u.def.fx = (u.def.fx||[]).concat(['commandoOrder']);
      break; }
    case '游骑兵营': {
      // 英 游骑兵营（金·步兵 3费1油 2/5 奋战）：友方单位造成的非对战、非攻击伤害+1。
      // 光环类：真正干活的是 HOOK-5（damageUnit 的伤害源加成）与 HOOK-6（13 处单位伤害出口）
      if(!hasFx(u,'rangerAura')) u.def.fx = (u.def.fx||[]).concat(['rangerAura']);
      break; }
    case '皇家燧发枪团': {
      // 英 皇家燧发枪团（铜·步兵 3费3油 0/8 守护）：友方使用指令时，将本单位的攻击力和行动花费交换。
      // 触发类：真正干活的是 HOOK-2（orderEffect 的「友方使用指令」触发段）
      if(!hasFx(u,'fusilierSwap')) u.def.fx = (u.def.fx||[]).concat(['fusilierSwap']);
      break; }
    case '十字军Mkll': {
      // 英 十字军Mkll（银·坦克 3费1油 2/3）：友方使用英国指令时，抽1张牌。
      // 触发类：真正干活的是 HOOK-2（orderEffect 的「友方使用指令」触发段）
      if(!hasFx(u,'crusaderDraw')) u.def.fx = (u.def.fx||[]).concat(['crusaderDraw']);
      break; }
    case '血腥第十一团': {
      // 英 血腥第十一团（铁·步兵 4费1油 4/5）：本单位对战并存活后，获得+2+2。
      // 触发类：真正干活的是 HOOK-3（combat 的单位对战分支，反击结算之后）
      if(!hasFx(u,'bloody11Fight')) u.def.fx = (u.def.fx||[]).concat(['bloody11Fight']);
      break; }
    case '彗星A34': {
      // 英 彗星A34（金·坦克 6费2油 6/6 重甲1）：本单位对敌方总部造成伤害时，抽1张牌。
      // 触发类：真正干活的是 HOOK-4（combat 的直击总部分支）
      if(!hasFx(u,'cometDraw')) u.def.fx = (u.def.fx||[]).concat(['cometDraw']);
      break; }
    case '兰开斯特BII': {
      // 英 兰开斯特BII（金·轰炸机 7费3油 5/4 闪击）：本单位对总部造成伤害时，使敌方手牌获得+1花费。
      // 触发类：真正干活的是 HOOK-4（combat 的直击总部分支）
      if(!hasFx(u,'lancasterTax')) u.def.fx = (u.def.fx||[]).concat(['lancasterTax']);
      break; }
    case '威灵顿': {
      // 英 威灵顿（金·轰炸机 7费3油 4/3 闪击）：若在手牌中，友方使用指令时，获得-2花费。
      // 「在手牌中」类效果：单位**不在战场**，故本 case 有意不挂任何战场标记（与 batch-E2 的
      // 「近卫步兵第4团」同口径）。钩子是 HOOK-2 的 me.wellingtonDiscount 计数 + HOOK-7 的
      // playCost 现算扣减，两者都按 card.id / me.hand 判定，**不依赖本 case 的任何一行**。
      // 故这不是「空 case 断线」，而是「无需挂载」——见 PART 5-⑥ 的自查说明。
      break; }
      case '玛蒂尔达MkV': {
      // 玛蒂尔达MkV（英·铜 4费2油 3/5 冲击·重甲1）：本单位冲击后，升为老兵。
      // 挂监听标记，实际结算在 combat 的「冲击移除」分支（老兵形态：4费2油 3/5 老兵·守护·重甲1）
      if(!hasFx(u,'vetMatilda')) u.def.fx = (u.def.fx||[]).concat(['vetMatilda']);
      break; }
    /* ↓↓↓ batch-E2：新增 7 个单位部署效果 ↓↓↓ */
    // 美 F7F虎猫：友方回合结束时，将 1 个「SBD 3 无畏」加入支援阵线。
    case 'F7F虎猫': {
      // 触发时机「友方回合结束」= triggerFriendlyTurnEnd（片段⑤），此处只挂标记（照抄 me163Back 写法）
      if(!hasFx(u,'f7fEnd')) u.def.fx = (u.def.fx||[]).concat(['f7fEnd']);
      break; }
    // 美 M6：每有 1 个攻击力不小于 4 的友方单位，友方总部受到的伤害 -1。
    case 'M6': {
      // 纯光环，无挂载标记（与 perEnemy11 同口径，每次现算）；结算在 applyHqDamage 的 M6 段。
      // 本 case 有意为空（不刷屏）：保留落点，也避免被 effectGaps 误判为未实现。
      break; }
    // 苏 IS-2：本单位被返回手中时，将 1 张复制加入支援阵线。
    case 'IS-2': {
      // 「被返回手中」不是部署时机：实际结算在 handReturnsToHand() → is2BacklineCopy()（片段②）。
      // 这里只挂标记——没有这一行 is2BacklineCopy 永远不命中。
      if(!hasFx(u,'is2Back')) u.def.fx = (u.def.fx||[]).concat(['is2Back']);
      break; }
    // 苏 SU-85：友方苏联坦克攻击时，使友方总部获得 +3 防御力。
        case '威尔士卫队': {
      // 威尔士卫队（英·铁 1费1油 1/2 守护）：部署：使1个目标获得+1防御力。
      // 口径：文档只写「1个目标」（不限归属），故有预选目标就用；无预选时随机 1 个友方单位（含自身）
      //       —— 给敌方加防御力对己方是纯亏，自动结算绝不选敌。
      // 「+1防御力」= maxHp 与当前 hp 同步 +1（既有写法：洛塔组织 lotta / 红茶 tea）
      // 兜底（用户 2026-09-13）：target 已改判 'any' → 类型校验放在这里；不合格的预选目标
      //   toast + return false，卡不消耗（无预选时仍走下面的随机友方兜底，AI/无头不会卡住）
      let t = null;
      if(pick && !pick.hq && findPosOf(pick)) t = pick;
      else if(pick && !pick.hq){ toast('请选择 1 个单位'); return false; }
      if(!t){ const list = allyList(side); if(list.length) t = list[Math.floor(Math.random()*list.length)].u; }
      if(t){ t.maxHp += 1; t.hp += 1; logMsg(u.def.n + ' 部署：' + t.def.n + ' 获得 +1 防御力。'); }
      else logMsg(u.def.n + ' 部署：没有可增益的目标，效果不触发。');
      break; }
    case '北极熊师': {
      // 北极熊师（英·铁 2费1油 1/3 协力·奋战）：部署：上回合友方每部署过1个英国步兵，获得一次+1+1。
      // 计数直接复用「前线观察员」的 gbInfLast（回合开始在 resolveOwnerTurnStart 轮换）——
      // 口径与 gbInfThis 完全一致：只算「从手牌部署的英国步兵（含手牌打出的卫戍）」，
      // 效果生成的卫戍（noDeploy=true）不计。注意 P1：现实现把 Last 压成 0/1，需还原为数量。
      const n = me.gbInfLast || 0;
      if(n > 0){ u.atk += n; u.hp += n; u.maxHp += n; }
      logMsg(u.def.n + ' 部署：上回合友方部署过 ' + n + ' 个英国步兵，获得 +' + n + '/+' + n + '。');
      break; }
    case 'P-40小鹰': {
      // P-40小鹰（英·金 3费2油 2/3）：部署：对1个敌方陆军或总部造成2点伤害。
      // 目标：预选优先（敌方陆军单位，或 hq 且非己方总部——与零战 dmgRand1 的 pick 形状一致）；
      //       无预选时随机 1 个敌方陆军；敌方没有陆军时打总部（总部永远是合法目标）。
      // 直伤总部走 applyHqDamage 总入口（口径 2026-09-13：M6/593 等总部减免对「对敌方总部造成 X 点伤害」一律生效）
      let done = false;
      if(pick && pick.hq && pick.hqSide !== side){
        applyHqDamage(foe, 2); done = true; checkGameOver();
        logMsg(u.def.n + ' 部署：对敌方总部造成 2 点伤害。');
      } else if(pick && !pick.hq && pick.owner !== side && isArmyType(pick.def.t) && findPosOf(pick)){
        damageUnit(pick, 2); done = true;
        logMsg(u.def.n + ' 部署：对 ' + pick.def.n + ' 造成 2 点伤害。');
      }
      if(!done){
        const list = [];
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x && x.owner !== side && isArmyType(x.def.t)) list.push(x); }
        if(list.length){
          const e = list[Math.floor(Math.random()*list.length)];
          damageUnit(e, 2);
          logMsg(u.def.n + ' 部署：对 ' + e.def.n + ' 造成 2 点伤害。');
        } else {
          applyHqDamage(foe, 2);
          logMsg(u.def.n + ' 部署：敌方没有陆军单位，对敌方总部造成 2 点伤害。');
        }
      }
      checkGameOver();
      break; }
    case '边防团': {
      // 边防团（英·铁 3费1油 2/5 奋战）：部署：将1个“卫戍”加入支援阵线。
      // 生成写法沿用「沙尘满目 dustStorm」：makeDerived('garrison') + spawnUnit(side, def, 底线, c, true)
      // —— noDeploy=true：效果生成的卫戍不触发部署特效，也不计入 gbInfThis（与「从手牌部署」口径一致）
      let n = 0;
      const br = backRowOf(side);
      for(let c=0;c<COLS;c++){
        if(S.board[br][c]) continue;
        const g = makeDerived('garrison');
        if(g && spawnUnit(side, g, br, c, true)) n++;
        break; // 只加 1 个
      }
      logMsg(u.def.n + ' 部署：' + (n ? '1 个「卫戍」加入支援阵线。' : '支援阵线已满，「卫戍」无法加入。'));
      break; }
    case '司事火炮': {
      // 司事火炮（英·金 5费2油 3/4）：部署：压制1个敌方单位。友方回合开始时，再次将其压制。
      // 压制沿用 applySuppress（免疫压制者不生效，如实记录）；「再次压制」把目标引用挂在本单位上
      // （u.reSuppressTarget），之后每个友方回合开始时由 resuppressTick(side) 重放（配套补丁 P2）。
      // 本卡离场 → 引用随对象消失；目标离场 → tick 内自动清理，不留悬挂引用。
      let t = null;
      if(pick && !pick.hq && pick.owner !== side){ const p = findPosOf(pick); if(p) t = { u:pick }; }
      if(!t) t = randEnemy();
      if(t){
        if(applySuppress(t.u)){
          u.reSuppressTarget = t.u;
          logMsg(u.def.n + ' 部署：压制 ' + t.u.def.n + '（友方回合开始时将再次压制）。');
        } else logMsg(u.def.n + ' 部署：' + t.u.def.n + ' 免疫压制，效果不触发。');
      } else logMsg(u.def.n + ' 部署：没有敌方单位，效果不触发。');
      break; }
    case '蚊式MkVⅥ': {
      // 蚊式MkVⅥ（英·金 6费2油 4/4）：部署：对1个敌方单位造成3点伤害。
      // 目标与伤害写法沿用 FX-A1 的「京都联队/M10A1」：pick 预选 → randEnemy() 兜底 → damageUnit
      let t = null;
      if(pick && !pick.hq && pick.owner !== side){ const p = findPosOf(pick); if(p) t = { u:pick }; }
      if(!t) t = randEnemy();
      if(t){ damageUnit(t.u, 3); logMsg(u.def.n + ' 部署：对 ' + t.u.def.n + ' 造成 3 点伤害。'); }
      else logMsg(u.def.n + ' 部署：没有敌方单位，效果不触发。');
      checkGameOver();
      break; }
    case '45英寸中型火炮': {
      // 45英寸中型火炮（英·铁 6费2油 3/3）：部署：压制1个敌方单位。
      // 与「M10A1（抑制 1 个敌方单位）」同形，只是把 applySuppress 换成压制（本卡就是压制）
      let t = null;
      if(pick && !pick.hq && pick.owner !== side){ const p = findPosOf(pick); if(p) t = { u:pick }; }
      if(!t) t = randEnemy();
      if(t){
        if(applySuppress(t.u)) logMsg(u.def.n + ' 部署：压制 ' + t.u.def.n + '。');
        else logMsg(u.def.n + ' 部署：' + t.u.def.n + ' 免疫压制，效果不触发。');
      } else logMsg(u.def.n + ' 部署：没有敌方单位，效果不触发。');
      break; }
    case '舍伍德森林人团': {
      // 舍伍德森林人团（英·铁 6费1油 5/6 守护）：部署：将1个单位的复制返回其所有者卡组顶。
      // 「复制」= 本体留在战场，另做 1 张复制进卡组顶（与「女王直属卡梅伦高地人团 bounceTop」
      // 的「把本体移回卡组顶」不同——那是移除，这里是增殖）。
      // 复制写法沿用 bounceTop：JSON 深拷贝 def（含本局对 def 的常驻改动）；卡组顶 = deck 末尾（pop 抽出）。
      // 目标：预选优先（文档只写「1个单位」，用户 2026-09-13 裁定：**任何单位**都能指，
      //       含敌方——复制体进「其所有者」卡组顶，卡对面下一张牌是有意为之的策略）；
      //       无预选时才随机 1 个友方单位（含自身）——自动结算不做「给敌方送牌」的亏本选择。
      //       类型校验兜底：target 已改判 'any' → 不在场的预选目标 toast + return false（卡不消耗）
      let t = null;
      if(pick && !pick.hq && findPosOf(pick)) t = pick;
      else if(pick && !pick.hq){ toast('请选择 1 个单位'); return false; }
      if(!t){ const list = allyList(side); if(list.length) t = list[Math.floor(Math.random()*list.length)].u; }
      if(t){
        playerOf(t.owner).deck.push(JSON.parse(JSON.stringify(t.def)));
        logMsg(u.def.n + ' 部署：将 ' + t.def.n + ' 的 1 张复制置于其所有者卡组顶。');
      } else logMsg(u.def.n + ' 部署：没有可复制的单位，效果不触发。');
      break; }
      case 'SU-85': {
      // 挂载标记 su85Aura：combat 的「本次攻击成立」点按 hasFx 扫它（没有这一行钩子永不命中）。
      if(!hasFx(u,'su85Aura')) u.def.fx = (u.def.fx||[]).concat(['su85Aura']);
      break; }
    // 苏 近卫步兵第4团：若在手中，敌方每抽 1 张牌，获得 -1 花费。
    case '近卫步兵第4团': {
      // 「在手中」类效果不在战场，无需部署标记：计数在 drawCards（片段⑧）、现算在 playCost（片段⑨）。
      break; }
    // 英 第85先锋连：每回合，友方使用的第一张指令具有 -1 花费。
    case '第85先锋连': {
      // 只负责挂载标记 firstOrderMinus1（onboardHasFx 靠它认「在场」）；
      // 减费是**现算**的（playCost 里按 ordersThisTurn===0 + onboardHasFx 判），
      // 所以本回合中途部署也立刻生效——旧写法靠回合开始的缓存标记，部署当回合必然漏掉（用户 2026-09-16 报「没有效果」）。
      if(!hasFx(u,'firstOrderMinus1')) u.def.fx = (u.def.fx||[]).concat(['firstOrderMinus1']);
      break; }
    // 最终 Boss「hana」专用：SUPERMAN 部署时，把**敌方**三张手牌转换为「轻步兵」
    // （卡面/文档：部署：将敌方 3 张手牌转换为「轻步兵」——用户 2026-09-17 纠正：转换的是玩家手牌，不是自己手牌）
    case 'SUPERMAN': {
      const foeS = enemyOf(u.owner);
      // 随机挑 3 张（旧写法从手牌头开始数 → 永远换掉最开始那 3 张，用户 2026-09-17 报「总是转换同 3 个」）
      // 口径（用户 2026-09-17）：**反制牌也参与**——它只是「使用时对面不知道是哪张」，
      // 情报照样能看到、弃牌/**转换**照样能作用到它，不是免疫区。
      const pool = [];
      for(let i=0;i<foeS.hand.length;i++){
        if(foeS.hand[i]) pool.push(i);
      }
      shuffle(pool);
      const chosen = pool.slice(0, 3);
      let nS = 0;
      for(const idx of chosen){
        const d = makeDerived('lightinf');
        if(!d) break;
        d.revealed = true; foeS.hand[idx] = d; nS++;
      }
      logMsg('SUPERMAN：' + (nS ? '敌方 ' + nS + ' 张手牌被转换为「轻步兵」（随机）。' : '敌方手牌不足，未能转换。'));
      break; }
    // 英 M3A3甜心：友方抽 1 张牌时，使友方总部获得 +1 防御力。
    case 'M3A3甜心': {
      // 纯光环，无挂载标记：结算在 drawCards 出口（片段⑧）。
      break; }
    /* ======================= batch-F5：英 新卡部署/被动 ======================= */
    // 英 亨伯MkIV（1费1油 1/2 坦克 奋战·冲击）：卡面效果「无」→ 白板单位，显式登记为空实现
    case '亨伯MkIV':
    // 英 角斗士Mkl（1费1油 1/3 战斗机）：效果「无」
    case '角斗士Mkl':
    // 英 东萨里团（3费1油 2/6 步兵 守护）：效果「无」
    case '东萨里团':
    // 英 布伦亨MkIV（3费2油 2/3 轰炸机）：效果「无」
    case '布伦亨MkIV':
    // 英 瓦伦丁MkI（3费1油 2/4 坦克 奋战）：效果「无」
    case '瓦伦丁MkI': {
      // 白板单位：无 deployment 效果（d: 与卡名一致，空 case 只为 effectGaps 可统计，同 F1「日 白板单位」口径）
      break; }
    // 英 牛津（2费1油 1/3 轰炸机·金）：陆军部署时，使其攻击力等同于其防御力。
    case '牛津': {
      // 触发时机是「别的陆军部署」，不是本单位上线：结算在 spawnUnit 的部署出口 → oxfordEqualize（片段 P1）
      break; }
    // 英 黑卫士兵团（5费1油 2/6 步兵 奋战·守护·银）：敌方指令具有 +2 花费。
    case '黑卫士兵团': {
      // 纯光环（在谁场上就加谁的敌人的价）：结算在 playCost（片段 P2）；
      // 挂 fx 标记供 onboardHasFx 扫场，抑制（applyInhibit 清 def.fx）后失效，与 reddevil 同口径
      if(!hasFx(u,'blackwatchTax')) u.def.fx = (u.def.fx||[]).concat(['blackwatchTax']);
      break; }
    // 英 旋风（6费2油 6/6 战斗机·金）：敌方指向或攻击本单位时，对其总部造成 3 点伤害。
    case '旋风': {
      // 两个触发点都在别处：① 敌方指令指向 → orderEffect 入口（片段 P3）；
      //                            ② 敌方单位攻击 → combat 的目标锁定处（片段 P4）
      if(!hasFx(u,'whirlwindAura')) u.def.fx = (u.def.fx||[]).concat(['whirlwindAura']);
      break; }
    // 英 英俊战士TFMkX（6费2油 4/4 战斗机·金）：其他单位攻击本单位时，先对其造成 3 点伤害。
    case '英俊战士TFMkX': {
      // 触发点在 combat 的伤害交换之前（伏击判定之前）→ 片段 P5
      if(!hasFx(u,'beaufighterPre')) u.def.fx = (u.def.fx||[]).concat(['beaufighterPre']);
      break; }
    /* ↓↓↓ batch-E4：新增 3 个单位效果（触发 / 光环类；均为「部署挂标记 + 既有钩子点生效」） ↓↓↓ */
    // 英 92英寸岸防炮：本单位造成伤害时，使友方总部获得同等防御力。
    case '92英寸岸防炮': {
      // 触发时机「本单位造成伤害」= combat 的 4 个伤害点（片段④）；此处只挂标记。
      // 没有这一行 x92HqHeal() 永远不命中（与菲亚特 G.50 的 g50HqHeal 同写法）。
      if(!hasFx(u,'x92HqHeal')) u.def.fx = (u.def.fx||[]).concat(['x92HqHeal']);
      break; }
    // 英 暴风MkV：敌方回合中，具有 +4 攻击力。
    case '暴风MkV': {
      // 光环挂载：实际结算在 atkOf（片段②，每次现算）——没有这一行永远不命中。
      if(!hasFx(u,'stormAtk4FoeTurn')) u.def.fx = (u.def.fx||[]).concat(['stormAtk4FoeTurn']);
      break; }
    // 英 卡梅伦团：每回合，友方使用第二张指令时，抽 2 张牌。
    case '卡梅伦团': {
      // 光环挂载：实际结算在 orderEffect 的指令计数处（片段⑤-1）；钩子按 onboardHasFx 查在场。
      if(!hasFx(u,'cameron2ndOrder')) u.def.fx = (u.def.fx||[]).concat(['cameron2ndOrder']);
      break; }
  }
}
function emptyBacklineSlot(side, preferCol){
  const r = backRowOf(side);
  if(preferCol!==undefined && !S.board[r][preferCol]) return {row:r,col:preferCol};
  for(let c=0;c<COLS;c++) if(!S.board[r][c]) return {row:r,col:c};
  return null;
}
function moveForward(side, row, col, toCol){
  const u = unitAt(row,col);
  if(!u || u.owner!==side) return false;
  if(row !== backRowOf(side)) return false;
  if(u.suppressed){ logMsg(u.def.n+' 被压制，无法移动！'); return false; }
  if(u.movedThisTurn){ toast('该单位本回合已行动过'); return false; }
  // 移动限制：落地当回合只有闪击/坦克/「可移动并攻击」可行动（与 v1 基线一致：
  // 落地当回合不能移动或攻击，闪击/坦克、「本单位能移动并攻击」除外）。
  // 坦克/「可移动并攻击」的豁免同时适用于「攻击后可再移动」的灵活组合。
  if(u.attackedN > 0 && !isTankUnit(u) && !hasFx(u,'moveNattack')){
    toast('该单位本回合已攻击，不能再移动'); return false;
  }
  if(u.summonedThisTurn && !hasSig(u,'blitz') && !isTankUnit(u) && !hasFx(u,'moveNattack')){
    toast('该单位本回合刚落地，不能移动'); return false;
  }
  const foe = enemyOf(side);
  const occupied = S.board[1].some(x => x && x.owner !== side);
  if(occupied){ toast('前线已被对方占领，无法推进！'); return false; }
  // A43 黑王子：前线至多有 2 个单位
  if(frontCapacityFull(side)){ toast('前线至多只能有 2 个单位（A43 黑王子）'); return false; }
  const fuel = actFuelCost(side, u); // 行动花费（拂晓/逆光可减免）
  if(fuel > 0 && playerOf(side).kredit < fuel){ toast('指挥点不足（推进需 '+fuel+' 点）'); return false; }
  let target = null;
  // 玩家手动推进可指定目标格（点击哪一格就进哪一格）；未指定时按原规则（本列优先，其次任意空位）
  if(toCol !== undefined && toCol !== null && toCol >= 0 && toCol < COLS && !S.board[1][toCol]) target = toCol;
  else if(!S.board[1][col]) target = col;
  else for(let c=0;c<COLS;c++) if(!S.board[1][c]){ target = c; break; }
  if(target === null){ toast('前线已满，无法推进'); return false; }
  playerOf(side).kredit -= fuel;
  S.board[1][target] = u; S.board[row][col] = null;
  u.movedThisTurn = true;
  syncRowSig(u); // 三式中战车：离开支援战线 → 失去伏击/守护
  // 烟幕：进入前线即永久散去（词条移除；攻击后散去仅本回合，见 combat）
  if(hasSig(u,'smoke')){
    u.smokeOut = true;
    if((u.def.sig||[]).indexOf('smoke') >= 0){
      u.def.sig = (u.def.sig||[]).filter(s => s !== 'smoke');
      logMsg(u.def.n + ' 进入前线，烟幕散去（烟幕词条移除）。');
    }
  }
  logMsg(u.def.n + ' 推进到前线' + (fuel?'（耗油 '+fuel+'）':'') + '。');
  sfx('place');
  // F4F-4 野猫：移至前线时，将 1 个 F2A 水牛加入相邻处
  if(hasFx(u,'f4fBuff') && u.hp > 0){
    const adj = (target - 1 >= 0 && !S.board[1][target-1]) ? target-1 : (target + 1 < COLS && !S.board[1][target+1]) ? target+1 : -1;
    if(adj >= 0){
      const d2 = makeDerived('f2a');
      if(d2 && spawnUnit(side, d2, 1, adj)) logMsg(u.def.n + ' 移至前线：1 个「F2A 水牛」加入相邻处。');
    }
  }
  // 第109战斗工兵营：其他友方单位移至前线时，使其获得 +1 攻击力

  if(hasFx(u,'pantherA') && u.hp > 0){
    const foePl = enemyOf(side);
    foePl.drawBanPending = (foePl.drawBanPending || 0) + 1;
    logMsg(u.def.n + ' 移至前线：下个敌方回合开始时，敌方无法抽牌。');
  }
  // 第5步兵团：移至前线时，获得 +1/+1（触发点与 F4F-4 野猫 f4fBuff / 豹式坦克A型 同位置）
  if(hasFx(u,'r5Buff') && u.hp > 0){
    u.atk += 1; u.maxHp += 1; u.hp += 1;
    logMsg(u.def.n + ' 移至前线：获得 +1/+1。');
  }
  eng109Buff(side, u);
  HOOKS.onMoveForward({ side, fromRow:row, fromCol:col, toRow:1, toCol:target, def:u.def }); // 推进动画：UI 播放入位滑行（无头下 no-op）
  // 反制：发现敌人（敌方触发才视做打出；激活状态保留到触发/手动收回）
  if(side==='a' && S.p.counters.includes('spotEnemy')){
    S.p.counterHit.spotEnemy = true;
    drawCards(S.p, 3);
    consumePlayerCounter('spotEnemy');
    logMsg('反制·发现敌人：敌方占领前线，抽 3 张牌！');
  } else if(side==='p' && S.a.counters.includes('spotEnemy')){
    S.a.counterHit.spotEnemy = true;
    S.a.counters = S.a.counters.filter(e => e !== 'spotEnemy');   // 触发即消耗（旧写法漏了这句，AI 的发现敌人会反复触发）
    drawCards(S.a, 3); 
    emitCounterFx('a', 'spotEnemy');
    logMsg('敌方反制·发现敌人：你占领了前线，老牧师抽 3 张牌！');
  }
  applyPanzerGrowth(u); // 豹式：行动后成长
  return true;
}

/* ---------- 死亡 ---------- */
function findUnitByUid(id){
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.uid===id) return {u:x,r,c}; }
  return null;
}
/* 记录「对本单位造成过伤害的单位」（partisan 被动；攻击者必须是场上单位） */
function recordHit(taken, dealtBy){
  if(!taken || !dealtBy || !hasFx(taken,'partisan')) return;
  if(!taken.damagedBy) taken.damagedBy = [];
  if(!taken.damagedBy.includes(dealtBy.uid)) taken.damagedBy.push(dealtBy.uid);
}
let B1_LAST_DEAD_ARMY = null; // 伊尔-10 用：上一个被消灭的友方陆军（def 快照，供亡计复活）
const b1Is = (u, id) => !!u && !!u.def && (((u.def.fx || []).indexOf(id) >= 0) || u.def.deploy === id);
function killUnit(row, col, opts){
  opts = opts || {};
  const u = S.board[row][col];
  if(!u) return;
  const def = u.def;
  S.board[row][col] = null;
  HOOKS.onUnitDeath({ row, col, def }); // 单位死亡：UI 播放死亡动画（无头下 no-op）
  const foe = enemyOf(u.owner);
  // 第158补给营：友方回合中，消灭第一个敌方单位时，获得 2 个指挥点
  // 受益方 = 被消灭单位的对手：foe 是它的**玩家对象**，side 字符串要另算
  // （⚠ 坑：engine 的 enemyOf(side) 返回玩家对象而非 side 字符串，别直接喂给 isTurnOf/onboardHasUnitId）
  // 「消灭」不看出手方（攻击/指令/效果皆算），但必须是受益方自己的回合（isTurnOf），
  // 且每回合只结算一次（foe.supply158Used，HOOK-10 清零）
  const foeSide158 = (u.owner === 'p') ? 'a' : 'p';
  if(!foe.supply158Used && isTurnOf(foeSide158) && onboardHasUnitId(foeSide158, '第158补给营')){
    foe.supply158Used = true;
    foe.kredit += 2;
    logMsg('第158补给营：消灭第一个敌方单位，获得 2 个指挥点（当前 ' + foe.kredit + '）。');
  }
  const b1Prev = B1_LAST_DEAD_ARMY;                // 本次死亡之前的最后阵亡陆军（伊尔-10 用）
  if(isArmyType(u.def.t)) B1_LAST_DEAD_ARMY = def; // 本次阵亡的是陆军 → 更新快照（留 def 即可，复活时深拷贝）
  if(hasFx(u,'deathDraw')){ drawCards(playerOf(u.owner), 1); logMsg(u.def.n+' 亡计：抽 1 张苏联牌'); }
  // 搜索第七联队（s7Death）：亡计——若敌方手中有明牌，抽 1 张牌
  if(hasFx(u,'s7Death')){
    const foeHand = enemyOf(u.owner).hand;
    if(foeHand.some(c => c && c.revealed)){
      drawCards(playerOf(u.owner), 1);
      logMsg(u.def.n+' 亡计：敌方手中有明牌，抽 1 张牌。');
    }
  }
  // 一式战（ki43Death）：亡计——对敌方总部造成 2 点伤害
  if(hasFx(u,'ki43Death')){
    abilityHqDamage(u, foe, 2);
    logMsg(u.def.n+' 亡计：对敌方总部造成 2 点伤害');
    checkGameOver();
  }
  // 游击队（partisan）：亡计——对本回合伤害过自己的存活单位各造成 3 点伤害（常规伤害流程，可触发亡计）
  if(hasFx(u,'partisan') && Array.isArray(u.damagedBy) && u.damagedBy.length){
    for(const id of u.damagedBy){
      const pos = findUnitByUid(id);
      if(pos){ logMsg(u.def.n+' 亡计：对 '+pos.u.def.n+' 造成 3 点伤害'); damageUnit(pos.u, 3, u); }
    }
    checkGameOver();
  }
  // 第164步兵团：亡计——随机使 1 个友方单位获得 +1/+1（只作用于存活的单位，群解中不浪费在将死单位上）
  if(hasFx(u,'r164Death')){
    const allies = allyList(u.owner).filter(t => t.u.hp > 0);
    if(allies.length){
      const t = allies[Math.floor(Math.random()*allies.length)];
      t.u.atk += 1; t.u.hp += 1; t.u.maxHp += 1;
      logMsg(u.def.n+' 亡计：随机使 '+t.u.def.n+' 获得 +1/+1。');
    } else logMsg(u.def.n+' 亡计：没有存活友方单位，效果不触发。');
  }
    if(b1Is(u, '秋田联队')){
    if(b1Is(u, '秋田联队')){
      const b1Aki = enemyList(u.owner).map(t => t.u); // 敌方全部单位
      b1Aki.push({ hq:true });                        // 目标池含敌方总部（同「终焉之行」的 pool 写法）
      const t = b1Aki[Math.floor(Math.random() * b1Aki.length)];
      if(t.hq){ abilityHqDamage(u, foe, 2); logMsg(u.def.n + ' 亡计：对敌方总部造成 2 点伤害。'); }
      else { damageUnit(t, 2, u); logMsg(u.def.n + ' 亡计：对 ' + t.def.n + ' 造成 2 点伤害。'); }
      checkGameOver();
    }
  }
  if(b1Is(u, '水户联队')){
    if(b1Is(u, '水户联队')){
      abilityHqDamage(u, foe, 2); // 与 ki43Death 同一写法（直击敌方总部 + checkGameOver）
      logMsg(u.def.n + ' 亡计：对敌方总部造成 2 点伤害。');
      checkGameOver();
    }
  }
  if(b1Is(u, '试制橘花')){
    if(b1Is(u, '试制橘花')){
      const b1Kf = makeDerived('神风特攻队'); // DERIVED_CARDS 衍生指令，makeDerived 返回指令卡形状（可直接进 deck）
      if(b1Kf){
        const me0 = playerOf(u.owner);
        for(let i = 0; i < 4; i++){
          const pos = me0.deck.length ? Math.floor(Math.random() * (me0.deck.length + 1)) : 0; // 随机位置洗入（同 stirlingCarpet）
          me0.deck.splice(pos, 0, JSON.parse(JSON.stringify(b1Kf)));
        }
        logMsg(u.def.n + ' 亡计：4 张「神风特攻队」洗入卡组。');
      } else logMsg(u.def.n + ' 亡计：未找到「神风特攻队」，效果不触发。');
    }
  }
  if(b1Is(u, 'Ki-49百式重爆吞龙')){
    if(b1Is(u, 'Ki-49百式重爆吞龙')){
      const b1All = [];
      for(let r = 0; r < ROWS; r++) for(let c = 0; c < COLS; c++){ const x = S.board[r][c]; if(x) b1All.push({ u:x, r, c }); }
      let b1N = 0;
      for(const t of b1All){ if(unitAt(t.r, t.c) === t.u){ killUnit(t.r, t.c); b1N++; } }
      logMsg(u.def.n + ' 亡计：消灭所有单位（' + (b1N || '无') + '）。');
    }
  }
  if(b1Is(u, '伊尔-10')){
    if(b1Is(u, '伊尔-10')){
      if(B1_LAST_DEAD_ARMY){
        const b1Slot = emptyBacklineSlot(u.owner); // 支援阵线 = 己方底线，取第一个空位
        if(b1Slot && spawnUnit(u.owner, JSON.parse(JSON.stringify(B1_LAST_DEAD_ARMY)), b1Slot.row, b1Slot.col, true)) // noDeploy：亡计复活不触发部署效果
          logMsg(u.def.n + ' 亡计：' + B1_LAST_DEAD_ARMY.n + ' 返回支援阵线。');
        else logMsg(u.def.n + ' 亡计：支援阵线已满，' + B1_LAST_DEAD_ARMY.n + ' 无法返回。');
      } else logMsg(u.def.n + ' 亡计：没有可返回的友方陆军，效果不触发。');
    }
  }
// 仙台联队：离场时返回被绑定单位
  if(u.bound && u.bound.u){
    const b = u.bound;
    if(!S.board[b.r][b.c]){ S.board[b.r][b.c] = b.u; logMsg('仙台联队离开战场，'+b.u.def.n+' 返回！'); }
  }
  // 7075铝：亡计——将 1 张本单位的复制加入手中，使其花费为 0（复制带同一标记，可继续连锁）
  if(hasFx(u,'a6m2Clone')) r2CloneToHand(u);
  // 工兵第329营 / 通信第一联队：1 个其他友方单位被消灭时触发
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const w = S.board[r][c];
    if(!w || w.owner !== u.owner || w === u) continue;
    if(hasFx(w,'eng329')){ const me2 = playerOf(w.owner); me2.maxHp += 2; me2.hp += 2; logMsg(w.def.n + '：友方单位被消灭，友方总部 +2 防御力。'); }
    if(hasFx(w,'comm1')){ const f3 = enemyOf(w.owner); abilityHqDamage(w, f3, 1); logMsg(w.def.n + '：友方单位被消灭，对敌方总部造成 1 点伤害。'); }
  }
  sfx('kill');
}

/* A43 黑王子：前线至多有 2 个单位（该方场上存在此单位时生效） */
function frontCapacityFull(side){
  let cap = COLS;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && hasFx(x,'frontMax2')) cap = Math.min(cap, 2); }
  let n = 0;
  for(let c=0;c<COLS;c++){ const x=S.board[1][c]; if(x && x.owner===side) n++; }
  return n >= cap;
}
/* 单位扣血统一入口：伤害、受伤抽牌（搜索第33联队：指令/反击/伏击/拦截等任何伤害都触发）、死亡 */
/* batch-E3：新增第 3 参数 srcU = 造成伤害的友方单位（缺省 = 非单位来源，不加成）。
   combat() 内的伤害调用一律**不传** srcU（攻击/对战伤害，游骑兵营不加成）；见 HOOK-6 的调用点清单。 */
function damageUnit(u, dmg, srcU){
  if(!u || dmg <= 0) return;
  // 游骑兵营：友方单位造成的非对战、非攻击伤害 +1（srcU 由调用点显式传入）
  if(srcU){
    const boosted = rangerBoost(srcU, dmg);
    if(boosted !== dmg) logMsg('游骑兵营：友方单位造成的非对战、非攻击伤害 +1（' + dmg + ' → ' + boosted + '）。');
    dmg = boosted;
  }
  u.hp -= dmg;
  if(hasFx(u,'onDamagedDraw')){ drawCards(playerOf(u.owner), 1); logMsg(u.def.n+' 受到伤害：抽 1 张牌'); }
  if(u.hp <= 0){ for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===u){ killUnit(r,c); return; } }
}

/* ---------- 攻击目标 ---------- */
function smokeHidden(x){ return !!x && !x.smokeOut && (hasSig(x,'smoke') && !x.movedThisTurn && !x.attackedN && !x.summonedThisTurn); }
function attackTargets(side, row, col){
  const u = unitAt(row,col);
  if(!u) return [];
  if(hasFx(u,'noAttack')) return []; // batch-F4·BP-43装甲列车：无法攻击（列表为空 → UI/AI/combat 都无法用它发起攻击）
  const foe = enemyOf(side);
  const foeBack = backRowOf(side === 'p' ? 'a' : 'p'); // 敌底线行（用字符串侧）
  const out = [];
  const t = u.def.t;
  // 烟幕：无法被攻击，移动或攻击后失去（smokeOut=true 表示已散去 → 可被攻击）。
  // 修复 F1（QA t3 报告）：原实现把 smokeOut 当"仍在烟幕"，导致行动后永久不可被攻击。
  // 敌方守护位置（规则.txt：与守护单位相邻的非守护单位无法被轰炸机和炮兵以外的单位攻击）
  // t19GuardBreak：被九七式战攻击过的单位失去守护（guardLost）——不再保护相邻单位/总部
  const enemyGuards = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side && hasSig(x,'guard') && !x.guardLost) enemyGuards.push({r,c}); }
  const guardInBack = enemyGuards.some(g => g.r === foeBack); // 底线守护才保护总部
  const canHitGuarded = (t === 'bomber' || t === 'artillery');
  const isProtected = (r,c) => {
    const x = S.board[r][c];
    if(!x || hasSig(x,'guard')) return false;
    if(canHitGuarded) return false;
    // 前线守护不保护后线
    return enemyGuards.some(g => Math.abs(g.r-r)+Math.abs(g.c-c) === 1 && !(g.r === 1 && r === foeBack));
  };
  const addUnit = (r,c)=>{ const x=S.board[r][c]; if(x && x.owner!==side && !smokeHidden(x) && !isProtected(r,c)) out.push({row:r, col:c, kind:'unit'}); };
  // 拦截（轰炸机）：敌方战斗机所在战线 = 轰炸禁区——轰炸机不能攻击该战线上的非战斗机单位
  // （战斗机本身可攻击=狗斗）；敌底线被遮蔽时也无法直击总部。拦截是目标限制，不是伤害。
  if(t === 'bomber'){
    const shieldRows = [];
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side && x.def.t==='fighter' && !smokeHidden(x)){ if(!shieldRows.includes(r)) shieldRows.push(r); } }
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const x=S.board[r][c];
      if(!x || x.owner===side || smokeHidden(x) || isProtected(r,c)) continue;
      if(x.def.t !== 'fighter' && shieldRows.includes(r)) continue; // 被战斗机遮蔽的战线：非战斗机目标不可打
      out.push({row:r, col:c, kind:'unit'});
    }
    if(!shieldRows.includes(foeBack) && !foe.hqSmoke) out.push({hq:true, kind:'hq'}); // 底线被战斗机遮蔽：总部不可炸
    if(hasFx(u,'noHq') && !u.ignoreNoHq) return out.filter(x=>!x.hq);
    return out;
  }
  if(t === 'fighter' || t === 'artillery'){
    // 战斗机/炮兵：可攻击任意战线的目标
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) addUnit(r,c);
  } else {
    // 步兵/坦克：只能攻击相邻战线（前线→敌底线；底线→敌前线）
    const targetRow = (row === 1) ? foeBack : 1;
    for(let c=0;c<COLS;c++) addUnit(targetRow,c);
  }
  // 总部：非守护单位不能阻止攻击总部——只有底线守护能阻止（炮兵/轰炸机可越过守护直击）；
  // 地面单位只有在前线才能直击总部（底线步兵不能隔空打总部）
  const hqAllowed = (t === 'fighter' || t === 'bomber' || t === 'artillery') || row === 1;
  const guardedHq = guardInBack && !canHitGuarded;
  if(hqAllowed && !guardedHq && !foe.hqSmoke) out.push({hq:true, kind:'hq'});
  // 四一式山炮：无法攻击敌方总部（只剔除总部，不影响单位目标）
  if(hasFx(u,'noHq') && !u.ignoreNoHq) return out.filter(x=>!x.hq);
  return out;
}
function canAct(u){
  if(!u) return false;
  if(hasFx(u,'noAttack')) return false; // batch-F4·BP-43装甲列车：无法攻击（UI 置灰、AI 不选它攻击；推进不受影响）
  if(u.summonedThisTurn && !hasSig(u,'blitz')) return false; // 落地回合禁行动（闪击可落地就行动）
  if(u.suppressed) return false;
  // 闪击/奋战都不是坦克：移动后不能再攻击（只有坦克/「可移动并攻击」能移动后攻击）
  if(u.movedThisTurn && !isTankUnit(u) && !hasFx(u,'moveNattack')) return false;
  // SUPERTANK（hana 专用）：处于前线时不受「每回合攻击一次」限制（可无限次攻击）
  if(hasFx(u,'infiniteFrontline')){
    for(let c=0;c<COLS;c++){ if(S.board[1][c] === u) return true; }
  }
  if(hasSig(u,'fight')) return u.attackedN < 2;
  if(u.attackedN >= 1) return false;
  return true;
}

/* AI 推进前的可行性判定（用户 2026-09-17：AI 在推不动的局面硬推 → 那一步白费，看着像浪费一回合）：
   与 moveForward 的前置条件保持一致——推不上去就别试，别在玩家屏幕上弹「无法推进」。
   ① 前线被对方占领 ② 前线已满（含 A43 黑王子容量）③ **本列已被己方占着**（旧行为会横move到别的空列，
   单位平移到不相干的一列，既没占住本列也浪费了这次行动）④ 油费付不起 ⑤ 本回合已行动/刚落地且无闪击 */
function aiCanPushUp(side, u, col){
  if(!u || u.owner !== side) return false;
  if(u.suppressed || u.movedThisTurn) return false;
  if(u.attackedN > 0 && !isTankUnit(u) && !hasFx(u,'moveNattack')) return false;
  if(u.summonedThisTurn && !hasSig(u,'blitz') && !isTankUnit(u) && !hasFx(u,'moveNattack')) return false;
  if(S.board[1].some(x => x && x.owner !== side)) return false;
  if(frontCapacityFull(side)) return false;
  if(S.board[1][col]) return false;
  const fuel = actFuelCost(side, u);
  if(fuel > 0 && playerOf(side).kredit < fuel) return false;
  return true;
}
/* ---------- 战斗 ---------- */
function combat(att, tgt){
  const a = unitAt(att.row, att.col);
  if(!a || !canAct(a)) return false;
  // 红魔空降步兵团：敌方攻击本单位时 +1 行动花费（花费不够则不能攻击）
  const tgtU = tgt && tgt.hq ? null : (tgt ? unitAt(tgt.row, tgt.col) : null);
  const actCost = actFuelCost(a.owner, a) + (tgtU ? targetSurcharge(a.owner, tgtU) : 0);
  if(actCost > 0){
    const me = playerOf(a.owner);
    if(me.kredit < actCost){ toast('指挥点不足（攻击需 '+actCost+' 点）'); return false; }
  }
  const valid = attackTargets(a.owner, att.row, att.col);
  let ok = valid.some(v => (v.hq ? tgt.hq : (v.row===tgt.row && v.col===tgt.col)));
  // 反制·极寒陷阱（芬）：敌方单位攻击时，加入 1 张「游击队员」并使其成为攻击目标
  if(a.owner === 'a' && !tgt.hq && S.p.counters.includes('frostTrap') && !S.p.counterHit.frostTrap){
    const def = makeDerived('guerrilla');
    let placedAt = null;
    const cands = [[tgt.row-1,tgt.col],[tgt.row+1,tgt.col],[tgt.row,tgt.col-1],[tgt.row,tgt.col+1]]
      .filter(([r,c]) => r>=0 && r<ROWS && c>=0 && c<COLS && !S.board[r][c]);
    if(cands.length){ const [r,c] = cands[Math.floor(Math.random()*cands.length)]; if(spawnUnit('p', def, r, c)) placedAt = { row:r, col:c }; }
    if(!placedAt){ const br = backRowOf('p'); for(let c=0;c<COLS;c++) if(!S.board[br][c]){ if(spawnUnit('p', def, br, c)){ placedAt = { row:br, col:c }; break; } } }
    if(placedAt){
      S.p.counterHit.frostTrap = true;
      consumePlayerCounter('frostTrap');
      tgt = placedAt; ok = true;
      logMsg('反制·极寒陷阱：1 张「游击队员」加入战场并成为攻击目标。');
    }
  }
  // 反制·误伤（芬）的结算挪到下方「攻击已成立（扣费/attackedN 已记）」之后 —— 见 misdirect 分支
  if(!ok){
    // 总部烟幕（深水炸弹）：目标是带烟幕的总部时给一句明确提示（attackTargets 已把它剔除，
    // 这里只负责「说清楚为什么点不动」，用户 2026-09-17：总部有烟幕不该被单位直接攻击）
    if(tgt && tgt.hq && enemyOf(a.owner).hqSmoke) toast('敌方总部被烟幕遮蔽，无法攻击！');
    else toast('无法攻击该目标');
    return false;
  }
  // SU-85：友方苏联坦克攻击时，使友方总部获得 +3 防御力
  // （扫描写法 = perEnemy11 的全盘扫描；增益写法 = g50HqHeal）
  // 触发点选在「目标校验通过」处：与攻击是否造成伤害无关（对 0 攻单位、被重甲减到 0、
  // 冲击抵消等情形一律照常触发）。卡面未写「其他」，故 SU-85 自己攻击时也触发。
  // 口径（用户 2026-09-13）：限「**友方苏联坦克**」→ 国籍判定按**本次攻击者** a 判
  //（苏85 本身只是光环源；SU-85 自身是苏械，故自带光环时自己攻击也满足「苏联」）。
  if(isTankUnit(a) && a.def.nation === 'su'){
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const su = S.board[r][c];
      if(su && su.owner===a.owner && hasFx(su,'su85Aura')){
        const m3 = playerOf(a.owner);
        m3.maxHp += 3; m3.hp += 3;
        logMsg('SU-85：友方坦克 ' + a.def.n + ' 攻击，友方总部获得 +3 防御力。');
      }
    }
  }
  a.attackedN++;
  if(actCost > 0){ playerOf(a.owner).kredit -= actCost; } // 攻击消耗行动花费
  if(hasSig(a,'smoke')) a.smokeOut = true;
  let proc = false; // 「攻击有 50% 概率 +1 伤害」（喀秋莎）：本次是否触发额外伤害（UI 音效分支用）
  /* 反制·误伤（芬，friendlyFire）：**敌方单位一发起攻击就生效**（打我的单位、打我的总部都算），
     把这次伤害整份转移到「自己人」身上 —— 随机 1 个其他敌方单位，或**敌方总部**（用户 2026-09-16：
     「目标包括总部」）。口径：原目标一点血都不掉；被打偏的目标不反击、不触发伏击（自己人之间不发生交战）；
     伤害量沿用常规攻击的算法（光环 + Hs129 对陆 +2 / 对总部 vsHq3 / 50% 额外 1 点 / 目标重甲减免）。
     历史缺陷（2026-09-16 修）：旧写法只把 tgt 改到自己人身上，往下走会撞上
     `if(d.owner === a.owner) return false` 的早退 → 卡面费用与攻击行动都消耗了，伤害却凭空消失。 */
  if(a.owner === 'a' && S.p.counters.includes('friendlyFire') && !S.p.counterHit.friendlyFire){
    const mates = allyList('a').filter(t => t.u !== a)
      .map(t => ({ hq:false, u:t.u, row:t.r, col:t.c }));
    mates.push({ hq:true });                                  // 敌方总部同样算「其他敌方目标」
    const pick = mates[Math.floor(Math.random()*mates.length)];
    S.p.counterHit.friendlyFire = true;
    consumePlayerCounter('friendlyFire');
    let dd = atkOf(a) + (hasFx(a,'hs129Atk') ? 2 : 0) + (pick.hq && hasFx(a,'vsHq3') ? 3 : 0);
    if(hasFx(a,'chanceExtra1') && Math.random()<0.5){ dd += 1; proc = true; }
    if(!pick.hq && hasFx(a,'vsArmy3') && isArmyType(pick.u.def.t)) dd += 3;
    if(!pick.hq && hasFx(a,'vsTank2x') && isTankUnit(pick.u)) dd *= 2;
    let killed = false;
    if(pick.hq){
      const own = playerOf(a.owner);                          // 打偏到自己总部：走总部伤害入口（含爆炸钩子）
      applyHqDamage(own, dd);
      logMsg('反制·误伤：' + a.def.n + ' 这一击打偏了——' + dd + ' 点伤害落到自己总部！');
    } else {
      if(pick.u.armor) dd = Math.max(0, dd - pick.u.armor);
      if(dd > 0){ recordHit(pick.u, a); damageUnit(pick.u, dd); }
      killed = pick.u.hp <= 0;
      logMsg('反制·误伤：' + a.def.n + ' 这一击打偏了——' + pick.u.def.n + ' 受到 ' + dd + ' 点伤害' + (killed ? '，被消灭！' : '。'));
      if(killed) killUnit(pick.row, pick.col);
    }
    HOOKS.onAttack({ hq:!!pick.hq, hqSide:pick.hq ? 'a' : undefined, atkRow:att.row, atkCol:att.col,
      tgtRow:pick.row, tgtCol:pick.col, dd, rd:0, atkN:a.def.n, atkDef:a.def, tgtDef:pick.hq ? null : pick.u.def, proc, killed, misdirect:true });
    sfx('hit');
    applyPanzerGrowth(a);   // 豹式：行动后成长（这次行动确实发生了）
    render(); checkGameOver();
    return true;
  }
  if(tgt.hq){
    let dmg = atkOf(a) + (hasFx(a,'hs129Atk') ? 2 : 0) + (hasFx(a,'vsHq3') ? 3 : 0); // Hs 129/P-40：对抗总部 +2/+3
    if(hasFx(a,'chanceExtra1') && Math.random()<0.5){ dmg += 1; proc = true; }
    const foe = enemyOf(a.owner);
    if(S.p.counters.includes('hqCap') && a.owner==='a' && dmg>1){ dmg = 1; S.p.counterHit.hqCap = true; consumePlayerCounter('hqCap'); logMsg('反制·国家消防局：伤害被压至 1！'); }
    if(S.a.counters.includes('hqCap') && a.owner==='p' && dmg>1){ dmg = 1; S.a.counterHit.hqCap = true; S.a.counters = S.a.counters.filter(e => e !== 'hqCap'); emitCounterFx('a', 'hqCap'); }
    const hqHpBefore = foe.hp;
    applyHqDamage(foe, dmg);
    // 豹式坦克D型（用户 2026-09-17 拍板）：直击总部 = **2 次伤害** —— 攻击本身一次 + 特效「造成的伤害
    // 也会施加到敌方总部」再结算一次（7 攻即 7+7=14）。两次分开走 applyHqDamage：
    // 593通信连/M6 这类「每次伤害减 N」的减免各算一次，M26潘兴的总部下限也按第二次的剩余空间收口。
    let dmgExtra = 0;
    if(hasFx(a,'pantherD')){
      applyHqDamage(foe, dmg);
      dmgExtra = dmg;
      logMsg(a.def.n + '：攻击总部的伤害结算 2 次（+' + dmg + '）。');
    }
    const hqApplied = hqHpBefore - foe.hp; // 实际落地伤害（M26潘兴的总部下限/西苏精神转伤都可能把它压到 0）
    x92HqHeal(a, hqApplied); // 92英寸岸防炮：按「实际造成的伤害」给友方总部加防御力
    logMsg(a.def.n + ' 直击总部，造成 ' + (dmg + dmgExtra) + ' 点伤害' + (dmgExtra ? '（2 次结算）' : '') + '！');
    // 彗星A34：本单位攻击敌方总部时，抽 1 张牌
    // 口径（用户 2026-09-13）：判「是否攻击到敌方总部」，与最终扣了多少血无关
    //（被国家消防局压到 1、被 M26/西苏/减免压到 0 一律照常触发）→ 不再前置 hqApplied > 0。
    // 【集成合并】batch-E1 的九二式重装甲车已在此处插入 hqHpBefore/hqApplied 快照壳，
    //   本段复用同一对变量（原本叫 hqBeforeE3/hqAppliedE3），避免叠两层重复快照；语义逐字等价。
    if(hasFx(a,'cometDraw')){
      drawCards(playerOf(a.owner), 1);
      logMsg(a.def.n + '：攻击敌方总部，抽 1 张牌。');
    }
    // 兰开斯特BII：本单位攻击敌方总部时，使敌方手牌获得 +1 花费
    // （口径同上：判「是否攻击到敌方总部」，不看实际落地伤害；+1 写在手牌对象的 blood 上，
    //   与「武装抵抗」翻倍敌方手牌花费同一写法）
    if(hasFx(a,'lancasterTax')){
      const taxHand = enemyOf(a.owner).hand.filter(c => c);
      taxHand.forEach(c => { c.blood = (c.blood || 0) + 1; });
      logMsg(a.def.n + '：敌方 ' + taxHand.length + ' 张手牌花费 +1。');
    }
    // 九二式重装甲车：本单位对敌方总部造成伤害后，获得 +1 攻击力（常驻成长，与豹式 tankGrowth 同为累加 u.atk）
    if(hqApplied > 0 && a.def && a.def.id === '九二式重装甲车' && !a.inhibited){
      a.atk += 1;
      logMsg(a.def.n + '：对敌方总部造成伤害，获得 +1 攻击力（现 ' + atkOf(a) + '）。');
    }
    // UI 飘字：两次结算就飘两个数字（用户 2026-09-17：飘字应当是 2 次 7），不是合成一个 -14
    const hqHits = dmgExtra > 0 ? [dmg, dmgExtra] : null;
    HOOKS.onAttack({ hq:true, hqSide:a.owner==='p'?'a':'p', atkRow:att.row, atkCol:att.col, dd:dmg + dmgExtra, ddHits:hqHits, rd:0, atkN:a.def.n, atkDef:a.def, proc, killed:false });
    sfx('hit');
    // 对战伤害 ≠ 攻击总部：STZ-5喀秋莎只在对战（攻击单位）时生成「爆破」，直击总部不生成
    meteorAfterFight(a); // 流星：攻击（含直击总部）后移除本单位，双倍复制洗入卡组
    applyPanzerGrowth(a); // 豹式：行动后成长
    // Bf 109G 古斯塔夫 FI：攻击敌方总部时，从敌方卡组抽 1 张牌（回合结束时弃掉）
    if(hasFx(a,'mt208')){
      const foeSide2 = a.owner === 'p' ? 'a' : 'p';
      const foePl = playerOf(foeSide2), mePl = playerOf(a.owner);
      if(foePl.deck.length && mePl.hand.length < MAX_HAND){
        const stolen = foePl.deck.pop();
        stolen.mt208Stolen = true;
        mePl.hand.push(stolen);   // 「从敌方卡组抽到」= 抽牌口径，不明牌
        mePl.mt208Stolen = (mePl.mt208Stolen || []).concat([stolen]);
        logMsg('Bf 109G：从敌方卡组抽到「' + stolen.n + '」（回合结束时弃掉）。');
      } else if(!foePl.deck.length) logMsg('Bf 109G：敌方卡组已空。');
    }
    // 豹式坦克D型：攻击总部时同样结算（伤害已含在 dmg 中，无需重复）
    render(); checkGameOver();
    return true;
  }
  const d = unitAt(tgt.row, tgt.col);
  if(!d || d.owner === a.owner) return false;
  d.hitThisRound = true; // 卫戍：被敌方单位攻击过（任何攻击方式）→ 其所有者回合开始不再触发 HQ 伤害

  // 旋风（英）：敌方单位攻击本单位时，对其总部造成 3 点伤害
  // 触发点在目标锁定之后（与本次攻击是否造成伤害无关：0 攻、被重甲减到 0、冲击抵消都照常触发）
  if(hasFx(d,'whirlwindAura')){
    applyHqDamage(playerOf(a.owner), 3);
    logMsg('旋风：' + a.def.n + ' 攻击本单位，' + (a.owner === 'p' ? '你' : '老牧师') + '的总部受到 3 点伤害。');
    checkGameOver();
  }

  // 九七式战（t19GuardBreak）：被本单位攻击的单位失去守护，直到回合结束
  if(hasFx(a,'t19GuardBreak')){ d.guardLost = true; if(hasSig(d,'guard')) logMsg(d.def.n+' 被 '+a.def.n+' 击中，失去守护！'); }
  // 伏击：先手反击（每回合首次）。炮兵攻击不触发伏击；轰炸机不触发地面单位的伏击，但攻击战斗机（零战）时触发（空中格斗）
  let ambushed = false;
  let atkTaken = 0; // 本次攻击行动中攻击者受到的伤害（伏击+反击，用于可见特效）
  const hasImpact = hasSig(a,'impact'); // 冲击：被攻击单位不会造成任何反击伤害
  const canTriggerAmbush = a.def.t !== 'artillery' && !(a.def.t === 'bomber' && d.def.t !== 'fighter');

  // 英俊战士TFMkX（英）：其他单位攻击本单位时，先对其造成 3 点伤害
  // 触发点在同一次攻击的伤害交换之前（伏击/反击之前）；攻击者被这 3 点消灭 → 本次攻击作废，
  // 直接 return（写法与同文件的「伏击消灭攻击者」分支一致）。
  if(hasFx(d,'beaufighterPre')){
    recordHit(a, d);
    damageUnit(a, 3);
    atkTaken += 3;
    logMsg(d.def.n + '：先对攻击者 ' + a.def.n + ' 造成 3 点伤害。');
    if(a.hp <= 0){
      logMsg(a.def.n + ' 在开火前被消灭！');
      killUnit(att.row, att.col);
      render(); checkGameOver();
      return true;
    }
  }

  if(canTriggerAmbush && hasSig(d,'ambush') && !d.ambushUsed){
    d.ambushUsed = true; ambushed = true;
    let rd = atkOf(d);
    if(hasImpact) rd = 0; // 冲击：伏击反击也被完全抵消
    if(a.armor) rd = Math.max(0, rd - a.armor);
    if(rd > 0){ recordHit(a, d); damageUnit(a, rd); atkTaken += rd; logMsg(d.def.n+' 伏击反击，'+a.def.n+' 受到 '+rd+' 点伤害'); x92HqHeal(d, rd); }
    if(a.hp <= 0){ logMsg(a.def.n + ' 被伏击消灭！'); killUnit(att.row, att.col); return true; }
  } else if(a.def.t === 'artillery' && hasSig(d,'ambush') && !d.ambushUsed){
    // 炮兵攻击破除伏击：不触发反击，但该伏击单位本回合的伏击失效（后续攻击不再被伏击）
    d.ambushUsed = true;
    logMsg(d.def.n + ' 的伏击被炮兵攻击破除（本回合不再伏击）。');
  }
  // 攻击者伤害（含效果修正；光环加成常驻生效）
  a._vsAir = (d.def.t === 'fighter' || d.def.t === 'bomber');   // 马基 C.205：对战空军 +2
  a._vsStronger = (atkOf(d) > atkOf(a));                         // T-26 FI：对战更高攻击力单位 +2
  let dd = atkOf(a);
  a._vsAir = false; a._vsStronger = false;
  if(hasFx(a,'vsArmy3') && isArmyType(d.def.t)) dd += 3;
  if(hasFx(a,'hs129Atk') && isArmyType(d.def.t)) dd += 2; // Hs 129：对抗陆军 +2
  if(hasFx(a,'vsTank2x') && isTankUnit(d)) dd *= 2;
  if(hasFx(a,'chanceExtra1') && Math.random()<0.5){ dd += 1; proc = true; }
  if(d.armor) dd = Math.max(0, dd - d.armor);
  let killed = false;
  if(dd > 0){
    recordHit(d, a); damageUnit(d, dd); killed = d.hp <= 0;
    x92HqHeal(a, dd); // 92英寸岸防炮：对单位造成伤害（与下一行 G.50 同点，两卡可同时在场）
    // 菲亚特 G.50：本单位造成伤害时，使友方总部获得同等防御力
    if(hasFx(a,'g50HqHeal')){ const m2 = playerOf(a.owner); m2.maxHp += dd; m2.hp += dd; logMsg(a.def.n + '：友方总部获得 +' + dd + ' 防御力。'); }
    // 豹式坦克D型：造成的伤害也会施加到敌方总部
    if(hasFx(a,'pantherD')){ const f2 = enemyOf(a.owner); applyHqDamage(f2, dd); logMsg(a.def.n + '：对敌方总部也造成 ' + dd + ' 点伤害。'); checkGameOver(); }
    // 游击队员：消灭受到本单位对战伤害的单位
    if(hasFx(a,'guerrillaKill') && d.hp > 0 && d.hp < d.maxHp){ const p2 = findPosOf(d); if(p2){ logMsg(a.def.n + '：消灭受伤的 ' + d.def.n + '。'); killUnit(p2.r, p2.c); killed = true; } }
  }
  // STZ-5喀秋莎：造成对战伤害时，将等量的「爆破」加入手牌
  if(hasFx(a,'stzGen') && dd > 0){ const pl = playerOf(a.owner); let got=0; for(let i=0;i<dd;i++){ if(pl.hand.length>=MAX_HAND) break; handPushRevealed(pl, makeBaopo()); got++; } if(got) logMsg(a.def.n+'：'+got+' 张「爆破」加入手牌。'); }
  // 反击（单位交换，按规则.txt）：任何位置的近战交换都有反伤；目标被消灭也反击（临死反伤）；炮兵攻击不受伤；轰炸机仅攻击战斗机时受反击；轰炸机被攻击不反击；重甲减反击
  if(!ambushed && d.def.t !== 'bomber'){
    const attRetal = uNeedRetal(a) || (a.def.t === 'bomber' && d.def.t === 'fighter');
    if(attRetal){
      let rd = atkOf(d);
      if(hasImpact) rd = 0; // 冲击：被攻击单位不会造成任何反击伤害
      if(a.armor) rd = Math.max(0, rd - a.armor);
      if(rd > 0){ recordHit(a, d); damageUnit(a, rd); atkTaken += rd; x92HqHeal(d, rd); } // 先记录伤害来源，再结算（致死时亡计才能反伤）；x92HqHeal=92英寸岸防炮反击
    }
  }
  // 血腥第十一团：本单位对战并存活后，获得 +2/+2
  // 触发点 = 单位对战分支（直击总部在上方已 return，天然排除）；「并存活」= 反击结算后 a.hp > 0。
  // 目标是否被消灭不影响（卡面只说本单位存活）；与 panzerActs / 红牛师 同属常驻成长。
  if(a.hp > 0 && hasFx(a,'bloody11Fight')){
    a.atk += 2; a.hp += 2; a.maxHp += 2;
    logMsg(a.def.n + '：对战后存活，获得 +2/+2（现 ' + a.atk + '/' + a.hp + '）。');
  }
  logMsg(a.def.n + ' 攻击 ' + d.def.n + '（造成 ' + dd + ' 点伤害' + (killed ? '，消灭！' : '') + '）');
  sfx('hit');
  if(killed){
    let overflow = -d.hp; // 溢出于目标剩余生命的部分
    const seized = hasSig(a,'seize') && a.owner !== d.owner ? d : null;   // 收缴：消灭敌方单位时留档
    killUnit(tgt.row, tgt.col);
    if(seized) seizeCopy(a.owner, seized);
    // 第7步枪兵团：攻击并消灭 1 个单位时升为老兵（老兵形态 5/5，词条：老兵；升为老兵时对敌方总部造成 3 点伤害）
    if(hasFx(a,'r7Vet') && a.hp > 0){
      promoteR7(a);
      const foe = enemyOf(a.owner);
      abilityHqDamage(a, foe, 3);
      logMsg('第7步枪兵团 升为老兵！对敌方总部造成 3 点伤害。');
      checkGameOver();
    }
    // 第142步兵团：本单位消灭 1 个敌方单位时，使友方总部获得 +2 防御力
    // 口径：不要求 a.hp>0 —— 本次交换同归于尽时「消灭」事实仍成立（对照 r7Vet 要求存活是因为
    //   死人无法升老兵；此处只是给总部加防御）。总部 +防御 沿用 eng329 的 maxHp/hp 同加写法。
    // 目标 d 必为敌方（上方有 d.owner === a.owner 的早退），故无需再判归属。
    if(a.def && a.def.id === '第142步兵团' && !a.inhibited){
      const m142 = playerOf(a.owner);
      m142.maxHp += 2; m142.hp += 2;
      logMsg(a.def.n + '：消灭 ' + d.def.n + '，友方总部 +2 防御力。');
    }
    if(hasFx(a,'overflowHq') && overflow > 0){
      const foe = enemyOf(a.owner);
      applyHqDamage(foe, overflow);
      logMsg('伊尔-28M：溢出 ' + overflow + ' 点伤害转移到敌方总部！');
    }
  }
  // 搜索第33联队：受伤抽牌已在 damageUnit 内统一处理（指令/反击/伏击/拦截等任何伤害均触发）
  if(a.hp <= 0){ killUnit(att.row, att.col); }
  // 冲击：攻击单位后移除冲击（无法失去冲击的单位保留，如 T-34-85）
  if(hasSig(a,'impact') && !hasFx(a,'keepImpact')){
    a.def.sig = (a.def.sig||[]).filter(s=>s!=='impact');
    logMsg(a.def.n + ' 发起攻击后失去了冲击。');
    // 玛蒂尔达MkV：本单位冲击后，升为老兵（本人仍存活才算；老兵形态：3/5 老兵·守护·重甲1）
    if(a.hp > 0 && hasFx(a,'vetMatilda')) promoteToVeteran(a);
  }
  meteorAfterFight(a); // 流星：攻击后移除本单位，双倍复制洗入卡组
  applyPanzerGrowth(a); // 豹式：行动后成长
  HOOKS.onAttack({ hq:false, atkRow:att.row, atkCol:att.col, tgtRow:tgt.row, tgtCol:tgt.col, dd, rd:atkTaken, atkN:a.def.n, atkDef:a.def, tgtDef:d.def, proc, killed });
  render(); checkGameOver();
  return true;
}
/* 流星（英）：本单位攻击后，移除本单位；将 1 张具有双倍攻击力和防御力的复制加入卡组（随机位置） */
function meteorAfterFight(a){
  if(!a || !hasFx(a,'meteorAfter')) return;
  const pos = (()=>{ for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===a) return {r,c}; return null; })();
  if(pos) S.board[pos.r][pos.c] = null;
  // 复制品按攻击时的当前数值翻倍（含本局增益），而非固定翻卡面基础值
  const copy = JSON.parse(JSON.stringify(a.def));
  copy.atk = Math.max(1, a.atk) * 2;
  copy.hp = Math.max(1, a.maxHp) * 2;
  const me = playerOf(a.owner);
  const at = me.deck.length ? Math.floor(Math.random()*(me.deck.length+1)) : 0;
  me.deck.splice(at, 0, copy);
  logMsg('流星：攻击后移除本单位，按当前数值（⚔' + a.atk + '/❤' + a.maxHp + '）翻倍复制（⚔' + copy.atk + '/❤' + copy.hp + '）洗入卡组。');
}
function uNeedRetal(u){ return u.def.t !== 'artillery' && u.def.t !== 'bomber'; }
/* 抉择结算（航母掩护）：玩家在 UI 中点选 抉择1/抉择2 后回调；AI 由 startAiTurn 自动调用 */
function resolveChoice(choiceId){
  const pc = S.pendingChoice;
  if(!pc) return false;
  S.pendingChoice = null;
  const side = pc.side, me = playerOf(side);
  // 研发链抉择：按下抉择选项时按「第几阶段」放对应音效（用户 2026-09-13 指定的口径）
  //   3 费的根研发 = 第 1 阶段 → 'research1'；6/9 费的扩展/高级研发 = 第 2/3 阶段 → 'research23'
  //   （「研发」本身那张音效是**打出/点开抉择**时放的，走 ui.js 的指令音效 orderAudio，不在这里。）
  if(pc.eff === 'researchChoice' || pc.eff === 'researchChoiceN'){
    const rc = (pc.card && pc.card.blood) || 0;
    HOOKS.onSfx(rc <= 3 ? 'research1' : 'research23');
  }
  // 抉择点选才算使用：玩家侧此时才消耗手牌与指挥点（AI 打出时已消耗，卡不在手则自动跳过）
  if(pc.card){
    const idx = me.hand.indexOf(pc.card);
    if(idx > -1){
      me.hand.splice(idx, 1);
      me.kredit -= playCost(me, pc.card);
      logMsg('你使用了「' + pc.card.n + '」（-'+(pc.card.blood||0)+' 指挥点）。');
    }
  }
        if(pc.eff === 'researchChoice'){ resolveResearchChoice(me, pc, choiceId); }
        if(pc.eff === 'researchChoiceN'){ resolveResearchChoiceN(me, pc, choiceId); }   // R3 研发链（多张版）
        if(pc.eff === 'womenReserve'){ resolveWomenReserve(me, pc, choiceId); }          // 英 妇女预备队
      if(pc.eff === 'carrierCover'){
    const fighters = [];
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && x.def.t==='fighter') fighters.push({x, r, c}); }
    if(choiceId === 'c1'){
      fighters.forEach(f=>{ f.x.atk += 1; f.x.maxHp += 1; f.x.hp += 1; });
      logMsg('航母掩护·战斗群：友方战斗机 +1/+1（' + fighters.length + ' 个单位）。');
    } else {
      // 抉择2·前线进驻：所有友方战斗机移至前线（指令直接生效，前线有敌方单位也可进驻空槽；
      // 移动野猫同样触发其特效——1 个「F2A 水牛」加入相邻处）
      let moved = 0;
      for(const f of fighters){
        if(f.r === 1) continue;
        const target = S.board[1][f.c] ? (()=>{ for(let c2=0;c2<COLS;c2++) if(!S.board[1][c2]) return c2; return -1; })() : f.c;
        if(target >= 0){
          S.board[1][target] = f.x; S.board[f.r][f.c] = null;
          f.x.movedThisTurn = true; f.x.summonedThisTurn = false;
          moved++;
          HOOKS.onMoveForward({ side:side, fromRow:f.r, fromCol:f.c, toRow:1, toCol:target, def:f.x.def }); // 推进动画/音效（与 moveForward 一致）
          // 第109战斗工兵营：其他友方单位移至前线时，使其获得 +1 攻击力
          eng109Buff(side, f.x);
          if(hasFx(f.x,'f4fBuff') && f.x.hp > 0){
            const adj = (target - 1 >= 0 && !S.board[1][target-1]) ? target-1 : (target + 1 < COLS && !S.board[1][target+1]) ? target+1 : -1;
            if(adj >= 0){
              const d2 = makeDerived('f2a');
              if(d2 && spawnUnit(side, d2, 1, adj)) logMsg(f.x.def.n + ' 移至前线：1 个「F2A 水牛」加入相邻处。');
            }
          }
        }
      }
      logMsg('航母掩护·前线进驻：' + moved + ' 架战斗机移至前线。');
    }
  }
  if(pc.eff === 'strategicFocus'){
    // 战略重心：抉择1 对所有陆军 / 抉择2 对所有空军 造成 5 点伤害（双方单位都受伤）
    const targets = [];
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const x = S.board[r][c];
      if(!x) continue;
      const isArmy = x.def.t === 'infantry' || x.def.t === 'tank' || x.def.t === 'artillery';
      const isAir = x.def.t === 'fighter' || x.def.t === 'bomber';
      if(choiceId === 'c1' ? isArmy : isAir) targets.push(x);
    }
    const n = massDamage(targets, 5);
    logMsg('战略重心·'+(choiceId === 'c1' ? '陆军' : '空军')+'：全场 ' + n + ' 个单位受到 5 点伤害。');
  }
  if(pc.eff === 'resistance'){
    // 抵抗：抉择1 对友方总部 1 点伤害 / 抉择2 移除卡组顶 1 张牌
    if(choiceId === 'c1'){ me.hp -= 1; logMsg('抵抗：友方总部受到 1 点伤害。'); checkGameOver(); }
    else {
      if(me.deck.length){ me.deck.pop(); logMsg('抵抗：移除卡组顶 1 张牌。'); }
      else { me.hp -= 1; logMsg('抵抗：卡组已空，友方总部受到 1 点伤害。'); checkGameOver(); }
    }
  }
  if(pc.eff === 'compromise'){
    // 妥协：① 抽 1 张 + 总部 +3 防御力；② 双方玩家各把该效果进行 2 次（各抽 2 张、双方总部各 +6）
    if(choiceId === 'c1'){ drawCards(me, 1); me.maxHp += 3; me.hp += 3; logMsg('妥协·抽牌加固：抽 1 张牌，友方总部 +3 防御力。'); }
    else {
      const foe2 = enemyOf(side) === S.p ? S.p : S.a;
      for(let i=0;i<2;i++){
        drawCards(me, 1); me.maxHp += 3; me.hp += 3;
        drawCards(foe2, 1); foe2.maxHp += 3; foe2.hp += 3;
      }
      logMsg('妥协·双方两次：双方玩家各抽 2 张牌，双方总部各 +6 防御力。');
    }
  }
  if(pc.eff === 'callColony'){
    // 呼叫殖民地：抉择1 总部 +8 防御力 / 抉择2 抽 2 张牌
    if(choiceId === 'c1'){ me.maxHp += 8; me.hp += 8; logMsg('呼叫殖民地·加固总部：友方总部 +8 防御力。'); }
    else { drawCards(me, 2); logMsg('呼叫殖民地·抽两张：抽 2 张牌。'); }
  }
  if(pc.eff === 'ruinHand'){
    // 毁坏：弃掉选中的敌方手牌，并将 1 张复制加入友方手牌
    const i = parseInt(String(choiceId).slice(1), 10);
    const chosen = (pc.picks || [])[i];
    const foePl = playerOf(pc.side === 'p' ? 'a' : 'p');
    if(chosen && discardCard(foePl, chosen)){
      logMsg('毁坏：弃掉敌方「' + chosen.n + '」。');
      if(me.hand.length < MAX_HAND){ handPushRevealed(me, JSON.parse(JSON.stringify(chosen))); logMsg('毁坏：1 张复制加入友方手牌。'); }
      else logMsg('毁坏：手牌已满，复制无法加入。');
    }
  }
  if(pc.eff === 'exploitGain'){
    // 扩大优势：选中的单位加入手牌（花费 0·闪击），其余置于卡组底
    const i = parseInt(String(choiceId).slice(1), 10);
    const picks = pc.picks || [];
    const chosen = picks[i];
    if(chosen){
      me.deck = me.deck.filter(c => !picks.includes(c)).concat(picks.filter(c => c !== chosen));
      chosen.blood = 0;
      chosen.sig = (chosen.sig || []).concat(['blitz']);
      chosen.desc = (chosen.desc || '') + '；(扩大优势)花费 0·闪击';
      if(me.hand.length < MAX_HAND) me.hand.push(chosen);   // 从卡组里挑牌 = 不明牌
      else logMsg('手牌已满，选中的单位被弃置。');
      logMsg('扩大优势：' + chosen.n + ' 加入手牌（花费 0·闪击），其余 ' + Math.max(0, picks.length - 1) + ' 张置于卡组底。');
    }
  }
  if(pc.eff === 'pz3hTop3'){
    // 三号坦克H型：从展示的卡组顶 3 张里选 1 张抽到手，其余置于卡组底（deck 头部）
    const i = parseInt(String(choiceId).slice(1), 10);
    const picks = pc.picks || [];
    const chosen = picks[i];
    if(chosen){
      const rest = picks.filter(c => c !== chosen);
      me.deck = rest.concat(me.deck);        // 其余置于卡组底
      if(handFree(me, pc.card) > 0){
        me.hand.push(chosen);                  // 从卡组顶 3 张里挑 1 张 = 不明牌
        logMsg('三号坦克H型：抽到「' + chosen.n + '」，其余 ' + rest.length + ' 张置于卡组底。');
      } else {
        me.deck.push(chosen);                // 手牌已满：留在卡组顶
        logMsg('三号坦克H型：手牌已满，「' + chosen.n + '」留在卡组。');
      }
    }
  }
  if(pc.eff === 'gordonPick'){
    // 戈登高人团：把选中的手牌指令花费设为 0 并置于卡组顶（排序与弹窗一致：按花费降序）
    const orders = me.hand.filter(c=>c.kind==='order').sort((a,b)=>(b.blood||0)-(a.blood||0));
    const i = parseInt(String(choiceId).slice(1), 10);
    const sel = orders[i];
    if(sel){
      const idx = me.hand.indexOf(sel);
      if(idx > -1){
        me.hand.splice(idx, 1);
        sel.blood = 0;
        me.deck.push(sel); // 卡组顶 = 牌堆末尾（pop 抽出）
        logMsg('戈登高人团：将「'+sel.n+'」花费设为 0 并置于卡组顶。');
      }
    }
  }
  render();
  return true;
}
/* 取消抉择（玩家点击其他处/结束回合/按 ESC）：卡牌不消耗、返回手牌，不算使用 */
function cancelChoice(){
  const pc = S.pendingChoice;
  if(!pc) return false;
  if(pc.side === 'p' && pc.card) logMsg('已取消使用「' + pc.card.n + '」（不消耗）。');
  S.pendingChoice = null;
    if(pc.eff === 'pz3hTop3') S.p.deck = (pc.picks||[]).filter(c => S.p.hand.indexOf(c) < 0 && S.p.deck.indexOf(c) < 0).concat(S.p.deck); // 三号坦克H型：取消时把取出的 3 张还回卡组顶，避免凭空消失
  render();
  return true;
}
/* 戈登高人团：点击浮起的指令 → 花费设为 0 并置于卡组顶（直接点击触发，不再弹抉择面板） */
/* 权衡（苏）：玩家点击手牌弃掉 1 张——点击即结算（消耗「权衡」指令并扣费），结束回合未选则自动弃最低费 */
function discardPickResolve(picked){
  const dp = S.discardPick;
  if(!dp) return false;
  if(!picked || S.p.hand.indexOf(picked) < 0) return false;
  // 观察团（英·batch-F6）：dp.costCut 标记本分支；霹雳师/第175（toDeck）与权衡（无标记）走原路径，行为不变
  if(dp.costCut){
    if((picked.blood||0) < (dp.costMin||0)){ toast('请选择花费不小于 ' + (dp.costMin||0) + ' 的牌'); return false; }
    const ord0 = dp.card;
    S.discardPick = null;
    if(ord0){
      const i0 = S.p.hand.indexOf(ord0);
      if(i0 > -1){
        S.p.hand.splice(i0, 1);
        const cost0 = playCost(S.p, ord0);
        S.p.kredit = Math.max(0, S.p.kredit - cost0);
        logMsg('你使用了「' + ord0.n + '」（-' + cost0 + ' 指挥点）。');
      }
    }
    picked.blood = Math.max(0, (picked.blood||0) - dp.costCut);
    logMsg('观察团：「' + picked.n + '」的花费 -' + dp.costCut + '（现 ' + picked.blood + '）。');
    render();
    return true;
  }
  const ord = dp.card;
  if(ord){
    const i = S.p.hand.indexOf(ord);
    if(i > -1){
      S.p.hand.splice(i, 1);
      const cost = playCost(S.p, ord);
      S.p.kredit = Math.max(0, S.p.kredit - cost);
      logMsg('你使用了「' + ord.n + '」（-' + cost + ' 指挥点）。');
    }
  }
  S.discardPick = null;
  const ok = discardCard(S.p, picked);
  if(!ok) logMsg('权衡：无法弃牌（手牌受保护）。');
  render();
  return ok;
}
function cancelDiscardPick(){
  if(!S.discardPick) return false;
  S.discardPick = null;
  logMsg('权衡：未选择弃牌，将于回合结束时自动弃掉花费最低的 1 张。');
  S.p.mustDiscardOne = true;
  render();
  return true;
}
function gordonResolve(card){
  S.gordonPick = false;
  if(!card || card.kind !== 'order') return false;
  const idx = S.p.hand.indexOf(card);
  if(idx < 0) return false;
  S.p.hand.splice(idx, 1);
  card.blood = 0;
  S.p.deck.push(card); // 卡组顶 = 牌堆末尾（pop 抽出）
  logMsg('戈登高人团：将「' + card.n + '」花费设为 0 并置于卡组顶。');
  render();
  return true;
}
function cancelGordon(){
  if(!S.gordonPick) return false;
  S.gordonPick = false;
  logMsg('戈登高人团：指令们沉回手中，加持取消。');
  render();
  return true;
}
/* 换牌（首回合）：把选中的开局卡组牌放回牌库洗匀后补抽同数量（可多选也可不选；
   换牌补抽仍属开局手牌，不算抽取）。生产牌不参与换牌。 */
function doMulligan(cards){
  if(!S.mulliganPending) return false;
  S.mulliganPending = false;
  const list = Array.isArray(cards) ? cards : [];
  let n = 0;
  for(const c of list){
    const idx = S.p.hand.indexOf(c);
    if(idx > -1){ S.p.hand.splice(idx, 1); S.p.deck.push(c); n++; }
  }
  if(n > 0){
    S.p.deck = shuffle(S.p.deck);
    drawCards(S.p, n, true);
    S.p.totalDraws = 0; // 换牌补抽同属「开局手牌、不算抽取」（同 startGame 开局发牌）：不累计近卫步兵第4团的减费计数
    logMsg('换牌：将 ' + n + ' 张牌放回牌库并补抽 ' + n + ' 张。');
  } else {
    logMsg('你选择了不换牌。');
  }
  render();
  return true;
}
/* 步兵第75团：被敌方效果指向时，将 1 个复制加入友方总部相邻处（底线空槽） */
function r75Targeted(side, unit){
  if(!unit || !unit.def || unit.owner === side || unit.def.id !== 'r75') return;
  const r = backRowOf(unit.owner);
  for(let c=0;c<COLS;c++){
    if(!S.board[r][c]){
      const copy = JSON.parse(JSON.stringify(unit.def));
      spawnUnit(unit.owner, copy, r, c, false);
      logMsg('步兵第75团：被敌方效果指向，1 个复制加入友方总部相邻处。');
      return;
    }
  }
}
/* 手牌空位（含"正在打出/部署、尚未移出手中"的卡）：excl=那张卡的 def 对象；
   部署/指令特效在手牌移除前结算，守卫必须把它排除，否则满手 9 时加牌会误判爆满 */
function handFree(me, excl){
  let n = me.hand.length;
  if(excl && me.hand.indexOf(excl) > -1) n--;
  return Math.max(0, MAX_HAND - n);
}
/* IS-2：本单位被返回手中时，将 1 张复制加入支援阵线（完整复制：拷贝 def，含 8/8 重甲2）。
   srcDef = 被返回单位的 def，side = 返回方阵营。返回 true 表示确实生成了复制。
   支援阵线满时不生成（与 bp42/沙漠满目 等生成物口径一致，不溢出到前线）。 */
function is2BacklineCopy(side, srcDef){
  if(!srcDef || !hasFx({ def:srcDef }, 'is2Back')) return false;
  const slot = emptyBacklineSlot(side);          // 支援阵线 = 己方底线，取第一个空位
  if(!slot){ logMsg('IS-2：支援阵线已满，复制无法加入。'); return false; }
  const ok = spawnUnit(side, JSON.parse(JSON.stringify(srcDef)), slot.row, slot.col, true); // noDeploy：复制不触发部署效果
  if(ok) logMsg('IS-2：返回手中时，1 张复制加入支援阵线。');
  return !!ok;
}
/* 「单位被返回手牌」的统一出口：进手牌（明牌）+ IS-2 复制结算。
   capturedPos（可选）= {row,col}：单位尚未从棋盘移除时的坐标（仅用于阅读顺序，日志不依赖它）。
   返回 false 表示手牌已满（不进手牌），爆牌回调由调用点负责。 */
function handReturnsToHand(side, srcDef, capturedPos){
  const owner = playerOf(side);
  if(!srcDef) return false;
  if(owner.hand.length >= MAX_HAND) return false;
  handPushRevealed(owner, JSON.parse(JSON.stringify(srcDef)));
  owner.hand[owner.hand.length - 1].revealed = true; // 明牌：被返回手牌的单位对对手正面可见
  is2BacklineCopy(side, srcDef);
  return true;
}
/* 轻步兵（衍生卡）：把 N 张加入手牌（手牌满则停；excl=正在打出的卡不计入手牌占用） */
function addLightInfantryToHand(player, n, excl){
  let added = 0;
  for(let i=0;i<n;i++){
    if(handFree(player, excl) <= 0){ logMsg('手牌已满（9张），轻步兵无法加入。'); break; }
    const def = makeDerived('lightinf');
    if(!def) break;
    handPushRevealed(player, def);
    added++;
  }
  return added;
}
/* 手牌 → 卡组顶（卡组顶 = deck 末尾，pop 抽出；与 gordonResolve 同口径）。
   返回 true 表示移动成功。注意：本函数不做「不可弃牌」豁免——返回卡组不是弃牌，
   芬兰男孩步兵团（noDiscard）不应拦截，故不经 discardCard。 */
function handCardToDeckTop(player, card){
  if(!player || !card) return false;
  const i = player.hand.indexOf(card);
  if(i < 0) return false;
  player.hand.splice(i, 1);
  player.deck.push(card);
  // 用户 2026-09-13：敌方手牌被「返回卡组顶」时同样要能看到是哪张（如 布莱切利庄园）
  if(player === S.a) HOOKS.onFoeDiscard(card, '返回卡组顶');
  return true;
}
/* 霹雳师 / 第175步兵团：玩家点击手牌 → 返回卡组顶（与权衡 discardPickResolve 同形，
   由 ui.js 的手牌点击分支调用；两者共用 S.discardPick 槽位，靠 toDeck 标记区分）。 */
function handToDeckResolve(picked){
  const dp = S.discardPick;
  if(!dp || !dp.toDeck) return false;
  if(!picked || S.p.hand.indexOf(picked) < 0) return false;
  S.discardPick = null;
  // 调整（日）：shuffleIn = 洗入卡组（随机位置）+ 抽 1 张，并在这一刻结算「调整」的消耗与费用
  if(dp.shuffleIn){
    const ord = dp.card;
    if(ord){
      const oi = S.p.hand.indexOf(ord);
      if(oi > -1){
        S.p.hand.splice(oi, 1);
        const cost = playCost(S.p, ord);
        S.p.kredit = Math.max(0, S.p.kredit - cost);
        logMsg('你使用了「' + ord.n + '」（-' + cost + ' 指挥点）。');
      }
    }
    const ok2 = handCardShuffleIn(S.p, picked);
    if(ok2){ logMsg('调整：将「' + picked.n + '」洗入卡组。'); drawCards(S.p, 1); }
    render();
    return ok2;
  }
  // 黑夜巡视（美·指令）：orderConsume —— 指令型 toDeck 要在这里才结算本卡的消耗与费用
  // （与 F2「调整」的 shuffleIn 分支同口径；两条分支互斥，可共存，锚点也相同）
  if(dp.orderConsume){
    const ord = dp.card;
    if(ord){
      const oi = S.p.hand.indexOf(ord);
      if(oi > -1){
        S.p.hand.splice(oi, 1);
        const cost = playCost(S.p, ord);
        S.p.kredit = Math.max(0, S.p.kredit - cost);
        logMsg('你使用了「' + ord.n + '」（-' + cost + ' 指挥点）。');
      }
    }
    const ok0 = handCardToDeckTop(S.p, picked);
    if(ok0) logMsg('黑夜巡视：将「' + picked.n + '」返回卡组顶。');
    render();
    return ok0;
  }
  const ok = handCardToDeckTop(S.p, picked);
  if(ok) logMsg('「' + picked.n + '」返回卡组顶。');
  render();
  return ok;
}
/* 取消选择（按 ESC / 结束回合兜底）：改由结束回合流程自动挑一张，不阻断回合结束 */
function cancelHandToDeck(){
  if(!S.discardPick || !S.discardPick.toDeck) return false;
  // 黑夜巡视（美·指令）：指令型 toDeck 不能「取消」，按随机 1 张立即结算
  if(S.discardPick.orderConsume){
    const pool0 = S.p.hand.filter(c => c && c !== S.discardPick.card);
    if(pool0.length && handToDeckResolve(pool0[Math.floor(Math.random()*pool0.length)])) return true;
  }
  S.discardPick = null;
  S.p.mustHandToDeck = true;
  logMsg('未选择手牌，将于回合结束时自动将 1 张手牌返回卡组顶。');
  render();
  return true;
}
/* 构筑之外的特殊指令（第2西非旅：抽到它们会重复抽取；不入任何默认卡组） */
const EXTRA_ORDER_EFFS = new Set(['plan','baopo','produce']);
/* 中立特殊指令「生产」（护送航运把 1 张「生产」加入手牌；与开局生产牌堆同款定义） */
function makeProduceDef(){
  return { kind:'order', id:'produce', n:'生产', blood:0, eff:'produce', img:'卡牌/中立/生产.jpg', desc:'获得 1 个指挥点' };
}
/* 「SBD 3 无畏」生成物（F7F虎猫 / 掩护部队 的效果生成单位）。
   卡名以《卡牌/美/文档.txt》为准 = 「SBD 3 无畏」（带空格）；组卡池已有同名单位
   cards.js us units id:'sbd'（3费2油 3/3 重甲1）。用 NATIONS 直取（与 bp42 取 r59 同写法），
   不依赖卡名字符串；生成物不登记进 DERIVED_CARDS（不进图鉴/不进组卡池）。 */
function makeSbd(){
  const raw = (typeof NATIONS !== 'undefined' && NATIONS.us) ? NATIONS.us.units.find(x => x.id === 'sbd') : null;
  return raw ? mkUnitDef(raw, 'us') : null;
}
/* 生成 n 个「SBD 3 无畏」加入支援阵线（底线逐列找空位 → spawnUnit，与 bp42 同写法）；
   opts.blitz → 追加闪击词条。返回实际落地数。不传 noDeploy：生成物照常触发自身部署效果。 */
function addSbdToBackline(side, n, opts){
  opts = opts || {};
  const br = backRowOf(side);
  let placed = 0;
  for(let i = 0; i < n; i++){
    const def = makeSbd();
    if(!def) break;
    if(opts.blitz && !hasSig({ def, owner:side }, 'blitz')) def.sig = (def.sig || []).concat(['blitz']);
    let ok = false;
    for(let c = 0; c < COLS; c++) if(!S.board[br][c]){ if(spawnUnit(side, def, br, c)){ ok = true; break; } }
    if(!ok) break;
    placed++;
  }
  return placed;
}
/* 三式中战车（rowGuardAmbush）：在支援战线（己方底线）时具有伏击和守护；离开底线即失去。
   所有行变更点（部署/推进/撤退/移动类效果）后调用一次，词条就地同步，规则查询无需特判 */
function syncRowSig(u){
  if(!u || !u.def || !hasFx(u,'rowGuardAmbush')) return;
  const pos = findPosOf(u);
  const inBack = pos && pos.r === backRowOf(u.owner);
  // 赋予守护时：烟幕不可共存——被赋予守护即移除烟幕词条
  if(inBack && (u.def.sig || []).indexOf('smoke') >= 0){
    u.def.sig = (u.def.sig || []).filter(s => s !== 'smoke');
    logMsg(u.def.n + ' 被赋予守护，烟幕散去（烟幕词条移除）。');
  }
  u.def.sig = (u.def.sig || []).filter(s => s !== 'guard' && s !== 'ambush');
  if(inBack){ u.def.sig.push('guard'); u.def.sig.push('ambush'); }
}
/* 情报Ⅹ（单位词条：如搜索第七联队「情报1」）：部署时随机显示敌方 N 张手牌
   （revealed=true → 敌方手牌 UI 正面直显；规则.txt：情报牌使用时能显示敌方Ⅹ张手牌） */
function intelDeploy(side, def){
  const foe = enemyOf(side), foeSide = side === 'p' ? 'a' : 'p';
  const sig = (def.sig || []).find(s => /^情报\d+$/.test(String(s)));
  if(!sig) return;
  const n = parseInt(String(sig).slice(2), 10) || 0;
  // 波兰：友方使用情报牌时触发「军团 / 塔尔努夫第16步兵团」
  triggerIntelAllies(side);
  if(n <= 0 || !foe.hand.length) return;
  const pool = foe.hand.slice();
  for(let i = pool.length - 1; i > 0; i--){ const j = Math.floor(Math.random()*(i+1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  let shown = 0;
  for(const c of pool.slice(0, Math.min(n, pool.length))){
    if(!c.revealed){ c.revealed = true; shown++; }
  }
  logMsg(def.n + ' 情报：随机显示敌方 ' + shown + ' 张手牌' + (foeSide === 'a' ? '（左侧明牌可见）' : '') + '。');
  if(shown) render();
}
/* 波兰情报联动：友方使用情报牌时——
   军团（intelBuff）：获得 +1/+1；塔尔努夫第16步兵团（intelLegion）：加入 1 张「军团」并抽 1 张牌 */
function triggerIntelAllies(side){
  let buffed = 0, spawned = 0, drew = 0;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner !== side) continue;
    if(hasFx(u,'intelBuff')){ u.atk += 1; u.hp += 1; u.maxHp += 1; buffed++; }
    if(hasFx(u,'intelLegion')){
      const n = addDerivedToBoard(side, 'legion', 1);
      spawned += n;
      const d = drawCards(playerOf(side), 1);
      drew += d;
    }
  }
  if(buffed || spawned || drew) logMsg('情报联动：' + (buffed?buffed+' 个「军团」获得 +1/+1；':'') + (spawned?spawned+' 张「军团」加入支援阵线；':'') + (drew?'抽 '+drew+' 张牌。':''));
}
/* 每方回合开始的被动结算（玩家侧在 beginPlayerTurn、AI 侧在 startAiTurn 调用）：
   ① 卫戍（garrisonTick）：上回合未被攻击 → 敌方总部 1 伤；随后清空本方单位的被攻击标记
   ② 物资短缺（selfBurnTurn）：所有者回合开始自伤 1 点（常驻）
   ③ 高潮迭起：本回合指令计数清零
   ④ 前线观察员：上回合英国步兵部署快照轮换
   ⑤ 三式中战车：行内词条兜底同步 */
function resolveOwnerTurnStart(side){
  const me = playerOf(side), foe = enemyOf(side);
  const units = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x && x.owner === side) units.push({u:x, r, c}); }
  for(const t of units){
    if(unitAt(t.r, t.c) !== t.u || S.over) continue;
    const u = t.u;
    if(hasFx(u, 'garrisonTick')){
      if(!u.hitThisRound){
        applyHqDamage(foe, 1);
        logMsg(u.def.n + '：上回合未被攻击，对敌方总部造成 1 点伤害！');
        checkGameOver();
        if(S.over) return;
      }
    }
    // 柴郡团：友方回合开始时，若上回合没有被攻击，对敌方总部造成 2 点伤害
    // 「被攻击」判据复用既有 u.hitThisRound（combat 里 d.hitThisRound = true；本函数末尾统一清零），
    // 因此窗口正好是「自上次友方回合开始以来」，与卡面的「上回合」同义。
    if(hasFx(u, 'cheshireTick') && !u.hitThisRound){
      const dChes = abilityHqDamage(u, foe, 2);
      logMsg(u.def.n + '：上回合未被攻击，对敌方总部造成 ' + dChes + ' 点伤害！');
      if(S.over) return;
    }
    if(hasFx(u, 'selfBurnTurn') && u.hp > 0){
      logMsg(u.def.n + ' 受「物资短缺」侵蚀，回合开始自伤 1 点。');
      damageUnit(u, 1);
      if(S.over) return;
    }
    // 红牛师：友方回合开始时，攻击力翻倍（常驻累积，卡面无「直到回合结束」；抑制后失效）
    if(u.hp > 0 && !u.inhibited && u.def && u.def.id === '红牛师'){
      const before = u.atk;
      u.atk *= 2;
      logMsg(u.def.n + '：回合开始，攻击力翻倍（' + before + ' → ' + u.atk + '）。');
    }
  }
  resuppressTick(side); // 司事火炮：友方回合开始，再次压制部署时选定的目标（自身先判 S.over）
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x && x.owner === side) x.hitThisRound = false; }
  me.ordersThisTurn = 0;
  // batch-F4·暴风雪：持续到施放方下个回合开始
  if(me.blizzardFuel4){ me.blizzardFuel4 = false; logMsg('暴风雪：效果结束，行动花费恢复。'); }
  me.supply158Used = false; // 第158补给营：新回合重新开始计「第一个被消灭的敌方单位」
  me.gbInfLast = me.gbInfThis || 0; // 存真实数量（北极熊师按数量 +N/+N；前线观察员只用 truthy 判断，语义不变）
  me.gbInfThis = 0;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x && x.owner === side) syncRowSig(x); }
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const t = S.board[r][c];
    if(t && t.atkZeroBy === side){
      t.atk = (t.atk0Prev != null) ? t.atk0Prev : t.atk;
      t.atk0Prev = null; t.atkZeroBy = null;
      logMsg(t.def.n + ' 的攻击力恢复（俯冲轰炸效果结束）。');
    }
  }
}
/* 步兵第25团：友方回合结束时，将 1 个「轻步兵」加入同一战线（同行空槽） */
function triggerR25(side){
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner!==side || u.def.id!=='r25') continue;
    let slot = -1;
    for(let c2=0;c2<COLS;c2++) if(!S.board[r][c2]){ slot = c2; break; }
    if(slot >= 0){
      const def = makeDerived('lightinf');
      if(def && spawnUnit(side, def, r, slot)) logMsg(u.def.n+'：1 个「轻步兵」加入同一战线。');
    }
  }
}
/* 友方回合结束特效：步兵第25团（同战线+轻步兵）/ Me 163彗星（返回手牌）/ 驱逐空军（返回并洗入卡组） */
function triggerFriendlyTurnEnd(side){
  const me = playerOf(side);
  triggerR25(side);
  f4TurnEndSettle(side); // batch-F4：BP-43装甲列车（同一阵线加入轻步兵）/ 最后一击（回合结束消灭该单位）
  // 德国老兵掷弹兵团（老兵形态效果，按 卡牌/德/文档.txt「（老兵）」条目）：
  //   第119掷弹兵团（老兵）：友方回合结束时，使所有敌方单位获得 -1/-2
  //   第35掷弹兵团（老兵）：友方回合结束时，对敌方总部造成 4 点伤害
  // 老兵形态的 fx 由 VETERAN_FORMS 的 e 数组带出（promoteToVeteran → mkUnitDef），在场即每回合结算。
  {
    const foeSide = side === 'p' ? 'a' : 'p';
    let debuff = 0, hqHits = 0;
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const u = S.board[r][c];
      if(!u || u.owner !== side) continue;
      if(hasFx(u,'vetEnemyDebuff12')) debuff++;
      if(hasFx(u,'vetHqDmg4')) hqHits++;
    }
    for(let i=0;i<debuff;i++){
      const list = enemyList(side).map(x => x.u).filter(Boolean);
      for(const t of list){
        t.atk = Math.max(0, t.atk - 1);
        if(t.atkZeroBy && t.atk0Prev != null) t.atk0Prev = Math.max(0, t.atk0Prev - 1);
        t.maxHp -= 2; t.hp -= 2;
      }
      let dead = 0;
      for(const t of list){ if(t.hp <= 0){ const p = findPosOf(t); if(p){ killUnit(p.r, p.c); dead++; } } }
      logMsg('第119掷弹兵团（老兵）：友方回合结束，所有敌方单位 -1/-2' + (dead ? '，' + dead + ' 个单位被消灭。' : '。'));
      checkGameOver();
      if(S.over) return;
    }
    for(let i=0;i<hqHits;i++){
      logMsg('第35掷弹兵团（老兵）：友方回合结束，对敌方总部造成 4 点伤害。');
      applyHqDamage(playerOf(foeSide), 4);
      checkGameOver();
      if(S.over) return;
    }
  }
  // F7F虎猫：友方回合结束时，将 1 个「SBD 3 无畏」加入支援阵线
  // （写法照抄紧邻的 me163Back 循环：扫全盘 → hasFx 判定 → 结算）
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner!==side || !hasFx(u,'f7fEnd')) continue;
    const n = addSbdToBackline(side, 1);
    logMsg(u.def.n + '：友方回合结束，' + (n ? '1 个「SBD 3 无畏」加入支援阵线。' : '支援阵线已满，「SBD 3 无畏」无法加入。'));
  }
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner!==side || !hasFx(u,'me163Back')) continue;
    if(me.hand.length < MAX_HAND){
      S.board[r][c] = null;
      handReturnsToHand(side, u.def, { row:r, col:c }); // 统一出口：进手牌（明牌）+ IS-2 返回复制结算
      logMsg(u.def.n+'：友方回合结束，返回手牌。');
    } else logMsg(u.def.n+'：手牌已满（9张），无法返回。');
  }
  resolveObliqueArmorReturn(side);   // 倾斜装甲：友方回合结束时把召唤的 IS-2 收回手中
  // 驱逐（英）：抽上场的空军在友方回合结束时返回并洗入卡组
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner!==side || !u.ejectOut) continue;
    S.board[r][c] = null;
    const cd = JSON.parse(JSON.stringify(u.def));
    const at = me.deck.length ? Math.floor(Math.random()*(me.deck.length+1)) : 0;
    me.deck.splice(at, 0, cd);
    logMsg('驱逐：'+u.def.n+' 友方回合结束，返回并洗入卡组。');
  }
  // 莫洛托夫鸡尾酒 / 长久围困（芬）：友方回合结束时弃掉本卡
  if(me.discardAtTurnEnd && me.discardAtTurnEnd.length){
    for(const tag of me.discardAtTurnEnd){
      const i = me.hand.findIndex(c => c && c.id === tag.id);
      if(i > -1){ const cd = me.hand.splice(i, 1)[0]; logMsg(tag.n + '：友方回合结束，弃掉此牌。'); }
    }
    me.discardAtTurnEnd = [];
  }
  // Bf 109G 古斯塔夫 FI：攻击总部时从敌方卡组抽到的牌，回合结束时弃掉
  if(me.mt208Stolen && me.mt208Stolen.length){
    for(const card of me.mt208Stolen){
      const i = me.hand.indexOf(card);
      if(i > -1){ me.hand.splice(i, 1); logMsg('Bf 109G：缴获的「' + card.n + '」被弃掉。'); }
    }
    me.mt208Stolen = [];
  }
  // 权衡（苏）：未手动弃牌 → 回合结束时自动弃掉花费最低的 1 张
  if(me.mustDiscardOne){
    me.mustDiscardOne = false;
    const sorted = me.hand.filter(c => c).sort((a,b) => (a.blood||0) - (b.blood||0));
    if(sorted.length){ discardCard(me, sorted[0]); logMsg('权衡：回合结束，自动弃掉花费最低的「' + sorted[0].n + '」。'); }
  }
  // 方面军（苏）：友方回合结束时消灭本回合加入的 T-34
  if(me.frontArmyTanks && me.frontArmyTanks.length){
    for(const u of me.frontArmyTanks){
      const p = findPosOf(u);
      if(p) { logMsg('方面军：回合结束，' + u.def.n + ' 被消灭。'); killUnit(p.r, p.c); }
    }
    me.frontArmyTanks = [];
  }
  // 玉碎（日）：友方回合结束时，消灭本回合获得 +4/+4 的单位（写法同方面军）
  if(me.yusuiUnits && me.yusuiUnits.length){
    for(const u of me.yusuiUnits){
      const p = findPosOf(u);
      if(p){ logMsg('玉碎：回合结束，' + u.def.n + ' 被消灭。'); killUnit(p.r, p.c); }
    }
    me.yusuiUnits = [];
  }
}
/* AI 抉择自动结算：打出抉择卡后立即选择（航母掩护：有战斗机选战斗群 +1/+1，否则前线进驻；
   战略重心：数敌方陆军/空军哪个多就抉择哪个，平局默认陆军） */
function aiResolveChoice(){
  const pc = S.pendingChoice;
      if(!pc || pc.side !== 'a') return;
        if(pc.eff === 'researchChoice'){ resolveChoice(aiResearchPick(pc, 'a')); return; }
        if(pc.eff === 'researchChoiceN'){ resolveChoice(aiResearchPickN(pc, 'a')); return; }   // R3 研发链（多张版）
        if(pc.eff === 'womenReserve'){ resolveChoice(aiWomenReservePick(pc, 'a')); return; }    // 英 妇女预备队
  let pick = pc.options && pc.options[0] ? pc.options[0].id : 'c1';
  if(pc.eff === 'carrierCover' && !allyList('a').some(t=>t.u.def.t==='fighter')) pick = 'c2';
  if(pc.eff === 'strategicFocus'){
    // 战略重心伤及双方：数敌方 vs 己方 陆军/空军，选净收益最大的一类（平局默认陆军）
    let aArmy = 0, aAir = 0, pArmy = 0, pAir = 0;
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const x = S.board[r][c];
      if(!x) continue;
      const isArmy = x.def.t === 'infantry' || x.def.t === 'tank' || x.def.t === 'artillery';
      const isAir = x.def.t === 'fighter' || x.def.t === 'bomber';
      if(x.owner === 'a'){ if(isArmy) aArmy++; else if(isAir) aAir++; }
      else { if(isArmy) pArmy++; else if(isAir) pAir++; }
    }
    const armyEdge = pArmy - aArmy; // 打陆军的净收益（敌方 − 己方）
    const airEdge = pAir - aAir;
    pick = airEdge > armyEdge ? 'c2' : 'c1';
  }
  resolveChoice(pick);
}
/* 豹式坦克A型 防磁装甲型：每次行动后按本局已行动次数获得等量攻击力、防御力与油费。
   行动 = 移动与攻击都算：同一回合先推进再攻击 = 两次行动、成长两次 */
function applyPanzerGrowth(u){
  if(!u || !hasFx(u,'panzer')) return;
  u.panzerActs = (u.panzerActs||0) + 1;
  const n = u.panzerActs;
  u.atk += n; u.maxHp += n; u.hp += n;
  u.def.fuel = (u.def.fuel||0) + n;
  logMsg(u.def.n + ' 行动（第 ' + n + ' 次），攻击力/防御力/油费 +' + n + '。');
}
function applyHqDamage(foe, dmg){
  // 开发者模式：总部免疫伤害（面板开关，默认关）
  if(DEV.hqImmuneSide){
    const immune = (DEV.hqImmuneSide === 'p') ? S.p : S.a;
    if(foe === immune){ logMsg('【开发者】总部免疫伤害（本次 ' + dmg + ' 点被吞掉）'); return; }
  }
  const side = (foe === S.p) ? 'p' : 'a';
  const pl = playerOf(side);
  // 西苏精神（芬·反制）：友方总部受到伤害时，改为由敌方总部承受
  if(side === 'p' && S.p.counters.includes('sisuSpirit') && dmg > 0){
    S.p.counterHit.sisuSpirit = true;
    consumePlayerCounter('sisuSpirit');
    logMsg('反制·西苏精神：伤害转由敌方总部承受。');
    // M26潘兴（受保护方为 AI 时）：转伤同样不能把总部打到 1 以下
    if(m26Frontline('a')) dmg = Math.min(dmg, Math.max(0, S.a.hp - 1));
    S.a.hp -= dmg;
    checkGameOver();
    return;
  }
  // 第593联合通信连：友方总部受到的伤害 -1
  if(onboardHasFx(side, 'hqDmgReduce1') && dmg > 0){
    dmg = Math.max(0, dmg - 1);
    logMsg('第593联合通信连：总部受到的伤害 -1。');
  }
  // M6：每有 1 个攻击力不小于 4 的友方单位，友方总部受到的伤害 -1
  // （写法与 593通信连同形：先算减免量，再一次性扣减；减免不超过本次伤害，避免变成「治疗」）
  // M6 必须在场：光环随本体离场即失效（同名即生效，扫 def.id 与 M3A3甜心/plan 同口径）
  if(dmg > 0){
    let m6 = 0, hasM6 = false;
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const x = S.board[r][c];
      if(!x || x.owner !== side) continue;
      if(x.def && x.def.id === 'M6') hasM6 = true;
      if(atkOf(x) >= 4) m6++;
    }
    if(hasM6 && m6 > 0){
      const cut = Math.min(dmg, m6);
      dmg -= cut;
      logMsg('M6：攻击力不小于 4 的友方单位 ' + m6 + ' 个，总部受到的伤害 -' + cut + '。');
    }
  }
  /* 注：位置必须早于 `foe.hp -= dmg;`。与 593 通信连叠加时按「先 593 后 M6」依次扣减，
     顺序对最终结果无影响（都是线性扣减，且都以 0 为下限）。 */
  // M26潘兴：本单位在前线时，友方总部的防御力无法降为 1 以下
  if(dmg > 0 && m26Frontline(side)){
    const room = Math.max(0, foe.hp - 1);
    if(dmg > room){
      logMsg('M26潘兴：友方总部的防御力无法降为 1 以下（伤害 ' + dmg + ' → ' + room + '）。');
      dmg = room;
    }
  }
  // 柏林之路：敌方总部每回合累计受到 ≥3 伤害时，友方总部 +3 防御力
  if(pl.roadBerlin){
    pl.hqDmgAccum = (pl.hqDmgAccum || 0) + dmg;
    if(pl.hqDmgAccum >= 3){
      pl.hqDmgAccum = 0;
      const other = (foe === S.p) ? S.a : S.p;
      other.maxHp += 3; other.hp += 3;
      logMsg('柏林之路：敌方总部本回合累计受伤达 3，友方总部 +3 防御力。');
    }
  }
  // HMS塔尔伯特（英）：友方总部即将受到致命伤害时，先获得 +6 防御力（**仅 1 次**，用户 2026-09-13 裁定）
  // （判定放在所有减免之后、扣血之前 →「即将受到致命伤害」按最终伤害值算；pl = 受伤总部的所有者）
  if(pl.hmsTalbot && !pl.hmsTalbotUsed && dmg > 0 && foe.hp - dmg <= 0){
    pl.hmsTalbotUsed = true;
    pl.maxHp += 6; pl.hp += 6;
    logMsg('HMS塔尔伯特：友方总部即将受到致命伤害，先获得 +6 防御力（本次保护已用尽）。');
  }
  foe.hp -= dmg;
}
function unitAt(row,col){ return (S.board[row] ? S.board[row][col] : null); } // 越界/非法坐标返回 null（防 AI 回合崩溃）

/* ---------- 指令执行 ---------- */
function countEnemy(side){ let n=0; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side) n++; } return n; }
function enemyList(side){ const out=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner!==side) out.push({u:x,r,c}); } return out; }
function allyList(side){ const out=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side) out.push({u:x,r,c}); } return out; }
/* 指令是否指向「反制方」的目标（反制·拦截判定）：总部目标按 hqSide（缺省=指向敌方总部，
   如 ui 里空中闪击/俾斯麦可选己方总部，那类指向不触发拦截）；单位目标看该格归属；
   无指向（群体伤害/自身增益）的指令不算「指向友方目标」 */
function orderAimedAtFoe(tgt, foeSide){
  if(!tgt) return false;
  if(tgt.hq) return tgt.hqSide === undefined || tgt.hqSide === foeSide;
  if(!Number.isInteger(tgt.row) || !Number.isInteger(tgt.col)) return false;
  const tu = unitAt(tgt.row, tgt.col);
  return !!tu && tu.owner === foeSide;
}
function orderEffect(card, tgt){
  HOOKS.onOrderPlayed(card); // 双方打出指令：UI 在牌桌中央播放约 1 秒动画（无头 no-op）
  const isAI = S.phase === 'ai';
  const me = isAI ? S.a : S.p, foe = isAI ? S.p : S.a;
  const side = isAI ? 'a' : 'p';
  const foeSide = isAI ? 'p' : 'a';
  const e = card.eff;
  // 天皇诏令：使本回合下个友方伤害指令造成的伤害 +1（单目标/直击伤害类指令；被包裹的伤害消耗一次）
  // SUPERMAN（hana 专用）：「友方指令造成的伤害 +1」= 在场即生效的光环，每次伤害指令结算时现算
  const x = n => {
    let v = n;
    if(onboardHasFx(side, 'orderDmgPlus1')) v += 1;
    if(me.edictNext){ me.edictNext = false; logMsg('天皇诏令：伤害 +1！'); v += 1; }
    return v;
  };
  // ULTRA（英反制）：敌方使用指令时将其反制，抽 1 张牌（触发即消耗；生产也属指令一并反制）
  // 北北布次香菜的剧本卡为固定发放+零费，但玩家反制照常生效（可被 ULTRA 拦截）
  if(foe.counters.includes('ultra') && !foe.counterHit.ultra){
    foe.counterHit.ultra = true;
    // 触发即消耗：玩家侧必须走 consumePlayerCounter（撤下计数器 + 把那张已激活的反制卡从手牌移除，
    // 否则它留在手里还能点一次「收回」白退 3 点指挥点——用户 2026-09-16 报「没有消耗」）；
    // AI 侧同拦截的写法。emitCounterFx 在 consumePlayerCounter 内部已调用，勿重复。
    if(foe === S.p) consumePlayerCounter('ultra');
    else { S.a.counters = S.a.counters.filter(x => x !== 'ultra'); emitCounterFx('a', 'ultra'); }
    drawCards(foe, 1);
    logMsg('反制·ULTRA：' + card.n + ' 被反制（效果取消），' + (foe === S.p ? '你' : '老牧师') + ' 抽 1 张牌。');
    render(); checkGameOver();
    return true;
  }
  // 拦截（英反制）：敌方指令指向友方目标时，将其反制（触发即消耗；无指向/指向其自身的指令不触发）
  if(foe.counters.includes('拦截') && !foe.counterHit['拦截'] && orderAimedAtFoe(tgt, foeSide)){
    foe.counterHit['拦截'] = true;
    if(foe === S.p) consumePlayerCounter('拦截');
    else { S.a.counters = S.a.counters.filter(e => e !== '拦截'); emitCounterFx('a', '拦截'); }
    logMsg('反制·拦截：' + card.n + ' 指向友方目标，效果被反制！');
    render(); checkGameOver();
    return true;
  }
  // 高潮迭起：本回合已使用指令计数（本卡计入；ULTRA/拦截 反制的不算）
  me.ordersThisTurn = (me.ordersThisTurn || 0) + 1;
  // 卡梅伦团（英）：每回合，友方使用第二张指令时，抽 2 张牌
  // （在场才生效 → 用 onboardHasFx 查在场，不能只看 def.fx；被 ULTRA/拦截 反制的指令不计入 ordersThisTurn）
  if(me.ordersThisTurn === 2 && onboardHasFx(side, 'cameron2ndOrder')){
    drawCards(me, 2);
    logMsg('卡梅伦团：本回合使用的第 2 张指令，抽 2 张牌。');
  }
  // 第85先锋连：减费是现算的（见 playCost，按 ordersThisTurn===0 判），这里无需再消耗什么；
  // 被 ULTRA/拦截 反制的指令在上方已 return true，不计入 ordersThisTurn → 减费自动留给下一张，语义不变。

  // 旋风（英）：敌方指令指向本单位时，对其总部造成 3 点伤害
  // 触发点在「指令确实开始结算」处：被 ULTRA/拦截 反制的指令已在上方 return，不会触发；
  // 「指向」= 指令的 target 落在本单位上（随机命中类指令不算），与红魔空降步兵团的 +1 花费同口径。
  if(tgt && !tgt.hq){
    const wu = unitAt(tgt.row, tgt.col);
    if(wu && wu.owner !== side && hasFx(wu,'whirlwindAura')){
      applyHqDamage(me, 3);
      logMsg('旋风：敌方指令指向本单位，' + (me === S.p ? '你' : '老牧师') + '的总部受到 3 点伤害。');
      checkGameOver();
    }
  }
  // 新发田联队：敌方使用指令时，对其总部造成 1 点伤害（剧本卡同样触发——玩家可影响）
  for(let rr=0;rr<ROWS;rr++) for(let cc=0;cc<COLS;cc++){ const bb=S.board[rr][cc]; if(bb && bb.owner===foeSide && hasFx(bb,'orderPunish')){ abilityHqDamage(bb, me, 1); logMsg('新发田联队：敌方使用指令，对其总部造成 1 点伤害。'); break; } }
  /* ↓↓↓ batch-E3：「友方使用指令时」触发的 4 张（side = 使用者，me = 使用者本人，foe = 对手） ↓↓↓ */
  // 第10突击队：友方使用指令时，随机对 1 个敌方目标造成 1 点伤害
  // 目标池 = 敌方全部单位 + 敌方总部（与「秋田联队」亡计的 pool 写法完全一致）
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const cu = S.board[r][c];
    if(!cu || cu.owner !== side || !hasFx(cu,'commandoOrder')) continue;
    const cPool = enemyList(side).map(t => t.u);
    cPool.push({ hq:true }); // 目标池含敌方总部
    const cT = cPool[Math.floor(Math.random()*cPool.length)];
    if(cT.hq){ const dCom = abilityHqDamage(cu, foe, 1); logMsg(cu.def.n + '：友方使用指令，随机对敌方总部造成 ' + dCom + ' 点伤害。'); }
    else { damageUnit(cT, 1, cu); logMsg(cu.def.n + '：友方使用指令，随机对 ' + cT.def.n + ' 造成 1 点伤害。'); }
  }
  // 皇家燧发枪团：友方使用指令时，将本单位的攻击力和行动花费交换
  // （「行动花费」= def.fuel，即 actFuelCost 的基数；两值互换，故连续两张指令会换回来）
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const fu = S.board[r][c];
    if(!fu || fu.owner !== side || !hasFx(fu,'fusilierSwap')) continue;
    const fAtk = fu.atk, fFuel = (fu.fuelOverride != null ? fu.fuelOverride : (fu.def.fuel || 0));
    fu.atk = fFuel; fu.fuelOverride = fAtk;
    logMsg(fu.def.n + '：友方使用指令，攻击力与行动花费交换（攻 ' + fAtk + ' → ' + fu.atk + '，行动花费 ' + fFuel + ' → ' + fu.def.fuel + '）。');
  }
  // 十字军Mkll：友方使用英国指令时，抽 1 张牌（「英国指令」按卡牌国籍 card.nation === 'gb' 判定）
  if(card.nation === 'gb' && onboardHasFx(side, 'crusaderDraw')){
    drawCards(me, 1);
    logMsg('十字军Mkll：友方使用英国指令，抽 1 张牌。');
  }
  // 威灵顿：若在手牌中，友方使用指令时获得 -2 花费（累计；离开手牌即清零）
  // 计数在此，扣减在 playCost（HOOK-7）。判定按 me.hand 里的 card.id，不依赖战场标记。
  {
    const wInHand = (me.hand || []).some(c => c && c.id === '威灵顿');
    me.wellingtonDiscount = wInHand ? ((me.wellingtonDiscount || 0) + 2) : 0;
    if(wInHand) logMsg('威灵顿：在手牌中，因友方使用指令获得 -2 花费（累计 -' + me.wellingtonDiscount + '）。');
  }
  const rand = arr => arr.length ? arr[Math.floor(Math.random()*arr.length)] : null;
  const doDamage = (u, dmg)=>{ if(!u || dmg<=0) return; u.hp -= dmg; if(hasFx(u,'onDamagedDraw')){ drawCards(playerOf(u.owner), 1); logMsg(u.def.n+' 受到伤害：抽 1 张牌'); } if(u.hp <= 0) killUnit(findPos(u).r, findPos(u).c); };
  const findPos = u => { for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(S.board[r][c]===u) return {r,c}; return null; };
  switch(e){
    case 'produce': { me.kredit += 1; logMsg('生产：获得 1 个指挥点（当前 ' + me.kredit + '）'); break; }
    case 'gunboat': {
      // 可选取敌方底线单位或敌方总部
      if(tgt && tgt.hq){
        applyHqDamage(foe, x(2)); checkGameOver(); logMsg('炮艇任务：对敌方总部造成 2 点伤害');
      } else {
        const d = tgt ? unitAt(tgt.row,tgt.col) : null;
        if(!d || d.owner!==foeSide || tgt.row!==backRowOf(foeSide)){ toast('请选择敌方支援阵线的单位'); return false; }
        doDamage(d, x(2)); logMsg('炮艇任务：对 '+d.def.n+' 造成 2 点伤害');
      }
      me.hp += 2; me.maxHp += 2; logMsg('炮艇任务：友方总部 +2 血量');
      break; }
    case 'deathFromAbove': { const t=rand(enemyList(side)); if(t){ logMsg('死神降临：随机消灭 '+t.u.def.n); killUnit(t.r,t.c); } else { toast('无敌方单位'); return false; } break; }
    case 'warMachine': { me.kreditSlots = Math.min(24, me.kreditSlots+1); logMsg('战争机器：指挥点槽 +1（下回合指挥点随之增加）！'); break; }
    case 'warNeed': { me.kreditSlots = Math.min(24, me.kreditSlots+2); logMsg('战争需要：指挥点槽 +2！'); break; }
    case 'warBond': {
      // 战争债券：+2 指挥点槽；下个友方回合开始时额外抽 1 张牌（摸牌完成后结算）
      me.kreditSlots = Math.min(24, me.kreditSlots+2);
      me.extraDrawNext = (me.extraDrawNext||0) + 1;
      logMsg('战争债券：指挥点槽 +2，下个友方回合开始时额外抽 1 张牌。');
      break; }
    case 'aswPatrol': {
      // 反潜巡逻：+3 指挥点槽，随机消灭 1 个敌方单位
      me.kreditSlots = Math.min(24, me.kreditSlots+3);
      const t = rand(enemyList(side));
      if(t){ logMsg('反潜巡逻：随机消灭 '+t.u.def.n); killUnit(t.r,t.c); }
      else logMsg('反潜巡逻：指挥点槽 +3（场上有敌方单位时随机消灭 1 个）。');
      break; }
    case 'southPlan': {
      // 南进计划：自己 +1 指挥点槽，敌方失去 1 个指挥点槽（真实减槽）
      me.kreditSlots = Math.min(24, me.kreditSlots+1);
      foe.kreditSlots = Math.max(0, foe.kreditSlots - 1); foe.slotsLost = (foe.slotsLost||0) + 1;
      logMsg('南进计划：你的指挥点槽 +1，敌方失去 1 个指挥点槽！');
      break; }
    case 'airCover': {
      // 空中掩护：将 2 个 F2A 水牛加入战场（优先前线）
      const n = spawnF2As(side, 2, true);
      logMsg('空中掩护：' + n + ' 个「F2A 水牛」加入战场。');
      break; }
    case 'yorktown': {
      // USS约克城号：将 4 个 F2A 水牛加入战场（优先前线）
      const n = spawnF2As(side, 4, true);
      logMsg('USS约克城号：' + n + ' 个「F2A 水牛」加入战场。');
      break; }
    case 'carrierGroup': {
      // 航母打击群：所有友方空军 +1/+1（抽取部分在 drawCards 触发）
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const x = S.board[r][c];
        if(x && x.owner===side && (x.def.t==='fighter' || x.def.t==='bomber')){
          x.atk += 1; x.maxHp += 1; x.hp += 1; n++;
        }
      }
      logMsg('航母打击群：友方空军 +1/+1（' + n + ' 个单位）。');
      break; }
    case 'carrierCover': {
      // 航母掩护（抉择）：① 友方战斗机 +1/+1；② 友方战斗机移至前线
      // 卡牌先留在手牌：点选 抉择1/抉择2 后才算使用（resolveChoice 内消耗），点击其他处可取消
      S.pendingChoice = { eff:'carrierCover', side, card, options:[
        { id:'c1', n:'抉择 1 · 战斗群', img:'卡牌/美/航母掩护（抉择1）.jpg', desc:'使所有友方战斗机获得 +1/+1' },
        { id:'c2', n:'抉择 2 · 前线进驻', img:'卡牌/美/航母掩护（抉择2）.jpg', desc:'所有友方战斗机移至前线' }
      ] };
      HOOKS.onChoice(S.pendingChoice.options);
      logMsg('航母掩护：抉择吧——战斗群（+1/+1）或前线进驻。');
      break; }
    case 'dawnOp': {
      // 拂晓行动：本回合友方空军行动花费为 0，失去 1 个指挥点槽
      me.airFuel0 = true;
      me.kreditSlots = Math.max(0, me.kreditSlots - 1); me.slotsLost = (me.slotsLost||0) + 1;
      logMsg('拂晓行动：本回合友方空军行动花费为 0，你的指挥点槽 -1。');
      break; }
    case 'blazing': {
      // 烈日：本回合所有友方空军 +3 攻击力
      me.airAtk3 = true; me.blazingUsed = true;
      logMsg('烈日：本回合所有友方空军 +3 攻击力。');
      break; }
    case 'backlight': {
      // 逆光攻击：本回合友方空军行动花费 -1；若本回合已用烈日，再 +2 攻击力
      me.airFuelMinus1 = true;
      if(me.blazingUsed){ me.airAtk2 = true; logMsg('逆光攻击：友方空军行动花费 -1，且烈日联动 +2 攻击力。'); }
      else logMsg('逆光攻击：友方空军行动花费 -1。');
      break; }
    case 'patton': {
      // 巴顿：本回合，手牌中所有单位部署花费 -1，部署后具有闪击
      me.patton = true;
      logMsg('巴顿：本回合手牌中所有单位部署花费 -1，部署后具有闪击。');
      break; }
    case 'forFreedom': {
      // 为了自由：使 1 个友方单位获得 +1/+1，抽 1 张牌
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side){ toast('请选择友方单位'); return false; }
      d.atk += 1; d.hp += 1; d.maxHp += 1;
      drawCards(me, 1);
      logMsg('为了自由：'+d.def.n+' 获得 +1/+1，抽 1 张牌。');
      break; }
    case 'quinine': {
      // 奎宁：使 1 个友方步兵获得 +1/+2 和 -1 行动花费
      const q = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!q || q.owner !== side || q.def.t !== 'infantry'){ toast('请选择友方步兵'); return false; }
      q.atk += 1; q.hp += 2; q.maxHp += 2;
      q.def.fuel = Math.max(0, (q.def.fuel||0) - 1);
      logMsg('奎宁：'+q.def.n+' 获得 +1/+2，行动花费 -1。');
      break; }
    case 'blitzKrieg': {
      // 闪电战：使前线所有友方单位获得 +3 攻击力和 -1 行动花费，直到回合结束
      me.frontBuff3 = true; me.frontFuelMinus1 = true;
      logMsg('闪电战：前线所有友方单位 +3 攻击力、-1 行动花费（直到回合结束）。');
      break; }
    case 'coopOp': {
      // 协同作战：友方每有一种单位类型，使 1 个友方坦克获得一次 +1/+1
      const types = new Set();
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side) types.add(x.def.t); }
      const n = types.size;
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side || !isTankUnit(d)){ toast('请选择友方坦克'); return false; }
      d.atk += n; d.hp += n; d.maxHp += n;
      logMsg('协同作战：友方有 '+n+' 种单位类型，'+d.def.n+' 获得 +'+n+'/+'+n+'。');
      break; }
    case 'motivate': {
      // 激励部队：使 1 个友方单位获得等同于其行动花费的攻击力和防御力，行动花费变为 0
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side){ toast('请选择友方单位'); return false; }
      const f = d.def.fuel||0;
      d.atk += f; d.maxHp += f; d.hp += f;
      d.def.fuel = 0;
      logMsg('激励部队：'+d.def.n+' 获得 +'+f+'/+'+f+'，行动花费变为 0。');
      break; }
    case 'bridgeTooFar': {
      // 遥远的桥：敌方回合结束时，若可能将 1 个「三号坦克J型」加入前线；否则消灭前线所有单位
      me.bridgeTooFar = true;
      logMsg('遥远的桥：敌方回合结束时见分晓——坦克入前线，或前线尽灭。');
      break; }
    case 'reserve': {
      // 预备役：将 2 张「轻步兵」加入手牌；此前每使用过 1 张「预备役」，额外加入 1 张
      // （正在打出的本卡不计入手牌占用）
      const extra = me.reserveUsed || 0;
      const added = addLightInfantryToHand(me, 2 + extra, card);
      me.reserveUsed = (me.reserveUsed||0) + 1;
      logMsg('预备役：'+added+' 张「轻步兵」加入手牌（此前已使用 '+extra+' 张预备役）。');
      break; }
    case 'deepOp': {
      // 大纵深作战：将 2 张「轻步兵」加入手牌，将手牌中的「轻步兵」获得闪击
      const added = addLightInfantryToHand(me, 2, card);
      let n = 0;
      for(const c of me.hand){ if(c.kind==='unit' && c.id==='lightinf' && !(c.sig||[]).includes('blitz')){ (c.sig = c.sig||[]).push('blitz'); n++; } }
      logMsg('大纵深作战：'+added+' 张「轻步兵」加入手牌，'+n+' 张手牌轻步兵获得闪击。');
      break; }
    case 'frontalAssault': {
      // 正面突击：使所有友方「轻步兵」获得 +1/+2；若没有「轻步兵」，将 2 张「轻步兵」加入手牌
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && x.def.id==='lightinf'){ x.atk+=1; x.hp+=2; x.maxHp+=2; n++; } }
      if(n > 0) logMsg('正面突击：'+n+' 个友方轻步兵获得 +1/+2。');
      else {
        const added = addLightInfantryToHand(me, 2, card);
        logMsg('正面突击：场上没有轻步兵，'+added+' 张「轻步兵」加入手牌。');
      }
      break; }
    case 'enigma': {
      // 恩尼格玛：抽数张牌，直到友方手牌数与敌方相同
      // 已打出的本卡不计入手牌数（玩家路径在效果结算后才移除手牌，AI 路径已先移除——此处统一口径）
      const want = foe.hand.length;
      const cur = me.hand.length - (me.hand.indexOf(card) > -1 ? 1 : 0);
      if(want > cur){
        const d = drawCards(me, want - cur);
        logMsg('恩尼格玛：补抽至与敌方手牌相同（'+d+' 张）。');
      } else logMsg('恩尼格玛：友方手牌不少于敌方，不抽牌。');
      break; }
    case 'buzzBomb': {
      // 嗡嗡炸弹：对 1 个敌方目标造成 1 点伤害（可指敌方单位或敌方总部）；
      // 若目标是敌方总部，抽 1 张牌
      if(tgt && tgt.hq){
        applyHqDamage(foe, x(1)); checkGameOver();
        drawCards(me, 1);
        logMsg('嗡嗡炸弹：敌方总部受到 1 点伤害，抽 1 张牌。');
      } else {
        const d = tgt ? unitAt(tgt.row, tgt.col) : null;
        if(!d || d.owner !== foeSide){ toast('请选择敌方目标'); return false; }
        damageUnit(d, x(1));
        logMsg('嗡嗡炸弹：对 '+d.def.n+' 造成 1 点伤害。');
      }
      break; }
    case 'lastJourney': {
      // 终焉之行：移除卡组顶的 1 张空军，造成等同于其攻击力的伤害（天皇诏令+1），随机分配至所有敌方目标
      const idx = (()=>{ for(let i=me.deck.length-1;i>=0;i--){ const c=me.deck[i]; if(c && c.kind==='unit' && (c.t==='fighter'||c.t==='bomber')) return i; } return -1; })();
      if(idx >= 0){
        const air = me.deck.splice(idx,1)[0];
        const extra = x(0); // 天皇诏令：+1 点额外伤害
        const dmg = (air.atk || 0) + extra;
        logMsg('终焉之行：移除卡组顶空军「'+air.n+'」（攻击力 '+air.atk+'）'+(extra ? '，天皇诏令 +1' : '')+'。');
        const pool = [];
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const b=S.board[r][c]; if(b && b.owner===foeSide) pool.push(b); }
        pool.push({hq:true}); // 目标包含敌方总部：即便场上无单位也会打总部
        for(let i=0;i<dmg && pool.length;i++){
          // 剔除已阵亡的单位目标，剩余伤害继续随机分配
          for(let j=pool.length-1;j>=0;j--){ const pj=pool[j]; if(!pj.hq && (!pj.def || pj.hp <= 0)) pool.splice(j,1); }
          if(!pool.length) break;
          const t = pool[Math.floor(Math.random()*pool.length)];
          if(t.hq){ applyHqDamage(foe, 1); }
          else { t.hp -= 1; if(hasFx(t,'onDamagedDraw')) drawCards(playerOf(t.owner),1); if(t.hp <= 0){ const p2=findPosOf(t); if(p2) killUnit(p2.r,p2.c); } }
        }
        logMsg('终焉之行：'+dmg+' 点伤害随机分配至敌方目标（含总部）。');
      } else logMsg('终焉之行：卡组顶没有空军，效果不触发。');
      break; }
    case 'quickWin': {
      // 快速胜利：对任意目标造成 3 点伤害（可指任意单位或敌方总部），使敌方卡组中所有单位获得 +3 攻击力
      const d = tgt ? (tgt.hq ? null : unitAt(tgt.row, tgt.col)) : null;
      if(tgt && !tgt.hq && !d){ toast('请选择目标'); return false; }
      if(tgt && tgt.hq){ applyHqDamage(foe, x(3)); checkGameOver(); }
      else if(d) damageUnit(d, x(3));
      let n = 0;
      for(const c of foe.deck){ if(c && c.kind==='unit'){ c.atk = (c.atk||0) + 3; n++; } }
      logMsg('快速胜利：'+(d ? d.def.n+' 受到' : '敌方总部受到')+' 3 点伤害，敌方卡组中 '+n+' 个单位获得 +3 攻击力。');
      break; }
    case 'diplomat': {
      // 外交专员：对 1 个敌方目标造成 1 点伤害（可指敌方单位或敌方总部）；
      // 此前每使用过 1 张「外交专员」，伤害 +1
      const dmg = x(1 + (me.diplomatUsed||0));
      if(tgt && tgt.hq){
        applyHqDamage(foe, dmg);
        checkGameOver();
        logMsg('外交专员：对敌方总部造成 '+dmg+' 点伤害（此前使用 '+(me.diplomatUsed||0)+' 张）。');
      } else {
        const d = tgt ? unitAt(tgt.row, tgt.col) : null;
        if(!d || d.owner !== foeSide){ toast('请选择敌方目标'); return false; }
        damageUnit(d, dmg);
        logMsg('外交专员：对 '+d.def.n+' 造成 '+dmg+' 点伤害（此前使用 '+(me.diplomatUsed||0)+' 张）。');
      }
      me.diplomatUsed = (me.diplomatUsed||0) + 1;
      break; }
    case 'carrierWar': {
      // 航母战：对任意目标造成 3 点伤害（可指任意单位或敌方总部），将「航母战」加入敌方手牌
      // 每次易手花费 +1、伤害 +1（接力升级，无限类推）：本张级数 = card.dmgAdd
      const d = tgt ? (tgt.hq ? null : unitAt(tgt.row, tgt.col)) : null;
      if(tgt && !tgt.hq && !d){ toast('请选择目标'); return false; }
      const lvl = card.dmgAdd || 0; // 0=原版，1=敌方加强版，2=回到己方再加强……
      const dmg = x(3 + lvl);
      if(tgt && tgt.hq){ applyHqDamage(foe, dmg); checkGameOver(); }
      else if(d) damageUnit(d, dmg);
      if(foe.hand.length < MAX_HAND){
        const copy = mkOrderDef(NATIONS.jp.orders.find(o=>o.id==='carrierwar'), 'jp');
        copy.blood = (copy.blood||0) + (lvl + 1); // 下家的花费在原版基础上 +（级数+1）
        copy.dmgAdd = lvl + 1;                     // 下家打出时伤害同样 +（级数+1）
        copy.revealed = true;                      // 明牌：接力「航母战」对敌方正面可见
        foe.hand.push(copy);
        logMsg('航母战：'+(d ? d.def.n+' 受到' : '敌方总部受到')+' '+dmg+' 点伤害，「航母战」加强版（花费+'+(lvl+1)+'，伤害+'+copy.dmgAdd+'）加入敌方手牌。');
      } else logMsg('航母战：'+(d ? d.def.n+' 受到' : '敌方总部受到')+' '+dmg+' 点伤害（敌方手牌已满）。');
      break; }
    case 'tora': {
      // 虎！虎！虎！：对所有敌方目标造成 1 点伤害（含总部）
      const dmg = x(1);
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const b=S.board[r][c]; if(b && b.owner===foeSide){ b.hp -= dmg; if(hasFx(b,'onDamagedDraw')){ drawCards(playerOf(b.owner), 1); logMsg(b.def.n+' 受到伤害：抽 1 张牌'); } n++; if(b.hp <= 0){ const p2=findPosOf(b); if(p2) killUnit(p2.r, p2.c); } } }
      applyHqDamage(foe, dmg);
      logMsg('虎！虎！虎！：敌方 '+(n||'无')+' 个单位与总部受到 '+dmg+' 点伤害！');
      break; }
    case 'lastResort': {
      // 亡命之计：对所有敌方目标造成 2 点伤害（含总部），友方失去 1 个指挥点槽
      const dmg = x(2);
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const b=S.board[r][c]; if(b && b.owner===foeSide){ b.hp -= dmg; if(hasFx(b,'onDamagedDraw')){ drawCards(playerOf(b.owner), 1); logMsg(b.def.n+' 受到伤害：抽 1 张牌'); } n++; if(b.hp <= 0){ const p2=findPosOf(b); if(p2) killUnit(p2.r, p2.c); } } }
      applyHqDamage(foe, dmg);
      me.kreditSlots = Math.max(0, me.kreditSlots - 1); me.slotsLost = (me.slotsLost||0) + 1;
      logMsg('亡命之计：敌方 '+(n||'无')+' 个单位与总部受到 '+dmg+' 点伤害，失去 1 个指挥点槽。');
      break; }
    case 'empireForce': {
      // 帝国之力：弃掉双方所有激活的反制，对敌方总部造成 2 点伤害
      const pa = S.p.counters.length, aa = S.a.counters.length;
      S.p.counters = []; S.a.counters = [];
      S.p.counterHit = {}; S.a.counterHit = {};
      applyHqDamage(foe, x(2)); checkGameOver();
      logMsg('帝国之力：弃掉双方反制（'+pa+'/'+aa+' 个），敌方总部受到 2 点伤害。');
      break; }
    case 'edict': {
      // 天皇诏令：使本回合下个友方伤害指令造成的伤害 +1
      me.edictNext = true;
      logMsg('天皇诏令：下个友方伤害指令造成的伤害 +1。');
      break; }
    case 'baopo': {
      // 爆破（STZ-5喀秋莎生成）：对一个单位造成 1 点伤害（可砸己方或敌方单位；总部不可指）
      if(tgt && tgt.hq){ toast('请选择单位'); return false; }
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择单位'); return false; }
      damageUnit(d, 1);
      logMsg('爆破：对 '+d.def.n+' 造成 1 点伤害。');
      break; }
    case 'strategicFocus': {
      // 战略重心（抉择）：对所有陆军（抉择1）或空军（抉择2）造成 5 点伤害（双方单位都受伤）
      S.pendingChoice = { eff:'strategicFocus', side, card, options:[
        { id:'c1', n:'抉择 1 · 陆军', img:'卡牌/苏/战略重心抉择1.jpg', desc:'对所有陆军造成 5 点伤害' },
        { id:'c2', n:'抉择 2 · 空军', img:'卡牌/苏/战略重心抉择2.jpg', desc:'对所有空军造成 5 点伤害' }
      ] };
      HOOKS.onChoice(S.pendingChoice.options);
      logMsg('战略重心：抉择吧——陆军，或空军。');
      break; }
    case 'eagleClaw': { const br=backRowOf(foeSide); const us=[]; for(let c=0;c<COLS;c++){ const x=S.board[br][c]; if(x && x.owner===foeSide) us.push(x); } const dmg=x(2); const n=massDamage(us, dmg); logMsg('鹰爪：敌方支援阵线 '+(n||'无')+' 个单位受伤'); break; }
    case 'airStrike': {
      // 空中闪击：可指向任意一方总部（文档：对1个总部造成3点伤害）；无目标（AI/自动）默认打敌方
      const victim = (tgt && tgt.hq) ? (tgt.hqSide === 'p' ? S.p : S.a) : foe;
      victim.hp -= x(3);
      logMsg('空中闪击：对' + (victim === S.p ? '己方' : '敌方') + '总部造成 3 点伤害');
      break; }
    case 'bismarck': {
      // KM 俾斯麦号：可指向任意一方总部（文档：对1个总部造成8点伤害）；无目标（AI/自动）默认打敌方
      const victim = (tgt && tgt.hq) ? (tgt.hqSide === 'p' ? S.p : S.a) : foe;
      applyHqDamage(victim, x(8)); checkGameOver();
      logMsg('KM 俾斯麦号：对' + (victim === S.p ? '己方' : '敌方') + '总部造成 8 点伤害！');
      break; }
    case 'tirpitz': {
      applyHqDamage(foe, x(4)); checkGameOver();
      S.deployBlock = { side: foeSide };
      logMsg('KM 提尔皮茨号：对敌方总部造成 4 点伤害，敌方下个回合无法部署单位！');
      break; }
    case 'yamamoto': {
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const x = S.board[r][c];
        if(x && x.owner===side && (x.def.t==='fighter' || x.def.t==='bomber') && !x.yamamoto){
          x.atk += 1; x.yamamoto = true;
          if(!hasSig(x,'blitz')){ x.def.sig.push('blitz'); x.yamamotoBlitz = true; }
          n++;
        }
      }
      logMsg('山本五十六：本回合友方空军 +1 攻击并获得闪击（' + n + ' 个单位）');
      break; }
    case 'missouri': {
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner!==foeSide || tgt.row!==1){ toast('请选择敌方前线单位'); return false; }
      logMsg('BB-63 密苏里号：消灭前线 ' + d.def.n);
      killUnit(tgt.row, tgt.col);
      // 相邻单位（同排左右）撤退：前线单位撤退到己方支援阵线空位；支援阵线满则返回手牌（满9弃置）
      for(const dc of [tgt.col-1, tgt.col+1]){
        if(dc < 0 || dc >= COLS) continue;
        const nb = S.board[tgt.row][dc];
        if(!nb || nb.owner !== foeSide) continue;
        const slot = emptyBacklineSlot(foeSide);
        if(slot){
          // bound 绑定按 sacrifice 逻辑处理（仙台联队离开战场，归还被绑定单位）
          if(nb.bound && nb.bound.u){ const b=nb.bound; if(!S.board[b.r][b.c]){ S.board[b.r][b.c]=b.u; logMsg('仙台联队离开战场，'+b.u.def.n+' 返回！'); } }
          S.board[tgt.row][dc] = null;
          S.board[slot.row][slot.col] = nb;
          syncRowSig(nb); // 三式中战车：撤至支援战线 → 重获伏击/守护
          logMsg('密苏里号：' + nb.def.n + ' 撤退到己方支援阵线。');
        } else {
          S.board[tgt.row][dc] = null;
          if(handReturnsToHand(foeSide, nb.def, { row:tgt.row, col:dc })){
            logMsg('密苏里号：' + nb.def.n + ' 支援阵线已满，撤退回手牌。');
          } else { logMsg('密苏里号：' + nb.def.n + ' 手牌已满，无处可去。'); HOOKS.onCardBurst(nb.def, nb.owner); } // 满手爆牌：撤退单位丢失
        }
      }
      break; }
    case 'burningSky': {
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner!==foeSide || (d.def.t!=='fighter' && d.def.t!=='bomber')){ toast('请选择敌方空军目标'); return false; }
      doDamage(d, x(4)); logMsg('燃烧的天空：对 '+d.def.n+' 造成 4 点伤害'); break; }
    case 'fromPeople': {
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner!==foeSide){ toast('请选择敌方单位'); return false; }
      doDamage(d, x(3)); logMsg('来自人民：对 '+d.def.n+' 造成 3 点伤害'); break; }
    // 口径（用户 2026-09-13）：卡面写「对所有目标造成 X 点伤害」→ 总部那一份同样走总入口
    case 'winterWar': { const us=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x) us.push(x); } const dmg=x(1); massDamage(us, dmg); applyHqDamage(me, dmg); applyHqDamage(foe, dmg); logMsg('冬季战争：所有单位与双方总部受到 '+dmg+' 点伤害'); checkGameOver(); break; }
    case 'winterOffensive': { const us=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x) us.push(x); } const dmg=x(4); massDamage(us, dmg); applyHqDamage(me, dmg); applyHqDamage(foe, dmg); logMsg('冬季攻势：所有单位与双方总部受到 '+dmg+' 点伤害！'); checkGameOver(); break; }
    case 'bloodSickle': {
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner!==foeSide){ toast('请选择敌方单位'); return false; }
      doDamage(d, x(1));
      me.hp -= 1; drawCards(me,1); logMsg('血红镰刀：'+d.def.n+' 与友方总部各 1 点伤害，抽 1 张牌'); break; }
    case 'greatWar': {
      // 伟大的卫国战争：双方总部防御力直接设为 12（直接更改 → 数字白色）
      me._hqSilent = true; me.hp = 12; me.maxHp = 12; me._hqSilent = false;
      foe._hqSilent = true; foe.hp = 12; foe.maxHp = 12; foe._hqSilent = false;
      HOOKS.onHqHpChange(side, 'set', 12, 12);
      HOOKS.onHqHpChange(foeSide, 'set', 12, 12);
      logMsg('伟大的卫国战争：双方总部防御力设为 12'); break; }
    case 'fortify': { me.hp += 7; me.maxHp += 7; logMsg('防御工事：友方总部 +7 防御力'); break; }
    case 'tea': {
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const x = S.board[r][c];
        if(x && x.owner===side && x.def.nation==='gb'){ x.maxHp += 2; x.hp += 2; n++; }
      }
      logMsg('红茶：友方英国单位 +2 防御力（' + (n||'无') + ' 个单位）');
      break; }
    case 'navalSupport': {
      // 海军支援：使 1 个单位的攻击力等同于其防御力（可指友方或敌方单位）
      // 对敌方使用=削攻（攻>防时降到防）；对友方使用=提攻（攻<防时升到防）
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d){ toast('请选择单位'); return false; }
      // 攻击力等同于当前防御力（当前血量，非血量上限）
      if(d.atk !== d.hp){
        const was = d.atk;
        d.atk = d.hp;
        logMsg('海军支援：' + d.def.n + ' 攻击力 ' + was + '→' + d.atk + '（等同于当前防御力）。');
      } else logMsg('海军支援：' + d.def.n + ' 攻击力已等同于防御力，效果不触发。');
      break; }
    case 'rampage': {
      // 猛袭：消灭1个敌方步兵；若其攻击力大于你的指挥点槽数，失去1个指挥点槽
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner !== foeSide || d.def.t !== 'infantry'){ toast('请选择敌方步兵'); return false; }
      const atk = atkOf(d), nm = d.def.n;
      killUnit(tgt.row, tgt.col);
      if(atk > me.kreditSlots){
        me.kreditSlots = Math.max(0, me.kreditSlots - 1); me.slotsLost = (me.slotsLost||0) + 1;
        logMsg('猛袭：消灭 ' + nm + '，其攻击力(' + atk + ')大于你的指挥点槽，失去 1 个指挥点槽！');
      } else logMsg('猛袭：消灭 ' + nm + '。');
      break; }
    case 'mudSeason': {
      // 泥泞季：对所有单位造成等同于其行动花费（油费）的伤害
      const us = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x) us.push(x); }
      const n = massDamage(us, u2 => u2.def.fuel || 0);
      logMsg('泥泞季：所有单位受到等同于其行动花费的伤害（' + n + ' 个单位）。');
      break; }
    case 'usArmyAir': {      // 美国陆军航空队：从牌库抽1张美国轰炸机和1张美国战斗机
      const drawByType = t => {
        for(let i=0;i<me.deck.length;i++){
          const c = me.deck[i];
          if(c && c.kind==='unit' && c.t === t && c.nation === 'us'){ me.deck.splice(i,1); return c; }
        }
        return null;
      };
      const b = drawByType('bomber'), f = drawByType('fighter');
      if(b){ if(me.hand.length < MAX_HAND){ me.hand.push(b); logMsg('美国陆军航空队：抽到轰炸机「' + b.n + '」。'); } else { me.deck.push(b); logMsg('手牌已满，轰炸机留在牌库。'); } }
      if(f){ if(me.hand.length < MAX_HAND){ me.hand.push(f); logMsg('美国陆军航空队：抽到战斗机「' + f.n + '」。'); } else { me.deck.push(f); logMsg('手牌已满，战斗机留在牌库。'); } }
      if(!b && !f) logMsg('美国陆军航空队：牌库中没有美国轰炸机/战斗机。');
      // Boss 挑战玩家增强：一切抽牌摸到抽取卡（PB2Y卡罗纳多）都触发特效（不走 drawCards 的自定义抽牌路径同样生效）
      bossPlayerReveal(b); bossPlayerReveal(f);
      break; }
    case 'killEnemy': {
      // 武士之刃：消灭1个敌方单位
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner !== foeSide){ toast('请选择敌方单位'); return false; }
      killUnit(tgt.row, tgt.col);
      logMsg('武士之刃：消灭 ' + d.def.n + '。');
      break; }
    case 'hammer': {
      // 铁锤：对1个敌方陆军造成6点伤害
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner !== foeSide || !isArmyType(d.def.t)){ toast('请选择敌方陆军'); return false; }
      doDamage(d, x(6));
      logMsg('铁锤：对 ' + d.def.n + ' 造成 6 点伤害');
      break; }
    case 'carpetBomb': { const us=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===foeSide) us.push(x); } const dmg=x(3); const n=massDamage(us, dmg); logMsg('地毯式轰炸：敌方全部 '+(n||'无')+' 个单位受到 '+dmg+' 点伤害'); break; }
    case 'desertRat': {
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner!==foeSide){ toast('请选择敌方单位'); return false; }
      doDamage(d, x(1));
      if(d.hp > 0){ applySuppress(d); logMsg('沙漠之鼠：'+d.def.n+' 受到 1 点伤害并被压制'); }
      break; }
    case 'montgomery': {
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner!==foeSide){ toast('请选择敌方单位'); return false; }
      const neighbors = [[tgt.row-1,tgt.col],[tgt.row+1,tgt.col],[tgt.row,tgt.col-1],[tgt.row,tgt.col+1]];
      let cnt=0;
      const supp = (u)=>{ if(!u) return; if(applySuppress(u)) cnt++; };
      supp(d);
      neighbors.forEach(([r,c])=>{ if(r>=0&&r<ROWS&&c>=0&&c<COLS){ const x=S.board[r][c]; if(x && x.owner===foeSide) supp(x); } });
      drawCards(me,1);
      logMsg('蒙哥马利：压制 '+cnt+' 个单位并抽 1 张牌');
      break; }
    case 'draw2': { drawCards(me,2); logMsg('MX 175 护航队：抽 2 张牌'); break; }
    case 'amphibious': {
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner!==foeSide || d.atk > 3){ toast('请选择攻击力≤3 的敌方单位'); return false; }
      logMsg('两栖进攻：消灭 '+d.def.n); killUnit(tgt.row,tgt.col); break; }
    case 'powerSurge': {
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner!==side || d.def.t !== 'fighter'){ toast('请选择友方战斗机'); return false; }
      d.atk += 1; d.surged = true;
      if(!hasSig(d,'fight')) d.def.sig.push('fight');
      logMsg('火力爆发：'+d.def.n+' 本回合 +1 攻击并具有奋战'); break; }
    case 'bombRaid': {
      // 指向总部：3 点伤害 + 随机 2 个敌方底线单位各 2 点伤害
      if(tgt && tgt.hq){
        applyHqDamage(foe, x(3)); checkGameOver(); logMsg('轰炸突袭：对敌方总部造成 3 点伤害');
        const br = backRowOf(foeSide);
        const list = [];
        for(let c=0;c<COLS;c++){ const x=S.board[br][c]; if(x && x.owner===foeSide) list.push([br,c]); }
        for(let i=list.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [list[i],list[j]]=[list[j],list[i]]; }
        const chosen = list.slice(0,2);
        for(const [r,c] of chosen){ const x=S.board[r][c]; if(x){ doDamage(x,2); logMsg('轰炸突袭：对 '+x.def.n+' 造成 2 点伤害'); } }
        break;
      }
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner!==foeSide){ toast('请选择敌方单位'); return false; }
      doDamage(d, x(3));
      const neighbors = [[tgt.row-1,tgt.col],[tgt.row+1,tgt.col],[tgt.row,tgt.col-1],[tgt.row,tgt.col+1]];
      neighbors.forEach(([r,c])=>{ if(r>=0&&r<ROWS&&c>=0&&c<COLS){ const x=S.board[r][c]; if(x && x.owner===foeSide){ doDamage(x,2); } } });
      logMsg('轰炸突袭：目标 3 点伤害，相邻目标 2 点伤害');
      break; }
    /* ======================= 盟国（波/法/芬/意） ======================= */
    case 'extendLine': {
      // 延长战线：将 1 张「军团」加入支援阵线，并触发等同于友方「军团」数量的情报
      const n0 = addDerivedToBoard(side, 'legion', 1);
      let cnt = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && x.def.id==='legion') cnt++; }
      if(cnt > 0) intelDeploy(side, { n:'延长战线', sig:['情报'+cnt] });
      logMsg('延长战线：'+n0+' 张「军团」加入支援阵线，触发 '+cnt+' 点情报。');
      break; }
    case 'punish': {
      // 严惩：敌方随机弃 1 张牌；若是明牌，友方抽 1 张牌
      const foePl = playerOf(foeSide);
      const pool = foePl.hand.filter(c => c);
      if(!pool.length){ toast('敌方没有手牌'); return false; }
      const pick = pool[Math.floor(Math.random()*pool.length)];
      const wasRevealed = !!pick.revealed;
      if(discardCard(foePl, pick)){
        logMsg('严惩：敌方随机弃掉「' + pick.n + '」' + (wasRevealed ? '（明牌）' : '') + '。');
        if(wasRevealed) drawCards(me, 1);
      }
      break; }
    case 'westPlan': {
      // 西线计划：将 2 张「军团」加入支援阵线
      const n1 = addDerivedToBoard(side, 'legion', 2);
      logMsg('西线计划：'+n1+' 张「军团」加入支援阵线。');
      break; }
    case 'resistance': {
      // 抵抗（加入敌方手牌）：抉择——对友方总部 1 点伤害 / 移除己方卡组顶 1 张牌
      if(side === 'a' || isAI){
        // AI：优先移除卡组顶（无伤），卡组空则承受伤害
        if(me.deck.length){ me.deck.pop(); logMsg('抵抗：移除卡组顶 1 张牌。'); }
        else { me.hp -= 1; logMsg('抵抗：卡组已空，友方总部受到 1 点伤害。'); checkGameOver(); }
      } else {
        const opts = [
          { id:'c1', n:'抉择 1 · 承受伤害', img:'卡牌/法/抵抗.png', desc:'对友方总部造成 1 点伤害' },
          { id:'c2', n:'抉择 2 · 移除卡组顶', img:'卡牌/法/抵抗.png', desc:'移除己方卡组顶的 1 张牌' }
        ];
        S.pendingChoice = { eff:'resistance', side:'p', options:opts, card };
        HOOKS.onChoice(opts);
        logMsg('抵抗：抉择吧——承受 1 点伤害，或移除卡组顶 1 张牌。');
      }
      break; }
    case 'resistanceHail': {
      addResistToEnemy(side, 1);
      drawCards(me, 1);
      logMsg('抵抗万岁！抽 1 张牌。');
      break; }
    case 'honorLoyalty': {
      // 荣誉与忠诚：将目标单位洗入其所有者卡组；其所有者抽 2 张牌
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      const owner = playerOf(d.owner);
      const p = findPosOf(d);
      if(p) S.board[p.r][p.c] = null;
      owner.deck.push(JSON.parse(JSON.stringify(d.def)));
      shuffle(owner.deck);
      drawCards(owner, 2);
      logMsg('荣誉与忠诚：' + d.def.n + ' 被洗入其所有者卡组，其所有者抽 2 张牌。');
      break; }
    case 'compromise': {
      // 妥协：抉择——① 抽 1 张牌 + 友方总部 +3 防御力；② 双方玩家各把「抽 1 张牌、总部 +3 防御力」进行 2 次
      const bothTwice = () => {
        for(let i=0;i<2;i++){
          drawCards(me, 1); me.maxHp += 3; me.hp += 3;
          drawCards(foe, 1); foe.maxHp += 3; foe.hp += 3;
        }
      };
      if(side === 'a' || isAI){
        // AI：默认选择对自己更稳的 ①；落后较多（血量与手牌双落后）时才博 ②
        if(S.a.hp < S.p.hp && S.a.hand.length <= S.p.hand.length) bothTwice();
        else { drawCards(me, 1); me.maxHp += 3; me.hp += 3; }
        logMsg('妥协（AI）：' + (S.a.hp >= S.p.hp ? '抽 1 张牌，总部 +3 防御力。' : '双方玩家各进行两次。'));
      } else {
        const opts = [
          { id:'c1', n:'抉择 1 · 抽牌加固', img:'卡牌/法/妥协.png', desc:'抽 1 张牌，友方总部 +3 防御力' },
          { id:'c2', n:'抉择 2 · 双方两次', img:'卡牌/法/妥协.png', desc:'双方玩家各进行两次：各抽 2 张牌、双方总部各 +6 防御力' }
        ];
        S.pendingChoice = { eff:'compromise', side:'p', options:opts, card };
        HOOKS.onChoice(opts);
        logMsg('妥协：抉择吧——抽 1 张牌并加固总部，或双方玩家各进行两次。');
      }
      break; }
    case 'deepDefense': {
      // 纵深防御：对 1 个单位造成等同于敌方手牌数的伤害
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      const dmg = Math.max(0, playerOf(foeSide).hand.length);
      doDamage(d, dmg);
      logMsg('纵深防御：对 ' + d.def.n + ' 造成 ' + dmg + ' 点伤害（敌方手牌数）。');
      break; }
    case 'callColony': {
      // 呼叫殖民地：抉择——友方总部 +8 防御力 / 抽 2 张牌
      if(side === 'a' || isAI){
        me.maxHp += 8; me.hp += 8;
        logMsg('呼叫殖民地（AI）：友方总部 +8 防御力。');
      } else {
        const opts = [
          { id:'c1', n:'抉择 1 · 加固总部', img:'卡牌/法/呼叫殖民地.png', desc:'使友方总部获得 +8 防御力' },
          { id:'c2', n:'抉择 2 · 抽两张', img:'卡牌/法/呼叫殖民地.png', desc:'抽 2 张牌' }
        ];
        S.pendingChoice = { eff:'callColony', side:'p', options:opts, card };
        HOOKS.onChoice(opts);
        logMsg('呼叫殖民地：抉择吧——总部 +8 防御力，或抽 2 张牌。');
      }
      break; }
    case 'armedResistance': {
      // 武装抵抗：将 1 张「抵抗」加入敌方手牌，并使敌方手牌中「抵抗」的数量与花费双双翻倍
      const foePl = playerOf(foeSide);
      addResistToEnemy(side, 1);
      const resists = foePl.hand.filter(c => c && c.eff === 'resistance');
      const doubled = resists.map(c => (c.blood || 1) * 2);
      let added = 0;
      for(let i=0;i<resists.length;i++){
        if(foePl.hand.length >= MAX_HAND) break;
        const rc = makeResist();
        rc.revealed = true;               // 明牌：塞牌方看得见
        rc.blood = doubled[i];            // 补入的复制体按翻倍后花费
        handPushRevealed(foePl, rc);
        added++;
      }
      resists.forEach((c, i) => { c.blood = doubled[i]; });   // 原有抵抗花费翻倍
      logMsg('武装抵抗：敌方手牌中「抵抗」数量与花费翻倍（补入 ' + added + ' 张，花费 ×2）。');
      break; }
    case 'phonyWar': {
      // 假战：双方抽牌，直到手牌数为 8
      const dp = Math.max(0, 8 - me.hand.length);
      const da = Math.max(0, 8 - foe.hand.length);
      if(dp) drawCards(me, dp);
      if(da) drawCards(foe, da);
      logMsg('假战：双方补抽至 8 张手牌（友方 +' + dp + '，敌方 +' + da + '）。');
      break; }
    case 'liberation': {
      // 解放：将 3 张「抵抗」加入敌方手牌；友方总部获得等同于敌方手牌数的防御力
      addResistToEnemy(side, 3);
      const add = playerOf(foeSide).hand.length;
      me.maxHp += add; me.hp += add;
      logMsg('解放：友方总部获得 +' + add + ' 防御力（等同于敌方手牌数）。');
      break; }
    case 'saarOffensive': {
      // 萨尔攻势：对 1 个单位造成 7 点伤害；若是本回合使用的第 1 张指令，将 1 张「洛林十字」加入手牌
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      doDamage(d, 7);
      logMsg('萨尔攻势：对 ' + d.def.n + ' 造成 7 点伤害。');
      if(!me.orderUsedThisTurn){
        const lor = NATIONS.fr.orders.find(o => o.id === 'lorraine');
        if(lor && me.hand.length < MAX_HAND){ handPushRevealed(me, mkOrderDef(lor, 'fr')); logMsg('萨尔攻势：本回合第 1 张指令，「洛林十字」加入手牌。'); }
      }
      me.orderUsedThisTurn = true;
      break; }
    case 'ruinHand': {
      // 毁坏：随机展示敌方 3 张手牌 → 由玩家选择 1 张弃掉，并将 1 张复制加入友方手牌
      const foePl = playerOf(foeSide);
      const pool = foePl.hand.filter(c => c);
      if(!pool.length){ toast('敌方没有手牌'); return false; }
      const picks = shuffle(pool.slice()).slice(0, 3);
      if(side === 'a' || isAI){
        // AI：随机取 1 张
        const chosen = picks[Math.floor(Math.random()*picks.length)];
        if(discardCard(foePl, chosen)){
          logMsg('毁坏：弃掉敌方「' + chosen.n + '」。');
          if(me.hand.length < MAX_HAND){ handPushRevealed(me, JSON.parse(JSON.stringify(chosen))); logMsg('毁坏：1 张复制加入友方手牌。'); }
        }
      } else {
        const options = picks.map((c, i) => ({
          id:'c' + i, n:c.n, img:c.img || '',
          desc:'弃掉敌方这张牌，并将 1 张复制加入你的手牌'
        }));
        S.pendingChoice = { eff:'ruinHand', side:'p', options, picks, card };
        HOOKS.onChoice(options);
        logMsg('毁坏：敌方手牌中随机展示 ' + picks.length + ' 张——选择 1 张弃掉。');
      }
      break; }
    case 'weighOptions': {
      // 权衡：抽 2 张牌 → 由玩家点击手牌弃掉 1 张（点击手牌即结算；结束回合未选则自动弃最低费）
      const drawn = drawCards(me, 2);
      if(side === 'a' || isAI){
        me.mustDiscardOne = true;                       // AI 走回合结束自动弃
        logMsg('权衡（AI）：抽 ' + drawn + ' 张牌，将弃掉 1 张。');
      } else {
        S.discardPick = { card, n:1, label:'权衡' };
        logMsg('权衡：抽 ' + drawn + ' 张牌——请点击手牌弃掉 1 张。');
      }
      break; }
    case 'lorraine': {
      // 洛林十字（法）：花费已由 playCost 按敌方手牌数降低；对 1 个敌方目标造成 3 点伤害
      if(tgt && tgt.hq){ applyHqDamage(foe, 3); checkGameOver(); logMsg('洛林十字：对敌方总部造成 3 点伤害。'); }
      else {
        const d = tgt ? unitAt(tgt.row, tgt.col) : null;
        if(!d || d.owner === side){ toast('请选择敌方目标'); return false; }
        doDamage(d, 3);
        logMsg('洛林十字：对 ' + d.def.n + ' 造成 3 点伤害。');
      }
      break; }
    case 'maginot': {      // 马奇诺防线（指令）：使 1 个陆军获得 +3/+4，且无法撤退或被抑制
      const d = (tgt ? unitAt(tgt.row, tgt.col) : null) || allyList(side).map(t=>t.u).find(u => isArmyType(u.def.t));
      if(!d){ toast('没有可加持的陆军'); return false; }
      d.atk += 3; d.hp += 4; d.maxHp += 4;
      if(!(d.def.fx||[]).includes('inhibitImmune')) d.def.fx = (d.def.fx||[]).concat(['inhibitImmune','noRetreat']);
      logMsg('马奇诺防线：' + d.def.n + ' 获得 +3/+4，且无法撤退或被抑制。');
      break; }
    /* ======================= 芬兰 ======================= */
    case 'lotta': {
      // 洛塔组织：使所有友方单位获得 +1 防御力和 -1 行动花费
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const x = S.board[r][c];
        if(x && x.owner===side){ x.maxHp += 1; x.hp += 1; x.def.fuel = Math.max(0, (x.def.fuel||0) - 1); n++; }
      }
      logMsg('洛塔组织：' + n + ' 个友方单位获得 +1 防御力、行动花费 -1。');
      break; }
    case 'molotov': {
      // 莫洛托夫鸡尾酒：造成 2 点伤害；敌方随机弃 1 张牌；友方回合结束时弃掉此牌
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      doDamage(d, 2);
      const dc = randomDiscard(playerOf(foeSide));
      if(dc) logMsg('莫洛托夫鸡尾酒：敌方弃掉「' + dc.n + '」。');
      playerOf(side).discardAtTurnEnd = (playerOf(side).discardAtTurnEnd || []).concat([{ id:'molotov', n:'莫洛托夫鸡尾酒' }]);
      logMsg('莫洛托夫鸡尾酒：对 ' + d.def.n + ' 造成 2 点伤害（回合结束时弃掉此牌）。');
      break; }
    case 'whiteDeath': {
      // 白色死神：抑制所有敌方单位；将 1 张具有闪击的「游击队员」加入支援阵线
      let n = 0;
      enemyList(side).forEach(t => { if(applyInhibit(t.u)) n++; });
      addDerivedToBoard(side, 'guerrilla', 1, { mods: d => { d.sig = ['blitz']; } });
      logMsg('白色死神：抑制 ' + n + ' 个敌方单位，并加入 1 张闪击「游击队员」。');
      break; }
    case 'freeze': {
      // 强制冻结：将 1 个「游击队员」加入 1 个友方单位相邻处，使其具有闪击和收缴
      const anchor = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!anchor || anchor.owner !== side){ toast('请选择 1 个友方单位'); return false; }
      const spots = [[anchor.row-1,anchor.col],[anchor.row+1,anchor.col],[anchor.row,anchor.col-1],[anchor.row,anchor.col+1]]
        .filter(([r,c]) => r>=0 && r<ROWS && c>=0 && c<COLS && !S.board[r][c]);
      const def = makeDerived('guerrilla');
      def.sig = ['blitz','seize'];
      def.desc = (def.desc||'') + '；闪击·收缴';
      let ok = false;
      if(spots.length){ const [r,c] = spots[Math.floor(Math.random()*spots.length)]; ok = spawnUnit(side, def, r, c); }
      if(!ok){ for(let r=0;r<ROWS && !ok;r++) for(let c=0;c<COLS && !ok;c++){ if(!S.board[r][c]) ok = spawnUnit(side, def, r, c); } }
      logMsg('强制冻结：' + (ok ? '1 张「游击队员」加入战场（闪击·收缴）。' : '没有空位，效果不触发。'));
      break; }
    case 'longSiege': {
      // 长久围困：抽 4 张牌；下个友方回合结束时将其弃掉
      const d = drawCards(me, 4);
      playerOf(side).discardAtTurnEnd = (playerOf(side).discardAtTurnEnd || []).concat([{ id:'longsiege', n:'长久围困' }]);
      logMsg('长久围困：抽 ' + d + ' 张牌（下个友方回合结束时弃掉此牌）。');
      break; }
    /* ======================= 意大利 ======================= */
    case 'colonialDream': {
      // 殖民梦：手牌中单位数最多的玩家抽 2 张牌
      const cntUnits = pl => pl.hand.filter(c => c && c.kind === 'unit').length;
      const mu = cntUnits(me), fu = cntUnits(foe);
      if(mu >= fu){ drawCards(me, 2); logMsg('殖民梦：友方单位手牌较多（' + mu + ' vs ' + fu + '），抽 2 张牌。'); }
      else { drawCards(foe, 2); logMsg('殖民梦：敌方单位手牌较多（' + fu + ' vs ' + mu + '），敌方抽 2 张牌。'); }
      break; }
    case 'directStrike': {
      // 单刀直入：压制 1 个单位；若其具有唯一最高的攻击力，将其消灭
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      const top = Math.max(...[].concat(...Array.from({length:ROWS},(_,r)=>Array.from({length:COLS},(_,c)=>S.board[r][c])).map(u=>u?u.atk:-1)), 0);
      let topCount = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.atk === top) topCount++; }
      applySuppress(d);
      if(d.atk === top && topCount === 1){ const p = findPosOf(d); if(p) killUnit(p.r, p.c); logMsg('单刀直入：' + d.def.n + ' 具有唯一最高攻击力，被消灭！'); }
      else logMsg('单刀直入：' + d.def.n + ' 被压制。');
      break; }
    case 'steelPact': {
      // 钢铁条约：双方各抽 1 张牌，弃掉花费更低的那张，重复 3 次
      for(let i=0;i<3;i++){
        if(!me.deck.length || !foe.deck.length) break;
        drawCards(me, 1); drawCards(foe, 1);
        const mine = me.hand[me.hand.length-1], his = foe.hand[foe.hand.length-1];
        if(!mine || !his) break;
        const mc = (mine.blood||0), hc = (his.blood||0);
        if(mc <= hc) discardCard(me, mine);
        else discardCard(foe, his);
      }
      logMsg('钢铁条约：双方各抽 3 轮，花费更低者被弃掉。');
      break; }
    case 'attackColony': {
      // 进攻殖民地：对 1 个敌方目标造成 3 点伤害，并使友方总部 +5 防御力
      if(tgt && tgt.hq){ applyHqDamage(foe, 3); checkGameOver(); logMsg('进攻殖民地：对敌方总部造成 3 点伤害。'); }
      else {
        const d = tgt ? unitAt(tgt.row, tgt.col) : null;
        if(!d || d.owner === side){ toast('请选择敌方目标'); return false; }
        doDamage(d, 3);
        logMsg('进攻殖民地：对 ' + d.def.n + ' 造成 3 点伤害。');
      }
      me.maxHp += 5; me.hp += 5;
      logMsg('进攻殖民地：友方总部 +5 防御力。');
      break; }
    case 'lionOfDay': {
      // 一日之狮：消灭 1 个攻击力不小于 4 的单位
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.atk < 4){ toast('请选择攻击力不小于 4 的单位'); return false; }
      const p = findPosOf(d);
      if(p) killUnit(p.r, p.c);
      logMsg('一日之狮：消灭 ' + d.def.n + '（攻击力 ' + d.atk + '）。');
      break; }
    case 'navalBattle': {
      // 海军交战：完全修复友方支援阵线的所有单位；消灭敌方支援阵线的所有单位
      const myBack = backRowOf(side), foeBack = backRowOf(foeSide);
      let heal = 0, kill = 0;
      for(let c=0;c<COLS;c++){ const x=S.board[myBack][c]; if(x && x.owner===side){ if(x.hp < x.maxHp){ x.hp = x.maxHp; heal++; } } }
      for(let c=COLS-1;c>=0;c--){ const x=S.board[foeBack][c]; if(x && x.owner===foeSide){ killUnit(foeBack, c); kill++; } }
      logMsg('海军交战：修复友方支援阵线 '+heal+' 个单位，消灭敌方支援阵线 '+kill+' 个单位。');
      break; }
          case '战时盟国': {
        // 英 战时盟国（金·7费）：将1个敌方单位洗入友方卡组。
        // 「敌方单位」= owner !== side（**不要**用 enemyOf(side)，那返回的是玩家对象）：tgt 由玩家点选/AI 指定，
        // 非法（空/指向自己人/总部）时随机兜底（与俯冲轰炸、荣誉与忠诚同口径）。
        // 「洗入卡组」= 进**施放者自己的**卡组、随机位置（同 stirlingCarpet / 调整 handCardShuffleIn）——
        // 注意与「荣誉与忠诚」（洗入**其所有者**卡组）的区别：卡面写的是「友方卡组」，即我方的卡组。
        // 移动的是卡面本体快照（def 深拷贝），不带走场上的临时增益（同驱逐/荣誉与忠诚）。
        let d = tgt ? unitAt(tgt.row, tgt.col) : null;
        if(!d || d.owner !== foeSide) d = rand(enemyList(side).map(t => t.u));
        if(!d){ toast('没有敌方单位'); return false; }
        const pos = findPos(d);
        if(pos) S.board[pos.r][pos.c] = null;
        // 绑定类单位（京都联队/仙台联队）非死亡离场时归还被绑单位（写法同密苏里号撤退；非绑定单位此行为空转）
        if(d.bound && d.bound.u && !S.board[d.bound.r][d.bound.c]){
          S.board[d.bound.r][d.bound.c] = d.bound.u;
          logMsg('战时盟国：' + d.bound.u.def.n + ' 返回战场。');
        }
        const stolen = JSON.parse(JSON.stringify(d.def));   // 每次深拷贝 = 新对象，多次使用不会共享引用
        const at = me.deck.length ? Math.floor(Math.random()*(me.deck.length + 1)) : 0; // 随机位置（含卡组顶/底）
        me.deck.splice(at, 0, stolen);
        logMsg('战时盟国：' + d.def.n + ' 被洗入你的卡组（随机位置）。');
        break; }
      case '租借法案': {
        // 英 租借法案（铜·7费）：抽4张牌。
        // 完全沿用「英联邦」的抽牌写法；drawCards 自带手牌上限（9）与牌库空时的士气疲劳结算，
        // 返回值=实际抽到的张数（被手牌上限/疲劳截断时如实记录，不虚报 4 张）。
        const got = drawCards(me, 4);
        logMsg('租借法案：抽 ' + got + ' 张牌。');
        break; }
      case '统治吧！不列颠尼亚！': {
        // 英 统治吧！不列颠尼亚！（金·8费）：使所有友方英国单位获得+2防御力，使其攻击力等同于其防御力。
        // 「友方英国单位」= owner===side && def.nation==='gb'（与红茶 tea 完全同判据）：
        //   被他国单位（美/苏…）或「战时盟国」洗进来的外国卡都不受影响。
        // 「+2防御力」= maxHp 与当前 hp 同步 +2（既有全批写法：红茶/妥协/我们能做到！）。
        // 「攻击力等同于其防御力」= atk = **当前 hp**（口径同海军支援 navalSupport：当前防御力=当前血量，非上限），
        //   且是「设定」而非「+X」——攻高于防的单位会被拉低到防（字面实现）。
        let n = 0;
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
          const y = S.board[r][c];
          if(y && y.owner === side && y.def.nation === 'gb'){
            y.maxHp += 2; y.hp += 2;
            y.atk = y.hp;
            // 与「俯冲轰炸」（F1 批次）的攻击力归零叠加时，同步暂存值，免得回合开始还原出旧攻击力（非叠加时空转）
            if(y.atkZeroBy && y.atk0Prev != null) y.atk0Prev = y.hp;
            n++;
          }
        }
        logMsg('统治吧！不列颠尼亚！：' + (n || '无') + ' 个友方英国单位获得 +2 防御力，攻击力等同于防御力。');
        break; }
      /* ======================= 新增主国指令 ======================= */
    case '调整': {
      // 日 调整（0费·铁）：选择1张手牌洗入卡组，抽1张牌。
      // 复用 fx-A1 已接好线的手牌点选槽 S.discardPick（权衡/霹雳师同款）：
      //   toDeck:true → ui.js 的手牌点击分支无需改动即可点击手牌；
      //   shuffleIn:true → 语义改为「洗入卡组（随机位置）+ 抽 1 张」，由 P1/P2 两个补丁识别。
      // 本卡在玩家侧此刻仍在手牌（结算与扣费推迟到点选时，见 P1），故牌池要排除自己
      const pool = me.hand.filter(c => c && c !== card);
      if(!pool.length){ toast('手牌中没有其他牌可洗入'); return false; }
      if(side === 'a' || isAI || GAME_RULES.headless){
        const ch = pool[Math.floor(Math.random()*pool.length)];
        handCardShuffleIn(me, ch);
        logMsg('调整：将「' + ch.n + '」洗入卡组，抽 1 张牌。');
        drawCards(me, 1);
        break;
      }
      S.discardPick = { card:card, n:1, label:'调整', toDeck:true, shuffleIn:true };
      logMsg('调整：请点击 1 张手牌，将其洗入卡组并抽 1 张牌（按 ESC 或结束回合将自动选择）。');
      break; }
    case '帝国指令': {
      // 日 帝国指令（1费·铁）：完全修复1个单位，使其获得+1+1.
      // 「完全修复」= hp 回到 maxHp（口径同海军交战 navalBattle）；先修复再 +1/+1
      // 目标口径（用户 2026-09-13）：卡面只写「1个单位」→ 任何单位（敌对单位也允许，target 已改判 'any'）；
      // 总部不是单位（unitAt 返回 null）→ toast + return false，卡不消耗
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      const healed = Math.max(0, d.maxHp - d.hp);
      d.hp = d.maxHp;
      d.atk += 1; d.maxHp += 1; d.hp += 1;
      logMsg('帝国指令：完全修复 ' + d.def.n + '（+' + healed + ' 防御力），并获得 +1/+1。');
      break; }
    case '新式战法': {
      // 日 新式战法（1费·铁）：使1个单位忽略「无法攻击敌方总部」。
      // 卡面没写「直到回合结束」→ 按**永久**（对该单位）实现：置 u.ignoreNoHq = true，
      // attackTargets 里两处 noHq 过滤改为 `hasFx(u,'noHq') && !u.ignoreNoHq`（见 P3）。
      // 本批可达成的收益：四一式山炮(t41)/Ki-84 疾风(ki84) 这两张带 noHq 的日械可打敌方总部
      // 目标口径（用户 2026-09-13）：任何单位（含敌方单位，target 已改判 'any'）；总部/空目标 → return false
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      d.ignoreNoHq = true;
      logMsg('新式战法：' + d.def.n + ' 不再受「无法攻击敌方总部」限制。');
      break; }
    case '极限使命': {
      // 日 极限使命（1费·铁）：消灭1个友方单位，抽2张牌。
      // 目标校验与消灭写法同「武士之刃 killEnemy」，只是归属反过来（自己人）
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side){ toast('请选择友方单位'); return false; }
      logMsg('极限使命：消灭 ' + d.def.n + '。');
      killUnit(tgt.row, tgt.col);        // 走标准死亡流程：亡计/离场特效照常触发
      drawCards(me, 2);
      logMsg('极限使命：抽 2 张牌。');
      break; }
    case '责无旁贷': {
      // 日 责无旁贷（1费·铁）：使1个友方单位获得+1+1。此前每使用过1张「责无旁贷」，额外获得一次+1+1。
      // 计数口径完全沿用「预备役」reserveUsed（本局累计，第 1 张只 +1/+1，第 2 张 +2/+2……）
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side){ toast('请选择友方单位'); return false; }
      const extra = me.zewuUsed || 0;      // 此前已使用张数
      const times = 1 + extra;             // 本次 +1/+1 的次数
      d.atk += times; d.maxHp += times; d.hp += times;
      me.zewuUsed = extra + 1;
      logMsg('责无旁贷：' + d.def.n + ' 获得 +' + times + '/+' + times + '（此前已使用 ' + extra + ' 张）。');
      break; }
    case '为了天皇': {
      // 日 为了天皇（1费·银）：使所有友方日本单位具有+1攻击力和-1行动花费，直到回合结束。
      // 采用「闪电战 blitzKrieg」的光环口径（侧标记 + atkOf/actFuelCost 读取 + clearTurnBuffs 清除），
      // 好处：本回合内之后部署的日本单位同样生效，且卡面攻/油显示自动正确
      //（ui.js 用 atkOf / actFuelCost 渲染，见 P5/P6/P7）
      me.jpBuff1 = true;
      me.jpFuelMinus1 = true;
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const y = S.board[r][c]; if(y && y.owner === side && y.def.nation === 'jp') n++; }
      logMsg('为了天皇：' + n + ' 个友方日本单位获得 +1 攻击力、-1 行动花费（直到回合结束）。');
      break; }
    case '穷兵黩武': {
      // 日 穷兵黩武（2费·银）：消灭1个攻击力不大于友方指挥点槽数的单位。失去1个指挥点槽。
      // 判定上限取「打出的瞬间」的槽数（先记后扣）；同类扣槽写法见拂晓行动/南进计划
      // （卡面已由 P8 在 orderTargets 里预先过滤掉不合格目标，这里再校验一次兜底）
      const slots = me.kreditSlots || 0;
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.atk > slots){ toast('请选择攻击力不大于 ' + slots + ' 的单位'); return false; }
      logMsg('穷兵黩武：消灭 ' + d.def.n + '（攻击力 ' + d.atk + ' ≤ 指挥点槽 ' + slots + '）。');
      killUnit(tgt.row, tgt.col);
      me.kreditSlots = Math.max(0, me.kreditSlots - 1); me.slotsLost = (me.slotsLost||0) + 1;
      logMsg('穷兵黩武：失去 1 个指挥点槽（现 ' + me.kreditSlots + ' 个）。');
      break; }
    case '最后的仪式': {
      // 日 最后的仪式（3费·金）：将8张「神风特攻队」洗入卡组。
      // 「神风特攻队」= DERIVED_CARDS 里的衍生**指令**，用 makeDerived 取（返回指令卡形状）；
      // 每张插到卡组随机位置（口径同斯特林 MK III 的 stirlingCarpet / 试制橘花的亡计）
      if(!makeDerived('神风特攻队')){ logMsg('最后的仪式：未找到「神风特攻队」，效果不触发。'); break; }
      let n = 0;
      for(let i=0;i<8;i++){
        const kf = makeDerived('神风特攻队');   // 每次调用都是新对象，8 张之间不共享引用
        kf.desc = '对敌方总部造成 1 点伤害，抽 1 张牌';
        const at = me.deck.length ? Math.floor(Math.random()*(me.deck.length+1)) : 0;
        me.deck.splice(at, 0, kf); n++;
      }
      logMsg('最后的仪式：' + n + ' 张「神风特攻队」洗入卡组。');
      break; }
    case '枪林弹雨': {
      // 日 枪林弹雨（3费·铁）：对1个敌方单位和其相邻目标造成1点伤害。压制受到此伤害的单位。
      // 相邻口径沿用「轰炸突袭 bombRaid」：上下左右四格、且只算敌方单位（伤害指令只伤敌方）；
      // 压制沿用 applySuppress（免疫压制者不生效），只压制「受到伤害且存活」者（同沙漠之鼠）
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== foeSide){ toast('请选择敌方单位'); return false; }
      const dmg = x(1);                       // 天皇诏令 +1：整张卡只消耗一次加成
      const hit = [d];
      const nbs = [[tgt.row-1,tgt.col],[tgt.row+1,tgt.col],[tgt.row,tgt.col-1],[tgt.row,tgt.col+1]];
      for(const [r, c] of nbs){
        if(r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
        const y = S.board[r][c];
        if(y && y.owner === foeSide) hit.push(y);
      }
      let sup = 0;
      for(const y of hit){
        doDamage(y, dmg);                     // orderEffect 内的既有局部助手（含死亡/受伤抽牌结算）
        if(y.hp > 0 && applySuppress(y)) sup++;
      }
      logMsg('枪林弹雨：' + hit.length + ' 个敌方单位受到 ' + dmg + ' 点伤害，' + sup + ' 个被压制。');
      break; }
    case '玉碎': {
      // 日 玉碎（3费·铁）：使1个友方单位获得+4+4。回合结束时，将其消灭。
      // 回合结束时消灭沿用「方面军 frontArmyTanks」的写法：记账单位引用，
      // 统一在 triggerFriendlyTurnEnd(side) 里 findPosOf → killUnit（见 P4）；
      // 该函数在玩家侧（endPlayerTurn）与 AI 侧（beginPlayerTurn）各调用一次，两侧都覆盖
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side){ toast('请选择友方单位'); return false; }
      d.atk += 4; d.maxHp += 4; d.hp += 4;
      me.yusuiUnits = (me.yusuiUnits || []).concat([d]);
      logMsg('玉碎：' + d.def.n + ' 获得 +4/+4（回合结束时被消灭）。');
      break; }

      /* ======================= batch-F3：日（3 张指令） ======================= */

      case '指挥不当': {
      // 指挥不当（日·铜 3费）：消灭 1 个「攻击力小于防御力」的单位。
      // 卡面写「1个单位」→ 双方单位皆可指向（cards.js 已写 target:'any'）；合法目标预过滤见 §P5。
      // 「攻击力/防御力」按卡面当前值比较（即 u.atk < u.hp，与 UI 显示一致，不额外计光环）。
      const dA = tgt ? unitAt(tgt.row, tgt.col) : null;
      let tA = null;
      if(dA && dA.atk < dA.hp) tA = { u:dA, r:tgt.row, c:tgt.col };
      else if(dA){ toast('请选择攻击力小于防御力的单位'); return false; }
      else {
        const poolA = [];                                  // 无目标（AI/自动结算）：从合法目标里随机兜底
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const t = S.board[r][c]; if(t && t.atk < t.hp) poolA.push({u:t,r,c}); }
        if(!poolA.length){ toast('没有攻击力小于防御力的单位'); return false; }
        tA = poolA[Math.floor(Math.random()*poolA.length)];
      }
      logMsg('指挥不当：消灭 ' + tA.u.def.n + '（攻击力 ' + tA.u.atk + ' < 防御力 ' + tA.u.hp + '）。');
      killUnit(tA.r, tA.c);                                // 标准死亡流程：亡计/离场特效照常
      checkGameOver();
      break; }

      case '侦察队': {
      // 侦察队（日·银 3费）：将 2 个「搜索第三十三联队」加入支援阵线。
      // 卡名以 cards.js 为准 = 「搜索第33联队」（jp units id:'s33'，doc 写「第三十三」），故按 **id** 取定义。
      // 落位/写法同族：空中掩护 spawnF2As、遥远的桥 resolveBridgeTooFar（底线逐列找空位 → spawnUnit）。
      // 生成物照常触发部署效果（与空中掩护一致）；s33 没有部署效果，只有 onDamagedDraw 被动。
      const rawA = (typeof NATIONS !== 'undefined' && NATIONS.jp) ? NATIONS.jp.units.find(x => x.id === 's33') : null;
      if(!rawA){ logMsg('侦察队：未找到「搜索第33联队」，效果不触发。'); break; }
      const brA = backRowOf(side);
      let gotA = 0;
      for(let i=0;i<2;i++){
        const defA = mkUnitDef(rawA, 'jp');                // 每张独立定义（sig/fx 已 slice），2 张不共享引用
        let okA = false;
        for(let c=0;c<COLS;c++) if(!S.board[brA][c]){ if(spawnUnit(side, defA, brA, c)){ okA = true; break; } }
        if(!okA) break;                                    // 支援阵线满了就停
        gotA++;
      }
      logMsg('侦察队：' + gotA + ' 个「搜索第33联队」加入支援阵线。');
      break; }

      case '暴风雨前的宁静': {
      // 暴风雨前的宁静（日·银 4费）：使所有友方单位获得 +3/+1，然后**立即结束本回合**。
      // +3/+1 的写法同航母打击群（atk/maxHp/hp 一起走）；「结束回合」见 §C 的 resolveImmediateEndTurn。
      let nA = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const yA = S.board[r][c];
        if(yA && yA.owner === side){ yA.atk += 3; yA.maxHp += 1; yA.hp += 1; nA++; }
      }
      logMsg('暴风雨前的宁静：' + nA + ' 个友方单位获得 +3/+1——本回合就此结束。');
      resolveImmediateEndTurn(side);
      break; }

      /* ======================= batch-F3：美（6 张指令） ======================= */

      case '陆军工程兵团': {
      // 陆军工程兵团（美·铁 0费）：使 1 个坦克或步兵获得 +1/+1。
      // 写法同「为了自由 forFreedom」（同款目标校验 + toast + 不消耗卡牌返回 false）；
      // 目标口径（用户 2026-09-13）：**任一阵营**的坦克或步兵（target 已改判 'any'）；
      // 合法目标预过滤见 §P5（orderTargets 里按 card.eff 过滤掉炮兵/空军）。
      const dB = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!dB){ toast('请选择 1 个坦克或步兵'); return false; }
      if(dB.def.t !== 'tank' && dB.def.t !== 'infantry'){ toast('只能选择坦克或步兵'); return false; }
      dB.atk += 1; dB.maxHp += 1; dB.hp += 1;
      logMsg('陆军工程兵团：' + dB.def.n + ' 获得 +1/+1。');
      break; }

      case '战略规划': {
      // 战略规划（美·金 10费）：将所有友方单位的攻击力和防御力翻倍。
      // 「防御力翻倍」= 当前防御力与上限同时 ×2（与 +1/+1 类增益同口径：hp/maxHp 一起走）；
      // 只作用于场上单位（不含总部）。atk 翻的是「本体值」，atkOf 的光环照常另算，与既有增益一致。
      let nB = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const yB = S.board[r][c];
        if(!yB || yB.owner !== side) continue;
        yB.atk = yB.atk * 2;
        yB.maxHp = yB.maxHp * 2;
        yB.hp = Math.min(yB.maxHp, yB.hp * 2);
        nB++;
      }
      logMsg('战略规划：' + nB + ' 个友方单位的攻击力与防御力翻倍。');
      break; }

      case '消耗战': {
      // 消耗战（美·铁 2费）：对 1 个单位造成 2 点伤害。若是老兵，使其撤退。
      // 「老兵」= hasSig(u,'veteran')（promoteR7 / promoteVeteran / promoteToVeteran 都挂这个 sig）。
      // 「撤退」= 规则.txt 的撤退：前线→己方支援阵线空位；支援阵线已满或本就在支援阵线 → 返回手牌。
      // 复用密苏里号/丘吉尔 AVRE 的同一段逻辑（已抽成 retreatUnit，见 §C；既有两处未改动）。
      const dC = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!dC){ toast('请选择 1 个单位'); return false; }
      const vetC = hasSig(dC, 'veteran');
      const nmC = dC.def.n;
      const dmgC = x(2);                                   // 天皇诏令只吃一次（同枪林弹雨）
      damageUnit(dC, dmgC);                                // 统一伤害入口（含受伤抽牌与死亡结算）
      if(vetC && dC.hp > 0 && findPosOf(dC)){
        logMsg('消耗战：对 ' + nmC + ' 造成 ' + dmgC + ' 点伤害；它是老兵，被迫撤退。');
        retreatUnit(dC.owner, dC);
      } else {
        logMsg('消耗战：对 ' + nmC + ' 造成 ' + dmgC + ' 点伤害。');
      }
      checkGameOver();
      break; }

      case '防火墙': {
      // 防火墙（美·铁 2费）：使 1 个单位获得「无法攻击敌方总部」。
      // 就是既有的 noHq 标记（四一式山炮 t41 / Ki-84 疾风 ki84 自带）：
      // attackTargets 里两处 `if(hasFx(u,'noHq')) return out.filter(x=>!x.hq);` 直接生效，无需改既有代码。
      // 用 concat 生成新数组（不就地 push），避免污染同源 def.fx —— 与「近卫机械化第12旅」挂标记同写法。
      const dD = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!dD){ toast('请选择 1 个单位'); return false; }
      if(hasFx(dD, 'noHq')){ logMsg('防火墙：' + dD.def.n + ' 本来就无法攻击敌方总部。'); break; }
      dD.def.fx = (dD.def.fx || []).concat(['noHq']);
      logMsg('防火墙：' + dD.def.n + ' 获得「无法攻击敌方总部」。');
      break; }

      case '黑夜巡视': {
      // 黑夜巡视（美·铁 2费）：抽 2 张牌。选择 1 张手牌并将其返回卡组顶。
      // 与「霹雳师」的部署效果完全同款（抽 2 + 选 1 张手牌回卡组顶），只是换成指令卡：
      //   点选槽复用 S.discardPick.toDeck（fx-A1 建立，ui.js 手牌点击分支无需改动），出口 handCardToDeckTop；
      //   指令额外挂 orderConsume —— 卡牌留在手牌，**点选时才扣费并移除**（三个补丁 §P2/§P3/§P4）。
      //   side==='a' / isAI / headless 时不等玩家，直接随机 1 张结算（与霹雳师 第175 同口径）。
      drawCards(me, 2);
      logMsg('黑夜巡视：抽 2 张牌。');
      const poolD = me.hand.filter(c => c && c !== card);   // 本卡此刻仍在手牌 → 牌池排除自己
      if(!poolD.length){
        logMsg('黑夜巡视：没有其他手牌可返回卡组顶。');
      } else if(side === 'a' || isAI || GAME_RULES.headless){
        const chD = poolD[Math.floor(Math.random()*poolD.length)];
        handCardToDeckTop(me, chD);
        logMsg('黑夜巡视：将「' + chD.n + '」返回卡组顶。');
      } else {
        S.discardPick = { card:card, n:1, label:'黑夜巡视', toDeck:true, orderConsume:true };
        logMsg('黑夜巡视：请点击 1 张手牌，将其返回卡组顶（按 ESC 或结束回合将自动选择）。');
      }
      break; }

      case '战时美利坚': {
      // 战时美利坚（美·铁 3费）：额外获得 1 个指挥点槽。若剩余指挥点数不小于 2，抽 1 张牌。
      // 槽 +1 完全照「战争机器 warMachine」（上限 24，不动当前指挥点）。
      // 「剩余指挥点数」= **支付本卡之后**剩下的指挥点：玩家侧的费用是 orderEffect 返回后才由 ui.js 扣，
      // 所以这里自行扣掉本卡花费；AI 侧（execPlay / Boss 脚本）调用前已扣过，isAI 为真时不再重复扣。
      me.kreditSlots = Math.min(24, me.kreditSlots + 1);
      const selfCostE = isAI ? 0 : (typeof playCost === 'function' ? playCost(me, card) : (card.blood || 0));
      const restE = me.kredit - selfCostE;
      if(restE >= 2){
        drawCards(me, 1);
        logMsg('战时美利坚：指挥点槽 +1；剩余指挥点 ' + restE + '（≥2），抽 1 张牌。');
      } else {
        logMsg('战时美利坚：指挥点槽 +1；剩余指挥点 ' + restE + ' 不足 2，不抽牌。');
      }
      break; }

    /* ======================= batch-F5：英 新卡指令 ======================= */
    case '两难困境': {
      // 英 两难困境（1费·铁）：将 1 个单位的攻击力和行动花费交换。
      // 「行动花费」= 卡面油费（u.def.fuel）：直接对调两个数，永久生效（卡面未写「直到回合结束」）；
      // 攻击力写 u.atk（与既有 +X 攻击力口径一致，不含光环加成）。actionFuel 的显示走 actFuelCost → def.fuel，
      // 因此换出来的新油费会被拂晓/逆光/闪电战等既有减免照常作用（与「油费 -1」类改 def.fuel 的写法同源）。
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      const atk0 = d.atk, fuel0 = (d.def.fuel || 0);
      d.atk = fuel0; d.def.fuel = atk0;
      logMsg('两难困境：' + d.def.n + ' 的攻击力与行动花费交换（⚔' + atk0 + '/⛽' + fuel0 + ' → ⚔' + d.atk + '/⛽' + d.def.fuel + '）。');
      break; }

          case '坚决守护': {
        // 英 坚决守护（1费·铁）：使1个守护单位获得+1+3。
        // 目标口径（用户 2026-09-13）：**任一阵营**的守护单位（target 已改判 'any'；orderTargets 已只按守护过滤）；
        // 预选目标类型不合格 → toast + return false（卡不消耗）；无预选时才走随机兜底（AI/无头不卡）
        const guardOk = x => hasSig(x,'guard');
        if(!orderTgtValid(tgt, guardOk)){ toast('请选择 1 个守护单位'); return false; }
        const d = orderPickUnit(tgt, guardOk);
        if(!d){ toast('没有守护单位'); return false; }
        d.atk += 1; d.maxHp += 3; d.hp += 3;              // +1/+3 写法同帝国指令/马奇诺防线
        logMsg('坚决守护：' + d.def.n + ' 获得 +1/+3。');
        break; }
      case '袋鼠运输': {
        // 英 袋鼠运输（1费·铁）：使1个英国步兵获得闪击和+1重甲。使其也算作是坦克。
        //  · 闪击 = sig 直挂 'blitz'（同山本五十六/巴顿）
        //  · +1 重甲 = u.armor（combat 减伤读它）+ def.armor（回手/复制后仍保留）同步 +1
        //  · 「也算作是坦克」= def.fx 挂 alsoTank，坦克判定统一走 isTankUnit（见补丁 P1~P6）
        // 目标口径（用户 2026-09-13）：**任一阵营**的英国步兵（target 已改判 'any'）；
        // 预选不是英国步兵 → orderPickUnit 找不到合法项 → toast + return false（卡不消耗）
        const gbInfOk = x => x.def.t === 'infantry' && x.def.nation === 'gb';
        if(!orderTgtValid(tgt, gbInfOk)){ toast('请选择 1 个英国步兵'); return false; }
        const d = orderPickUnit(tgt, gbInfOk);
        if(!d){ toast('没有英国步兵'); return false; }
        if(!hasSig(d,'blitz')) d.def.sig = (d.def.sig || []).concat(['blitz']);
        d.armor = (d.armor || 0) + 1;
        d.def.armor = (d.def.armor || 0) + 1;
        if(!hasFx(d,'alsoTank')) d.def.fx = (d.def.fx || []).concat(['alsoTank']);
        logMsg('袋鼠运输：' + d.def.n + ' 获得闪击与 +1 重甲（现 ' + d.armor + '），并算作坦克。');
        break; }
      case '观察团': {
        // 英 观察团（1费·铁）：选择1张花费不小于5的手牌，使其获得-2花费。
        // 手牌点选沿用 S.discardPick 槽位（权衡/霹雳师/调整 同款），靠 costCut 标记区分（补丁 P8/P9）；
        // 「-2 花费」永久生效（卡面没写「直到回合结束」）→ 直接改手牌对象的 blood（playCost 读它）。
        const COST_MIN = 5, COST_CUT = 2;
        const pool = me.hand.filter(c => c && c !== card && (c.blood||0) >= COST_MIN);
        if(!pool.length){ toast('手牌中没有花费不小于 ' + COST_MIN + ' 的牌'); return false; }
        if(side === 'a' || isAI || GAME_RULES.headless){   // AI/无头：直接挑花费最高的一张结算
          pool.sort((a,b) => (b.blood||0) - (a.blood||0));
          const ch = pool[0];
          ch.blood = Math.max(0, (ch.blood||0) - COST_CUT);
          logMsg('观察团：' + ch.n + ' 的花费 -' + COST_CUT + '（现 ' + ch.blood + '）。');
          break;
        }
        S.discardPick = { card:card, n:1, label:'观察团', costCut:COST_CUT, costMin:COST_MIN };
        logMsg('观察团：请点击 1 张花费不小于 ' + COST_MIN + ' 的手牌，使其花费 -' + COST_CUT + '（按 ESC 或结束回合将自动选择）。');
        break; }
      case '防空弹幕': {
        // 英 防空弹幕（1费·铁）：使1个空军撤退，使友方总部获得+2防御力。
        // 目标口径（用户 2026-09-13）：**任一阵营**的空军（友军也可以撤）；cards.js 的 target 已是 'any'。
        // 预选不是空军 → orderPickUnit 找不到合法项 → toast + return false（卡不消耗）；
        // 友方总部 +2 那半句不变。
        const airOk = x => x.def.t === 'fighter' || x.def.t === 'bomber';
        if(!orderTgtValid(tgt, airOk)){ toast('请选择 1 个空军单位'); return false; }
        const d = orderPickUnit(tgt, airOk);
        if(!d){ toast('没有空军单位'); return false; }
        const res = retreatUnit(d);
        me.maxHp += 2; me.hp += 2;                        // 友方总部 +2 防御力（口径同炮艇任务/工兵第329营）
        logMsg('防空弹幕：' + d.def.n + (res === 'back' ? ' 撤退到支援阵线'
          : res === 'hand' ? ' 返回其所有者手牌' : ' 手牌已满，撤退丢失') + '，友方总部 +2 防御力。');
        render(); checkGameOver();
        break; }
      case '战术撤退': {
        // 英 战术撤退（1费·铜）：使前线1个友方单位撤退，将其完全修复。本回合可再次操作此单位。
        // 「完全修复」= hp 回到 maxHp（口径同海军交战）；「本回合可再次操作」= 清掉三个行动标记
        const d = orderPickUnit(tgt, x => x.owner === side && S.board[1].indexOf(x) >= 0);
        if(!d){ toast('前线没有友方单位'); return false; }
        const nm = d.def.n;
        const res = retreatUnit(d);
        if(res !== 'back'){
          // 支援阵线已满 → 按「撤退」规则返回手牌（此时已不在场上，完全修复/再操作无对象可作用）
          logMsg('战术撤退：' + nm + (res === 'hand' ? ' 退回手牌（支援阵线已满）。' : ' 手牌已满，撤退丢失。'));
          render();
          break;
        }
        d.hp = d.maxHp;                                   // 完全修复
        d.movedThisTurn = false; d.attackedN = 0; d.summonedThisTurn = false;
        logMsg('战术撤退：' + nm + ' 撤退到支援阵线，已完全修复，本回合可再次行动。');
        render();
        break; }
      case '为了国王': {
        // 英 为了国王（2费·铁）：对1个敌方坦克造成5点伤害。
        // 走 orderEffect 内的既有伤害助手 doDamage（含死亡结算/受伤抽牌）；x(5) 吃一次天皇诏令
        const d = orderPickUnit(tgt, x => x.owner !== side && isTankUnit(x));
        if(!d){ toast('没有敌方坦克'); return false; }
        doDamage(d, x(5));
        logMsg('为了国王：对 ' + d.def.n + ' 造成 5 点伤害。');
        break; }
      case '咬紧牙关': {
        // 英 咬紧牙关（2费·铁）：抽1张牌。若有友方守护单位，额外抽1张牌。
        let guardN = 0;
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
          const y = S.board[r][c];
          if(y && y.owner === side && hasSig(y,'guard')) guardN++;
        }
        let drawn = drawCards(me, 1);                      // 抽牌一律走 drawCards 出口（既有规则如封抽照常生效）
        if(guardN) drawn += drawCards(me, 1);
        logMsg('咬紧牙关：抽 ' + drawn + ' 张牌'
          + (guardN ? '（友方守护单位 ' + guardN + ' 个，额外抽 1 张）。' : '（没有友方守护单位）。'));
        break; }
      case '拖延战术': {
        // 英 拖延战术（2费·铁）：使前线所有单位撤退。
        // 「所有单位」= 双方前线单位（同冬季战争/斩草除根的双方口径）；
        // 每个都走统一撤退出口 retreatUnit（前线→己方支援阵线空位；满则返回所有者手牌）
        const list = [];
        for(let c=0;c<COLS;c++){ const y = S.board[1][c]; if(y) list.push(y); }
        let back = 0, hand = 0, lost = 0;
        for(const y of list){
          const res = retreatUnit(y);
          if(res === 'back') back++; else if(res === 'hand') hand++; else if(res === 'lost') lost++;
        }
        logMsg('拖延战术：前线 ' + list.length + ' 个单位撤退——' + back + ' 个退到支援阵线'
          + (hand ? '，' + hand + ' 个返回手牌' : '') + (lost ? '，' + lost + ' 个手牌已满被丢弃' : '') + '。');
        render(); checkGameOver();
        break; }
      case '深沟固垒': {
        // 英 深沟固垒（2费·铁）：使1个友方守护单位获得+3攻击力、奋战和收缴。
        // 奋战 = sig 'fight'（喷火 MkIIa/N1K-J紫电同款）；收缴 = sig 'seize'（combat 内 hasSig(a,'seize') → seizeCopy）
        const d = orderPickUnit(tgt, x => x.owner === side && hasSig(x,'guard'));
        if(!d){ toast('没有友方守护单位'); return false; }
        d.atk += 3;
        const got = [];
        if(!hasSig(d,'fight')){ d.def.sig = (d.def.sig || []).concat(['fight']); got.push('奋战'); }
        if(!hasSig(d,'seize')){ d.def.sig = (d.def.sig || []).concat(['seize']); got.push('收缴'); }
        logMsg('深沟固垒：' + d.def.n + ' 获得 +3 攻击力'
          + (got.length ? '与' + got.join('、') : '（奋战/收缴原本就有）') + '。');
        break; }
      case '空投补给': {
        // 英 空投补给（2费·铁）：使1个坦克或步兵获得+4防御力和守护，失去烟幕。
        // 守护与烟幕互斥（同三式中战车 syncRowSig 口径）：给守护的同时移除烟幕词条
        // 目标口径（用户 2026-09-13）：**任一阵营**的坦克或步兵（target 已改判 'any'）；
        // 预选不是坦克/步兵 → orderPickUnit 找不到合法项 → toast + return false（卡不消耗）
        const dropOk = x => isTankUnit(x) || x.def.t === 'infantry';
        if(!orderTgtValid(tgt, dropOk)){ toast('请选择 1 个坦克或步兵'); return false; }
        const d = orderPickUnit(tgt, dropOk);
        if(!d){ toast('没有坦克或步兵'); return false; }
        d.maxHp += 4; d.hp += 4;
        const hadSmoke = hasSig(d,'smoke');
        if(hadSmoke) d.def.sig = (d.def.sig || []).filter(s => s !== 'smoke');
        if(!hasSig(d,'guard')) d.def.sig = (d.def.sig || []).concat(['guard']);
        d.guardLost = false;                              // 新获得守护 → 清掉「守护失效」标记（第19装甲师 t19GuardBreak）
        logMsg('空投补给：' + d.def.n + ' 获得 +4 防御力与守护' + (hadSmoke ? '，失去烟幕' : '') + '。');
        break; }
      case 'coerce': {
      // 胁迫：抑制 1 个单位
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      applyInhibit(d);
      break; }
    case 'nightBomb': {
      // 夜间轰炸：消灭 1 个未受伤单位，随机排列所有敌方单位
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.hp !== d.maxHp){ toast('请选择 1 个未受伤的单位'); return false; }
      const p = findPosOf(d);
      if(p) killUnit(p.r, p.c);
      logMsg('夜间轰炸：消灭未受伤的 ' + d.def.n + '。');
      shuffleSideBoard(foeSide);
      break; }
    case 'highBomb': {
      // 高空轰炸：随机消灭 2 个敌方单位
      let n = 0;
      for(let i=0;i<2;i++){
        const list = enemyList(side);
        if(!list.length) break;
        const t = list[Math.floor(Math.random()*list.length)];
        logMsg('高空轰炸：随机消灭 ' + t.u.def.n + '。');
        killUnit(t.r, t.c); n++;
      }
      if(!n){ toast('无敌方单位'); return false; }
      break; }
    case 'ironOre': {
      // 北方铁矿：若前线有友方单位，获得 3 个指挥点
      const ok = S.board[1].some(x => x && x.owner === side);
      if(!ok){ toast('前线没有友方单位'); return false; }
      me.kredit += 3;
      logMsg('北方铁矿：获得 3 个指挥点（当前 ' + me.kredit + '）。');
      break; }
    case '扩张': {
      // ★★★ 警告：本块不属于 applyDeploy！apply-fx.mjs 会把它一起插到 applyDeploy 的锚点，
      //     插完请把本块**整块剪走**，粘到 orderEffect 的 switch(e) 里 `case 'ironOre'` 之后。
      //     留在 applyDeploy 里是死代码（没有单位以 '扩张' 为 deploy id），不报错但**不生效**。
      // 扩张（日·铁 1费 指令）：若前线有友方日本单位，抽2张牌。
      // 口径与「北方铁矿 ironOre」完全一致：前线 = 第 1 行；不满足条件则 return false
      //   （orderEffect 返回 false → 调用方把卡退回手牌、指挥点退回，见 AI 侧与玩家侧的 !ok 分支）。
      // 「日本单位」用 def.nation==='jp' 判定（与古德里安 guderian 的 x.def.nation==='de' 同法）。
      const frontJp = S.board[1].some(x => x && x.owner === side && x.def.nation === 'jp');
      if(!frontJp){ toast('前线没有友方日本单位'); return false; }
      const drew = drawCards(me, 2);
      logMsg('扩张：前线有友方日本单位，抽 ' + drew + ' 张牌。');
      break; }
    case 'guderian': {
      // 古德里安：使前线所有友方德国坦克获得 +2/+1
      let n = 0;
      for(let c=0;c<COLS;c++){ const x=S.board[1][c]; if(x && x.owner===side && x.def.t==='tank' && x.def.nation==='de'){ x.atk+=2; x.hp+=1; x.maxHp+=1; n++; } }
      logMsg('古德里安：前线 '+n+' 个德国坦克获得 +2/+1。');
      break; }
    case '俯冲轰炸': {
      let d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner === foeSide){
        const list = enemyList(side);
        d = list.length ? list[Math.floor(Math.random()*list.length)].u : null;
      }
      if(!d){ toast('没有敌方单位'); return false; }
      damageUnit(d, x(1));
      if(d.hp > 0){
        d.atk0Prev = d.atk;
        d.atkZeroBy = side;
        d.atk = 0;
        logMsg('俯冲轰炸：' + d.def.n + ' 受到 1 点伤害，攻击力变为 0（直到下个友方回合开始）。');
      } else {
        logMsg('俯冲轰炸：' + d.def.n + ' 受到 1 点伤害并被消灭。');
      }
      checkGameOver();
      break; }
    case '转变攻击': {
      let d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side){
        const list = allyList(side);
        d = list.length ? list[Math.floor(Math.random()*list.length)].u : null;
      }
      if(!d){ toast('没有友方单位'); return false; }
      const pos = findPosOf(d);
      if(me.hand.length >= MAX_HAND){
        if(pos) killUnit(pos.r, pos.c);
        logMsg('转变攻击：' + d.def.n + ' 手牌已满，无法返回，被摧毁！');
        HOOKS.onCardBurst(d.def, d.owner);
        checkGameOver();
        break;
      }
      const cdef = JSON.parse(JSON.stringify(d.def));
      if(pos) S.board[pos.r][pos.c] = null;
      if(!cdef.zeroCostEOT){ cdef.zeroCostEOT = true; cdef.costPrev = cdef.blood || 0; }
      cdef.blood = 0;
      handPushRevealed(me, cdef);
      logMsg('转变攻击：' + d.def.n + ' 返回你的手牌，花费变为 0（直到回合结束）。');
      break; }
    case '第二战线': {
      let d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side){
        const list = allyList(side);
        d = list.length ? list[Math.floor(Math.random()*list.length)].u : null;
      }
      if(!d){ toast('没有友方单位'); return false; }
      const pos = findPosOf(d);
      if(pos) S.board[pos.r][pos.c] = null;
      me.secondFront = (me.secondFront || []).concat([{ u:d, row: pos ? pos.r : backRowOf(side), col: pos ? pos.c : 0 }]);
      logMsg('第二战线：' + d.def.n + ' 被移出战场——下个敌方回合结束时返回支援战线并复制。');
      break; }
    case '交叉火力': {
      const dmg = x(1);
      let rounds = 0, total = 0, killed = 0;
      while(rounds < 12){
        const us = [];
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const t = S.board[r][c]; if(t && t.owner === foeSide) us.push(t); }
        if(!us.length) break;
        rounds++;
        total += massDamage(us, dmg);
        const dead = us.filter(t => t.hp <= 0).length;
        killed += dead;
        if(!dead) break;
      }
      logMsg('交叉火力：对敌方单位造成 ' + dmg + ' 点伤害（结算 ' + rounds + ' 轮，共 ' + total + ' 次命中，消灭 ' + killed + ' 个）。');
      checkGameOver();
      break; }
    case '斩草除根': {
      const list = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const t = S.board[r][c]; if(t) list.push(t); }
      for(const t of list){
        t.atk = Math.max(0, t.atk - 1);
        if(t.atkZeroBy && t.atk0Prev != null) t.atk0Prev = Math.max(0, t.atk0Prev - 1);
        t.maxHp -= 2;
        t.hp -= 2;
      }
      let dead = 0;
      for(const t of list){ if(t.hp <= 0){ const p = findPosOf(t); if(p){ killUnit(p.r, p.c); dead++; } } }
      logMsg('斩草除根：所有单位 -1/-2' + (dead ? '，' + dead + ' 个单位被消灭。' : '。'));
      checkGameOver();
      break; }
    case '大混战': {
      const us = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const t = S.board[r][c]; if(t && !hasSig(t,'veteran')) us.push(t); }
      const total = massDamage(us, x(4));
      logMsg('大混战：' + (total||'无') + ' 个非老兵单位受到 4 点伤害（老兵单位不受影响）。');
      checkGameOver();
      break; }

    case 'routCheap': {
      // 溃敌：将 1 个花费不大于 2 的单位转换为「溃军」
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || (d.def.blood||0) > 2){ toast('请选择花费不大于 2 的单位'); return false; }
      convertToRout(d);
      break; }
    case 'inhibitOne': {
      // 抑制：抑制 1 个单位；若有友方空军，抽 1 张牌
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      applyInhibit(d);
      const hasAir = allyList(side).some(t => t.u.def.t === 'fighter' || t.u.def.t === 'bomber');
      if(hasAir){ drawCards(me, 1); logMsg('抑制：有友方空军，抽 1 张牌。'); }
      break; }
    case 'alpineFort': {
      // 阿尔卑斯要塞：使友方总部的防御力为 25；从卡组顶移除 10 张牌
      me.maxHp = 25; me.hp = 25;
      let rm = 0;
      for(let i=0;i<10 && me.deck.length;i++){ me.deck.pop(); rm++; }
      logMsg('阿尔卑斯要塞：友方总部防御力设为 25，移除卡组顶 ' + rm + ' 张牌。');
      break; }
    case 'massRout': {
      // 一触即溃：将所有敌方单位转换为「溃军」
      const list = enemyList(side);
      list.forEach(t => convertToRout(t.u));
      logMsg('一触即溃：' + list.length + ' 个敌方单位被转换为「溃军」。');
      break; }
    case '星条旗': {
      // 星条旗（美·铁 5费）：对敌方支援阵线所有单位造成等同于该阵线单位数的伤害。
      // 「支援阵线」= 敌方底线（backRowOf），取行方式与既有「鹰爪 eagleClaw」逐列扫完全一致；
      // 伤害值 = 该阵线单位数（每个单位都吃满这个数字，不是总量平摊）
      const br = backRowOf(foeSide), us = [];
      for(let c=0;c<COLS;c++){ const y = S.board[br][c]; if(y && y.owner === foeSide) us.push(y); }
      if(!us.length){ toast('敌方支援阵线没有单位'); return false; }
      const dmg = x(us.length);                 // 天皇诏令：伤害指令 +1（与鹰爪同口径）
      const n = massDamage(us, dmg);            // 群解：先全体扣血、再统一处理死亡
      logMsg('星条旗：敌方支援阵线 ' + n + ' 个单位各受到 ' + dmg + ' 点伤害。');
      checkGameOver();
      break; }
    case '同盟国': {
      // 同盟国（美·银 5费）：使所有友方非美国单位获得 +2/+2。
      // 国家判定走 def.nation（与协力 coopCheck / 古德里安 同口径）；美国 = 'us'
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const y = S.board[r][c];
        if(y && y.owner === side && y.def.nation !== 'us'){ y.atk += 2; y.maxHp += 2; y.hp += 2; n++; }
      }
      logMsg('同盟国：' + n + ' 个友方非美国单位获得 +2/+2。');
      break; }
    case '爱国热忱': {
      // 爱国热忱（美·银 7费）：将 1 个友方单位的攻击力和防御力翻倍。
      // 目标点选走 tgt（cards.js 需补 target:'friendly-unit'）；tgt 为 null（AI/无头）→ 随机友方兜底（同 fx-F1 俯冲轰炸）
      let d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side){
        const list = allyList(side);
        d = list.length ? list[Math.floor(Math.random()*list.length)].u : null;
      }
      if(!d){ toast('没有友方单位'); return false; }
      const pa = d.atk, ph = d.maxHp;
      d.atk *= 2; d.maxHp *= 2; d.hp *= 2;      // 防御力翻倍 = 上限与当前值同翻（与 +X/+X 类贴膜口径一致）
      logMsg('爱国热忱：' + d.def.n + ' 攻击力与防御力翻倍（' + pa + '/' + ph + ' → ' + d.atk + '/' + d.maxHp + '）。');
      break; }
    case '背水一战': {
      // 背水一战（苏·铁 0费）：使 1 个单位获得「无法撤退或被抑制」。
      // 口径完全沿用既有「马奇诺防线 maginot」：fx 挂 inhibitImmune + noRetreat。
      // applyInhibit 已识别 inhibitImmune（免疫抑制）；noRetreat 原先没有消费点 → 由补丁 P3 在 convertToRout 落实
      let d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){
        let list = allyList(side);
        if(!list.length) list = enemyList(side); // 「1 个单位」= 任意单位：无目标时优先随机友方兜底
        d = list.length ? list[Math.floor(Math.random()*list.length)].u : null;
      }
      if(!d){ toast('没有单位'); return false; }
      d.def.fx = (d.def.fx || []).slice();
      if(!hasFx(d,'inhibitImmune')) d.def.fx.push('inhibitImmune');
      if(!hasFx(d,'noRetreat'))     d.def.fx.push('noRetreat');
      logMsg('背水一战：' + d.def.n + ' 获得「无法撤退或被抑制」。');
      break; }
    case '最后一击': {
      // 最后一击（苏·铁 1费）：使 1 个友方单位获得 +3 攻击力。友方回合结束时，将其消灭。
      // 回合末消灭沿用「方面军 frontArmyTanks」的记账写法：单位引用挂到 me.lastStrikeUnits，
      // 由 triggerFriendlyTurnEnd 里的 f4TurnEndSettle 统一 findPosOf → killUnit（见补丁 P4）
      let d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side){
        const list = allyList(side);
        d = list.length ? list[Math.floor(Math.random()*list.length)].u : null;
      }
      if(!d){ toast('没有友方单位'); return false; }
      d.atk += 3;
      me.lastStrikeUnits = (me.lastStrikeUnits || []).concat([d]);
      logMsg('最后一击：' + d.def.n + ' 获得 +3 攻击力（友方回合结束时被消灭）。');
      break; }
    case '暴风雪': {
      // 暴风雪（苏·铜 1费）：使所有单位的行动花费为 4，直到下个友方回合开始。
      // 光环挂施放方（blizzardFuel4），由 actFuelCost 统一读取（补丁 P5）：期间双方所有单位行动花费为 4；
      // 在施放方下个回合开始（resolveOwnerTurnStart）清除（补丁 P6）
      me.blizzardFuel4 = true;
      logMsg('暴风雪：所有单位的行动花费变为 4（直到你的下个回合开始）。');
      break; }
    case '焦土政策': {
      // 焦土政策（苏·铜 2费）：使所有单位的行动花费为 4（本局持续，不过期）。
      // 与暴风雪同一读取点（actFuelCost / 补丁 P5），差别只在「永不解除」
      me.scorchedFuel4 = true;
      logMsg('焦土政策：所有单位的行动花费变为 4（本局持续）。');
      break; }
    case '以剑之名': {
      // 以剑之名（苏·银 4费）：抽取等同于敌方单位数的卡牌。
      // 计数沿用既有 countEnemy(side)（不分战线）；没有敌方单位则不结算（不消耗、留在手牌）
      const n = countEnemy(side);
      if(n <= 0){ toast('敌方没有单位'); return false; }
      const got = drawCards(me, n);
      logMsg('以剑之名：敌方单位 ' + n + ' 个，抽 ' + got + ' 张牌。');
      break; }
    case '胜利旗帜': {
      // 胜利旗帜（苏·金 7费）：指向 1 个单位。将其所有者的所有单位转换为此单位。
      // 「转换」= 就地替换为「被指向单位」的复制体（不触发亡计/离场，也不触发部署效果）；
      // 复制体写法与「第二战线（fx-F1）」的复制段完全一致：makeUnit(深拷贝 def) + 同步当前数值；
      // 被替换单位若带 u.bound（京都联队/仙台联队），先按 killUnit 的口径归还被绑定单位
      let d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){
        let list = allyList(side);
        if(!list.length) list = enemyList(side);
        d = list.length ? list[Math.floor(Math.random()*list.length)].u : null;
      }
      if(!d){ toast('没有单位'); return false; }
      const own = d.owner, targets = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const y = S.board[r][c];
        if(y && y.owner === own && y !== d) targets.push({ u:y, r, c });
      }
      for(const t of targets){                                   // 先归还绑定单位，再做替换（避免占格冲突）
        if(t.u.bound && t.u.bound.u && !S.board[t.u.bound.r][t.u.bound.c]){
          S.board[t.u.bound.r][t.u.bound.c] = t.u.bound.u;
          logMsg('胜利旗帜：' + t.u.def.n + ' 离开战场，' + t.u.bound.u.def.n + ' 返回！');
        }
      }
      for(const t of targets){
        if(S.board[t.r][t.c] !== t.u) continue;                  // 被归还单位占格时跳过（极少数边界）
        const copy = makeUnit(JSON.parse(JSON.stringify(d.def)), own);
        copy.atk = d.atk; copy.maxHp = d.maxHp; copy.hp = d.hp;
        copy.baseAtk = d.baseAtk; copy.baseMaxHp = d.baseMaxHp; copy.baseFuel = d.baseFuel;
        copy.armor = d.armor;
        copy.summonedThisTurn = true;                            // 新形体当回合不能行动（与第二战线复制体同口径）
        S.board[t.r][t.c] = copy;
      }
      logMsg('胜利旗帜：' + d.def.n + ' 的所有者（' + (own === side ? '你' : '敌方') + '）的 ' + targets.length + ' 个单位转换为此单位。');
      break; }
          case 'roadBerlin': {
      // 柏林之路：使敌方总部获得——每回合累计受到 ≥3 伤害时，友方总部 +3 防御力
      playerOf(foeSide).roadBerlin = true;
      logMsg('柏林之路：敌方总部每回合累计受到 3 点以上伤害时，友方总部 +3 防御力。');
      break; }
    case 'zhukov': {
      // 朱可夫：抽 1 张苏联步兵，使其部署时获得 +1/+1 和闪击
      const pool = me.deck.filter(c => c && c.kind === 'unit' && c.t === 'infantry' && c.nation === 'su');
      if(!pool.length){ toast('卡组中没有苏联步兵'); return false; }
      const card2 = pool[Math.floor(Math.random()*pool.length)];
      const i = me.deck.indexOf(card2);
      if(i > -1) me.deck.splice(i, 1);
      card2.sig = (card2.sig || []).concat(['blitz']);
      card2.atk += 1; card2.hp += 1;
      card2.desc = (card2.desc || '') + '；(朱可夫)+1/+1·闪击';
      if(me.hand.length < MAX_HAND) me.hand.push(card2); else logMsg('手牌已满，朱可夫抽到的卡被弃置。');
      logMsg('朱可夫：抽到 ' + card2.n + '（+1/+1 且具有闪击）。');
      break; }
    case 'closeCombat': {
      // 短兵相接：使所有友方步兵具有 +3 攻击力，直到回合结束（回合结束时由 clearTurnBuffs 移除）
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && x.def.t==='infantry'){ x.atk += 3; x.tempAtk3 = true; n++; } }
      logMsg('短兵相接：' + n + ' 个友方步兵获得 +3 攻击力（直到回合结束）。');
      break; }
    case 'exploitGain': {
      // 扩大优势：若前线有友方单位，展示卡组顶 3 张单位 → 玩家选择 1 张（花费 0·闪击），其余置于卡组底
      const ok = S.board[1].some(x => x && x.owner === side);
      if(!ok){ toast('前线没有友方单位'); return false; }
      const picks = [];
      for(let i=0;i<me.deck.length && picks.length<3;i++){
        const c2 = me.deck[i];
        if(c2 && c2.kind === 'unit') picks.push(c2);
      }
      if(!picks.length){ toast('卡组顶没有单位'); return false; }
      if(side === 'a' || isAI){
        const chosen = picks.reduce((a,b) => ((b.atk||0)+(b.hp||0)) > ((a.atk||0)+(a.hp||0)) ? b : a, picks[0]);
        me.deck = me.deck.filter(c => !picks.includes(c)).concat(picks.filter(c => c !== chosen));
        chosen.blood = 0;
        chosen.sig = (chosen.sig || []).concat(['blitz']);
        chosen.desc = (chosen.desc || '') + '；(扩大优势)花费 0·闪击';
        if(me.hand.length < MAX_HAND) me.hand.push(chosen);   // 从卡组里挑牌 = 对手不知卡组内容，不进明牌（用户 2026-09-16）
        logMsg('扩大优势（AI）：' + chosen.n + ' 加入手牌（花费 0·闪击）。');
      } else {
        const options = picks.map((c, i) => ({
          id:'c' + i, n:c.n, img:c.img || '',
          desc:'⚔' + (c.atk||0) + ' · ❤' + (c.hp||0) + ' — 加入手牌（花费 0·闪击）'
        }));
        S.pendingChoice = { eff:'exploitGain', side:'p', options, picks, card };
        HOOKS.onChoice(options);
        logMsg('扩大优势：卡组顶 3 张单位——选择 1 张加入手牌（花费 0·闪击）。');
      }
      break; }
    case 'weighOptions': {
      break; }
    case 'harshWinter': {
      // 严冬：移除所有单位，将等量「轻步兵」加入同一阵线
      const snapshot = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x) snapshot.push({ side:x.owner, r, c }); }
      snapshot.forEach(s => { S.board[s.r][s.c] = null; });
      let placed = 0;
      for(const s of snapshot){
        if(placed >= 15) break;
        if(S.board[s.r][s.c]) continue;
        const def = makeDerived('lightinf');
        if(spawnUnit(s.side, def, s.r, s.c)) placed++;
      }
      logMsg('严冬：移除 ' + snapshot.length + ' 个单位，加入 ' + placed + ' 张「轻步兵」到同一阵线。');
      break; }
    case 'tractorPlant': {
      // 拖拉机厂：将 2 个「T-34 1942」加入支援阵线
      let n = 0;
      for(let i=0;i<2;i++){
        const def = mkUnitDef(NATIONS.su.units.find(u => u.id === 't34'), 'su');
        const br = backRowOf(side);
        let ok = false;
        for(let c=0;c<COLS;c++) if(!S.board[br][c]){ if(spawnUnit(side, def, br, c)){ ok = true; break; } }
        if(!ok) break;
        n++;
      }
      logMsg('拖拉机厂：' + n + ' 个「T-34 1942」加入支援阵线。');
      break; }
    case 'frontArmy': {
      // 方面军：使友方总部获得——友方回合开始时受 1 点伤害，将 1 个 T-34 加入支援阵线，回合结束时将其消灭
      me.frontArmy = true;
      logMsg('方面军：友方回合开始时受 1 点伤害并加入 1 个「T-34 1942」，回合结束时消灭它。');
      break; }
    case 'greetings': {
      // 诚挚问候：使友方总部获得 +6 防御力，抽 2 张牌
      me.maxHp += 6; me.hp += 6;
      drawCards(me, 2);
      logMsg('诚挚问候：友方总部 +6 防御力，抽 2 张牌。');
      break; }
    case 'dayBomb': {
      // 日间轰炸：对 1 个目标造成 2 点伤害，敌方失去 1 个指挥点槽
      if(tgt && tgt.hq){ applyHqDamage(foe, 2); checkGameOver(); logMsg('日间轰炸：对敌方总部造成 2 点伤害。'); }
      else {
        const d = tgt ? unitAt(tgt.row, tgt.col) : null;
        if(!d || d.owner === side){ toast('请选择敌方目标'); return false; }
        doDamage(d, 2);
        logMsg('日间轰炸：对 ' + d.def.n + ' 造成 2 点伤害。');
      }
      foe.kreditSlots = Math.max(0, foe.kreditSlots - 1); foe.slotsLost = (foe.slotsLost||0) + 1;
      logMsg('日间轰炸：敌方失去 1 个指挥点槽。');
      break; }
    case 'longRange': {
      // 远距离交战：对 1 个敌方目标造成 2 点伤害
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner === side){ toast('请选择敌方单位'); return false; }
      doDamage(d, 2);
      logMsg('远距离交战：对 ' + d.def.n + ' 造成 2 点伤害。');
      break; }
    case 'sneakAttack': {
      // 偷袭：压制 1 个敌方单位；若其已被压制，将其消灭
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner === side){ toast('请选择敌方单位'); return false; }
      if(d.suppressed){ const p = findPosOf(d); if(p) killUnit(p.r, p.c); logMsg('偷袭：' + d.def.n + ' 已被压制，将其消灭！'); }
      else { applySuppress(d); logMsg('偷袭：' + d.def.n + ' 被压制。'); }
      break; }
    case 'islandDef': {
      // 岛屿防御：若友方总部防御力不大于 10，抽 1 张牌；使友方总部获得 +6 防御力
      if(me.maxHp <= 10){ drawCards(me, 1); logMsg('岛屿防御：总部防御力不大于 10，抽 1 张牌。'); }
      me.maxHp += 6; me.hp += 6;
      logMsg('岛屿防御：友方总部 +6 防御力。');
      break; }
    case 'hakkoIchiu': {
      // 八纮一宇：抽 2 张牌；本局每失去过 1 个指挥点槽，获得 2 个指挥点
      drawCards(me, 2);
      const lost = me.slotsLost || 0;
      if(lost) me.kredit += lost * 2;
      logMsg('八纮一宇：抽 2 张牌，本局失去过 ' + lost + ' 个指挥点槽，获得 ' + (lost*2) + ' 个指挥点。');
      break; }
    case 'warNavy': {
      // 战争海军：对敌方总部造成等同于其手牌数的伤害，敌方随机弃 1 张牌
      const wn = foe.hand.length;
      let dealt = 0;
      if(wn > 0){ dealt = x(wn); applyHqDamage(foe, dealt); checkGameOver(); }
      if(foe.hand.length){
        const ix = Math.floor(Math.random()*foe.hand.length);
        const disc = foe.hand.splice(ix,1)[0];
        logMsg('战争海军：敌方总部受到 '+dealt+' 点伤害（=其手牌数 '+wn+'），敌方随机弃掉「'+disc.n+'」。');
        if(foe === S.a && disc) HOOKS.onFoeDiscard(disc, '弃牌');   // 用户 2026-09-13：敌方弃牌要看得见是哪张
      } else logMsg('战争海军：敌方手牌为空，无事发生。');
      checkGameOver();
      break; }
    case 'wolfPack': {
      // 狼群战术：将 1 个单位返回其手牌（可指己方或敌方单位）；敌方随机弃 1 张牌
      // 目标手牌已满（9 张）时返回失败，该单位被摧毁（爆掉）——无论己方/敌方
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d){ toast('请选择单位'); return false; }
      const own = playerOf(d.owner);
      if(own.hand.length >= MAX_HAND){
        killUnit(tgt.row, tgt.col);
        logMsg('狼群战术：'+d.def.n+' 手牌已满，无法返回，被摧毁！');
        HOOKS.onCardBurst(d.def, d.owner); // 满手爆牌：目标单位被摧毁（UI 播放爆牌动画）
      } else {
        S.board[tgt.row][tgt.col] = null;
        handPushRevealed(own, JSON.parse(JSON.stringify(d.def)));
        own.hand[own.hand.length-1].revealed = true; // 明牌：返回手牌可见
        logMsg('狼群战术：'+d.def.n+' 返回其手牌。');
      }
      if(foe.hand.length){
        const ix = Math.floor(Math.random()*foe.hand.length);
        const disc = foe.hand.splice(ix,1)[0];
        logMsg('狼群战术：敌方随机弃掉「'+disc.n+'」。');
        if(foe === S.a && disc) HOOKS.onFoeDiscard(disc, '弃牌');   // 用户 2026-09-13：敌方弃牌要看得见是哪张
      }
      break; }
    case 'stratBomb': {
      // 战略轰炸：对敌方支援战线所有目标造成 3 点伤害（同时打击敌方总部），敌方失去 1 个指挥点槽
      const br = backRowOf(foeSide); const us = [];
      for(let c=0;c<COLS;c++){ const x=S.board[br][c]; if(x && x.owner===foeSide) us.push(x); }
      const dmg = x(3);
      const n = massDamage(us, dmg);
      applyHqDamage(foe, dmg); // 同时打总部（走总入口：M6/593 等减免生效）
      foe.kreditSlots = Math.max(0, foe.kreditSlots - 1); foe.slotsLost = (foe.slotsLost||0) + 1;
      logMsg('战略轰炸：敌方支援阵线 '+(n||'无')+' 个单位与总部受到 '+dmg+' 点伤害，失去 1 个指挥点槽。');
      checkGameOver();
      break; }
    case 'commonwealth': {
      // 英联邦（可指向任意一方总部，与空中闪击/俾斯麦同规则）：先指向一个总部；
      // 若友方总部防御力（最大生命）不小于 30，对该总部造成 20 点伤害；条件不足时仅抽 4 张牌。
      // 无目标（AI/自动）默认打敌方总部
      const victim = (tgt && tgt.hq) ? (tgt.hqSide === 'p' ? S.p : S.a) : foe;
      const selfHit = victim === S.p;
      if(me.maxHp >= 30){
        applyHqDamage(victim, 20); checkGameOver();
        logMsg('英联邦：对' + (selfHit ? '己方' : '敌方') + '总部造成 20 点伤害！');
      } else logMsg('英联邦：友方总部防御力不足 30，无法打击总部，仅抽 4 张牌。');
      drawCards(me, 4);
      logMsg('英联邦：抽 4 张牌。');
      checkGameOver();
      break; }
    case 'precisionBomb': {
      // 精准轰炸：消灭 1 个敌方单位（其花费已按友方轰炸机最高攻击力动态降低）
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner !== foeSide){ toast('请选择敌方单位'); return false; }
      killUnit(tgt.row, tgt.col);
      logMsg('精准轰炸：消灭 '+d.def.n+'。');
      break; }
    case 'eject': {
      // 驱逐：将 1 个敌方单位返回其卡组顶；抽己方卡组顶 1 张，若为空军则加入己方底线
      //（行动花费照常，不再免油），友方回合结束时返回并洗入卡组
      const d = tgt ? unitAt(tgt.row,tgt.col) : null;
      if(!d || d.owner !== foeSide){ toast('请选择敌方单位'); return false; }
      S.board[tgt.row][tgt.col] = null;
      playerOf(d.owner).deck.push(JSON.parse(JSON.stringify(d.def)));
      logMsg('驱逐：'+d.def.n+' 返回其所有者卡组顶。');
      if(me.deck.length){
        const top = me.deck.pop();
        const giveHand = (why) => {
          if(me.hand.length < MAX_HAND){ me.hand.push(top); logMsg('驱逐：'+why+'「'+top.n+'」加入手牌。'); }   // 「抽卡组顶」= 抽牌口径，不明牌
          else { me.deck.push(top); logMsg('驱逐：手牌已满，「'+top.n+'」放回牌库顶。'); }
        };
        if(top && top.kind==='unit' && (top.t==='fighter' || top.t==='bomber')){
          const slot = emptyBacklineSlot(side);
          if(slot){
            const dd = JSON.parse(JSON.stringify(top)); // 行动花费照常（不设为 0）
            if(spawnUnit(side, dd, slot.row, slot.col, true)){
              const u2 = unitAt(slot.row, slot.col);
              if(u2) u2.ejectOut = true;
              logMsg('驱逐：抽取空军「'+top.n+'」加入战场（友方回合结束返回卡组）。');
              break;
            }
          }
          giveHand('战场无空位，空军');
        } else giveHand('抽到');
      } else logMsg('驱逐：己方卡组为空。');
      break; }
    case 'totalWar': {
      // 全域战争：此后友方空军部署时，获得 +1 攻击力和闪击
      me.totalWar = true;
      logMsg('全域战争：友方空军部署时获得 +1 攻击力与闪击。');
      break; }
    case 'plan': {
      // 计划（中立特殊指令）：抽 1 张牌；场上每有 1 个友方「通用载具」，1 张「爆破」加入手牌
      drawCards(me, 1);
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const x = S.board[r][c];
        if(x && x.owner === side && x.def.id === 'ucarrier'){
          if(me.hand.length < MAX_HAND){ handPushRevealed(me, makeBaopo()); n++; }
        }
      }
      logMsg('计划：抽 1 张牌' + (n ? '；通用载具 触发：' + n + ' 张「爆破」加入手牌。' : '。'));
      break; }
    case 'homelandDef': {
      // 本土决战（花费条件见 playCost）：将「三式中战车」和「D3A2九九舰爆」加入己方支援战线
      const chi = NATIONS.jp.units.find(u => u.id === 'chihat');
      const d3 = NATIONS.jp.units.find(u => u.id === 'd3a');
      let n = 0;
      const put = raw => {
        if(!raw) return;
        const slot = emptyBacklineSlot(side);
        if(!slot) return;
        if(spawnUnit(side, mkUnitDef(raw, 'jp'), slot.row, slot.col, true)) n++;
      };
      put(chi); put(d3);
      logMsg('本土决战：' + (n ? '「三式中战车」与「D3A2九九舰爆」加入支援战线。' : '支援战线已满，无法加入。'));
      break; }
    case 'lastPush': {
      // 最后一搏：消灭所有单位；双方失去 6 个指挥点槽；双方卡组中的单位 +3 攻击力
      const all = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x) all.push({u:x, r, c}); }
      let n = 0;
      for(const t of all){ if(unitAt(t.r, t.c) === t.u){ killUnit(t.r, t.c); n++; } }
      me.kreditSlots = Math.max(0, me.kreditSlots - 6); me.slotsLost = (me.slotsLost||0) + 6;
      foe.kreditSlots = Math.max(0, foe.kreditSlots - 6); foe.slotsLost = (foe.slotsLost||0) + 6;
      let dn = 0;
      for(const deck of [me.deck, foe.deck]) for(const cd of deck){ if(cd && cd.kind === 'unit'){ cd.atk = (cd.atk||0) + 3; dn++; } }
      logMsg('最后一搏：消灭 ' + (n||'无') + ' 个单位，双方失去 6 个指挥点槽，双方卡组中 ' + dn + ' 个单位 +3 攻击力。');
      break; }
    case 'wipeAll': {
      // 至死方休：消灭所有单位
      const all = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x) all.push({u:x, r, c}); }
      let n = 0;
      for(const t of all){ if(unitAt(t.r, t.c) === t.u){ killUnit(t.r, t.c); n++; } }
      logMsg('至死方休：消灭所有单位（' + (n||'无') + '）。');
      break; }
    case 'paraDrop': {
      // 伞降突袭：将数个「第506空降步兵团」加入己方支援战线直到已满；每个获得闪击和冲击
      const raw = NATIONS.us.units.find(u => u.id === 'r506');
      const br = backRowOf(side);
      let n = 0;
      if(raw) for(let c = 0; c < COLS; c++){
        if(S.board[br][c]) continue;
        const d = mkUnitDef(raw, 'us');
        if(!(d.sig || []).includes('blitz')) d.sig.push('blitz');
        if(!(d.sig || []).includes('impact')) d.sig.push('impact');
        if(spawnUnit(side, d, br, c, true)) n++;
      }
      logMsg('伞降突袭：' + (n||'无') + ' 个「第506空降步兵团」加入支援战线（闪击+冲击）。');
      break; }
    case 'armorWedge': {
      // 装甲楔形阵：使 1 个友方坦克 +1/+1，其相邻单位（任意归属）也 +1/+1
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || d.owner !== side || !isTankUnit(d)){ toast('请选择友方坦克'); return false; }
      d.atk += 1; d.hp += 1; d.maxHp += 1;
      let n = 0;
      const nbs = [[tgt.row-1,tgt.col],[tgt.row+1,tgt.col],[tgt.row,tgt.col-1],[tgt.row,tgt.col+1]];
      for(const [r, c] of nbs){
        if(r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
        const x = S.board[r][c];
        if(!x) continue;
        x.atk += 1; x.hp += 1; x.maxHp += 1; n++;
      }
      logMsg('装甲楔形阵：' + d.def.n + ' +1/+1，相邻 ' + (n||'无') + ' 个单位 +1/+1。');
      break; }
    case 'suppressOne': {
      // 逢敌：压制 1 个单位（任意归属），抽 1 张牌
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择单位'); return false; }
      if(applySuppress(d)) logMsg('逢敌：压制 ' + d.def.n + '。');
      else logMsg('逢敌：目标免疫压制。');
      drawCards(me, 1);
      logMsg('逢敌：抽 1 张牌。');
      break; }
    case 'climax': {
      // 高潮迭起：对所有敌方单位造成 2 点伤害；若是本回合使用的第 2 张指令，改为 4 点
      const second = me.ordersThisTurn === 2;
      const dmg = x(second ? 4 : 2);
      const us = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x && x.owner === foeSide) us.push(x); }
      const n = massDamage(us, dmg);
      logMsg('高潮迭起：敌方 ' + (n||'无') + ' 个单位受到 ' + dmg + ' 点伤害' + (second ? '（第 2 张指令，威力提升）' : '') + '。');
      break; }
    case 'landGirl': {
      // 土地女孩：协力，抽 2 张牌
      coopCheck(side, card);
      drawCards(me, 2);
      logMsg('土地女孩：抽 2 张牌。');
      break; }
    case 'convoy': {
      // 护送航运：将 1 张「生产」和 1 张「计划」加入手牌（正在打出的本卡不计入占用）
      let room = handFree(me, card);
      if(room > 0){ handPushRevealed(me, makeProduceDef()); room--; logMsg('护送航运：1 张「生产」加入手牌。'); }
      else logMsg('护送航运：手牌已满，「生产」无法加入。');
      if(room > 0){ handPushRevealed(me, makePlan()); logMsg('护送航运：1 张「计划」加入手牌。'); }
      else logMsg('护送航运：手牌已满，「计划」无法加入。');
      break; }
    case 'shortage': {
      // 物资短缺：使所有敌方单位获得「本单位所有者回合开始时，对本单位造成 1 点伤害」（常驻）
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const x = S.board[r][c];
        if(x && x.owner === foeSide && !hasFx(x, 'selfBurnTurn')){ (x.def.fx = x.def.fx || []).push('selfBurnTurn'); n++; }
      }
      logMsg('物资短缺：' + (n||'无') + ' 个敌方单位染上侵蚀（每回合开始自伤 1 点，常驻）。');
      break; }
    case 'homeGuard': {
      // 国土警卫队：协力，对 1 个单位（任意归属）造成 2 点伤害；将 1 张「卫戍」加入手牌
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择单位'); return false; }
      damageUnit(d, 2);
      logMsg('国土警卫队：对 ' + d.def.n + ' 造成 2 点伤害。');
      const g = makeDerived('garrison');
      if(g){ if(handFree(me, card) > 0){ handPushRevealed(me, g); logMsg('国土警卫队：1 张「卫戍」加入手牌。'); }
        else logMsg('国土警卫队：手牌已满，「卫戍」无法加入。'); }
      coopCheck(side, card);
      break; }
    case 'dustStorm': {
      // 沙尘满目：压制 1 个单位（任意归属）；将 2 张「卫戍」加入己方支援战线
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择单位'); return false; }
      if(applySuppress(d)) logMsg('沙尘满目：压制 ' + d.def.n + '。');
      else logMsg('沙尘满目：目标免疫压制。');
      let n = 0;
      const br = backRowOf(side);
      for(let c = 0; c < COLS && n < 2; c++){
        if(S.board[br][c]) continue;
        const g = makeDerived('garrison');
        if(g && spawnUnit(side, g, br, c, true)) n++;
      }
      logMsg('沙尘满目：' + (n||'无') + ' 张「卫戍」加入支援战线。');
      break; }
    case 'monsoon': {
      // 季风侵袭：使所有敌方单位的防御力为 1
      let n = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const x = S.board[r][c];
        if(x && x.owner === foeSide && (x.maxHp !== 1 || x.hp !== 1)){ x.maxHp = 1; x.hp = 1; n++; }
      }
      logMsg('季风侵袭：' + (n||'无') + ' 个敌方单位防御力变为 1。');
      break; }
        case '德意志帝国研发': {
      // 德 德意志帝国研发：抉择：将1张“V-1飞行炸弹”或1张“扩展德意志帝国研发”加入手牌。
      // 抉择卡：本卡留在手牌，点选选项后才算使用（消耗在 resolveChoice 内既有逻辑完成）
      openResearchChoice(card, side, ['V-1飞行炸弹', '扩展德意志帝国研发']);
      break; }
    case '扩展德意志帝国研发': {
      // 德 扩展德意志帝国研发：抉择：将1张“合成机油”或1张“高级德意志帝国研发”加入手牌。
      openResearchChoice(card, side, ['合成机油', '高级德意志帝国研发']);
      break; }
    case '高级德意志帝国研发': {
      // 德 高级德意志帝国研发：抉择：将1张“XXⅪ级U型潜艇”或1张“铀工程”加入手牌。
      // 文档原文此处写作“XXⅪI级U型潜艇”（多一个 I，疑似文档笔误）：必须用 DERIVED_CARDS 的键
      // “XXⅪ级U型潜艇”，否则 makeDerived 取不到卡
      openResearchChoice(card, side, ['XXⅪ级U型潜艇', '铀工程']);
      break; }
    case '帝国研发': {
      // 日 帝国研发：抉择：将1张“气球炸弹”或1张“扩展帝国研发”加入手中。
      openResearchChoice(card, side, ['气球炸弹', '扩展帝国研发']);
      break; }
    case 'V-1飞行炸弹': {
      // 德 V-1飞行炸弹：消灭1个花费不大于3的单位（任意归属；花费取卡面部署花费 def.blood）
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || (d.def.blood || 0) > 3){ toast('请选择花费不大于 3 的单位'); return false; }
      logMsg('V-1飞行炸弹：消灭 ' + d.def.n + '。');
      killUnit(tgt.row, tgt.col);
      break; }
    case '合成机油': {
      // 德 合成机油：下个回合开始时，获得10个指挥点并抽1张牌（延迟结算，见辅助函数 resolveOilPending）
      me.oilPending = (me.oilPending || 0) + 1;
      logMsg('合成机油：下个回合开始时获得 10 个指挥点并抽 1 张牌。');
      break; }
    case 'XXⅪ级U型潜艇': {
      // 德 XXⅪ级U型潜艇：消灭1个单位（任意归属），敌方随机弃2张牌
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      const foePl = playerOf(foeSide);
      logMsg('XXⅪ级U型潜艇：消灭 ' + d.def.n + '。');
      killUnit(tgt.row, tgt.col);
      let dn = 0;
      for(let i=0;i<2;i++){ if(randomDiscard(foePl, null)) dn++; }
      logMsg('XXⅪ级U型潜艇：' + playerNameOf(foePl) + '随机弃掉 ' + (dn || '无') + ' 张牌。');
      break; }
    case '铀工程': {
      // 德 铀工程：消灭所有敌方单位；每消灭1个单位获得1个指挥点（先快照再结算，与「至死方休」同款）
      const us = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const y = S.board[r][c]; if(y && y.owner === foeSide) us.push({u:y, r:r, c:c}); }
      let n = 0;
      for(const t of us){ if(unitAt(t.r, t.c) === t.u){ killUnit(t.r, t.c); n++; } }
      me.kredit += n;
      logMsg('铀工程：消灭 ' + (n || '无') + ' 个敌方单位，获得 ' + n + ' 个指挥点（当前 ' + me.kredit + '）。');
      break; }
    case '神风特攻队': {
      // 日 神风特攻队：对敌方总部造成1点伤害（吃「天皇诏令」+1，与既有直伤指令一致），抽1张牌
      const dmg = x(1);
      applyHqDamage(foe, dmg); checkGameOver();
      logMsg('神风特攻队：对敌方总部造成 ' + dmg + ' 点伤害，抽 1 张牌。');
      drawCards(me, 1);
      break; }
    case '氧气鱼雷': {
      // 日 氧气鱼雷：消灭1个单位（任意归属）；若其攻击力不大于3，抽2张牌（先记攻击力再消灭）
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      const weak = d.atk <= 3;
      logMsg('氧气鱼雷：消灭 ' + d.def.n + '。');
      killUnit(tgt.row, tgt.col);
      if(weak){ drawCards(me, 2); logMsg('氧气鱼雷：目标攻击力不大于 3，抽 2 张牌。'); }
      break; }
          case '高级帝国研发': {
      // 抉择：本卡留在手牌，点选选项后才算使用（消耗在 resolveChoice 既有逻辑完成）
      openResearchChoice(card, side, ['7075铝', '皇国二号兵器']);
      break; }
    case '扩展帝国研发': {
      openResearchChoice(card, side, ['氧气鱼雷', '高级帝国研发']);
      break; }
    case '美国军事研发': {
      // 本卡不是衍生卡（在 us.orders 里，3 费金卡），但抉择结算与研发链完全相同
      openResearchChoice(card, side, ['深水炸弹', '扩展美国研发']);
      break; }
    case '扩展美国研发': {
      openResearchChoice(card, side, ['加压舱', '高级美国研发']);
      break; }
    case '气球炸弹': {
      // 全场压制：免疫压制的单位（虎式坦克H型 immuneSuppress）被 applySuppress 跳过并记日志（与「蒙哥马利」同口径）
      let n = 0;
      for(const t of enemyList(side)){ if(applySuppress(t.u)) n++; }
      logMsg('气球炸弹：压制 ' + (n || '无') + ' 个敌方单位。');
      break; }
    case '皇国二号兵器': {
      // 卡组顶 = deck 末尾（drawCards 从末尾抽，同戈登高人团/三号坦克H型口径）；
      // 花费(blood)+行动花费(fuel) 就地置 0，抽到手即是 0 费 0 油的「试制橘花」
      const n = r2TopDeckFreeCopies(me, 'jp', '试制橘花', 4);
      logMsg(n ? ('皇国二号兵器：' + n + ' 张「试制橘花」置于卡组顶（花费 0、行动花费 0）。')
               : '皇国二号兵器：未找到「试制橘花」，效果不触发。');
      break; }
    case '7075铝': {
      // 3 张 A6M2零战 进手牌：花费 0 + 挂亡计标记 a6m2Clone（亡计结算见 file 头 ③(1) 的 killUnit patch）
      const n = r2AddFreeCloneToHand(me, card, 'jp', 'A6M2零战', 3);
      logMsg(n ? ('7075铝：' + n + ' 张「A6M2零战」加入手中（花费 0，并获得亡计：复制回手）。')
               : '7075铝：手牌已满或未找到「A6M2零战」，效果不触发。');
      break; }
    case '加压舱': {
      // 数据侧卡名是「超级堡垒B-29」（文档文案写作“B-29超级堡垒”，同一张卡）；先加手牌再随机消灭
      const got = r2AddUnitToHand(me, card, 'us', '超级堡垒B-29', 1);
      const t = rand(enemyList(side));
      let msg = '加压舱：' + (got ? ('将 1 张「' + got.n + '」加入手牌') : '手牌已满，「超级堡垒B-29」无法加入');
      if(t){ logMsg(msg + '，并随机消灭 ' + t.u.def.n + '。'); killUnit(t.r, t.c); }
      else logMsg(msg + '；场上没有敌方单位。');
      break; }
    case '深水炸弹': {
      // 指挥点槽 +1（同战争机器口径，上限 24）；总部烟幕 = 敌方单位无法攻击友方总部，
      // 由 attackTargets 的 ③(2)(3) 两处 patch 生效，③(4)(5) 在下个友方回合开始清除
      me.kreditSlots = Math.min(24, me.kreditSlots + 1);
      me.hqSmoke = true;
      logMsg('深水炸弹：指挥点槽 +1（当前 ' + me.kreditSlots + '）；友方总部获得烟幕，直到下个友方回合开始。');
      break; }
    case '青霉素': {
      // 单位「防御力」= 血量上限（口径同「红茶」maxHp/hp 双加）；总部同样 +6，再抽 4 张（空卡组自动转士气伤害）
      const allies = allyList(side);
      for(const t of allies){ t.u.maxHp += 6; t.u.hp += 6; }
      me.maxHp += 6; me.hp += 6;
      logMsg('青霉素：' + (allies.length || '无') + ' 个友方单位与友方总部 +6 防御力。');
      drawCards(me, 4);
      break; }
    case '苏联军事研发': {
      // 抉择卡：本卡留在手牌，点选选项后才算使用（消耗在 resolveChoice 内既有逻辑完成，同 R1）
      openResearchChoiceN(card, side, [{ id:'气动雪橇', n:1 }, { id:'扩展苏联研发', n:1 }]);
      break; }

    case '扩展苏联研发': {
      openResearchChoiceN(card, side, [{ id:'标准弹药', n:1 }, { id:'高级苏联研发', n:1 }]);
      break; }

    case '高级苏联研发': {
      // 与 R1 抉择同机制，多一个「张数」参数（3 张斯大林管风琴）
      openResearchChoiceN(card, side, [{ id:'倾斜装甲', n:1 }, { id:'斯大林管风琴', n:3 }]);
      break; }

    case '高级美国研发': {
      // 「青霉素」是美系衍生卡（R2/R4 批次的实现），此处只做发放：makeDerived 取不到时按空处理
      openResearchChoiceN(card, side, [{ id:'青霉素', n:1 }, { id:'曼哈顿计划', n:2 }]);
      break; }

    case '曼哈顿计划': {
      // 「对所有敌方目标」= 敌方所有单位 + 敌方总部（与「虎！虎！虎！ tora」同口径）。
      // 群体伤害用 massDamage（先快照再结算，含受伤抽牌/死亡清理），总部伤害走 applyHqDamage 统一出口
      const us = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const b = S.board[r][c]; if(b && b.owner === foeSide) us.push(b); }
      const dmg = x(6);
      const n = massDamage(us, dmg);
      applyHqDamage(foe, dmg);
      logMsg('曼哈顿计划：敌方 ' + (n || '无') + ' 个单位与总部受到 ' + dmg + ' 点伤害。');
      break; }

    case '斯大林管风琴': {
      // 逐点随机落点：写法照抄「超级堡垒B-29」的随机池（目标 = 当前存活的敌方单位 + 敌方总部，
      // 场上无单位时 8 点全打总部；每点前剔除已阵亡单位，剩余点数继续分配）
      const pool = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const b = S.board[r][c]; if(b && b.owner !== side) pool.push(b); }
      const foeP = playerOf(foeSide);
      pool.push(foeP);
      let dealt = 0;
      for(let i=0;i<8 && pool.length;i++){
        for(let j=pool.length-1;j>=0;j--){ const pj = pool[j]; if(pj !== foeP && (!pj.def || pj.hp <= 0)) pool.splice(j, 1); }
        if(!pool.length) break;
        const t = pool[Math.floor(Math.random()*pool.length)];
        dealt++;
        if(t === foeP){ applyHqDamage(foeP, 1); }      // 逐点结算：每点都过总入口（M6/593 各减 1，下限 0）
        else { damageUnit(t, 1); }
      }
      logMsg('斯大林管风琴：8 点伤害随机分配至敌方目标（实际分配 ' + dealt + ' 点）。');
      checkGameOver();
      break; }

    case '标准弹药': {
      // 直接改手中/卡组里「单位卡」def 的 blood/fuel（最低 0）：部署时 makeUnit 与卡面共享同一 def，
      // 因此减过的行动花费对之后部署的单位同样生效；已在场单位不受影响（卡面只写「手中和卡组中」）
      let n = 0;
      for(const zone of [me.hand, me.deck]){
        for(const c of zone){
          if(!c || c.kind !== 'unit') continue;
          const b0 = c.blood || 0, f0 = c.fuel || 0;
          c.blood = Math.max(0, b0 - 1);
          c.fuel  = Math.max(0, f0 - 1);
          if(c.blood !== b0 || c.fuel !== f0) n++;
        }
      }
      logMsg('标准弹药：手中与卡组中 ' + n + ' 张友方单位 -1 花费、-1 行动花费（已为 0 的不再降）。');
      break; }

    case '气动雪橇': {
      // 主目标 = 敌方陆军单位 或 敌方总部；相邻 = 上下左右四格、只算敌方单位（口径沿用「枪林弹雨」）。
      // 未点选时（AI / cards.js 暂无 target）自动取第 1 个敌方陆军，其次敌方总部 → AI 侧不会卡住
      let t = null;
      if(tgt && tgt.hq){ t = { hq:true }; }
      else if(tgt){
        const d = unitAt(tgt.row, tgt.col);
        if(!d || d.owner !== foeSide || !isArmyType(d.def.t)){ toast('请选择敌方陆军或敌方总部'); return false; }
        t = { u:d, row:tgt.row, col:tgt.col };
      }
      if(!t){
        for(let r=0;r<ROWS && !t;r++) for(let c=0;c<COLS && !t;c++){
          const y = S.board[r][c];
          if(y && y.owner === foeSide && isArmyType(y.def.t)) t = { u:y, row:r, col:c };
        }
      }
      const dmg = x(2);                       // 天皇诏令 +1：整张卡只取一次加成（同「枪林弹雨」）
      if(!t){
        applyHqDamage(foe, dmg);              // 无敌方陆军：改打敌方总部
        logMsg('气动雪橇：敌方没有陆军，对敌方总部造成 ' + dmg + ' 点伤害。');
        break;
      }
      if(t.hq){
        // 口径（用户 2026-09-13）：指向敌方总部时，和「轰炸突袭」一样，随机打敌方底线 2 个单位各 dmg 点伤害。
        // 随机池写法逐字参照 case 'bombRaid'（底线逐列收单位 → Fisher-Yates 洗牌 → 取前 2）。
        // 底线没有单位时不打（只写日志），不再对总部造成伤害。
        const br = backRowOf(foeSide);
        const list = [];
        for(let c=0;c<COLS;c++){ const y=S.board[br][c]; if(y && y.owner===foeSide) list.push([br,c]); }
        for(let i=list.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [list[i],list[j]]=[list[j],list[i]]; }
        const chosen = list.slice(0,2);
        const hit = [];
        for(const [r,c] of chosen){ const y=S.board[r][c]; if(y){ doDamage(y, dmg); hit.push(y.def.n); } }
        logMsg(hit.length
          ? '气动雪橇：指向敌方总部，改为对敌方底线 ' + hit.length + ' 个单位各造成 ' + dmg + ' 点伤害（' + hit.join('、') + '）。'
          : '气动雪橇：指向敌方总部，但敌方底线没有单位，效果不触发。');
        break;
      }
      const main = t.u.def.n;
      doDamage(t.u, dmg);
      let m = 0;
      for(const [r, c] of [[t.row-1,t.col],[t.row+1,t.col],[t.row,t.col-1],[t.row,t.col+1]]){
        if(r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
        const y = S.board[r][c];
        if(y && y.owner === foeSide){ doDamage(y, dmg); m++; }
      }
      logMsg('气动雪橇：' + main + ' 受到 ' + dmg + ' 点伤害，相邻 ' + (m || '无') + ' 个敌方目标受到 ' + dmg + ' 点伤害。');
      break; }

    case '倾斜装甲': {
      // 三段的写法来源：①「将 1 个 X 加入支援阵线」= emptyBacklineSlot + mkUnitDef + spawnUnit
      //（同「遥远的桥」取 NATIONS 原始卡数据）；②「战斗」= 纯数值交换（口径沿用 Hs 129 hs129Fight）；
      // ③「回合结束时返回手中」= 给召唤物挂 def.fx 标记，由 resolveObliqueArmorReturn 在
      // triggerFriendlyTurnEnd 里结算（写法同 Me 163 彗星 me163Back 循环）
      const slot = emptyBacklineSlot(side);
      if(!slot){ logMsg('倾斜装甲：支援阵线已满，「IS-2」无法加入。'); break; }
      const raw = NATIONS.su.units.find(y => y.id === 'IS-2');
      if(!raw){ logMsg('倾斜装甲：卡数据里找不到「IS-2」。'); break; }
      const is2def = mkUnitDef(raw, 'su');                              // 每次新对象，不污染 NATIONS 原始数据
      is2def.fx = (is2def.fx || []).concat(['obliqueBack']);            // 回合结束返回标记
      spawnUnit(side, is2def, slot.row, slot.col);
      const is2 = unitAt(slot.row, slot.col);
      if(!is2){ logMsg('倾斜装甲：「IS-2」无法加入支援阵线。'); break; }
      logMsg('倾斜装甲：1 个「IS-2」加入支援阵线。');
      // 与 1 个敌方单位战斗（点选优先，未点选则随机 1 个敌方单位）
      let t = null;
      if(tgt && !tgt.hq){ const d = unitAt(tgt.row, tgt.col); if(d && d.owner === foeSide) t = { u:d, r:tgt.row, c:tgt.col }; }
      if(!t){ const list = enemyList(side); if(list.length) t = list[Math.floor(Math.random()*list.length)]; }
      if(t){
        const foeName = t.u.def.n;
        const dd = atkOf(is2), rd = atkOf(t.u);
        if(dd > 0){ damageUnit(t.u, dd); logMsg('倾斜装甲：「IS-2」与 ' + foeName + ' 战斗，造成 ' + dd + ' 点伤害。'); }
        if(rd > 0){ damageUnit(is2, rd); logMsg('倾斜装甲：' + foeName + ' 反击，「IS-2」受到 ' + rd + ' 点伤害。'); }
        if(t.u.hp <= 0){ const p2 = findPosOf(t.u); if(p2) killUnit(p2.r, p2.c); }
        if(is2.hp <= 0){ const p3 = findPosOf(is2); if(p3) killUnit(p3.r, p3.c); }
        checkGameOver();
      } else logMsg('倾斜装甲：没有敌方单位可战斗。');
      break; }

    case '妇女预备队': {
      // 「卡组顶」= 卡组末尾（drawCards 用 deck.pop() 抽牌）；两个选项都作用于「卡组顶的那张单位」，
      // 卡组里没有单位卡时不出牌（返回 false → 玩家侧不消耗、留手；UI 可点其他处取消）
      const pick = topUnitInDeck(me);
      if(!pick){ toast('卡组中没有单位'); return false; }
      S.pendingChoice = { eff:'womenReserve', side:side, card:card, pick:pick, options:[
        { id:'c1', n:'抉择 1 · 征召入伍', img:(pick.img || ''), desc:'抽取卡组顶的单位「' + pick.n + '」' },
        { id:'c2', n:'抉择 2 · 授以战技', img:(pick.img || ''), desc:'使卡组顶的「' + pick.n + '」获得伏击与冲击' }
      ] };
      HOOKS.onChoice(S.pendingChoice.options);
      logMsg('妇女预备队：抉择吧——抽取卡组顶的「' + pick.n + '」，或使其获得伏击与冲击。');
      break; }

          case '皇家研发': {
      // 抉择卡：本卡留在手牌，点选选项后才算使用（消耗在 resolveChoice 既有逻辑完成）
      openResearchChoice(card, side, ['雷达', '扩展皇家研发']);
      break; }
    case '扩展皇家研发': {
      openResearchChoice(card, side, ['合成橡胶', '高级皇家研发']);
      break; }
    case '高级皇家研发': {
      // 文档写作“主动声纳”（纳），DERIVED_CARDS 的键/效果 id 是「主动声呐」（呐）：
      // 必须用数据侧 id，否则 makeDerived 取不到卡（同 R1「XXⅪ级U型潜艇」的坑）
      openResearchChoice(card, side, ['主动声呐', '布莱切利庄园']);
      break; }
    case '合成橡胶': {
      // +4 防御力 = maxHp/hp 双加（口径同既有「青霉素/红茶」的 x.maxHp += n; x.hp += n）；
      // 「攻击力等同于其防御力」按**当前**防御力（当前血量）取，口径同既有「海军支援」；
      // 目标任意归属（cards.js 已带 target:'any'）
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      d.maxHp += 4; d.hp += 4;
      const was = d.atk;
      d.atk = d.hp;
      logMsg('合成橡胶：' + d.def.n + ' +4 防御力，攻击力 ' + was + '→' + d.atk + '（等同于其防御力）。');
      break; }
    case '雷达': {
      // 总部「+4 防御力」= maxHp/hp 双加（口径同「青霉素」的 me.maxHp += 6; me.hp += 6）；
      // 抽牌走既有 drawCards（空卡组自动转士气伤害）
      drawCards(me, 1);
      me.maxHp += 4; me.hp += 4;
      logMsg('雷达：抽 1 张牌；友方总部 +4 防御力（当前 ' + me.hp + '/' + me.maxHp + '）。');
      break; }
    case '主动声呐': {
      // 全场压制：免疫压制的单位（如虎式坦克H型 immuneSuppress）由 applySuppress 跳过并记日志
      // （口径同既有「气球炸弹/蒙哥马利」：逐个 applySuppress 计数）；
      // 「手牌 +3 花费」把标记打在每张牌上（r4HandCostPlus），付账时由 playCost 末尾读（见 file 头 ③(1)）
      let n = 0;
      for(const t of enemyList(side)){ if(applySuppress(t.u)) n++; }
      const foePl = playerOf(foeSide);
      const m = r4HandCostPlus(foePl, 3);
      logMsg('主动声呐：压制 ' + (n || '无') + ' 个敌方单位；' + playerNameOf(foePl) + '手牌 ' + (m || '无') + ' 张 +3 花费。');
      break; }
    case '布莱切利庄园': {
      // 手牌部分走既有出口 handCardToDeckTop（卡组顶 = deck 末尾，pop 抽出；返回卡组不是弃牌，不做 noDiscard 豁免）；
      // 场上部分走 r4ReturnBoardToDeckTop（口径同 女王直属卡梅伦高地人团/驱逐）
      const foePl = playerOf(foeSide);
      const h = r4ReturnHandToDeckTop(foePl, 5);
      const b = r4ReturnBoardToDeckTop(foeSide, 5);
      logMsg('布莱切利庄园：' + playerNameOf(foePl) + '手牌 ' + (h || '无') + ' 张、场上 ' + (b || '无') +
             ' 个单位（花费不大于 5）返回其卡组顶。');
      break; }
      case 'frontObserver': {
      // 前线观察员：对所有敌方单位造成 2 点伤害；若上回合友方部署过英国步兵，抽 1 张牌
      const us = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x && x.owner === foeSide) us.push(x); }
      const n = massDamage(us, x(2));
      let drew = false;
      if(me.gbInfLast){ drawCards(me, 1); drew = true; }
      logMsg('前线观察员：敌方 ' + (n||'无') + ' 个单位受到 2 点伤害' + (drew ? '；上回合部署过英国步兵，抽 1 张牌。' : '。'));
      break; }
    /* ↓↓↓ batch-E2：新增 2 张指令 ↓↓↓ */
    // 美 我们能做到！：所有友方单位和总部获得 +3 防御力，抽 1 张牌。
    case '我们能做到！': {
      // 「+3 防御力」= maxHp 与当前 hp 同步 +3（既有全批写法：妥协 / 岛屿防御 / 柏林之路）
      const list = allyList(side).map(t => t.u);   // 先快照再结算，避免遍历中棋盘被改动
      for(const a of list){ a.maxHp += 3; a.hp += 3; }
      me.maxHp += 3; me.hp += 3;
      logMsg('我们能做到！：友方 ' + (list.length || '无') + ' 个单位与总部获得 +3 防御力。');
      drawCards(me, 1);
      logMsg('我们能做到！：抽 1 张牌。');
      break; }
    // 美 掩护部队：将 2 个「SBD 3 无畏」加入支援阵线，使其获得闪击。
    case '最光辉的时刻': {
      // 英 最光辉的时刻（2费·银）：使1个空军获得+1+1和闪击。
      // 「空军」= 战斗机/轰炸机（与 actFuelCost 的 isAir、全域战争 同口径）。
      // 目标口径（用户 2026-09-13）：**任一阵营**的空军（target 已改判 'any'）；
      // 非法目标（非空军/总部/空格）→ toast + return false，卡不消耗
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d || !(d.def.t === 'fighter' || d.def.t === 'bomber')){ toast('请选择 1 个空军单位'); return false; }
      d.atk += 1; d.maxHp += 1; d.hp += 1;
      if(!hasSig(d,'blitz')) d.def.sig.push('blitz'); // 已有闪击不重复（同火力爆发）
      logMsg('最光辉的时刻：' + d.def.n + ' 获得 +1/+1 与闪击。');
      break; }
    case 'HMS光辉号': {
      // 英 HMS光辉号（3费·金）：将2个「剑鱼MkI」加入支援阵线，使其获得闪击。
      // 生成写法同 掩护部队 addSbdToBackline（底线逐列找空位 → spawnUnit；blitz 由 opts 追加）
      const n = addPoolUnitToBackline(side, 'gb', 'swordfish', 2, { blitz:true });
      if(n) logMsg('HMS光辉号：' + n + ' 个「剑鱼 MKI」加入支援阵线并获得闪击。');
      else logMsg('HMS光辉号：支援阵线已满，「剑鱼 MKI」无法加入。');
      break; }
    case '军情五处': {
      // 英 军情五处（3费·银）：敌方随机将1张手牌放回卡组顶，友方抽1张牌。
      // 「放回卡组顶」走既有出口 handCardToDeckTop（霹雳师/第175步兵团同口径；
      // 不经 discardCard —— 返回卡组不是弃牌，芬兰男孩步兵团的 noDiscard 不拦截）
      if(foe.hand.length){
        const back = foe.hand[Math.floor(Math.random()*foe.hand.length)];
        if(handCardToDeckTop(foe, back)) logMsg('军情五处：' + playerNameOf(foe) + ' 的「' + back.n + '」被放回卡组顶。');
      } else logMsg('军情五处：' + playerNameOf(foe) + ' 没有手牌可放回卡组顶。');
      drawCards(me, 1);
      logMsg('军情五处：你抽 1 张牌。');
      break; }
    case '炮击': {
      // 英 炮击（5费·金）：压制所有敌方单位，对其造成1点伤害。敌方失去1个指挥点槽。
      // 按卡面语序：先全体压制（免疫压制者不生效），再统一结算 1 点伤害（massDamage：先扣血再统一死亡）
      const us = enemyList(side).map(t => t.u);        // 先快照，避免结算中棋盘被改动
      let sup = 0;
      for(const y of us){ if(applySuppress(y)) sup++; }
      const hit = massDamage(us, x(1));                // 天皇诏令 +1：整张卡只消耗一次
      foe.kreditSlots = Math.max(0, foe.kreditSlots - 1); foe.slotsLost = (foe.slotsLost||0) + 1;
      logMsg('炮击：压制敌方 ' + sup + ' 个单位、对 ' + (hit||'无') + ' 个造成 1 点伤害；敌方失去 1 个指挥点槽（现 ' + foe.kreditSlots + ' 个）。');
      break; }
    case '停飞': {
      // 英 停飞（5费·铁）：将1个单位返回其所有者卡组顶。
      // 完全复用既有「返回其所有者卡组顶」写法（驱逐 eject / 卡梅伦高地人团 bounceTop）：
      // 直接离场（不触发亡计）+ def 深拷贝压入该方卡组顶（deck 末尾 = 卡组顶，pop 抽出）
      const d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){ toast('请选择 1 个单位'); return false; }
      S.board[tgt.row][tgt.col] = null;
      playerOf(d.owner).deck.push(JSON.parse(JSON.stringify(d.def)));
      logMsg('停飞：' + d.def.n + ' 返回其所有者卡组顶。');
      break; }
    case '渗透': {
      // 英 渗透（5费·铜）：每个友方突击队随机对1个敌方目标造成等同于敌方明牌数的伤害。
      // · 「突击队」= 卡名含「突击队」的友方单位（第9/第46/第10突击队；id 兜底）
      // · 「明牌数」= 敌方手牌中 revealed 的牌数（情报/被返回手牌/塞牌三类口径，见 intelDeploy）
      // · 「敌方目标」含敌方总部（与终焉之行/B-29 的随机池一致）；总部伤害走 applyHqDamage
      const dm = foe.hand.filter(c => c && c.revealed).length;
      const squad = [];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const y = S.board[r][c];
        if(y && y.owner === side && isCommandoUnit(y)) squad.push(y);
      }
      if(!squad.length){ logMsg('渗透：场上没有友方突击队，效果不触发。'); break; }
      if(dm <= 0){ logMsg('渗透：敌方没有明牌（伤害 0），' + squad.length + ' 个突击队不结算。'); break; }
      let hqHit = 0;
      for(const y of squad){
        // 每个突击队独立随机取目标；重新扫描 → 已阵亡的单位不再入池
        const pool = [];
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const t = S.board[r][c]; if(t && t.owner === foeSide) pool.push(t); }
        pool.push({ hq:true });                        // 场上无单位时全部打总部
        const t = pool[Math.floor(Math.random()*pool.length)];
        if(t.hq){ applyHqDamage(foe, dm); hqHit++; }
        else damageUnit(t, dm);
      }
      logMsg('渗透：' + squad.length + ' 个友方突击队各造成 ' + dm + ' 点伤害（' + hqHit + ' 次命中敌方总部）。');
      break; }
    case '突击队突击': {
      // 英 突击队突击（5费·铜）：造成1点伤害。将2个「第10突击队」加入支援阵线。
      // 目标 = 任意单位（cards.js 已 target:'any'）：优先 tgt，未指定/非法则随机 1 个敌方单位兜底；
      // 生成部分独立结算（场上无单位时伤害不结算，但突击队照常加入，不退还卡牌）
      let d = tgt ? unitAt(tgt.row, tgt.col) : null;
      if(!d){
        const list = enemyList(side);
        d = list.length ? list[Math.floor(Math.random()*list.length)].u : null;
      }
      const tName = d ? d.def.n : null;
      if(d) doDamage(d, x(1));                         // 天皇诏令 +1：只作用于这 1 点伤害
      else logMsg('突击队突击：场上没有单位，1 点伤害未结算。');
      const n = addPoolUnitToBackline(side, 'gb', '第10突击队', 2);
      logMsg('突击队突击：造成 1 点伤害' + (tName ? '（' + tName + '）' : '（无目标）') + '，' + n + ' 个「第10突击队」加入支援阵线。');
      break; }
    case '参谋长联席会议': {
      // 英 参谋长联席会议（6费·铁）：使所有友方英国和美国单位获得+2+3。
      // 「+2+3」= 攻击 +2 / 防御（上限与当前值）+3（同 我们能做到！/妥协 的无斜杠口径）；
      // 国家取 def.nation（gb=英 / us=美），盟国参战的英美单位同样计入
      const list = allyList(side).map(t => t.u);
      let n = 0;
      for(const a of list){
        if(a.def.nation === 'gb' || a.def.nation === 'us'){ a.atk += 2; a.maxHp += 3; a.hp += 3; n++; }
      }
      logMsg('参谋长联席会议：' + (n||'无') + ' 个友方英美单位获得 +2/+3。');
      break; }
    case 'HMS竞技神号': {
      // 英 HMS竞技神号（6费·铜）：将数个「剑鱼MkI」加入支援阵线，直到已满。
      // 「直到已满」= 支援阵线（己方底线 5 格）有几个空位就放几个：直接请求 COLS 个，
      // addPoolUnitToBackline 在没有空位时自然停下（同 bp42 的逐列找位）
      const n = addPoolUnitToBackline(side, 'gb', 'swordfish', COLS);
      logMsg('HMS竞技神号：' + (n||'无') + ' 个「剑鱼 MKI」加入支援阵线（直到支援阵线已满）。');
      break; }
    case '合作关系': {
      // 英 合作关系（6费·银）：随机将1个美国精英单位加入支援阵线。
      // 「精英」= 稀有度「金」（见 DIY制卡指南.md 映射表：金 = 精英，组卡上限 1 张）；
      // 从 us 卡池单位里筛 rarity==='金' → 随机 1 个生成到支援阵线（生成写法同 HMS光辉号）
      const pool = (NATIONS.us && NATIONS.us.units ? NATIONS.us.units : []).filter(raw => rarityOf(raw.id) === '金');
      if(!pool.length){ logMsg('合作关系：卡池里没有美国精英单位，效果不触发。'); break; }
      const raw = pool[Math.floor(Math.random()*pool.length)];
      const n = addPoolUnitToBackline(side, 'us', raw.id, 1);
      logMsg('合作关系：' + (n ? '美国精英单位「' + raw.n + '」加入支援阵线。' : '支援阵线已满，「' + raw.n + '」无法加入。'));
      break; }
          case '掩护部队': {
      // 减费部分（每有 1 个友方「F2A 水牛」-1 花费）在 playCost 里现算（片段⑨）
      const n = addSbdToBackline(side, 2, { blitz:true });
      if(n) logMsg('掩护部队：' + n + ' 个「SBD 3 无畏」加入支援阵线并获得闪击。');
      else logMsg('掩护部队：支援阵线已满，「SBD 3 无畏」无法加入。');
      break; }
    /* ↓↓↓ batch-E4：新增 1 张指令 ↓↓↓ */
    // 英 HMS塔尔伯特：友方总部即将受到致命伤害时，先获得 +6 防御力。
    case 'HMS塔尔伯特': {
      // 指令本身不结算伤害：置一个常驻旗标，触发点在 applyHqDamage 的致命判定处（片段⑥）。
      // 写法与「柏林之路」roadBerlin 同形（playerOf(side) 上的常驻旗标）。
      me.hmsTalbot = true;
      logMsg('HMS塔尔伯特：友方总部即将受到致命伤害时，先获得 +6 防御力（常驻）。');
      break; }
  }
  sfx('order');
  render(); checkGameOver();
  return true;
}
function activateCounter(card){
  const me = S.p;
  const idx = me.hand.indexOf(card);
  if(idx < 0) return false;
  if(card.armed){
    // 已激活 → 收回：退还指挥点，取消激活（尚未打出）
    card.armed = false;
    const cost = playCost(me, card);
    me.kredit += cost;
    me.counters = (me.counters || []).filter(e => e !== card.eff);
    logMsg('反制「' + card.n + '」已收回，退回 ' + cost + ' 指挥点。');
    render();
    return 'disarmed';
  }
  const cost = playCost(me, card);
  if(me.kredit < cost){ toast('指挥点不足（需要 ' + cost + ' 点）'); render(); return false; }
  me.kredit -= cost;
  card.armed = true;
  if(!me.counters.includes(card.eff)) me.counters.push(card.eff);
  me.counterHit[card.eff] = false;          // 复位触发标记：重新挂载的反制可以再次触发
  logMsg('你激活了反制「' + card.n + '」（再点击一次收回；敌方真正触发才算打出）。');
  render();
  return 'armed';
}
/* 实际打出费用：巴顿（本回合手牌中所有单位部署花费 -1，最低 0）；
   本土决战（友方总部防御力≤10 → 4）；计划（场上每个友方「通用载具」-1，最低 0） */
function playCost(player, card){
  let c = (card.blood||0);
  // 精准轰炸（英）：花费降低等同于友方轰炸机最高攻击力（最低 0）
  if(card.eff === 'precisionBomb' && player && typeof S !== 'undefined' && S.board){
    const side = (player === S.a) ? 'a' : 'p';
    let top = 0;
    for(let r=0;r<ROWS;r++) for(let cc=0;cc<COLS;cc++){
      const x = S.board[r][cc];
      if(x && x.owner===side && x.def.t==='bomber' && x.atk > top) top = x.atk;
    }
    c = Math.max(0, c - top);
  }
  // 本土决战（日）：友方总部防御力（最大生命）≤10 时，花费降为 4
  if(card.eff === 'homelandDef' && player){ c = (player.maxHp <= 10) ? 4 : 8; }
  // 计划（中立特殊指令）：场上每个友方「通用载具」使花费 -1（最低 0）
  if(card.eff === 'plan' && player && typeof S !== 'undefined' && S.board){
    const side = (player === S.a) ? 'a' : 'p';
    let n = 0;
    for(let r=0;r<ROWS;r++) for(let cc=0;cc<COLS;cc++){
      const x = S.board[r][cc];
      if(x && x.owner===side && x.def.id==='ucarrier') n++;
    }
    c = Math.max(0, c - n);
  }
  if(player.patton && card.kind === 'unit') c = Math.max(0, c - 1);
  // 洛林十字（法）：敌方每有 1 张手牌，花费 -1
  if(card.eff === 'lorraine' && player){
    const foePl = (player === S.a) ? S.p : S.a;
    c = Math.max(0, c - (foePl.hand || []).length);
  }
  // 罗得突击旅（德）：在手牌中，每次友方反制触发时获得 -2 花费
  if(card.id === 'rhodes' && player){
    c = Math.max(0, c - 2 * (player.counterTriggers || 0));
  }
  /* ↓↓↓ batch-E2：三处现算减费 ↓↓↓ */
  // 掩护部队（美）：每有 1 个友方「F2A 水牛」，花费 -1（最低 0）
  // （与 precisionBomb / plan 同形：只在打的是本卡时现算，不写卡片状态）
  if(card.eff === '掩护部队' && player && typeof S !== 'undefined' && S.board){
    const side = (player === S.a) ? 'a' : 'p';
    let f2a = 0;
    for(let r=0;r<ROWS;r++) for(let cc=0;cc<COLS;cc++){
      const x = S.board[r][cc];
      if(x && x.owner===side && x.def.id === 'f2a') f2a++;   // 衍生卡 id = 'f2a'（DERIVED_CARDS.f2a）
    }
    c = Math.max(0, c - f2a);
  }
  // 第85先锋连（英）：每回合友方使用的第一张指令花费 -1（最低 0）。
  // **现算**：只看「该单位此刻在场上」+「本回合还没结算过指令（ordersThisTurn===0）」——
  // 这样本回合中途部署也立刻生效（旧写法用回合开始缓存的 firstOrderDiscount，部署当回合漏掉，用户报过）。
  // 「第一张」与被 ULTRA/拦截 反制的指令的关系：反制路径在上方 return，不增加 ordersThisTurn → 减费保留给下一张。
  if(player && card.kind === 'order' && !player.ordersThisTurn){
    const pside = (player === S.a) ? 'a' : 'p';
    if(onboardHasFx(pside, 'firstOrderMinus1')) c = Math.max(0, c - 1);
  }
  // 近卫步兵第4团（苏）：若在手中，敌方每抽 1 张牌获得 -1 花费（最低 0）
  // 计数在 drawCards 的 player.totalDraws（片段⑧）；这里数的是**敌方**的累计抽牌数
  // （与罗得突击旅 rhodes 的 player.counterTriggers 同形）。
  if(card.id === '近卫步兵第4团' && player){
    const foePl = (player === S.a) ? S.p : S.a;
    c = Math.max(0, c - (foePl.totalDraws || 0));
  }
  // 黑卫士兵团（英）：敌方指令具有 +2 花费（现算，与 precisionBomb/plan/掩护部队 同形；不出日志，避免每帧渲染刷屏）
  if(card.kind === 'order' && player && typeof S !== 'undefined' && S.board){
    const foeSide0 = (player === S.p) ? 'a' : 'p';
    if(onboardHasFx(foeSide0, 'blackwatchTax')) c += 2;
  }
  // 威灵顿（英）：若在手牌中，友方使用指令时获得 -2 花费（最低 0）
  // 计数在 orderEffect（HOOK-2），离开手牌即清零；跨回合保留（卡面没有「直到回合结束」）。
  if(card.id === '威灵顿' && player){
    c = Math.max(0, c - (player.wellingtonDiscount || 0));
  }
  if(card.handCostPlus) c = Math.max(0, c + card.handCostPlus);   // 主动声呐（英·R4）：手牌 +3 花费
  return c;
}
function canAfford(player, card){ return playCost(player, card) <= player.kredit; }
/* 红魔空降步兵团：敌方指向或攻击本单位时 +1 花费（单位属于另一方才生效；hq 目标无单位信息，直接 0） */
function targetSurcharge(side, unit){
  return (unit && unit.owner && unit.owner !== side && unit.def && hasFx(unit,'reddevil')) ? 1 : 0;
}
/* 抽取卡判定：PB2Y卡罗纳多（单位 fx=drawReveal）/ 航母打击群（指令 eff=carrierGroup） */
const isDrawRevealCard = (card) => !!card && (
  (card.fx && card.fx.includes('drawReveal')) ||
  card.e === 'drawReveal' ||
  (card.eff === 'carrierGroup' || card.e === 'carrierGroup')
);
function drawCards(player, n, noReveal, isTurnDraw){
  let drawn = 0;
  if(player.drawBanned){ logMsg('豹式坦克A型：' + playerNameOf(player) + '本回合无法抽牌。'); return 0; }
  for(let i=0; i<n; i++){
    if(player.deck.length === 0){
      // 北北布次香菜：不抽牌且不受士气伤害（防御性兜底）
      if(player === S.a && S.bossKind === 'meme') break;
      // 士气疲劳：牌库空时抽牌受到递增伤害（无法被减少或转移）
      player.fatigue = (player.fatigue||0) + 1;
      player.hp -= player.fatigue;
      logMsg('牌库已空！士气疲劳 ' + player.fatigue + ' 点伤害（无法减免）。');
      sfx('kill');
      checkGameOver();
      break;
    }
    if(player.hand.length >= MAX_HAND){ logMsg('手牌已满（9张）。'); break; }
    const card = player.deck.pop();
    player.hand.push(card);
    drawn++;
    // 抽取效果：不管什么手段抽到的抽取特效牌都触发；仅「开局发牌」不向对手展示明牌（revealed）
    if(isDrawRevealCard(card)){
      if(!noReveal){
        card.revealed = true; // 明牌：抽取揭示的牌（航母打击群/卡罗纳多）对对手正面可见
        HOOKS.onDrawnReveal(card, player === S.a ? 'a' : 'p');
      }
      triggerDrawReveal(player, card);
    }
  }
  // 闪电袭击反制：敌方额外抽牌（非常规回合摸牌）时对其总部造成 4 点伤害（触发即消耗）
  // 只在敌方自己的行动回合内生效（规则：反制在敌方回合达成条件才触发）——
  // 敌方在回合外抽牌（亡计/受击抽牌/奖励抽牌等）不触发，友方抽牌更不触发
  if(drawn > 0 && !isTurnDraw && S.phase === 'ai' && player === S.a && S.p.counters.includes('enemyDrawPunish')){
    S.p.counterHit.enemyDrawPunish = true;
    consumePlayerCounter('enemyDrawPunish');   // 触发即消耗：撤下计数器 + 从手牌移除那张（否则还能收回退款）
    S.a.hp -= 4;
    logMsg('反制·闪电袭击：老牧师额外抽牌，其总部受到 4 点伤害！');
    checkGameOver();
  } else if(drawn > 0 && !isTurnDraw && S.phase === 'player' && player === S.p && S.a.counters.includes('enemyDrawPunish')){
    S.a.counters = S.a.counters.filter(e => e !== 'enemyDrawPunish');
    S.a.counterHit.enemyDrawPunish = true;
    emitCounterFx('a', 'enemyDrawPunish');
    S.p.hp -= 4;
    logMsg('敌方反制·闪电袭击：你额外抽牌，总部受到 4 点伤害！');
    checkGameOver();
  }
  /* ↓↓↓ batch-E2：抽牌触发的被动（2 张） ↓↓↓ */
  if(drawn > 0){
    const dSide = (player === S.a) ? 'a' : 'p';
    // M3A3甜心（英）：友方抽 1 张牌时，使友方总部获得 +1 防御力（每张牌各触发一次 = +drawn）。
    // 同名即生效的光环：直接扫 def.id（与 plan 扫 ucarrier 同写法）。
    let hasSweetheart = false;
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const x = S.board[r][c];
      if(x && x.owner===dSide && x.def.id==='M3A3甜心') hasSweetheart = true;
    }
    if(hasSweetheart){
      player.maxHp += drawn; player.hp += drawn;
      logMsg('M3A3甜心：友方抽 ' + drawn + ' 张牌，友方总部 +' + drawn + ' 防御力。');
    }
    // 近卫步兵第4团（苏）：本局累计抽牌计数（供 playCost 现算「敌方每抽 1 张牌 -1 花费」）
    player.totalDraws = (player.totalDraws || 0) + drawn;
  }
  if(drawn) sfx('draw');
  return drawn;
}
/* 抽取效果触发（深度保护：抽取触发抽牌可能再抽到抽取卡） */
let drawRevealDepth = 0;
function triggerDrawReveal(player, card){
  if(drawRevealDepth >= 3) return;
  drawRevealDepth++;
  try {
    const eff = card.fx ? card.fx.find(f=>f==='drawReveal') : null;
    const side = player === S.p ? 'p' : 'a';
    if(card.id === 'pb2y'){       // PB2Y卡罗纳多：抽取时把 1 个 F2A 水牛加入支援战线
      if(spawnF2As(side, 1, false)) logMsg(card.n+' 抽取：1 个「F2A 水牛」加入支援战线。');
    } else if(card.id === 'carriergroup'){ // 航母打击群：抽取时抽 1 张空军
      const idx = player.deck.findIndex(c2 => c2 && c2.kind==='unit' && (c2.t==='fighter' || c2.t==='bomber'));
      if(idx >= 0 && player.hand.length < MAX_HAND){
        const air = player.deck.splice(idx,1)[0];
        player.hand.push(air);
        logMsg(card.n+' 抽取：抽到空军「'+air.n+'」。');
        if(air.fx && air.fx.includes('drawReveal')) triggerDrawReveal(player, air);
      } else logMsg(card.n+' 抽取：牌库中没有空军。');
    }
  } finally { drawRevealDepth--; }
}
/* Boss 挑战玩家增强：一切抽牌摸到抽取卡（PB2Y卡罗纳多/航母打击群）都触发特效——
   覆盖不走 drawCards 的自定义抽牌路径（如美国陆军航空队）；非 Boss 对局保持原行为 */
function bossPlayerReveal(card){
  if(!S.bossMode || !card) return;
  if(S.p.hand.indexOf(card) < 0) return; // 手牌已满退回牌库的不算抽到
  if(isDrawRevealCard(card)){
    HOOKS.onDrawnReveal(card, 'p'); // Boss 增强是玩家侧抽到
    triggerDrawReveal(S.p, card);
  }
}
/* 生成衍生卡 F2A 水牛并部署（frontFirst=优先放前线；
   前线被敌方占领时「若可能，加入前线」不成立——只能加入底线） */
function spawnF2As(side, n, frontFirst){
  let placed = 0;
  const frontContested = S.board[1].some(x => x && x.owner !== side);
  for(let i=0;i<n;i++){
    const def = makeDerived('f2a');
    if(!def) break;
    let ok = false;
    if(frontFirst && !frontContested){
      for(let c=0;c<COLS;c++) if(!S.board[1][c]){ if(spawnUnit(side, def, 1, c)){ ok = true; break; } }
    }
    if(!ok){
      const br = backRowOf(side);
      for(let c=0;c<COLS;c++) if(!S.board[br][c]){ if(spawnUnit(side, def, br, c)){ ok = true; break; } }
    }
    if(!ok) break;
    placed++;
  }
  return placed;
}

/* ---------- 盟国/新增卡公用辅助 ---------- */
/* 场上是否存在带某效果的友方单位 */
function onboardHasFx(side, fx){
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && hasFx(x,fx)) return true; }
  return false;
}
/* 92英寸岸防炮（英）：本单位造成伤害时，使友方总部获得同等防御力
   （与菲亚特 G.50 的 g50HqHeal 同文案；G.50 只挂在对单位伤害点，本卡覆盖本单位造成伤害的全部 4 个点：
     攻击单位 / 直击敌方总部 / 伏击反击 / 反击。dmg 一律取「实际造成的伤害」） */
function x92HqHeal(src, dmg){
  if(!src || !src.def || dmg <= 0 || !hasFx(src,'x92HqHeal')) return;
  const me = playerOf(src.owner);
  me.maxHp += dmg; me.hp += dmg;
  logMsg(src.def.n + '：友方总部获得 +' + dmg + ' 防御力。');
}
/* 衍生单位加入手牌（军团/游击队员/轻步兵等）：手牌满则停 */
/* 衍生单位加入支援阵线（己方底线；可选前线优先）；返回放置数 */
function addDerivedToBoard(side, id, n, opts){
  opts = opts || {};
  let placed = 0;
  const frontOk = opts.front && !S.board[1].some(x => x && x.owner !== side);
  for(let i=0;i<n;i++){
    const def = makeDerived(id);
    if(!def) break;
    if(opts.mods) opts.mods(def);
    let ok = false;
    if(frontOk){ for(let c=0;c<COLS;c++) if(!S.board[1][c]){ if(spawnUnit(side, def, 1, c)){ ok = true; break; } } }
    if(!ok){ const br = backRowOf(side); for(let c=0;c<COLS;c++) if(!S.board[br][c]){ if(spawnUnit(side, def, br, c)){ ok = true; break; } } }
    if(!ok) break;
    placed++;
  }
  return placed;
}
/* 弃牌：芬兰男孩步兵团在场时，该方手牌无法被弃掉 */
function canDiscard(player){ return !onboardHasFx(player === S.p ? 'p' : 'a', 'noDiscard'); }
function discardCard(player, card){
  if(!card || !player) return false;
  if(!canDiscard(player)){ logMsg('芬兰男孩步兵团在场：' + playerNameOf(player) + '的手牌无法被弃掉。'); return false; }
  const i = player.hand.indexOf(card);
  if(i < 0) return false;
  player.hand.splice(i, 1);
  logMsg('弃掉了「' + card.n + '」。');
  // 用户 2026-09-13：敌方（AI）被弃牌时，玩家得**看见**弃掉的是哪张（原来只有一行日志，等于没提示）
  if(player === S.a) HOOKS.onFoeDiscard(card, '弃牌');
  return true;
}
/* 随机弃牌（可带筛选；返回被弃的卡） */
function randomDiscard(player, pred){
  if(!canDiscard(player)) return null;
  const pool = player.hand.filter(c => c && (!pred || pred(c)));
  if(!pool.length) return null;
  const card = pool[Math.floor(Math.random()*pool.length)];
  return discardCard(player, card) ? card : null;
}
function playerNameOf(player){ return player === S.p ? '你' : '老牧师'; }
/* 随机排列某方场上单位的位置（夜间轰炸） */
function shuffleSideBoard(side){
  const pos = [], units = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side){ pos.push([r,c]); units.push(x); } }
  if(!units.length) return 0;
  shuffle(units);
  pos.forEach(([r,c], i) => { S.board[r][c] = units[i]; });
  units.forEach(u => syncRowSig(u));
  logMsg('所有敌方单位被随机排列。');
  return units.length;
}
/* 转换为「溃军」：保留位置，替换为单位定义（1/1 步兵） */
function convertToRout(u){
  if(!u) return false;
  // batch-F4·背水一战（苏）/ 马奇诺防线（法）：获得「无法撤退」的单位不被转换为「溃军」
  if(hasFx(u,'noRetreat')){ logMsg(u.def.n + ' 无法撤退，不受影响。'); return false; }
  const def = makeDerived('rout');
  if(!def) return false;
  const name = u.def.n;
  u.def = def;
  u.atk = def.atk; u.maxHp = def.hp; u.hp = def.hp;
  u.baseAtk = def.atk; u.baseMaxHp = def.hp; u.baseFuel = def.fuel || 0;
  u.armor = 0; u.suppressed = false; u.inhibited = false;
  logMsg(name + ' 被转换为「溃军」。');
  return true;
}
/* 加入「抵抗」到敌方手牌（法国机制）：我方塞给对方的牌对自己是明牌（revealed → 敌方手牌 UI 正面直显） */
function addResistToEnemy(side, n){
  const foe = enemyOf(side);
  const owner = playerOf(foe);
  let added = 0;
  for(let i=0;i<n;i++){
    if(owner.hand.length >= MAX_HAND){ logMsg('敌方手牌已满，「抵抗」无法加入。'); break; }
    const card = makeResist();
    card.revealed = true;          // 明牌：塞牌方看得见
    owner.hand.push(card);
    added++;
  }
  if(added) logMsg('将 ' + added + ' 张「抵抗」加入敌方手牌（明牌）。');
  return added;
}
/* 缴获（收缴）：消灭敌方单位后，将其 1/1 复制加入手牌（至多花费 3） */
function seizeCopy(side, deadUnit){
  if(!deadUnit) return false;
  const owner = playerOf(side);
  if(owner.hand.length >= MAX_HAND){ logMsg('手牌已满，无法收缴。'); return false; }
  const src = deadUnit.def;
  const copy = {
    kind:'unit', id:src.id, n:src.n + '(收缴)', t:src.t,
    blood:Math.min(3, src.blood||0), fuel:src.fuel||0, atk:1, hp:1,
    sig:[], armor:0, fx:(src.fx||[]).slice(), deploy:null, target:null,
    nation:src.nation || null, rarity:'无', img:src.img, desc:'收缴复制（1/1，花费至多 3）'
  };
  handPushRevealed(owner, copy);
  logMsg('收缴：' + src.n + ' 的 1/1 复制加入手牌。');
  return true;
}

/* ---------- 指向型指令的合法目标列表（无目标则无法打出） ---------- */
function orderTargets(card, side){
  const foe = enemyOf(side);
  const out = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const x = S.board[r][c];
    if(!x) continue;
    let ok = false;
    if(card.target === 'friendly-unit') ok = x.owner === side;
    else if(card.target === 'friendly-fighter') ok = x.owner === side && x.def.t === 'fighter';
    else if(card.target === 'friendly-infantry') ok = x.owner === side && x.def.t === 'infantry';
    else if(card.target === 'friendly-tank') ok = x.owner === side && isTankUnit(x);
    else if(card.target === 'friendly-ground') ok = x.owner === side && (x.def.t === 'tank' || x.def.t === 'infantry'); // 坦克或步兵（不含炮兵）
    else if(card.target === 'friendly-guard') ok = x.owner === side && hasSig(x,'guard'); // 友方守护单位
    else if(card.target === 'friendly-air') ok = x.owner === side && (x.def.t === 'fighter' || x.def.t === 'bomber'); // 友方空军
    else if(card.target === 'friendly-army') ok = x.owner === side && isArmyType(x.def.t);
    else if(card.target === 'friendly') ok = x.owner === side;
    else if(card.target === 'enemy-unit' || card.target === 'enemy-unit-hq' || card.target === 'enemy') ok = x.owner !== side;
    else if(card.target === 'enemy-any') ok = x.owner !== side;
    else if(card.target === 'any') ok = true; // 任意目标：双方单位皆可指向（只写"造成X点伤害"的指令）
    else if(card.target === 'enemy-infantry') ok = x.owner !== side && x.def.t === 'infantry';
    else if(card.target === 'enemy-army') ok = x.owner !== side && (x.def.t==='infantry' || x.def.t==='tank' || x.def.t==='artillery');
    else if(card.target === 'enemy-fly') ok = x.owner !== side && (x.def.t==='fighter' || x.def.t==='bomber');
    else if(card.target === 'enemy-backline') ok = x.owner !== side && r === backRowOf(side==='p'?'a':'p');
    else if(card.target === 'enemy-frontline') ok = x.owner !== side && r === 1;
    if(ok) out.push({row:r, col:c, u:x});
  }
  // 炮艇任务 / 轰炸突袭 / 快速胜利 / 航母战 / 外交专员 / 嗡嗡炸弹：可选敌方总部（任意目标或敌方目标）
  // 注：总部烟幕**只挡单位攻击**，不挡指令指向（用户 2026-09-17 拍板：指令仍能指向带烟幕的总部，别改）
  if(card.eff === 'gunboat' || card.eff === 'bombRaid' || card.eff === 'quickWin' || card.eff === 'carrierWar' || card.eff === 'diplomat' || card.eff === 'buzzBomb'
     || card.eff === 'lorraine' || card.eff === 'attackColony' || card.eff === 'dayBomb'
     || card.eff === '气动雪橇') out.push({hq:true, kind:'hq'});
  if(card.eff === 'amphibious') return out.filter(t => t.u && t.u.atk <= 3 && !tiger2Blocked(side, t.u));
  // 穷兵黩武（日）：只可指向「攻击力不大于友方指挥点槽数」的单位（虎式E 的免指向照旧保留）
  if(card.eff === '穷兵黩武'){
    const slots0 = playerOf(side).kreditSlots || 0;
    return out.filter(t => t.u && t.u.atk <= slots0 && !(t.u.owner !== side && hasFx(t.u,'tigerE')));
  }
  // 指挥不当（日）：只可指向「攻击力小于防御力」的单位
  if(card.eff === '指挥不当') return out.filter(t => t.u && t.u.atk < t.u.hp && !(t.u.owner !== side && hasFx(t.u,'tigerE')));
  // 虎式坦克E型：无法成为敌方指令的目标（己方指令仍可指向自己）
  // 虎王：友方支援阵线的卡牌无法成为敌方指令的目标（己方指令仍可指向自己）
  const legal = out.filter(t => !(t.u && t.u.owner !== side && (hasFx(t.u,'tigerE') || tiger2Blocked(side, t.u))));
  // ---- batch-F6（英）指向型指令的合法目标细化（写法同「穷兵黩武」）----
  // 口径（用户 2026-09-13）：这 4 张的 target 已改判 'any'（增益也可指向敌方）→ 只留类型/词条过滤，
  // 归属由 case 内的类型校验兜底（去掉 t.u.owner === side 后，敌我双方符合类型的单位都可点）
  if(card.eff === '坚决守护') return legal.filter(t => t.u && hasSig(t.u,'guard'));
  if(card.eff === '深沟固垒') return legal.filter(t => t.u && t.u.owner === side && hasSig(t.u,'guard'));
  if(card.eff === '袋鼠运输') return legal.filter(t => t.u && t.u.def.t === 'infantry' && t.u.def.nation === 'gb');
  if(card.eff === '战术撤退') return legal.filter(t => t.u && t.u.owner === side && t.row === 1);
  if(card.eff === '防空弹幕') return legal.filter(t => t.u && (t.u.def.t === 'fighter' || t.u.def.t === 'bomber'));
  if(card.eff === '空投补给') return legal.filter(t => t.u && (isTankUnit(t.u) || t.u.def.t === 'infantry'));
  if(card.eff === '为了国王') return legal.filter(t => t.u && t.u.owner !== side && isTankUnit(t.u));
  return legal;
}
/* 部署指向的合法目标（第二挺进团只可消灭攻≤2） */
function deployPickValid(m, u){
  if(!u || !m || m.type !== 'deployPick') return false;
  // 虎王：AI 支援阵线的卡牌无法成为玩家部署效果的目标
  // （deployPick 只出现在玩家侧 UI 流程，故取目标方固定是 'p'；含 target==='any' 的部署。
  //  tiger2Blocked 对 u.owner==='p' 一律返回 false，所以「贴自己人」的部署不受影响）
  if(m.tgtOwner !== 'p' && tiger2Blocked('p', u)) return false;
  // 零战/威尔士卫队：任意单位皆可（含友方）
  if(m.card && m.card.target === 'any') return true;
  // 归属 + 兵种/战线统一走 targetUnitOk（与部署前的 deployCanTarget 同口径）
  const pos = findPosOf(u);
  if(!pos || !targetUnitOk(m.card, u, pos.r, 'p')) return false;
  if(m.card && m.card.deploy === 'destroyAtk2' && u.atk > 2) return false;
  return true;
}
/* 压制：目标自身免疫压制则不生效（虎式无光环，相邻单位照常被压制） */
function applySuppress(u){
  if(!u) return false;
  if(hasFx(u,'immuneSuppress')){ logMsg(u.def.n+' 免疫压制'); return false; }
  u.suppressed = true;
  return true;
}

/* ---------- 回合流程 ---------- */
/* 第109战斗工兵营：其他友方单位移至前线时，使其获得 +1 攻击力（单位自身除外） */
function eng109Buff(side, u){
  if(!u || u.def.id === 'eng109') return;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const x = S.board[r][c];
    if(x && x.owner === side && x.def.id === 'eng109'){
      u.atk += 1;
      logMsg('第109战斗工兵营：'+u.def.n+' 移至前线，获得 +1 攻击力。');
      return;
    }
  }
}
/* 牛津（英·金 2费1油 1/3 轰炸机）：友方陆军部署时，使其攻击力等同于其防御力。
   与第109战斗工兵营 eng109Buff 同形（扫场找光环源、命中即改写这次的部署物），差别有三：
   · 只作用于陆军（步兵/坦克/炮兵）——空军/总部不受影响（isArmyType）；
   · 只作用于「本次从手牌部署」的单位（调用点带 !noDeploy，口径同全域战争）；
   · 取 maxHp（防御力上限）而非当前血量：新落地单位两者相等，被全域战争改过也以防御力为准。
   返回 true 表示本次部署被牛津改写。 */
function oxfordEqualize(side, u){
  if(!u || !u.def || !isArmyType(u.def.t)) return false;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const x = S.board[r][c];
    if(x && x.owner === side && x !== u && x.def.id === '牛津'){
      if(u.atk !== u.maxHp){
        logMsg('牛津：' + u.def.n + ' 的攻击力等同于其防御力（⚔' + u.atk + ' → ⚔' + u.maxHp + '）。');
        u.atk = u.maxHp;
      }
      return true;
    }
  }
  return false;
}
/* 遥远的桥：敌方回合结束时结算——若可能把 1 个「三号坦克J型」加入前线，否则消灭前线所有单位 */
function resolveBridgeTooFar(side){
  const me = playerOf(side);
  if(!me.bridgeTooFar) return;
  me.bridgeTooFar = false;
  const contested = S.board[1].some(x => x && x.owner !== side);
  let placed = false;
  if(!contested){
    const pz = NATIONS.de.units.find(u=>u.id==='pz3j');
    if(pz){
      for(let c=0;c<COLS;c++) if(!S.board[1][c]){ if(spawnUnit(side, mkUnitDef(pz,'de'), 1, c)){ placed = true; break; } }
    }
  }
  if(placed) logMsg('遥远的桥：三号坦克J型 加入前线！');
  else {
    let n = 0;
    for(let c=0;c<COLS;c++){ if(S.board[1][c]){ killUnit(1,c); n++; } }
    logMsg('遥远的桥：无处落桥——前线所有单位被消灭（'+n+'）。');
  }
  render();
}
/* 第二战线（德）：敌方回合结束时，把被「移除」的友方单位返回其**支援战线**并复制 1 份。
   用户 2026-09-17：「第2战线是把单位加入支援战线」——回场位置固定是拥有者自己的底线
   （玩家 row2 / AI row0），不再回原战线（旧写法 rows=[原行, 底线, 前线, 0, 2] 会把单位放回前线，
   极端情况下甚至会放进对方的底线）。支援战线满了就暂缓返回，绝不改放别的战线。 */
function resolveSecondFront(side){
  const me = playerOf(side);
  if(!me.secondFront || !me.secondFront.length) return;
  const rest = [];
  for(const rec of me.secondFront){
    const u = rec.u;
    if(!u){ continue; }
    const slot = secondFrontSlot(side);
    if(!slot){ rest.push(rec); logMsg('第二战线：支援战线已满，' + u.def.n + ' 暂缓返回。'); continue; }
    u.summonedThisTurn = true;
    u.attackedN = 0; u.movedThisTurn = false;
    S.board[slot.r][slot.c] = u;
    logMsg('第二战线：' + u.def.n + ' 返回支援战线。');
    const slot2 = secondFrontSlot(side);
    if(slot2){
      const copy = makeUnit(JSON.parse(JSON.stringify(u.def)), side);
      copy.atk = u.atk; copy.maxHp = u.maxHp; copy.hp = u.hp;
      copy.baseAtk = u.baseAtk; copy.baseMaxHp = u.baseMaxHp; copy.baseFuel = u.baseFuel;
      copy.armor = u.armor;
      copy.summonedThisTurn = true;
      S.board[slot2.r][slot2.c] = copy;
      logMsg('第二战线：' + u.def.n + ' 的复制加入支援战线。');
    } else logMsg('第二战线：支援战线无空位，复制未能加入。');
  }
  me.secondFront = rest;
  render();
}
/* 第二战线的回场格：只认拥有者自己的支援战线（底线） */
function secondFrontSlot(side){
  const br = backRowOf(side);
  for(let c=0;c<COLS;c++) if(!S.board[br][c]) return { r: br, c };
  return null;
}
/* 协力：回合开始时场上友方单位国家快照 */
function collectNations(side){
  const s = new Set();
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner===side && x.def.nation) s.add(x.def.nation); }
  return s;
}
/* 协力（规则.txt）：使用该卡牌时，除非回合开始时场上有相同国家的友方单位，
   否则总部受到 1 点士气伤害（算作伤害，无法被减少或转移） */
function coopCheck(side, card){
  const me = playerOf(side);
  if(!card || !(card.sig || []).includes('coop')) return;
  if(me.coopNations && me.coopNations.has(card.nation)) return;
  me.hp -= 1;
  const n = card.nation && nationOf(card.nation) ? nationOf(card.nation).name : card.nation;
  logMsg('协力：回合开始时场上没有同国（'+n+'）友方单位，总部受到 1 点士气伤害（无法减免）。');
  checkGameOver();
}
function checkGameOver(){
  if(S.over) return;
  if(S.a.hp <= 0){ endGame('p'); }
  else if(S.p.hp <= 0){ endGame('a'); }
}
/* ---------- Boss 挑战（梦之泪伤）：美国水牛卡组带满 + 日本空军加成指令 ---------- */
function buildTearsDeck(){
  const us = NATIONS.us, jp = NATIONS.jp;
  const list = [];
  const add = (d, key) => { if(!d) return; const n = maxCopiesOf(d.id); for(let i=0;i<n;i++) list.push(Object.assign({}, d, { nation: key })); };
  // 与水牛关联的卡（带满 = 按稀有度上限：金1/银2/铜3/铁4）
  add(us.units.find(u=>u.id==='f4f'), 'us');          // F4F-4 野猫（铁×4）
  add(us.units.find(u=>u.id==='pb2y'), 'us');         // PB2Y卡罗纳多（铜×3）
  add(us.orders.find(o=>o.id==='aircover'), 'us');    // 空中掩护（铁×4）
  add(us.orders.find(o=>o.id==='carriergroup'), 'us');// 航母打击群（铜×3）
  add(us.orders.find(o=>o.id==='carriercover'), 'us');// 航母掩护（铜×3）
  add(us.orders.find(o=>o.id==='yorktown'), 'us');    // USS约克城号（银×2）
  // 日本空军加成指令
  add(jp.orders.find(o=>o.id==='yamamoto'), 'jp');    // 山本五十六（金×1）
  add(jp.orders.find(o=>o.id==='blazing'), 'jp');     // 烈日（铁×4）
  add(jp.orders.find(o=>o.id==='backlight'), 'jp');   // 逆光攻击（银×2）
  return list; // 共 26 张
}
/* ---------- Boss 挑战（阿尔卑斯要塞）：美德快攻卡组 ----------
   美国和德国的低费单位（不含 T19榴弹炮/F4F野猫/二号坦克/第506/17步兵团）
   + M7牧师/闪电战/USS约克城号/巴顿/地狱猫/为了自由/奎宁，均带满 */
function buildAlpsDeck(){
  const us = NATIONS.us, de = NATIONS.de;
  const list = [];
  const add = (d, key) => { if(!d) return; const n = maxCopiesOf(d.id); for(let i=0;i<n;i++) list.push(Object.assign({}, d, { nation: key })); };
  // 美德低费单位（快攻曲线；排除 T19榴弹炮/F4F野猫/二号坦克/第506/17步兵团）
  ['r32','r1def','reddevil','r164','eng109'].forEach(id => add(us.units.find(u=>u.id===id), 'us'));
  ['pz35','r59'].forEach(id => add(de.units.find(u=>u.id===id), 'de'));
  // 指定卡（带满）
  add(us.units.find(u=>u.id==='m7'), 'us');            // M7牧师（铜×3）
  add(us.units.find(u=>u.id==='m18'), 'us');           // 地狱猫（银×2）
  add(de.orders.find(o=>o.id==='blitzkrieg'), 'de');   // 闪电战（铜×3）
  add(us.orders.find(o=>o.id==='yorktown'), 'us');     // USS约克城号（银×2）
  add(us.orders.find(o=>o.id==='patton'), 'us');       // 巴顿（金×1）
  add(us.orders.find(o=>o.id==='forfreedom'), 'us');   // 为了自由（银×2）
  add(us.orders.find(o=>o.id==='quinine'), 'us');      // 奎宁（铜×3）
  return list; // 共 38 张
}
/* ---------- 最终 Boss「hana」卡组：20 张随机国家金卡单位 + 20 张随机国家金卡指令 ----------
   （用户 2026-09-16 口径）金卡 = RARITY 为「金」；国家在 9 国里随机取，允许重复；
   反制不带；开局手牌由 startGame 换成 5 张研发（不走这里的牌堆）。 */
function buildHanaDeck(){
  const units = [], orders = [];
  for(const [key, n] of Object.entries(NATIONS)){
    (n.units || []).forEach(u => { if(rarityOf(u.id) === '金') units.push({ raw:u, key:key }); });
    (n.orders || []).forEach(o => { if(rarityOf(o.id) === '金') orders.push({ raw:o, key:key }); });
  }
  const draw = (pool, n, mk) => {
    const out = [];
    if(!pool.length) return out;
    for(let i=0;i<n;i++){ const e = pool[Math.floor(Math.random()*pool.length)]; out.push(mk(e.raw, e.key)); }
    return out;
  };
  return draw(units, 20, mkUnitDef).concat(draw(orders, 20, mkOrderDef));
}
/* Boss 卡组按种类分发（北北布次香菜：不携带卡牌） */
function buildBossDeck(kind){
  return kind === 'alps' ? buildAlpsDeck() : kind === 'meme' ? [] : kind === 'hana' ? buildHanaDeck() : buildTearsDeck();
}
/* Boss 命数：hana 三条命（其余两条命＝一次重生） */
function bossLives(kind){ return kind === 'hana' ? 3 : 2; }
/* 阿尔卑斯要塞 开局脚本：弃置全部手牌 → 虚空印卡 巴顿 → 第109战斗工兵营 ×1 →
   第164步兵团 ×4 + 第32步兵团 ×4（推进前线；前线有玩家单位先消灭再继续铺） */
async function alpsOpening(){
  S.a.hand = [];
  logMsg('阿尔卑斯要塞 打开要塞大门——弃置全部手牌，虚空印卡！');
  const voidPrint = (key, id) => { const raw = NATIONS[key] && NATIONS[key].orders.find(o=>o.id===id); if(raw) orderEffect(mkOrderDef(Object.assign({}, raw, {nation:key}), key), null); };
  voidPrint('us', 'patton'); // 巴顿：本回合手牌单位 -1 费 + 部署后闪击
  render(); await HOOKS.wait(900);
  if(S.over) return;
  // 1× 第109战斗工兵营（支援底线；虚空印卡不触发部署特效）
  spawnUnit('a', mkUnitDef(NATIONS.us.units.find(u=>u.id==='eng109'), 'us'), 0, 0, true);
  render(); await HOOKS.wait(600);
  if(S.over) return;
  // 4× 第164步兵团：部署底线 → 推进前线（有从底线到前线的过程；前线有玩家单位先消灭再继续铺）
  // 4× 第32步兵团：仅部署底线，不推前线（虚空印卡不触发部署特效）
  // 玩家单位占据前线时：要塞单位自动与之交换战斗（不消灭、不清空前线）
  for(let c=0;c<COLS;c++){
    const x = S.board[1][c];
    if(!x || x.owner !== 'p') continue;
    const slot = emptyBacklineSlot('a');
    if(!slot || S.over) break;
    const d164 = mkUnitDef(NATIONS.us.units.find(u=>u.id==='r164'), 'us');
    spawnUnit('a', d164, slot.row, slot.col, true);
    const u = unitAt(slot.row, slot.col);
    if(u && canAct(u)){
      logMsg('阿尔卑斯要塞：前线接触——第164步兵团 与 '+x.def.n+' 交换火力！');
      combat({row:slot.row, col:slot.col}, {row:1, col:c});
    }
    render(); await HOOKS.wait(650);
  }
  let pushed = 0;
  for(let i=0;i<4;i++){
    if(S.over) break;
    const slot = emptyBacklineSlot('a');
    if(!slot) break;
    const def = mkUnitDef(NATIONS.us.units.find(u=>u.id==='r164'), 'us');
    spawnUnit('a', def, slot.row, slot.col, true);
    if(S.a.patton){ // 巴顿：部署后具有闪击
      const dep = unitAt(slot.row, slot.col);
      if(dep && !hasSig(dep,'blitz')){ dep.def.sig.push('blitz'); }
    }
    render(); await HOOKS.wait(500); // 底线亮相
    const u = unitAt(slot.row, slot.col);
    const contested = S.board[1].some(x => x && x.owner !== 'a');
    if(!contested && u){
      const target = S.board[1][slot.col] ? (()=>{ for(let c2=0;c2<COLS;c2++) if(!S.board[1][c2]) return c2; return -1; })() : slot.col;
      if(target >= 0){
        S.board[1][target] = u; S.board[slot.row][slot.col] = null;
        u.movedThisTurn = true; u.summonedThisTurn = false;
        eng109Buff('a', u); // 第109战斗工兵营：其他友方单位移至前线时 +1 攻击力
        HOOKS.onMoveForward({ side:'a', fromRow:slot.row, fromCol:slot.col, toRow:1, toCol:target, def:u.def }); // 推进动画/音效
        pushed++;
      }
    }
    render(); await HOOKS.wait(450); // 推进过程
  }
  for(let i=0;i<4;i++){
    if(S.over) break;
    const slot = emptyBacklineSlot('a');
    if(!slot) break;
    const def = mkUnitDef(NATIONS.us.units.find(u=>u.id==='r32'), 'us');
    spawnUnit('a', def, slot.row, slot.col, true);
    if(S.a.patton){
      const dep = unitAt(slot.row, slot.col);
      if(dep && !hasSig(dep,'blitz')){ dep.def.sig.push('blitz'); }
    }
    render(); await HOOKS.wait(420);
  }
  logMsg('阿尔卑斯要塞：'+pushed+' 个第164步兵团推进前线，第32步兵团留守底线，要塞大门合拢。');
  render(); await HOOKS.wait(700);
}
/* 北北布次香菜：猛攻——全体单位攻击玩家总部（奋战攻击两次；底线守护先清除） */
async function memeAllOutAttack(){
  const units = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner==='a' && canAct(x)) units.push({u:x,r,c}); }
  for(let pass=0; pass<2 && !S.over; pass++){
    for(const at of units){
      if(S.over) break;
      if(!canAct(at.u)) continue;
      const tgts = attackTargets('a', at.r, at.c);
      if(!tgts.length) continue;
      let t = null;
      if(tgts.some(x=>x.hq)){ t = {hq:true}; }
      else { t = tgts.find(x=>!x.hq && hasSig(unitAt(x.row,x.col),'guard')) || tgts[0]; }
      combat({row:at.r, col:at.c}, t);
      render(); await HOOKS.wait(600);
    }
  }
}
/* 北北布次香菜：全程固定行动——剧本卡按回合「固定发放到手上」，再按正常规则打出
   （按卡面费用支付，付不起就留在手里等下一回合；玩家反制照常生效——可影响她）。
   ①空过 ②战争机器 ③战争需要 ④反潜巡逻 ⑤生产+紫电+激励部队+烈日 ⑥起每回合猛攻总部。
   不抽牌、不受士气伤害 */
async function memeBossTurn(){
  S.memeTurn = (S.memeTurn||0) + 1;
  const t = S.memeTurn;
  // 每回合自然增长 1 个指挥点槽（空过也算回合）
  S.a.kreditSlots = (S.a.kreditSlots < 12) ? S.a.kreditSlots + 1 : S.a.kreditSlots;
  S.a.kredit = S.a.kreditSlots;
  /* 固定发放：把剧本卡加入手牌（正常费用，不做零费处理） */
  const grant = (key, id) => {
    const raw = NATIONS[key] && NATIONS[key].orders.find(o=>o.id===id);
    if(!raw) return;
    const c = mkOrderDef(Object.assign({}, raw, {nation:key}), key);
    c._memeScript = true;
    if(S.a.hand.length < MAX_HAND) S.a.hand.push(c);
    else S.a.deck.push(c);
  };
  const grantUnit = (key, id) => {
    const raw = NATIONS[key] && NATIONS[key].units.find(u=>u.id===id);
    if(!raw) return;
    const c = mkUnitDef(raw, key);
    c._memeScript = true;
    if(S.a.hand.length < MAX_HAND) S.a.hand.push(c);
    else S.a.deck.push(c);
  };
  const grantProduce = () => { const p = makeProduceDef(); p._memeScript = true; if(S.a.hand.length < MAX_HAND) S.a.hand.push(p); };
  if(t === 1){
    logMsg('北北布次香菜 空过——菜地里的第一个回合。');
  } else if(t === 2){
    grant('us', 'warmachine');   // 战争机器：+1 指挥点槽
  } else if(t === 3){
    grant('us', 'warneed');      // 战争需要：+2 指挥点槽
  } else if(t === 4){
    grant('us', 'aswpatrol');    // 反潜巡逻：+3 指挥点槽，随机消灭 1 个敌方单位
  } else if(t === 5){
    grantProduce();              // 生产：+1 指挥点
    grantUnit('jp', 'n1k');      // 紫电 4/4 闪击伏击奋战（正常部署，占底线空位）
    grant('us', 'motivate');     // 激励部队：+3/+3
    grant('jp', 'blazing');      // 烈日：空军 +3 攻（本回合有效）
  }
  /* 出牌：按发放顺序，把手上的剧本卡里「付得起」的一张张正常打出 */
  const strongestOwn = () => {
    let best = null;
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const x = S.board[r][c];
      if(x && x.owner === 'a' && (!best || x.atk > best.u.atk)) best = { u:x, row:r, col:c };
    }
    return best;
  };
  for(let guard=0; guard<12 && !S.over; guard++){
    const list = (S.a.hand || []).filter(c => c && c._memeScript);
    const card = list.find(c => (c.blood||0) <= S.a.kredit);
    if(!card) break;
    if(card.kind === 'unit'){
      const slot = emptyBacklineSlot('a');
      if(!slot) break;                       // 无空位：留手等下一回合
      S.a.kredit -= (card.blood||0);
      S.a.hand.splice(S.a.hand.indexOf(card), 1);
      spawnUnit('a', card, slot.row, slot.col);
      checkEnemyDeployDmg('a', unitAt(slot.row, slot.col), slot.row, slot.col); // 玩家反制·无心漫谈照常生效
      logMsg('北北布次香菜 部署了 ' + card.n + '。');
      render(); await HOOKS.wait(650);
      continue;
    }
    let tgt = null;
    if(card.eff === 'motivate'){
      const best = strongestOwn();
      if(!best) break;                       // 无友方单位：贴膜无处可贴，留手
      tgt = { row: best.row, col: best.col };
    }
    S.a.kredit -= (card.blood||0);
    S.a.hand.splice(S.a.hand.indexOf(card), 1);
    const ok = orderEffect(card, tgt);
    if(!ok){ S.a.hand.push(card); S.a.kredit += (card.blood||0); break; }
    render(); await HOOKS.wait(600);
  }
  // 第 5 回合起：每回合猛攻玩家总部（奋战单位攻击两次；底线守护先清除）
  if(t >= 5 && !S.over) await memeAllOutAttack();
  if(S.over) return;
  // 结束回合（不摸牌、无士气伤害）
  settleCounters(S.p, S.pNation, '你的');
  clearSuppress('a');
  if(S.deployBlock && S.deployBlock.side === 'a') S.deployBlock = null;
  await HOOKS.wait(600);
  beginPlayerTurn();
}
/* Boss 二阶段：第一次被击败时重生（三位 Boss 各有一套）
   · 梦之泪伤：清场（前线+底线）→ 回 20 血 → 铺满底线+前线「F2A 水牛」+ 航母掩护 +1/+1 → 跳过敌方回合
   · 阿尔卑斯要塞：清空全场 → 回 20 血 → 指挥点槽锁定 10（每回合按前线归属执行两套行动之一）
   · 北北布次香菜：回 20 血 → 指挥点槽至少 10 → 牌堆获得 9 张随机「闪击·协力」日机（紫电除外）
     → 恢复抽牌 → 下个敌方回合把「最后一搏」加入手牌并打出 */
function bossRevive(kind){
  kind = kind || S.bossKind;
  S.bossLife = (S.bossLife || 1) + 1;
  S.bossRevived = true;
  /* ---------- 最终 Boss「hana」：三条命（用户 2026-09-16 口径） ---------- */
  if(kind === 'hana'){
    S.a._hqSilent = true;
    if(S.bossLife === 2){
      // 第二条命：恢复 20 血 + 恢复正常逻辑（重新抽牌）；指挥点槽**沿用当前值继续每回合 +3**（上限由 12 提到 24，
      // 不再一次性跳到 24 —— 用户 2026-09-16 削弱口径）
      S.a.hp = 20; S.a.maxHp = 20;
      S.a._hqSilent = false;
      HOOKS.onHqHpChange('a', 'set', 20, 20);
      S.a.hanaNoDraw = false;                    // 第一阶段的不抽牌到此结束
      S.a.slotLock = null;
      logMsg('hana 第一阶段被击穿——她不再只盯着科技树：恢复抽牌，总部 20 血，指挥点每回合 +3（上限提到 24）。');
    } else {
      // 第三条命：恢复 99 血 + **不再抽牌**（用户 2026-09-16）+ 弃掉所有手牌 + 5 张 SUPERMAN / 4 张 SUPERTANK（槽继续 +3，上限 24）
      S.a.hp = 99; S.a.maxHp = 99;
      S.a._hqSilent = false;
      HOOKS.onHqHpChange('a', 'set', 99, 99);
      S.a.hanaNoDraw = true;                     // 第三条命：封牌堆，只打手上这九张
      const thrown = (S.a.hand || []).length;
      S.a.hand = [];
      const granted = [];
      // 明牌：Boss 剧本写明「加入手牌」的九张也走 handPushRevealed（玩家能看见 hana 手上的威胁）
      for(let i=0;i<5;i++){ const d = mkUnitDef(BOSS_CARDS.SUPERMAN, 'us'); handPushRevealed(S.a, d); granted.push(d); }
      for(let i=0;i<4;i++){ const d = mkUnitDef(BOSS_CARDS.SUPERTANK, 'us'); handPushRevealed(S.a, d); granted.push(d); }
      logMsg('hana 第二条命被击穿——她把牌一推：弃掉 '+thrown+' 张手牌，总部 99 血，'
        +'摊开 5 张 SUPERMAN 与 4 张 SUPERTANK！');
      HOOKS.onBossGrant({ side:'a', cards: granted.map(d => ({ n:d.n, img:d.img })) });
    }
    HOOKS.onBossPhase2({ kind:'hana', life:S.bossLife });
    render();
    return true;
  }
  if(kind === 'alps'){
    // 清空全场（三行双方单位）
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ if(S.board[r][c]) killUnit(r,c); }
    S.a._hqSilent = true; S.a.hp = 20; S.a.maxHp = 20; S.a._hqSilent = false;
    HOOKS.onHqHpChange('a', 'set', 20, 20);
    // 指挥点槽锁定 10（每回合复位，被削减后同样回到 10）
    S.a.slotLock = 10; S.a.kreditSlots = 10; S.a.kredit = 10;
    S.alpsTurn = 0;
    logMsg('阿尔卑斯要塞 第一次被击穿——混凝土深处亮起红灯：全场清空，要塞重启（总部 20 血，指挥点槽锁定 10）！');
    HOOKS.onBossPhase2({ kind: 'alps' });
    render();
    return true;
  }
  if(kind === 'meme'){
    S.a._hqSilent = true; S.a.hp = 20; S.a.maxHp = 20; S.a._hqSilent = false;
    HOOKS.onHqHpChange('a', 'set', 20, 20);
    // 指挥点槽至少 10：保证下个回合付得起「最后一搏」（10 费）
    S.a.kreditSlots = Math.max(S.a.kreditSlots, 10);
    S.a.kredit = S.a.kreditSlots;
    // 牌堆获得 9 张随机日本飞机（紫电除外），每张赋予「闪击」与「协力」
    const pool = (NATIONS.jp.units || []).filter(u => (u.t === 'fighter' || u.t === 'bomber') && u.id !== 'n1k');
    const granted = [];
    for(let i=0;i<9 && pool.length;i++){
      const raw = pool[Math.floor(Math.random() * pool.length)];
      const d = mkUnitDef(raw, 'jp');
      d.sig = d.sig || [];
      if(d.sig.indexOf('blitz') < 0) d.sig.push('blitz');
      if(d.sig.indexOf('coop') < 0) d.sig.push('coop');
      S.a.deck.push(d);
      granted.push(d);
    }
    S.memeLastPush = true; // 下个敌方回合：手牌加入并打出「最后一搏」
    // 恢复抽牌功能：先补一手 6 张开局手牌（此后每回合正常摸牌）
    drawCards(S.a, 6, true);
    logMsg('北北布次香菜 第一次被击倒——她从土里爬起来：总部回复 20 血，牌堆里多出 9 架「闪击·协力」日机（紫电除外），她重新开始抽牌！');
    HOOKS.onBossPhase2({ kind: 'meme' });
    HOOKS.onBossGrant({ side: 'a', cards: granted.map(d => ({ n: d.n, img: d.img })) });
    render();
    return true;
  }
  // 梦之泪伤（原逻辑）
  // 消灭前线（第1行，双方单位）和自己底线（第0行）所有单位
  for(const r of [0,1]) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x) killUnit(r,c); }
  // 总部回复到 20 血（直接更改 → 白色）
  S.a._hqSilent = true; S.a.hp = 20; S.a.maxHp = 20; S.a._hqSilent = false;
  HOOKS.onHqHpChange('a', 'set', 20, 20);
  // 底线 + 前线铺满「F2A 水牛」（两行共 10 格）
  let placed = 0;
  for(let r=0;r<2;r++) for(let c=0;c<COLS;c++){ if(!S.board[r][c] && spawnUnit('a', makeDerived('f2a'), r, c)) placed++; }
  // 打出航母掩护·抉择1：友方战斗机 +1/+1
  let n = 0;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x=S.board[r][c]; if(x && x.owner==='a' && x.def.t==='fighter'){ x.atk += 1; x.maxHp += 1; x.hp += 1; n++; } }
  logMsg('梦之泪伤 第一次被击败——泪水凝成钢翼，'+placed+' 架「F2A 水牛」铺满战场（航母掩护 +1/+1）！');
  S.bossSkipNext = true; // 跳过接下来的敌方回合
  HOOKS.onBossPhase2({ kind: 'tears' });
  render();
  return true;
}
/* Boss 一阶段（梦之泪伤）：每回合在支援阵线凝结 1 架「F2A 水牛」
   （优先选择前线空出的列，落地后由 AI 推进逻辑优先抢占前线） */
function tearsReinforce(){
  const slots = [];
  for(let c=0;c<COLS;c++){ if(!S.board[0][c]) slots.push({ row:0, col:c, front:!S.board[1][c] }); }
  if(!slots.length){ logMsg('梦之泪伤：支援阵线已满，泪水无处凝结。'); render(); return false; }
  slots.sort((a,b) => (b.front ? 1 : 0) - (a.front ? 1 : 0));
  const slot = slots[0];
  spawnUnit('a', makeDerived('f2a'), slot.row, slot.col);
  logMsg('梦之泪伤 的泪光凝成 1 架「F2A 水牛」（支援阵线；优先抢占前线）。');
  render();
  return true;
}
/* 阿尔卑斯要塞 二阶段：每回合按前线归属执行两套行动之一
   ① 前线无敌方单位 → 加入并打出「第20装甲掷弹兵团」与「35(t)坦克」，贴上「协同作战」，
      随后全体可行动单位攻击玩家总部（守护优先清除）；
   ② 前线有敌方单位 → 加入并打出 2 张「第7步枪兵团」，先消灭玩家前线单位，再抢占前线。
   剧本卡只是发放到手上、按正常费用打出（玩家反制照常生效——可以影响她）。 */
async function alpsSpecialTurn(){
  S.alpsTurn = (S.alpsTurn || 0) + 1;
  if(S.a.slotLock != null) S.a.kreditSlots = S.a.slotLock; // 指挥点槽锁定 10（被削减后复位）
  S.a.kredit = S.a.kreditSlots;
  const grantUnit = (key, id) => {
    const raw = NATIONS[key] && NATIONS[key].units.find(u => u.id === id);
    if(!raw) return null;
    const c = mkUnitDef(raw, key); c._alpsScript = true;
    if(S.a.hand.length < MAX_HAND) S.a.hand.push(c); else S.a.deck.push(c);
    return c;
  };
  const grantOrder = (key, id) => {
    const raw = NATIONS[key] && NATIONS[key].orders.find(o => o.id === id);
    if(!raw) return null;
    const c = mkOrderDef(Object.assign({}, raw, { nation:key }), key); c._alpsScript = true;
    if(S.a.hand.length < MAX_HAND) S.a.hand.push(c); else S.a.deck.push(c);
    return c;
  };
  /* 按发放顺序把手上的剧本卡里「付得起」的一张张正常打出 */
  const playScripts = async () => {
    for(let guard=0; guard<10 && !S.over; guard++){
      const list = (S.a.hand || []).filter(c => c && c._alpsScript);
      const card = list.find(c => (c.blood||0) <= S.a.kredit);
      if(!card) break;
      if(card.kind === 'unit'){
        const slot = emptyBacklineSlot('a');
        if(!slot) break;                        // 无空位：留手等下一回合
        S.a.kredit -= (card.blood||0);
        S.a.hand.splice(S.a.hand.indexOf(card), 1);
        spawnUnit('a', card, slot.row, slot.col);
        checkEnemyDeployDmg('a', unitAt(slot.row, slot.col), slot.row, slot.col); // 玩家反制·无心漫谈照常生效
        logMsg('阿尔卑斯要塞 部署了 ' + card.n + '。');
        render(); await HOOKS.wait(650);
        continue;
      }
      let tgt = null;
      if(card.eff === 'coopOp'){
        // 协同作战：贴给己方攻击力最高的坦克
        let best = null;
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
          const x = S.board[r][c];
          if(x && x.owner === 'a' && x.def.t === 'tank' && (!best || x.atk > best.u.atk)) best = { u:x, row:r, col:c };
        }
        if(!best) break;                        // 无坦克可贴：留手
        tgt = { row: best.row, col: best.col };
      }
      S.a.kredit -= (card.blood||0);
      S.a.hand.splice(S.a.hand.indexOf(card), 1);
      const ok = orderEffect(card, tgt);
      if(!ok){ S.a.hand.push(card); S.a.kredit += (card.blood||0); break; }
      render(); await HOOKS.wait(700);
    }
  };
  /* 找一个底线可行动的己方单位（用于推进前线）；坦克优先——推进后仍可攻击总部 */
  const findMover = () => {
    const cands = [];
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const u = S.board[r][c];
      if(u && u.owner === 'a' && r !== 1 && canAct(u) && !u.movedThisTurn) cands.push({ r:r, c:c, tank: u.def.t === 'tank' ? 1 : 0 });
    }
    cands.sort((a,b) => b.tank - a.tank);
    return cands[0] || null;
  };
  const frontHeld = S.board[1].some(x => x && x.owner === 'p');
  if(!frontHeld){
    grantUnit('de', 'r20');   // 第20装甲掷弹兵团（5 费 3/4 闪击）
    grantUnit('de', 'pz35');  // 35(t)坦克（2 费 2/2 闪击）
    grantOrder('de', 'coopop'); // 协同作战（1 费：友方坦克 +N/+N）
    logMsg('阿尔卑斯要塞：前线没有敌人——装甲掷弹兵与坦克驶出闸门，协同作战！');
    render(); await HOOKS.wait(800);
    if(S.over) return;
    await playScripts();
  } else {
    grantUnit('de', 'r7');
    grantUnit('de', 'r7');    // 第7步枪兵团 ×2（4 费 4/5 闪击）
    logMsg('阿尔卑斯要塞：前线被敌人占据——两支「第7步枪兵团」奉命夺回阵地！');
    render(); await HOOKS.wait(800);
    if(S.over) return;
    await playScripts();
    // 消灭玩家前线单位
    for(let c=0;c<COLS && !S.over;c++){
      const x = S.board[1][c];
      if(!x || x.owner !== 'p') continue;
      let attacker = null;
      for(let r=0;r<ROWS && !attacker;r++) for(let c2=0;c2<COLS && !attacker;c2++){
        const u = S.board[r][c2];
        if(!u || u.owner !== 'a' || !canAct(u)) continue;
        if(attackTargets('a', r, c2).some(t => !t.hq && t.row === 1 && t.col === c)) attacker = { u:u, r:r, c:c2 };
      }
      if(!attacker) continue;
      logMsg('阿尔卑斯要塞：' + attacker.u.def.n + ' 猛攻前线的 ' + x.def.n + '！');
      combat({ row:attacker.r, col:attacker.c }, { row:1, col:c });
      render(); await HOOKS.wait(700);
    }
  }
  // 抢占前线：前线没有玩家单位时，把底线单位推进前线（坦克推进后仍能攻击总部；
  // 步兵推进后本回合不能再攻击，但会占住前线形成压力）
  for(let guard=0; guard<COLS && !S.over; guard++){
    if(S.board[1].some(x => x && x.owner === 'p')) break; // 玩家仍占据前线
    if(S.board[1].every(x => !!x)) break;                 // 前线已满
    const mv = findMover();
    if(!mv) break;
    if(!moveForward('a', mv.r, mv.c)) break;
    render(); await HOOKS.wait(500);
  }
  // 全体可行动单位攻击：能直击总部就打总部，否则先清守护
  for(let r=0;r<ROWS && !S.over;r++) for(let c=0;c<COLS && !S.over;c++){
    const u = S.board[r][c];
    if(!u || u.owner !== 'a' || !canAct(u)) continue;
    const tgts = attackTargets('a', r, c);
    if(!tgts.length) continue;
    const t = tgts.some(x => x.hq) ? { hq:true }
            : (tgts.find(x => !x.hq && hasSig(unitAt(x.row, x.col), 'guard')) || tgts[0]);
    combat({ row:r, col:c }, t);
    render(); await HOOKS.wait(600);
  }
  if(S.over) return;
  settleCounters(S.p, S.pNation, '你的');
  clearSuppress('a');
  if(S.deployBlock && S.deployBlock.side === 'a') S.deployBlock = null;
  await HOOKS.wait(600);
  beginPlayerTurn();
}
/* Boss 三阶段：重生后的每一敌方回合——弃光手牌 → 虚空印卡（山本五十六/烈日/逆光攻击）→ 全体水牛总攻（先灭守护） */
async function bossSpecialTurn(){
  if(S.bossSkipNext){
    S.bossSkipNext = false;
    logMsg('梦之泪伤 沉默地擦干泪水，跳过此回合。');
    render(); await HOOKS.wait(900);
    settleCounters(S.p, S.pNation, '你的');
    clearSuppress('a');
    if(S.deployBlock && S.deployBlock.side === 'a') S.deployBlock = null;
    await HOOKS.wait(600);
    beginPlayerTurn();
    return;
  }
  // 失去所有手牌
  S.a.hand = [];
  logMsg('梦之泪伤 的泪光点燃牌堆——手牌尽数燃尽，虚空印卡！');
  // 虚空印卡按顺序打出：山本五十六 → 烈日 → 逆光攻击（无论卡组有没有）
  // 每张间隔 1 秒，让玩家看清贴膜（打出动画）
  const voidPrint = (key, id) => {
    const raw = NATIONS[key] && NATIONS[key].orders.find(o=>o.id===id);
    if(raw) orderEffect(mkOrderDef(Object.assign({}, raw, { nation:key }), key), null);
  };
  voidPrint('jp','yamamoto');
  await HOOKS.wait(1000);
  voidPrint('jp','blazing');
  await HOOKS.wait(1000);
  voidPrint('jp','backlight');
  render(); await HOOKS.wait(1000);
  if(S.over) return;
  // 全体水牛攻击玩家总部（前提：先消灭底线守护）
  const buffs = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const u=S.board[r][c]; if(u && u.owner==='a' && u.def.id==='f2a') buffs.push({u,r,c}); }
  buffs.sort((a,b)=> (a.r===1?1:0) - (b.r===1?1:0)); // 前线水牛先动
  for(const at of buffs){
    if(S.over) break;
    if(!canAct(at.u)) continue;
    const tgts = attackTargets('a', at.r, at.c);
    if(!tgts.length) continue;
    let t = null;
    if(tgts.some(x=>x.hq)){
      t = {hq:true}; // 底线守护已清：直击总部
    } else {
      // 前提消灭守护：先攻击守护单位，其次任意可及目标
      t = tgts.find(x=>!x.hq && hasSig(unitAt(x.row,x.col),'guard')) || tgts[0];
    }
    combat({row:at.r, col:at.c}, t);
    render(); await HOOKS.wait(600);
  }
  if(S.over) return;
  settleCounters(S.p, S.pNation, '你的');
  clearSuppress('a');
  if(S.deployBlock && S.deployBlock.side === 'a') S.deployBlock = null;
  await HOOKS.wait(600);
  beginPlayerTurn();
}
function endGame(winner){
  // Boss 挑战多命：被击败一次不结束对局，触发下一阶段重生（hana 三条命，其余两条命）
  if(winner === 'p' && S.bossMode && S.bossKind && (S.bossLife || 1) < bossLives(S.bossKind)){ bossRevive(S.bossKind); return; }
  S.over = true; S.phase = 'over'; S.mode = null;
  S.mulliganPending = false; // 对局结束：换牌窗口随引擎标志关闭（UI 随渲染隐藏）
  HOOKS.onHqExplode({ side: winner === 'p' ? 'a' : 'p' }); // 失败方总部爆炸（UI 专属，无头下 no-op）
  if(winner === 'p'){ S.wins++; } else { S.losses++; }
  HOOKS.onSfx(winner === 'p' ? 'win' : 'lose');
  HOOKS.onGameEnd(winner); // UI 专属：结算面板/覆盖层（无头下 no-op）
  render();
}
function resetGameState(){
  S.turn = 0; S.phase = 'idle'; S.mode = null; S.over = false; S.log = [];
  S.deployBlock = null;
  S.guard216Pending = false;
  S.pendingChoice = null;
  S.gordonPick = false;      // 戈登高人团：等待点击浮起的指令（不属于抉择面板）
  S.mulliganPending = false;   // 首回合换牌窗口（玩家可多选换牌或全部保留）
  S.bossKind = BOSS_KIND;      // Boss 挑战：UI 在 startGame 前 setBossKind（每局从全局读入）
  S.bossMode = !!BOSS_KIND;
  S.bossRevived = false;
  S.bossLife = 1;              // 最终 Boss「hana」：三条命计数（其余 Boss 两条命即结束；不再抽牌标记在 S.a.hanaNoDraw）
  S.bossSkipNext = false;
  S.alpsOpened = false;        // 阿尔卑斯要塞：开局脚本每局只执行一次
  S.alpsTurn = 0;              // 阿尔卑斯要塞：二阶段脚本回合计数
  S.memeTurn = 0;              // 北北布次香菜：固定行动回合计数
  S.memeLastPush = false;      // 北北布次香菜：二阶段下个回合加入并打出「最后一搏」
  S.board = mkBoard();
B1_LAST_DEAD_ARMY = null; // 伊尔-10：新的一局，清空「上一个被消灭的友方陆军」记录
  // v2：卡组覆盖（组卡/战役自定义；未设置 = 原版卡组）
  S.p = makeHqProxy(newPlayer(buildDeck(S.pNation, DECK_OVERRIDE.p || undefined)), 'p');
  S.a = makeHqProxy(newPlayer(buildDeck(S.aNation, DECK_OVERRIDE.a || undefined)), 'a');
  // 削弱 AI：不再补偿 +1 指挥点槽（开局同样只有 1 槽，改为开局 6 张牌补偿，见 startGame）
}
function startGame(){
  resetGameState();
  // v2 规则钩子：双方 HQ 生命加成（默认 0/0 = 原行为；extra_draw 每回合触发，见 startAiTurn）
  // 首回合玩家：4 张卡组牌 + 1 张生产（均不算抽取；生产来自生产牌堆，不进换牌窗口）
  drawCards(S.p, 4, true);
  if(S.p.prodDeck.length){ S.p.hand.push(S.p.prodDeck.pop()); }
  // 北北布次香菜：不携带卡牌、不抽牌（空卡组摸牌会疲劳，跳过开局发牌）
  if(S.bossKind === 'hana'){
    // 最终 Boss「hana」（用户 2026-09-16 二次口径）：
    // 第一阶段 = 五国研发起手 + **不抽牌** + 指挥点槽 **24**；第二阶段起恢复正常逻辑（见 bossRevive）
    const RESEARCH5 = [['de','德意志帝国研发'], ['us','美国军事研发'], ['gb','皇家研发'], ['jp','帝国研发'], ['su','苏联军事研发']];
    S.a.hand = RESEARCH5.map(([key, id]) => {
      const raw = NATIONS[key] && NATIONS[key].orders.find(o => o.id === id);
      return raw ? mkOrderDef(Object.assign({}, raw, { nation:key }), key) : null;
    }).filter(Boolean);
    S.a.hanaTurns = 0;
    // 槽位增长机制（用户 2026-09-16 定稿·削弱 hana）：**每回合 +3 点**，第一回合 3 点；
    // 第一阶段上限 12、第二阶段起上限 24（沿用当前槽数继续 +3，不重置回 3）。
    // 实际增长在 startAiTurn 的 hana 分支里按 3 × 她的回合数算（指令带来的额外槽不被拉回）。
    S.a.kreditSlots = 3; S.a.kredit = 3;   // 她第一次行动时就是 3 点
    S.a.hanaNoDraw = true;          // 第一阶段不抽牌（startAiTurn 的摸牌段会拦下）
    logMsg('hana 摊开五张研发：德意志、美国、皇家、帝国、苏联——第一阶段她不抽牌，指挥点每回合 +3（上限 12）。');
  } else if(S.bossKind !== 'meme') drawCards(S.a, 6, true); // 削弱 AI：开局 6 张牌（原 +1 指挥点槽补偿改为牌数补偿）
  // 近卫步兵第4团「敌方每抽 1 张牌 -1 花费」：开局发牌也走 drawCards，但开局手牌不是「抽牌」（与
  // doMulligan「换牌补抽仍属开局手牌，不算抽取」同口径）→ 发完牌后把本局累计抽牌数清零，否则开局就白减。
  S.p.totalDraws = 0; S.a.totalDraws = 0;
  S.mulliganPending = true; // 首回合换牌：屏幕正中窗口显示 4 张卡组牌，可多选换牌/不换
  const hb = GAME_RULES.hqHpBonus || {};
  if(hb.p){ S.p._hqSilent = true; S.p.hp += hb.p; S.p.maxHp += hb.p; S.p._hqSilent = false; HOOKS.onHqHpChange('p', 'set', 20 + hb.p, 20 + hb.p); }
  if(hb.a){ S.a._hqSilent = true; S.a.hp += hb.a; S.a.maxHp += hb.a; S.a._hqSilent = false; HOOKS.onHqHpChange('a', 'set', 20 + hb.a, 20 + hb.a); }
  logMsg('你以 ' + nationOf('p').name + ' 的名义出征，对面是老牧师统帅的 ' + nationOf('a').name + '。');
  beginPlayerTurn();
}
function resetUnitFlags(side){
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(u){
      u.attackedN = 0; u.movedThisTurn = false; u.summonedThisTurn = false; u.ambushUsed = false; u.interceptUsed = false;
      if(u.surged){ u.atk -= 1; u.surged = false; u.def.sig = (u.def.sig||[]).filter(s=>s!=='fight'); }
      // 山本五十六：本回合空军 +1 攻/闪击，回合结束还原（只移除本次添加的闪击，不误删原卡闪击）
      if(u.yamamoto){
        u.atk -= 1; u.yamamoto = false;
        if(u.yamamotoBlitz){ u.yamamotoBlitz = false; u.def.sig = (u.def.sig||[]).filter(s=>s!=='blitz'); }
      }
      // 九七式战：被攻击单位失去守护直到回合结束
      u.guardLost = false;
      // 游击队：本回合伤害记录清空
      u.damagedBy = [];
    }
  }
}
/* 九九式袭击机（ki61Auto）被动：敌方回合结束时，若在手牌且拥有者指挥点≥7，
   自动消耗 7 指挥点部署到己方支援阵线随机空位（多个 ki61 只部署 1 张）。 */
function checkKi61Auto(side){
  const me = playerOf(side);
  if(!me || deployBlocked(side)) return;
  const card = me.hand.find(c => c.kind==='unit' && (c.fx||[]).includes('ki61Auto'));
  if(!card || me.kredit < 7) return;
  const slot = emptyBacklineSlot(side);
  if(!slot) return;
  me.kredit -= 7;
  const idx = me.hand.indexOf(card); if(idx>-1) me.hand.splice(idx,1);
  spawnUnit(side, card, slot.row, slot.col);
  checkEnemyDeployDmg(side, unitAt(slot.row, slot.col), slot.row, slot.col); // 反制·无心漫谈（手牌自动部署也算部署）
  logMsg(card.n + ' 自动部署到支援阵线（-7 指挥点）。');
  sfx('place'); render();
}
/* 近卫步兵第216团（guard216）：友方回合开始时自伤友方总部 2 点并抽 1 张；
   累计触发两次后升为老兵（就地转换 def 为老兵形态、重置数值、友方全体与总部 +3 防御）。 */
function checkGuard216(side){
  const me = playerOf(side);
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner!==side || !hasFx(u,'guard216')) continue;
    me.hp -= 2;
    logMsg(u.def.n + ' 自损：友方总部受到 2 点伤害');
    checkGameOver();
    if(S.over) return;
    drawCards(me, 1);
    u.promoCount = (u.promoCount||0) + 1;
    if(u.promoCount >= 2) promoteVeteran(side, u);
  }
}
/* 群解（多目标同时伤害）：第一阶段全部扣血（不处理死亡），第二阶段统一处理死亡——
   亡计等触发时只看到真正的存活者（如：冬季战争能清掉阿尔卑斯要塞的 1 血步兵，亡计不会救活将死单位） */
function massDamage(units, dmgOf){
  let n = 0;
  const hits = [];
  for(const u of units){
    if(!u) continue;
    const dmg = typeof dmgOf === 'function' ? dmgOf(u) : dmgOf;
    if(dmg <= 0) continue;
    u.hp -= dmg;
    if(hasFx(u,'onDamagedDraw')){ drawCards(playerOf(u.owner), 1); logMsg(u.def.n+' 受到伤害：抽 1 张牌'); }
    hits.push(u);
    n++;
  }
  for(const u of hits){
    if(u.hp <= 0){ const p = findPosOf(u); if(p) killUnit(p.r, p.c); }
  }
  return n;
}
/* 第7步枪兵团：攻击并消灭 1 个单位时升为老兵（就地转换，5/5，词条：老兵，不再带 r7Vet）；
   升为老兵时的 3 点总部伤害由调用点（combat 击杀分支）结算 */
function promoteR7(u){
  const vet = { kind:'unit', id:'r7', n:'第7步枪兵团（老兵）', t:'infantry', blood:4, fuel:1,
    atk:5, hp:5, sig:['veteran'], armor:0, fx:[],
    img:'卡牌/德/第7步枪兵团（老兵）.png', nation:u.def.nation,
    desc:'升为老兵时，对敌方总部造成 3 点伤害' };
  u.def = vet;
  u.atk = 5; u.maxHp = 5; u.hp = 5; u.armor = 0;
  sfx('vet'); // 升老兵音效（UI 专属，无头下 no-op）
}
function promoteVeteran(side, u){  const vet = { kind:'unit', id:'r216', n:'近卫步兵第216团（老兵）', t:'infantry', blood:3, fuel:1,
    atk:3, hp:6, sig:['veteran','guard'], armor:0, fx:[],
    img:'卡牌/苏/近卫步兵第216团（老兵）.jpg', nation:u.def.nation,
    desc:'经历过两次血战的近卫步兵，守护友军与总部（老兵形态不再自伤）。' };
  u.def = vet;
  u.atk = 3; u.maxHp = 6; u.hp = 6; u.armor = 0;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const x = S.board[r][c];
    if(x && x.owner===side && x!==u){ x.maxHp += 3; x.hp += 3; }
  }
  playerOf(side).maxHp += 3;
  playerOf(side).hp += 3;
  sfx('vet'); // 升老兵音效（UI 专属，无头下 no-op）
  logMsg(u.def.n + ' 升为老兵！友方单位与总部 +3 防御力。');
}
/* ---------- 老兵形态就地转换（通用；本批 5 张老兵卡） ----------
   与 promoteR7/promoteVeteran 是同一套机制：老兵形态与本体是同一张卡，不进卡池，
   满足条件后就地替换 def（换名字/数值/词条/卡图）并重置基础值快照。
   模板见 cards.js 的 VETERAN_FORMS（键 = 本体卡名）；老兵形态卡名不在表内 → 不再转换。 */
function promoteToVeteran(u){
  if(!u || !u.def) return false;
  const form = (typeof VETERAN_FORMS !== 'undefined') ? VETERAN_FORMS[u.def.n] : null;
  if(!form) return false;
  const vet = mkUnitDef(form, u.def.nation);
  u.def = vet;
  u.atk = vet.atk; u.maxHp = vet.hp; u.hp = vet.hp; u.armor = vet.armor;
  u.baseAtk = vet.atk; u.baseMaxHp = vet.hp; u.baseFuel = vet.fuel || 0; // 抑制/重置按老兵形态的基础值
  sfx('vet'); // 升老兵音效（UI 专属，无头下 no-op）
  logMsg(vet.n + ' 升为老兵！');
  /* 老兵形态自带的登场效果（写在该形态定义上，例：近卫机械化第12旅（老兵）＝「升为老兵时，抽2张牌」
     —— 口径见 卡牌/苏/文档.txt，用户手补，勿覆盖） */
  if(hasFx(u,'vetDraw2')){
    drawCards(playerOf(u.owner), 2);
    logMsg(vet.n + '：升为老兵时抽 2 张牌。');
  }
  return true;
}
/* 场上是否存在具有指定卡 id 的其他友方单位（老兵形态沿用本体 id → 本体与老兵互认） */
function allyWithId(side, id, excl){
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const x = S.board[r][c];
    if(x && x.owner===side && x!==excl && x.def && x.def.id === id) return x;
  }
  return null;
}
/* 近卫机械化第12旅：攻击力不小于 4 的友方坦克部署时，升为老兵（监听标记 vetTank12 由部署效果挂上） */
function checkTank12Veteran(side, deployed){
  if(!deployed || !deployed.def || deployed.def.t !== 'tank') return 0;
  if(!(deployed.hp > 0) || atkOf(deployed) < 4) return 0;
  let n = 0;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const x = S.board[r][c];
    if(x && x.owner===side && x!==deployed && hasFx(x,'vetTank12')){
      logMsg('近卫机械化第12旅：攻击力 ' + atkOf(deployed) + ' 的 ' + deployed.def.n + ' 部署，升为老兵！');
      if(promoteToVeteran(x)) n++;
    }
  }
  return n;
}
/* 反制·第一响应（英）：敌方回合结束时，将 1 个「第5步兵旅」加入支援阵线；
   若敌方单位数不小于 3，使其获得 +3/+3（触发即消耗；支援阵线已满则本次不触发）。
   加入的单位当回合不能行动：回合开始的 resetUnitFlags 会清掉落地标记，
   故记入 summonHold，由 applySummonHold 在 resetUnitFlags 之后回补。 */
function firstResponseArmed(side){
  const me = playerOf(side);
  return !!((me.counters||[]).includes('第一响应')) && !me.counterHit['第一响应'];
}
function resolveFirstResponse(side){
  if(!firstResponseArmed(side)) return false;
  const me = playerOf(side);
  const slot = emptyBacklineSlot(side);
  if(!slot){ logMsg('反制·第一响应：支援阵线已满，无法加入「第5步兵旅」。'); return false; }
  const raw = mkByName('gb', '第5步兵旅');
  if(!raw) return false;
  if(!spawnUnit(side, mkUnitDef(raw, 'gb'), slot.row, slot.col)) return false;
  const u = unitAt(slot.row, slot.col);
  const buffed = countEnemy(side) >= 3;   // 敌方单位数不小于 3
  if(buffed && u){ u.atk += 3; u.hp += 3; u.maxHp += 3; }
  me.summonHold = u || null;
  me.counterHit['第一响应'] = true;
  if(side === 'p') consumePlayerCounter('第一响应');
  else { S.a.counters = S.a.counters.filter(e => e !== '第一响应'); emitCounterFx('a', '第一响应'); }
  logMsg('反制·第一响应：1 个「第5步兵旅」加入' + (side === 'p' ? '你的' : '敌方') + '支援阵线'
    + (buffed ? '，并获得 +3/+3（敌方单位数不小于 3）。' : '。'));
  render();
  return true;
}
/* 回补「回合切换瞬间加入的单位」的落地标记（见 resolveFirstResponse） */
function applySummonHold(side){
  const me = playerOf(side);
  if(me.summonHold){ me.summonHold.summonedThisTurn = true; me.summonHold = null; }
}
/* 抑制（规则.txt）：被抑制的单位失去所有关键词和效果，同时重置其攻击力、最大防御力以及行动花费；
   免疫抑制的单位不受影响（如 T-34-85）。供施加抑制效果的卡牌调用。 */
function applyInhibit(u){
  if(!u) return false;
  if(hasFx(u,'inhibitImmune')){ logMsg(u.def.n + ' 免疫抑制，不受影响'); return false; }
  u.inhibited = true;
  u.def.sig = [];
  u.def.fx = [];
  u.atk = (u.baseAtk != null) ? u.baseAtk : u.def.atk;
  u.maxHp = (u.baseMaxHp != null) ? u.baseMaxHp : u.def.hp;
  u.hp = Math.min(u.hp, u.maxHp);
  u.def.fuel = (u.baseFuel != null) ? u.baseFuel : (u.def.fuel||0);
  // 牛奶口径（用户 2026-09-13）：抑制 = 清除单位身上的所有增益与 debuff 标记，
  // 连同「挂在单位对象（而非 def）上」的记账一起清掉（def.fx 已在上面整体清空，覆盖 fx 类标记）。
  u.ignoreNoHq = false;                            // 新式战法：恢复「无法攻击敌方总部」限制
  u.alsoTank = false;                              // 袋鼠运输「也算作是坦克」（挂 def.fx 的那份已被 fx 清空覆盖）
  u.fuelOverride = null;                           // 皇家燧发枪团：攻/油互换的行动花费覆盖值
  u.armor = 0;                                     // 袋鼠运输的 +1 重甲等（def.armor 不在此重置：抑制清 buff，不删卡面固有装甲）
  const owner = u.owner ? playerOf(u.owner) : null; // u.owner 取不到就跳过 owner 段
  if(owner){
    if(Array.isArray(owner.yusuiUnits)) owner.yusuiUnits = owner.yusuiUnits.filter(x => x !== u);          // 玉碎：不再回合末被消灭
    if(Array.isArray(owner.lastStrikeUnits)) owner.lastStrikeUnits = owner.lastStrikeUnits.filter(x => x !== u); // 最后一击：不再回合末被消灭
  }
  logMsg(u.def.n + ' 被抑制：失去所有关键词与效果，属性重置（增益与标记一并清除）。');
  return true;
}
/* 压制：所有者下个回合结束时移除 */
function clearSuppress(side){  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const u = S.board[r][c]; if(u && u.owner===side) u.suppressed = false; }
}
function beginPlayerTurn(){
  if(S.over) return;
  S.phase = 'player'; S.mode = null;

  S.a.drawBanned = false;
  if(S.p.drawBanPending > 0){ S.p.drawBanPending--; S.p.drawBanned = true; logMsg('豹式坦克A型：敌方效果——你本回合无法抽牌。'); }
  else S.p.drawBanned = false;
  S.turn++;
  // 反制·第一响应：触发点是「敌方回合结束」，必须先于下方「迎敌失效」结算（否则挂载的反制已过期）；
  // 加入单位的落地标记由 applySummonHold（resetUnitFlags 之后）回补
  resolveFirstResponse('p');
  // 挂着的反制时效：到下一个友方回合自动失效（不退还指挥点；想再次迎敌需重新激活）
  (function(){
    const armed = (S.p.hand || []).filter(c => c && c.kind === 'counter' && c.armed);
    armed.forEach(c => {
      c.armed = false;
      S.p.counters = (S.p.counters || []).filter(e => e !== c.eff);
      logMsg('「' + c.n + '」迎敌失效（指挥点不退）；下回合重新点击即可再次激活。');
    });
  })();
  triggerFriendlyTurnEnd('a'); // 步兵第25团/Me 163彗星（AI）：敌方回合结束=友方回合结束，先结算再重置落地标记
  resolveSecondFront('p'); // 第二战线：敌方回合结束时，返回并复制被移除的友方单位
  resetUnitFlags('p');
  applySummonHold('p'); // 第一响应加入的「第5步兵旅」：落地标记回补（当回合不能行动）
  clearTurnBuffs('a'); // 敌方「本回合」特效在其回合结束时即失效（不延续到你的回合）
  resolveBridgeTooFar('p'); // 遥远的桥：敌方（AI）回合结束，结算玩家侧
  // 九九式袭击机：敌方回合结束时检查手牌自动部署（用敌方回合结束时的指挥点判断）
  checkKi61Auto('p');
  S.p.kreditSlots = (S.p.kreditSlots < 12) ? S.p.kreditSlots + 1 : S.p.kreditSlots; // 自然增长仅在槽<12时+1；指令带来的>12槽不被拉回
  // 指挥点 = 槽数（不保留上回合）；「槽-1」规则已由 startGame 预置到槽本身，此处不再加偏移
  S.p.kredit = Math.max(0, S.p.kreditSlots);
  // 216团特效延后到玩家摸牌完成后触发（hideDrawChoice），避免特效先于玩家摸牌
  S.guard216Pending = true;
  // 本回合临时增益（拂晓/烈日/逆光）在新回合开始清零
  S.p.airFuel0 = false; S.p.airFuelMinus1 = false; S.p.airAtk3 = false; S.p.airAtk2 = false; S.p.blazingUsed = false;
  S.p.patton = false;            // 巴顿增益只持续本回合
  // （第85先锋连「第一张指令 -1」不在此缓存：playCost 现算，见该处注释）
  S.p.coopNations = collectNations('p'); // 协力：回合开始时友方单位国家快照
  resolveOwnerTurnStart('p'); // 卫戍/物资短缺/高潮迭起/前线观察员：回合开始被动
  logMsg('—— 你的回合（第 ' + S.turn + ' 回合，指挥点 ' + S.p.kredit + '）——');
  render();
  if(S.turn === 1){
    // 玩家首回合不再摸牌：直接结算回合开始特效（216团/战争债券）
    resolveTurnStartEffects();
  } else {
    showDrawChoice();
  }
}
function showDrawChoice(){
  if(S.over) return;
  if(S.p.drawBanned){ logMsg('豹式坦克A型：你本回合无法抽牌（摸牌阶段跳过）。'); hideDrawChoice(); return; }
  // 生产牌堆与卡组都空：自动疲劳抽牌，避免卡死
  if(S.p.prodDeck.length === 0 && S.p.deck.length === 0){
    drawCards(S.p, 1);
    hideDrawChoice();
    return;
  }
  S.drawPending = true;
  render(); // 摸牌面板 DOM 由 UI 层按 S.drawPending 渲染
}
function hideDrawChoice(atTurnStart){
  S.drawPending = false;
  // 注意：endPlayerTurn 也会调到这里（只为关掉摸牌面板 + 重绘），那时**不是**回合开始，
  // 凡是「下个回合开始时」的延迟效果都必须跳过，否则会在本回合结束时提前结算（合成机油 10 点被刷新吞掉）。
  resolveTurnStartEffects(atTurnStart !== false);
  render();
}
/* 玩家摸牌完成后的回合开始特效（216团自伤抽牌 / 战争债券额外抽牌 / 合成机油延迟指挥点）
   atTurnStart=false（endPlayerTurn 的收尾调用）→ 一律不结算，等真正的新回合开始 */
function resolveTurnStartEffects(atTurnStart){
  if(atTurnStart === false) return;
  const S_ = S;
  if(S.guard216Pending){ S.guard216Pending = false; checkGuard216('p'); }
  if(S.p.extraDrawNext > 0){ const n = S.p.extraDrawNext; S.p.extraDrawNext = 0; drawCards(S.p, n); logMsg('战争债券：额外抽 ' + n + ' 张牌。'); }
  resolveOilPending('p');    // 合成机油：下个回合开始时给 10 点指挥点并抽牌（用户 2026-09-16：时间线修正到新回合开始）
  r2ClearHqSmoke('p');       // 深水炸弹：总部烟幕到本回合开始
  // 霍尔姆第99团：下个友方回合开始时失去 1 个指挥点（此时指挥点已是本回合刷新后的值）
  if(S.p.pendingKreditLoss > 0){
    const n = S.p.pendingKreditLoss;
    S.p.pendingKreditLoss = 0;
    S.p.kredit = Math.max(0, S.p.kredit - n);
    logMsg('霍尔姆第99团：失去 ' + n + ' 个指挥点（当前 ' + S.p.kredit + '）。');
  }
  // 方面军（苏）：友方回合开始时受 1 点伤害，并加入 1 个「T-34 1942」
  if(S.p.frontArmy){
    S.p.hp -= 1;
    logMsg('方面军：友方回合开始，总部受到 1 点伤害。');
    checkGameOver();
    const def = mkUnitDef(NATIONS.su.units.find(u => u.id === 't34'), 'su');
    const br = backRowOf('p');
    let placed = null;
    for(let c=0;c<COLS;c++) if(!S.board[br][c]){ if(spawnUnit('p', def, br, c)){ placed = S.board[br][c]; break; } }
    if(placed){ S.p.frontArmyTanks = (S.p.frontArmyTanks || []).concat([placed]); logMsg('方面军：1 个「T-34 1942」加入支援阵线（回合结束时消灭）。'); }
  }
}
/* 反制结算：AI 反制触发消耗 / 未触发返还；玩家反制常驻（激活保留到触发或手动收回） */
function settleCounters(owner, nationKey, label){
  if(owner === S.p) return;                       // 玩家：不再每回合自动返还
  for(const eff of owner.counters){
    if(!owner.counterHit[eff]){
      const def = NATIONS[nationKey].counters.find(c => (c.eff || c.e) === eff);
      if(def && owner.hand.length < MAX_HAND){
        owner.hand.push(mkCounterDef(def, nationKey));   // 未触发的反制「返还手牌」：它当初是暗着挂上去的，
                                                          // 对手本就知道有反制但不知道是哪张 → 这里不置明牌
                                                          // （注意：反制牌本身不是免疫区——情报能揭示、弃牌/转换照样作用，见用户 2026-09-17 口径）
        logMsg(label+'的反制「'+def.n+'」未触发，返还手牌。');
      }
    }
  }
  owner.counters = [];
  owner.counterHit = {};
}
/* 「本回合」特效（拂晓行动/烈日/逆光攻击/巴顿/山本五十六）：
   回合结束时即失效，不延续到敌方回合 */
function clearTurnBuffs(side){
  const me = playerOf(side);
  me.airFuel0 = false; me.airFuelMinus1 = false; me.airAtk3 = false; me.airAtk2 = false; me.blazingUsed = false;
  me.patton = false;
  // （第85先锋连的减费不需要在这里清：playCost 现算，跨回合自然失效）
  me.frontBuff3 = false; me.frontFuelMinus1 = false; // 闪电战（直到回合结束）
  me.jpBuff1 = false; me.jpFuelMinus1 = false; // 为了天皇（直到回合结束）
  me.edictNext = false; // 天皇诏令只持续本回合
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(u && u.owner === side && u.yamamoto){
      u.atk -= 1; u.yamamoto = false;
      if(u.yamamotoBlitz){ u.yamamotoBlitz = false; u.def.sig = (u.def.sig||[]).filter(s=>s!=='blitz'); }
    }
    if(u && u.owner === side && u.tempAtk3){ u.atk -= 3; u.tempAtk3 = false; } // 短兵相接（直到回合结束）
  }
  for(const c of me.hand){
    if(c && c.zeroCostEOT){ c.blood = c.costPrev || 0; c.zeroCostEOT = false; c.costPrev = null; }
  }
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u2 = S.board[r][c];
    if(u2 && u2.owner === side && u2.def && u2.def.zeroCostEOT){
      u2.def.blood = u2.def.costPrev || 0; u2.def.zeroCostEOT = false; u2.def.costPrev = null;
    }
  }
}
function endPlayerTurn(){
  if(S.phase !== 'player') return;
  // 黑夜巡视（美·指令）：玩家没点手牌就结束回合 → 按随机 1 张结算本卡
  if(S.discardPick && S.discardPick.toDeck && S.discardPick.orderConsume){
    const pool0 = S.p.hand.filter(c => c && c !== S.discardPick.card);
    if(pool0.length) handToDeckResolve(pool0[Math.floor(Math.random()*pool0.length)]);
    else S.discardPick = null;
  }
  S.mode = null;
  if(S.mulliganPending) doMulligan([]); // 未换牌直接结束回合 = 全部保留
  if(S.pendingChoice && S.pendingChoice.side === 'p') cancelChoice(); // 未抉择就结束回合 = 取消使用（卡牌返回手牌）
  if(S.discardPick && S.discardPick.toDeck){        // 霹雳师/第175：未选则随机返回 1 张；调整：未选则随机洗入并抽 1 张
    const dp0 = S.discardPick;
    const pool0 = S.p.hand.filter(c => c && c !== dp0.card);
    if(pool0.length && dp0.shuffleIn){
      handToDeckResolve(pool0[Math.floor(Math.random()*pool0.length)]); // 内部清槽位并结算「调整」
    } else {
      S.discardPick = null;
      if(pool0.length) handCardToDeckTop(S.p, pool0[Math.floor(Math.random()*pool0.length)]);
    }
  } else if(S.discardPick && S.discardPick.costCut){ // 观察团：未点手牌就结束回合 = 自动挑花费最高的合格手牌
    const dp0 = S.discardPick;
    const pool0 = S.p.hand.filter(c => c && c !== dp0.card && (c.blood||0) >= (dp0.costMin||0));
    pool0.sort((a,b) => (b.blood||0) - (a.blood||0));
    if(pool0.length) discardPickResolve(pool0[0]);
    else { S.discardPick = null; logMsg('观察团：手牌中没有花费不小于 ' + (dp0.costMin||0) + ' 的牌，效果未结算。'); }
  } else if(S.discardPick){                          // 权衡未点手牌就结束回合 = 自动弃最低费并结算本卡
    const pool = S.p.hand.filter(c => c && c !== S.discardPick.card);
    pool.sort((a,b) => (a.blood||0) - (b.blood||0));
    if(pool.length) discardPickResolve(pool[0]);
    else { S.discardPick = null; }
  }
  if(S.gordonPick) cancelGordon(); // 戈登高人团：未点指令就结束回合 = 取消加持
  triggerFriendlyTurnEnd('p'); // 步兵第25团/Me 163彗星：友方回合结束特效
  resolveBridgeTooFar('a'); // 遥远的桥：敌方（玩家）回合结束，结算 AI 侧
  resolveSecondFront('a'); // 第二战线（AI 侧）：敌方（玩家）回合结束时结算
  resolveFirstResponse('a'); // 反制·第一响应（AI 侧）：敌方（玩家）回合结束时加入「第5步兵旅」；
                             // 必须早于下方 settleCounters（未触发的反制会被退回手牌）
  clearTurnBuffs('p'); // 「本回合」特效按下结束回合即失效，不延续到敌方回合
  S.p.drawBanned = false;
  hideDrawChoice(false); // 只为关掉摸牌面板：这里不是回合开始，「下个回合开始」类延迟效果不许在此结算
  clearSuppress('p'); // 玩家回合结束：移除玩家单位的压制
  settleCounters(S.a, S.aNation, '老牧师'); // AI 反制结算（触发消耗 / 未触发返还）
  // 部署封锁（提尔皮茨）：被封锁方整个回合结束即解除
  if(S.deployBlock && S.deployBlock.side === 'p') S.deployBlock = null;
  return startAiTurn(); // 返回 Promise（浏览器忽略；无头模拟可 await 整回合）
}
async function startAiTurn(){
  // 开发者模式：跳过敌方回合（面板按钮；消费一次就回玩家）
  if(DEV.skipAiTurns > 0){
    DEV.skipAiTurns--;
    logMsg('【开发者】跳过敌方回合。');
    render();
    await HOOKS.wait(250);
    if(!S.over) beginPlayerTurn();
    return;
  }
  S.phase = 'ai'; render();
  await HOOKS.wait(1300);
  if(S.over) return;
  // 北北布次香菜：全程固定行动（不抽牌、不受士气伤害）；二阶段（重生后）改用普通 AI 流程（恢复抽牌）
  if(S.bossKind === 'meme' && !S.bossRevived){
    await memeBossTurn();
    return;
  }
  // Boss 二阶段回合（优先于一阶段脚本）：梦之泪伤=虚空印卡 + 水牛总攻；
  // 阿尔卑斯要塞=按前线归属的两套行动；北北布次香菜=恢复普通 AI 流程（抽牌/出牌/攻击），
  // 并在摸牌后加入并打出「最后一搏」
  if(S.bossMode && S.bossRevived){
    if(S.bossKind === 'tears'){ await bossSpecialTurn(); return; }
    if(S.bossKind === 'alps'){ S.alpsOpened = true; await alpsSpecialTurn(); return; }
  }
  // 阿尔卑斯要塞：首个敌方回合执行开局脚本（弃手牌 + 虚空印卡 + 铺前线），随后恢复正常 AI
  if(S.bossKind === 'alps' && !S.alpsOpened){
    S.alpsOpened = true;
    await alpsOpening();
    if(S.over) return;
    settleCounters(S.p, S.pNation, '你的');
    clearSuppress('a');
    if(S.deployBlock && S.deployBlock.side === 'a') S.deployBlock = null;
    await HOOKS.wait(600);
    beginPlayerTurn();
    return;
  }
  resetUnitFlags('a');
  applySummonHold('a'); // 第一响应加入的「第5步兵旅」：落地标记回补（当回合不能行动）
  // 梦之泪伤 一阶段：本回合凝结的水牛刚落地（resetUnitFlags 之后创建 → 落地当回合不能行动）
  if(S.bossKind === 'tears' && !S.bossRevived){
    tearsReinforce();
    await HOOKS.wait(500);
    if(S.over) return;
  }
  // 九九式袭击机：检查 AI 手牌自动部署（用敌方回合结束时的指挥点判断）
  checkKi61Auto('a');
  if(S.bossKind === 'hana'){
    // hana 专用槽位机制（用户 2026-09-16）：每回合 +3；第一回合 3 点；一阶段上限 12、二阶段起上限 24。
    // 按「她的第 N 个回合 = 3N」绝对值给（Math.max 保住战争机器/战争需要这类指令带来的额外槽）。
    S.a.hanaTurns = (S.a.hanaTurns || 0) + 1;
    const hanaCap = (S.bossLife >= 2 || S.bossRevived) ? 24 : 12;
    S.a.kreditSlots = Math.max(S.a.kreditSlots || 0, Math.min(hanaCap, 3 * S.a.hanaTurns));
  } else {
    S.a.kreditSlots = (S.a.kreditSlots < 12) ? S.a.kreditSlots + 1 : S.a.kreditSlots; // 自然增长仅在槽<12时+1；指令带来的>12槽不被拉回
  }
  S.a.kredit = S.a.kreditSlots;
  // 霍尔姆第99团（AI 侧）：持有方（老牧师）**自己回合开始时**失去 1 个指挥点——必须在新回合点数刷新之后扣，
  // 否则扣的是上个回合的余额，一刷新就白扣了（同「合成机油」的时间线口径）
  if(S.a.pendingKreditLoss > 0){
    const n = S.a.pendingKreditLoss;
    S.a.pendingKreditLoss = 0;
    S.a.kredit = Math.max(0, S.a.kredit - n);
    logMsg('霍尔姆第99团：老牧师失去 ' + n + ' 个指挥点（当前 ' + S.a.kredit + '）。');
  }
  // 本回合临时增益（拂晓/烈日/逆光）在新回合开始清零
  S.a.airFuel0 = false; S.a.airFuelMinus1 = false; S.a.airAtk3 = false; S.a.airAtk2 = false; S.a.blazingUsed = false;
  S.a.patton = false;            // 巴顿增益只持续本回合
  // （第85先锋连「第一张指令 -1」对 AI 同样走 playCost 现算，无需在这里置位）
  S.a.coopNations = collectNations('a'); // 协力：回合开始时友方单位国家快照
  resolveOwnerTurnStart('a'); // 卫戍/物资短缺/高潮迭起/前线观察员：回合开始被动
  // AI 摸牌：不再摸生产（已补偿永久 +1 指挥点槽），直接摸卡组（空则疲劳）

  if(S.a.hanaNoDraw){ S.a.drawBanned = true; logMsg('hana：第三条命不再抽牌——牌堆已经封了。'); }
  else if(S.a.drawBanPending > 0){ S.a.drawBanPending--; S.a.drawBanned = true; logMsg('豹式坦克A型：老牧师本回合无法抽牌。'); }
  else S.a.drawBanned = false;  drawCards(S.a, 1, false, true);;
  // 战争债券：下个友方回合开始时额外抽牌（AI 侧在摸牌后结算）
  if(S.a.extraDrawNext > 0){ const n = S.a.extraDrawNext; S.a.extraDrawNext = 0; drawCards(S.a, n); logMsg('战争债券：额外抽 ' + n + ' 张牌。'); }
      resolveOilPending('a');
      r2ClearHqSmoke('a');   // 深水炸弹：总部烟幕到本回合开始
  checkGuard216('a'); // 216团：AI 摸牌后触发回合开始特效（与玩家侧摸牌后触发对齐）
  // 元帅战术中央：回合开始刷新一次全局评估（marshal 专属；其他难度 aiRefreshIntel 直接跳过）
  if(typeof aiRefreshIntel === 'function') aiRefreshIntel();
  // 抉择（AI）：若上一步打出的抉择卡属于 AI，自动选择（航母掩护：有战斗机选战斗群+1/+1，否则前线进驻）
  aiResolveChoice();
  logMsg('老牧师摩挲着牌堆，落下一张牌……');
  render(); await HOOKS.wait(1000);
  if(S.over) return;

  // 北北布次香菜 二阶段：重生后的下一个敌方回合——把「最后一搏」加入手牌并打出
  // （剧本卡只是发放，按正常 10 费支付；玩家反制照常生效）
  if(S.bossKind === 'meme' && S.bossRevived && S.memeLastPush){
    S.memeLastPush = false;
    const rawLp = NATIONS.jp.orders.find(o => o.id === 'lastpush');
    if(rawLp){
      const lp = mkOrderDef(Object.assign({}, rawLp, { nation:'jp' }), 'jp');
      if(S.a.hand.length >= MAX_HAND) S.a.deck.push(lp); else S.a.hand.push(lp);
      logMsg('北北布次香菜 从泥土里掏出一张牌——「最后一搏」加入手牌。');
      render(); await HOOKS.wait(900);
      if(S.a.hand.indexOf(lp) >= 0){
        const need = playCost(S.a, lp);
        if(S.a.kredit < need) S.a.kredit = need; // 她的指挥点槽已锁定在 10：付得起
        S.a.hand.splice(S.a.hand.indexOf(lp), 1);
        S.a.kredit -= need;
        orderEffect(lp, null);
        render(); await HOOKS.wait(1100);
      }
    }
    if(S.over) return;
  }

  // AI 加强·致死打击：场上可直击玩家总部的单位攻击力之和(+可直击总部的指令) ≥ 玩家总部血量
  // → 放弃部署/推进/其他操作：先打生产与致命指令，再全体直击玩家总部，随后直接收尾
  const lethal = aiLethalPlan();
  if(lethal){
    for(const c of S.a.hand.slice()){
      if(c.kind==='order' && c.eff==='produce'){
        const i = S.a.hand.indexOf(c); if(i>-1) S.a.hand.splice(i,1);
        orderEffect(c, null);
        render(); await HOOKS.wait(500);
      }
    }
    for(const card of lethal.orders){
      if(S.over) break;
      if(playCost(S.a, card) > S.a.kredit) continue;
      const i = S.a.hand.indexOf(card); if(i<0) continue;
      S.a.hand.splice(i,1); S.a.kredit -= playCost(S.a, card);
      const tgt = (card.eff==='gunboat' || card.eff==='bombRaid') ? {hq:true} : null;
      orderEffect(card, tgt);
      render(); await HOOKS.wait(850);
    }
    for(const at of lethal.units){
      if(S.over) break;
      if(!canAct(at.u)) continue;
      if(!attackTargets('a', at.r, at.c).some(t=>t.hq)) continue;
      combat({row:at.r, col:at.c}, {hq:true});
      render(); await HOOKS.wait(850);
    }
    // 奋战单位可攻击两次：第二次攻击（斩杀伤害已按双倍计算，如 N1K-J紫电）
    for(const at of lethal.units){
      if(S.over) break;
      if(!canAct(at.u)) continue; // 非奋战单位攻击过一次后 canAct=false 自动跳过
      if(!attackTargets('a', at.r, at.c).some(t=>t.hq)) continue;
      combat({row:at.r, col:at.c}, {hq:true});
      render(); await HOOKS.wait(850);
    }
    if(S.over) return;
    // 斩杀没打成（高估了伤害：油费付不起/被守护挡住/玩家有总部保护…）——**不要直接结束回合**：
    // 旧写法在这里 beginPlayerTurn() 收工，导致解场/推进/攻击全部被跳过 = 白费一回合，
    // 前线的玩家单位也不会挨打（用户 2026-09-17：他推不了就攻击前线单位啊）。
    // 现在从斩杀分支掉出去，继续走下面的常规流程（解场→推进→贴膜→攻击→发育→补推）。
    logMsg('老牧师：斩杀没能得手，转入常规行动。');
  }

  // 行动执行器（解场/发育两阶段共用）
  const execPlay = async (play) => {
    if(play.kind === 'unit'){
      // AI 预选部署目标（play.pick = 单位对象）：走与玩家 UI 同一条路（S.pickTarget → spawnUnit 消费并清空）。
      // 目前只有「舍伍德森林人团」用（用户 2026-09-13 口径：两个方向都可以，但不复制自己弱卡 / 不复制敌方强卡，
      // 见 ai.js aiUnitDeployPick）；其余单位 play.pick 为 null，保持原行为。
      const hadPick = !!play.pick;
      const prevPick = hadPick ? (S.pickTarget || null) : null;
      if(hadPick) S.pickTarget = play.pick;
      const spawned = spawnUnit('a', play.card, play.slot.row, play.slot.col);
      if(hadPick) S.pickTarget = prevPick;   // 只有真的设过才恢复；未设过的卡保持原行为（spawnUnit 照旧清空）
      if(!spawned) return false;
      S.a.kredit -= playCost(S.a, play.card);
      const idx = S.a.hand.indexOf(play.card); if(idx>-1) S.a.hand.splice(idx,1);
      checkEnemyDeployDmg('a', unitAt(play.slot.row, play.slot.col), play.slot.row, play.slot.col); // 反制·无心漫谈
      // 巴顿：部署后具有闪击
      if(S.a.patton){
        const dep = unitAt(play.slot.row, play.slot.col);
        if(dep && !hasSig(dep,'blitz')){ dep.def.sig.push('blitz'); logMsg('巴顿：'+dep.def.n+' 部署后获得闪击。'); }
      }
      logMsg('老牧师 部署了 ' + play.card.n + '。');
      sfx('place'); render(); await HOOKS.wait(950);
      aiResolveChoice(); // 部署抉择（戈登高人团）：AI 立即自动选最优
      return true;
    }
    if(play.kind === 'order'){
      // 目标单位解析（总部目标无单位信息）：防御非法 tgt 形状（如 row/col 丢失），杜绝 AI 回合崩溃
      const tu = (play.tgt && !play.tgt.hq && Number.isInteger(play.tgt.row) && Number.isInteger(play.tgt.col)) ? unitAt(play.tgt.row, play.tgt.col) : null;
      // 红魔空降步兵团：敌方指向本单位时 +1 花费（花费不够则不能打出）；总部目标无加成
      const sur = tu ? targetSurcharge('a', tu) : 0;
      // 步兵第75团：被敌方效果指向时复制到友方总部相邻处
      if(tu) r75Targeted('a', tu);
      const cost = playCost(S.a, play.card) + sur;
      if(cost > S.a.kredit) return false;
      const idx = S.a.hand.indexOf(play.card); if(idx>-1) S.a.hand.splice(idx,1);
      S.a.kredit -= cost;
      if(sur) logMsg('红魔空降步兵团：指向花费 +1。');
      orderEffect(play.card, play.tgt || null);
      aiResolveChoice(); // 抉择卡（AI）：打出后立即自动结算，不在玩家界面停留
      render(); await HOOKS.wait(850); return true;
    }
    if(play.kind === 'counter'){
      const idx = S.a.hand.indexOf(play.card); if(idx>-1) S.a.hand.splice(idx,1);
      S.a.kredit -= playCost(S.a, play.card);
      S.a.counters.push(play.card.eff);
      render(); await HOOKS.wait(700); return true;   // 反制为暗牌：字幕不显露老牧师布置了什么
    }
    return false;
  };
  // ===== ① 解场阶段（优先级低于致死）：解场指令 + 利奥波德 优先打出 =====
  for(let iter=0; iter<8 && !S.over; iter++){
    const play = aiPlayRemoval();
    if(!play) break;
    if(!(await execPlay(play))) break;
  }
  if(S.over) return;
  await HOOKS.wait(500);

  // 推进（反制对 AI 是隐藏信息，不因玩家反制改变行为）
  {
    const pushCands = [];
    const isPushType = u => u.def.t==='infantry' || u.def.t==='tank';
    const atRow0 = c => { const u=S.board[0][c]; return u && u.owner==='a' && !u.suppressed ? u : null; };
    // 1) 守护步兵/坦克：优先上前线顶阵（落地当回合除外；第109战斗工兵营不上前线）
    for(let c=0;c<COLS;c++){ const u=atRow0(c); if(u && aiCanPushUp('a',u,c) && isPushType(u) && u.def.id!=='eng109' && hasSig(u,'guard') && !u.summonedThisTurn) pushCands.push({u,c,score:99}); }
    // 2) 落地闪击步兵/坦克（闪击=落地当回合可行动；工兵营不上前线）
    for(let c=0;c<COLS;c++){ const u=atRow0(c); if(u && aiCanPushUp('a',u,c) && u.summonedThisTurn && hasSig(u,'blitz') && isPushType(u) && u.def.id!=='eng109' && !hasSig(u,'guard')) pushCands.push({u,c,score:60}); }
    // 3) 所有步兵/坦克（含低质量；工兵营不上前线）：上前线施压，炮兵留底线；每回合最多推 3 个
    for(let c=0;c<COLS;c++){ const u=atRow0(c); if(u && aiCanPushUp('a',u,c) && isPushType(u) && u.def.id!=='eng109' && !u.summonedThisTurn && !hasSig(u,'guard')) pushCands.push({u,c,score:30+u.atk+u.hp}); }
    // 4) 水牛/野猫（战斗机）优先抢线：F2A 前线 +1 攻、F4F 推进生成水牛（正常对局）
    for(let c=0;c<COLS;c++){ const u=atRow0(c); if(u && aiCanPushUp('a',u,c) && (u.def.id==='f2a' || u.def.id==='f4f') && !u.summonedThisTurn) pushCands.push({u,c,score:90}); }
    // 5) 落地闪击野猫（闪击=落地当回合即可推进抢线）
    for(let c=0;c<COLS;c++){ const u=atRow0(c); if(u && aiCanPushUp('a',u,c) && u.summonedThisTurn && u.def.id==='f4f') pushCands.push({u,c,score:65}); }
    pushCands.sort((x,y)=>y.score-x.score);
    let pushed = 0;
    for(const pc of pushCands){
      if(pushed >= 3 || S.over) break;
      if(moveForward('a', 0, pc.c)){ pushed++; render(); await HOOKS.wait(700); }
    }
  }
  if(S.over) return;
  await HOOKS.wait(400);

  // ===== ② 贴膜阶段（AI 优化）：贴膜卡先贴膜，再让被贴膜的单位攻击 =====
  // 只打能立刻转化为攻击的增益（目标=本回合可行动单位 / 全局增益需有可行动受益单位）
  for(let iter=0; iter<6 && !S.over; iter++){
    const buff = aiPlayBuff();
    if(!buff) break;
    if(!(await execPlay(buff))) break;
  }
  if(S.over) return;

  /* ===== 攻击执行器（可重复调用）：一轮扫全盘，把「还能行动」的单位都打一次 =====
     旧写法把攻击写成一个**每格只扫一次**的 for 循环 → 三个后果（用户 2026-09-17 报「AI 完全没发挥出
     SUPERMAN 的作用：分明有闪击、奋战、还能像坦克一样行动」）：
       ① 奋战（fight）的第二下永远打不出来（canAct 允许 attackedN<2，但循环已经走过那格）；
       ② 发育阶段（部署）排在攻击阶段之后 → 落地当回合攻击 0 次（闪击形同虚设）；
       ③ 前线 SUPERTANK 的「无限次攻击」只打 1 下。
     现在改成函数：内部最多扫 4 轮，某轮没人能再打就停（canAct 自带 attackedN/落地/移动限制，
     普通单位第 2 轮自然打不动，不会变成人人连击）。 */
  const aiAttackPass = async () => {
    let acted = 0;
    for(let round=0; round<4 && !S.over; round++){
      let did = 0;
      for(let r=0;r<ROWS && !S.over;r++) for(let c=0;c<COLS && !S.over;c++){
        const u = S.board[r][c];
        if(!u || u.owner!=='a' || !canAct(u)) continue;
        // 油费付不起就别打：`combat` 会直接 return false，但循环仍算「有进展」→ 空转到上限
        // （用户 2026-09-17 报：hana 第三阶段没费用了还在无意义地反复行动）
        const fuel = actFuelCost('a', u);
        if(fuel > 0 && S.a.kredit < fuel) continue;
        const tgts = attackTargets('a', r, c);
        if(!tgts.length) continue;
        const t = aiAttackTarget(r, c, u, tgts);
        if(!t) continue;
        if(!combat({row:r, col:c}, t)) continue;   // 没打成就当没发生，不算一轮进展
        did++; acted++;
        render(); await HOOKS.wait(850);
      }
      if(!did) break;
    }
    return acted;
  };

  await aiAttackPass();
  if(S.over) return;
  // ===== ③ 发育阶段（优先级最低）：部署其他单位 / 使用其他指令（解场指令已优先处理） =====
  for(let iter=0; iter<10 && !S.over; iter++){
    // 暴风雨前的宁静（日）：本卡打出后本方回合立即结束 → 发育阶段不再出牌（旗标由 resolveImmediateEndTurn 置位）
    if(S.a.forceEndTurn) break;
    const play = aiChoosePlay(typeof AI_REMOVAL_EFFS !== 'undefined' ? AI_REMOVAL_EFFS : null); // 无头（模块态）下 AI_REMOVAL_EFFS 可能不可见
    if(!play) break;
    if(!(await execPlay(play))) break;
  }
  if(S.over) return;
  // ===== ④ 补推：发育阶段刚部署的闪击步兵/坦克/野猫（及守护单位）落地当回合即推进前线 =====
  // 暴风雨前的宁静：若本回合已立即结束，则不再推进（旗标在下方 beginPlayerTurn 之前清零）
  for(let c=0;c<COLS && !S.a.forceEndTurn;c++){
    if(S.over) break;
    const u = S.board[0][c];
    if(!u || u.owner!=='a' || u.suppressed || !u.summonedThisTurn) continue;
    const isGround = u.def.t === 'infantry' || u.def.t === 'tank';
    if(!isGround && u.def.id !== 'f4f') continue; // 落地闪击野猫同样抢线
    if(!hasSig(u,'blitz')) continue; // 落地当回合仅闪击可推进（无闪击的坦克/守护单位不推进，如 T-70）
    if(!aiCanPushUp('a', u, c)) continue;   // 推不上去（前线被占/已满/本列被己方占着/油费不足）就别试
    if(moveForward('a', 0, c)){ render(); await HOOKS.wait(600); }
  }
  if(S.over) return;
  // ===== ⑤ 补攻：发育阶段刚落地（闪击/奋战/移动并攻击）的单位这一回合也要出手 =====
  // （SUPERMAN：闪击落地 → 推前线 → 奋战打两下；旧写法这里直接收工，等于白扔一张 9/5）
  await aiAttackPass();
  if(S.over) return;
  // 敌方回合结束：玩家反制结算（触发消耗 / 未触发返还）；移除 AI 单位的压制
  settleCounters(S.p, S.pNation, '你的');
  clearSuppress('a');
  // 部署封锁（提尔皮茨）：被封锁方整个回合结束即解除
  if(S.deployBlock && S.deployBlock.side === 'a') S.deployBlock = null;
  await HOOKS.wait(700);
  // 暴风雨前的宁静（日·AI 侧）：立即结束本方回合——清旗标并留下一条日志，避免旗标带到下一个 AI 回合
  if(S.a.forceEndTurn){ S.a.forceEndTurn = false; logMsg('暴风雨前的宁静：老牧师立即结束了回合。'); }
  beginPlayerTurn();
}

/* ---------- 引擎/UI 共用旁路（Hook 包装，避免重名冲突） ----------
   logMsg：写入 S.log（状态）后通知 HOOKS.onLog；
   sfx/toast/render：直接转发 HOOKS，UI 层注入真实实现后即生效。 */
function logMsg(msg){ S.log.push(msg); if(S.log.length>60) S.log.shift(); HOOKS.onLog(msg); }
function sfx(kind){ HOOKS.onSfx(kind); }
function toast(msg){ HOOKS.toast(msg); }
function render(){ HOOKS.onRender(); }

/* ==== batch-R3 顶层辅助函数（浏览器可见；勿移入 module 块） ==== */
function researchTextR3(id){
  const T = {
    '曼哈顿计划':'对所有敌方目标造成 6 点伤害',
    '青霉素':'使所有友方单位和总部获得 +6 防御力，抽 4 张牌',
    '高级美国研发':'抉择：青霉素 或 2 张曼哈顿计划',
    '倾斜装甲':'将 1 个「IS-2」加入支援阵线，使其与 1 个敌方单位战斗；回合结束时返回手中',
    '标准弹药':'手中与卡组中所有友方单位 -1 花费、-1 行动花费',
    '气动雪橇':'对 1 个敌方陆军或总部造成 2 点伤害，对其相邻目标造成 2 点伤害',
    '扩展苏联研发':'抉择：标准弹药 或 高级苏联研发',
    '高级苏联研发':'抉择：倾斜装甲 或 3 张斯大林管风琴',
    '斯大林管风琴':'造成 8 点伤害，随机分配至所有敌方目标'
  };
  return T[id] || '';
}

function addResearchCardsToHand(me, id, n){
  const def0 = makeDerived(id);
  if(!def0){ logMsg('研发：找不到衍生卡「' + id + '」，效果不结算。'); return 0; }
  let added = 0;
  for(let i=0;i<(n || 1);i++){
    if(handFree(me, null) <= 0){ logMsg('手牌已满（9张），「' + def0.n + '」无法加入手牌。'); break; }
    const def = makeDerived(id);            // 每张各取一个新对象：多张之间不共享引用（同 R1）
    const txt = researchTextR3(id);
    if(txt) def.desc = txt;
    def.revealed = true;                    // 明牌（用户 2026-09-16：研发得到的卡均为明牌，对手正面可见）
    def.research = true;                    // 研发系标记：AI 用它判「研发及其衍生牌」（hana 优先出这类）
    me.hand.push(def);
    added++;
  }
  return added;
}

function openResearchChoiceN(card, side, picks){
  const options = picks.map((p, i) => {
    const def = makeDerived(p.id);
    const num = p.n || 1;
    const base = researchTextR3(p.id) || (def ? (def.desc || '') : '');
    return { id:'c' + (i + 1), n:(num > 1 ? num + '×' : '') + (def ? def.n : p.id),
             img:(def ? (def.img || '') : ''), desc:(num > 1 ? base + '（一次加入 ' + num + ' 张）' : base),
             add:p.id, num:num };
  });
  S.pendingChoice = { eff:'researchChoiceN', side:side, card:card, options:options, picks:picks };
  HOOKS.onChoice(options);
  logMsg((card && card.n ? card.n : '研发') + '：抉择吧——「' +
         picks.map(p => ((p.n > 1 ? p.n + '×' : '') + p.id)).join('」或「') + '」。');
}

function resolveResearchChoiceN(me, pc, choiceId){
  const picks = pc.picks || [];
  const i = parseInt(String(choiceId).slice(1), 10) - 1;
  const p = picks[i];
  if(!p){ logMsg('研发：抉择无效，未获得任何卡。'); return false; }
  const got = addResearchCardsToHand(me, p.id, p.n || 1);
  if(got > 0) logMsg('研发：将 ' + got + ' 张「' + p.id + '」加入手牌。');
  return got > 0;
}

function aiResearchPickN(pc, side){
  const me = playerOf(side);
  const opts = pc.options || [];
  if(!opts.length) return 'c1';
  // 最终 Boss「hana」：同上（picks 形状是 {id,n}，同样按指定终结卡 / 下一级研发优先）
  if(S.bossKind === 'hana' && side === 'a'){
    for(const o of opts){ if(HANA_RESEARCH_WANT.some(w => String(o.add).indexOf(w) >= 0)) return o.id; }
    for(const o of opts){ if(String(o.add).indexOf('研发') >= 0) return o.id; }
  }
  let rich = opts[0], richCost = -1, cheap = null;
  for(const o of opts){
    const def = makeDerived(o.add);
    const cost = def ? (def.blood || 0) * (o.num || 1) : 0;
    if(cost > richCost){ richCost = cost; rich = o; }
  }
  for(const o of opts){ if(o !== rich){ cheap = o; break; } }
  if(!cheap) return rich.id;
  const rdef = makeDerived(rich.add);
  const need = rdef ? (rdef.blood || 0) : 0;
  return (me.kreditSlots + 2 >= need) ? rich.id : cheap.id;
}

function topUnitInDeck(me){
  for(let i = me.deck.length - 1; i >= 0; i--){
    const c = me.deck[i];
    if(c && c.kind === 'unit') return c;
  }
  return null;
}

function resolveWomenReserve(me, pc, choiceId){
  const card = pc.pick;
  if(!card || me.deck.indexOf(card) < 0){ logMsg('妇女预备队：目标单位已不在卡组，效果不结算。'); return false; }
  if(choiceId === 'c2'){
    card.sig = card.sig || [];
    const add = [];
    if(!card.sig.includes('ambush')){ card.sig.push('ambush'); add.push('伏击'); }
    if(!card.sig.includes('impact')){ card.sig.push('impact'); add.push('冲击'); }
    logMsg('妇女预备队：「' + card.n + '」获得' + (add.length ? add.join('与') : '（已有伏击与冲击）') + '。');
    return true;
  }
  if(me.hand.length >= MAX_HAND){ logMsg('妇女预备队：手牌已满（9张），「' + card.n + '」无法加入手牌。'); return false; }
  me.deck.splice(me.deck.indexOf(card), 1);
  me.hand.push(card);       // 「抽取…加入手牌」按抽牌口径：不进明牌（用户 2026-09-16 明确：妇女预备队不是明牌）
  bossPlayerReveal(card);   // Boss 挑战下与「美国陆军航空队」一致：自定义抽牌也结算抽取特效
  logMsg('妇女预备队：抽取卡组顶的「' + card.n + '」加入手牌。');
  return true;
}

function aiWomenReservePick(pc, side){
  const me = playerOf(side);
  return (me.hand.length < MAX_HAND) ? 'c1' : 'c2';
}

function resolveObliqueArmorReturn(side){
  const me = playerOf(side);
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner !== side || !hasFx(u,'obliqueBack')) continue;
    if(me.hand.length >= MAX_HAND){ logMsg(u.def.n + '：手牌已满（9张），无法返回手中。'); continue; }
    S.board[r][c] = null;
    u.def.fx = (u.def.fx || []).filter(f => f !== 'obliqueBack');
    handReturnsToHand(side, u.def, { row:r, col:c });
    logMsg('倾斜装甲：友方回合结束，' + u.def.n + ' 返回手中。');
  }
}

/* 卡牌效果「将…加入手牌/手中」的牌一律是明牌（用户 2026-09-16）：对手手牌 UI 正面直显，并计入情报口径。
   抽牌不走这里 —— drawCards 的抽牌只在「抽取特效卡」时揭示（另行判定），开局发牌也不揭示。 */
function handPushRevealed(player, card){
  if(!player || !card) return card;
  try{ card.revealed = true; }catch(e){}
  player.hand.push(card);
  return card;
}
/* Node 导出（浏览器下跳过，靠全局变量） */
Object.assign(globalThis, { GAME_RULES, DECK_OVERRIDE }); // 无头下 global 可见（与浏览器顶层 const 等价）
  
/* ==== 新增辅助函数（apply-fx 插入） ==== */
function researchText(id){
  const T = {
    'V-1飞行炸弹':'消灭 1 个花费不大于 3 的单位',
    '合成机油':'下个回合开始时获得 10 个指挥点并抽 1 张牌',
    'XXⅪ级U型潜艇':'消灭 1 个单位，敌方随机弃 2 张牌',
    '铀工程':'消灭所有敌方单位，每消灭 1 个获得 1 个指挥点',
    '扩展德意志帝国研发':'抉择：合成机油 或 高级德意志帝国研发',
    '高级德意志帝国研发':'抉择：XXⅪ级U型潜艇 或 铀工程',
    '气球炸弹':'压制所有敌方单位',
    '扩展帝国研发':'抉择：氧气鱼雷 或 高级帝国研发',
    '氧气鱼雷':'消灭 1 个单位；若其攻击力不大于 3，抽 2 张牌',
    '7075铝':'将 3 张「A6M2零战」加入手中（花费 0），并获得亡计：复制回手',
    '皇国二号兵器':'将 4 张「试制橘花」置于卡组顶，使其花费与行动花费为 0',
    '高级帝国研发':'抉择：7075铝 或 皇国二号兵器',
    '加压舱':'将 1 张「超级堡垒B-29」加入手牌，随机消灭 1 个敌方单位',
    '深水炸弹':'额外获得 1 个指挥点槽；友方总部获得烟幕直到下个友方回合开始',
    '青霉素':'所有友方单位与总部 +6 防御力，抽 4 张牌',
    '扩展美国研发':'抉择：加压舱 或 高级美国研发',
    '美国军事研发':'抉择：深水炸弹 或 扩展美国研发',
    '高级美国研发':'抉择：青霉素 或 2 张曼哈顿计划'
  };
  return T[id] || '';
}

function addResearchCardToHand(me, id){
  const def = makeDerived(id);
  if(!def) return null;
  if(handFree(me, null) <= 0){ logMsg('手牌已满（9张），「' + def.n + '」无法加入手牌。'); return null; }
  const txt = researchText(id);
  if(txt) def.desc = txt;
  def.revealed = true;   // 明牌（用户 2026-09-16：研发得到的卡均为明牌，对手正面可见）
  def.research = true;   // 研发系标记：AI 用它判「研发及其衍生牌」（hana 优先出这类）
  me.hand.push(def);
  return def;
}

function openResearchChoice(card, side, ids){
  const options = ids.map((id, i) => {
    const def = makeDerived(id);
    return { id:'c' + (i + 1), n:(def ? def.n : id), img:(def ? (def.img || '') : ''),
             desc:(researchText(id) || (def ? (def.desc || '') : '')), add:id };
  });
  S.pendingChoice = { eff:'researchChoice', side:side, card:card, options:options, picks:ids.slice() };
  HOOKS.onChoice(options);
  logMsg((card && card.n ? card.n : '研发') + '：抉择吧——「' + ids.join('」或「') + '」。');
}

function resolveResearchChoice(me, pc, choiceId){
  const ids = pc.picks || [];
  const i = parseInt(String(choiceId).slice(1), 10) - 1;
  const id = ids[i];
  if(!id){ logMsg('研发：抉择无效，未获得任何卡。'); return false; }
  const got = addResearchCardToHand(me, id);
  if(got) logMsg('研发：将 1 张「' + got.n + '」加入手牌。');
  return !!got;
}

/* 最终 Boss「hana」的科技树终点（用户口径）：德→U型潜艇 / 美→曼哈顿计划 / 英→声呐 / 日→7075铝 / 苏→管风琴。
   注意「声呐」(nà) 与卡名逐字一致——写成「声纳」会永远匹配不上（2026-09-16 踩过），故两种写法都收。 */
const HANA_RESEARCH_WANT = ['XXⅪ级U型潜艇', '曼哈顿计划', '声呐', '声纳', '7075铝', '斯大林管风琴'];

function aiResearchPick(pc, side){
  const me = playerOf(side);
  const opts = pc.options || [];
  if(!opts.length) return 'c1';
  // 最终 Boss「hana」的科技树走向（用户口径）：3/6 费一律往下一级研发爬，9 费拿指定的终结卡
  if(S.bossKind === 'hana' && side === 'a'){
    for(const o of opts){ if(HANA_RESEARCH_WANT.some(w => String(o.add).indexOf(w) >= 0)) return o.id; }
    for(const o of opts){ if(String(o.add).indexOf('研发') >= 0) return o.id; }   // 先爬到 6/9 费那一级
  }
  let rich = opts[0], richCost = -1, cheap = null;
  for(const o of opts){
    const def = makeDerived(o.add);
    const cost = def ? (def.blood || 0) : 0;
    if(cost > richCost){ richCost = cost; rich = o; }
  }
  for(const o of opts){ if(o !== rich){ cheap = o; break; } }
  if(!cheap) return rich.id;
  return (me.kreditSlots + 2 >= richCost) ? rich.id : cheap.id;
}

function resolveOilPending(side){
  const me = playerOf(side);
  const n = me.oilPending || 0;
  if(n <= 0) return 0;
  me.oilPending = 0;
  const gain = 10 * n;
  me.kredit += gain;
  drawCards(me, n);
  logMsg('合成机油：获得 ' + gain + ' 个指挥点（当前 ' + me.kredit + '），并抽 ' + n + ' 张牌。');
  return gain;
}


/* ==== 新增辅助函数（apply-fx 插入） ==== */
function handCardShuffleIn(player, card){
  if(!player || !card) return false;
  const i = player.hand.indexOf(card);
  if(i < 0) return false;
  player.hand.splice(i, 1);
  const at = player.deck.length ? Math.floor(Math.random()*(player.deck.length+1)) : 0;
  player.deck.splice(at, 0, card);
  return true;
}


/* ==== 新增辅助函数（apply-fx 插入） ==== */
function makePoolUnitDef(nation, id){
  const nat = (typeof NATIONS !== 'undefined' && NATIONS) ? NATIONS[nation] : null;
  const raw = nat ? (nat.units || []).find(x => x.id === id) : null;
  return raw ? mkUnitDef(raw, nation) : null;
}

function addPoolUnitToBackline(side, nation, id, n, opts){
  opts = opts || {};
  const br = backRowOf(side);
  let placed = 0;
  for(let i = 0; i < n; i++){
    const def = makePoolUnitDef(nation, id);
    if(!def) break;
    if(opts.blitz && (def.sig || []).indexOf('blitz') < 0) def.sig = (def.sig || []).concat(['blitz']);
    let ok = false;
    for(let c = 0; c < COLS; c++) if(!S.board[br][c]){ if(spawnUnit(side, def, br, c)){ ok = true; break; } }
    if(!ok) break;                                   // 支援阵线已满 → 停止（HMS竞技神号的「直到已满」）
    placed++;
  }
  return placed;
}

function isCommandoUnit(u){
  if(!u || !u.def) return false;
  if(u.def.id === 'cmdo9' || u.def.id === 'cmdo46' || u.def.id === '第10突击队') return true;
  return /突击队/.test(String(u.def.n || ''));
}


/* ==== 新增辅助函数（apply-fx 插入） ==== */
function resuppressTick(side){
  if(S.over) return;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner !== side || !u.reSuppressTarget) continue;
    if(findPosOf(u.reSuppressTarget)){
      if(applySuppress(u.reSuppressTarget)) logMsg(u.def.n + '：友方回合开始，再次压制 ' + u.reSuppressTarget.def.n + '。');
      else logMsg(u.def.n + '：' + u.reSuppressTarget.def.n + ' 免疫压制，再次压制不生效。');
    } else {
      u.reSuppressTarget = null;
      logMsg(u.def.n + '：原压制目标已不在战场，再次压制结束。');
    }
  }
}


/* 「撤退」（规则.txt：前线单位撤退时，退回支援阵线；若支援阵线已满或本就从支援阵线撤退，
   则返回所有者手牌，手牌已满则丢失并播爆牌）。
   写法取自「密苏里号 missouri」的相邻单位撤退与「丘吉尔 MKIII AVRE avreRetreat」的同一段逻辑，
   抽成公用函数（既有那两处代码**未改动**，行为不变，不构成回归）。
   返回 true = 成功留在支援阵线或回到手牌。 */
function retreatUnit(side, u){
  if(!u) return false;
  const pos = findPosOf(u);
  if(!pos) return false;
  const slot = (pos.r === 1) ? emptyBacklineSlot(side) : null;   // 只有前线单位能「退到支援阵线」
  if(slot){
    // bound 绑定按 sacrifice 逻辑处理（仙台联队离开原位，归还被绑定单位）——与密苏里号同写法
    if(u.bound && u.bound.u){ const b = u.bound; if(!S.board[b.r][b.c]){ S.board[b.r][b.c] = b.u; logMsg('仙台联队离开战场，' + b.u.def.n + ' 返回！'); } }
    S.board[pos.r][pos.c] = null;
    S.board[slot.row][slot.col] = u;
    syncRowSig(u);                                       // 三式中战车：撤至支援战线 → 重获伏击/守护
    logMsg(u.def.n + ' 撤退到己方支援阵线。');
    return true;
  }
  if(u.bound && u.bound.u){ const b = u.bound; if(!S.board[b.r][b.c]){ S.board[b.r][b.c] = b.u; logMsg('仙台联队离开战场，' + b.u.def.n + ' 返回！'); } }
  S.board[pos.r][pos.c] = null;
  if(handReturnsToHand(side, u.def, pos)){ logMsg(u.def.n + ' 撤退回手牌。'); return true; }
  logMsg(u.def.n + ' 手牌已满，撤退无处可去。');
  HOOKS.onCardBurst(u.def, u.owner);                     // 满手爆牌：撤退单位丢失（与密苏里号同口径）
  return false;
}

/* 「结束回合」类指令的收尾（暴风雨前的宁静）：
   玩家侧直接调用 endPlayerTurn() —— 它内含 triggerFriendlyTurnEnd / resolveBridgeTooFar /
   clearTurnBuffs / settleCounters 等**全部既有**回合结束结算，并接着开始敌方回合，
   语义就是「本卡结算完 → 回合结束」。
   时序说明：orderEffect 的调用方（ui.js 约 1737/1773 行）是在 orderEffect **返回之后**才扣费/移除手牌，
   而本函数同步跑完 endPlayerTurn，因此卡牌消耗仍按原路径完成，不会漏扣、也不会重复扣。
   AI 侧（S.phase==='ai'）：**不**直接结束回合，只置 me.forceEndTurn 旗标；该旗标由 startAiTurn()
   消费（发育阶段循环开头 break、补推阶段循环条件、beginPlayerTurn() 之前清零并留痕），
   即「AI 打出本卡后立即结束本方回合」。该卡已在 ai.js 的 AI_ORDER_COND 登记，AI 确实会打出。 */
function resolveImmediateEndTurn(side){
  if(S.over) return false;
  if(side === 'p' && S.phase === 'player'){ endPlayerTurn(); return true; }
  playerOf(side).forceEndTurn = true;                    // AI 侧：由 startAiTurn() 消费（见上）
  return false;
}

/* ==== 新增辅助函数（apply-fx 插入） ==== */
function onboardHasUnitId(side, id){
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const x = S.board[r][c];
    if(x && x.owner === side && !x.inhibited && x.def && x.def.id === id) return true;
  }
  return false;
}

function isTurnOf(side){
  if(side === 'p') return S.phase === 'player';
  if(side === 'a') return S.phase === 'ai';
  return false;
}

function tiger2Blocked(casterSide, u){
  if(!u || !u.def) return false;
  if(u.owner === casterSide) return false;
  const pos = findPosOf(u);
  if(!pos || pos.r !== backRowOf(u.owner)) return false;
  return onboardHasUnitId(u.owner, '虎王');
}

function m26Frontline(side){
  for(let c=0;c<COLS;c++){
    const x = S.board[1][c];
    if(x && x.owner === side && !x.inhibited && x.def && x.def.id === 'M26潘兴') return true;
  }
  return false;
}

/* ==== 新增辅助函数（apply-fx 插入） ==== */
function r2UnitDef(nation, id){
  const nat = NATIONS[nation];
  if(!nat) return null;
  const raw = (nat.units || []).find(u => u.id === id || u.n === id);
  return raw ? mkUnitDef(raw, nation) : null;
}

function r2TopDeckFreeCopies(player, nation, id, n){
  let added = 0;
  for(let i=0;i<n;i++){
    const def = r2UnitDef(nation, id);
    if(!def) break;
    def.blood = 0;   // 部署花费
    def.fuel  = 0;   // 行动花费（油费）
    def.desc = '花费 0、行动花费 0；' + (def.desc || '');
    player.deck.push(def); // 卡组顶 = 牌堆末尾（drawCards 从末尾抽）
    added++;
  }
  return added;
}

function r2AddUnitToHand(player, excl, nation, id, n){
  let added = 0;
  for(let i=0;i<n;i++){
    if(handFree(player, excl) <= 0){ logMsg('手牌已满（9张），「' + id + '」无法加入手中。'); break; }
    const def = r2UnitDef(nation, id);
    if(!def) break;
    handPushRevealed(player, def);
    added++;
  }
  return added;
}

function r2AddFreeCloneToHand(player, excl, nation, id, n){
  let added = 0;
  for(let i=0;i<n;i++){
    if(handFree(player, excl) <= 0){ logMsg('手牌已满（9张），「' + id + '」无法加入手中。'); break; }
    const def = r2UnitDef(nation, id);
    if(!def) break;
    def.blood = 0;
    def.fx = (def.fx || []).concat(['a6m2Clone']); // fx 是 mkUnitDef 里 slice 出的新数组，就地 push 不会污染 NATIONS
    def.desc = '花费 0；亡计：将 1 张本单位的复制加入手中，使其花费为 0。' + (def.desc ? '；' + def.desc : '');
    handPushRevealed(player, def);
    added++;
  }
  return added;
}

function r2CloneToHand(u){
  if(!u || !u.def) return false;
  const owner = playerOf(u.owner);
  if(owner.hand.length >= MAX_HAND){ logMsg(u.def.n + ' 亡计：手牌已满，复制无法加入手中。'); return false; }
  const copy = JSON.parse(JSON.stringify(u.def)); // 深拷贝：保留 fx（含 a6m2Clone）、target/deploy 等原字段
  copy.blood = 0;
  copy.kind = 'unit';
  handPushRevealed(owner, copy);
  logMsg(u.def.n + ' 亡计：将 1 张本单位的复制加入手中（花费为 0）。');
  return true;
}

function r2ClearHqSmoke(side){
  const me = playerOf(side);
  if(!me || !me.hqSmoke) return false;
  me.hqSmoke = false;
  logMsg('深水炸弹：友方总部的烟幕散去。');
  return true;
}

/* ==== 新增辅助函数（apply-fx 插入） ==== */
function rangerBoost(srcU, dmg){
  // 【batch-E3】游骑兵营：友方单位造成的非对战、非攻击伤害 +1。
  // 口径：srcU = 造成伤害的**友方单位**（缺省 = 非单位来源，不加成）；
  // 「非对战、非攻击」由**调用点**保证 —— combat() 内的伤害一律不传 srcU（攻击/对战伤害），
  // 只有部署效果 / 亡计 / 单位触发类效果的出口才传 srcU（13 处清单见 HOOK-6）。
  if(!srcU || !srcU.def || dmg <= 0) return dmg;
  return onboardHasFx(srcU.owner, 'rangerAura') ? dmg + 1 : dmg;
}

function abilityHqDamage(srcU, foe, dmg){
  // 【batch-E3】单位能力造成的总部伤害统一出口：与既有 foe.hp -= N + checkGameOver() 行为等价，
  // 只是在扣血前过一遍 rangerBoost（游骑兵营不在场时 d === dmg，行为与原实现逐字一致）。
  // 口径（用户 2026-09-13 追加）：单位能力的总部伤害同样必须过 applyHqDamage 总入口
  //（M6/593/西苏/柏林之路/HMS 等减免与记账照常生效）；applyHqDamage 内部自己会 checkGameOver，
  // 故此处不再重复调用。
  if(!foe || dmg <= 0) return 0;
  const d = rangerBoost(srcU, dmg);
  if(d !== dmg) logMsg('游骑兵营：友方单位造成的非对战、非攻击伤害 +1（' + dmg + ' → ' + d + '）。');
  applyHqDamage(foe, d);
  return d;
}

/* ==== 新增辅助函数（apply-fx 插入） ==== */
function r4HandCostPlus(player, n){
  if(!player || !Array.isArray(player.hand)) return 0;
  let k = 0;
  for(const c of player.hand){ if(!c) continue; c.handCostPlus = (c.handCostPlus || 0) + n; k++; }
  return k;
}

function r4ReturnHandToDeckTop(player, max){
  if(!player || !Array.isArray(player.hand)) return 0;
  let n = 0;
  for(const c of player.hand.slice()){ if(c && (c.blood || 0) <= max && handCardToDeckTop(player, c)) n++; }
  return n;
}

function r4ReturnBoardToDeckTop(side, max){
  const list = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(u && u.owner === side && (u.def.blood || 0) <= max) list.push({ u:u, r:r, c:c });
  }
  let n = 0;
  for(const t of list){
    if(S.board[t.r][t.c] !== t.u) continue;   // 快照后已被别的效果挪走 → 跳过
    S.board[t.r][t.c] = null;
    playerOf(t.u.owner).deck.push(JSON.parse(JSON.stringify(t.u.def)));
    n++;
  }
  return n;
}

/* ==== 新增辅助函数（apply-fx 插入） ==== */
function isTankUnit(u){
  if(!u || !u.def) return false;
  return u.def.t === 'tank' || hasFx(u,'alsoTank');
}

function orderPickUnit(tgt, filter){
  const d0 = tgt ? unitAt(tgt.row, tgt.col) : null;
  if(d0 && filter(d0)) return d0;
  const cand = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const x = S.board[r][c]; if(x && filter(x)) cand.push(x); }
  return cand.length ? cand[Math.floor(Math.random()*cand.length)] : null;
}
/* 预选目标是否「类型合格」（用户 2026-09-13 的 target:'any' 兜底用）：
   ① 无预选（tgt 为空）→ true：交给 orderPickUnit 的随机兜底（AI/无头不卡住）；
   ② 预选是总部（tgt.hq）→ false（单位类效果不能指向总部；cards.js 的 orderTargets 也不产出总部条目）；
   ③ 预选指向棋盘上不存在的格/单位 → false（不是合法单位）；
   ④ 其余 → 按各卡自己的类型谓词 filter 判定。
   用途：让 10 张改判 'any' 的卡在「预选非法」时 toast + return false（卡不消耗），
   而不是被 orderPickUnit 的随机兜底悄悄改指到另一个单位。 */
function orderTgtValid(tgt, filter){
  if(!tgt) return true;
  if(tgt.hq) return false;
  const u = unitAt(tgt.row, tgt.col);
  if(!u) return false;
  return !!filter(u);
}

function retreatUnit(u){
  if(!u) return null;
  const pos = findPosOf(u);
  if(!pos) return null;
  if(pos.r === 1){                                    // 前线单位：优先退到己方支援阵线空位
    const slot = emptyBacklineSlot(u.owner);
    if(slot){
      S.board[pos.r][pos.c] = null;
      S.board[slot.row][slot.col] = u;
      syncRowSig(u);                                  // 三式中战车：撤至支援阵线 → 重获伏击/守护
      return 'back';
    }
  }
  S.board[pos.r][pos.c] = null;                        // 支援阵线已满 / 本就在支援阵线 → 返回手牌
  if(handReturnsToHand(u.owner, u.def, { row:pos.r, col:pos.c })) return 'hand';
  HOOKS.onCardBurst(u.def, u.owner);                   // 满手爆牌：撤退单位丢失
  return 'lost';
}

/* ==== 新增辅助函数（apply-fx 插入） ==== */
function f4TurnEndSettle(side){
  const me = playerOf(side);
  // ① BP-43装甲列车
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const u = S.board[r][c];
    if(!u || u.owner !== side || !hasFx(u,'bp43LightInf')) continue;
    let slot = -1;
    for(let c2=0;c2<COLS;c2++) if(!S.board[r][c2]){ slot = c2; break; }
    if(slot >= 0){
      const def = makeDerived('lightinf');
      if(def && spawnUnit(side, def, r, slot)) logMsg(u.def.n + '：友方回合结束，1 张「轻步兵」加入同一阵线。');
      else logMsg(u.def.n + '：友方回合结束，「轻步兵」加入失败。');
    } else logMsg(u.def.n + '：友方回合结束，同一阵线已满，「轻步兵」无法加入。');
  }
  // ② 最后一击
  if(me.lastStrikeUnits && me.lastStrikeUnits.length){
    for(const u of me.lastStrikeUnits){
      const p = findPosOf(u);
      if(p){ logMsg('最后一击：回合结束，' + u.def.n + ' 被消灭。'); killUnit(p.r, p.c); }
    }
    me.lastStrikeUnits = [];
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
  HOOKS, S, GAME_RULES, DECK_OVERRIDE, setDeckOverride, getDeckOverride, setGAME_RULES_OFF,
  newPlayer, mkBoard, buildDeck, mkUnitDef, mkOrderDef, mkCounterDef,
  makeUnit, hasSig, hasFx, spawnUnit, applyDeploy, emptyBacklineSlot, moveForward,
  killUnit, attackTargets, canAct, combat, uNeedRetal, applyHqDamage, unitAt,
  applyInhibit, applyPanzerGrowth, actFuelCost, atkOf,
  resolveChoice, cancelChoice, gordonResolve, cancelGordon, spawnF2As, doMulligan,
  buildBossDeck, buildTearsDeck, buildAlpsDeck, bossRevive, alpsOpening, memeBossTurn,
  setBossKind, getBossKind, addLightInfantryToHand, triggerR25, triggerFriendlyTurnEnd, r75Targeted,
  playCost, targetSurcharge, collectNations, coopCheck, checkEnemyDeployDmg, deployCanTarget, clearTurnBuffs,
  discardPickResolve, cancelDiscardPick, handToDeckResolve, cancelHandToDeck,
  eng109Buff, resolveBridgeTooFar, resolveSecondFront, f4TurnEndSettle, retreatUnit, resolveImmediateEndTurn,
  promoteR7, promoteToVeteran, checkTank12Veteran, resolveFirstResponse,
  countEnemy, enemyList, allyList, orderEffect, activateCounter, canAfford, drawCards,
  checkGameOver, endGame, resetGameState, startGame, resetUnitFlags, clearSuppress,
  beginPlayerTurn, showDrawChoice, hideDrawChoice, endPlayerTurn, startAiTurn,
  orderTargets, applySuppress, deployPickValid, handPushRevealed,
  aiResearchPick, aiResearchPickN, HANA_RESEARCH_WANT,
  resolveOwnerTurnStart, syncRowSig, intelDeploy, makeProduceDef, EXTRA_ORDER_EFFS, handFree,
  deployBlocked, checkKi61Auto, checkGuard216, findUnitByUid, recordHit,
  enemyOf, playerOf, nationOf, backRowOf, isArmyType, canBypassGuard,
  shuffle, uid, MAX_HAND, ROWS, COLS, OIL_DEF,
  logMsg, sfx, toast, render
};
}
