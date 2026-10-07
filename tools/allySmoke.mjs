#!/usr/bin/env node
// allySmoke.mjs —— 新增盟国/新卡冒烟测试（效果不崩 + 关键数值符合文档）
import { loadEngine, makeEng, defOf, placeUnit, cardDefs } from './engineAdapter.mjs';

const L = await loadEngine();
if (!L.ok) { console.log('引擎加载失败: ' + L.reason); process.exit(2); }
const NATIONS = L.NATIONS;
const mk = (p = 'us', a = 'de') => makeEng(L.mod, L.ai, NATIONS, { pNation: p, aNation: a });
const R = [];
const ok = (name, cond, extra) => R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + extra : ''));
const u = (id, n, t, atk, hp, extra = {}) => Object.assign({ kind:'unit', id, n, t, atk, hp, sig:[], fx:[], armor:0, fuel:1, blood:1, nation:'xx', desc:'' }, extra);
const o = (id, n, blood, eff, extra = {}) => Object.assign({ kind:'order', id, n, blood, eff, nation:'xx', desc:'' }, extra);

// 0) 四国数据存在且为盟国限定
for(const k of ['pl','fr','fi','it']) ok('盟国存在且 allyOnly: ' + k, !!NATIONS[k] && NATIONS[k].allyOnly === true);
for(const k of ['us','de','su','gb','jp']) ok('主国未被误标: ' + k, !!NATIONS[k] && !NATIONS[k].allyOnly);

// 1) 波兰：西线计划（2 张军团）
{
  const eng = mk();
  eng.orderEffect(o('westplan','西线计划',0,'westPlan'), null, 'p');
  const n = eng.state.board[2].filter(x => x && x.def.id === 'legion').length;
  ok('西线计划：加入 2 张「军团」', n === 2, 'legion=' + n);
}
// 2) 波兰：延长战线触发情报（军团 +1/+1）
{
  const eng = mk();
  const g = placeUnit(eng, 'p', u('legion','军团','infantry',2,2,{ sig:['guard'], fx:['intelBuff'] }), 2, 0);
  eng.orderEffect(o('extendline','延长战线',0,'extendLine'), null, 'p');
  const grown = eng.state.board.flat().filter(x => x && x.def.id === 'legion' && x.atk === 3).length;
  ok('延长战线：军团 +1/+1 且新军团入场', grown >= 1, 'buffed=' + grown);
}
// 3) 法国：抵抗万岁（敌方手牌 +1 且为抵抗）
{
  const eng = mk();
  const h0 = eng.state.a.hand.length;
  eng.orderEffect(o('resistvive','抵抗万岁!',0,'resistanceHail'), null, 'p');
  ok('抵抗万岁：敌方手牌 +1', eng.state.a.hand.length === h0 + 1, 'a.hand=' + eng.state.a.hand.length);
  ok('抵抗已加入敌方手牌', eng.state.a.hand.some(c => c && c.eff === 'resistance'));
}
// 4) 法国：纵深防御（伤害 = 敌方手牌数）
{
  const eng = mk();
  const t = placeUnit(eng, 'a', u('big','大单位','infantry',1,9), 0, 0);
  const hand = eng.state.a.hand.length;
  eng.orderEffect(o('deepdefense','纵深防御',0,'deepDefense',{ target:'any' }), { row:0, col:0 }, 'p');
  ok('纵深防御：伤害 = 敌方手牌数', t.hp === 9 - hand, 'hp=' + t.hp + ' 手牌=' + hand);
}
// 5) 芬兰：白色死神（抑制敌方 + 游击队员）
{
  const eng = mk();
  const t = placeUnit(eng, 'a', u('big2','大单位','tank',5,5), 0, 0);
  eng.orderEffect(o('whitedeath','白色死神',0,'whiteDeath'), null, 'p');
  ok('白色死神：抑制敌方单位', !!(eng.state.board[0][0] && eng.state.board[0][0].inhibited));
  ok('白色死神：加入游击队员', eng.state.board.flat().some(x => x && x.def.id === 'guerrilla'));
}
// 6) 芬兰：洛塔组织（+1 防御 / -1 行动花费）
{
  const eng = mk('us','fi');
  const t = placeUnit(eng, 'p', u('inf','步兵','infantry',1,2,{ fuel:2 }), 2, 0);
  eng.orderEffect(o('lotta','洛塔组织',0,'lotta'), null, 'p');
  ok('洛塔组织：+1 防御力', t.maxHp === 3, 'maxHp=' + t.maxHp);
  ok('洛塔组织：-1 行动花费', t.def.fuel === 1, 'fuel=' + t.def.fuel);
}
// 7) 意大利：一日之狮（消灭攻≥4）
{
  const eng = mk();
  placeUnit(eng, 'a', u('big3','大单位','infantry',5,5), 0, 0);
  eng.orderEffect(o('lionday','一日之狮',0,'lionOfDay',{ target:'any' }), { row:0, col:0 }, 'p');
  ok('一日之狮：消灭攻击力≥4 的单位', !eng.state.board[0][0]);
}
// 8) 意大利：海军交战（修复己方支援阵线 + 消灭敌方支援阵线）
{
  const eng = mk();
  const mine = placeUnit(eng, 'p', u('m1','我方','infantry',1,5), 2, 0);
  mine.hp = 1;
  placeUnit(eng, 'a', u('e1','敌方','infantry',1,5), 0, 0);
  eng.orderEffect(o('navalbattle','海军交战',0,'navalBattle'), null, 'p');
  ok('海军交战：修复己方支援阵线', eng.state.board[2][0] && eng.state.board[2][0].hp === eng.state.board[2][0].maxHp);
  ok('海军交战：消灭敌方支援阵线', !eng.state.board[0][0]);
}
// 9) 德：胁迫（抑制）/ 高空轰炸 / 阿尔卑斯要塞
{
  const eng = mk();
  placeUnit(eng, 'a', u('t1','目标','infantry',2,4), 0, 0);
  eng.orderEffect(o('coerce','胁迫',0,'coerce',{ target:'any' }), { row:0, col:0 }, 'p');
  ok('胁迫：抑制目标', !!eng.state.board[0][0].inhibited);
  eng.orderEffect(o('alpine','阿尔卑斯要塞',0,'alpineFort'), null, 'p');
  ok('阿尔卑斯要塞：总部防御力 = 25', eng.state.p.maxHp === 25, 'maxHp=' + eng.state.p.maxHp);
}
// 10) 德：狮鹫指挥车（坦克 -1 花费）/ 溃敌（转换溃军）
{
  const eng = mk();
  placeUnit(eng, 'p', u('gryphon','狮鹫指挥车','tank',1,1,{ fx:['gryphon'] }), 2, 0);
  const tk = placeUnit(eng, 'p', u('tk','测试坦克','tank',2,3,{ fuel:2 }), 2, 1);
  const cost = L.mod.actFuelCost('p', tk);
  ok('狮鹫指挥车：其他友方坦克行动花费 -1', cost === 1, 'cost=' + cost);
  placeUnit(eng, 'a', u('w1','弱单位','infantry',1,1,{ blood:2 }), 0, 0);
  eng.orderEffect(o('routcheap','溃敌',0,'routCheap',{ target:'any' }), { row:0, col:0 }, 'p');
  ok('溃敌：转换为「溃军」', !!(eng.state.board[0][0] && eng.state.board[0][0].def.id === 'rout'));
}
// 11) 美：第593联合通信连（总部伤害 -1）
{
  const eng = mk();
  placeUnit(eng, 'p', u('comm593','第593联合通信连','infantry',0,4,{ fx:['hqDmgReduce1'] }), 2, 0);
  const hp0 = eng.state.p.hp;
  L.mod.applyHqDamage(eng.state.p, 3);        // 直接结算总部伤害（引擎内部入口）
  ok('第593联合通信连：总部受到的伤害 -1', eng.state.p.hp === hp0 - 2, 'hp=' + eng.state.p.hp + ' (期望 ' + (hp0-2) + ')');
}
// 12) 搜索第33联队：指令伤害也抽牌（AI 单位被玩家的指令打伤）
//    注意别写死 === h0 + 1：AI 卡组里可能含「航母打击群」这类会在同期额外抽牌的东西（实测 2% 概率偶发假失败），
//    所以判「手牌 ≥ +1」并直接核日志里 33 联队自己那条抽牌。
{
  const eng = mk('jp','us');
  placeUnit(eng, 'a', u('s33','搜索第33联队','infantry',1,4,{ fx:['onDamagedDraw'] }), 0, 0);
  const h0 = eng.state.a.hand.length;
  eng.orderEffect(o('hammer','铁锤',0,'hammer',{ target:'enemy-army' }), { row:0, col:0 }, 'p');
  const log = (eng.state.log || []).join(' | ');
  ok('搜索第33联队：受到指令伤害抽 1 张', eng.state.a.hand.length >= h0 + 1 && /搜索第33联队 受到伤害：抽 1 张牌/.test(log),
    'a.hand ' + h0 + ' → ' + eng.state.a.hand.length);
}

// 13) 指向型新卡的合法目标（洛林十字/进攻殖民地/马奇诺防线/日间轰炸）
{
  const S = (eng) => eng.state;
  const mkOrder = (id, n, eff, target) => ({ kind:'order', id, n, blood:0, eff, target, nation:'xx', desc:'' });
  // 洛林十字：敌方单位 + 敌方总部均可选
  {
    const eng = mk();
    placeUnit(eng, 'a', u('t','敌单位','infantry',2,4), 0, 0);
    const tg = L.mod.orderTargets(mkOrder('lorraine','洛林十字','lorraine','enemy-any'), 'p');
    ok('洛林十字：可选敌方单位', tg.some(t => !t.hq && t.row === 0 && t.col === 0));
    ok('洛林十字：可选敌方总部', tg.some(t => t.hq));
    const h0 = eng.state.a.hp;
    eng.orderEffect(mkOrder('lorraine','洛林十字','lorraine','enemy-any'), { hq:true }, 'p');
    ok('洛林十字：打总部 3 伤', eng.state.a.hp === h0 - 3, 'a.hp=' + eng.state.a.hp);
  }
  // 进攻殖民地：敌方目标 3 伤 + 友方总部 +5
  {
    const eng = mk();
    placeUnit(eng, 'a', u('t2','敌单位','infantry',2,6), 0, 0);
    const hp0 = eng.state.p.maxHp;
    eng.orderEffect(mkOrder('attackcolony','进攻殖民地','attackColony','enemy-any'), { row:0, col:0 }, 'p');
    ok('进攻殖民地：敌方单位 3 伤', eng.state.board[0][0].hp === 3, 'hp=' + eng.state.board[0][0].hp);
    ok('进攻殖民地：友方总部 +5', eng.state.p.maxHp === hp0 + 5, 'maxHp=' + eng.state.p.maxHp);
  }
  // 马奇诺防线：只可选友方陆军
  {
    const eng = mk();
    placeUnit(eng, 'p', u('inf','步兵','infantry',1,2), 2, 0);
    placeUnit(eng, 'p', u('jet','战斗机','fighter',1,2), 2, 1);
    const tg = L.mod.orderTargets(mkOrder('maginot','马奇诺防线','maginot','friendly-army'), 'p');
    ok('马奇诺防线：只可选友方陆军', tg.length === 1 && tg[0].u.def.t === 'infantry', 'tg=' + tg.length);
    eng.orderEffect(mkOrder('maginot','马奇诺防线','maginot','friendly-army'), { row:2, col:0 }, 'p');
    const buffed = eng.state.board[2][0];
    ok('马奇诺防线：+3/+4 且免疫抑制', buffed.atk === 4 && buffed.maxHp === 6 && (buffed.def.fx||[]).includes('inhibitImmune'),
      'atk=' + buffed.atk + ' maxHp=' + buffed.maxHp);
  }
  // 日间轰炸：可打敌方总部并夺 1 个指挥点槽
  {
    const eng = mk();
    eng.state.a.kreditSlots = 3;                 // 新引擎 AI 槽为 0（未开回合）：先给 3 槽再验证扣除
    const slots0 = eng.state.a.kreditSlots, hp0 = eng.state.a.hp;
    eng.orderEffect(mkOrder('daybomb','日间轰炸','dayBomb','any'), { hq:true }, 'p');
    ok('日间轰炸：总部 2 伤', eng.state.a.hp === hp0 - 2, 'a.hp=' + eng.state.a.hp);
    ok('日间轰炸：敌方 -1 指挥点槽', eng.state.a.kreditSlots === slots0 - 1, 'slots=' + eng.state.a.kreditSlots);
  }
}
// 14) 盟国卡组可构建（主国 + 盟国混编，buildDeck 路径）
{
  const eng = mk('us', 'pl');
  const deck = [];
  for(const o of NATIONS.pl.orders) deck.push(Object.assign({ nation:'pl' }, o));
  for(const un of NATIONS.pl.units) deck.push(Object.assign({ nation:'pl' }, un));
  const built = L.mod.buildDeck('us', deck);
  ok('盟国卡组可构建（波）', built.length === deck.length, 'built=' + built.length);
  ok('盟国卡国籍正确', built.every(c => c.nation === 'pl'));
}

// 15) 衍生卡图路径与卡面数据完整性（军团/抵抗/溃军/游击队员/轻步兵/F2A/卫戍）
{
  const derived = [
    ['legion','军团','卡牌/波/军团.png'], ['guerrilla','游击队员','卡牌/芬/游击队员.png'],
    ['rout','溃军','卡牌/中立/溃军.png'], ['lightinf','轻步兵','卡牌/苏/轻步兵.jpg'],
    ['f2a','F2A 水牛','卡牌/美/F2A 水牛.jpg'], ['garrison','卫戍','卡牌/英/卫戍.jpg']
  ];
  const makeDerived = globalThis.makeDerived;
  for(const [id, name, img] of derived){
    const d = makeDerived(id);
    ok('衍生卡 ' + name + '：图路径正确', !!d && d.img === img, d ? d.img : 'null');
  }
  ok('衍生卡 抵抗：图路径正确', globalThis.RESIST && globalThis.RESIST.img === '卡牌/法/抵抗.png', globalThis.RESIST && globalThis.RESIST.img);
  // 溃军转换后带图
  const eng = mk();
  placeUnit(eng, 'a', u('w','弱单位','infantry',1,1,{ blood:2 }), 0, 0);
  eng.orderEffect(o('routcheap','溃敌',0,'routCheap',{ target:'any' }), { row:0, col:0 }, 'p');
  const routed = eng.state.board[0][0];
  ok('溃军转换后卡面带图', !!routed && routed.def.img === '卡牌/中立/溃军.png', routed ? routed.def.img : 'null');
}

// 16) 权衡：抽 2 张 + 点手牌弃 1 张（点击即结算、消耗本卡并扣费）
{
  const eng = mk('us','su');
  const ord = { kind:'order', id:'weigh', n:'权衡', blood:2, eff:'weighOptions', nation:'su', desc:'' };
  eng.state.p.kredit = 5;
  eng.state.p.hand.push(ord);
  const h0 = eng.state.p.hand.length;
  eng.orderEffect(ord, null, 'p');
  ok('权衡：抽 2 张后进入点手牌弃牌态', !!eng.state.discardPick, JSON.stringify(!!eng.state.discardPick));
  const MAX_HAND = L.mod.MAX_HAND || 9;   // 手牌上限 9；抽到的「抽取特效」卡可能额外加牌，故不断言恰好 +2
  ok('权衡：抽牌后手牌增加且不超上限', (eng.state.p.hand.length > h0 || h0 >= MAX_HAND) && eng.state.p.hand.length <= MAX_HAND,
    'hand=' + eng.state.p.hand.length + ' 原=' + h0);
  const trash = eng.state.p.hand.find(c => c !== ord);
  const k0 = eng.state.p.kredit;
  const okRes = L.mod.discardPickResolve(trash);
  ok('权衡：点击的手牌被弃掉', okRes && eng.state.p.hand.indexOf(trash) < 0);
  ok('权衡：本卡被消耗（离开手牌）', eng.state.p.hand.indexOf(ord) < 0);
  ok('权衡：扣费 2', eng.state.p.kredit === k0 - 2, 'kredit=' + eng.state.p.kredit);
  ok('权衡：状态已清除', !eng.state.discardPick);
}
// 17) 毁坏：展示敌方 3 张手牌 → 玩家选 1 张弃掉 + 复制入手
{
  const eng = mk('us','fr');
  const ord = { kind:'order', id:'ruin', n:'毁坏', blood:0, eff:'ruinHand', nation:'fr', desc:'' };
  const foeHand0 = eng.state.a.hand.length;
  const myHand0 = eng.state.p.hand.length;
  eng.orderEffect(ord, null, 'p');
  const pc = eng.state.pendingChoice;
  ok('毁坏：弹出抉择面板', !!pc && pc.eff === 'ruinHand');
  ok('毁坏：展示 3 张敌方手牌', !!pc && pc.options.length === 3, pc ? 'options=' + pc.options.length : 'null');
  ok('毁坏：未选前敌方手牌不变', eng.state.a.hand.length === foeHand0);
  const pickName = pc.picks[1].n;
  L.mod.resolveChoice('c1');
  ok('毁坏：选中的敌方手牌被弃', eng.state.a.hand.length === foeHand0 - 1, 'a.hand=' + eng.state.a.hand.length);
  ok('毁坏：复制加入我方手牌', eng.state.p.hand.length === myHand0 + 1 && eng.state.p.hand.some(c => c.n === pickName),
    'p.hand=' + eng.state.p.hand.length + ' 期望含 ' + pickName);
}
// 18) 扩大优势：卡组顶 3 张单位 → 玩家选 1 张（花费 0·闪击），其余置于卡组底
{
  const eng = mk('de','us');
  const ord = { kind:'order', id:'exploit', n:'扩大优势', blood:0, eff:'exploitGain', nation:'de', desc:'' };
  placeUnit(eng, 'p', u('front','前线兵','infantry',1,3), 1, 0);           // 前线有友方单位
  const deck0 = eng.state.p.deck.length;
  eng.orderEffect(ord, null, 'p');
  const pc = eng.state.pendingChoice;
  ok('扩大优势：弹出抉择面板', !!pc && pc.eff === 'exploitGain');
  ok('扩大优势：展示卡组顶单位（≤3）', !!pc && pc.options.length >= 1 && pc.options.length <= 3, pc ? 'options=' + pc.options.length : 'null');
  const handN0 = eng.state.p.hand.length;
  const chosenName = pc.picks[0].n;
  L.mod.resolveChoice('c0');
  const added = eng.state.p.hand[eng.state.p.hand.length - 1];   // 新加入的牌在末尾（手牌里可能本就有同名卡，不能按名字找）
  ok('扩大优势：选中单位入手', !!added && added.n === chosenName && eng.state.p.hand.length === handN0 + 1,
    added ? 'n=' + added.n : 'null');
  ok('扩大优势：花费为 0 且具有闪击', !!added && added.blood === 0 && (added.sig||[]).includes('blitz'),
    added ? 'blood=' + added.blood + ' sig=' + JSON.stringify(added.sig) : 'null');
  ok('扩大优势：卡组总数不变（其余回卡组底）', eng.state.p.deck.length === deck0 - pc.picks.length + Math.max(0, pc.picks.length - 1),
    'deck=' + eng.state.p.deck.length);
}
// 19) 权衡兜底：结束回合未点手牌 → 自动弃最低费
{
  const eng = mk('us','su');
  const S5 = eng.state;
  S5.phase = 'player';
  const ord = { kind:'order', id:'weigh', n:'权衡', blood:0, eff:'weighOptions', nation:'su', desc:'' };
  S5.p.hand.push(ord);
  eng.orderEffect(ord, null, 'p');
  ok('权衡兜底：进入弃牌态', !!S5.discardPick);
  const cheap = S5.p.hand.filter(c => c !== ord).sort((a,b)=>(a.blood||0)-(b.blood||0))[0];
  const n0 = S5.p.hand.length;
  L.mod.endPlayerTurn();
  ok('权衡兜底：回合结束时自动弃 1 张', S5.p.hand.length <= n0 - 1, 'hand=' + S5.p.hand.length);
  ok('权衡兜底：状态清除', !S5.discardPick);
}

// 20) 抵抗塞给敌方时是明牌（revealed）
{
  const eng = mk('us','fr');
  eng.orderEffect(o('resistvive','抵抗万岁!',0,'resistanceHail'), null, 'p');
  const res = eng.state.a.hand.filter(c => c && c.eff === 'resistance');
  ok('抵抗：塞入敌方手牌', res.length >= 1, 'n=' + res.length);
  ok('抵抗：为明牌（revealed）', res.every(c => c.revealed === true), JSON.stringify(res.map(c => !!c.revealed)));
  // 武装抵抗：翻倍后的补牌也应是明牌
  const eng2 = mk('us','fr');
  eng2.orderEffect(o('armedresist','武装抵抗',0,'armedResistance'), null, 'p');
  const res2 = eng2.state.a.hand.filter(c => c && c.eff === 'resistance');
  ok('武装抵抗：抵抗数量翻倍', res2.length >= 2, 'n=' + res2.length);
  ok('武装抵抗：补入的抵抗也是明牌', res2.every(c => c.revealed === true));
  ok('武装抵抗：抵抗花费翻倍', res2.every(c => (c.blood||0) >= 2), JSON.stringify(res2.map(c => c.blood)));
}

// 21) 芬：误伤（反制 friendlyFire，用户 2026-09-16 口径）——敌方单位一攻击就把整份伤害反弹回敌方：
//     「其他敌方目标」＝其他敌方单位或**敌方总部**；我方原目标一点血不掉；打偏的目标不反击。
//     历史缺陷：旧写法只改 tgt 就被 `d.owner === a.owner → return false` 拦掉，伤害凭空消失（表现为「毫无效果」）。
{
  const rnd = Math.random;
  const eng = mk('us','de');
  const S = eng.state;
  S.p.counters = ['friendlyFire']; S.p.counterHit = {};
  S.p.kredit = 12; S.a.kredit = 12; S.phase = 'ai';
  placeUnit(eng, 'a', u('ffatk','敌攻','infantry',2,3), 1, 0);
  const mate = placeUnit(eng, 'a', u('ffmate','敌友','infantry',1,5), 1, 3);
  const mine = placeUnit(eng, 'p', u('ffmine','我方','infantry',1,5), 2, 1);
  const hq0 = S.a.hp;
  Math.random = () => 0;   // 固定随机：池中第 0 个 = 另一个敌方单位
  L.mod.combat({ row:1, col:0 }, { row:2, col:1 });
  ok('误伤：我方单位一点血不掉', mine.hp === 5, 'hp=' + mine.hp);
  ok('误伤：伤害反弹到另一个敌方单位', mate.hp < 5, 'mate.hp=' + mate.hp);
  ok('误伤：敌方总部未被牵连 + 触发即消耗', S.a.hp === hq0 && !S.p.counters.includes('friendlyFire') && S.p.counterHit.friendlyFire === true,
    'a.hp=' + S.a.hp + ' counters=' + JSON.stringify(S.p.counters));
  const eng2 = mk('us','de');
  const S2 = eng2.state;
  S2.p.counters = ['friendlyFire']; S2.p.counterHit = {};
  S2.p.kredit = 12; S2.a.kredit = 12; S2.phase = 'ai';
  placeUnit(eng2, 'a', u('ffatk2','敌攻2','infantry',2,3), 1, 0);
  const ph0 = S2.p.hp, ah0 = S2.a.hp;
  Math.random = () => 0.99;   // 固定随机：池中最后一个 = 敌方总部
  L.mod.combat({ row:1, col:0 }, { hq:true });
  ok('误伤：敌方打我方总部也触发，我方总部不掉血', S2.p.hp === ph0, 'p.hp ' + ph0 + '→' + S2.p.hp);
  ok('误伤：伤害反弹到敌方总部（目标含总部）', S2.a.hp < ah0, 'a.hp ' + ah0 + '→' + S2.a.hp);
  const eng3 = mk('us','de');
  const S3 = eng3.state;
  S3.p.counters = []; S3.p.counterHit = {};
  S3.p.kredit = 12; S3.a.kredit = 12; S3.phase = 'ai';
  placeUnit(eng3, 'a', u('ffatk3','敌攻3','infantry',2,3), 1, 0);
  const m3 = placeUnit(eng3, 'p', u('ffmine3','我方3','infantry',1,5), 2, 1);
  Math.random = () => 0;
  L.mod.combat({ row:1, col:0 }, { row:2, col:1 });
  ok('误伤：没挂反制时交战照常（我方掉血 + 攻方被反击）', m3.hp < 5, '我 hp=' + m3.hp);
  Math.random = rnd;
}

// 22) 英·第85先锋连：每回合友方第一张指令 -1 花费（现算：中途部署也立刻生效；用完即失效）
//     历史缺陷：旧实现靠「回合开始缓存的 firstOrderDiscount」，本回合部署的单位当回合不生效（用户 2026-09-16 报「没有效果」）。
{
  const idx = cardDefs(NATIONS);
  const d85 = () => JSON.parse(JSON.stringify(idx.get('gb:第85先锋连')));
  const ORDER = { kind:'order', id:'t85', n:'测试指令', blood:3, eff:'fortify', nation:'gb', desc:'' };
  const eng = mk('gb','de'); const S = eng.state;
  S.p.kredit = 10; S.a.kredit = 10; S.phase = 'player';
  eng.spawnUnit('p', d85(), 2, 0);                        // 本回合中途部署（走部署效果挂 firstOrderMinus1）
  ok('第85先锋连：部署当回合第一张指令 -1（3 → 2）', L.mod.playCost(S.p, ORDER) === 2, 'cost=' + L.mod.playCost(S.p, ORDER));
  L.mod.orderEffect(ORDER, null);
  ok('第85先锋连：用掉后第二张恢复原价', L.mod.playCost(S.p, { ...ORDER, id:'t85b' }) === 3, 'cost=' + L.mod.playCost(S.p, { ...ORDER, id:'t85b' }));
  const eng2 = mk('gb','de'); const S2 = eng2.state;
  S2.p.kredit = 10;
  eng2.beginTurn('p');
  ok('第85先锋连：不在场时原价', L.mod.playCost(S2.p, ORDER) === 3, 'cost=' + L.mod.playCost(S2.p, ORDER));
}

// 23) 反制「触发即消耗」：ULTRA（玩家侧）触发后那张卡必须从手牌消失（不能留着点「收回」白退指挥点）
//     历史缺陷：ULTRA 分支只删了计数器、没走 consumePlayerCounter；且 consumePlayerCounter 用 findIndex 只按 eff
//     取第一张，手里有两张同名反制时会误删未激活的那张、把已激活的留在手里（用户 2026-09-16 报「没有消耗」）。
{
  const idx2 = cardDefs(NATIONS);
  const findC = eff => { for (const [, d] of idx2) if (d.kind === 'counter' && d.eff === eff) return JSON.parse(JSON.stringify(d)); return null; };
  const eng = mk('gb','de'); const S = eng.state;
  const plain = (S.p.hand.find(c => c && c.kind === 'counter' && c.eff === 'ultra')) || null;  // 起手自带的（未激活）
  const card = findC('ultra');
  S.p.hand.push(card); S.p.kredit = 10; S.a.kredit = 10;
  L.mod.activateCounter(card);
  S.phase = 'ai';
  L.mod.orderEffect(o('tultra','测试指令',1,'produce'), null);
  ok('ULTRA：触发后计数器撤下', !S.p.counters.includes('ultra'), JSON.stringify(S.p.counters));
  ok('ULTRA：已激活的那张被消耗（不在手牌）', S.p.hand.indexOf(card) === -1);
  ok('ULTRA：手里未激活的同名卡不受影响', !plain || S.p.hand.indexOf(plain) > -1);
  ok('ULTRA：不能再次激活同一张（不能在手里收回退款）', L.mod.activateCounter(card) === false);
}

// 24) 部署效果的指向判定要按兵种过滤（P-40小鹰 target=enemy-army）
//     历史缺陷：指令路径（orderTargets）一直按兵种过滤，**单位部署效果**那条路径只判归属 →
//     敌方场上只有战斗机时也会开放点选、效果落到错对象（2026-09-16 自查发现）。
{
  const idx3 = cardDefs(NATIONS);
  const byId = id => { for (const [, d] of idx3) if (d.id === id) return JSON.parse(JSON.stringify(d)); return null; };
  const mkUnit = (id, n, t) => ({ kind:'unit', id, n, t, atk:1, hp:3, sig:[], fx:[], armor:0, fuel:0, blood:1, nation:'xx', desc:'' });
  const p40 = byId('P-40小鹰');
  const pickM = card => ({ type:'deployPick', card, tgtOwner: /friendly/.test(card.target) ? 'p' : 'a' });

  const e1 = mk('us','de'); placeUnit(e1, 'a', mkUnit('ef','敌机','fighter'), 1, 0);
  ok('部署指向：enemy-army 不认敌方战斗机', L.mod.deployCanTarget(p40, 'p') === false &&
    L.mod.deployPickValid(pickM(p40), e1.state.board[1][0]) === false);
  const e2 = mk('us','de'); placeUnit(e2, 'a', mkUnit('ei','敌步兵','infantry'), 1, 0);
  ok('部署指向：enemy-army 认敌方步兵', L.mod.deployCanTarget(p40, 'p') === true &&
    L.mod.deployPickValid(pickM(p40), e2.state.board[1][0]) === true);

  const r17 = byId('r17');
  const e3 = mk('us','de'); placeUnit(e3, 'a', mkUnit('ef2','敌方单位','infantry'), 1, 0);
  ok('部署指向：friendly 在己方空场时不开点选', L.mod.deployCanTarget(r17, 'p') === false);
  placeUnit(e3, 'p', mkUnit('pf','我方单位','infantry'), 2, 0);
  ok('部署指向：friendly 只认己方', L.mod.deployCanTarget(r17, 'p') === true &&
    L.mod.deployPickValid(pickM(r17), e3.state.board[2][0]) === true &&
    L.mod.deployPickValid(pickM(r17), e3.state.board[1][0]) === false);
}

const fails = R.filter(x => x.startsWith('FAIL'));
console.log(R.join('\n'));
console.log('\n[allySmoke] 通过 ' + (R.length - fails.length) + '/' + R.length + '，失败 ' + fails.length);
process.exit(fails.length ? 1 : 0);
