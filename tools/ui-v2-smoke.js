// Built-bundle smoke test: verify v2 UI runs against t1 engine hooks in the BUILT KADMIN-卡兹铭刻.html
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');
const m = src.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('NO SCRIPT FOUND'); process.exit(1); }

let fail = 0;
function check(name, cond){
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if(!cond) fail++;
}
// built template checks
{
  const need = ['id="ovMenu"', 'id="ovNation"', 'id="ovDeck"', 'id="ovCodex"', 'id="ovBoss"',
    'id="btnRematch"', 'id="modal"', 'class="v2modal"', 'data-act="btnFree"', 'data-act="btnBoss"',
    'data-act="btnDeck"', 'data-act="btnCodex"', 'data-act="settingsOpen"',
    'id="codexQuery"', 'class="menuBtns"', 'id="loading"', '<title>KADMIN-卡兹铭刻</title>', '卡 兹 铭 刻'];
  for(const n of need) check('template contains ' + n, src.indexOf(n) > -1);
  check('template removed campaign entry/list/level', src.indexOf('id="campaignList"') === -1 && src.indexOf('data-act="btnCampaign"') === -1 && src.indexOf('id="ovLevel"') === -1);
  check('template removed old rematchBtn', src.indexOf('id="rematchBtn"') === -1);
  check('template removed old repickBtn', src.indexOf('id="repickBtn"') === -1);
  check('template removed boss draw-2 bonus', src.indexOf('S.bossMode ? 2 : 1') === -1);
  // 战场等比缩放（用户 2026-09-16：手机端战斗中比例失调）——桌面值不变，窄屏/矮屏只改 --bw 一个变量
  check('template: 战场等比缩放变量 + 媒体查询', src.indexOf(':root { --bw: 96px; }') > -1 &&
    src.indexOf('--bw: clamp(48px, min(calc((100vw - 44px) / 5.625), calc((100vh - 50px) / 9.3)), 96px);') > -1 &&
    src.indexOf('@media (max-height: 520px)') > -1);
  check('template: 战场关键块都改用 --bw', src.indexOf('.slot, .unit { width: var(--bw);') > -1 &&
    src.indexOf('.hqchip { width: calc(var(--bw) * 1.35417);') > -1 &&
    src.indexOf('.pile { width: calc(var(--bw) * 1.04167);') > -1 &&
    src.indexOf('.card { width: calc(var(--bw) * 1.04167);') > -1);
}

function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', className: '', dataset: {},
    style: {}, disabled: false,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(){}, appendChild(){}, removeChild(){}, focus(){}, scrollIntoView(){},
  };
}
const els = {};
const sandbox = {
  console, setTimeout, clearTimeout, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Date, Promise, parseInt, parseFloat, isNaN,
  document: {
    getElementById(id){ if(!els[id]) els[id] = makeEl(id); return els[id]; },
    querySelector(){ return makeEl('_q'); },
    querySelectorAll(){ return []; },
    addEventListener(){},
    createElement(){ return makeEl('_c'); },
  },
  window: { AudioContext: undefined, webkitAudioContext: undefined },
  localStorage: {
    _d: {},
    getItem(k){ return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v){ this._d[k] = String(v); },
    removeItem(k){ delete this._d[k]; },
  },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
function ev(expr){ return vm.runInContext(expr, ctx); }
function h(id){ return (els[id] ? els[id].innerHTML : ''); }
function cnt(s, sub){ return s.split(sub).length - 1; }

try {
  vm.runInContext(m[1], ctx, { filename: 'built.js' });
  check('built bundle evaluated (boot ran, no throw)', true);
} catch (e) {
  console.error('EVAL ERROR: ' + e.stack);
  process.exit(1);
}

try {
  // ===== boot & menu =====
  check('boot -> view menu', ev('UI.view') === 'menu');
  check('menu has no campaign remnants (campaignList empty/absent)', h('campaignList') === '' || h('campaignList') === undefined);
  check('GAME_RULES off at boot', ev('typeof GAME_RULES.hqHpBonus') === 'object' && ev('GAME_RULES.hqHpBonus.a') === 0 && ev('GAME_RULES.enemyExtraDraw') === undefined && ev('GAME_RULES.blizzard') === undefined);
  check('default save shape', ev('SAVE.v') === 2 && ev('SAVE.campaign') === undefined && ev('SAVE.campaign2') === undefined);

  // ===== 自由对战 =====
  ev('clickFreeBattle();');
  check('free battle -> nation view', ev('UI.view') === 'nation');
  check('deck pick: 初始卡组数 = 可作主国的国家数（盟国不提供初始卡组）', cnt(h('nationPicker'), 'data-act="deckPick"') === ev('Object.keys(NATIONS).filter(k=>!NATIONS[k].allyOnly).length') && h('nationPicker').indexOf('美国初始') > -1 && ev('typeof IMG_MAP !== "undefined" && !!IMG_MAP["装饰/卡背/美/美国基础_1.png"]'));
  check('card backs: 主国齐全 + 盟国已接入（中立仍不内嵌）', ev('CARD_BACKS.length') >= 25
    && ev('["波","法","芬","意"].every(d => CARD_BACKS.some(b => b.nation === d))')
    && ev('!!IMG_MAP["装饰/卡背/盟国/意/italy_a.png"]')
    && ev('!IMG_MAP["装饰/卡背/中立/Base_set_card_back_a.png"]'));
  ev('dispatchDeckPick({kind:"init", key:"us"});');
  check('free battle starts (phase player, overlay hidden)', ev('S.phase') === 'player' && ev('S.pNation') === 'us');
  check('battle backs: 己方默认+AI 难度装备', ev('backDefaultId("us") === "美:美国基础"') && ev('backUriOf("p") !== ""') && ev('!!backIdOf("a")'));
  check('AI 卡背按实力：基础/空军/老兵/精锐(元帅)', ev('aiBackId("us","recruit") === "美:美国基础"') && ev('aiBackId("us","veteran") === "美:美国空军"') && ev('aiBackId("us","warder") === "美:美国老兵"') && ev('aiBackId("de","marshal") === "德:第1步兵师"'));
  check('HQ 经典默认(瑟堡) + 场景数据', ev('hqPathOf("p") === "装饰/总部/美/瑟堡.png"') && ev('hqPathOf("a") !== ""') && ev('Object.keys(HQ_SCENES).length === 5') && ev('(HQ_SCENES["美"]||[]).length >= 8'));
  check('桌面背景：初始5张 + 桌布映射 + 对战可用', ev('DESK_INITIAL.length === 5') && ev('!!DESK_TABLE["地堡"]') && ev('!!IMG_MAP["装饰/桌面/初始桌面_1.png"]') && ev('deskBattleUri() !== ""') && ev('applyDesk(true) || true'));
  ev('S.hqOf = { p: "装饰/总部/德/舰队_德国.png", a: null };');
  check('桌面应用：总部场景(舰队_德国) → 对应桌布(舰队)', ev('deskBattleUri() === IMG_MAP["装饰/桌面/总部对应桌布/舰队.png"]') === true);
  ev('S.hqOf = null;');
  check('free battle default deck = us 40 (4 开局牌+ 1 生产)', ev('S.p.deck.length + (S.p.hand.length - (S.p.hand.some(c=>c.kind==="order"&&c.eff==="produce")?1:0))') === 40);
  check('free enemy deck default (random nation) built', ev('S.a.deck.length + S.a.hand.length') > 0);
  check('GAME_RULES stays off in free battle', ev('GAME_RULES.enemyExtraDraw') === undefined && ev('GAME_RULES.hqHpBonus.a') === 0);
  check('AI difficulty applied from save (recruit default)', ev('AI_DIFFICULTY') === 'recruit');

  // ===== 背景音乐：全曲库随机播放 + 场景槽 + 设置里换歌 =====
  check('bgm: 国家归属表仍在（us8/gb4/jp5/su4/de5/it4/pl1）——留给以后按国家限定',
    ev('BGM_TRACKS.us.length') === 8 && ev('BGM_TRACKS.gb.length') === 4 && ev('BGM_TRACKS.jp.length') === 5 &&
    ev('BGM_TRACKS.su.length') === 4 && ev('BGM_TRACKS.de.length') === 5 && ev('BGM_TRACKS.it.length') === 4 && ev('BGM_TRACKS.pl.length') === 1);
  check('bgm: 当前为「不限定国家、全曲库随机」模式', ev('BGM_NATION_MODE') === false && ev('bgmAllFiles().length') >= 30 && ev('bgmAllFiles().indexOf("老牧师.mp3")') === -1);
  check('bgm: 场景槽只剩主菜单 2 首；Immortals 与 The Warrior Song 转入不绑定场景的 @extra', ev('BGM_SCENES["@menu"].length') === 2 && !ev('BGM_SCENES["@boss"]') && !ev('BGM_SCENES["@run"]') && ev('BGM_SCENES["@extra"].length') === 2, ev('JSON.stringify(BGM_SCENES)'));
  check('bgm: 那两首仍在全曲库随机池里（没被丢掉）', ev('bgmAllFiles().indexOf("Fall Out Boy - Immortals.mp3")') >= 0 && ev('bgmAllFiles().indexOf("Sean Household - The Warrior Song.mp3")') >= 0);
  ev('S.pNation = "de"; S.p.deck = [{ nation: "de" }, { nation: "pl" }]; S.p.hand = []; bgmLockForMatch(); const _r0 = bgmFileLocked;');
  check('bgm: 开局锁定 = 全曲库随机一首（不看国家）', ev('bgmNationKey()') === '@all' && ev('bgmAllFiles().indexOf(_r0)') >= 0);
  ev('S.p.deck = []; bgmLockForMatch();');
  check('bgm: 每局重掷且不连放同一首', ev('bgmFileLocked !== _r0') && ev('bgmAllFiles().indexOf(bgmFileLocked)') >= 0);
  // 用户 2026-09-17：征程之路与 Boss 挑战不再固定曲目，同样全库随机
  ev('const _b0 = bgmFileLocked; bgmLockForMatch("@boss"); const _b1 = bgmFileLocked; bgmLockForMatch("@run"); const _b2 = bgmFileLocked;');
  check('bgm: Boss 战 = 全库随机（不再固定 Immortals）',
    ev('bgmKeyLocked') === '@all' && ev('bgmAllFiles().indexOf(_b1) >= 0') && (ev('_b1') !== 'Fall Out Boy - Immortals.mp3' || ev('bgmAllFiles().length') === 1),
    '_b1=' + ev('_b1'));
  check('bgm: 征程战斗 = 全库随机（不再固定 The Warrior Song）',
    ev('bgmAllFiles().indexOf(_b2) >= 0') && (ev('_b2') !== 'Sean Household - The Warrior Song.mp3' || ev('bgmAllFiles().length') === 1),
    '_b2=' + ev('_b2'));
  // rotate=false（回到地图）：保持当前曲目，不每次渲染都换曲
  ev('bgmLockForMatch("@run", false); const _b3 = bgmFileLocked;');
  check('bgm: 回地图不换曲（rotate=false 保持当前曲目）', ev('_b3') === ev('_b2'), ev('_b3'));
  ev('const _m0 = bgmFileLocked; bgmBackToMenu();');
  check('bgm: 回主菜单 = 菜单曲单里随机一首（且换掉了上一首）', ev('bgmKeyLocked') === '@menu' && ev('bgmAvailOf("@menu").indexOf(bgmFileLocked)') >= 0 && ev('bgmFileLocked !== _m0'));
  ev('const _x0 = bgmFileLocked; bgmNext();');
  check('bgm: 设置里「换一首」= 全曲库再随机一首', ev('bgmKeyLocked') === '@all' && ev('bgmFileLocked !== _x0') && ev('bgmAllFiles().indexOf(bgmFileLocked)') >= 0);
  check('bgm: 当前曲目文案（随机模式）', ev('/^随机播放 · .+（曲库 \\d+ 首）$/.test(bgmNowText())') === true);
  // 自选换歌（设置面板下拉直接点歌）
  check('bgm: 曲库清单去重且带归属池', ev('bgmAllEntries().length') === ev('bgmAllFiles().length') && ev('(function(){ const s={}; return bgmAllEntries().every(e => { if(s[e.file]) return false; s[e.file]=1; return !!e.key; }); })()') === true);
  ev('const _p0 = bgmFileLocked; const _picked = bgmAllFiles().filter(f => f.indexOf("Море") >= 0)[0];');
  check('bgm: 自选能点名播放（@pick + 立即换源）', ev('(function(){ return bgmPickFile(_picked) === true && bgmFileLocked === _picked && bgmKeyLocked === "@pick" && bgmNowText().indexOf("自选 · ") === 0; })()') === true, ev('_picked'));
  check('bgm: 自选文案带曲名', ev('bgmNowText().indexOf("Море") > 0'), ev('bgmNowText()'));
  check('bgm: 自选不在曲库的值 → 忽略（保持当前曲）', ev('(function(){ const b = bgmFileLocked; const r = bgmPickFile("根本没有这首.mp3"); return r === false && bgmFileLocked === b; })()') === true);
  ev('bgmPickFile(_p0);');   // 复位
  check('bgm: 配了曲子但文件没入库 → 回退默认曲（不静音）', ev('(function(){ BGM_TRACKS.zz = ["不存在的曲子.mp3"]; const p = bgmPathOf("zz"); const n = bgmAvailOf("zz").length; delete BGM_TRACKS.zz; return p === "音乐/背景音乐/老牧师.mp3" && n === 0; })()') === true);
  check('bgm: 无 Audio 环境调用 bgmStart 不抛错（无头保护）', ev('(function(){ try{ bgmStart(); bgmStart("us"); bgmStart("@boss"); return true; }catch(e){ return false; } })()') === true);
  ev('S.pNation = "us"; S.p.deck = []; S.p.hand = []; bgmLockForMatch(); startGame();');   // 复原对局状态，供后续用例

  // ===== Boss 挑战 =====
  ev('backToMenu(); showBossPick();');
  check('boss pick: 4 张挑战卡（含最终 Boss hana）', cnt(h('bossPickList'), 'data-act="bossPick"') === 4 && h('bossPickList').indexOf('data-kind="hana"') > -1 && h('bossPickList').indexOf('三条命') > -1 && ev('UI.view') === 'boss');
  // 点击白名单：v2ui 的 bossPick 分支只放行名单里的 kind —— 新增 Boss 漏加就「点了没反应」（2026-09-16 hana 踩过）
  check('boss pick: 四种 kind 全在点击白名单里', ["'tears'", "'alps'", "'meme'", "'hana'"].every(k => src.indexOf('kind !== ' + k) > -1));
  // 最终 Boss hana（用户 2026-09-16 三次口径）：第一阶段 5 张研发 + 不抽牌 + 指挥点每回合 +3（第一回合 3 点，一阶段上限 12）
  ev('PENDING.boss = "hana"; showNationPick("出 战 · Boss 挑战 · hana"); pickNation("us");');
  check('boss hana: 第一阶段 = 五国研发起手 + 起手 3 点 + 不抽牌',
    ev('S.bossKind') === 'hana' && ev('S.bossLife') === 1 && ev('S.a.kreditSlots') === 3 && ev('S.a.hanaNoDraw') === true &&
    ev('S.a.hanaTurns') === 0 &&
    ev('S.a.hand.length') === 5 && ev('S.a.hand.filter(c => c && c.n.indexOf("研发") > 0).length') === 5,
    ev('S.a.hand.map(c => c.n).join("/")'));
  ev('S.a.hp = 0; checkGameOver();');
  check('boss hana: 第一条命→20 血 + 恢复抽牌（槽沿用当前值，不跳到 24）',
    ev('S.bossLife') === 2 && ev('S.a.hp') === 20 && ev('S.a.kreditSlots') === 3 && ev('S.a.hanaNoDraw') === false && ev('S.over') === false);
  ev('S.a.hp = 0; checkGameOver();');
  check('boss hana: 第二条命→99 血 + 5 SUPERMAN / 4 SUPERTANK + 不抽牌（槽不跳 24）',
    ev('S.bossLife') === 3 && ev('S.a.hp') === 99 && ev('S.a.hanaNoDraw') === true && ev('S.a.kreditSlots') === 3 &&
    ev('S.a.hand.filter(c => c && c.n === "SUPERMAN").length') === 5 && ev('S.a.hand.filter(c => c && c.n === "SUPERTANK").length') === 4);
  ev('S.a.hp = 0; checkGameOver();');
  check('boss hana: 第三条命结束 → 对局真结束', ev('S.over') === true);
  ev('setBossKind(null); backToMenu();');
  ev('PENDING.boss = "alps"; showNationPick("出 战 · Boss 挑战 · 阿尔卑斯要塞"); pickNation("us");');
  check('boss alps: 敌方 us + 元帅难度 + 无规则加成', ev('S.aNation') === 'us' && ev('AI_DIFFICULTY') === 'marshal' && ev('GAME_RULES.enemyExtraDraw') === undefined);
  check('boss alps: 敌方为阿尔卑斯要塞卡组', ev('S.a.deck.length + S.a.hand.length') > 0 && ev('S.phase') === 'player');
  check('boss alps: S.bossKind == alps (引擎重开关卡)', ev('S.bossKind') === 'alps');
  ev('uiGameEndFrame("a");');
  check('boss rematch: 再战一局重开同一 Boss', ev('LAST_BOSS') === 'alps' && ev('(function(){ rematch(); return S.phase === "player"; })()') && ev('S.bossKind') === 'alps');
  check('boss rematch: 敌方卡组仍为 alps', ev('S.a.deck.length + S.a.hand.length') > 0);

  // ===== 组卡 =====
  ev('backToMenu(); openDeckBuilder();');
  check('deck builder: us+de default 40 + legal (盟国)', cnt(h('deckBox'), 'deckItem') > 0 && h('deckBox').indexOf('卡组合法') > -1 && h('deckBox').indexOf('分额 40/') > -1);
  check('deck builder filter bar (8费+7类+2国 = 17 按钮)', cnt(h('deckBox'), 'data-act="flt"') === 17);
  // ===== 排序与网格（用户 2026-09-13：卡池不再分「单位/指令/反制」，组卡器与图鉴同口径＝费用→类型→名称；一行 4 个）=====
  const seqCosts = (html, act) => ev('(function(){ var html = ' + JSON.stringify(html) + ';' +
    ' var re = /data-act="' + act + '"[^>]*data-info="([^"]+)"/g, m, costs = [];' +
    ' while((m = re.exec(html))){ var p = m[1].split(":"); var e = cardEntryById(p[0], p[2]); costs.push(e ? (e.def.c || 0) : -1); }' +
    ' var sorted = costs.slice().sort(function(a,b){ return a-b; });' +
    ' return JSON.stringify({ n: costs.length, ok: JSON.stringify(costs) === JSON.stringify(sorted), head: costs.slice(0,6) }); })()');
  const deckBox = h('deckBox');
  check('卡池不再分「单位/指令/反制」三组（单一 poolGroup，无 pgTitle）', cnt(deckBox, 'poolGroup') === 1 && cnt(deckBox, 'pgTitle') === 0);
  const poolOrder = JSON.parse(seqCosts(deckBox, 'deckAdd'));
  check('卡池按费用升序排列（与图鉴同口径）', poolOrder.n > 0 && poolOrder.ok === true, JSON.stringify(poolOrder));
  const deckOrder = JSON.parse(seqCosts(deckBox, 'deckDel'));
  check('我的卡组按费用升序排列（不再是加入先后；同名卡合并成一行）', deckOrder.n > 0 && deckOrder.n < 40 && deckOrder.ok === true, JSON.stringify(deckOrder));
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行顺序 = 费用 → 单位名 → 国家 → 微缩卡图 → 数量',
    (function(){
      const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = seg.split('<div class="deckItem"').slice(1);
      if (!rows.length) return false;
      return rows.every(r => {
        const iCost = r.indexOf('class="diCost"'), iNm = r.indexOf('class="nm"'),
              iFlag = r.indexOf('class="natFlag'), iArt = r.indexOf('class="diArt"'),
              iCnt = r.indexOf('class="diCnt"');
        return iCost > -1 && iNm > iCost && iFlag > iNm && iArt > iFlag && iCnt > iArt;
      });
    })() === true);
  check('行内「微缩卡图」有卡图（img/canvas）且国家小旗在名后',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      return /class="diArt"><img /.test(seg) || /class="diArt"><canvas /.test(seg); })() === true);
  check('我的卡组每行都显示费用角标（diCost，数量 = 行数）',
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || '';
      const rows = (seg.match(/class="deckItem"/g) || []).length;
      const costs = (seg.match(/<span class="diCost">(\d+)<\/span>/g) || []).length;
      return rows > 0 && rows === costs; })() === true);
  check('我的卡组只显示「卡名 + *数量」（无卡图、数量合计 = 40）',
    cnt(deckBox, '<div class="deckGrid">') === 1 &&
    /<span class="nm">[\s\S]*?<\/span><span class="diCnt">\*\d+<\/span>/.test(deckBox) &&
    (function(){ const seg = deckBox.split('<div class="deckGrid">')[1] || ''; if(seg.indexOf('diImg') > -1) return false; const nums = (seg.match(/<span class="diCnt">\*(\d+)<\/span>/g) || []).map(x => +String(x).replace(/\D/g, '')); return nums.length > 0 && nums.reduce((a, n) => a + n, 0) === 40; })() === true);
  check('左「选卡空间」4/5 : 右「我的卡组」1/5（grid 定死，不会被内容挤反）',
    src.indexOf('.deckWrap { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 1fr);') > -1 &&
    src.indexOf('.deckPool { min-width: 0; }') > -1 && src.indexOf('.deckList { min-width: 0;') > -1);
  // 结构断言：栈式扫描渲染出的 HTML，确认右栏容器没被多余的 </div> 挤到外层（曾导致卡组列表掉到卡池下面）
  (function(){
    const html = deckBox;
    const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
    const stack = [], nodes = [];
    let m;
    while ((m = re.exec(html))) {
      const closing = m[1] === '/', tag = String(m[2]).toLowerCase(), attrs = m[3] || '', selfClose = m[4] === '/';
      const VOID = /^(img|br|hr|input|meta|link|source)$/;
      const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
      if (closing) { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.length = i; break; } continue; }
      if (cls && /^(deckPool|deckList|deckSheet|deckGrid)$/.test(cls)) nodes.push({ cls, parent: stack.length ? stack[stack.length - 1].cls : '(root)' });
      if (!selfClose && !VOID.test(tag)) stack.push({ tag, cls });
    }
    const find = (x) => nodes.find(n => n.cls === x) || {};
    const get = (x) => find(x).parent;
    check('右栏结构正确：deckList 与 deckPool 是 deckWrap 的两个子项，deckSheet 在 deckList 里（不会掉到下面）',
      get('deckPool') === 'deckWrap' && get('deckList') === 'deckWrap' && get('deckSheet') === 'deckList' && get('deckGrid') === 'deckSheet',
      JSON.stringify(nodes));
  })();
  check('组卡器两栏任何宽度都左右并排（我的卡组在右，不会掉到下面）',
    src.indexOf('.deckWrap { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 1fr);') > -1 &&
    (src.match(/\.deckWrap \{ grid-template-columns: minmax\(0, 1fr\); \}/g) || []).length === 0 &&
    (src.match(/\.deckWrap \{[^}]*flex-direction: column/g) || []).length === 0);
  check('卡池卡面有最小尺寸（≥190px，窗口再窄也不会小到看不见）',
    src.indexOf('.poolCards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }') > -1);
  ev('openCodex();');                                        // 先渲染图鉴再检查（检查完切回组卡器，后面的断言继续用）
  const codexOrder = JSON.parse(seqCosts(h('codexGrid'), 'codexCard'));
  check('图鉴卡格按费用升序（与组卡器同口径）', codexOrder.n > 0 && codexOrder.ok === true, JSON.stringify(codexOrder));
  ev('openDeckBuilder();');
  check('卡池/图鉴网格就位（宽屏一行 4 个 + 间距；图鉴居中留白）',
    src.indexOf('.poolCards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }') > -1 &&
    src.indexOf('.codexGrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px;') > -1);
  check('我的卡组是「一行一张」列表（4/5:1/5 布局；只列卡名与数量）',
    src.indexOf('.deckGrid { display: flex; flex-direction: column;') > -1 &&
    src.indexOf('.deckItem { display: flex; gap: 6px; align-items: center;') > -1 &&
    src.indexOf('.deckItem .diCnt { flex: none; color: #ffcf5a;') > -1 &&
    src.indexOf('.deckItem .diImg') < 0);
  check('deck builder: 主国 5 套卡背可选（随机磨损图预览）', cnt(h('deckBox'), 'data-act="deckBack"') === 5);
  check('deck builder: 总部场景可选', cnt(h('deckBox'), 'data-act="deckHq"') >= 5 && cnt(h('deckBox'), 'data-act="deckHq"') <= 9);
  ev('UI.deckF = { cost:"1", type:null, nation:null }; renderDeckView();');
  check('deck builder cost filter=1: 卡池出现且含费1', (function(){ const g = h('deckBox'); return (g.match(/data-act="deckAdd"/g)||[]).length > 0 && (g.match(/费1 /g)||[]).length > 0; })());
  ev('UI.deckF = { cost:null, type:null, nation:null }; renderDeckView();');
  ev('setDeckNation("de");');
  check('de+us default 40 legal (no warning)', h('deckBox').indexOf('卡组合法') > -1);
  ev('UI.deck.ids = ["pz2","pz2","pz2","pz2","pz35","pz35","pz35","r59","r59","r59","r59","bf109","bf109","bf109","bf109","tiger","tiger","r980","r980","r980","r980","leopold","eagleclaw","eagleclaw","bismarck","smalltalk","smalltalk","smalltalk","smalltalk"]; UI.deck.auto=false; renderDeckView();');
  check('de custom 29 legal deck (稀有度: 金/银/铜/铁)', ev('deckValidate("de", UI.deck.ally, UI.deck.ids).ok') === true);
  ev('fightWithDeck();');
  check('deck fight: battle with custom de deck (29, 含 1 生产)', ev('S.phase') === 'player' && ev('S.pNation') === 'de' && ev('S.p.deck.length + (S.p.hand.length - (S.p.hand.some(c=>c.kind==="order"&&c.eff==="produce")?1:0))') === 29);
  check('deck fight: GAME_RULES off (free battle)', ev('GAME_RULES.enemyExtraDraw') === undefined && ev('GAME_RULES.hqHpBonus.a') === 0);

  // ===== DECK_OVERRIDE (engine persistent semantics; re-set each pickNation) =====
  check('engine DECK_OVERRIDE holds last free-fight set (p=defs, a=null)', ev('DECK_OVERRIDE.a') === null && Array.isArray(ev('DECK_OVERRIDE.p')) === true && ev('DECK_OVERRIDE.p.length') === 29);

  // ===== 选卡组页：自定义卡组 =====
  ev('backToMenu(); SAVE = defaultSave(); saveV2Save(); clickFreeBattle();');
  check('deck pick: 无存档时 5 张初始卡组', cnt(h('nationPicker'), 'data-act="deckPick"') === 5);
  ev('SAVE.deckSlots[0] = {name:"快攻", nation:"de", ally:"us", cards:["pz2","pz2","pz2","pz2","r59","r59","r59","r59"]}; saveV2Save(); renderNationPicker();');
  check('deck pick: 自定义卡组入列(分组+6 张)', cnt(h('nationPicker'), 'data-act="deckPick"') === 6 && h('nationPicker').indexOf('快攻') > -1 && h('nationPicker').indexOf('自 定 义 卡 组') > -1);
  ev('dispatchDeckPick({kind:"slot", slot:0, key:"de", deckP: buildDeckCustom("de","us",["pz2","pz2","pz2","pz2","r59","r59","r59","r59"])});');
  check('deck pick: 自定义卡组开局 (de, 8 张全在场)', ev('S.phase') === 'player' && ev('S.pNation') === 'de' && ev('S.p.deck.length + (S.p.hand.length - (S.p.hand.some(c=>c.kind==="order"&&c.eff==="produce")?1:0))') === 8);
  ev('backToMenu(); SAVE = defaultSave(); saveV2Save();');

  // ===== 图鉴 =====
  ev('backToMenu(); openCodex();');
  check('codex: 卡池总数与 NATIONS 一致', cnt(h('codexGrid'), 'data-act="codexCard"') === ev('Object.values(NATIONS).reduce((s,n)=>s+n.units.length+n.orders.length+n.counters.length,0)'));
  check('codex filters bar（国家数+8花费+7类型）', cnt(h('codexFilters'), 'data-act="flt"') === ev('Object.keys(NATIONS).length + 8 + 7'));
  check('codex tabs: 全部+九国（含盟国，无战役变体）', cnt(h('codexTabs'), 'data-act="codexTab"') === ev('Object.keys(NATIONS).length + 1') && cnt(h('codexGrid'), 'data-act="codexCardVar"') === 0);
  check('codex sorted by cost asc (首张费0)', (function(){ const m = h('codexGrid').match(/费(\d+)/); return !!m && m[1] === '0'; })());
  ev('UI.codexF = { cost:"5", type:null, nation:null }; renderCodex();');
  check('codex cost filter=5: 全部卡片费5', (function(){ const g = h('codexGrid'); const n = (g.match(/data-act="codexCard"/g)||[]).length; return n > 0 && (g.match(/费5 /g)||[]).length >= n && !/(费[0-46-9] )/.test(g.replace(/费5 /g,'')); })());
  ev('UI.codexF = { cost:null, type:null, nation:"jp" }; renderCodex();');
  check('codex nation filter jp: 首张费0(天皇诏令/零战梯队前)且全为日卡', (function(){ const g = h('codexGrid'); const n = (g.match(/data-act="codexCard"/g)||[]).length; return n > 0 && (g.match(/data-k="jp"/g)||[]).length >= n; })());
  ev('UI.codexF = { cost:null, type:null, nation:null }; UI.codexQ=""; renderCodex();');
  ev('showCardDetail("us", "order", "gunboat");');
  check('card detail: 效果原文', h('modalPanel').indexOf('效果原文') > -1 && h('modalPanel').indexOf('炮艇任务') > -1);
  ev('closeModal();');

  // ===== 设置 =====
  ev('openSettings();');
  check('settings: speed seg 3 + warder option', cnt(h('modalPanel'), 'speedSet') === 3 && h('modalPanel').indexOf('warder') > -1 && h('modalPanel').indexOf('钟声残响') === -1);
  check('settings: 换歌行（当前曲目 + 换一首按钮）', h('modalPanel').indexOf('data-act="bgmNext"') > -1 && h('modalPanel').indexOf('id="bgmNow"') > -1 && h('modalPanel').indexOf('当前曲目') > -1 && (h('modalPanel').indexOf('随机播放 · ') > -1 || h('modalPanel').indexOf('首随机）') > -1 || h('modalPanel').indexOf('自选 · ') > -1));
  check('settings: 自选换歌下拉（optgroup + 全曲库选项 + 当前曲选中）', (function(){
    const html = h('modalPanel');
    const at = html.indexOf('id="bgmSel"');
    const seg = at < 0 ? '' : html.slice(at, html.indexOf('</select>', at));   // 只看这个下拉（难度下拉也有 selected）
    const sel = seg.match(/<option value="([^"]+)" selected>/);
    const files = ev('bgmAllFiles()');
    return at > -1 && seg.indexOf('<optgroup label="主菜单">') > -1 && seg.indexOf('<optgroup label="其他曲子（不绑定场景）">') > -1 &&
      seg.indexOf('<optgroup label="Boss 战">') === -1 &&
      (seg.match(/<option value="/g) || []).length >= 30 &&
      (seg.match(/ selected>/g) || []).length === 1 && !!sel && files.indexOf(sel[1]) >= 0;
  })());
  ev('setDifficulty("warder");');
  check('difficulty persists + AI switched', ev('SAVE.settings.lastDifficulty') === 'warder' && ev('AI_DIFFICULTY') === 'warder');
  ev('setSpeed(2);');
  check('speed persists', ev('SAVE.settings.speed') === 2);
  ev('closeModal();');

  // ===== 结算：免费对战 再战一局（战役模式已移除） =====
  ev('backToMenu(); clickFreeBattle(); LAST_BOSS = null; dispatchDeckPick({kind:"init", key:"us"});');
  check('free battle ready for end', ev('S.phase') === 'player' && ev('LAST_BOSS') === null);
  ev('uiGameEndFrame("p");');   // 结算帧（延迟版 uiGameEnd 已在源码层校验）
  check('win settle: 战绩+1 且 再战按钮出现', ev('SAVE.stats.wins') === 1 && h('ovResult').indexOf('你赢了') > -1);
  check('胜利延迟 5s 结算（uiGameEnd 内 setTimeout 5200）', ev('typeof uiGameEnd === "function" && /setTimeout\\s*\\(/.test(uiGameEnd.toString()) && uiGameEnd.toString().indexOf("5200") > -1') === true);
  ev('(function(){ rematch(); })();');
  check('free rematch: 随机敌方重开一局', ev('S.phase') === 'player' && ev('PENDING.level') === null);
  ev('backToMenu(); SAVE = defaultSave(); saveV2Save();');
  check('reset save ok', ev('SAVE.campaign') === undefined && ev('SAVE.activeSlot') === 0);

  // ===== 开始游戏（征程之路大改）：选国 → 10 次三选一 → 地图 → 战斗 =====
  ev('runBeginDraft("us","de");');
  check('begin draft: 主国 us + 盟国 de 入池', ev('RUN.phase')==='draft' && ev('RUN.nation')==='us' && ev('RUN.ally')==='de' && ev('RUN.active')===true);
  const dr = ev('runDraftNext()');
  check('draft: 20 轮三选一（每轮 3 张）', dr && dr.round === 1 && dr.total === 20 && dr.options.length === 3);
  ev('for(let i=0;i<20;i++){ runDraftNext(); runDraftPick(0); }');
  check('draft: 20 次取完后卡组 20 张', ev('RUN.deck.length') === 20);
  check('draft: 再取 = 终态', ev('(function(){ const r = runDraftNext(); return r && r.done; })()') === true);
  ev('runMapInit();');
  // 用户 2026-09-17：征程补上最终 Boss —— 前两张随机常规 Boss，最后一张固定 hana
  check('map init: 3 图 + 3 Boss（前两张随机不重复、最后固定 hana）',
    ev('RUN.maps.length') === 3 && ev('RUN.bossOrder.length') === 3 &&
    ev('RUN.bossOrder[2]') === 'hana' &&
    ev('RUN.bossOrder.slice(0,2).sort().join(",")') !== '' &&
    ev('RUN.bossOrder.slice(0,2).indexOf("hana")') === -1 &&
    ev('RUN.bossOrder.slice(0,2)[0] !== RUN.bossOrder.slice(0,2)[1]') &&
    ev('["tears","alps","meme"].indexOf(RUN.bossOrder[0])') > -1 && ev('["tears","alps","meme"].indexOf(RUN.bossOrder[1])') > -1,
    ev('RUN.bossOrder.join(",")'));
  check('map: 最后一张图的 Boss 是 hana 且有展示名', ev('RUN.maps[2].boss.bossKind') === 'hana' && ev('RUN.maps[2].boss.name') === 'hana',
    ev('RUN.maps[2].boss.name') + ' / ' + ev('RUN.maps[2].boss.blurb'));
  check('map: 每图 2/3/3/2 行 + Boss 节点', ev('RUN.maps[0].rows.map(function(r){return r.length;}).join(",")') === '2,3,3,2' && ev('!!RUN.maps[0].boss') && ev('RUN.maps[0].boss.type') === 'boss');
  check('map: 初始可达 = 首行 2 节点', ev('runReachable().length') === 2);
  ev('const N0 = RUN.maps[0].rows[0][0];');
  check('map: 首行节点为小怪关', ev('N0.type') === 'fight');
  ev('const F0 = runGetFight(N0);');
  check('fight 小怪: 无加成、无 GAME_RULES 写入', ev('F0.kind') === 'fight' && ev('F0.bonusText') === null && ev('F0.deck.length') > 0);
  check('fight 小怪: 套用自由对战（随机五国之一 + 原版卡组）', ev('["us","de","su","gb","jp"].indexOf(F0.nation)') > -1 && ev('F0.deck.length') > 0 && ev('F0.difficulty') === 'veteran');
  ev('const BASE_DE = buildDeck("de");');
  ev('const EL = (function(){ return runGetFight({ type:"elite", nation:"de" }); })();');
  ev('const tankRaw = BASE_DE.find(function(c){ return c && c.kind === "unit" && c.t === "tank"; });');
  check('elite 德: 坦克 +2/+2（其余字段不变）', ev('tankRaw && EL.deck.find(function(c){ return c.id === tankRaw.id; }).atk === tankRaw.atk + 2 && EL.deck.find(function(c){ return c.id === tankRaw.id; }).hp === tankRaw.hp + 2 && EL.deck.find(function(c){ return c.id === tankRaw.id; }).blood === tankRaw.blood') === true);
  ev('const BASE_JP = buildDeck("jp");');
  ev('const EL2 = (function(){ return runGetFight({ type:"elite", nation:"jp" }); })();');
  ev('const fRaw = BASE_JP.find(function(c){ return c && c.kind === "unit" && (c.t === "fighter" || c.t === "bomber"); });');
  check('elite 日: 飞机部署费 -1（非飞机不变）', ev('fRaw && EL2.deck.find(function(c){ return c.id === fRaw.id; }).blood === Math.max(1, fRaw.blood - 1)') === true);
  ev('RUN.buffs = { kredit:0, enemyHqDmg:0, atkBonus:0 };');
  ev('runFightStart({ type:"elite", nation:"us" });');
  check('elite 美: 敌方开局 2 指挥点槽（槽预置 1）', ev('S.phase') === 'player' && ev('S.a.kreditSlots') === 1 && ev('GAME_RULES.enemyExtraDraw') === undefined);
  ev('RUN.buffs = { kredit:0, enemyHqDmg:0, atkBonus:0 };');
  ev('runFightStart({ type:"boss", bossKind:"tears" });');
  check('run boss tears: bossKind/敌方 us/元帅', ev('S.bossKind') === 'tears' && ev('S.aNation') === 'us' && ev('AI_DIFFICULTY') === 'marshal');
  check('run boss: 无任何关卡规则残留（钩子已拆，只剩总部生命加成）', ev('GAME_RULES.enemyExtraDraw') === undefined && ev('GAME_RULES.hqHpBonus.a') === 0 && ev('GAME_RULES.blizzard') === undefined && ev('GAME_RULES.shrine') === undefined);
  check('run 卡背对应: 己方=主国初始 / 敌方按难度(无残留)', ev('S.backOf.p === backDefaultId("us")') === true && ev('backIdOf("a") !== null') === true);
  ev('RUN.hq = 13;');
  ev('const FW = RUN.maps[0].rows[0][0];');
  ev('RUN._fightNode = FW;');
  ev('const bw = runBattleWin(7);');
  check('战斗结束: 总部回复满血（hq=20 而非残留 7）', ev('RUN.hq') === 20 && ev('bw.victory') === false);
  ev('S.over = true;');
  ev('PENDING.run = false; PENDING.level = null; PENDING.boss = false;');
  ev('setDeckOverride({ p: null, a: null }); setBossKind(null);');

  // ===== 事件：强化 / 献祭 / 熔炉 / 抉择（多步选择流） =====
  ev('const UN = { type:"upgrade", data:{} };');
  check('event upgrade: 视图有选卡列表', ev('runEventView(UN).choices.length === RUN.deck.length + 1') === true);
  ev('const u1 = runChoice(UN, "card:0");');
  check('event upgrade: 选卡后进入二选一', ev('u1.close') === false && ev('runEventView(UN).choices.length') === 3);
  ev('const u2 = runChoice(UN, "opt:stat");');
  check('event upgrade: +1/+1 生效并闭合', ev('u2.close') === true && ev('RUN.deck.length') === 20);
  ev('(function(){ var units = RUN.deck.filter(function(c){ return c.kind === "unit"; }); if(units.length === 0){ RUN.deck[0] = mkUnitDef(NATIONS.us.units[0], "us"); RUN.deck[1] = mkUnitDef(NATIONS.us.units[1], "us"); } else if(units.length === 1){ RUN.deck[0] = mkUnitDef(NATIONS.us.units[0], "us"); } })();');
  ev('const UIS = (function(){ var out=[]; RUN.deck.forEach(function(c,i){ if(c.kind==="unit") out.push(i); }); return out; })();');
  if (ev('UIS.length') >= 2) {
    ev('const SN = { type:"sacrifice", data:{} };');
    ev('const s1 = runChoice(SN, "card:" + UIS[0]);');
    check('event sacrifice: 第一步选祭品', ev('s1.close') === false);
    ev('const TID = RUN.deck[UIS[1]].id; const TFX = RUN.deck[UIS[1]].fx; const TSIG = RUN.deck[UIS[1]].sig;');
    ev('const s2 = runChoice(SN, "card:" + UIS[1]);');
    check('event sacrifice: 承受者继承特效+词条（19 张）', ev('s2.close') === true && ev('RUN.deck.length') === 19
      && ev('(function(){ var c = RUN.deck.find(function(x){ return x.id === TID; }); return c && c.fx.length >= TFX.length && c.sig.length >= TSIG.length; })()'));
  } else check('event sacrifice: 卡组不足两单位（跳过）', true);
  ev('const FU = RUN.deck.find(function(c){ return c.kind === "unit"; });');
  if (ev('!!FU')) {
    ev('RUN.deck[0] = JSON.parse(JSON.stringify(FU)); RUN.deck[1] = JSON.parse(JSON.stringify(FU)); RUN._fuseSel = [0,1];');
    ev('const fr = runFuseConfirm();');
    check('event fusion: 同名合成熔铸（18 张）', ev('fr.close') === true && ev('RUN.deck.length') === 18);
  } else check('event fusion: 无单位卡（跳过）', true);
  ev('const CN = { type:"choice", data:{} };');
  check('choice 节点: 五选一（休整/强化/删卡/增援/熔炉）', ev('runEventView(CN).choices.length') === 5);
  ev('const c1 = runChoice(CN, "fn:upgrade");');
  check('choice: 选兵工厂 → 进选卡', ev('c1.close') === false);
  ev('const c2 = runChoice(CN, "card:0");');
  check('choice: 选卡 → 强化二选一', ev('c2.close') === false && ev('runEventView(CN).choices.length') === 3);
  ev('const c3 = runChoice(CN, "opt:cost");');
  check('choice: 费用 -1 生效并闭合', ev('c3.close') === true);
  ev('const CN2 = { type:"choice", data:{} };');
  const chq0 = ev('RUN.hq');
  ev('const c4 = runChoice(CN2, "fn:rest");');
  check('choice: 休整 = 总部 +3（封顶）', ev('c4.close') === true && ev('RUN.hq') === Math.min(20, chq0 + 3));

  // ===== 回归:引擎无头路径仍可用（单文件 bundle 在浏览器语义下） =====
  ev('setGAME_RULES_OFF(); PENDING.level=null; PENDING.boss=false; PENDING.run=false;');
  ev('setDeckOverride({ p: null, a: null });');
  ev('S.over = false; startGame();');
  check('regression: startGame flow ok', ev('S.phase') === 'player' && ev('S.p.hand.length') >= 5);

  // ===== 反制：激活/收回/敌方触发消耗 =====
  ev('const CC = mkCounterDef(NATIONS.us.counters.find(function(c){ return c.id === "spot"; }), "us");');
  ev('S.p.hand = [CC]; S.p.kredit = 1; S.p.kreditSlots = 1;');
  ev('const k0 = S.p.kredit;');
  ev('const a1 = activateCounter(CC);');
  check('counter: 激活扣费且卡留在手牌', ev('a1 === "armed"') === true && ev('CC.armed') === true && ev('S.p.counters.indexOf("spotEnemy")') >= 0 && ev('S.p.hand.indexOf(CC)') >= 0 && ev('S.p.kredit') === ev('k0 - 1'));
  ev('const a2 = activateCounter(CC);');
  check('counter: 再点收回并退还指挥点', ev('a2 === "disarmed"') === true && ev('CC.armed') === false && ev('S.p.counters.length') === 0 && ev('S.p.kredit') === ev('k0'));
  ev('activateCounter(CC);');   // 重新激活
  ev('S.board[0][0] = makeUnit(mkUnitDef(NATIONS.de.units.find(function(u){ return u.id === "r980"; }), "de"), "a");');
  ev('S.a.kredit = 5;');
  const deckN0 = ev('S.p.deck.length');
  ev('moveForward("a", 0, 0);');
  check('counter 发现敌人: 敌方推进触发 → 抽3 且反制打出', ev('S.p.hand.indexOf(CC)') === -1 && ev('S.p.counters.indexOf("spotEnemy")') === -1 && ev('S.p.deck.length') <= deckN0 - 3);
  ev('const CC2 = mkCounterDef(NATIONS.us.counters.find(function(c){ return c.id === "spot"; }), "us");');
  ev('S.p.hand = [CC2]; S.p.kredit = 5; S.p.kreditSlots = 5; activateCounter(CC2);');
  ev('S.board[0][1] = makeUnit(mkUnitDef(NATIONS.de.units.find(function(u){ return u.id === "r980"; }), "de"), "a");');
  ev('S.a.kredit = 5;');
  const deckN1 = ev('S.p.deck.length');
  ev('moveForward("a", 0, 1);');
  check('counter 再挂仍触发（counterHit 复位）', ev('S.p.hand.indexOf(CC2)') === -1 && ev('S.p.deck.length') <= deckN1 - 3);
  ev('const CC3 = mkCounterDef(NATIONS.us.counters.find(function(c){ return c.id === "spot"; }), "us");');
  ev('S.p.hand = [CC3]; S.p.kredit = 4; S.p.kreditSlots = 4; activateCounter(CC3);');
  ev('beginPlayerTurn();');
  check('反制时效: 下个友方回合自动失效且不退费', ev('CC3.armed') === false && ev('S.p.counters.length') === 0 && ev('S.p.kredit') === 5);
  ev('const CC4 = mkCounterDef(NATIONS.us.counters.find(function(c){ return c.id === "spot"; }), "us");');
  ev('S.p.hand = [CC4]; activateCounter(CC4);');

  // ===== 戈登高人团：指令上浮点击（不再抉择面板） =====
  ev('const GO = mkUnitDef(NATIONS.gb.units.find(function(u){ return u.id === "gordon"; }), "gb");');
  ev('const ORD = mkOrderDef(NATIONS.us.orders[0], "us");');
  ev('S.p.hand.push(ORD);');
  ev('applyDeploy("p", { def: GO }, null);');
  check('gordon: 部署后指令浮起（S.gordonPick=true）', ev('S.gordonPick') === true);
  const dLen0 = ev('S.p.deck.length'); const hLen0 = ev('S.p.hand.length');
  ev('const g1 = gordonResolve(ORD);');
  check('gordon: 点指令 → 费0置卡组顶 + 浮起清除', ev('g1') === true && ev('ORD.blood') === 0 && ev('S.p.deck.length') === dLen0 + 1 && ev('S.p.hand.length') === hLen0 - 1 && ev('S.gordonPick') === false);
  ev('applyDeploy("p", { def: GO }, null); cancelGordon();');
  check('gordon: 结束回合取消浮起', ev('S.gordonPick') === false);

  // ===== AI 火力爆发: 只给友方战斗机; 抽取特效: 任何抽牌手段都触发 =====
  ev('S.over = false; startGame();');
  ev('const PW = mkOrderDef(NATIONS.jp.orders.find(function(o){ return o.id === "power"; }), "jp");');
  ev('S.board[0][0] = makeUnit(mkUnitDef(NATIONS.jp.units.find(function(u){ return u.id === "a6m2"; }), "jp"), "a");');
  ev('S.board[0][1] = makeUnit(mkUnitDef(NATIONS.jp.units.find(function(u){ return u.id === "d3a"; }), "jp"), "a");');
  ev('S.a.hand = [PW]; S.a.kredit = 3;');
  ev('const p1 = aiChoosePlay(new Set());');
  ev('const p2 = aiPlayBuff();');
  check('AI 火力爆发: 只给友方战斗机（轰炸机不可）', (ev('!p1 || unitAt(p1.tgt.row, p1.tgt.col).def.t === "fighter"') === true) && (ev('!p2 || unitAt(p2.tgt.row, p2.tgt.col).def.t === "fighter"') === true));
  ev('S.p.deck = [mkUnitDef(NATIONS.us.units.find(function(u){ return u.id === "pb2y"; }), "us")];');
  ev('S.p.hand = []; S.p.prodDeck = [];');
  ev('drawCards(S.p, 1, true);');   // noReveal=true 的开局式抽取也须触发抽取特效
  check('抽取特效: 任何抽牌手段抽到抽取卡都触发（PB2Y→F2A上阵）', ev('(function(){ for(var r=0;r<3;r++) for(var c=0;c<5;c++){ const x=S.board[r][c]; if(x && x.def.id === "f2a") return true; } return false; })()') === true);

  // ===== Hs 129：部署战斗目标点选 =====
  ev('const HS = mkUnitDef(NATIONS.de.units.find(function(u){ return u.id === "hs129"; }), "de");');
  check('hs129: 卡面 target=enemy（可点选）', ev('HS.target') === 'enemy');
  ev('S.board[0][1] = makeUnit(mkUnitDef(NATIONS.su.units.find(function(u){ return u.id === "r554"; }), "su"), "a");');
  ev('S.board[0][2] = makeUnit(mkUnitDef(NATIONS.de.units.find(function(u){ return u.id === "tiger"; }), "de"), "a");');
  ev('const pickU = S.board[0][1];');
  ev('S.pickTarget = pickU;');
  ev('spawnUnit("p", HS, 2, 0);');
  check('hs129: 与点选单位战斗（另一只未受伤）', ev('S.board[0][1]') === null && ev('!!S.board[0][2]') === true && ev('S.board[0][2].hp') === 8);

  // ===== Hs 129 纯数值交换：类型无豁免 + 重甲不减免 =====
  ev('S.over = false; startGame();');
  ev('const HS2 = mkUnitDef(NATIONS.de.units.find(function(u){ return u.id === "hs129"; }), "de");');
  ev('S.board[0][2] = makeUnit(mkUnitDef(NATIONS.jp.units.find(function(u){ return u.id === "d3a"; }), "jp"), "a");'); // 轰炸机（常规不反击）
  ev('S.pickTarget = S.board[0][2];');
  ev('spawnUnit("p", HS2, 2, 0);');
  check('hs129 数值交换: 轰炸机也反击（敌死仍反 3 伤）', ev('S.board[0][2]') === null && ev('(function(){ for(var r=0;r<3;r++)for(var c=0;c<5;c++){ var x=S.board[r][c]; if(x && x.def.id==="hs129") return x.hp; } return null; })()') === 2);
  ev('const HS3 = mkUnitDef(NATIONS.de.units.find(function(u){ return u.id === "hs129"; }), "de");');
  ev('S.board[0][4] = makeUnit(mkUnitDef(NATIONS.de.units.find(function(u){ return u.id === "tiger"; }), "de"), "a");'); // 虎式 8/8 重甲2（坦克=陆军）
  ev('S.pickTarget = S.board[0][4];');
  ev('spawnUnit("p", HS3, 2, 1);');
  check('hs129 数值交换: 对陆军+2 且重甲不减（虎式受 6）', ev('S.board[0][4].hp') === 2);

  // ===== 攻击行动可见：onAttack 事件（单位战 / 总部战） =====
  ev('window.__atkFx = []; const _origAtk = HOOKS.onAttack; HOOKS.onAttack = function(e){ window.__atkFx.push(e); _origAtk(e); };');
  ev('S.board[1][3] = makeUnit(mkUnitDef(NATIONS.su.units.find(function(u){ return u.id === "t34"; }), "su"), "p");');
  ev('S.board[0][3] = makeUnit(mkUnitDef(NATIONS.de.units.find(function(u){ return u.id === "r980"; }), "de"), "a");');
  ev('S.p.kredit = 10;');
  ev('combat({row:1,col:3},{row:0,col:3});');
  check('攻击可见: 单位战事件（伤害+反击）', ev('window.__atkFx.length') >= 1 && ev('window.__atkFx[window.__atkFx.length-1].hq') === false && ev('window.__atkFx[window.__atkFx.length-1].dd') >= 4 && ev('window.__atkFx[window.__atkFx.length-1].rd') >= 2);
  ev('S.board[1][2] = makeUnit(mkUnitDef(NATIONS.us.units.find(function(u){ return u.id === "r506"; }), "us"), "p");');
  ev('combat({row:1,col:2},{hq:true});');
  check('攻击可见: 总部战事件', ev('window.__atkFx[window.__atkFx.length-1].hq') === true && ev('window.__atkFx[window.__atkFx.length-1].dd') >= 1);

  // ===== 部署/推进/死亡/总部爆炸：动画钩子均发出 =====
  ev('S.over = false; startGame();');
  ev('window.__fx2 = []; (function(){ const o1=HOOKS.onCounterTrigger,o2=HOOKS.onUnitDeath,o3=HOOKS.onUnitDeploy,o4=HOOKS.onHqExplode,o5=HOOKS.onMoveForward; HOOKS.onCounterTrigger=function(e){ window.__fx2.push("C:"+e.eff); o1(e); }; HOOKS.onUnitDeath=function(e){ window.__fx2.push("D"); o2(e); }; HOOKS.onUnitDeploy=function(e){ window.__fx2.push("U:"+(e.hasDeploy?1:0)); o3(e); }; HOOKS.onHqExplode=function(e){ window.__fx2.push("E:"+e.side); o4(e); }; HOOKS.onMoveForward=function(e){ window.__fx2.push("M:"+e.fromRow+","+e.fromCol+">"+e.toRow+","+e.toCol); o5(e); }; })();');
  ev('(function(){ for(var r=0;r<3;r++) for(var c=0;c<5;c++){ if(!S.board[r][c]){ PFR={r:r,c:c}; return; } } })();');
  ev('spawnUnit("p", mkUnitDef(NATIONS.us.units.find(function(u){ return u.id === "r506"; }), "us"), PFR.r, PFR.c);');
  ev('killUnit(PFR.r, PFR.c);');
  ev('(function(){ for(var c=0;c<5;c++){ if(!S.board[0][c] && !S.board[1][c]){ PMC={c:c}; return; } } })();');
  ev('S.board[0][PMC.c] = makeUnit(mkUnitDef(NATIONS.de.units.find(function(u){ return u.id === "r980"; }), "de"), "a");');
  ev('S.a.kredit = 5;');
  ev('moveForward("a", 0, PMC.c);');
  ev('S.a.hp = 0; checkGameOver();');
  check('FX hooks: 部署/推进/死亡/总部爆炸均发出', ev('(function(){ const s = window.__fx2.join(","); return s.indexOf("U:") >= 0 && s.indexOf("D") >= 0 && s.indexOf("M:0," + PMC.c + ">1," + PMC.c) >= 0 && s.indexOf("E:a") >= 0; })()') === true);
} catch (e) {
  console.error('TEST ERROR: ' + e.stack);
  process.exit(1);
}

console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
