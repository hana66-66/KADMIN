/* ============================================================
   铭刻前线 —— 启动装配（src/main.js）
   浏览器加载顺序：cards → engine → ai → ui → main（build.mjs 拼接）。
   职责：选卡组面板（原选国页）+ HOOKS 注入 + 输入绑定 + 首帧渲染。
   仅浏览器执行（Node 下 require 安全，顶层不碰 DOM）。
   ============================================================ */

/* ---------- 选卡组面板（原选国页） ----------
   卡组条目：自定义（组卡器已保存槽位）+ 五国初始卡组；
   默认卡组名 = 「主国名+初始」；卡组卡图 = 对应国家卡背（装饰/卡背/{国}初始.jpg）。 */
function listDeckEntries(){
  const entries = [];
  (SAVE.deckSlots || []).forEach((d, i) => {
    if(d && d.nation && d.cards && d.cards.length && d.nation !== undefined){
      const allyTxt = (d.ally && NATIONS[d.ally]) ? ' · ' + NATIONS[d.ally].name : '';
      entries.push({ kind:'slot', slot:i, key:d.nation,
        name:(d.name && d.name !== '未命名') ? d.name : ('卡组' + 'ABC'[i]),
        meta: NATIONS[d.nation].name + allyTxt + ' · ' + d.cards.length + ' 张',
        deckP: buildDeckCustom(d.nation, d.ally || null, d.cards) });
    }
  });
  Object.entries(NATIONS).forEach(([key, n]) => {
    if(n.allyOnly) return;                     // 盟国：只能作为盟国出战，不提供初始卡组
    entries.push({ kind:'init', key, name: n.name + '初始', meta: n.name + ' · 原版预组', deckP: null });
  });
  return entries;
}
function deckCardHtml(e2){
  const art = backArtOf(backDefaultId(e2.key)) || imgUrl('筛选用图标/国家/' + flagNameOf(e2.key) + '.png');
  return '<div class="nationCard" data-act="deckPick" data-kind="'+e2.kind+'" data-key="'+e2.key+'"'+(e2.slot !== undefined ? ' data-slot="'+e2.slot+'"' : '')+' title="'+esc(e2.meta)+'">'+
    '<div class="nb" style="background-image:url(\'' + art + '\')"></div>'+
    '<div class="no"></div>'+
    '<div class="nn"><div class="nm">'+esc(e2.name)+'</div><div class="np">'+esc(e2.meta)+'</div></div>'+
  '</div>';
}
function renderNationPicker(){
  const list = listDeckEntries();
  const firstSlot = list.findIndex(x => x.kind === 'slot');
  const firstInit = list.findIndex(x => x.kind === 'init');
  let html = '';
  if(firstSlot > -1) html += '<div class="dpSec">自 定 义 卡 组</div>' + list.slice(0, firstInit).map(deckCardHtml).join('');
  if(firstInit > -1) html += '<div class="dpSec">初 始 卡 组</div>' + list.slice(firstInit).map(deckCardHtml).join('');
  $('nationPicker').innerHTML = html;
}
/* 点击/随机 卡组条目 → 开局（初始卡组=默认预组；自定义=该槽位卡组，并设为激活槽） */
function dispatchDeckPick(e2){
  if(!e2) return;
  if(e2.kind === 'slot'){
    if(!e2.deckP || !e2.deckP.length){ toast('该卡组为空'); return; }
    SAVE.activeSlot = e2.slot; saveV2Save();
    pickNation(e2.key, e2.deckP, e2.back || null, e2.hq || null);
  } else {
    pickNation(e2.key, null, e2.back || null, e2.hq || null); // 初始：强制默认预组（不被已保存的同国卡组拦截）
  }
}

/* ---------- 启动 ---------- */
function boot(){
  try {
    installHooks();        // ui.js：向引擎 HOOKS 注入 DOM/音频/定时器实现
    bindInput();           // ui.js：输入事件与按钮装配
    renderNationPicker();  // 选卡组面板
    render();              // 首帧渲染
    initV2();              // [v2] 读档 + 主菜单(战役列表/设置应用/视图复位)
    applyDesk(false);      // 初始背景 = 默认桌面
  } finally {
    // 启动完成：移除加载遮罩（解析/解码期的卡顿由遮罩顶住；纯 CSS 动画在合成器线程不影响）
    try { const l = document.getElementById('loading'); if(l){ l.classList.add('done'); } } catch(e) {}
  }
}

/* ---------- [v2] 启动初始化(数据层在 ui.js v2 模块) ---------- */
function initV2(){
  setGAME_RULES_OFF();
  setAI_DIFFICULTY(SAVE.settings.lastDifficulty || 'recruit');
  S.wins = SAVE.stats.wins; S.losses = SAVE.stats.losses;   // 战绩并入统一存档
  showView('menu');
}
if (typeof document !== 'undefined') boot();

/* Node 导出（浏览器下跳过） */
if (typeof module !== 'undefined') module.exports = { renderNationPicker, boot, listDeckEntries, dispatchDeckPick };
