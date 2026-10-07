/* ============================================================
   [v2] UI 升级层(t4)—— 主菜单 / 战役 / 组卡器 / 图鉴 / AI 难度 / 设置
   独立文件(src/v2ui.js),仅供 build.mjs 拼接(LOAD_ORDER:cards → engine → ai → ui → v2ui → main);
   零 DOM 依赖外的唯一浏览器入口,与引擎/ai/cards 文件无耦合,不声明引擎符号。
   交互点:① GAME_RULES(engine) ② setAI_DIFFICULTY(ai.js) ③ HOOKS.wait(速度倍率)
           ④ buildDeck(key,list) + DECK_OVERRIDE(engine setDeckOverride)
   数据常量(VARIANTS/DECK_RULES)在 src/cards.js。
   ============================================================ */
/* ============================================================
   [v2] UI 升级层(t4)—— 主菜单 / 战役 / 组卡器 / 图鉴 / AI 难度 / 设置
    与引擎交互点:① GAME_RULES(engine；现只剩总部生命加成 hqHpBonus) ② setAI_DIFFICULTY(ai.js) ③ HOOKS.wait(速度倍率)
   ④ buildDeck 的 list 参数 + main 层 deck override(自定义/战役卡组注入)。
   数据常量(VARIANTS/DECK_RULES)在 src/cards.js。
   ============================================================ */

/* ---------- 统一存档 v2(对齐《方案》§7.6,key=mingke-frontline-v2-save) ---------- */
const LS = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v===null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem(k); }catch(e){} }
};
const SAVE_KEY = 'mingke-frontline-v2-save';
function defaultSave(){
  return { v:2, meta:{ createdAt:Date.now(), updatedAt:Date.now() },
    deckSlots:[ {name:'',nation:null,ally:null,cards:[],auto:true,updatedAt:0},
                {name:'',nation:null,ally:null,cards:[],auto:true,updatedAt:0},
                {name:'',nation:null,ally:null,cards:[],auto:true,updatedAt:0} ],
    activeSlot:0,
    stats:{ wins:0, losses:0 },
    settings:{ lastDifficulty:'recruit', lastMode:'free', sound:true, speed:1, bgmVol:1, sfxVol:1 } };
}
function loadV2Save(){
  const d = LS.get(SAVE_KEY, null);
  const base = defaultSave();
  if(!d || d.v !== 2) return base;
  const merge = (a,b)=>{ Object.keys(b).forEach(k=>{ if(a[k]===undefined) a[k]=b[k]; }); return a; };
  merge(d.settings = d.settings||{}, base.settings);
  merge(d.stats = d.stats||{}, base.stats);
  if(!Array.isArray(d.deckSlots) || d.deckSlots.length !== 3) d.deckSlots = base.deckSlots;
  return d;
}
let SAVE = loadV2Save();
function saveV2Save(){ SAVE.meta = SAVE.meta||{}; SAVE.meta.updatedAt = Date.now(); LS.set(SAVE_KEY, SAVE); }
function mkSettings(){ return Object.assign({ sound:true, speed:1, bgmVol:1, sfxVol:1 }, SAVE.settings); }

/* 注:卡组覆盖(setDeckOverride)
   由引擎实现(src/engine.js v2 钩子),UI 直接调用,不重复声明。 */

const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* ---------- 运行时状态 ---------- */
const UI = { view:'menu', levelSel:null, codexNation:'', codexQ:'',
  codexF:{ cost:null, type:null, nation:null },   // 图鉴筛选：花费/类型/国家
  deckF:{ cost:null, type:null, nation:null },    // 组卡器筛选：花费/类型/国家
  backPrev:{},                                    // 卡背预览缓存（每次打开随机 1 张磨损图）
  deck:{ slot:0, nation:null, ally:null, ids:[], name:'', back:null, hq:null, auto:true }, decks:[] };
const PENDING = { level:null, customDeck:null, boss:false };   // 出战上下文:关卡(征程用) / 自定义卡组 / Boss 挑战
let LAST_BOSS = null;                               // 上一局 Boss 种类('tears'/'alps'，供「再战」）
let wipeArmed = false;

/* ---------- 视图切换 ---------- */
function showView(name){
  UI.view = name;
  [['menu','ovMenu'],['nation','ovNation'],['deck','ovDeck'],['codex','ovCodex'],['boss','ovBoss']].forEach(([n,id])=>{
    $(id).classList.toggle('hidden', n !== name);
  });
  $('overlay').classList.remove('hidden');
}

/* Boss 挑战选择界面：梦之泪伤 / 阿尔卑斯要塞 */
function showBossPick(){
  $('ovBossTitle').textContent = 'Boss 挑 战';
  $('bossPickList').innerHTML =
    '<div class="bossCard" data-act="bossPick" data-kind="tears">'+
      '<div class="bossName">梦之泪伤</div>'+
      '<div class="bossLine">美国水牛卡组 · 两条命 · 虚空印卡</div>'+
      '<div class="bossFlavor">礼拜堂深处的抽泣。泪水凝成钢翼——六架水牛，两条命，泪光即火力。</div>'+
    '</div>'+
    '<div class="bossCard" data-act="bossPick" data-kind="alps">'+
      '<div class="bossName">阿尔卑斯要塞</div>'+
      '<div class="bossLine">美德快攻卡组 · 开局弃牌 · 闪电铺场</div>'+
      '<div class="bossFlavor">南线的混凝土巨兽。1944 年冬，要塞指挥官把整副手牌掷入炉膛：「快攻不需要计划，只需要速度。」</div>'+
    '</div>'+
    '<div class="bossCard" data-act="bossPick" data-kind="meme">'+
      '<div class="bossName">北北布次香菜</div>'+
      '<div class="bossLine">日美合流 · 不携带卡牌 · 全程固定行动</div>'+
      '<div class="bossFlavor">北海道的菜地里，有个从不抽牌的指挥官。他掐着手指数回合：一二三四，种田；五，拔刀——香菜在风里晃了晃，紫电已出鞘。</div>'+
    '</div>'+
    '<div class="bossCard" data-act="bossPick" data-kind="hana">'+
      '<div class="bossName">hana · 最终 Boss</div>'+
      '<div class="bossLine">三条命 · 五国研发起手 · 40 张随机金卡 · 一阶段不抽牌 · 指挥点每回合 +3（一阶段上限 12，二阶段起上限 24）</div>'+
      '<div class="bossFlavor">礼拜堂尽头那扇门后面，坐着写规则的人。她手里捏着五张研发：德意志、美国、皇家、帝国、苏联——「打赢我一次不够，你得赢三次。」</div>'+
    '</div>';
  showView('boss');
}
function showNationPick(title, sub, flavor){
  S.over = false;
  const rb = $('btnRematch'); if(rb) rb.style.display = 'none';
  const res = $('ovResult'); if(res) res.textContent = '';
  $('ovNationTitle').textContent = title || '选 择 卡 组';
  $('ovNationSub').textContent = sub || '选择你的出战卡组';
  $('ovFlavor').innerHTML = flavor || '雨夜。烛火。森林深处的礼拜堂。<br>桌面上摊开你的卡组：五国初始，或亲手编排的战群。<br>选一份，然后坐吧。狼群已经到前线了。';
  $('ovFlavor').className = 'flavor';
  $('nationPicker').style.display = 'flex';
  renderNationPicker(); // 每次进出刷新（自定义卡组随存档变化）
  showView('nation');
}

/* ---------- 卡组数据层（盟国机制：主国 main + 盟国 ally 双国家卡池） ---------- */
function nationEntries(key){
  const n = NATIONS[key];
  return [ ...n.units.map(u=>({kind:'unit', id:u.id, def:u})),
           ...n.orders.map(o=>({kind:'order', id:o.id, def:o})),
           ...n.counters.map(o=>({kind:'counter', id:o.id, def:o})) ];
}
function cardEntryById(key, id){ return nationEntries(key).find(e=>e.id===id); }
/* 盟国：先在主国找，找不到再在盟国找（本卡池卡 id 全局唯一，实际无歧义） */
function cardEntryById2(main, ally, id){
  return cardEntryById(main, id) || (ally ? cardEntryById(ally, id) : null);
}
function anyDef(key, e){ return e.kind==='unit' ? mkUnitDef(e.def,key) : (e.kind==='order' ? mkOrderDef(e.def,key) : mkCounterDef(e.def,key)); }
function parseCardRef(ref){
  const i = ref ? String(ref).indexOf(':') : -1;
  if(i <= 0) return null;
  return { key: ref.slice(0,i), id: ref.slice(i+1) };
}
function defaultDeckCards(main, ally){
  const out = [];
  const addNation = (key) => {
    const n = NATIONS[key];
    if(!n) return;
    // 默认卡组按稀有度限制数量（金1/银2/铜3/铁4，原版预组至多 2 张）
    n.units.forEach(u=>{ const copies = Math.min(2, maxCopiesOf(u.id)); for(let i=0;i<copies;i++) out.push(u.id); });
    n.orders.forEach(o=>out.push(o.id));
    n.counters.forEach(o=>out.push(o.id));
  };
  addNation(main);
  if(ally) addNation(ally);
  // 超上限时裁掉末尾的单位副本（单位段在数组前部）
  let unitEnd = out.length;
  while(out.length > DECK_RULES.totalMax && unitEnd > 0){
    out.splice(unitEnd - 1, 1); unitEnd--;
  }
  return out;
}
function buildDeckCustom(main, ally, ids){
  const cards = [];
  (ids||[]).forEach(id=>{
    const e = cardEntryById2(main, ally, id);
    if(!e) return;
    const key = cardEntryById(main, id) ? main : ally; // 按实际归属国家构建（nation 字段正确）
    cards.push(anyDef(key, e));
  });
  return cards;
}
/* 盟国卡池容量 = 两国之和 */
function poolCap2(main, ally){ return poolCap(main) + (ally ? poolCap(ally) : 0); }
/* 玩家当前出战卡组:激活槽位方案(主国匹配)或 null=原版预组（盟国牌一并携带） */
function activePlayerDeck(key){
  const s = SAVE.deckSlots[SAVE.activeSlot];
  if(s && s.nation === key && !s.auto && s.cards && s.cards.length){
    return buildDeckCustom(key, s.ally || null, s.cards);
  }
  return null;
}
function deckValidate(main, ally, ids){
  const msgs = [];
  const cnt = {}; ids.forEach(id=>cnt[id]=(cnt[id]||0)+1);
  const cap = poolCap2(main, ally);
  const tMin = Math.min(DECK_RULES.totalMin, cap), tMax = Math.min(DECK_RULES.totalMax, cap);
  if(ids.length < tMin) msgs.push('总张数需在 '+tMin+'–'+tMax+' 张之间(本卡池上限 '+cap+' 张)');
  if(ids.length > tMax) msgs.push('总张数需在 '+tMin+'–'+tMax+' 张之间(本卡池上限 '+cap+' 张)');
  // 盟国机制：无单位数量限制（0 个单位也可行）
  Object.keys(cnt).forEach(id=>{
    const e = cardEntryById2(main, ally, id); if(!e) return;
    const max = maxCopiesOf(id);
    if(cnt[id] > max) msgs.push('同名卡超过稀有度上限(金1/银2/铜3/铁4，该卡最多 '+max+' 张)');
  });
  return { ok: msgs.length===0, msgs };
}
function persistDeckSlot(slot){
  const d = SAVE.deckSlots;
  d[slot] = { name: UI.deck.name||'未命名', nation: UI.deck.nation, ally: UI.deck.ally || null, cards: UI.deck.ids.slice(), back: UI.deck.back || null, hq: UI.deck.hq || null, auto: !!UI.deck.auto, updatedAt: Date.now() };
  SAVE.activeSlot = slot;
  saveV2Save();
  UI.decks = d;
}

/* ---------- 组卡器视图（盟国机制：主国 + 盟国双国家卡池） ---------- */
function openDeckBuilder(){
  UI.decks = SAVE.deckSlots;
  UI.backPrev = {}; // 卡背预览：每种卡背随机 1 张磨损卡图（每次打开重新随机）
  if(UI.deck.nation === null){
    const i = UI.decks.findIndex(d=>d && d.nation);
    const baseNation = i>=0 && UI.decks[i].nation ? UI.decks[i].nation : 'us';
    const baseAlly = i>=0 && UI.decks[i].ally ? UI.decks[i].ally : (Object.keys(NATIONS).find(k=>k!==baseNation) || null);
    const empty = i<0;
    UI.deck = { slot: Math.max(0,i), nation: baseNation, ally: baseAlly, ids: defaultDeckCards(baseNation, baseAlly), name:'', back: (i>=0 && UI.decks[i] && UI.decks[i].back) || null, hq: (i>=0 && UI.decks[i] && UI.decks[i].hq) || null, auto: empty };
  }
  renderDeckView();
  showView('deck');
}
function idsUnitCount(ids){
  let n = 0;
  ids.forEach(id=>{ const e = cardEntryById2(UI.deck.nation, UI.deck.ally, id); if(e && e.kind==='unit') n++; });
  return n;
}
/* 国家图标（组卡器用 筛选用图标/国家/{国名}.png 小旗标识每张卡归属；sm=小尺寸） */
function natFlagHtml(k, cls){
  const nm = (NATIONS[k] && NATIONS[k].name) || k;
  return '<span class="natFlag' + (cls ? ' ' + cls : '') + '" title="' + nm + '"><img src="' + imgUrl('筛选用图标/国家/' + nm + '.png') + '" alt="' + nm + '" loading="lazy"></span>';
}
/* ---------- 筛选（组卡器/图鉴共用）：花费(0-6/7及以上) · 类型 · 国家 ----------
   图标素材在 筛选用图标/{花费,类型,国家}/（用户提供；缺失时回退文字标签） */
const FLT_ICON_DIR = { cost:'筛选用图标/花费/', type:'筛选用图标/类型/', nation:'筛选用图标/国家/' };
const FLT_TYPES = [ ['infantry','步兵'], ['tank','坦克'], ['artillery','炮兵'], ['fighter','战斗机'], ['bomber','轰炸机'], ['order','指令'], ['counter','反制'] ];
const FLT_COSTS = [ ['0','0'], ['1','1'], ['2','2'], ['3','3'], ['4','4'], ['5','5'], ['6','6'], ['7及以上','7及以上'] ];
function fltBtnHtml(group, val, iconName, active, label){
  const icon = iconName && IMG_MAP && IMG_MAP[FLT_ICON_DIR[group] + iconName + '.png'];
  return '<button class="fltBtn'+(active?' on':'')+'" data-act="flt" data-group="'+group+'" data-val="'+val+'" title="'+esc(label||val)+'">'+
    (icon ? '<img src="'+icon+'" alt="" loading="lazy">' : esc(label||val))+'</button>';
}
function fltTypeOf(it){ return it.kind === 'order' ? 'order' : (it.kind === 'counter' ? 'counter' : it.def.t); }
function fltCostOf(it){ return (it.def.c !== undefined ? it.def.c : 99); }
function fltMatch(f, it){
  if(f.cost !== null && f.cost !== undefined){
    const c = fltCostOf(it);
    if(f.cost === '7及以上'){ if(c < 7) return false; }
    else if(c !== +f.cost) return false;
  }
  if(f.type && fltTypeOf(it) !== f.type) return false;
  if(f.nation && it.key !== f.nation) return false;
  return true;
}
function fltToggle(f, group, val){ f[group] = (f[group] === val) ? null : val; }
function fltBarHtml(f, withNation, nations, rows){
  const row = (inner) => rows ? ('<div class="fltRow">' + inner + '</div>') : inner;
  let h = row('<span class="fltLabel">花费</span>' + FLT_COSTS.map(([v,lab]) => fltBtnHtml('cost', v, lab, f.cost === v, lab + ' 费')).join(''));
  h += row('<span class="fltLabel">类型</span>' + FLT_TYPES.map(([t,lab]) => fltBtnHtml('type', t, lab, f.type === t, lab)).join(''));
  if(withNation && nations && nations.length){
    h += row('<span class="fltLabel">国家</span>' + nations.map(k => fltBtnHtml('nation', k, NATIONS[k].name, f.nation === k, NATIONS[k].name)).join(''));
  }
  return h;
}
function renderDeckView(){
  const key = UI.deck.nation, ally = UI.deck.ally;
  const cnt = {}; UI.deck.ids.forEach(id=>cnt[id]=(cnt[id]||0)+1);
  const v = deckValidate(key, ally, UI.deck.ids);
  /* 排序口径 = 图鉴：费用升序 → 单位/指令/反制 → 名称（zh）
     卡池**不再按单位/指令/反制分组**，全部混在一格里（用户 2026-09-13 口径） */
  const KIND_ORDER = { unit:0, order:1, counter:2 };
  const byCost = (a,b)=> (fltCostOf(a.e) - fltCostOf(b.e))          // 两种形状都能比：卡池 {e,kind,key} / 卡组 {id,i,e,ekey}
    || (KIND_ORDER[a.e.kind] - KIND_ORDER[b.e.kind])
    || String(a.e.def.n).localeCompare(String(b.e.def.n), 'zh');
  /* 卡池：主国 + 盟国卡池合并（盟国卡标「盟」），同一张卡只出现一次 */
  const poolAll = [];
  ['unit','order','counter'].forEach(kind=>{
    nationEntries(key).filter(e=>e.kind===kind).forEach(e=>poolAll.push({ e, kind, key }));
    if(ally) nationEntries(ally).filter(e=>e.kind===kind).forEach(e=>poolAll.push({ e, kind, key: ally }));
  });
  const seen = {};
  const shown = poolAll.filter(x=>{
    const k = x.key + ':' + x.e.id;
    if(seen[k]) return false;
    seen[k] = true;
    return true;
  }).filter(x => fltMatch(UI.deckF, { kind:x.e.kind, def:x.e.def, key:x.key })).sort(byCost);
  const poolHTML =
    '<div class="poolGroup"><div class="poolCards">' +
      shown.map(x=>{
        const e = x.e, ekey = x.key;
        const d = anyDef(ekey, e);
        const max = maxCopiesOf(e.id);
        const have = cnt[e.id]||0;
        const rare = d.rarity || rarityOf(e.id);
        const rareCls = 'rarity r' + {金:'gold',银:'silver',铜:'bronze',铁:'iron'}[rare] || 'iron';
        const allyTag = (ekey === ally && ally !== key) ? '<span style="color:#8ad0ff;font-size:9px;margin-left:4px">盟</span>' : '';
        const meta = (e.kind==='unit'
          ? ('⚔'+(e.def.a||0)+' · ❤'+(e.def.h||0)+(e.def.c?' · 费'+(e.def.c||0):'')+(e.def.f?' · 油'+(e.def.f||0):''))
          : ('费'+(e.def.c||0))) + ' · <span class="'+rareCls+'">'+rare+'</span>';
        return '<div class="poolItem'+(have>=max?' maxed':'')+'" data-act="deckAdd" data-id="'+e.id+'" data-info="'+ekey+':'+e.kind+':'+e.id+'" title="'+esc(e.def.n)+'">'+
          '<div class="piImg">'+artHTML(d, true)+'</div>'+
          '<div class="piBody"><div class="piName">'+natFlagHtml(ekey)+'<span class="nm">'+esc(e.def.n)+'</span>'+allyTag+'</div><div class="piMeta">'+meta+'</div></div>'+
          '<div class="piCnt">'+have+'/'+max+'</div></div>';
      }).join('') +
    '</div></div>';
  /* 我的卡组：同一排序；同名卡合并成一行，只显示「卡名 + *数量」（用户 2026-09-13 口径）
     data-i 保留该卡在 UI.deck.ids 里的**第一个**下标 → 点 ✕ 删掉一张，数量随之 -1 */
  const grouped = {};
  const deckSorted = [];
  UI.deck.ids.forEach((id,i)=>{
    const e = cardEntryById2(key, ally, id); if(!e) return;
    const ekey = cardEntryById(key, id) ? key : ally;
    const g = grouped[id];
    if(g){ g.n++; return; }
    const item = { id, i, e, ekey, n: 1 };
    grouped[id] = item;
    deckSorted.push(item);
  });
  deckSorted.sort(byCost);
  const deckItems = deckSorted.map(x=>{
    const e = x.e, ekey = x.ekey;
    const cost = (e.def.c != null) ? e.def.c : 0;
    /* 行内顺序（用户 2026-09-13）：费用 → 单位名 → 国家 → 微缩卡图（和字一样大）→ 数量 → ✕ 删除 */
    return '<div class="deckItem" data-act="deckDel" data-i="'+x.i+'" data-info="'+ekey+':'+(e.kind||'unit')+':'+e.def.id+'" title="'+esc(e.def.n)+'（费'+cost+'，点击删除一张）">'+
      '<span class="diCost">'+cost+'</span>'+
      '<span class="nm">'+esc(e.def.n)+(ekey===ally?' <span style="color:#8ad0ff">盟</span>':'')+'</span>'+
      natFlagHtml(ekey,'sm')+
      '<span class="diArt">'+artHTML(anyDef(ekey,e), true)+'</span>'+
      '<span class="diCnt">*'+x.n+'</span><span class="diX">✕</span></div>';
  }).join('');
  const cap2 = poolCap2(key, ally);
  const tMax2 = Math.min(DECK_RULES.totalMax, cap2);
  const tMin2 = Math.min(DECK_RULES.totalMin, cap2);
  $('deckBox').innerHTML =
    '<div class="deckNameRow"><span style="color:#a98d55;font-size:12px;letter-spacing:1px">主 国</span>'+
      Object.keys(NATIONS).filter(k=>!NATIONS[k].allyOnly).map(k=>'<button class="smBtn"'+(k===key?' style="color:#f0d58a;border-color:#f0d58a"':'')+' data-act="deckNation" data-k="'+k+'">'+natFlagHtml(k,'sm')+NATIONS[k].name+'</button>').join('')+
    '</div>'+
    '<div class="deckNameRow"><span style="color:#8ad0ff;font-size:12px;letter-spacing:1px">盟 国</span>'+
      Object.keys(NATIONS).filter(k=>k!==key).map(k=>'<button class="smBtn"'+(k===ally?' style="color:#8ad0ff;border-color:#8ad0ff"':'')+' data-act="deckAlly" data-k="'+k+'">'+natFlagHtml(k,'sm')+NATIONS[k].name+'</button>').join('')+
    '</div>'+
    '<div class="deckWrap">'+
      '<div class="deckPool"><h3>卡池 · '+NATIONS[key].name+(ally?' + '+NATIONS[ally].name:'')+'</h3>'+
        '<div class="deckFilters">'+fltBarHtml(UI.deckF, true, ally ? [key, ally] : [key], true)+'</div>'+
        poolHTML+'</div>'+
      '<div class="deckList"><h3>我的卡组</h3>'+
        '<div class="deckSlots">'+UI.decks.map((d,i)=>'<div class="deckSlot'+(i===UI.deck.slot?' active':'')+'" data-act="deckSlot" data-i="'+i+'">'+
          '<div class="dsName">'+esc((d&&d.name)||'槽位'+'ABC'[i])+'</div>'+
          '<div class="dsMeta">'+((d&&d.cards)?(d.cards.length+' 张 · '+(NATIONS[d.nation]?NATIONS[d.nation].name:'?')+(d.ally&&NATIONS[d.ally]?'+'+NATIONS[d.ally].name:'')):'空')+'</div></div>').join('')+'</div>'+
        '<div class="deckSheet">'+
          '<div class="backRow"><span class="fltLabel">卡 背</span><div class="backGrid">'+
            (CARD_BACKS || []).filter(b => b.nation === (HQ_DIR[key] || key)).map(b => {
              if(UI.backPrev[b.id] === undefined) UI.backPrev[b.id] = Math.floor(Math.random() * b.wears.length);
              const art = backArtOf(b.id, UI.backPrev[b.id]);
              return '<div class="backOpt'+(UI.deck.back === b.id ? ' on' : '')+'" data-act="deckBack" data-id="'+b.id+'" title="'+esc(b.name)+' · '+b.wears.length+' 种磨损">'+
                (art ? '<img src="'+art+'" alt="" loading="lazy">' : '')+'</div>';
            }).join('') +
          '</div></div>'+
          '<div class="backRow"><span class="fltLabel">总 部</span><div class="backGrid">'+
            (((HQ_SCENES || {})[HQ_DIR[key]] || [])).map(p => {
              const nm = String(p.split('/').pop() || '').replace(/\.png$/, '').replace(/_(德|日|美|苏|英)$/, '');
              const art = IMG_MAP[p] || imgUrl(p);
              return '<div class="backOpt'+(UI.deck.hq === p ? ' on' : '')+'" data-act="deckHq" data-path="'+p+'" title="'+esc(nm)+'">'+
                '<img src="'+art+'" alt="" loading="lazy"></div>';
            }).join('') +
          '</div></div>'+
          '<div class="deckCount'+(UI.deck.ids.length<tMin2||UI.deck.ids.length>tMax2?' bad':'')+'">分额 '+UI.deck.ids.length+'/'+tMax2+' 张 · 单位 '+idsUnitCount(UI.deck.ids)+' 张'+(UI.deck.auto?' · 原版预组':'')+'</div>'+
          '<div class="deckGrid">'+(deckItems || '<div style="color:#8a6a3a;font-size:12px;padding:14px 6px;grid-column:1/-1">卡组为空 —— 从左侧卡池点选加入(点卡组内卡片可移除)</div>')+'</div>'+
        '</div>'+
        '<div class="deckWarn'+(v.ok?' ok':'')+'">'+(v.ok?'✔ 卡组合法,可携带出战(主国+盟国)':'⚠ '+v.msgs.join(';'))+'</div>'+
        '<div class="deckNameRow"><input id="deckNameInput" maxlength="14" placeholder="卡组名称(≤14字)" value="'+esc(UI.deck.name)+'"><button class="smBtn" data-act="deckSave">保 存</button><button class="smBtn" data-act="deckClear">清 空</button></div>'+
        '<div class="deckActions"><button class="bigbtn" data-act="deckFight">用 此 卡 组 开 战</button> <button class="bigbtn" data-act="backMenu">返 回</button></div>'+
      '</div>'+
    '</div>';
}
function deckAdd(id){
  const e = cardEntryById2(UI.deck.nation, UI.deck.ally, id); if(!e) return;
  const max = maxCopiesOf(id); // 稀有度上限：金1/银2/铜3/铁4
  const have = UI.deck.ids.filter(x=>x===id).length;
  if(have >= max){ toast('「'+e.def.n+'」'+rarityOf(id)+'卡最多 '+max+' 张'); return; }
  const tMax = Math.min(DECK_RULES.totalMax, poolCap2(UI.deck.nation, UI.deck.ally));
  if(UI.deck.ids.length >= tMax){ toast('卡组已达 '+tMax+' 张上限'); return; }
  UI.deck.auto = false;
  UI.deck.ids.push(id); renderDeckView();
}
function deckDel(i){ UI.deck.auto = false; UI.deck.ids.splice(i,1); renderDeckView(); }
function deckClear(){ UI.deck.auto = false; UI.deck.ids = []; renderDeckView(); }
function setDeckNation(key){
  UI.deck.nation = key;
  if(UI.deck.ally === key) UI.deck.ally = Object.keys(NATIONS).find(k=>k!==key) || null;
  if(UI.deckF.nation && UI.deckF.nation !== key && UI.deckF.nation !== UI.deck.ally) UI.deckF.nation = null;
  if(UI.deck.hq && !((HQ_SCENES || {})[HQ_DIR[key]] || []).includes(UI.deck.hq)) UI.deck.hq = null; // 换国：总部场景随主国
  if(UI.deck.back && UI.deck.back.split(':')[0] !== (HQ_DIR[key] || key)) UI.deck.back = null;   // 换国：卡背仅主国可选
  UI.deck.ids = defaultDeckCards(key, UI.deck.ally); UI.deck.auto = true;
  renderDeckView();
}
function setDeckAlly(key){
  if(key === UI.deck.nation){ toast('盟国不能与主国相同'); return; }
  UI.deck.ally = key;
  if(UI.deckF.nation && UI.deckF.nation !== UI.deck.nation && UI.deckF.nation !== key) UI.deckF.nation = null;
  UI.deck.ids = defaultDeckCards(UI.deck.nation, key); UI.deck.auto = true;
  renderDeckView();
}
function deckSave(){
  const inp = $('deckNameInput');
  UI.deck.name = (inp && inp.value && inp.value.trim()) || '未命名';
  const v = deckValidate(UI.deck.nation, UI.deck.ally, UI.deck.ids);
  if(!v.ok){ toast(v.msgs[0]); return; }
  UI.deck.auto = false;
  persistDeckSlot(UI.deck.slot);
  renderDeckView();
  toast('卡组已保存到槽位 '+('ABC'[UI.deck.slot]));
}
function selectDeckSlot(i){
  const d = SAVE.deckSlots; UI.decks = d;
  UI.backPrev = {}; // 切槽位：卡背预览重新随机
  if(d[i] && d[i].nation){
    const ally = d[i].ally || Object.keys(NATIONS).find(k=>k!==d[i].nation) || null;
    UI.deck = { slot:i, nation:d[i].nation, ally, ids:(d[i].cards||[]).slice(), name:d[i].name||'', back: d[i].back || null, hq: d[i].hq || null, auto: !!d[i].auto };
  } else {
    const nat = UI.deck.nation || 'us';
    UI.deck = { slot:i, nation: nat, ally: UI.deck.ally || Object.keys(NATIONS).find(k=>k!==nat) || null, ids: defaultDeckCards(nat, UI.deck.ally || null), name:'', back:null, hq:null, auto:true };
  }
  renderDeckView();
}
function fightWithDeck(bypass){
  const v = deckValidate(UI.deck.nation, UI.deck.ally, UI.deck.ids);
  if(!v.ok && !UI.deck.auto && !bypass){ toast(v.msgs[0]); return; }
  const inp = $('deckNameInput');
  UI.deck.name = (inp && inp.value && inp.value.trim()) || UI.deck.name || '未命名';
  if(!UI.deck.auto) persistDeckSlot(UI.deck.slot);
  PENDING.level = null; PENDING.customDeck = null;
  pickNation(UI.deck.nation, undefined, UI.deck.back || null, UI.deck.hq || null);
}

/* ---------- 图鉴 ---------- */
function openCodex(){ renderCodex(); showView('codex'); }
/* 单位部署/被动效果文案统一收口在 src/cards.js（UNIT_DEPLOY_TEXT/UNIT_FX_TEXT），
   卡面、图鉴、征程卡组查看共用同一份文案 */
const DEPLOY_TEXT = UNIT_DEPLOY_TEXT;
const FX_TEXT = UNIT_FX_TEXT;
function fullDesc(it){
  if(it.kind==='unit'){
    return unitDesc(it.def); // unitDesc 已含类型/费用/词条/部署效果/被动效果
  }
  if(it.kind==='order') return orderDesc(it.def);
  return counterDesc(it.def);
}
function renderCodex(){
  // 标签页缩略图：优先总部卡图；盟国（无总部素材，hq=null）回退到国旗图标
  const tabArt = k => imgUrl(NATIONS[k].hq || ('筛选用图标/国家/' + NATIONS[k].name + '.png'));
  $('codexTabs').innerHTML =
    [['','全 部']].concat(Object.entries(NATIONS).map(([k,n])=>[k,n.name])).map(([k,name])=>
      '<div class="codexTab'+(UI.codexNation===k?' active':'')+'" data-act="codexTab" data-k="'+k+'">'+
      (k ? '<span class="ctImg" style="background-image:url(\''+tabArt(k)+'\')"></span>' : '')+name+'</div>').join('');
  // 筛选条：国家（仅全部页）/ 花费 / 类型
  $('codexFilters').innerHTML = fltBarHtml(UI.codexF, !UI.codexNation, Object.keys(NATIONS));
  const q = (UI.codexQ||'').trim().toLowerCase();
  let items = [];
  Object.entries(NATIONS).forEach(([key,n])=>{
    if(UI.codexNation && UI.codexNation!==key) return;
    n.units.forEach(u=>items.push({key,kind:'unit',def:u}));
    n.orders.forEach(o=>items.push({key,kind:'order',def:o}));
    n.counters.forEach(o=>items.push({key,kind:'counter',def:o}));
  });
  if(q) items = items.filter(it=>{
    const e = it.def;
    const sigs = (e.s||[]).map(s=>SIGINFO[s]?SIGINFO[s].n:s).join(' ');
    return (e.n||'').toLowerCase().includes(q) || (TYPEINFO[e.t]||'').toLowerCase().includes(q) ||
           sigs.toLowerCase().includes(q) || fullDesc(it).toLowerCase().includes(q);
  });
  // 筛选（花费/类型/国家）+ 花费升序（同费按 单位→指令→反制→名称 稳定排序）
  if(UI.codexF.cost !== null || UI.codexF.type || UI.codexF.nation){
    items = items.filter(it => fltMatch(UI.codexF, it));
  }
  const KIND_ORDER = { unit:0, order:1, counter:2 };
  items.sort((a,b)=> (fltCostOf(a)-fltCostOf(b)) || (KIND_ORDER[a.kind]-KIND_ORDER[b.kind]) || String(a.def.n).localeCompare(String(b.def.n),'zh'));
  $('codexGrid').innerHTML =
    items.map(it=>{
      const e = it.def;
      const meta = it.kind==='unit' ? ('⚔'+(e.a||0)+' ❤'+(e.h||0)+(e.c?' · 费'+e.c:'')+(e.f?' · 油'+e.f:'')) : ('费'+(e.c||0)+' · '+(it.kind==='order'?'指令':'反制'));
      return '<div class="codexCard'+(it.kind!=='unit'?' order':'')+'" data-act="codexCard" data-k="'+it.key+'" data-kind="'+it.kind+'" data-id="'+e.id+'" data-info="'+it.key+':'+it.kind+':'+e.id+'">'+
        '<div class="cxImg">'+artHTML(anyDef(it.key,it),true)+'</div>'+
        '<div class="cxName">'+esc(e.n)+'</div><div class="cxMeta">'+meta+'</div></div>';
    }).join('') || '<div style="color:#8a6a3a;font-size:13px;letter-spacing:2px;text-align:center;grid-column:1/-1;padding:22px">没有匹配的卡牌</div>';
}
function showCardDetail(key, kind, id){
  const e = cardEntryById(key, id); if(!e) return;
  const d = anyDef(key, e);
  const chips = [];
  if(d.t && TYPEINFO[d.t]) chips.push('<span class="tagBadge">'+TYPEINFO[d.t]+'</span>');
  if(d.sig) d.sig.forEach(s=>{ if(SIGINFO[s]) chips.push('<span class="tagBadge">'+SIGINFO[s].n+'</span>'); });
  if(d.armor) chips.push('<span class="tagBadge">重甲'+d.armor+'</span>');
  if(d.blood) chips.push('<span class="tagBadge">费 '+d.blood+'</span>');
  if(d.fuel) chips.push('<span class="tagBadge">油 '+d.fuel+'</span>');
  const sub = (kind==='unit')
    ? ('⚔'+d.atk+' · ❤'+d.hp+(d.blood?' · 费'+d.blood:'')+(d.fuel?' · 油'+d.fuel:''))
    : ('费'+(d.blood||0)+' · '+(kind==='order'?'指 令':'反 制'));
  $('modalPanel').innerHTML =
    '<div class="cardHero'+(kind!=='unit'?' chOrder':'')+'">'+
      '<div class="chImg"><div class="artbox">'+artHTML(d,false)+'</div></div>'+
      '<div style="min-width:0;flex:1"><div class="chName">'+esc(d.n)+'</div><div class="chSub">'+sub+'</div><div class="chChips">'+chips.join('')+'</div></div>'+
    '</div>'+
    '<div class="chDesc"><b style="color:#ffcf5a">效果原文</b><br>'+esc(fullDesc(e))+'</div>'+
    '<div class="chNation">所属国家:'+NATIONS[key].name+'</div>'+
    '<div style="text-align:center;margin-top:14px"><button class="bigbtn" data-act="modalClose">关 闭</button></div>';
  showModal();
}
/* ---------- 设置 ---------- */
function showModal(){ $('modal').classList.add('show'); }
function closeModal(){ $('modal').classList.remove('show'); }
/* 自选曲目下拉：按归属池分组（主菜单 / Boss 战 / 征程之路 / 各国），选项值 = 曲目文件名 */
function bgmOptionsHtml(){
  if(typeof bgmAllEntries !== 'function') return '';
  const cur = (typeof bgmNowFile === 'function') ? bgmNowFile() : '';
  const groups = new Map();
  for(const e of bgmAllEntries()){
    const g = (typeof bgmPoolName === 'function') ? bgmPoolName(e.key) : e.key;
    if(!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e.file);
  }
  let html = '';
  for(const [g, list] of groups){
    html += '<optgroup label="'+esc(g)+'">' + list.map(f =>
      '<option value="'+esc(f)+'"'+(f===cur?' selected':'')+'>'+
        esc(typeof bgmShortName === 'function' ? bgmShortName(f) : f)+'</option>').join('') + '</optgroup>';
  }
  return html;
}
function openSettings(){
  const s = mkSettings();
  const nowTrack = (typeof bgmNowText === 'function') ? bgmNowText() : '';
  $('modalPanel').innerHTML =
    '<h2 style="text-align:center;letter-spacing:6px;color:#f0d58a;margin-bottom:6px">设 置</h2>'+
    '<div class="setRow"><span>🔊 音效</span><div class="setCtrl"><button class="smBtn" data-act="sndToggle" id="sndBtn">'+(s.sound?'开':'关')+'</button></div></div>'+
    // 音量（局内可调，顶栏「音 量」按钮也开这一页）：实时生效 + 落盘，装配见 ui.js bindVolSliders
    '<div class="setRow"><span>🎵 背景音乐</span><div class="setCtrl"><input type="range" min="0" max="100" step="5" data-vol="bgmVol" id="bgmVolSlider" value="'+Math.round((s.bgmVol==null?1:s.bgmVol)*100)+'"><span class="vpVal" id="bgmVolVal">'+Math.round((s.bgmVol==null?1:s.bgmVol)*100)+'%</span></div></div>'+
    // 换歌（用户 2026-09-16）：显示当前曲目 + 随机换一首 + **自选**（下拉直接点歌）
    '<div class="setRow"><span>🎼 当前曲目</span><div class="setCtrl"><span class="vpVal" id="bgmNow" style="max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(nowTrack)+'">'+esc(nowTrack)+'</span></div></div>'+
    '<div class="setRow"><span>🎵 自选曲目</span><div class="setCtrl"><select id="bgmSel" data-act="bgmSel" title="直接点一首放（下一次开局/回主菜单会由场景接管）">'+bgmOptionsHtml()+'</select></div></div>'+
    '<div class="setRow"><span>⏭ 随 机 换</span><div class="setCtrl"><button class="smBtn" data-act="bgmNext" id="bgmNextBtn" title="从整个曲库随机换一首">换 一 首</button></div></div>'+
    '<div class="setRow"><span>🔊 音效音量</span><div class="setCtrl"><input type="range" min="0" max="100" step="5" data-vol="sfxVol" id="sfxVolSlider" value="'+Math.round((s.sfxVol==null?1:s.sfxVol)*100)+'"><span class="vpVal" id="sfxVolVal">'+Math.round((s.sfxVol==null?1:s.sfxVol)*100)+'%</span></div></div>'+
    '<div class="setRow"><span>⏩ 动画速度</span><div class="setCtrl speedSeg" id="speedSeg">'+
      [1,1.5,2].map(v=>'<button data-act="speedSet" data-v="'+v+'" class="'+(s.speed===v?'on':'')+'">'+(v===1?'1x':(v===1.5?'1.5x':'2x'))+'</button>').join('')+'</div></div>'+
    '<div class="setRow"><span>🤖 AI 难度</span><div class="setCtrl"><select id="diffSel" data-act="diffSel">'+
      AI_DIFFS.map(d=>'<option value="'+d.v+'"'+(s.lastDifficulty===d.v?' selected':'')+'>'+d.n+'('+d.d+')</option>').join('')+'</select></div></div>'+
    '<div class="setRow"><span>🧹 进度存档</span><div class="setCtrl"><button class="smBtn dangerBtn" data-act="wipeSave" id="wipeBtn">清 空 存 档</button></div></div>'+
    '<div style="text-align:center;margin-top:14px"><button class="bigbtn" data-act="modalClose">关 闭</button></div>';
  showModal();
  if(typeof bindVolSliders === 'function') bindVolSliders($('modalPanel'));   // 音量滑杆：实时生效 + 落盘
}
function sndToggle(){
  const s = mkSettings(); s.sound = !s.sound;
  SAVE.settings = Object.assign({}, SAVE.settings, s);
  saveV2Save();
  const b = $('sndBtn'); if(b) b.textContent = s.sound?'开':'关';
  if(typeof bgmStart === 'function'){ bgmStart(); bgmResume(); } // 背景音乐随音效开关启停
}
function setSpeed(v){
  SAVE.settings = Object.assign({}, SAVE.settings, { speed: v });
  saveV2Save();
  document.querySelectorAll('#speedSeg button').forEach(b=>b.classList.toggle('on', +b.dataset.v===v));
}
function setDifficulty(v){
  SAVE.settings.lastDifficulty = v;
  saveV2Save();
  setAI_DIFFICULTY(v);
  const sel = $('diffSel'); if(sel) sel.value = v;
}
function wipeSave(btn){
  if(!wipeArmed){
    wipeArmed = true; btn.textContent = '再 点 一 次 确 认';
    setTimeout(()=>{ wipeArmed = false; const b = $('wipeBtn'); if(b) b.textContent = '清 空 存 档'; }, 3200);
    return;
  }
  wipeArmed = false;
  SAVE = defaultSave(); saveV2Save();     // 全量重置
  UI.decks = SAVE.deckSlots; UI.deck.nation = null;
  closeModal();
  toast('存档已清空');
}

/* ---------- 菜单动作 ---------- */
function clickFreeBattle(){
  PENDING.level = null; PENDING.customDeck = null;
  setGAME_RULES_OFF();
  showNationPick();
}
function backToMenu(){ PENDING.level = null; PENDING.customDeck = null; showView('menu'); if(typeof bgmBackToMenu === 'function') bgmBackToMenu(); }  // 回主菜单＝解除本局曲目锁定、放默认 BGM
function rematch(){
  const rb = $('btnRematch'); if(rb) rb.style.display='none';
  const result = $('ovResult'); result.textContent='';
  if(LAST_BOSS){                                   // Boss 挑战再战：重开同一 Boss 对局（保持玩家卡组）
    const kind = LAST_BOSS;
    S.aNation = 'us';
    setGAME_RULES_OFF();
    setAI_DIFFICULTY('marshal');
    setDeckOverride({ p: DECK_OVERRIDE.p, a: buildBossDeck(kind) });
    setBossKind(kind);
    $('overlay').classList.add('hidden');
    startGame();
    return;
  }
  // 自由对战再战：随机敌方重开一局（战役模式已移除）
  PENDING.level = null; PENDING.customDeck = null;
  const others = Object.keys(NATIONS).filter(k=>k!==S.pNation && !NATIONS[k].allyOnly);  // 盟国不能当敌方主国（无总部场景）
  S.aNation = others[Math.floor(Math.random()*others.length)];
  setGAME_RULES_OFF();
  setAI_DIFFICULTY(SAVE.settings.lastDifficulty);
  $('overlay').classList.add('hidden'); // 隐藏主菜单直接开局（对齐 pickNation 流程）
  startGame();
}

/* ---------- v2 事件分发(与既有 data-act 链互不冲突:nation/hand/unit/slot 交给 bindInput) ---------- */
if (typeof document !== 'undefined'){
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if(!el) return;
    switch(el.dataset.act){
      case 'btnFree': clickFreeBattle(); break;
      case 'btnBoss':
        PENDING.level = null; PENDING.customDeck = null;
        showBossPick();
        break;
      case 'bossPick': {
        const kind = el.dataset.kind;
        // 白名单：新增 Boss 必须同时加进这里，否则点了没反应（2026-09-16 hana 就漏在这一步）
        if(kind !== 'tears' && kind !== 'alps' && kind !== 'meme' && kind !== 'hana') return;
        PENDING.boss = kind;
        const title = kind === 'alps' ? '出 战 · Boss 挑战 · 阿尔卑斯要塞'
          : kind === 'meme' ? '出 战 · Boss 挑战 · 北北布次香菜'
          : kind === 'hana' ? '出 战 · Boss 挑战 · hana · 最终 Boss'
          : '出 战 · Boss 挑战 · 梦之泪伤';
        const flavor = kind === 'alps'
          ? '1944 年冬，阿尔卑斯山脊的混凝土要塞。射孔里伸出一排排炮管，雪线之上军旗猎猎。<br><span style="color:#8a6a3a;font-size:13px">—— 要塞指挥官把整副手牌掷入炉膛：「快攻不需要计划，只需要速度。」</span>'
          : kind === 'meme'
            ? '北海道的菜地边，指挥官掐着手指头数回合：一二三四，种田；五，拔刀。<br><span style="color:#8a6a3a;font-size:13px">—— 香菜在风里晃了晃，紫电已出鞘。</span>'
            : kind === 'hana'
              ? '礼拜堂尽头那扇门后面，坐着写规则的人。她摊开五张研发，把牌堆推到桌子中央。<br><span style="color:#8a6a3a;font-size:13px">—— 「打赢我一次不够，你得赢三次。」</span>'
              : '礼拜堂深处传来压抑的抽泣。泪珠滚落牌桌，凝成钢翼的轮廓。<br><span style="color:#8a6a3a;font-size:13px">—— 「梦之泪伤」的六架水牛已在桌边立起。</span>';
        showNationPick(title, '选择你的阵营', flavor);
        break;
      }
      case 'bossBack': backToMenu(); break;
      case 'btnDeck': openDeckBuilder(); break;
      case 'btnCodex': openCodex(); break;
      case 'btnRematch': rematch(); break;
      case 'backMenu': backToMenu(); break;
      case 'deckNation': setDeckNation(el.dataset.k); break;
      case 'deckAlly': setDeckAlly(el.dataset.k); break;
      case 'deckAdd': deckAdd(el.dataset.id); break;
      case 'deckDel': deckDel(+el.dataset.i); break;
      case 'deckSlot': selectDeckSlot(+el.dataset.i); break;
      case 'deckSave': deckSave(); break;
      case 'deckClear': deckClear(); break;
      case 'deckBack': UI.deck.back = (UI.deck.back === el.dataset.id) ? null : el.dataset.id; renderDeckView(); break;
      case 'deckHq': UI.deck.hq = (UI.deck.hq === el.dataset.path) ? null : el.dataset.path; renderDeckView(); break;
      case 'deckFight': fightWithDeck(e.shiftKey); break;   // Shift 点击 = 跳过校验(仅测试用)
      case 'flt': {
        const f = UI.view === 'codex' ? UI.codexF : UI.deckF;
        fltToggle(f, el.dataset.group, el.dataset.val);
        if(UI.view === 'codex') renderCodex(); else renderDeckView();
        break; }
      case 'codexTab': UI.codexNation = el.dataset.k || ''; UI.codexF.nation = null; renderCodex(); break;
      case 'codexCard': showCardDetail(el.dataset.k, el.dataset.kind, el.dataset.id); break;
      case 'settingsOpen': openSettings(); break;
      case 'sndToggle': sndToggle(); break;
      case 'bgmNext': {
        if(typeof bgmNext === 'function') bgmNext();
        const nowEl = $('bgmNow');
        if(nowEl && typeof bgmNowText === 'function') nowEl.textContent = bgmNowText();
        const selEl = $('bgmSel');   // 随机换歌后把下拉同步到当前这首
        if(selEl && typeof bgmNowFile === 'function'){ try{ selEl.value = bgmNowFile(); }catch(e){} }
        break; }
      case 'speedSet': setSpeed(+el.dataset.v); break;
      case 'wipeSave': wipeSave(el); break;
      case 'modalClose': closeModal(); break;
    }
  });
  document.addEventListener('change', e => {
    if(e.target && e.target.id === 'diffSel') setDifficulty(e.target.value);
    // 自选曲目（设置面板下拉）：点名放这一首（不在曲库里的值会被 bgmPickFile 忽略）
    if(e.target && e.target.id === 'bgmSel' && typeof bgmPickFile === 'function'){
      bgmPickFile(e.target.value);
      const nowEl = $('bgmNow');
      if(nowEl && typeof bgmNowText === 'function') nowEl.textContent = bgmNowText();
    }
  });
  $('modal').addEventListener('click', e => { if(e.target === $('modal')) closeModal(); });
  $('codexQuery').addEventListener('input', e => { UI.codexQ = e.target.value; renderCodex(); });
}



