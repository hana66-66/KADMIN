/* ============================================================
   开始游戏 —— UI 层（src/runui.js）
   与 src/run.js（逻辑层，零 DOM）配套：runui 只做渲染/输入，
   所有规则状态（RUN 对象）与事件效果由 run.js 提供。
   加载顺序（build.mjs LOAD_ORDER）：cards → engine → ai → ui
   → v2ui → run → runui → main。
   安全约束：
   ① 顶层不访问 DOM（仅注册 click 委托；smoke 沙箱 addEventListener 是 no-op，
      DOMContentLoaded 不会触发，故所有初始化都放进 runInit）。
   ② 不复用/重声明 cards/engine/ai/ui/v2ui/run 的顶层 const/let/函数名；
      新增符号一律带 run 前缀。
   ③ 全部动态文本经 esc() 转义；风格贴合现有 UI（楷体/深褐木纹/金色高亮）。
   ④ run.js 事件返回值契约为 {text, close:boolean}：close=true 事件完成
      （UI 关面板、节点打勾、重绘地图）；close=false 多步事件
      （UI 重取 runEventView(node) 重渲染面板）。
   ============================================================ */

/* ---------- run.js 逻辑层接口适配（名称以 run.js 实际实现为准） ---------- */
const RUN_L = {
  beginDraft: (typeof runBeginDraft === 'function') ? runBeginDraft : null,
  draftNext:  (typeof runDraftNext   === 'function') ? runDraftNext   : null,
  draftPick:  (typeof runDraftPick   === 'function') ? runDraftPick   : null,
  mapInit:    (typeof runMapInit     === 'function') ? runMapInit     : null,
  reachable:  (typeof runReachable   === 'function') ? runReachable   : null,
  enter:      (typeof runNodeEnter   === 'function') ? runNodeEnter   : null,
  done:       (typeof runNodeDone    === 'function') ? runNodeDone    : null,
  view:       (typeof runEventView   === 'function') ? runEventView   : null,
  choice:     (typeof runChoice      === 'function') ? runChoice      : null,
  confirmFuse:(typeof runFuseConfirm === 'function') ? runFuseConfirm : null,
  fight:      (typeof runGetFight    === 'function') ? runGetFight    : null,
  bossInfo:   (typeof runBossInfo    === 'function') ? runBossInfo    : null,
  battleWin:  (typeof runBattleWin   === 'function') ? runBattleWin   : null,
  reset:      (typeof runReset       === 'function') ? runReset       : null
};
function runL(fn, label, args){
  if(!fn){ console.warn('[开始游戏] run.js 未提供 ' + label + '()'); return null; }
  return fn.apply(null, args);
}

/* ---------- 征程 UI 局部状态（本文件专属） ---------- */
let RUN_sel = -1;          // 需选卡的 choice：当前选中卡下标
let RUN_curNode = null;    // 当前事件节点
let RUN_curView = null;    // 当前事件视图（缓存，供选卡重渲染）
const RUN_NODE_ICONS = { fight:'⚔️', elite:'⚙️', boss:'🏰', add:'➕', remove:'➖', upgrade:'🔧', sacrifice:'🕯', fusion:'⚒️', item:'🎁', choice:'⚖️' };

/* ---------- 注入样式（深色木纹，与游戏一致） ---------- */
const RUN_STYLE = '\n' +
'/* ===== 开始游戏（runui.js 注入） ===== */\n' +
'#runOverlay{position:fixed;inset:0;z-index:88;display:none;align-items:center;justify-content:center;' +
  'background:radial-gradient(ellipse at center,rgba(60,35,12,.55),rgba(0,0,0,.96));}\n' +
'#runOverlay.show{display:flex;}\n' +
'#runOverlay .runView{display:none;width:min(1060px,96vw);max-height:94vh;overflow-y:auto;' +
  'padding:10px 14px 20px;border-radius:14px;' +
  'background:radial-gradient(ellipse at 50% 0%,rgba(96,58,20,.35),transparent 70%);}\n' +
'#runOverlay .runView.show{display:block;}\n' +
'#runOverlay h1{font-size:36px;letter-spacing:8px;color:#f0d58a;text-align:center;' +
  'text-shadow:0 0 22px rgba(240,180,80,.55),0 3px 8px #000;}\n' +
'#runOverlay .runSub{font-size:13px;color:#b39a66;letter-spacing:3px;text-align:center;margin:4px 0 12px;}\n' +
'#runOverlay .runFlavor{font-size:14px;color:#d8c48e;line-height:1.9;letter-spacing:2px;' +
  'text-align:center;margin:0 auto 14px;max-width:780px;}\n' +
'#runOverlay .runCenter{text-align:center;margin-top:14px;}\n' +
'#runOverlay .bigbtn{font-size:16px;letter-spacing:4px;padding:8px 30px;}\n' +
'#toast{z-index:120;}\n' +
'.runGrid{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;}\n' +
'.runNationCard{width:170px;height:230px;border-radius:12px;position:relative;cursor:pointer;overflow:hidden;' +
  'border:3px solid #4a2f14;box-shadow:0 6px 16px rgba(0,0,0,.7);transition:transform .18s,box-shadow .18s;background:#241407;}\n' +
'.runNationCard:hover{transform:translateY(-8px) scale(1.04);border-color:#f0d58a;box-shadow:0 12px 26px rgba(0,0,0,.85);}\n' +
'.runNationCard .rncBg{position:absolute;inset:0;background-size:cover;background-position:center;}\n' +
'.runNationCard .rncOv{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,5,2,.05),rgba(8,5,2,.92));}\n' +
'.runNationCard .rncBody{position:absolute;bottom:0;left:0;right:0;padding:8px 6px 10px;text-align:center;}\n' +
'.runNationCard .rncName{font-size:19px;font-weight:bold;color:#f0d58a;letter-spacing:4px;text-shadow:0 2px 4px #000;}\n' +
'.runNationCard .rncMeta{font-size:11px;color:#ffcf5a;letter-spacing:1px;margin-top:3px;text-shadow:0 1px 3px #000;}\n' +
'.runNationCard .rncMeta2{font-size:10px;color:#d8c48e;margin-top:2px;text-shadow:0 1px 3px #000;}\n' +
'.runGrid .runNationCard { width: auto; flex: 1 1 0; max-width: 172px; height: auto; aspect-ratio: 170 / 230; }\n' +
'.runDraftCard{width:292px;border-radius:12px;padding:10px;cursor:pointer;transition:transform .16s,box-shadow .16s;' +
  'background:linear-gradient(170deg,#f2e5c0,#d3bd8e 60%,#b89e6a);border:3px solid #4a2f14;' +
  'box-shadow:0 5px 14px rgba(0,0,0,.6);}\n' +
'.runDraftCard:hover{transform:translateY(-6px);border-color:#ffd94a;box-shadow:0 12px 24px rgba(0,0,0,.85);}\n' +
'.runDraftCard .rdImg{height:210px;display:flex;align-items:center;justify-content:center;border-radius:7px;' +
  'overflow:hidden;background:#14100c;border:1px solid #2a1a0a;margin-bottom:6px;}\n' +
'.runDraftCard .rdImg img{width:100%;height:100%;object-fit:contain;}\n' +
'.runDraftCard .rdName{font-size:17px;font-weight:bold;color:#3a2410;letter-spacing:1px;text-align:center;}\n' +
'.runDraftCard .rdStats{font-size:13px;color:#5d4423;text-align:center;margin-top:2px;}\n' +
'.runDraftCard .rdSig{font-size:11px;color:#7a5a2a;text-align:center;margin-top:2px;}\n' +
'.runDraftCard .rdFrom{font-size:11px;color:#a08050;text-align:center;margin-top:3px;}\n' +
'.runProg{text-align:center;font-size:14px;color:#f0d58a;letter-spacing:3px;margin:6px 0 12px;}\n' +
'.runTop{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;' +
  'padding:8px 14px;border-radius:9px;background:linear-gradient(#3a2410,#241407);' +
  'border:2px solid #6a4a24;margin-bottom:10px;font-size:14px;letter-spacing:2px;color:#e8d9b0;}\n' +
'.runTop .rtItem{display:inline-flex;align-items:center;gap:4px;}\n' +
'.runTop .rtClick{cursor:pointer;padding:3px 10px;border-radius:6px;background:rgba(0,0,0,.35);border:1px solid #5d3a18;}\n' +
'.runTop .rtClick:hover{filter:brightness(1.35);border-color:#e8c87a;}\n' +
'.runMapWrap{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 4px 14px;}\n' +
'.runMapTitle{font-size:16px;letter-spacing:4px;color:#ffd94a;text-shadow:0 0 12px rgba(255,217,74,.4);margin-bottom:6px;}\n' +
'.runMapRow{position:relative;width:100%;height:86px;}\n' +
'.runMapEdge{position:relative;width:100%;height:30px;}\n' +
'.runMapEdge svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;display:block;}\n' +
'.runMapEdge line{stroke:#6a4a24;stroke-width:2;stroke-dasharray:4 5;opacity:.85;vector-effect:non-scaling-stroke;}\n' +
'.runMapEdge line.hot{stroke:#ffd94a;stroke-width:2.4;stroke-dasharray:7 4;opacity:1;' +
  'filter:drop-shadow(0 0 3px rgba(255,217,74,.6));}\n' +
'.runNode{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:78px;height:78px;' +
  'border-radius:50%;display:flex;flex-direction:column;' +
  'align-items:center;justify-content:center;background:radial-gradient(circle at 35% 30%,#5d3d1e,#2a1a0b);' +
  'border:2px solid #6a4a24;box-shadow:0 3px 8px rgba(0,0,0,.6);transition:transform .15s;}\n' +
'.runNode.reachable{cursor:pointer;border-color:#e8c87a;box-shadow:0 0 14px rgba(232,200,122,.5);}\n' +
'.runNode.reachable:hover{transform:translate(-50%,-50%) scale(1.1);}\n' +
'.runNode .rnIcon{font-size:26px;line-height:1;}\n' +
'.runNode .rnName{font-size:10px;color:#d8c48e;letter-spacing:1px;margin-top:3px;' +
  'max-width:74px;white-space:nowrap;overflow:hidden;}\n' +
'.runNode.done{filter:grayscale(.75) brightness(.9);}\n' +
'.runNode.done::after{content:"✓";position:absolute;top:-5px;right:-5px;width:19px;height:19px;' +
  'border-radius:50%;background:#2a6a2a;color:#cfe8cf;font-size:12px;line-height:19px;text-align:center;' +
  'border:1px solid #4a8a4a;}\n' +
'.runNode.cur{animation:pulseGold 1.1s infinite;border-color:#ffd94a;}\n' +
'.runNode.locked{opacity:.45;filter:grayscale(.7);}\n' +
'.runNode.boss{width:96px;height:96px;border-width:3px;border-color:#c09a3a;}\n' +
'.runNode.boss .rnName{font-size:12px;color:#ffd94a;}\n' +
'.runNode.elite{border-color:#d46a2a;}\n' +
'.runDeckGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(106px,1fr));gap:8px;' +
  'max-width:840px;margin:10px auto;}\n' +
'.runDeckGrid.pmGrid{max-width:none;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));}\n' +
'.runMiniCard{border-radius:8px;padding:4px;background:linear-gradient(170deg,#f2e5c0,#d3bd8e 60%,#b89e6a);' +
  'border:2px solid #4a2f14;text-align:center;cursor:pointer;transition:transform .12s,border-color .12s;}\n' +
'.runMiniCard:hover{transform:translateY(-3px);border-color:#e8c87a;}\n' +
'.runMiniCard.order{background:linear-gradient(170deg,#e8d4c0,#c2a088 60%,#a88462);}\n' +
'.runMiniCard.sel{border-color:#ffd94a;box-shadow:0 0 12px rgba(255,217,74,.85);transform:translateY(-3px);}\n' +
'.runMiniCard .rmImg{height:56px;display:flex;align-items:center;justify-content:center;border-radius:5px;' +
  'overflow:hidden;background:#14100c;border:1px solid #2a1a0a;}\n' +
'.runMiniCard .rmImg img{max-width:100%;max-height:100%;}\n' +
'.runMiniCard .rmName{font-size:10.5px;font-weight:bold;color:#3a2410;white-space:nowrap;overflow:hidden;margin-top:2px;}\n' +
'.runMiniCard .rmStats{font-size:10px;color:#5d4423;}\n' +
'.runMiniCard .rmSig{font-size:8.5px;color:#7a5a2a;white-space:nowrap;overflow:hidden;}\n' +
'.runMiniCard .rmEff{font-size:9px;color:#4a2a14;line-height:1.3;margin-top:1px;}\n' +
'.runModal{position:fixed;inset:0;z-index:95;display:none;align-items:center;justify-content:center;' +
  'background:rgba(0,0,0,.82);}\n' +
'.runModal.show{display:flex;}\n' +
'.runModal .panel{width:640px;max-width:94vw;max-height:86vh;overflow:auto;padding:20px 24px;' +
  'border-radius:12px;background:linear-gradient(#2e1c0c,#1c1006);border:3px solid #6a4a24;' +
  'box-shadow:0 0 40px rgba(0,0,0,.9);text-align:left;}\n' +
'.runModal .pmTitle{font-size:20px;letter-spacing:3px;color:#f0d58a;text-align:center;}\n' +
'.runModal .pmText{font-size:14px;color:#d8c48e;line-height:1.9;margin:10px 0;letter-spacing:1px;}\n' +
'.runModal .pmChoices{display:flex;flex-direction:column;gap:8px;margin-top:12px;}\n' +
'.runModal .pmChoice{font-family:inherit;font-size:15px;letter-spacing:3px;padding:9px 16px;cursor:pointer;' +
  'background:linear-gradient(#6a4a24,#3a2410);color:#f0d58a;border:2px solid #2a1808;' +
  'border-radius:8px;box-shadow:0 3px 8px rgba(0,0,0,.6);}\n' +
'.runModal .pmChoice:hover{filter:brightness(1.3);}\n' +
'.runModal .pmHint{font-size:12px;color:#a98d55;text-align:center;letter-spacing:1px;margin:10px 0 2px;}\n' +
'.runModal .runBtnOff{opacity:.5;cursor:not-allowed;filter:grayscale(.6);}\n' +
'.runModal .runBtnOff:hover{filter:grayscale(.6);}\n' +
'.runEndBox{margin:14px auto;max-width:560px;padding:16px 20px;border-radius:10px;text-align:center;' +
  'background:linear-gradient(#3a2410,#241407);border:2px solid #6a4a24;' +
  'font-size:15px;line-height:2;color:#d8c48e;letter-spacing:2px;}\n' +
'.runEndBox b{color:#ffcf5a;}\n';

/* ---------- 视图切换（runOverlay 内部，不动 v2ui 的 #overlay/showView） ---------- */
function runShow(v){
  const ov = $('runOverlay'); if(!ov) return;
  ov.classList.add('show');
  const views = document.querySelectorAll('#runOverlay .runView');
  for(let i=0;i<views.length;i++) views[i].classList.remove('show');
  const el = $('runV-' + v);
  if(el) el.classList.add('show');
}
function runOverlayHide(){
  const ov = $('runOverlay'); if(ov) ov.classList.remove('show');
  closeRunModal();
}
function runExitToMenu(){
  runOverlayHide();
  const ov = $('overlay'); if(ov) ov.classList.remove('hidden');
  showView('menu');
  if(typeof bgmBackToMenu === 'function') bgmBackToMenu();   // 离开征程＝回主菜单曲（并轮到下一首）
}
function closeRunModal(){ const m = $('runModal'); if(m) m.classList.remove('show'); }
function openRunModalPanel(html){
  const p = $('runModalPanel'); if(p) p.innerHTML = html;
  const m = $('runModal'); if(m) m.classList.add('show');
}

/* ---------- 菜单入口 + 初始化（DOMContentLoaded 一次性装配） ---------- */
function runInit(){
  if($('runOverlay')) return;                       // 防重复注入
  const st = document.createElement('style');
  st.id = 'runStyle'; st.textContent = RUN_STYLE;
  document.head.appendChild(st);
  const ov = document.createElement('div');
  ov.id = 'runOverlay';
  ov.innerHTML =
    '<div class="runView" id="runV-nation"></div>' +
    '<div class="runView" id="runV-ally"></div>' +
    '<div class="runView" id="runV-draft"></div>' +
    '<div class="runView" id="runV-map"></div>' +
    '<div class="runView" id="runV-end"></div>' +
    '<div class="runModal" id="runModal"><div class="panel" id="runModalPanel"></div></div>';
  document.body.appendChild(ov);
  const mb = document.querySelector('#ovMenu .menuBtns');
  if(mb){
    const b = document.createElement('button');
    b.className = 'bigbtn menuBtn'; b.dataset.act = 'runStart';
    b.textContent = '开 始 游 戏';
    mb.appendChild(b);
  }
  /* 对局结束接管：开始游戏的对局走 runBattleEnd，其余原样转发（保留原引用） */
  const origGameEnd = HOOKS.onGameEnd;
  HOOKS.onGameEnd = function(winner){
    if(PENDING && PENDING.run && RUN && RUN.active && typeof runBattleEnd === 'function'){
      runBattleEnd(winner);
    } else {
      origGameEnd(winner);
    }
  };
}

/* ---------- 顶层点击委托（data-act 均带 run 前缀，与 v2ui 委托互不冲突） ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if(!el) return;
  switch(el.dataset.act){
    case 'runStart':        runOpenStart(); break;
    case 'runNationMain':   runNationMain(el.dataset.k); break;
    case 'runNationAlly':   runNationAlly(el.dataset.k); break;
    case 'runDraftPick':    runDraftPickDo(+el.dataset.i); break;
    case 'runNationBack':   runOpenStart(); break;
    case 'runNode':         runNodeOpen(el.dataset.id); break;
    case 'runChoice':       runChoiceDo(el.dataset.id); break;
    case 'runSelCard':      runSelCard(+el.dataset.i); break;
    case 'runFuseConfirm':  runFuseConfirmDo(); break;
    case 'runDeck':         runDeckOpen(); break;
    case 'runModalClose':   closeRunModal(); break;
    case 'runContinue':     runContinue(); break;
    case 'runEndExit':      runEndExit(); break;
    case 'runBackMenu':     runBackMenu(); break;
  }
});

/* ============================================================
   开局：选主国（初始卡背）→ 选盟国（其余卡背）→ 10 次三选一
   ============================================================ */
function runOpenStart(){
  if(RUN && RUN.active && typeof confirm === 'function' && !confirm('当前游戏尚未结束，重新开始将丢弃全部进度。确定吗？')){
    return;
  }
  RUN_sel = -1; RUN_curNode = null; RUN_curView = null;
  const box = $('runV-nation'); if(!box) return;
  box.innerHTML =
    '<h1>选 择 主 国</h1>' +
    '<div class="runGrid">' +
    Object.keys(NATIONS).filter(k => !NATIONS[k].allyOnly).map(k => {
      const n = NATIONS[k];
      const art = (typeof backArtOf === 'function' && typeof backDefaultId === 'function') ? backArtOf(backDefaultId(k), 0) : '';
      return '<div class="runNationCard" data-act="runNationMain" data-k="' + k + '" title="选择 ' + esc(n.name) + '">' +
        (art ? '<div class="rncBg" style="background-image:url(\'' + art + '\')"></div>' : '<div class="rncBg" style="background:#241407"></div>') +
        '<div class="rncOv"></div>' +
        '<div class="rncBody">' +
          '<div class="rncName">' + esc(n.name) + '</div>' +
        '</div>' +
      '</div>';
    }).join('') +
    '</div>' +
    '<div class="runCenter"><button class="bigbtn" data-act="runBackMenu">返 回 菜 单</button></div>';
  runShow('nation');
}
function runNationMain(key){
  const sub = RUN; sub._mainPick = key;
  const box = $('runV-ally'); if(!box) return;
  const others = Object.keys(NATIONS).filter(k => k !== key);
  box.innerHTML =
    '<h1>选 择 盟 国</h1>' +
    '<div class="runGrid">' +
    others.map(k => {
      const n = NATIONS[k];
      const art = (typeof backArtOf === 'function' && typeof backDefaultId === 'function') ? backArtOf(backDefaultId(k), 0) : '';
      return '<div class="runNationCard" data-act="runNationAlly" data-k="' + k + '" title="选择盟国 ' + esc(n.name) + '">' +
        (art ? '<div class="rncBg" style="background-image:url(\'' + art + '\')"></div>' : '<div class="rncBg" style="background:#241407"></div>') +
        '<div class="rncOv"></div>' +
        '<div class="rncBody">' +
          '<div class="rncName">' + esc(n.name) + '</div>' +
        '</div>' +
      '</div>';
    }).join('') +
    '</div>' +
    '<div class="runCenter"><button class="bigbtn" data-act="runNationBack">重 选 主 国</button></div>';
  runShow('ally');
}
function runNationAlly(key){
  const main = RUN._mainPick || key;
  runL(RUN_L.beginDraft, 'runBeginDraft', [main, key]);
  renderRunDraft();
}

/* ============================================================
   抽卡页：3 选 1 × 10
   ============================================================ */
function renderRunDraft(){
  const r = runL(RUN_L.draftNext, 'runDraftNext', []);
  if(!r){ toast('抽卡数据未就绪'); return; }
  if(r.done){
    runL(RUN_L.mapInit, 'runMapInit', []);
    renderRunMap();
    return;
  }
  const box = $('runV-draft'); if(!box) return;
  const fromName = k => NATIONS[k] ? NATIONS[k].name : k;
  box.innerHTML =
    '<h1>组 建 卡 组</h1>' +
    '<div class="runSub">主国 ' + esc(fromName(RUN.nation)) + ' × 盟国 ' + esc(fromName(RUN.ally)) + ' · 随机三选一 · 共 ' + r.total + ' 次</div>' +
    '<div class="runProg">第 ' + r.round + ' / ' + r.total + ' 次抉择 · 当前卡组 ' + (RUN.deck||[]).length + ' 张</div>' +
    '<div class="runGrid">' +
    (r.options||[]).map((o,i) =>
      '<div class="runDraftCard" data-act="runDraftPick" data-i="' + i + '" data-info="'+(o.def.nation||o.from)+':'+o.def.kind+':'+o.def.id+'">' +
        '<div class="rdImg">' + artHTML(o.def, true) + '</div>' +
        '<div class="rdName">' + esc(o.def.n) + '</div>' +
        '<div class="rdStats">' + runCardStats(o.def) + '</div>' +
        ((o.def.kind === 'unit' && (o.def.sig||[]).length) ? '<div class="rdSig">' + esc((o.def.sig||[]).map(s=>SIGINFO[s]?SIGINFO[s].n:s).join('·')) + '</div>' : '') +
        '<div class="rdFrom">' + esc(fromName(o.from)) + '</div>' +
      '</div>').join('') +
    '</div>' +
    '<div class="runCenter"><span class="bigbtn" data-act="runDeck" style="font-size:14px;padding:6px 20px;cursor:pointer">查 看 卡 组</span>' +
    ' <button class="bigbtn" data-act="runNationBack">重 选 国 家</button></div>';
  runShow('draft');
}
function runDraftPickDo(i){
  const res = runL(RUN_L.draftPick, 'runDraftPick', [i]);
  if(res && res.text) toast(res.text);
  if(res && res.done){
    runL(RUN_L.mapInit, 'runMapInit', []);
    toast('卡组定了。老牧师卷起地图：「出发吧。」');
    renderRunMap();
  } else if(res && res.close){
    renderRunDraft();
  }
}
function runCardStats(d){
  if(d.kind === 'unit') return '⚔' + (d.atk||0) + ' ❤' + (d.hp||0) + (d.blood ? ' · 费' + d.blood : '') + (d.fuel ? ' · 油' + d.fuel : '');
  return '费' + (d.blood||0) + ' · ' + (d.kind === 'order' ? '指 令' : '反 制');
}

/* ============================================================
   地图页：三张图（杀戮尖塔式分支路线），关底 = Boss
   ============================================================ */
function renderRunMap(){
  const box = $('runV-map'); if(!box) return;
  if(typeof bgmStart === 'function'){ bgmLockForMatch('@run', false); bgmStart(); }   // 回到地图＝保持当前曲子（全库随机；rotate=false 保证不是每次渲染都换曲）
  const map = (RUN.maps && RUN.maps[RUN.mapIdx]) || null;
  const bossInfo = runL(RUN_L.bossInfo, 'runBossInfo', []) || {};
  const reach = runL(RUN_L.reachable, 'runReachable', []) || [];
  const reachSet = {};
  reach.forEach(id => reachSet[id] = true);
  const deckN = (RUN.deck || []).length;
  const top =
    '<div class="runTop">' +
      '<span class="rtItem">❤ ' + RUN.hq + '/' + RUN.hqMax + '</span>' +
      '<span class="rtItem">🗺 ' + (RUN.mapIdx + 1) + '/3 图</span>' +
      '<span class="rtItem rtClick" data-act="runDeck" title="查看卡组">🃏 ' + deckN + ' 张</span>' +
      '<span class="rtItem rtClick" data-act="runBackMenu" title="离开">↩ 离开</span>' +
    '</div>';
  if(!map){
    box.innerHTML = top + '<div class="runSub">地图未生成。</div>';
    runShow('map');
    return;
  }
  let rows = '';
  for(let r=0; r<map.rows.length; r++){
    const row = map.rows[r];
    rows += '<div class="runMapRow">' + row.map(nd => runMapNodeHTML(nd, reachSet, runXPct(nd.col, row.length))).join('') + '</div>';
    rows += (r < map.rows.length - 1)
      ? runEdgeRowHTML(row, map.rows[r + 1], reachSet)
      : runEdgeRowHTML(row, [map.boss], reachSet);
  }
  rows += '<div class="runMapRow">' + runMapNodeHTML(map.boss, reachSet, 50) + '</div>';
  box.innerHTML = top +
    '<div class="runMapTitle">第 ' + (RUN.mapIdx + 1) + ' 张地图 · Boss：' + esc(bossInfo.name || '未知') + '</div>' +
    (bossInfo.blurb ? '<div class="runSub">' + esc(bossInfo.blurb) + '</div>' : '') +
    '<div class="runMapWrap">' + rows + '</div>';
  runShow('map');
}
/* 横向位置百分比：row 宽 w 时节点 c 居中于 (c+0.5)/w */
function runXPct(col, w){ return ((col + 0.5) / (w || 1)) * 100; }
/* 虚线连接段：上一行节点 → 下一行节点/Boss（可达路径高亮金色） */
function runEdgeRowHTML(parents, children, reachSet){
  const lines = [];
  parents.forEach(nd => {
    const x1 = runXPct(nd.col, parents.length);
    (nd.edges || []).forEach(tid => {
      const ch = children.find(c => c.id === tid);
      if(!ch) return;
      const x2 = runXPct(ch.col, children.length);
      lines.push('<line x1="' + x1 + '" y1="0" x2="' + x2 + '" y2="100" class="' + (reachSet[tid] ? 'hot' : '') + '" />');
    });
  });
  return '<div class="runMapEdge"><svg viewBox="0 0 100 100" preserveAspectRatio="none">' + lines.join('') + '</svg></div>';
}
function runMapNodeHTML(nd, reachSet, x){
  const cls = [];
  if(nd.done) cls.push('done');
  if(RUN.cur && RUN.cur.id === nd.id) cls.push('cur');
  else if(nd.done) cls.push('locked');
  else if(reachSet[nd.id]) cls.push('reachable');
  else cls.push('locked');
  if(nd.type === 'boss') cls.push('boss');
  if(nd.type === 'elite') cls.push('elite');
  const attr = (reachSet[nd.id] && !nd.done) ? ' data-act="runNode" data-id="' + nd.id + '"' : '';
  const tip = runNodeTitle(nd);
  return '<div class="runNode ' + cls.join(' ') + '"' + attr + ' style="left:' + x + '%" title="' + esc(tip) + '">' +
    '<div class="rnIcon">' + (nd.icon || RUN_NODE_ICONS[nd.type] || '❓') + '</div>' +
    '<div class="rnName">' + esc(nd.type === 'boss' ? (nd.name || 'Boss') : (RUN_NODE_ICONS[nd.type] ? RUN_NODE_META_NAMES[nd.type] : '') ) + '</div>' +
  '</div>';
}
const RUN_NODE_META_NAMES = { fight:'遭遇战', elite:'精英战', boss:'Boss', add:'增援', remove:'整编', upgrade:'兵工厂', sacrifice:'祭坛', fusion:'熔炉', choice:'抉择' };
function runNodeTitle(nd){
  if(nd.type === 'boss') return 'Boss · ' + (nd.name || '') + (nd.blurb ? ' —— ' + nd.blurb : '');
  if(nd.type === 'elite') return '精英战' + (nd.bonusText ? '（' + nd.bonusText + '）' : '');
  return (RUN_NODE_META_NAMES[nd.type] || nd.type) + (nd.type === 'fight' ? ' · 小怪无加成' : '');
}

/* ============================================================
   节点进入：事件面板 / 战斗
   ============================================================ */
function runNodeOpen(id){
  const res = runL(RUN_L.enter, 'runNodeEnter', [id]);
  if(!res){ toast('尚未到达此处'); return; }
  if(res.kind === 'battle'){
    runFightStart(res.node);
    return;
  }
  RUN_curNode = res.node;
  RUN_curView = res.view;
  RUN_sel = -1;
  renderRunModal(res.node, res.view);
}

/* ============================================================
   战斗集成：runFightStart(node) —— 配置对局 → startGame
   · 小怪：无加成；精英：敌方按国家加成（run.js 改敌方卡组）；
   · Boss：沿用 Boss 挑战（setBossKind + buildBossDeck + 双命/开局脚本/固定行动）
   ============================================================ */
function runFightStart(node){
  if(!RUN || !RUN.active) return;
  const f = runL(RUN_L.fight, 'runGetFight', [node]);
  if(!f){ toast('战斗配置失败'); return; }
  PENDING.level = null;
  PENDING.boss = false;
  PENDING.run = true;
  let pDeck = JSON.parse(JSON.stringify(RUN.deck || []));
  setDeckOverride({ p: pDeck, a: (f.deck && f.deck.length) ? f.deck : null });
  setGAME_RULES_OFF();                                // 小怪关 AI 无加成；征程之战不沿用任何战役加成
  GAME_RULES.hqHpBonus.p = (RUN.hqMax || 20) - 20;    // 征程自身：总部上限加成（目前恒 20，预留）
  if(f.bossKind) setBossKind(f.bossKind); else setBossKind(null);
  setAI_DIFFICULTY(f.difficulty || 'veteran');
  S.pNation = RUN.nation;
  S.aNation = f.nation || 'de';
  /* 卡背装配：己方=主国初始卡背；敌方=按难度装配（清除自由/Boss 对局残留的卡背） */
  if(typeof backDefaultId === 'function' && typeof aiBackId === 'function'){
    S.backOf = { p: backDefaultId(RUN.nation || 'us'), a: aiBackId(S.aNation, AI_DIFFICULTY) };
    if(typeof _backCache !== 'undefined' && _backCache){ _backCache.p = null; _backCache.a = null; }
  }
  /* 总部场景清回默认（本国经典），桌面即按总部对应桌布应用 */
  if(typeof S.hqOf !== 'undefined'){ S.hqOf = { p: null, a: null }; }
  if(typeof applyDesk === 'function') applyDesk(true);
  runOverlayHide();
  const ov = $('overlay'); if(ov) ov.classList.add('hidden');
  startGame();
  if(typeof bgmStart === 'function'){ bgmLockForMatch(null); bgmStart(); }   // 征程战斗：全库随机换一首（Boss 关与普通关一致，不再固定曲目 —— 用户 2026-09-17）
  S.p.hp = Math.min(RUN.hq || 20, S.p.maxHp);
  if(f.kind === 'elite' && f.nation === 'us'){        // 美军精英：开局 2 个指挥点槽（首回合槽+1 后为 2）
    S.a.kreditSlots = 1; S.a.kredit = 1;
    logMsg('美国精英：开局 2 个指挥点槽');
  }
  if(f.bonusText) logMsg('精英战场：' + f.bonusText);
  render();
  checkGameOver();
}

/* ============================================================
   对局结束接管：runBattleEnd(winner)
   ============================================================ */
function runBattleEnd(winner){
  // 对局结算延迟约 5 秒：让总部爆炸/死亡动画播完再出结算屏
  if(_runEndDelay){ _runEndDelay = false; runBattleEndFrame(winner); return; }
  _runEndDelay = true;
  setTimeout(()=>{ _runEndDelay = false; runBattleEndFrame(winner); }, 5200);
}
let _runEndDelay = false;
function runBattleEndFrame(winner){
  PENDING.run = false;
  PENDING.level = null;
  PENDING.boss = false;
  const rb = $('btnRematch'); if(rb) rb.style.display = 'none';
  if(winner === 'p'){
    const res = runL(RUN_L.battleWin, 'runBattleWin', [S.p.hp]) || {};
    if(res.victory){
      runEndShow('victory');
    } else if(res.nextMap){
      RUN.mapIdx = res.mapIdx;
      RUN.cur = null; RUN.curRow = -1;                // 新图重新选路
      runEndShow('map');
    } else {
      runEndShow('win');
    }
  } else {
    runEndShow('lose');
  }
  SAVE.stats.wins = S.wins; SAVE.stats.losses = S.losses;
  saveV2Save();
}
function runEndShow(kind){
  const box = $('runV-end'); if(!box) return;
  let html = '';
  if(kind === 'victory'){
    html =
      '<h1>🏆 全 部 击 破</h1>' +
      '<div class="runSub">三张地图的三位 Boss 尽数倒下——连最终 Boss「hana」也没能拦住你。</div>' +
      '<div class="runEndBox">战绩已记录</div>' +
      '<div class="runCenter"><button class="bigbtn" data-act="runEndExit">返 回 菜 单</button></div>';
    runL(RUN_L.reset, 'runReset', []);               // 通关结算完成，征程结束
  } else if(kind === 'map'){
    const bossInfo = runL(RUN_L.bossInfo, 'runBossInfo', []) || {};
    html =
      '<h1>⚔ Boss 已 破</h1>' +
      '<div class="runSub">一张地图的尽头被打通了。</div>' +
      '<div class="runEndBox">休整片刻。下一张地图：Boss <b>' + esc(bossInfo.name || '?') + '</b>（' + (RUN.mapIdx + 1) + '/3 图）<br>总部血量保留为 ❤ ' + RUN.hq + '/' + RUN.hqMax + '</div>' +
      '<div class="runCenter"><button class="bigbtn" data-act="runContinue">继 续 前 进</button></div>';
  } else if(kind === 'win'){
    html =
      '<h1>⚔ 战 斗 告 捷</h1>' +
      '<div class="runSub">敌阵溃散，路重新敞开。</div>' +
      '<div class="runEndBox">总部血量保留为 ❤ ' + RUN.hq + '/' + RUN.hqMax + ' · 卡组随行</div>' +
      '<div class="runCenter"><button class="bigbtn" data-act="runContinue">继 续 前 进</button></div>';
  } else {
    html =
      '<h1>🕯 战 败</h1>' +
      '<div class="runSub">火堆熄灭，队伍散尽。</div>' +
      '<div class="runEndBox">旅程到此为止。卡组与战绩，都随火堆一同熄灭。</div>' +
      '<div class="runCenter"><button class="bigbtn" data-act="runEndExit">返 回 菜 单</button></div>';
  }
  box.innerHTML = html;
  runShow('end');
}
function runContinue(){
  renderRunMap();
}
function runEndExit(){
  runL(RUN_L.reset, 'runReset', []);
  runExitToMenu();
}
function runBackMenu(){
  if(RUN && RUN.active && typeof confirm === 'function' && !confirm('离开开始游戏？本次旅程的进度将全部重置。')){
    return;
  }
  runL(RUN_L.reset, 'runReset', []);
  runExitToMenu();
}

/* ============================================================
   事件面板：runEventView(node) → {title,text,choices}
   · 普通 choice：直接按钮 → runChoice(node,id)
   · choice id 形如 card:N（N=卡组下标）：选卡网格 + 确认按钮
   · 熔炉（view.needCards）：点卡直选（run.js 维护 RUN._fuseSel），
     fuseReady 时出现「确认熔铸」→ runFuseConfirm()
   runChoice 返回 {text, close}：close=true 关面板、节点打勾、重绘地图；
   close=false 重取视图继续多步事件
   ============================================================ */
function renderRunModal(nd, view){
  const choices = (view && view.choices) || [];
  let body = '';
  if(view && view.needCards){
    const sel = view.fuseSel || [];
    // 只渲染 run.js 允许投入炉中的卡（view.cardIdx：有重复就只列重复卡，没重复就列单位卡）
    const allow = (view.cardIdx && view.cardIdx.length) ? view.cardIdx.filter(i => RUN.deck[i]) : (RUN.deck || []).map((c, i) => i).filter(i => RUN.deck[i]);
    const hasDup = /有重复/.test(String(view.text || ''));
    body =
      '<div class="pmHint">熔炉：点卡选中、**再点一次取消**（已选 ' + sel.length + '/2）</div>' +
      '<div class="runDeckGrid pmGrid">' +
        allow.map(i => runMiniCardHTML(RUN.deck[i], { sel: sel.indexOf(i) >= 0, act: 'runSelCard', i: i })).join('') +
      '</div>' +
      (sel.length >= 2
        ? '<div class="runCenter"><button class="bigbtn" data-act="runFuseConfirm">确 认 熔 铸</button></div>'
        : sel.length === 1
          ? '<div class="runCenter"><button class="bigbtn" data-act="runFuseConfirm">熔 炼 单 卡</button></div>'
          : '<div class="pmHint" style="margin-top:4px">' + (hasDup ? '选两张**相同**的卡（单位或指令）后确认熔铸。' : '挑一张单位卡单卡熔炼（+1/+1）。') + '</div>') +
      '<div class="runCenter" style="margin-top:6px"><span class="smBtn" data-act="runChoice" data-id="cancel" style="cursor:pointer">离 开</span></div>';
  } else if(choices.some(c => /^card:\d+$/.test(c.id))){
    body =
      '<div class="pmHint">请从卡组中点击选择 1 张卡（只读，点选高亮）</div>' +
      '<div class="runDeckGrid pmGrid">' +
        (RUN.deck || []).map((c, i) => runMiniCardHTML(c, { sel: i === RUN_sel, act: 'runSelCard', i })).join('') +
      '</div>' +
      '<div class="runCenter"><button class="bigbtn' + (RUN_sel >= 0 ? '' : ' runBtnOff') + '" data-act="runChoice" data-id="card:' + (RUN_sel >= 0 ? RUN_sel : 0) + '">确 认 选 择</button></div>' +
      (choices.some(c => c.id === 'cancel')
        ? '<div class="runCenter" style="margin-top:6px"><span class="smBtn" data-act="runChoice" data-id="cancel" style="cursor:pointer">取 消</span></div>'
        : '');
  } else {
    body = '<div class="pmChoices">' + choices.map(c =>
      '<button class="pmChoice" data-act="runChoice" data-id="' + esc(c.id) + '">' + esc(c.label || c.id) + '</button>'
    ).join('') + '</div>';
  }
  openRunModalPanel(
    '<div class="pmTitle">' + esc(view.title || '事件') + '</div>' +
    '<div class="pmText">' + esc(view.text || '') + '</div>' +
    body +
    '<div style="text-align:right;margin-top:8px"><span class="smBtn" data-act="runModalClose" style="cursor:pointer">✕ 暂离</span></div>'
  );
}
function runSelCard(i){
  const view = RUN_curView; if(!view) return;
  if(view.needCards){ runChoiceDo('card:' + i); return; }   // 熔炉：直选（run.js 管理）
  RUN_sel = (RUN_sel === i) ? -1 : i;
  renderRunModal(RUN_curNode, RUN_curView);
}
function runFuseConfirmDo(){
  if(!RUN_curNode) return;
  runChoiceRes(runL(RUN_L.confirmFuse, 'runFuseConfirm', []));  // run.js 熔铸并返回结果
}
function runChoiceDo(id){
  if(!RUN_curNode || id == null) return;
  const view = RUN_curView || {};
  if(/^card:\d+$/.test(String(id)) && !view.needCards){
    if(RUN_sel < 0){ toast('请先选择一张卡'); return; }
    id = 'card:' + RUN_sel;
  }
  runChoiceRes(runL(RUN_L.choice, 'runChoice', [RUN_curNode, id]));
}
/* run.js 返回值统一处理：{text, close} */
function runChoiceRes(res){
  if(!res) return;
  if(res.text) toast(res.text);
  if(res.close){
    const nd = RUN_curNode;
    RUN_curNode = null; RUN_curView = null; RUN_sel = -1;
    closeRunModal();
    if(nd) runL(RUN_L.done, 'runNodeDone', [nd.id]);    // 节点打勾 + 当前位置前移
    renderRunMap();
  } else {
    const view = runL(RUN_L.view, 'runEventView', [RUN_curNode]);  // 多步事件：重取视图
    if(view){ RUN_curView = view; RUN_sel = -1; renderRunModal(RUN_curNode, view); }
  }
}

function runDeckOpen(){
  const deck = RUN.deck || [];
  openRunModalPanel(
    '<h2 style="text-align:center;color:#f0d58a;letter-spacing:6px">我 的 卡 组</h2>' +
    '<div style="text-align:center;color:#a98d55;font-size:12px;letter-spacing:2px;margin-top:2px">共 ' + deck.length + ' 张 · 🃏 仅展示</div>' +
    '<div class="runDeckGrid">' + deck.map(c => runMiniCardHTML(c, {})).join('') + '</div>' +
    '<div class="runCenter"><button class="bigbtn" data-act="runModalClose">收 起</button></div>'
  );
}

/* ---------- 只读小卡面（征程各处共用） ---------- */
function runMiniCardHTML(c, opts){
  opts = opts || {};
  if(!c) return '';
  const isUnit = c.kind === 'unit';
  const cls = (isUnit ? '' : ' order') + (opts.sel ? ' sel' : '');
  const attrs = opts.act ? ' data-act="' + opts.act + '" data-i="' + opts.i + '"' : '';
  const name = esc(c.n || '?');
  const sig = isUnit ? (c.sig || []).map(s => SIGINFO[s] ? SIGINFO[s].n : s).join('·') : '';
  const stats = runCardStats(c);
  const effText = isUnit
    ? (c.fx || []).map(f => UNIT_FX_TEXT[f] || '').filter(Boolean).join('；') || (c.d ? (UNIT_DEPLOY_TEXT[c.d] || '') : '')
    : (c.desc || '');
  const eff = effText ? '<div class="rmEff">' + esc(effText) + '</div>' : '';
  return '<div class="runMiniCard' + cls + '"' + attrs + ' data-info="'+(c.nation||'us')+':'+(c.kind||'unit')+':'+(c.id||'')+'"' + '>' +
    '<div class="rmImg">' + artHTML(c, true) + '</div>' +
    '<div class="rmName" title="' + name + '">' + name + '</div>' +
    '<div class="rmStats">' + stats + '</div>' +
    (sig ? '<div class="rmSig">' + sig + '</div>' : '') + eff +
  '</div>';
}

/* ---------- 装配（浏览器环境；smoke 沙箱中 DOMContentLoaded 不触发，顶层保持安全） ---------- */
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function'){
  document.addEventListener('DOMContentLoaded', runInit);
}
