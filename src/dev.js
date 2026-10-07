/* ============================================================
   开发者模式桥（src/dev.js）—— 桌面「开发者模式\」目录里的外挂面板专用
   ------------------------------------------------------------
   通道：localStorage 轮询 + storage 事件 + BroadcastChannel（三保险，全是同源/无副作用）
     面板 → 游戏： localStorage['KADMIN_DEV_CMD'] = {id, cmd, args}
     游戏 → 面板： localStorage['KADMIN_DEV_ACK'] = {id, ok, msg, data}
     面板开过一次会把 KADMIN_DEV_ON 置 '1'；没置位时这边每个 tick 只做一次 getItem，几乎零成本。
   命令（cmd）：
     ping                       探活（面板用它判断 KADMIN 是否在线）
     list                       返回卡牌索引：正常卡池 / 衍生卡 / JM / 老兵形态（含 id/名称/种类/国家）
     state                      返回局面快照（双方 hp/指挥点/手牌/牌堆、回合、阶段、最近日志）
     addHand  {id, group}       指定卡加入玩家手牌（group: normal/derived/jm/veteran）
     addBoard {id, group, row}  指定卡直接加入战场（默认玩家支援战线，满了往前线）
     addDeck  {id, group}       指定卡置于玩家卡组顶（deck 末尾 = 抽牌位）
     flags    {infiniteKredit, hqImmuneSide}   开关类（无限指挥点 / 总部免疫）
     skipAi                     跳过 AI 的下一个回合
     win                        直接判玩家获胜（Boss 多命一并跳过）
     heal                       双方总部回满（顺手功能）
   注意：本文件在 build 里排在最后，与引擎同处一个 <script> 作用域，可直接调用引擎函数/读 S。
   任何异常都必须被吞掉——开发者通道绝不能影响正常游戏。
   ============================================================ */
(function(){
  if(typeof window === 'undefined' || typeof document === 'undefined') return;   // 无头（Node 测试）下不启用
  const KEY_ON = 'KADMIN_DEV_ON', KEY_CMD = 'KADMIN_DEV_CMD', KEY_ACK = 'KADMIN_DEV_ACK', CH = 'kadmin-dev';
  let lastId = 0, ch = null;
  try{ if(typeof BroadcastChannel === 'function') ch = new BroadcastChannel(CH); }catch(e){ ch = null; }

  function ack(id, ok, msg, data){
    const payload = { id: id, ok: !!ok, msg: msg || '', data: (data === undefined ? null : data), at: Date.now(), build: (typeof BUILD_ID !== 'undefined' ? BUILD_ID : '') };
    try{ localStorage.setItem(KEY_ACK, JSON.stringify(payload)); }catch(e){}
    try{ if(ch) ch.postMessage({ type:'ack', payload: payload }); }catch(e){}
  }

  /* ---------- 卡牌索引：正常卡池 + 衍生卡 + JM（Boss 专用 DIY 卡）+ 老兵形态 ---------- */
  // 衍生卡里有 6 张是**单位**（水牛/轻步兵/卫戍/军团/溃军/游击队员），它们的定义里没有 kind 字段
  // ——旧写法 `d.kind || 'order'` 会把它们当指令，面板的「加入战场」按钮就被禁掉了（用户 2026-09-17 报）
  function devKindOf(d){
    if(!d) return 'order';
    if(d.kind) return d.kind;
    if(d.t || (d.a != null && d.h != null)) return 'unit';   // 有兵种或攻血 = 单位
    return 'order';
  }
  function cardIndex(){
    const out = [];
    try{
      for(const key of Object.keys(NATIONS)){
        const n = NATIONS[key] || {};
        (n.units || []).forEach(u => out.push({ id:u.id, n:u.n, kind:'unit', group:'normal', nation:key, cost:(u.c||0), t:u.t, a:u.a, h:u.h }));
        (n.orders || []).forEach(o => out.push({ id:o.id, n:o.n, kind:'order', group:'normal', nation:key, cost:(o.c||0) }));
        (n.counters || []).forEach(o => out.push({ id:o.id, n:o.n, kind:'counter', group:'normal', nation:key, cost:(o.c||0) }));
      }
      const DER = (typeof DERIVED_CARDS !== 'undefined' && DERIVED_CARDS) ? DERIVED_CARDS : {};
      for(const id of Object.keys(DER)){
        const d = DER[id] || {};
        out.push({ id:id, n:(d.n || id), kind:devKindOf(d), group:'derived', nation:(d.nation || ''), cost:(d.c != null ? d.c : (d.blood || 0)), t:d.t, a:d.a, h:d.h });
      }
      const BOSS = (typeof BOSS_CARDS !== 'undefined' && BOSS_CARDS) ? BOSS_CARDS : {};
      for(const id of Object.keys(BOSS)){
        const d = BOSS[id] || {};
        out.push({ id:id, n:(d.n || id), kind:(d.kind || 'unit'), group:'jm', nation:(d.nation || ''), cost:(d.c || 0), t:d.t, a:d.a, h:d.h });
      }
      const VF = (typeof VETERAN_FORMS !== 'undefined' && VETERAN_FORMS) ? VETERAN_FORMS : {};
      for(const id of Object.keys(VF)){
        const d = VF[id] || {};
        out.push({ id:id, n:(d.n || id), kind:'unit', group:'veteran', nation:'', cost:(d.c || 0), t:d.t, a:d.a, h:d.h });
      }
    }catch(e){ /* 索引失败不影响命令处理 */ }
    return out;
  }

  /* ---------- 卡牌定义解析（group → 正确的构造器） ---------- */
  function defOf(id, group){
    if(!id) return null;
    if(group === 'jm'){
      const d = (typeof BOSS_CARDS !== 'undefined' && BOSS_CARDS) ? BOSS_CARDS[id] : null;
      return d ? mkUnitDef(d, d.nation || 'us') : null;
    }
    if(group === 'derived'){
      const d = makeDerived(id);
      if(d) return d;
      // makeDerived 不可用时的兜底：按形状判单位/指令（别再一律当指令 —— 见 devKindOf 注释）
      const raw = (typeof DERIVED_CARDS !== 'undefined' && DERIVED_CARDS && DERIVED_CARDS[id]) || null;
      if(!raw) return null;
      const nat = raw.nation || 'us';
      return (devKindOf(raw) === 'unit')
        ? mkUnitDef(Object.assign({}, raw, { nation:nat }), nat)
        : mkOrderDef(Object.assign({}, raw, { nation:nat }), nat);
    }
    if(group === 'veteran'){
      const d = (typeof VETERAN_FORMS !== 'undefined' && VETERAN_FORMS && VETERAN_FORMS[id]) || null;
      return d ? mkUnitDef(d, d.nation || 'us') : null;
    }
    // normal：国家表里找（unit/order/counter）
    for(const key of Object.keys(NATIONS)){
      const n = NATIONS[key] || {};
      const u = (n.units || []).find(x => x.id === id || x.n === id);
      if(u) return mkUnitDef(u, key);
      const o = (n.orders || []).find(x => x.id === id || x.n === id);
      if(o) return mkOrderDef(Object.assign({}, o, { nation:key }), key);
      const c = (n.counters || []).find(x => x.id === id || x.n === id);
      if(c) return mkCounterDef(c, key);
    }
    // 兜底：其它分组也试着找一遍（面板传错 group 也能用）
    for(const g of ['jm','derived','veteran']) if(g !== group){ const d = defOf(id, g); if(d) return d; }
    return null;
  }
  function firstFreeSlot(side, preferRow){
    const rows = [preferRow, backRowOf(side), 1].filter(r => r != null);
    for(const r of rows){ for(let c=0;c<COLS;c++) if(!S.board[r][c]) return { r:r, c:c }; }
    return null;
  }

  /* ---------- 局面快照（面板显示用） ---------- */
  function snapshot(){
    const brief = P => ({
      hp: P.hp, maxHp: P.maxHp, kredit: P.kredit, slots: P.kreditSlots,
      hand: (P.hand || []).map(c => c ? c.n : '?'), deck: (P.deck || []).length,
      counters: (P.counters || []).length
    });
    const board = [];
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      const u = S.board[r][c];
      if(u) board.push({ r:r, c:c, owner:u.owner, n:u.def.n, atk:u.atk, hp:u.hp, maxHp:u.maxHp });
    }
    return {
      turn: S.turn, phase: S.phase, over: !!S.over, winner: S.winner || null,
      bossKind: S.bossKind || null, bossLife: S.bossLife || 1,
      p: brief(S.p), a: brief(S.a), board: board,
      log: (S.log || []).slice(-8),
      dev: { infiniteKredit: !!DEV.infiniteKredit, hqImmuneSide: DEV.hqImmuneSide || null, skipAiTurns: DEV.skipAiTurns || 0 }
    };
  }

  /* ---------- 命令处理 ---------- */
  function handle(p){
    const cmd = p && p.cmd, args = (p && p.args) || {};
    if(cmd === 'ping'){
      ack(p.id, true, 'KADMIN 在线', { build: (typeof BUILD_ID !== 'undefined' ? BUILD_ID : ''), phase: S.phase, over: !!S.over, turn: S.turn });
      return;
    }
    if(cmd === 'list'){
      // 卡表单独放一个键：ACK 保持小体积（浏览器版面板每 300ms 轮询 ACK，塞 40KB 进去会白解析）
      const idx = cardIndex();
      try{ localStorage.setItem('KADMIN_DEV_CARDS', JSON.stringify({ cards: idx, at: Date.now() })); }catch(e){}
      ack(p.id, true, '卡牌索引 ' + idx.length + ' 张', { cards: idx.length, key: 'KADMIN_DEV_CARDS' });
      return;
    }
    if(cmd === 'state'){ ack(p.id, true, '局面快照', snapshot()); return; }
    if(cmd === 'addHand'){
      const def = defOf(args.id, args.group);
      if(!def){ ack(p.id, false, '找不到卡：' + args.id); return; }
      S.p.hand.push(def);
      logMsg('【开发者】将「' + def.n + '」加入手牌。');
      render();
      ack(p.id, true, '「' + def.n + '」已加入手牌（手牌 ' + S.p.hand.length + ' 张）');
      return;
    }
    if(cmd === 'addBoard'){
      const def = defOf(args.id, args.group);
      if(!def){ ack(p.id, false, '找不到卡：' + args.id); return; }
      if(def.kind !== 'unit'){ ack(p.id, false, '「' + def.n + '」不是单位卡，无法加入战场（可加入手牌/卡组顶）'); return; }
      const slot = firstFreeSlot('p', args.row != null ? args.row : backRowOf('p'));
      if(!slot){ ack(p.id, false, '战场已满，放不下'); return; }
      const ok = spawnUnit('p', def, slot.r, slot.c);
      render();
      ack(p.id, !!ok, ok ? ('「' + def.n + '」已加入战场（' + (slot.r === backRowOf('p') ? '支援战线' : '前线') + ' ' + slot.c + ' 列）') : '入场失败');
      return;
    }
    if(cmd === 'addDeck'){
      const def = defOf(args.id, args.group);
      if(!def){ ack(p.id, false, '找不到卡：' + args.id); return; }
      S.p.deck.push(def);   // 卡组顶 = deck 末尾（drawCards 从末尾抽）
      logMsg('【开发者】将「' + def.n + '」置于卡组顶。');
      render();
      ack(p.id, true, '「' + def.n + '」已置于卡组顶（牌堆 ' + S.p.deck.length + ' 张）');
      return;
    }
    if(cmd === 'flags'){
      if(args.infiniteKredit !== undefined) DEV.infiniteKredit = !!args.infiniteKredit;
      if(args.hqImmuneSide !== undefined) DEV.hqImmuneSide = args.hqImmuneSide || null;
      DEV.enabled = true;
      if(DEV.infiniteKredit){ S.p.kreditSlots = Math.max(S.p.kreditSlots || 0, 99); S.p.kredit = 99; }
      render();
      ack(p.id, true, '开关已更新：无限指挥点 ' + (DEV.infiniteKredit ? '开' : '关') + '、总部免疫 ' + (DEV.hqImmuneSide === 'p' ? '我方' : DEV.hqImmuneSide === 'a' ? '敌方' : '关'));
      return;
    }
    if(cmd === 'skipAi'){
      DEV.skipAiTurns = 1;
      ack(p.id, true, '已排队：跳过 AI 的下一个回合（结束你这一回合后生效）');
      return;
    }
    if(cmd === 'win'){
      try{
        if(S.bossMode && S.bossKind) S.bossLife = bossLives(S.bossKind);   // 越过 Boss 剩余命数
        S.a.hp = 0;
        endGame('p');
        ack(p.id, true, '已判玩家获胜');
      }catch(e){ ack(p.id, false, '胜利指令异常：' + e.message); }
      return;
    }
    if(cmd === 'heal'){
      S.p.hp = S.p.maxHp; S.a.hp = S.a.maxHp;
      logMsg('【开发者】双方总部回满。');
      render();
      ack(p.id, true, '双方总部已回满');
      return;
    }
    ack(p.id, false, '未知指令：' + cmd);
  }

  /* ---------- 主循环（轮询 + 事件 + BroadcastChannel） ---------- */
  // 作弊开关的持续生效部分（每一帧都顶一次；本地面板不开 localStorage 门闸，所以这段必须放在门闸之前）
  function applyDevPerks(){
    if(!DEV.infiniteKredit || S.over) return;
    if((S.p.kreditSlots || 0) < 99) S.p.kreditSlots = 99;
    if(S.p.kredit < 99){ S.p.kredit = 99; render(); }
  }
  function tick(){
    try{
      applyDevPerks();
      if(localStorage.getItem(KEY_ON) !== '1') return;
      const raw = localStorage.getItem(KEY_CMD);
      if(!raw) return;
      const p = JSON.parse(raw);
      if(!p || typeof p.id !== 'number' || p.id <= lastId) return;
      lastId = p.id;
      handle(p);
    }catch(e){ /* 开发者通道异常一律吞掉 */ }
  }
  try{ window.addEventListener('storage', e => { if(e && (e.key === KEY_CMD || e.key === KEY_ON)) tick(); }); }catch(e){}
  try{ if(ch) ch.onmessage = ev => { const d = ev && ev.data; if(d && d.type === 'cmd' && d.payload) { try{ if(d.payload.id > lastId){ lastId = d.payload.id; handle(d.payload); } }catch(e){} } }; }catch(e){}
  // 定时器可能不存在（某些测试沙箱）：有就挂，没有就只跑一次 tick
  if(typeof setInterval === 'function') setInterval(tick, 350);
  tick();

  /* ============================================================
     第二通道：本地窗口版面板（开发者模式\KADMIN 开发者面板.ps1，原生 WinForms 小窗口）
     它在 127.0.0.1:PORT 上跑一个最小 HTTP 服务，这里用 fetch 轮询取命令、回传结果/局面/卡表。
     没开面板时 fetch 会失败——被吞掉即可，正常游戏零影响。
     ============================================================ */
  const HTTP_BASE = 'http://127.0.0.1:7788';
  let httpSince = 0, httpOk = false, indexPushed = false, stateTick = 0, lastStateJson = '';
  function post(path, payload){
    if(typeof fetch !== 'function') return null;
    try{
      return fetch(HTTP_BASE + path, { method:'POST', mode:'no-cors', headers:{ 'Content-Type':'text/plain' }, body: JSON.stringify(payload) }).catch(() => {});
    }catch(e){ return null; }
  }
  function postRaw(path, jsonBody){
    if(typeof fetch !== 'function') return null;
    try{
      return fetch(HTTP_BASE + path, { method:'POST', mode:'no-cors', headers:{ 'Content-Type':'text/plain' }, body: jsonBody }).catch(() => {});
    }catch(e){ return null; }
  }
  function pushIndex(){
    post('/index', { cards: cardIndex() });
    indexPushed = true;
  }
  function pushState(){
    // 局面没变就不发（静态局面下几乎零流量；面板那边也不会被无意义地重画）
    // 注意：这里 body 已经是序列化好的 JSON 串，必须走 postRaw —— 用 post 会再包一层引号（踩过）
    let json = '';
    try{ json = JSON.stringify(snapshot()); }catch(e){ return; }
    if(json === lastStateJson) return;
    lastStateJson = json;
    postRaw('/state', json);
  }
  async function httpTick(){
    if(typeof fetch !== 'function') return;
    try{
      const r = await fetch(HTTP_BASE + '/poll?since=' + httpSince, { cache:'no-store' });
      const j = await r.json();
      const wasOk = httpOk;
      httpOk = true;
      httpFails = 0;
      DEV.enabled = true;
      applyDevPerks();
      if(!wasOk) log('【开发者】本地面板已连接（' + HTTP_BASE + '）');
      if(j && j.needIndex && !indexPushed) pushIndex();
      if(j && Array.isArray(j.commands)){
        for(const c of j.commands){
          if(!c || typeof c.id !== 'number' || c.id <= httpSince) continue;
          httpSince = c.id;
          const ackBackup = { id: c.id };
          try{ handle(c, ackBackup); }catch(e){ /* 单条命令出错不影响后续 */ }
        }
      }
      if((stateTick++ % 3) === 0) pushState();     // 局面约每 1.5 秒回传一次（内容没变则跳过）
    }catch(e){ httpOk = false; }
  }
  // handle 的回包：本地面板走 HTTP，HTML 面板走 localStorage —— 两边都发一份，谁在听谁收
  const origAck = ack;
  ack = function(id, ok, msg, data){
    origAck(id, ok, msg, data);
    post('/ack', { id: id, ok: !!ok, msg: msg || '' });
  };
  let httpFails = 0, httpTimer = null;
  function scheduleHttp(){
    if(typeof fetch !== 'function' || typeof setTimeout !== 'function') return;   // 无 fetch 的沙箱直接跳过本通道
    if(httpTimer) clearTimeout(httpTimer);
    const delay = (httpFails > 3) ? 4000 : 500;    // 面板没开时退避到 4 秒一次，避免刷控制台
    httpTimer = setTimeout(async () => { await httpTick(); scheduleHttp(); }, delay);
  }
  scheduleHttp();
  function log(msg){ try{ console.log(msg); }catch(e){} }
})();
