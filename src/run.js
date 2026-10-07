'use strict';
/* ============================================================
   开始游戏（原「征程之路」）—— 逻辑层（src/run.js）
   流程：选主国（初始卡背）→ 选盟国 → 10 次三选一抽卡定卡组
        → 三张地图（杀戮尖塔式分支路线）→ 全灭 3 个 Boss 通关
   纯逻辑层：
   · 顶层零 DOM 访问（不碰 document/window/localStorage），Node 安全；
   · 依赖全局符号：NATIONS/SIGINFO、buildDeck（小怪＝自由对战口径）、
     buildBossDeck、mkUnitDef/mkOrderDef/mkCounterDef；
   · UI 层（runui.js）按本文件 API 契约调用，本文件不碰 DOM。
   ============================================================ */

/* ---------- 运行状态（全局唯一；runReset 还原默认） ---------- */
const RUN = { active:false, phase:'idle', nation:null, ally:null, deck:[],
  mapIdx:0, cur:null, curRow:-1, hq:20, hqMax:20,
  maps:[], bossOrder:[],
  _draftRound:0, _draftOpts:[], _fuseSel:[], _fightNode:null, _usedEv:{} };
RUN._sac = { step:null, sacIdx:-1 };   /* 献祭两步状态（内部） */

/* ---------- 常量池 ---------- */
const RUN_DRAFT_N = 20;                        /* 抽卡次数：20 次三选一 */
const RUN_MAP_ROWS = [2,3,3,2];                /* 每张地图的节点行宽（杀戮尖塔式分支） */
const RUN_BOSSES = ['tears','alps','meme','hana'];   /* 常规三 Boss + 最终 Boss（hana 固定镇守最后一张地图，见 runMapInit） */
const RUN_BOSS_META = {
  tears:{ name:'梦之泪伤',     nation:'us', blurb:'美国水牛卡组 · 两条命 · 虚空印卡' },
  alps: { name:'阿尔卑斯要塞', nation:'us', blurb:'美德快攻卡组 · 开局弃牌 · 闪电铺场' },
  meme: { name:'北北布次香菜', nation:'jp', blurb:'日美合流 · 不携带卡牌 · 全程固定行动' },
  hana: { name:'hana',         nation:'us', blurb:'最终 Boss · 三条命 · 五国研发起手 · 40 张随机金卡' }
};
const RUN_ELITE_BONUS = {                      /* 精英关：按敌方国家给加成（小怪关无加成） */
  de:{ text:'德国精英：所有坦克 +2/+2' },
  jp:{ text:'日本精英：所有飞机部署费 -1' },
  us:{ text:'美国精英：开局 2 个指挥点槽' },
  gb:{ text:'英国精英：所有单位 +2 生命' },
  su:{ text:'苏联精英：所有单位重甲 1' }
};
const RUN_EVENT_WEIGHTS = { add:2, remove:1.2, upgrade:1.6, sacrifice:1, fusion:1, choice:1.5 };
/* 节点展示元数据 */
const RUN_NODE_META = {
  fight:{ name:'遭遇战', icon:'⚔️' }, elite:{ name:'精英战', icon:'⚙️' }, boss:{ name:'Boss', icon:'🏰' },
  add:{ name:'增援', icon:'➕' }, remove:{ name:'整编', icon:'➖' }, upgrade:{ name:'兵工厂', icon:'🔧' },
  sacrifice:{ name:'祭坛', icon:'🕯' }, fusion:{ name:'熔炉', icon:'⚒️' },
  choice:{ name:'抉择', icon:'⚖️' }
};

/* ---------- 本地工具（函数声明，避免与引擎全局重名） ---------- */
function runShuffle(a){ const b = a.slice(); for(let i=b.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [b[i],b[j]]=[b[j],b[i]]; } return b; }
function runRand(n){ return Math.floor(Math.random()*n); }
function uniqArr(a){ const out=[]; a.forEach(x=>{ if(out.indexOf(x)<0) out.push(x); }); return out; }
function runWeightedPick(weights){
  const keys = Object.keys(weights);
  let total = 0; keys.forEach(k=>total += weights[k]);
  let r = Math.random() * total;
  for(const k of keys){ r -= weights[k]; if(r <= 0) return k; }
  return keys[0];
}
function deckCard(i){ return RUN.deck[i] || null; }
function deckName(i){ const d = deckCard(i); return d ? d.n : '?'; }
/* 国家卡池条目（含国家键：defOf 需要） */
function nationCardList(key){
  const n = NATIONS[key];
  if(!n) return [];
  const out = [];
  n.units.forEach(u=>out.push({ kind:'unit', d:u, key }));
  n.orders.forEach(o=>out.push({ kind:'order', d:o, key }));
  n.counters.forEach(c=>out.push({ kind:'counter', d:c, key }));
  return out;
}
function defOf(key, e){ return e.kind==='unit' ? mkUnitDef(e.d,key) : (e.kind==='order' ? mkOrderDef(e.d,key) : mkCounterDef(e.d,key)); }

/* ============================================================
   开局抽卡：选主国/盟国 → 10 次三选一 → 定卡组
   ============================================================ */
function runBeginDraft(mainKey, allyKey){
  runReset();
  RUN.active = true;
  RUN.phase = 'draft';
  RUN.nation = mainKey || null;
  RUN.ally = (allyKey && allyKey !== mainKey) ? allyKey : null;
  RUN.deck = [];
  RUN._draftRound = 0;
  RUN._draftOpts = [];
  return RUN;
}
/* 主国+盟国合并卡池 */
function runDraftPool(){
  const out = [];
  [RUN.nation, RUN.ally].forEach(k=>{ if(NATIONS[k]) nationCardList(k).forEach(e=>out.push(e)); });
  return out;
}
/* 下一轮三选一：{round,total,options:[{def,from}]}；draft 终结返回 {done:true} */
function runDraftNext(){
  if(RUN.phase !== 'draft') return null;
  const round = RUN._draftRound + 1;
  if(round > RUN_DRAFT_N) return { done:true, round, total:RUN_DRAFT_N };
  const pool = runDraftPool();
  const p = pool.slice();
  const opts = [];
  while(opts.length < 3 && p.length){
    const i = runRand(p.length);
    const e = p.splice(i,1)[0];
    opts.push({ def: defOf(e.key, e), from: e.key });
  }
  RUN._draftOpts = opts;
  return { round, total:RUN_DRAFT_N, options: opts };
}
/* 取走当前轮的第 i 张 → 下一轮；全部取完返回 done → UI 调 runMapInit */
function runDraftPick(i){
  if(RUN.phase !== 'draft') return { text:'还没到抽卡阶段。', close:true };
  const o = RUN._draftOpts[i];
  if(!o) return { text:'无效的选择。', close:false };
  RUN.deck.push(JSON.parse(JSON.stringify(o.def)));
  RUN._draftRound++;
  RUN._draftOpts = [];
  const done = RUN._draftRound >= RUN_DRAFT_N;
  return { text: done ? '「'+o.def.n+'」入列——卡组已定（'+RUN.deck.length+' 张）' : '「'+o.def.n+'」加入卡组（'+(RUN._draftRound)+'/'+RUN_DRAFT_N+'）', close:true, done };
}

/* ============================================================
   地图：三张图，每张 = 数行节点（分支）+ 关底 Boss
   ============================================================ */
function runMapInit(){
  RUN.phase = 'map';
  RUN.mapIdx = 0;
  RUN.cur = null; RUN.curRow = -1;
  // 三张地图的 Boss：前两张从常规三位里随机，**最后一张固定是最终 Boss「hana」**（用户 2026-09-17：征程少了最终 Boss）
  const RUN_BOSS_POOL = RUN_BOSSES.filter(k => k !== 'hana');
  RUN.bossOrder = runShuffle(RUN_BOSS_POOL.slice()).slice(0, 2).concat(['hana']);
  RUN.maps = [0,1,2].map(mi => runGenMap(mi));
  return RUN;
}
function runGenMap(mi){
  const rows = [];
  let hasElite = false;
  for(let r=0;r<RUN_MAP_ROWS.length;r++){
    const row = [];
    for(let c=0;c<RUN_MAP_ROWS[r];c++){
      const nd = runMakeNode(mi, r, c);
      if(nd.type==='elite') hasElite = true;
      row.push(nd);
    }
    rows.push(row);
  }
  if(!hasElite && rows.length){                       /* 保底：每图至少 1 个精英关 */
    const t = rows[rows.length-1][0];
    t.type = 'elite'; t.icon = RUN_NODE_META.elite.icon; t.name = RUN_NODE_META.elite.name;
    t.nation = runRandomNation();
    t.bonusText = RUN_ELITE_BONUS[t.nation] || RUN_ELITE_BONUS.de;
  }
  /* 分支：节点链接到下一行最近的 1-2 个节点 */
  for(let r=0;r<rows.length-1;r++){
    const w = RUN_MAP_ROWS[r], w2 = RUN_MAP_ROWS[r+1];
    rows[r].forEach((nd)=>{
      const pos = w>1 ? nd.col/(w-1) : 0;
      const t = Math.round(pos * (w2-1));
      nd.edges.push(rows[r+1][t].id);
      if(w2>1 && Math.random()<0.55){
        const alt = t + (Math.random()<0.5?-1:1);
        if(alt>=0 && alt<w2 && rows[r+1][alt].id !== nd.edges[nd.edges.length-1]) nd.edges.push(rows[r+1][alt].id);
      }
    });
  }
  /* 兜底：下一行每个节点至少 1 条入边 */
  for(let r=1;r<rows.length;r++){
    rows[r].forEach((n2)=>{
      const hasIn = rows[r-1].some(n1 => (n1.edges||[]).includes(n2.id));
      if(!hasIn){
        const w1 = RUN_MAP_ROWS[r-1];
        const j = Math.min(w1-1, Math.round((n2.col/(RUN_MAP_ROWS[r]-1||1))*(w1-1)));
        rows[r-1][j].edges.push(n2.id);
      }
    });
  }
  const bossKind = RUN.bossOrder[mi] || 'tears';
  const bmeta = RUN_BOSS_META[bossKind] || RUN_BOSS_META.tears;
  const boss = { id:'m'+mi+'-boss', row:rows.length, col:0, type:'boss', done:false, edges:[],
    bossKind, name:bmeta.name, blurb:bmeta.blurb, icon:RUN_NODE_META.boss.icon, nation:bmeta.nation };
  const last = rows[rows.length-1];
  last.forEach(nd=>nd.edges.push(boss.id));            /* 末行全部汇合到 Boss */
  return { mi, rows, boss };
}
function runMakeNode(mi, r, c){
  let type;
  if(r === 0) type = 'fight';
  else {
    const W = (r === RUN_MAP_ROWS.length-1)
      ? { fight:1.6, elite:1.2, event:1.8 }
      : { fight:2.6, elite:0.7, event:1.9 };
    type = runWeightedPick(W);
  }
  if(type === 'event') type = runEventKind(mi);        /* 事件节点：落实具体类型 */
  const id = 'm'+mi+'-r'+r+'-c'+c;
  const meta = RUN_NODE_META[type] || { name:type, icon:'❓' };
  const nd = { id, row:r, col:c, type, done:false, edges:[], name:meta.name, icon:meta.icon, data:{} };
  if(type==='fight' || type==='elite'){
    /* 三类关卡的敌方来源（用户 2026-09-13 口径，不再依赖战役关卡数据）：
       小怪 = 套用自由对战（随机敌方国家 + 原版卡组、无加成）；
       精英 = 同样随机国家 + 该国家的精英增益（RUN_ELITE_BONUS，见 runEliteBonus）；
       Boss = 打 Boss（runGetFight 里走 buildBossDeck + 既有 Boss 脚本）。 */
    nd.nation = runRandomNation();
    if(type==='elite') nd.bonusText = RUN_ELITE_BONUS[nd.nation] || RUN_ELITE_BONUS.de;
  }
  return nd;
}
/* 随机敌方国家（自由对战口径：五国里随机，避开玩家主国/盟国；盟国不能当敌方主国） */
function runRandomNation(){
  const all = Object.keys(NATIONS || {});
  const mains = all.filter(k => !(NATIONS[k] && NATIONS[k].allyOnly));
  const pool = mains.filter(k => k !== RUN.nation && k !== RUN.ally);
  const p = pool.length ? pool : (mains.length ? mains : all);
  return p[Math.floor(Math.random()*p.length)] || 'de';
}
function runEventKind(mi){
  /* 每种事件在一张地图里最多出现 2 次，保证多样性 */
  const mkey = 'm' + mi;
  for(let t=0;t<10;t++){
    const k = runWeightedPick(RUN_EVENT_WEIGHTS);
    const used = (RUN._usedEv[mkey] || {})[k] || 0;
    if(used < 2){ RUN._usedEv[mkey] = RUN._usedEv[mkey]||{}; RUN._usedEv[mkey][k] = used+1; return k; }
  }
  return 'add';
}
function runMapNode(id){
  const maps = RUN.maps || [];
  for(const map of maps){
    if(!map) continue;
    for(const row of map.rows) for(const nd of row) if(nd.id === id) return nd;
    if(map.boss && map.boss.id === id) return map.boss;
  }
  return null;
}
/* 当前可到达节点 id 列表（首行任意；之后沿当前节点的边） */
function runReachable(){
  const map = RUN.maps && RUN.maps[RUN.mapIdx];
  if(!map) return [];
  if(!RUN.cur) return map.rows[0].map(nd=>nd.id);
  return (RUN.cur.edges || []).slice();
}
/* 进入节点：事件 → {kind:'event',node,view}；战斗 → {kind:'battle',node}；不可达 → null */
function runNodeEnter(id){
  const nd = runMapNode(id);
  if(!nd || nd.done) return null;
  if(!runReachable().includes(id)) return null;
  if(nd.type==='fight' || nd.type==='elite' || nd.type==='boss'){
    RUN._fightNode = nd;
    return { kind:'battle', node:nd };
  }
  const view = runEventView(nd);
  return { kind:'event', node:nd, view };
}
/* 节点完成：打勾，当前位置前移 */
function runNodeDone(id){
  const nd = runMapNode(id);
  if(!nd) return;
  nd.done = true;
  RUN.cur = nd;
  RUN.curRow = nd.row;
  return nd;
}

/* ============================================================
   战斗配置：runGetFight(node) → {kind,nation,difficulty,deck,bossKind,bonusText,name}
   · 小怪关：套用自由对战 —— 随机敌方国家 + 原版卡组（buildDeck），无任何加成
   · 精英关：同样随机国家 + 该国家的精英加成（runEliteBonus 改敌方卡组）
   · Boss 关：沿用 Boss 挑战（setBossKind + buildBossDeck + 双命/开局脚本/固定行动）
   （用户 2026-09-13：不再使用战役关卡数据）
   ============================================================ */
function runGetFight(node){
  if(node.type === 'boss'){
    const kind = node.bossKind || RUN.bossOrder[RUN.mapIdx] || 'tears';
    const meta = RUN_BOSS_META[kind] || RUN_BOSS_META.tears;
    const deck = (typeof buildBossDeck === 'function') ? buildBossDeck(kind) : [];
    return { kind:'boss', bossKind:kind, nation:meta.nation, name:meta.name, blurb:meta.blurb,
      difficulty:'marshal', deck:Array.isArray(deck)?deck:[], bonusText:null };
  }
  const nation = node.nation || runRandomNation();
  const deck = (typeof buildDeck === 'function') ? buildDeck(nation) : [];
  if(node.type === 'elite'){
    return { kind:'elite', nation, name:'精英部队',
      difficulty:'warder', deck:runEliteBonus(nation, deck),
      bonusText:(RUN_ELITE_BONUS[nation]||{}).text||null };
  }
  return { kind:'fight', nation, name:'遭遇战',
    difficulty:'veteran', deck, bonusText:null };
}
/* 精英加成：在敌方卡组定义上就地改造（定义带 kind/t/atk/hp/blood/armor） */
function runEliteBonus(nation, deck){
  if(!Array.isArray(deck) || !nation) return deck||[];
  return deck.map(c=>{
    if(!c || c.kind !== 'unit') return c;                 /* 只有单位受加成 */
    const d = JSON.parse(JSON.stringify(c));
    if(nation==='de' && d.t==='tank'){ d.atk=(d.atk||0)+2; d.hp=(d.hp||0)+2; }
    if(nation==='jp' && (d.t==='fighter'||d.t==='bomber')){ d.blood=Math.max(1,(d.blood||0)-1); }
    if(nation==='gb'){ d.hp=(d.hp||0)+2; }
    if(nation==='su'){ d.armor=(d.armor||0)+1; }
    return d;
  });
}

/* ============================================================
   事件视图 / 选择（契约同旧版：{title,text,choices}；choice 返回 {text,close}）
   ============================================================ */
function runEventView(node){
  if(!node) return null;
  switch(node.eventType || node.type){
    case 'add':       return addView(node);
    case 'remove':    return removeView(node);
    case 'upgrade':   return upgradeView(node);
    case 'sacrifice': return sacrificeView(node);
    case 'fusion':    return fusionView(node);
    case 'choice':    return choiceView(node);
    case 'boss':      return null;
    default:          return { title:'未知', text:'前方的路被迷雾吞没。', choices:[{id:'ok',label:'继续前进'}] };
  }
}
function runChoice(node, cid){
  if(!node) return { text:'未知事件。', close:true };
  switch(node.eventType || node.type){
    case 'add':       return choiceAdd(node, cid);
    case 'remove':    return choiceRemove(node, cid);
    case 'upgrade':   return choiceUpgrade(node, cid);
    case 'sacrifice': return choiceSacrifice(node, cid);
    case 'fusion':    return choiceFusion(node, cid);
    case 'choice':    return choiceCamp(node, cid);
  }
  return { text:'无效的选择。', close:false };
}

/* ---------- 增援：主/盟国池随机 3 张选 1 加入（金币已取消） ---------- */
function addView(node){
  if(!node.data.offers) node.data.offers = runAddOffers();
  const choices = node.data.offers.map((o,i)=>({ id:'take:'+i, label:o.def.n }));
  choices.push({ id:'skip', label:'空手离开' });
  return { title:'增援', text:'一辆落单的军需卡车。车厢里躺着三张卡，没人认领。', choices };
}
function runAddOffers(){
  const p = runDraftPool();
  const out = [];
  while(out.length < 3 && p.length){ const i = runRand(p.length); out.push(p.splice(i,1)[0]); }
  return out.map(e=>{ const d = defOf(e.key, e); return { def:d, from:e.key, ref:e.key+':'+d.id }; });
}
function choiceAdd(node, cid){
  if(cid === 'skip') return { text:'你合上车厢，继续赶路。', close:true };
  const m = /^take:(\d+)$/.exec(cid);
  if(m){
    const o = (node.data.offers||[])[+m[1]];
    if(!o) return { text:'那张卡已经被拿走了。', close:false };
    RUN.deck.push(JSON.parse(JSON.stringify(o.def)));
    return { text:'「'+o.def.n+'」加入卡组（当前 '+RUN.deck.length+' 张）。', close:true };
  }
  return { text:'无效的选择。', close:false };
}

/* ---------- 整编：删除一张卡 ---------- */
function removeView(node){
  return { title:'整编', text:'清点编制。选一张卡从卡组中除名（这支队伍不需要累赘）。',
    choices: RUN.deck.map((d,i)=>({ id:'card:'+i, label:d.n })).concat([{ id:'cancel', label:'算了' }]) };
}
function choiceRemove(node, cid){
  if(cid === 'cancel') return { text:'你收起了花名册。', close:true };
  const m = /^card:(\d+)$/.exec(cid);
  if(m){
    const i = +m[1];
    const d = deckCard(i);
    if(!d) return { text:'无效的选择。', close:false };
    RUN.deck.splice(i,1);
    return { text:'「'+d.n+'」被划去（剩余 '+RUN.deck.length+' 张）。', close:true };
  }
  return { text:'无效的选择。', close:false };
}

/* ---------- 兵工厂：强化一张卡（+1/+1 或 费用-1） ---------- */
function upgradeView(node){
  if(node.data.step !== 'opt'){
    const base = { title:'兵工厂', text:'高炉与钳台作响。选一张卡，让它变得趁手。',
      choices: RUN.deck.map((d,i)=>({ id:'card:'+i, label:d.n })).concat([{ id:'cancel', label:'离开' }]) };
    return base;
  }
  return { title:'兵工厂', text:'强化「'+deckName(node.data.cardIdx)+'」：', choices:[
    { id:'opt:stat', label:'+1/+1' }, { id:'opt:cost', label:'部署费用 -1' }, { id:'cancel', label:'取消' } ] };
}
function choiceUpgrade(node, cid){
  if(cid === 'cancel'){ node.data.step = null; node.data.cardIdx = undefined; return { text:'你放下了钳子。', close:true }; }
  const m = /^card:(\d+)$/.exec(cid);
  if(m){
    const i = +m[1];
    const d = deckCard(i);
    if(!d) return { text:'无效的选择。', close:false };
    node.data.step = 'opt'; node.data.cardIdx = i;
    return { text:'「'+d.n+'」被夹上台钳。选一种强化方式：', close:false };
  }
  if(cid==='opt:stat' || cid==='opt:cost'){
    if(node.data.step !== 'opt' || node.data.cardIdx===undefined) return { text:'请先选择一张卡。', close:false };
    const d = deckCard(node.data.cardIdx);
    if(!d) return { text:'选择已失效。', close:false };
    node.data.step = null; node.data.cardIdx = undefined;
    if(cid==='opt:stat'){ d.atk=(d.atk||0)+1; d.hp=(d.hp||0)+1; return { text:'铁锤落。「'+d.n+'」+1/+1。', close:true }; }
    d.blood = Math.max(0,(d.blood||0)-1);
    return { text:'铁锤落。「'+d.n+'」的部署费用 -1。', close:true };
  }
  return { text:'无效的选择。', close:false };
}

/* ---------- 祭坛：献祭一张单位，另一张获得它的特效与词条 ---------- */
function sacrificeView(node){
  if(node.data.step !== 'target'){
    const base = { title:'祭坛', text:'石台上刻着古文字。选一张单位卡献祭：它的特效与词条将渡到另一张卡上。',
      choices: RUN.deck.map((d,i)=>({ id:'card:'+i, label:d.n })).concat([{ id:'cancel', label:'离开' }]) };
    return base;
  }
  const d = deckCard(node.data.sacIdx);
  const txs = (d ? ((d.fx||[]).concat(d.sig||[])) : []);
  const txTxt = d ? ((d.fx||[]).map(f=>UNIT_FX_TEXT[f]||f).join('、') + (d.sig||[]).map(s=>SIGINFO[s]?SIGINFO[s].n:s).join('、')).slice(0,40) : '';
  return { title:'祭坛', text:'指定「'+deckName(node.data.sacIdx)+'」延续其力量给……（'+txTxt+'）',
    choices: RUN.deck.map((d,i)=>({ id:'card:'+i, label:d.n })).concat([{ id:'cancel', label:'作罢' }]) };
}
function choiceSacrifice(node, cid){
  if(cid === 'cancel'){ node.data.step = null; node.data.sacIdx = -1; return { text:'你离开了祭坛。', close:true }; }
  const m = /^card:(\d+)$/.exec(cid);
  if(m){
    const i = +m[1];
    const d = deckCard(i);
    if(!d) return { text:'无效的选择。', close:false };
    if(node.data.step !== 'target'){
      if(d.kind !== 'unit') return { text:'只有单位卡承载着可渡让的词条。', close:false };
      node.data.step = 'target'; node.data.sacIdx = i;
      return { text:'「'+d.n+'」被缚在祭坛上……再选一张承受者。', close:false };
    }
    const sac = deckCard(node.data.sacIdx);
    if(!sac) { node.data.step = null; node.data.sacIdx = -1; return { text:'祭品不见了。', close:false }; }
    if(i === node.data.sacIdx) return { text:'不能献祭给自己。', close:false };
    if(d.kind !== 'unit') return { text:'只有单位卡才能承受词条。', close:false };
    d.fx = uniqArr((d.fx||[]).concat(sac.fx||[]));
    d.sig = uniqArr((d.sig||[]).concat(sac.sig||[]));
    RUN.deck.splice(node.data.sacIdx, 1);
    node.data.step = null; node.data.sacIdx = -1;
    return { text:'祭坛的火焰腾起。「'+d.n+'」继承了「'+sac.n+'」的特效与词条。', close:true };
  }
  return { text:'无效的选择。', close:false };
}

/* ---------- 熔炉：两张相同的卡融合成一张更强的 ----------
   用户 2026-09-17 口径：
     · **只列卡组里有重复的卡**（相同的单位 或 相同的指令；反制不参与熔炉）
     · 点卡 = 选中，**再点一次 = 取消选择**
     · 卡组里没有重复时：让玩家自己从卡组挑**一张**卡熔炼（旧写法是随机挑一张，玩家看不见）
   熔铸结果：单位 = 攻/血/甲相加、词条与特效并集、花费取高；
             指令 = 两张同名合成一张更便宜的（花费 -1，最低 0）。 */
function fusionFusable(d){ return !!d && (d.kind === 'unit' || d.kind === 'order'); }
function fusionDupIds(){
  const cnt = {};
  RUN.deck.forEach(d => { if(fusionFusable(d)) cnt[d.id] = (cnt[d.id] || 0) + 1; });
  const out = {};
  Object.keys(cnt).forEach(k => { if(cnt[k] >= 2) out[k] = true; });
  return out;
}
function fusionLabel(d){
  return d.n + (d.kind === 'unit' ? '（' + (d.atk||0) + '/' + (d.hp||0) + '）' : '（指令 · ' + (d.blood||0) + ' 费）');
}
function fusionView(node){
  const dup = fusionDupIds();
  const hasDup = Object.keys(dup).length > 0;
  // 有重复 → 只列有重复的卡；没重复 → 列单位卡（单卡熔炼 +1/+1 只对单位有意义）
  const pool = RUN.deck.map((d,i)=>({ d, i }))
    .filter(x => hasDup ? (fusionFusable(x.d) && dup[x.d.id]) : (x.d.kind === 'unit'));
  return { title:'熔炉', needCards:true, cardIdx: pool.map(x => x.i),
    text: hasDup
      ? '炉膛里流淌着金色的铁水。这里只列**卡组里有重复**的卡——选两张相同的（单位或指令）熔铸成一张更强的；点错再点一次即可取消。'
      : '熔炉的火焰沉睡：卡组里没有两张相同的卡。挑一张单位卡，熔炉为它镀上 +1/+1（点错再点一次即可取消）。',
    choices: pool.map(x => ({ id:'card:'+x.i, label:fusionLabel(x.d) })).concat([{ id:'cancel', label:'离开' }]),
    fuseSel: RUN._fuseSel.slice(), fuseReady: RUN._fuseSel.length >= 2 };
}
function choiceFusion(node, cid){
  if(cid === 'cancel'){ RUN._fuseSel = []; return { text:'你离开了熔炉。', close:true }; }
  const m = /^card:(\d+)$/.exec(cid);
  if(!m) return { text:'无效的选择。', close:false };
  const i = +m[1];
  const d = deckCard(i);
  if(!d) return { text:'无效的选择。', close:false };
  const pos = RUN._fuseSel.indexOf(i);
  if(pos >= 0){                                    /* 再点一次 = 取消选择 */
    RUN._fuseSel.splice(pos, 1);
    return { text:'已把「' + d.n + '」从炉里取回（当前 ' + RUN._fuseSel.length + '/2）。', close:false };
  }
  if(!fusionFusable(d)) return { text:'反制牌不能投入熔炉。', close:false };
  if(RUN._fuseSel.length >= 2) RUN._fuseSel.shift();   /* 已满两张：顶掉最早选的那张，不用先取消 */
  RUN._fuseSel.push(i);
  const sel = RUN._fuseSel.map(k => deckCard(k)).filter(Boolean);
  if(sel.length >= 2){
    const same = sel[0].id === sel[1].id;
    return { text: same ? ('已选 2 张：' + sel[0].n + ' + ' + sel[1].n + '。点击「确认熔铸」。')
                        : ('这两张并不相同（' + sel[0].n + ' × ' + sel[1].n + '），只有相同的卡才能熔铸。'), close:false };
  }
  return { text:'已选 1 张：「' + d.n + '」。再选一张相同的（或直接单卡熔炼）。', close:false };
}
function runFuseConfirm(){
  const sel = RUN._fuseSel.map(i => ({ i:i, d:deckCard(i) })).filter(x => !!x.d);
  if(sel.length >= 2){
    const a = sel[0].d, b = sel[1].d;
    if(a.id !== b.id || !fusionFusable(a) || !fusionFusable(b)){
      RUN._fuseSel = [];
      return { text:'需要两张**相同**的单位或指令卡才能熔铸。', close:false };
    }
    RUN._fuseSel = [];
    if(a.kind === 'unit'){
      a.atk = (a.atk||0)+(b.atk||0);
      a.hp  = (a.hp||0)+(b.hp||0);
      a.blood = Math.max(a.blood||0, b.blood||0);
      a.armor = (a.armor||0)+(b.armor||0);
      a.sig = uniqArr((a.sig||[]).concat(b.sig||[]));
      a.fx  = uniqArr((a.fx||[]).concat(b.fx||[]));
      RUN.deck.splice(RUN.deck.indexOf(b),1);
      return { text:'熔炉轰鸣。「'+a.n+'」焰铸重生：现在 '+(a.atk||0)+'/'+(a.hp||0)+'。', close:true };
    }
    const before = a.blood || 0;
    a.blood = Math.max(0, before - 1);
    a.desc = (a.desc || '') + '（熔铸：花费 ' + before + '→' + a.blood + '）';
    RUN.deck.splice(RUN.deck.indexOf(b),1);
    return { text:'熔炉轰鸣。「'+a.n+'」两张合一：花费 '+before+' → '+a.blood+'。', close:true };
  }
  if(sel.length === 1){                                    /* 单卡熔炼：玩家自己挑的那张 */
    const t = sel[0].d;
    RUN._fuseSel = [];
    if(t.kind === 'unit'){
      t.atk = (t.atk||0)+1; t.hp = (t.hp||0)+1;
      return { text:'熔炉为「'+t.n+'」镀上一层 +1/+1：现在 '+(t.atk||0)+'/'+(t.hp||0)+'。', close:true };
    }
    const b0 = t.blood || 0;
    t.blood = Math.max(0, b0 - 1);
    return { text:'熔炉为「'+t.n+'」降了 1 费：'+b0+' → '+t.blood+'。', close:true };
  }
  RUN._fuseSel = [];
  return { text:'没有可以熔铸的卡。', close:true };
}

/* ---------- 抉择：从五项功能中挑一项（休整/强化/删卡/增援/熔炉） ---------- */
function choiceView(node){
  if(!node.data.fn){
    return { title:'抉择', text:'岔路口的茶棚。桌上摊着五张纸条，你只能动其中一张：',
      choices:[
        { id:'fn:rest',    label:'休整 · 总部 +3 生命' },
        { id:'fn:upgrade', label:'兵工厂 · 强化一张卡' },
        { id:'fn:remove',  label:'整编 · 删除一张卡' },
        { id:'fn:add',     label:'增援 · 三选一加入卡组' },
        { id:'fn:fusion',  label:'熔炉 · 两张相同卡熔铸' }
      ]};
  }
  switch(node.data.fn){
    case 'upgrade': return upgradeView(node);
    case 'remove':  return removeView(node);
    case 'add':     return addView(node);
    case 'fusion':  return fusionView(node);
  }
  return { title:'抉择', text:'纸条无字。', choices:[{ id:'fn:rest', label:'休整 · 总部 +3 生命' }] };
}
function choiceCamp(node, cid){
  const fn = node.data.fn;
  if(cid === 'fn:rest'){
    RUN.hq = Math.min(RUN.hqMax, RUN.hq + 3);
    return { text:'你打了个盹。总部 +3 生命（'+RUN.hq+'/'+RUN.hqMax+'）。', close:true };
  }
  if(!fn){
    const m = /^fn:(.+)$/.exec(cid);
    if(!m || !RUN_NODE_META[m[1]]) return { text:'无效的选择。', close:false };
    node.data.fn = m[1];
    return { text:'你抄起「'+RUN_NODE_META[m[1]].name+'」的纸条。', close:false };
  }
  switch(fn){
    case 'upgrade': return choiceUpgrade(node, cid);
    case 'remove':  return choiceRemove(node, cid);
    case 'add':     return choiceAdd(node, cid);
    case 'fusion':  return choiceFusion(node, cid);
  }
  return { text:'无效的选择。', close:false };
}

/* ============================================================
   战斗结算 / 重置
   · 小怪/精英胜：节点打勾，回地图
   · Boss 胜：进下一张地图；全灭 → 通关
   ============================================================ */
function runBattleWin(remainHp){
  RUN.hq = RUN.hqMax || 20;                        /* 战斗结束：总部回复满血 */
  const nd = RUN._fightNode;
  RUN._fightNode = null;
  if(nd) runNodeDone(nd.id);
  if(nd && nd.type === 'boss'){
    const bossOrder = RUN.bossOrder || [];
    const cleared = (RUN.maps||[]).filter(m=>m && m.boss && m.boss.done).length;
    if(cleared >= bossOrder.length) return { victory:true, next:false };
    return { nextMap:true, mapIdx:RUN.mapIdx + 1 };
  }
  return { victory:false, next:false };
}
function runBattleLose(){
  return { victory:false };
}
function runReset(){
  RUN.active = false;
  RUN.phase = 'idle';
  RUN.nation = null;
  RUN.ally = null;
  RUN.deck = [];
  RUN.mapIdx = 0;
  RUN.cur = null; RUN.curRow = -1;
  RUN.hq = 20; RUN.hqMax = 20;
  RUN.maps = [];
  RUN.bossOrder = [];
  RUN._draftRound = 0; RUN._draftOpts = [];
  RUN._fuseSel = [];
  RUN._fightNode = null;
  RUN._usedEv = {};
  RUN._sac.step = null; RUN._sac.sacIdx = -1;
}
function runDeckSummary(){
  return RUN.deck.map((d,i)=>{
    let line;
    if(d.kind === 'unit'){
      const parts = [ d.n, (d.atk||0)+'⚔/'+(d.hp||0)+'❤' ];
      if(d.blood) parts.push('费'+d.blood);
      if(d.fuel) parts.push('油'+d.fuel);
      if(d.armor) parts.push('重甲'+d.armor);
      if(d.sig && d.sig.length) parts.push(d.sig.map(s=>SIGINFO[s]?SIGINFO[s].n:s).join('·'));
      line = parts.join(' ');
    } else {
      line = d.n + ' 费'+(d.blood||0);
    }
    return { idx:i, def:d, line };
  });
}
function runFlagName(key){
  const M = { us:'美国', de:'德国', su:'苏联', gb:'英国', jp:'日本' };
  return M[key] || key;
}
/* 当前 / 下一张 Boss 信息（地图页展示用） */
function runBossInfo(){
  const map = RUN.maps && RUN.maps[RUN.mapIdx];
  const kind = map ? map.boss.bossKind : (RUN.bossOrder[RUN.mapIdx] || 'tears');
  return RUN_BOSS_META[kind] || RUN_BOSS_META.tears;
}

/* ---------- Node 无头加载兼容（浏览器下跳过，靠全局变量） ---------- */
if (typeof module !== 'undefined' && typeof require === 'function') {
  module.exports = { RUN, RUN_META:{ RUN_DRAFT_N, RUN_MAP_ROWS, RUN_BOSSES, RUN_ELITE_BONUS, RUN_NODE_META },
    runBeginDraft, runDraftNext, runDraftPick, runMapInit, runGenMap, runReachable, runNodeEnter, runNodeDone,
    runEventView, runChoice, runFuseConfirm, runGetFight, runEliteBonus, runBossInfo,
    runBattleWin, runBattleLose, runReset, runDeckSummary, runFlagName };
}
