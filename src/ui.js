/* ============================================================
   铭刻前线 —— 渲染与输入层（src/ui.js，DOM 专属）
   启动时通过 installHooks() 向引擎注入真实实现：
     HOOKS.onRender ← uiRender；HOOKS.onSfx ← uiSfx；
     HOOKS.toast ← uiToast；HOOKS.onGameEnd ← uiGameEnd；
     HOOKS.wait ← waitMs（setTimeout 版），恢复旧版节奏。
   引擎侧的 render()/sfx()/toast()/logMsg() 为统一转发点，
   UI 内部同样直接调用它们（避免重名覆盖）。
   ============================================================ */

const $ = id => document.getElementById(id);
/* 图片 URL：空路径安全（盟国没有总部图/自定义卡无图时不能抛异常，否则整个视图渲染中断） */
const imgUrl = rel => rel ? encodeURI(String(rel).replace(/\\/g,'/')) : '';

/* ---------- 音效（HOOKS.onSfx 实现）：真实音频（音乐/音效/**）优先，合成音兜底 ---------- */
let AC = null;
let _lastRealSfx = 0;   // 最近一次真实音频播放时刻：合成兜底据此让位（避免两种音叠在一起）
function uiSfx(kind){
  const soundOn = (typeof mkSettings === 'function') ? !!mkSettings().sound : true;
  if(!soundOn) return;
  switch(kind){
    case 'vet': if(sfxPlay(SFX.vet, { volume:.55 })) return; break;   // 升老兵：真实音效
    case 'win': if(playSettleSfx('p')) return; break;                 // 结算：玩家所属国·胜利
    case 'lose': if(playSettleSfx('a')) return; break;                // 结算：玩家所属国·失败
    // 研发抉择：**按下选项**时触发（引擎 resolveChoice 发钩子）。3 费根研发=1 阶段；6/9 费扩展/高级=23 阶段
    // （点开/打出研发卡本身走 orderAudio → 研发.mp3，见 ORDER_AUDIO 名字兜底）
    case 'research1': if(sfxPlay(SFX.ordResearch1, { volume:.6 })) return; break;
    case 'research23': if(sfxPlay(SFX.ordResearch23, { volume:.6 })) return; break;
  }
  if(!AC) return;
  const t = AC.currentTime;
  const blip = (f,d,ty,v)=>{ const o=AC.createOscillator(), g=AC.createGain(); o.type=ty; o.frequency.value=f; g.gain.setValueAtTime(v,t); g.gain.exponentialRampToValueAtTime(.0001,t+d); o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t+d+.02); };
  const noise = (d,v)=>{ const b=AC.createBuffer(1, AC.sampleRate*d, AC.sampleRate); const ch=b.getChannelData(0); for(let i=0;i<ch.length;i++) ch[i]=Math.random()*2-1; const s=AC.createBufferSource(), g=AC.createGain(); s.buffer=b; g.gain.setValueAtTime(v,t); g.gain.exponentialRampToValueAtTime(.0001,t+d); s.connect(g); g.connect(AC.destination); s.start(t); };
  switch(kind){
    case 'card': blip(520,.08,'triangle',.18); blip(780,.07,'triangle',.1); break;
    // 部署/推进：真实音效（单位部署音/占领前线音）优先；130ms 内没有真实音效才用合成兜底
    case 'place': setTimeout(()=>{ if(Date.now() - _lastRealSfx < 200) return; try{ if(AC) blip(300,.12,'square',.14); }catch(e){} }, 130); break;
    case 'draw': blip(660,.07,'triangle',.12); break;
    case 'hit': noise(.15,.2); blip(150,.1,'sawtooth',.16); break;
    case 'kill': blip(90,.25,'sawtooth',.22); noise(.1,.18); break;
    case 'sac': blip(70,.3,'sine',.28); break;
    // 指令：真实卡牌音效优先（uiShowOrderAnim 已尝试播放）
    case 'order': if(Date.now() - _lastRealSfx > 900){ blip(440,.1,'triangle',.15); blip(660,.12,'triangle',.12); } break;
    // 结算音效文件不可用时（无 Audio/未内嵌）退回合成小段
    case 'win': [392,523,659,784].forEach(f=>blip(f,.18,'triangle',.2)); break;
    case 'lose': [220,174,146,110].forEach(f=>blip(f,.25,'sawtooth',.16)); break;
  }
}

/* ============================================================
   真实音效库（音乐/音效/**，由 build.mjs 以 AUDIO_MAP 内嵌为 data URI）
   命名规则 → 播放时机（文件的「K」= 卡牌费用；多卡共用一个文件按「、/，」分组）：
     · 部署 unitDeployAudio：**一律按费用档**（步兵 0~2K/3~5K/6~12K；坦克 1K轻型/2K轻型/3~5中型/
       6~10大型/11~12巨型；战斗机 1~2K/3~12K；轰炸机 1~2K / 3~4K与5~12K 再分「美，日，苏」「英，德」；
       炮兵一般部署）。仅「特殊音频校对.txt」写明的单位例外：第59装甲掷弹兵团→装甲车音频、
       Me 163彗星→喷气机-1；喀秋莎/STZ-5喀秋莎→喀秋莎部署（文件与单位同名）
     · 移动 unitMoveAudio：「单位的部署音效又是移动音效」——步兵用「步兵占领前线」专项，
       其余兵种（含带专项部署音的第59装甲掷弹兵团=装甲车音）直接复用其部署音
     · 攻击 unitAttackAudio：同样按费用档（坦克 1K轻型 / 2K轻型，中型 / 大，巨型；战斗机 1~2K / 3~12；
       轰炸机 1~4K / 5~12K；炮兵单管炮）。喀秋莎=前半段→后半段（校对：触发 2 点伤害时后半段放两遍）；
       战斗机攻击音播完后，按该单位造成的伤害「每 1 点伤害 1 发战斗机射击」（上限 30 发；新版
       战斗机射击.mp3 时长 1.46s，相邻两发重叠 150ms → 步长 ≈1.31s，见 sfxShots/SHOT_OVERLAP_MS）
     · 指令 orderAudio：同名牌优先（id 精确匹配），其次苏联按费用档、日本/英国「其他牌」兜底、
       攻防贴膜类指令用「涉及攻击力和防御力的贴膜」
     · 升老兵 vet；结算 settle（玩家所属国 + 胜利/失败）
   未启用的专项文件（本作没有校对指定或对应的卡，不做卡名猜测）：
     摩托部署 / 轻骑兵部署 / 重骑兵部署 / 机枪坦克攻击 / 喷火坦克攻击 / 连射炮攻击 /
     喷气机-2（菊花、原神机）/ 电报（教程·战役已移除）
   ============================================================ */
const SFX_ROOT = '音乐/音效/';
const SFX = {
  // 步兵
  inf02:'音乐/音效/步兵/0~2K步兵部署.mp3', inf35:'音乐/音效/步兵/3~5K步兵部署.mp3', inf612:'音乐/音效/步兵/6~12K步兵部署.mp3',
  infFront:'音乐/音效/步兵/步兵占领前线.mp3',
  apc:'音乐/音效/步兵/装甲车部署.mp3',                                    // 仅校对指定的 第59装甲掷弹兵团
  moto:'音乐/音效/步兵/摩托部署.mp3', cavLight:'音乐/音效/步兵/轻骑兵部署.mp3', cavHeavy:'音乐/音效/步兵/重骑兵部署.mp3', // 未启用（无校对指定）
  // 坦克
  tankD1:'音乐/音效/坦克/1K轻型坦克部署.mp3', tankD2:'音乐/音效/坦克/2K轻型坦克部署.mp3',
  tankD35:'音乐/音效/坦克/3~5中型坦克部署.mp3', tankD610:'音乐/音效/坦克/6~10K大型坦克部署.mp3', tankD1112:'音乐/音效/坦克/11~12K巨型坦克部署.mp3',
  tankA1:'音乐/音效/坦克/1K轻型坦克攻击.mp3', tankA2:'音乐/音效/坦克/2K轻型，中型坦克攻击.mp3',
  tankABig:'音乐/音效/坦克/大，巨型坦克攻击.mp3',
  tankAMg:'音乐/音效/坦克/机枪坦克攻击.mp3', tankAFlame:'音乐/音效/坦克/喷火坦克攻击.mp3', // 未启用（无校对指定）
  // 战斗机
  ftrD12:'音乐/音效/战斗机/1~2K部署.mp3', ftrD312:'音乐/音效/战斗机/3~12K部署.mp3',
  ftrA12:'音乐/音效/战斗机/1~2K攻击.mp3', ftrA312:'音乐/音效/战斗机/3~12攻击.mp3',
  jet1:'音乐/音效/战斗机/喷气机-1（彗星、金飞燕）.mp3',                    // 仅校对指定的 Me 163彗星
  jet2:'音乐/音效/战斗机/喷气机-2（菊花、原神机）.mp3',                    // 未启用（本作无对应卡）
  ftrShot:'音乐/音效/战斗机/战斗机射击.mp3',                              // 战斗机攻击音结束后按伤害连放的射击音
  // 轰炸机
  bmbD12:'音乐/音效/轰炸机/1~2K部署.mp3',
  bmbD34Axis:'音乐/音效/轰炸机/3~4K美，日，苏部署.mp3', bmbD512Axis:'音乐/音效/轰炸机/5~12K美，日，苏部署.mp3',
  bmbD34Allied:'音乐/音效/轰炸机/3~4K英，德部署.mp3', bmbD512Allied:'音乐/音效/轰炸机/5~12K英，德部署.mp3',
  bmbA14:'音乐/音效/轰炸机/1~4K攻击.mp3', bmbA512:'音乐/音效/轰炸机/5~12K攻击.mp3',
  // 炮兵
  artyD:'音乐/音效/炮兵/一般部署.mp3', katyD:'音乐/音效/炮兵/喀秋莎部署.mp3',
  artyA:'音乐/音效/炮兵/单管炮攻击.mp3', artyARepeat:'音乐/音效/炮兵/连射炮攻击.mp3',  // 连射炮攻击音未启用（无校对指定）
  katyA:'音乐/音效/炮兵/喀秋莎攻击前半段.mp3', katyB:'音乐/音效/炮兵/喀秋莎攻击后半段.mp3',
  // 指令（同名牌）
  ordEmpire:'音乐/音效/指令/帝国之力.mp3',
  ordWinter:'音乐/音效/指令/冬季攻势，冬季战争，严冬.mp3',
  ordHammer:'音乐/音效/指令/动乱、铁锤.mp3',
  ordEnigma:'音乐/音效/指令/恩尼格码.mp3',
  ordBomraid:'音乐/音效/指令/轰炸突袭.mp3',
  ordConvoy:'音乐/音效/指令/护航队、海军支援.mp3',
  ordMonty:'音乐/音效/指令/蒙哥马利.mp3',
  ordGunboat:'音乐/音效/指令/炮艇任务.mp3',
  ordJpOther:'音乐/音效/指令/日本其他牌.mp3',
  ordBuff:'音乐/音效/指令/涉及攻击力和防御力的贴膜.mp3',
  ordDfa:'音乐/音效/指令/死神降临.mp3',
  ordSu1:'音乐/音效/指令/苏联1K指令-啊~~~~~~.mp3',
  ordSu23:'音乐/音效/指令/苏联2~3K指令-拉伸！.mp3',
  ordSu4:'音乐/音效/指令/苏联4K以上指令-拉——伸！.mp3',
  ordLastresort:'音乐/音效/指令/亡命之计.mp3',
  ordBuzz:'音乐/音效/指令/嗡嗡炸弹、V-3飞行炸弹.mp3',   // 磁盘真实文件名（用户改名加了 V-3；原名「嗡嗡炸弹、飞行炸弹.mp3」不存在 → 曾是静音）
  ordBlitz:'音乐/音效/指令/一触即溃、闪电战.mp3',
  ordGbOther:'音乐/音效/指令/英国其他牌.mp3',
  ordEagle:'音乐/音效/指令/鹰爪.mp3',
  ordStratbomb:'音乐/音效/指令/战略轰炸.mp3',
  ordFocus:'音乐/音效/指令/战略重心.mp3',
  ordKredit:'音乐/音效/指令/战争机器，战争需要，战争债卷，反潜巡逻.mp3',
  // 新卡（id = 中文卡名）同名牌音频 —— 与 音乐/音效/指令/ 下的文件一一对应
  ordSubmarine:'音乐/音效/指令/U型潜艇.mp3',
  ordMelee:'音乐/音效/指令/大混战.mp3',
  ordManhattan:'音乐/音效/指令/曼哈顿、铀工程.mp3',
  ordCommando:'音乐/音效/指令/突击队突击.mp3',
  ordResearch:'音乐/音效/指令/研发.mp3',            // 点开/打出研发卡（触发抉择）时
  ordResearch1:'音乐/音效/指令/研发1阶段.mp3',       // 按下 3 费根研发的抉择选项时
  ordResearch23:'音乐/音效/指令/研发23阶段.mp3',     // 按下 6/9 费扩展/高级研发的抉择选项时
  ordSeize:'音乐/音效/指令/收缴单位.mp3',           // 收缴（seize）结算：见 HOOKS.onLog 里的日志名兜底
  ordNaval:'音乐/音效/指令/海军交战.mp3',           // 意 9 费「海军交战」（盟国卡，此前漏接线）
  // 全局通用 / 结算
  vet:'音乐/音效/全局通用音效/升老兵.mp3',
  telegraph:'音乐/音效/全局通用音效/教程、战役音效-电报.mp3'
};
const SETTLE_NATION = { us:'美国', de:'德国', jp:'日本', su:'苏联', gb:'英国' };
/* 指令 id → 同名牌音频；贴膜类（+攻/+防）单独一张；未列出的按国家/费用兜底 */
const ORDER_AUDIO = {
  empireforce: SFX.ordEmpire,
  winterwar: SFX.ordWinter, winteroff: SFX.ordWinter,
  hammer: SFX.ordHammer,
  enigma: SFX.ordEnigma,
  bomraid: SFX.ordBomraid,
  convoy: SFX.ordConvoy, navalsupport: SFX.ordConvoy,
  monty: SFX.ordMonty,
  gunboat: SFX.ordGunboat,
  deathfromabove: SFX.ordDfa,
  lastresort: SFX.ordLastresort,
  buzzbomb: SFX.ordBuzz,
  blitzkrieg: SFX.ordBlitz,
  eagleclaw: SFX.ordEagle,
  stratbomb: SFX.ordStratbomb,
  focus: SFX.ordFocus,
  warmachine: SFX.ordKredit, warneed: SFX.ordKredit, warbond: SFX.ordKredit, aswpatrol: SFX.ordKredit,
  // 涉及攻击力和防御力的「贴膜」指令
  forfreedom: SFX.ordBuff, motivate: SFX.ordBuff, quinine: SFX.ordBuff, tea: SFX.ordBuff,
  coopop: SFX.ordBuff, wedge: SFX.ordBuff, frontalassault: SFX.ordBuff,
  // 新卡（这些指令的 id 就是中文卡名；老映射是拉丁 id，故新卡曾整批静音）
  'XXⅪ级U型潜艇': SFX.ordSubmarine,
  '大混战': SFX.ordMelee,
  '曼哈顿计划': SFX.ordManhattan, '铀工程': SFX.ordManhattan,   // 两卡共用一个文件
  '突击队突击': SFX.ordCommando,
  // 同名牌补接线（自查发现：磁盘有同名文件却漏登记 → 打出来静音）
  massrout: SFX.ordBlitz,        // 一触即溃（德 8 费）：与「一触即溃、闪电战.mp3」同名
  navalbattle: SFX.ordNaval,     // 海军交战（意 9 费，盟国卡）
  // 研发链（3/6/9 费含 31 张衍生）不逐条登记：orderAudio 用 /研发/ 名字兜底一次覆盖
};
const JET_AUDIO = { me163: SFX.jet1 };  // 校对：Me 163彗星 → 喷气机-1（喷气机-2「菊花、原神机」本作无对应卡，未启用）

/* 首个用户手势里解锁音频：创建/恢复 AudioContext（移动端 Safari/Chrome 只允许手势内起播，
   解锁后 WebAudio 才能在任何时机出声——例如 AI 回合）；顺带预热常用音效的解码缓存 */
function sfxUnlock(){
  try{
    if(!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
    if(AC && AC.state === 'suspended' && typeof AC.resume === 'function') AC.resume();
  }catch(e){ /* 无 WebAudio 时只走 HTMLAudio */ }
  if(!_sfxWarmed){ _sfxWarmed = true; SFX_WARM.forEach(sfxDecode); }
}
let _sfxWarmed = false;
/* 预热清单：玩家/敌人最常用、且短小的几条（首次播放即可走 WebAudio，不受手势限制） */
const SFX_WARM = ['音乐/音效/步兵/步兵占领前线.mp3', '音乐/音效/步兵/0~2K步兵部署.mp3',
  '音乐/音效/步兵/3~5K步兵部署.mp3', '音乐/音效/坦克/1K轻型坦克攻击.mp3',
  '音乐/音效/坦克/3~5中型坦克部署.mp3', '音乐/音效/战斗机/战斗机射击.mp3'];

/* 回合开始预热：把本回合「双方场上单位 + 双方手牌」可能用到的部署/移动/攻击音提前解码。
   这样 AI 回合的部署/移动音在需要时已经走 WebAudio——手机上（非手势时机）也放得出声。 */
let _sfxWarmSig = '';
function sfxWarmForTurn(){
  try{
    // 每个「回合+阶段」只扫一次（渲染很频繁，避免每次都重建清单）
    const sig = (S.turn | 0) + ':' + S.phase + ':' + (S.bossRevived ? 1 : 0);
    if(sig === _sfxWarmSig) return;
    _sfxWarmSig = sig;
    const rels = new Set();
    const add = r => { if(r) rels.add(r); };
    const scan = def => {
      if(!def) return;
      add(unitDeployAudio(def));
      if(def.t === 'infantry' || def.t === 'tank' || def.t === 'fighter' || def.t === 'bomber' || def.t === 'artillery') add(unitMoveAudio(def));
      const a = unitAttackAudio(def); if(a){ add(a.file); if(a.tail) add(a.tail); }
      add(infantryAttackAudio(def));
    };
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const u = S.board[r][c]; if(u && u.def) scan(u.def); }
    [S.p, S.a].forEach(pl => { if(pl && pl.hand) pl.hand.forEach(cd => { if(cd && cd.kind === 'unit') scan(cd); }); });
    add(SFX.ftrShot); add(SFX.infFront);
    rels.forEach(sfxDecode);
  }catch(e){ /* 预热失败不影响播放 */ }
}

/* 音频元素缓存与播放：同一文件复用解码结果，重叠播放用 cloneNode */
const _sfxCache = Object.create(null);
const _sfxActive = [];
/* WebAudio 通道：移动端（iOS 等）只允许「用户手势内」播放 HTMLAudio，AI 回合的音效会被静音；
   上下文一旦在首个手势里解锁，WebAudio 在任何时机都能出声。这里懒解码 + 缓存 AudioBuffer，
   未解码的文件先用 HTMLAudio 顶上并同时预热解码（下次即走 WebAudio）。 */
const _sfxBuf = Object.create(null);   // rel -> AudioBuffer | 'pending' | 'fail'
function sfxDecode(rel){
  if(!AC || typeof fetch !== 'function' || typeof AC.decodeAudioData !== 'function') return;
  if(_sfxBuf[rel] !== undefined) return;
  _sfxBuf[rel] = 'pending';
  try{
    const src = (typeof audioUrl === 'function') ? audioUrl(rel) : encodeURI(rel);
    fetch(src).then(r => r.arrayBuffer()).then(buf => {
      const p = AC.decodeAudioData(buf, b => { _sfxBuf[rel] = b; }, () => { _sfxBuf[rel] = 'fail'; });
      if(p && p.then) p.then(b => { _sfxBuf[rel] = b; }).catch(() => { _sfxBuf[rel] = 'fail'; });
    }).catch(() => { _sfxBuf[rel] = 'fail'; });
  }catch(e){ _sfxBuf[rel] = 'fail'; }
}
function sfxWeb(rel, opt){
  const b = _sfxBuf[rel];
  if(!b || b === 'pending' || b === 'fail' || !AC) return null;
  try{
    if(AC.state === 'suspended' && typeof AC.resume === 'function') AC.resume();
    if(AC.state === 'suspended') return null;
    const s = AC.createBufferSource(); s.buffer = b;
    const g = AC.createGain(); g.gain.value = Math.max(0, Math.min(1, (opt && opt.volume != null) ? opt.volume : .5));
    s.connect(g); g.connect(AC.destination); s.start(0);
    _lastRealSfx = Date.now();
    bgmDuck(); // 音效期间压低背景音乐（保证听清）
    // 与 HTMLAudio 同形的接口：sfxChain / sfxShots 靠 'ended' 串下一段
    return { _web:true, addEventListener(ev, fn){ if(ev === 'ended') s.onended = fn; } };
  }catch(e){ return null; }
}
/* 音效调试：用 ...html#sfxdebug 打开时，右上角显示最近 6 条播放/拦截记录（排查「某侧没声音」用） */
const SFX_DEBUG = (typeof location !== 'undefined' && String(location.hash || '').indexOf('sfxdebug') > -1);
let _sfxDebugEl = null, _sfxDebugLog = [];
function sfxDebug(text){
  if(!SFX_DEBUG || typeof document === 'undefined' || !document.createElement) return;
  try{
    const line = (typeof Date !== 'undefined' ? new Date().toLocaleTimeString().slice(0, 8) + ' ' : '') + text;
    _sfxDebugLog.unshift(line);
    if(_sfxDebugLog.length > 6) _sfxDebugLog.length = 6;
    if(!_sfxDebugEl){
      _sfxDebugEl = document.createElement('div');
      _sfxDebugEl.id = 'sfxDebug';
      _sfxDebugEl.style.cssText = 'position:fixed;right:6px;top:6px;z-index:99;max-width:48vw;font:11px/1.4 monospace;color:#ffe9b0;background:rgba(0,0,0,.66);border:1px solid #6a4a20;border-radius:6px;padding:4px 6px;pointer-events:none;white-space:pre-wrap;';
      (document.body || document.documentElement).appendChild(_sfxDebugEl);
    }
    _sfxDebugEl.textContent = '音效调试（#sfxdebug）' + (typeof BUILD_ID !== 'undefined' ? ' build=' + BUILD_ID : '') + '\n' + _sfxDebugLog.join('\n');
  }catch(e){ /* 调试层失败不影响播放 */ }
}
function sfxPlayEl(rel, opt){
  if(!rel) return null;
  const soundOn = (typeof mkSettings === 'function') ? !!mkSettings().sound : true;
  if(!soundOn) return null;
  const vol = sfxVol();
  if(vol <= 0) return null;                                   // 音效音量拉到 0：直接不播
  const key = String(rel).replace(/\\/g,'/');
  if(vol !== 1) opt = Object.assign({}, opt, { volume: ((opt && opt.volume != null) ? opt.volume : .5) * vol });  // 最终音量 × 音效音量
  // 已解码 → WebAudio（移动端也能在非手势时机出声）；未解码 → 预热并走 HTMLAudio 兜底
  const web = sfxWeb(key, opt);
  if(web){ sfxDebug('♪ ' + key.replace('音乐/音效/','')); return web; }
  sfxDecode(key);
  if(typeof Audio === 'undefined') return null;
  const src = (typeof audioUrl === 'function') ? audioUrl(key) : encodeURI(key);
  try{
    let base = _sfxCache[key];
    if(!base){ base = new Audio(src); _sfxCache[key] = base; }
    const a = (typeof base.cloneNode === 'function') ? base.cloneNode(true) : new Audio(src);
    if(!a || typeof a.play !== 'function') return null;
    a.volume = Math.max(0, Math.min(1, (opt && opt.volume != null) ? opt.volume : .5));
    if(opt && opt.rate) a.playbackRate = opt.rate;
    _sfxActive.push(a);
    if(_sfxActive.length > 12) _sfxActive.shift();
    a.addEventListener('ended', ()=>{ const i = _sfxActive.indexOf(a); if(i > -1) _sfxActive.splice(i,1); });
    const p = a.play();
    sfxDebug('▶ ' + key.replace('音乐/音效/','') + ' v' + a.volume.toFixed(2));
    bgmDuck(); // 音效期间压低背景音乐（保证听清）
    if(p && p.catch) p.catch(()=>{
      // 被自动播放策略拦下（典型：手机/AI 回合不在手势内）→ 解码转 WebAudio 补播
      sfxDebug('✗ 被拦截，转 WebAudio 补播：' + key.replace('音乐/音效/',''));
      sfxDecode(key);
      let tries = 20;
      const retry = ()=>{
        const b = _sfxBuf[key];
        if(b && b !== 'pending' && b !== 'fail'){ sfxWeb(key, opt); sfxDebug('♪ 补播成功：' + key.replace('音乐/音效/','')); return; }
        if(tries-- > 0) setTimeout(retry, 120);
        else sfxDebug('✗ 补播失败（解码超时）：' + key.replace('音乐/音效/',''));
      };
      setTimeout(retry, 80);
    });
    _lastRealSfx = Date.now();
    return a;
  }catch(e){ sfxDebug('✗ 异常：' + key + ' ' + (e && e.message)); return null; }
}
function sfxPlay(rel, opt){ return !!sfxPlayEl(rel, opt); }
/* 叠音调压（**不丢音**）：同类音效同时播放越多，新增那条音量越低——Boss 脚本连铺场/总攻时靠
   音量让位，而不是把音效直接吞掉（曾被闸门吞掉，用户反馈「音效丢失」）。n 用 1.2s 衰减近似「同时在播」；
   下限 0.28 保证「敌方回合」的音效不会被压到听不见 */
const _sfxLoad = { deploy:{ n:0 }, attack:{ n:0 }, order:{ n:0 } };
function sfxVolume(kind, base){
  const g = _sfxLoad[kind];
  if(!g) return base;
  const v = Math.max(0.42, base / (1 + g.n * 0.15));
  g.n++;
  setTimeout(()=>{ g.n = Math.max(0, g.n - 1); }, 1200);
  return v;
}
/* 依次播放（前一段结束后接下一段）：喀秋莎「前半段 → 后半段（触发 2 点伤害时再来一遍）」 */
function sfxChain(list, opt){
  const head = list[0];
  if(!head) return;
  const a = sfxPlayEl(head, opt);
  if(a && list.length > 1) a.addEventListener('ended', ()=> sfxChain(list.slice(1), opt));
}
/* 战斗机射击：攻击音先播 **2 秒**，随后才起射击音（用户 2026-09-13 拍板；先要求同时、再改 0.5s，最终定为 2s），
   按该单位造成的伤害「每 1 点伤害 1 发」（上限 30 发）。
   连放节奏 = 射击音时长 − 150ms（「战斗机射击.mp3」实测 0.679s / 126kbps / 44.1kHz，逐帧数出；
   浏览器解码时长同量级 → 步长 ≈0.53s；相邻两发重叠 150ms，衔接处不留缝隙；取不到时长时退回 'ended' 串接）。
   多个战斗机连续攻击时最多保留 2 条射击链，更早的链被截断——否则 9 架飞机总攻会糊成一片 */
const SHOT_DELAY_MS = 2000;   // 攻击音起播后延迟多久开始连放射击音（用户 2026-09-13 定为 2 秒）
const SHOT_OVERLAP_MS = 150;
const _shotChains = [];
/* 单发间隔：优先用已解码的 AudioBuffer 时长，其次用 HTMLAudio 元素的 duration（都拿不到 → null 走 ended 串接） */
function shotStepMs(el){
  const b = (typeof _sfxBuf === 'object' && _sfxBuf) ? _sfxBuf[SFX.ftrShot] : null;
  if(b && b !== 'pending' && b !== 'fail' && b.duration) return Math.max(30, Math.round(b.duration * 1000) - SHOT_OVERLAP_MS);
  if(el && isFinite(el.duration) && el.duration > 0) return Math.max(30, Math.round(el.duration * 1000) - SHOT_OVERLAP_MS);
  return null;
}
function sfxShots(n, opt){
  if(!n || n <= 0) return;
  while(_shotChains.length >= 2){ const old = _shotChains.shift(); if(old){ old.left = 0; if(old.timer) clearTimeout(old.timer); } }
  const state = { left: Math.min(30, n | 0), timer: null };
  _shotChains.push(state);
  const step = () => {
    state.timer = null;
    if(state.left <= 0){ const i = _shotChains.indexOf(state); if(i > -1) _shotChains.splice(i,1); return; }
    state.left--;
    const a = sfxPlayEl(SFX.ftrShot, opt);
    if(!a){ state.left = 0; return; }
    if(state.left <= 0) return;
    const ms = shotStepMs(a);
    if(ms != null) state.timer = setTimeout(step, ms);   // 相邻两发重叠 SHOT_OVERLAP_MS（下一发在本发结束前 150ms 起播）
    else a.addEventListener('ended', step);              // 时长未知（未解码）：退回逐发串接
  };
  step();
}

/* ---------- 命名规则 → 音频文件 ----------
   原则：**只按费用档放**；只有「特殊音频校对.txt」里写明的单位才用专项文件。
   专项文件（摩托/轻骑兵/重骑兵/机枪坦克/喷火坦克/连射炮/战斗机射击/喷气机-2）本作暂无
   被指定使用的卡，一律不用（等校对里写明再加），不靠卡名猜测。 */
const defName = def => (def && def.n) ? String(def.n) : '';   // 仅用于「喀秋莎」这类与文件同名的专项判定
/* 部署音 */
function unitDeployAudio(def){
  if(!def) return '';
  const c = def.blood || 0, nm = defName(def);
  if(def.t === 'infantry'){
    if(def.id === 'r59') return SFX.apc;                                          // 校对：第59装甲掷弹兵团 → 装甲车音频
    return (c <= 2) ? SFX.inf02 : (c <= 5 ? SFX.inf35 : SFX.inf612);
  }
  if(def.t === 'tank') return (c <= 1) ? SFX.tankD1 : (c <= 2 ? SFX.tankD2 : (c <= 5 ? SFX.tankD35 : (c <= 10 ? SFX.tankD610 : SFX.tankD1112)));
  if(def.t === 'artillery') return (nm.indexOf('喀秋莎') > -1 || nm.indexOf('喀秋沙') > -1) ? SFX.katyD : SFX.artyD;
  if(def.t === 'fighter') return JET_AUDIO[def.id] || ((c <= 2) ? SFX.ftrD12 : SFX.ftrD312);  // 校对：Me 163彗星 → 喷气机-1
  if(def.t === 'bomber'){
    if(c <= 2) return SFX.bmbD12;
    const axis = (def.nation === 'us' || def.nation === 'jp' || def.nation === 'su');
    if(c <= 4) return axis ? SFX.bmbD34Axis : SFX.bmbD34Allied;
    return axis ? SFX.bmbD512Axis : SFX.bmbD512Allied;
  }
  return '';
}
/* 移动音（占领前线）：「单位的部署音效又是移动音效」——步兵（部署用的是步兵费用档音频）用
   「步兵占领前线」专项；带专项部署音的单位（如校对指定的第59装甲掷弹兵团=装甲车音频）移动时沿用同一个专项音 */
function unitMoveAudio(def){
  if(!def) return '';
  const dep = unitDeployAudio(def);
  if(def.t !== 'infantry') return dep;
  return (dep === SFX.inf02 || dep === SFX.inf35 || dep === SFX.inf612) ? SFX.infFront : dep;
}
/* 步兵攻击音：本作当前**没有**该文件 → 静音（只保留合成打击音）。
   等你补 音乐/音效/步兵/<费用档>步兵攻击.mp3（0~2K / 3~5K / 6~12K）后重新 build，
   这里按与部署音一致的命名规则自动接上（文件不存在就不放，不做任何猜测） */
function infantryAttackAudio(def){
  const c = def.blood || 0;
  const rel = SFX_ROOT + '步兵/' + (c <= 2 ? '0~2K' : c <= 5 ? '3~5K' : '6~12K') + '步兵攻击.mp3';
  return (typeof AUDIO_MAP !== 'undefined' && AUDIO_MAP[rel]) ? rel : '';
}
/* 攻击音：返回 {file} 或 {file, tail}（喀秋莎两段） */
function unitAttackAudio(def){
  if(!def) return null;
  const c = def.blood || 0, nm = defName(def);
  if(def.t === 'artillery'){
    // 校对：喀秋莎触发 2 点伤害时后半段放两遍（攻击音由 uiAttackFx 按 proc 连播）
    if(nm.indexOf('喀秋莎') > -1 || nm.indexOf('喀秋沙') > -1) return { file: SFX.katyA, tail: SFX.katyB };
    return { file: SFX.artyA };   // 其余炮兵：一般（单管炮）攻击音
  }
  if(def.t === 'tank') return { file: (c <= 1) ? SFX.tankA1 : (c <= 5 ? SFX.tankA2 : SFX.tankABig) };
  if(def.t === 'fighter') return { file: JET_AUDIO[def.id] || ((c <= 2) ? SFX.ftrA12 : SFX.ftrA312), shots: true }; // 攻击音后再按伤害连放「战斗机射击」
  if(def.t === 'bomber') return { file: (c <= 4) ? SFX.bmbA14 : SFX.bmbA512 };
  if(def.t === 'infantry'){ const ia = infantryAttackAudio(def); return ia ? { file: ia } : null; } // 无文件 → 静音（合成打击音兜底）
  return null;
}
/* 指令音：同名牌 → 贴膜 → 苏联费用档 → 日本/英国「其他牌」→ 无（合成兜底） */
function orderAudio(card){
  if(!card || card.kind !== 'order') return '';
  if(ORDER_AUDIO[card.id]) return ORDER_AUDIO[card.id];
  // 研发链名字兜底：3/6/9 费的「德意志帝国研发 / 扩展德意志帝国研发 / 高级…」及全部衍生卡 —— 都放「研发.mp3」
  // （点开/打出研发卡=触发抉择；抉择选项按下时的 1/23 阶段音在 uiSfx 的 research1/research23）
  if(/研发/.test(String(card.n || ''))) return SFX.ordResearch;
  const c = card.blood || 0;
  if(card.nation === 'su') return (c <= 1) ? SFX.ordSu1 : (c <= 3 ? SFX.ordSu23 : SFX.ordSu4);
  if(card.nation === 'jp') return SFX.ordJpOther;
  if(card.nation === 'gb') return SFX.ordGbOther;
  return '';
}
/* 结算音：玩家所属国的胜利/失败 */
function playSettleSfx(winnerSide){
  const nat = SETTLE_NATION[S.pNation] || '美国';
  const rel = SFX_ROOT + '结算音效/' + nat + (winnerSide === 'p' ? '胜利' : '失败') + '.mp3';
  return sfxPlay(rel, { volume:.6 });
}


/* ---------- 浮动提示（HOOKS.toast 实现，UI 层专属） ---------- */
let toastTimer = null;
function uiToast(msg){
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), 1600);
}

/* ---------- 对局结束面板（HOOKS.onGameEnd 实现，UI 层专属；v2：战役结算 + 回主菜单） ---------- */
function uiGameEnd(winner){
  // 对局结算延迟约 5 秒：让总部爆炸/死亡动画播完再弹结算面板
  if(_endDelay){ _endDelay = false; uiGameEndFrame(winner); return; }
  _endDelay = true;
  setTimeout(()=>{ _endDelay = false; uiGameEndFrame(winner); }, 5200);
}
let _endDelay = false;
function uiGameEndFrame(winner){
  hideChoiceBox(); // 抉择面板随对局结束清空（防残留跨局显示）
  hideMullBox();   // 换牌窗口随对局结束清空
  // 总部数字颜色复原（下局从白色默认开始）
  const ah = document.getElementById ? document.getElementById('aiHqHp') : null;
  const ph = document.getElementById ? document.getElementById('pHqHp') : null;
  if(ah) ah.style.color = '';
  if(ph) ph.style.color = '';
  applyDesk(false); // 结算返回菜单：背景切回默认桌面
  $('overlay').classList.remove('hidden');
  const result = $('ovResult');
  const aname = S.bossMode ? bossDisplayName() : nationOf('a').name;
  if(winner === 'p'){
    S.wins = ++SAVE.stats.wins;               // 战绩并入统一存档
    result.innerHTML = '天平彻底倾倒。「'+aname+' 输了……你赢了。」';
    result.className = '';
  } else {
    S.losses = ++SAVE.stats.losses;
    result.innerHTML = '天平猛地回弹。黑暗吞没牌桌。「'+nationOf('p').name+' 的军旗倒了。」';
    result.className = 'dim';
  }
  saveV2Save();
  LAST_BOSS = S.bossKind;
  const rb = $('btnRematch');
  if(rb){ rb.style.display = 'inline-block'; rb.textContent = '再 战 一 局'; }
  showView('menu');
}

/* ---------- 等待（HOOKS.wait 实现；浏览器保持旧版节奏） ---------- */
function waitMs(ms){ return new Promise(r => setTimeout(r, ms)); }

/* ---------- 渲染 ---------- */
/* 词条图标（装饰/词条/{词条名}.png；缺图回退文字）——只在场上单位显示，手牌不显示 */
function sigIconHTML(name, cls){
  const k = (typeof SIG_ICONS !== 'undefined') ? SIG_ICONS[name] : null;
  if(!k) return '';
  return '<span class="sigIcon' + (cls ? ' ' + cls : '') + '" style="background-image:url(\'' + imgUrl(k) + '\')" title="' + name + '"></span>';
}
/* 效果（fx）→ 图标名：取效果描述中与图标名匹配的最长前缀（如「亡计:抽1张」→ 亡计；「免疫压制」→ 免疫） */
function fxIconName(f){
  const t = (typeof UNIT_FX_TEXT !== 'undefined' && UNIT_FX_TEXT[f]) || '';
  if(!t) return '';
  let best = '';
  const names = (typeof SIG_ICONS !== 'undefined') ? Object.keys(SIG_ICONS) : [];
  for(const nm of names){
    if(nm.length > best.length && t.indexOf(nm) === 0) best = nm;
  }
  return best;
}
/* 效果分类表：常态效果（被动/持续，敌我回合都生效，如 Hs 129 对陆军+2）↔ 触发效果
   （限定条件触发，如物资短缺挂上的侵蚀/回合开始等）——对应「在场常态效果」「在场条件触发效果」图标。
   注意：亡计（死亡时触发）不属于「在场」效果，见 fxNotOnField —— 既不进常态也不进条件触发。 */
const FX_STYLE = {
  vsArmy3:'常态', vsTank2x:'常态', immuneSuppress:'常态', chanceExtra1:'常态',
  moveNattack:'常态', auraAtk1:'常态', perAllyD3:'常态', noHq:'常态',
  inhibitImmune:'常态', keepImpact:'常态', pb2yAura:'常态', frontAtk1:'常态',
  hs129Atk:'常态', rowGuardAmbush:'常态', ucarrierAura:'常态',
  onDamagedDraw:'触发', overflowHq:'触发', ki61Auto:'触发', t19GuardBreak:'触发', guard216:'触发',
  panzer:'触发', f4fBuff:'触发', reddevil:'触发', r7Vet:'触发',
  eng109:'触发', r25Spawn:'触发', me163Back:'触发', orderPunish:'触发', stzGen:'触发',
  r75Copy:'触发', meteorAfter:'触发', garrisonTick:'触发', selfBurnTurn:'触发'
};
/* 非「在场」效果：亡计在单位死亡时才触发（此时已不在场），因此不参与
   在场常态/在场条件触发的分类标签（自身仍显示「亡计」专图）。按效果描述前缀判定，后续新增亡计自动生效。 */
function fxNotOnField(f){
  const t = (typeof UNIT_FX_TEXT !== 'undefined' && UNIT_FX_TEXT[f]) || '';
  return t.indexOf('亡计') === 0;
}
function sigBadges(u){
  const parts = [];
  // 压制：被压制时显示（红色高亮），撤除后自动消失
  if(u.suppressed){
    parts.push(sigIconHTML('压制', 'supIcon') || '<span class="supTxt" title="被压制：不能移动/攻击">压制</span>');
  }
  (u.def.sig||[]).forEach(s=>{
    const info = SIGINFO[s]; if(!info) return;
    parts.push(sigIconHTML(info.n) || '<span title="'+info.d+'">'+info.n+'</span>');
  });
  // 光环赋予的词条（例：四号坦克H型（老兵）→「友方攻击力为4以上的陆军具有闪击」）：
  // 卡面 def.sig 里没有，但引擎的 hasSig 判定为真 → 补一个徽章，玩家才看得到它已经能立刻行动
  if(!(u.def.sig||[]).includes('blitz') && typeof hasSig === 'function' && hasSig(u,'blitz') && SIGINFO.blitz){
    parts.push(sigIconHTML(SIGINFO.blitz.n) || '<span title="'+SIGINFO.blitz.d+'">'+SIGINFO.blitz.n+'</span>');
  }
  // 效果分类标签：在场常态效果 / 在场条件触发效果（按 FX_STYLE 二分；亡计不计入）
  const fxs = u.def.fx || [];
  const onField = fxs.filter(f => !fxNotOnField(f));
  [['常态','在场常态效果'],['触发','在场条件触发效果']].forEach(([st,nm])=>{
    if(onField.some(f => FX_STYLE[f] === st)){
      const ic = sigIconHTML(nm);
      if(ic) parts.push(ic);
    }
  });
  // 效果（fx）图标：显示各自专图（如 亡计/倒计时/免疫/动员/收缴/钳击/隐蔽…；无专图不显示）
  fxs.forEach(f=>{
    const nm = fxIconName(f);
    if(nm) parts.push(sigIconHTML(nm));
  });
  if(u.armor){
    const ic = sigIconHTML('重甲');
    parts.push(ic ? ic + '<i class="sigNum">' + u.armor + '</i>' : '<span title="受到伤害-'+u.armor+'">重甲'+u.armor+'</span>');
  }
  return parts.join('');
}
function artHTML(def, small){
  if(def.img){ return '<img src="' + imgUrl(def.img) + '" alt="" width="'+(small?56:60)+'" height="'+(small?56:60)+'">'; }
  return '<canvas width="'+(small?46:46)+'" height="'+(small?46:46)+'" data-art="squirrel"></canvas>';
}
/* 油费显示：临时减油（拂晓行动=本回合空军0费 / 逆光攻击=本回合空军-1油）时，
   卡面展示实际花费并高亮原值，与攻击力光环（atkOf）的展示逻辑一致 */
function fuelHTML(u){
  if(!u.def.fuel) return '';
  const eff = actFuelCost(u.owner, u);
  if(eff < u.def.fuel) return ' <span style="color:#7ddf7d;font-weight:bold">⛽'+eff+'（原'+u.def.fuel+'）</span>';
  return ' ⛽'+eff;
}
function unitHTML(row, col){
  const u = unitAt(row,col);
  if(!u) return '<div class="slot" data-act="slot" data-row="'+row+'" data-col="'+col+'"></div>';
  const side = u.owner;
  const classes = ['unit'];
  if(side==='a') classes.push('enemy');
  if(!canAct(u) && !S.over) classes.push('used');
  if(S.mode && S.mode.type==='attack' && S.mode.row===row && S.mode.col===col) classes.push('selected');
  if(isTarget(u, row, col)) classes.push('targetable');
  let btns = '';
  if(side==='p' && S.phase==='player' && !S.over){
    if(row===backRowOf('p') && !u.movedThisTurn && (!u.summonedThisTurn || hasSig(u,'blitz') || u.def.t==='tank')){
      classes.push('mobile'); // 可推进：点击后金色空槽=推进落点
    }
  }
  const flag = (u.summonedThisTurn ? '新部署' : (u.movedThisTurn ? '已推进' : (u.suppressed ? '被压制' : '')));
  const bd = sigBadges(u);
  // 攻/血/油角标（全端统一）：攻=左下 血=右下 油=左上
  const liveStats =
    '<span class="mmStats mAtk">' + atkOf(u) + '</span>' +
    '<span class="mmStats mHp">' + u.hp + '</span>' +
    ((u.def.fuel || 0) > 0 ? '<span class="mmStats mFuel">⛽' + actFuelCost(u.owner, u) + '</span>' : '');
  return '<div class="'+classes.join(' ')+'" data-act="unit" data-row="'+row+'" data-col="'+col+'" data-info="'+u.def.nation+':unit:'+u.def.id+'" title="'+u.def.n+'：'+u.def.desc+'">'+
    '<div class="artbox">'+artHTML(u.def, false)+'</div>'+
    '<div class="uinfo">'+
      '<div class="uname">'+u.def.n+'</div>'+
      '<div class="utype">'+TYPEINFO[u.def.t]+fuelHTML(u)+'</div>'+
      '<div class="ustats"><span class="atk">⚔'+atkOf(u)+'</span><span class="hp">❤'+u.hp+'/'+u.maxHp+'</span></div>'+
    '</div>'+
    liveStats+
    (bd ? '<div class="usig">'+bd+'</div>' : '')+
    (flag ? '<div class="uflag">'+flag+'</div>' : '')+
    btns+'</div>';
}
/* ---------- 攻击行动可见特效（HOOKS.onAttack 实现） ----------
   攻击者扑击 + 目标红闪 + 飘字伤害；总部被击时敌总部红闪。瞬态，下一次渲染/事件自然清除。 */
let _lastFxAttack = null;
let _fxTimer = null;
function uiAttackFx(info){
  if(!info) return;
  sfxDebug('事件 攻击 ' + (info.atkDef ? info.atkDef.n : '?') + (info.hq ? '→总部' : '') + ' dd=' + info.dd);
  // 攻击音效：按攻击者兵种/费用/国家选文件（步兵无专属音，保留合成打击音）
  const aud = unitAttackAudio(info.atkDef);
  if(aud){
    const vol = sfxVolume('attack', .62);
    if(aud.tail) sfxChain([aud.file, aud.tail].concat(info.proc ? [aud.tail] : []), { volume: vol }); // 喀秋莎：触发 2 点伤害时后半段放两遍
    else {
      const a = sfxPlayEl(aud.file, { volume: vol });
      if(aud.shots){ // 战斗机：攻击音先播 2 秒，再按造成伤害「每 1 点 1 发」连放「战斗机射击」（上限 30 发）
        const n = Math.min(30, Math.max(0, (info.dd | 0)));
        if(n > 0) setTimeout(()=> sfxShots(n, { volume: vol }), SHOT_DELAY_MS);   // 用户 2026-09-13：攻击音响 2s 后接射击
      }
    }
  }
  _lastFxAttack = info;
  if(_fxTimer){ clearTimeout(_fxTimer); _fxTimer = null; }
  _fxTimer = setTimeout(()=>{ _lastFxAttack = null; _fxTimer = null; if(typeof render === 'function') render(); }, 950);
}
/* ---------- 反制触发：卡牌从手牌侧滑出展示（HOOKS.onCounterTrigger 实现） ---------- */
let _fxCounterT = null;
function uiCounterTriggerFx(info){
  if(!info || !document.getElementById) return;
  const parent = document.getElementById('table');
  if(!parent || !document.createElement) return;
  let layer = document.getElementById('fxCounterLayer');
  if(!layer){
    layer = document.createElement('div');
    layer.id = 'fxCounterLayer';
    parent.appendChild(layer);
  }
  const el = document.createElement('div');
  el.className = 'fxCounterCard ' + (info.side === 'a' ? 'fromA' : 'fromP');
  const def = info.def;
  el.innerHTML = '<div class="fxcArt">' + (def && def.img ? artHTML(def, false) : '⏱') + '</div>' +
    '<div class="fxcName">' + esc(def ? def.n : '反制') + '</div>';
  layer.appendChild(el);
  if(_fxCounterT){ clearTimeout(_fxCounterT); }
  _fxCounterT = setTimeout(()=>{ while(layer.firstChild) layer.removeChild(layer.firstChild); }, 1800);
}
/* ---------- 单位上线 / 死亡特效（瞬态队列；下一次棋盘渲染消费） ---------- */
let _deployFxQueue = [];
let _deathFxQueue = [];
let _moveFxQueue = [];
function uiUnitDeployFx(info){
  if(!info) return;
  sfxDebug('事件 部署 ' + (info.def ? info.def.n : '?'));
  sfxPlay(unitDeployAudio(info.def), { volume: sfxVolume('deploy', .62) }); // 部署音效：按兵种/费用/国家/特例（叠音时自动压低不丢音）
  _deployFxQueue.push({ row:info.row, col:info.col, hasDeploy:!!info.hasDeploy });
  if(_deployFxQueue.length > 6) _deployFxQueue.shift();
}
function uiUnitDeathFx(info){
  if(!info) return;
  _deathFxQueue.push({ row:info.row, col:info.col });
  if(_deathFxQueue.length > 6) _deathFxQueue.shift();
}
function uiMoveForwardFx(info){
  if(!info) return;
  sfxDebug('事件 推进 ' + (info.def ? info.def.n : '?'));
  sfxPlay(unitMoveAudio(info.def), { volume: sfxVolume('deploy', .62) }); // 移动音效：部署音即移动音（步兵用「步兵占领前线」）
  _moveFxQueue.push({ row:info.toRow, col:info.toCol, fromRow:info.fromRow, fromCol:info.fromCol });
  if(_moveFxQueue.length > 6) _moveFxQueue.shift();
}
/* ---------- 总部被摧毁：爆炸（配合 3 秒延迟结算） ---------- */
let _hqExplodeFx = null;
let _hqBoomT = null;
function uiHqExplodeFx(info){
  if(!info) return;
  _hqExplodeFx = info;
  if(!document.getElementById) return;
  const chipId = info.side === 'p' ? 'pHqChip' : 'aiHqChip';
  const chip = document.getElementById(chipId);
  if(chip && chip.classList){
    chip.classList.remove('hqExploded');
    chip.classList.remove('hqHit');
    let b = document.getElementById('hqBoom');
    if(!b && document.createElement){
      b = document.createElement('div');
      b.id = 'hqBoom'; b.className = 'hqBoom';
      chip.appendChild(b);
    }
    if(b){ b.classList.remove('go'); void b.offsetWidth; b.classList.add('go'); }
    chip.classList.add('hqExploded');
  }
  const tbl = document.getElementById('table');
  if(tbl && tbl.classList){
    tbl.classList.remove('boomWhite');
    void tbl.offsetWidth;
    tbl.classList.add('boomWhite');
  }
  if(_hqBoomT){ clearTimeout(_hqBoomT); }
  _hqBoomT = setTimeout(()=>{
    _hqExplodeFx = null;
    if(chip && chip.classList) chip.classList.remove('hqExploded');
    if(tbl && tbl.classList) tbl.classList.remove('boomWhite');
    if(tbl && typeof render === 'function') render();
  }, 5600);
}
function fxCellExtra(r, c){
  const ev = _lastFxAttack;
  let cls = '', float = '';
  const dx = _deathFxQueue.findIndex(q => q.row === r && q.col === c);
  if(dx >= 0){ const q = _deathFxQueue[dx]; _deathFxQueue.splice(dx,1); cls += ' deathFx'; float += '<span class="dmgFloat skull">💀</span>'; }
  const dy = _deployFxQueue.findIndex(q => q.row === r && q.col === c);
  if(dy >= 0){ const q = _deployFxQueue[dy]; _deployFxQueue.splice(dy,1); cls += ' deployFx'; if(q.hasDeploy) float += '<span class="dmgFloat dlDeploy">部 署</span>'; }
  const mq = _moveFxQueue.findIndex(q => q.row === r && q.col === c);
  if(mq >= 0){ const q = _moveFxQueue[mq]; _moveFxQueue.splice(mq,1); cls += (q.fromRow > q.toRow ? ' movedInUp' : ' movedInDown'); }
  if(!ev) return { cls, float };
  if(ev.hq){ return { cls, float }; }                            // 总部攻击：特效落在 hqchip（uiRender 处理）
  if(ev.atkRow === r && ev.atkCol === c){
    const dir = (ev.tgtCol !== undefined && ev.tgtCol !== null) ? ((ev.tgtCol > c) ? 1 : -1) : 1;
    cls += ' justAttacked ' + (dir > 0 ? 'dr' : 'dl');
    if(ev.rd > 0) float += '<span class="dmgFloat retal">-' + ev.rd + '</span>';
  }
  if(ev.tgtRow === r && ev.tgtCol === c){
    cls += ' justHit';
    if(ev.dd > 0) float += '<span class="dmgFloat">-' + ev.dd + '</span>' + (ev.killed ? '<span class="dmgFloat kill">消灭</span>' : '');
  }
  return { cls, float };
}
function renderBoard(){
  for(let r=0;r<ROWS;r++){
    let html = '';
    for(let c=0;c<COLS;c++){
      const u = unitAt(r,c);
      const fx = fxCellExtra(r,c);
      if(u){
        let uh = unitHTML(r,c);
        if(fx.cls) uh = uh.replace(/^<div class="unit/, '<div class="unit' + fx.cls);
        if(fx.float) uh = uh.replace(/<\/div>$/, fx.float + '</div>');
        html += uh;
      } else {
        const pc = slotPlaceable(r,c) ? ' placeable' : (slotMovable(r,c) ? ' movetarget' : '');
        html += '<div class="slot'+pc+fx.cls+'" data-act="slot" data-row="'+r+'" data-col="'+c+'">' + fx.float + '</div>';
      }
    }
    $('row'+r).innerHTML = html;
  }
}
function cardHTML(c, i){
  const cls = ['card'];
  if(c.kind!=='unit') cls.push('order');
  // [费用显示系统] 实际费用=playCost（精准轰炸按友方最高攻轰炸机动态减费/巴顿-1 等）；
  // 可负担性/置灰也按实际费用；减费时显示原值划线；0 费照常显示
  const effCost = playCost(S.p, c);
  const baseCost = c.blood || 0;
  const afford = effCost <= S.p.kredit;
  if(!afford && !c.armed) cls.push('disabled');
  if(S.mode && S.mode.type==='place' && S.mode.card === c) cls.push('selected');
  if(c.kind === 'counter' && c.armed) cls.push('counterArmed');   // 反制已激活（再点收回）
  if(S.gordonPick && c.kind === 'order') cls.push('gordonLift');  // 戈登高人团：指令上浮亮起
  if(S.discardPick && c !== S.discardPick.card) cls.push('gordonLift'); // 权衡：可弃的手牌上浮亮起
  let costs = '<span class="cost kredit'+(effCost <= 0 ? ' free' : '')+'"><span class="dot"></span>'+effCost+'</span>';
  if(baseCost > effCost) costs += '<span class="cost orig">原'+baseCost+'</span>';
  const oilc = c.kind==='unit' && c.fuel ? '<span class="cost movek"><span class="dot"></span>'+c.fuel+'</span>' : '';
  let body;
  if(c.kind === 'unit'){
    const fxline = (c.fx||[]).map(f=>UNIT_FX_TEXT[f]||'').filter(Boolean).join('；');
    body = '<div class="artbox">'+artHTML(c, true)+'</div>'+
      '<div class="cname">'+c.n+'</div><div class="ctype">'+TYPEINFO[c.t]+(c.armor?' · 重甲'+c.armor:'')+'</div>'+
      '<div class="cstats"><span class="atk">⚔'+c.atk+'</span><span class="hp">❤'+c.hp+'</span></div>'+
      '<div class="csig">'+((c.sig||[]).map(s=>SIGINFO[s]?SIGINFO[s].n:s).join('·'))+'</div>'+
      (fxline ? '<div class="ceff">'+esc(fxline)+'</div>' : '');
  } else if(c.kind === 'order'){
    body = '<div class="artbox">'+artHTML(c, true)+'</div>'+
      '<div class="cname">'+c.n+'</div><div class="ctype">指 令</div>'+
      '<div class="ceffect">'+c.desc+'</div>';
  } else {
    body = '<div class="artbox">'+artHTML(c, true)+'</div>'+
      '<div class="cname">'+c.n+'</div><div class="ctype">反 制</div>'+
      '<div class="ceffect">'+c.desc+'</div>';
  }
  const flag = c.kind==='counter' ? '<span class="cflag">'+(c.armed ? '反制·已激活' : '反制')+'</span>' : '';
  return '<div class="'+cls.join(' ')+'" data-act="hand" data-i="'+i+'" data-info="'+(c.nation||'us')+':'+c.kind+':'+c.id+'" title="'+c.n+'：'+(c.desc||c.n)+'" style="animation-delay:'+(i*40)+'ms">'+
    '<div class="costs">'+costs+oilc+'</div>'+flag+body+'</div>';
}
function renderHand(){
  $('hand').innerHTML = S.p.hand.map((c,i)=>cardHTML(c,i)).join('');
}
/* Boss 显示名（梦之泪伤 / 阿尔卑斯要塞 / 北北布次香菜 / hana） */
function bossDisplayName(){
  if(S.bossKind === 'alps') return '阿尔卑斯要塞';
  if(S.bossKind === 'meme') return '北北布次香菜';
  if(S.bossKind === 'hana') return 'hana';
  return '梦之泪伤';
}
function uiRender(){
  sfxWarmForTurn();   // 每回合（含 AI 回合）预热本回合可能用到的部署/移动/攻击音（幂等，已解码的直接跳过）
  // 菜单类界面只显示桌面背景：隐藏对战界面；进入对局才显示战场（重开等路径兜底）
  const tblEl = document.getElementById ? document.getElementById('table') : null;
  if(tblEl){
    const inBattle = !S.over && (S.phase === 'player' || S.phase === 'ai');
    if(inBattle){ if(tblEl.style.display === 'none') tblEl.style.display = ''; }
    else if(tblEl.style.display !== '') tblEl.style.display = 'none';
  }
  renderBoard(); renderHand();
  renderMulligan(); // 首回合换牌窗口（随 S.mulliganPending 显隐）
  const pn = nationOf('p'), an = S.bossMode ? Object.assign({}, nationOf('a'), {name: bossDisplayName()}) : nationOf('a');
  const aiLabel = S.bossMode ? bossDisplayName() : '老牧师';
  $('aiHqHp').textContent = S.a.hp;
  $('pHqHp').textContent = S.p.hp;
  $('aiHqName').textContent = an.name + '总部';
  $('pHqName').textContent = pn.name + '总部';
  $('aiHqBg').style.backgroundImage = 'url("' + hqUriOf('a') + '")';
  $('pHqBg').style.backgroundImage = 'url("' + hqUriOf('p') + '")';
  // 深水炸弹的总部烟幕（S.p/S.a.hqSmoke）：标记直接拼进 innerHTML —— render() 每次重算也会带上
  $('aiInfo').innerHTML = aiLabel + ' · ' + an.name + ' · 生命 <b class="aihp">' + S.a.hp + '</b> · 指挥点 <span class="aikredit">' + S.a.kredit + '</span> · 手牌 <span class="aihand">' + S.a.hand.length + '</span> · 牌库 <span class="aideck">' + S.a.deck.length + '</span>' + hqSmokeTag('a');
  $('pInfo').innerHTML = '<span class="res kredit"><span class="dot"></span>指挥点 <b id="pKredit">' + S.p.kredit + '</b>/<i id="pSlot">' + S.p.kreditSlots + '</i></span>' +
    pn.name + ' · 生命 <b class="php">' + S.p.hp + '/' + S.p.maxHp + '</b> · 牌库 <span class="pdeck">' + S.p.deck.length + '</span>' + hqSmokeTag('p');
  hqInfoBind();     // 信息条可点开总部面板：data-act 挂在**容器**上，innerHTML 重写不影响（事件委托）
  renderHqPanel();  // 面板开着时同步刷新（烟幕/指挥点/反制随 render 变化）
  $('turnInfo').textContent = '第 ' + S.turn + ' 回合 · 胜 ' + S.wins + ' 负 ' + S.losses;
  $('phaseMsg').textContent = S.over ? '对局结束'
    : (S.phase==='ai' ? '老牧师的回合……'
      : (S.discardPick ? (S.discardPick.shuffleIn ? '调整 · 点击手牌洗入卡组' : (S.discardPick.toDeck ? '点击手牌返回卡组顶' : (S.discardPick.costCut ? '观察团 · 点击手牌使其花费 -' + S.discardPick.costCut : '权衡 · 点击手牌弃掉 1 张'))) : (S.pendingChoice && S.pendingChoice.side==='p' ? '请做出抉择' : '你的回合')));
  $('endTurn').disabled = !(S.phase === 'player' && !S.over);
  const cname = { spotEnemy:'发现敌人', enemyDeployDmg:'无心漫谈', hqCap:'国家消防局', ultra:'ULTRA' };
  const plist = S.p.counters.map(x=>cname[x]||x).join('、');
  $('counters').innerHTML = plist ? '你激活的反制：'+plist : '';
  $('log').innerHTML = S.log.slice(-3).map(l=>'<div>'+l+'</div>').join('');
  const m = S.mode;
  let hqTarget = false, hqSelfTarget = false;
  if(m && m.type==='attack'){
    const u = unitAt(m.row,m.col);
    if(u) hqTarget = attackTargets(u.owner, m.row, m.col).some(t=>t.hq);
  }
  // 炮艇任务/轰炸突袭/快速胜利/航母战/外交专员/嗡嗡炸弹：指向模式可选总部（高亮）
  if(m && m.type==='order' && m.card && (m.card.eff==='gunboat' || m.card.eff==='bombRaid' || m.card.eff==='quickWin' || m.card.eff==='carrierWar' || m.card.eff==='diplomat' || m.card.eff==='buzzBomb')){
    hqTarget = true;
  }
  // 空中闪击/俾斯麦号：文档「对1个总部造成伤害」→ 双方总部都可点（高亮）
  if(m && m.type==='orderHq' && m.card){ hqTarget = true; hqSelfTarget = true; }
  // 零战部署：指向模式可选总部（任意目标）
  if(m && m.type==='deployPick' && m.card && m.card.target==='any'){
    hqTarget = true;
  }
  $('aiHqChip').classList.toggle('targetable', hqTarget && !S.over);
  $('pHqChip').classList.toggle('targetable', hqSelfTarget && !S.over);
  document.querySelectorAll('canvas[data-art]').forEach(cv=>{
    const a = cv.getAttribute('data-art');
    const g = cv.getContext('2d'); g.clearRect(0,0,cv.width,cv.height);
    g.fillStyle = '#e04a3a'; g.font = 'bold 28px serif'; g.textAlign='center'; g.textBaseline='middle';
    g.fillText('⚡', cv.width/2, cv.height/2+2);
  });
  document.querySelectorAll('.artbox img').forEach(im=>{
    if(im.complete && im.naturalWidth === 0){ im.style.opacity = '0.25'; }
  });
  // 摸牌面板由左右牌堆承担（触碰发牌）；牌堆暗态/发光随 S.drawPending 与余量
  renderAiHand();
  renderPiles();
  fxDrawDiff(); // [v2 特效] 抽牌飞行/敌方进手飞入：前后帧 diff（纯装饰，内部自判空）
  uiHqAttackFx(); // 攻击行动可见：总部被击红闪 + 飘字
  fitBattleView(); // 战场适配：整页缩放，让棋盘一屏放下（无需上下拖动）
}
/* 总部被击特效（onAttack hq 事件；瞬态，_lastFxAttack 清空后隐藏）
   多段伤害：ev.ddHits = [7,7] 时飘两个 -7（豹式坦克D型直击总部 = 2 次结算，用户 2026-09-17：
   「飘字应当是 2 次 7」）；没给 ddHits 的老事件照旧飘一个 -dd。 */
function uiHqAttackFx(){
  if(!document.getElementById) return;
  const ev = _lastFxAttack;
  const chipId = (ev && ev.hq) ? (ev.hqSide === 'p' ? 'pHqChip' : 'aiHqChip') : null;
  if(!chipId){ return; }
  const chip = document.getElementById(chipId);
  if(!chip) return;
  chip.classList.remove('hqHit');
  // 先清掉上一帧的飘字（可能是 1 个也可能是 2 个），再按本次命中段数重建
  if(chip.querySelectorAll){ const old = chip.querySelectorAll('.hqfloat'); for(let i=0;i<old.length;i++){ if(old[i].parentNode) old[i].parentNode.removeChild(old[i]); } }
  const hits = (ev.ddHits && ev.ddHits.length) ? ev.ddHits : ((ev.dd > 0) ? [ev.dd] : []);
  hits.forEach((h, i) => {
    if(!(h > 0)) return;
    const f = document.createElement('span');
    f.className = 'dmgFloat hqfloat';
    f.textContent = '-' + h;
    if(hits.length > 1){                    // 多段：错开位置 + 稍晚起飞，看得清是两下
      f.style.left = (14 + i * 44) + 'px';
      f.style.top = (-30 - i * 6) + 'px';
      f.style.animationDelay = (i * 0.26) + 's';
    }
    chip.appendChild(f);
  });
  chip.classList.add('hqHit');
}

/* ---------- 总部也是一张卡牌：总部面板（用户 2026-09-13 口径） ----------
   需求原话：「深水炸弹给总部上的烟幕要做 UI 提示，总部其实也是一张卡牌，可以点开查看他有的效果」。
   三条实现约束（对应三个坑）：
   ① 烟幕标记由 uiRender 直接拼进 #aiInfo / #pInfo 的 innerHTML（hqSmokeTag）——render() 每次重算也不会丢；
   ② 点击事件走 document 上既有的 data-act 委托：属性挂在**容器** #aiInfo/#pInfo 上（不在 innerHTML 里的
      子节点上挂监听），所以重算 innerHTML 不影响点击；
   ③ 面板是自建浮层（写法同 orderAnim/choiceBox/mullBox 的注入式 <style>），点击**不 stopPropagation**，
      不挡棋盘的出牌/点选；有进行中的点选（S.mode/discardPick/gordonPick）时点击信息条仍按老规矩取消。
   内容只列**当前真实存在**的状态（直接读 S.p / S.a 上的字段），不按卡名虚构效果。 */
const HQ_COUNTER_NAME = { spotEnemy:'发现敌人', enemyDeployDmg:'无心漫谈', hqCap:'国家消防局', ultra:'ULTRA' };
let hqPanelSide = null, hqPanelEl = null;
/* 烟幕标记（引擎侧事实）：S.p.hqSmoke / S.a.hqSmoke —— 深水炸弹给己方总部上烟幕，
   期间 attackTargets / orderTargets 都不给出该总部，r2ClearHqSmoke 在该方下个回合开始时清除 */
function hqSmokeTag(side){
  const P = side === 'a' ? S.a : S.p;
  if(!P || !P.hqSmoke) return '';
  return ' <span class="hqSmoke" title="烟幕：直到该方下个回合开始前，总部无法被指向（不能被攻击，也不能被指令指定为目标）">🌫 烟幕</span>';
}
/* 信息条容器绑定：data-act="hqinfo" + 手型光标（幂等，每次 render 重设一次即可） */
function hqInfoBind(){
  if(typeof document === 'undefined' || !document.getElementById) return;
  [[$('aiInfo'), 'a'], [$('pInfo'), 'p']].forEach(function(pair){
    const el = pair[0], side = pair[1];
    if(!el) return;
    if(el.dataset){ el.dataset.act = 'hqinfo'; el.dataset.side = side; }
    if(el.setAttribute) el.setAttribute('data-act', 'hqinfo');   // dataset 与属性双写：真实 DOM 下等价，桩环境下也认
    if(el.style) el.style.cursor = 'pointer';
    if(el.setAttribute) el.setAttribute('title', '点击查看总部当前的效果');
  });
}
function uiSafeText(s){ return (typeof esc === 'function') ? esc(s) : String(s == null ? '' : s); }
function hqEsc(s){ return uiSafeText(s); }
function hqPanelWho(side){
  const nat = (typeof nationOf === 'function' && nationOf(side)) || { name:'总部' };
  if(side === 'a') return ((S.bossMode ? bossDisplayName() : '老牧师') + ' · ' + nat.name + '总部');
  return nat.name + '总部';
}
/* 面板行：[标签, 说明] —— 每条都对应一个真实读到的字段（没有该状态就不出行） */
function hqPanelRows(side){
  const P = side === 'a' ? S.a : S.p;
  if(!P) return [];
  const rows = [];
  rows.push(['生命', P.hp + ' / ' + (P.maxHp != null ? P.maxHp : P.hp)]);
  if(P.hqSmoke) rows.push(['烟幕', '直到该方下个回合开始前，总部无法被指向：不能被攻击，也不能被敌方指令指定为目标']);
  rows.push(['指挥点', P.kredit + ' / ' + (P.kreditSlots != null ? P.kreditSlots : '?') + ' 槽']);
  const cnt = P.counters || [];
  // 已激活（挂上桌）的反制是暗牌：AI 侧只显示数量，不借面板读牌（玩家侧是自己激活的，照常显示名字）
  // 注意：这是「挂上去的反制」——手牌里的反制卡是普通手牌，情报能揭示、弃牌/转换照样作用
  if(side === 'p') rows.push(['反制', cnt.length ? cnt.map(x => HQ_COUNTER_NAME[x] || x).join('、') : '未激活']);
  else rows.push(['反制', cnt.length ? ('暗牌 ×' + cnt.length + '（未触发，不公开）') : '未激活']);
  // 柏林之路：旗标挂在「受益方」上，累计值挂在「挨打方」上（applyHqDamage）
  if(P.roadBerlin) rows.push(['柏林之路', '此总部每回合累计受到 ≥3 点伤害时，对方总部 +3 防御力' + (P.hqDmgAccum ? '（本回合已累计 ' + P.hqDmgAccum + ' 点）' : '')]);
  if(P.hmsTalbot) rows.push(['HMS塔尔伯特', P.hmsTalbotUsed ? '已用尽：本局的一次性护盾已消耗' : '此总部即将受到致命伤害时，先获得 +6 防御力（仅 1 次，尚未使用）']);
  if(typeof m26Frontline === 'function' && m26Frontline(side)) rows.push(['M26潘兴', '前线有 M26 潘兴：此总部受到的伤害无法把防御力降到 1 以下']);
  return rows;
}
function hqPanelHTML(side){
  return '<div class="hpClose" data-act="hqClose" title="关闭">✕</div>' +
    '<div class="hpTitle">' + hqEsc(hqPanelWho(side)) + ' · 总部</div>' +
    hqPanelRows(side).map(r => '<div class="hpRow"><span class="hpK">' + hqEsc(r[0]) + '</span><span class="hpV">' + hqEsc(r[1]) + '</span></div>').join('') +
    '<div class="hpHint">总部也是一张卡牌：这里只列出当前真实生效的效果（点 ✕ 或面板外关闭）。</div>';
}
function ensureHqPanel(){
  if(hqPanelEl) return;
  if(typeof document === 'undefined' || !document.createElement) return;
  hqPanelEl = document.createElement('div');
  hqPanelEl.id = 'hqPanel';
  hqPanelEl.style.display = 'none';
  const host = (document.getElementById ? document.getElementById('table') : null) || document.body || null;
  if(host && host.appendChild) host.appendChild(hqPanelEl);
  if(document.head && document.head.appendChild){
    const st = document.createElement('style');
    st.textContent =
      '.hqSmoke{color:#bfe6ff;font-weight:bold;text-shadow:0 0 8px rgba(140,200,255,.8);}' +
      '#hqPanel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:59;min-width:280px;max-width:min(92vw,470px);max-height:74vh;overflow:auto;' +
        'padding:14px 16px 12px;border-radius:12px;border:2px solid #f0d58a;background:linear-gradient(170deg,rgba(38,26,14,.97),rgba(20,14,8,.97));' +
        'box-shadow:0 14px 40px rgba(0,0,0,.8),0 0 26px rgba(240,200,120,.25);color:#e8d9ae;font-size:13px;line-height:1.55;}' +
      '#hqPanel .hpTitle{font-size:16px;font-weight:bold;color:#f0d58a;letter-spacing:2px;margin-bottom:8px;padding-right:24px;}' +
      '#hqPanel .hpClose{position:absolute;right:8px;top:8px;width:22px;height:22px;line-height:20px;text-align:center;border-radius:6px;cursor:pointer;' +
        'color:#f0d58a;border:1px solid rgba(240,213,138,.5);background:rgba(0,0,0,.35);}' +
      '#hqPanel .hpClose:hover{background:rgba(240,213,138,.22);}' +
      '#hqPanel .hpRow{display:flex;gap:10px;padding:3px 0;border-top:1px dashed rgba(240,213,138,.22);}' +
      '#hqPanel .hpRow:first-of-type{border-top:none;}' +
      '#hqPanel .hpK{flex:0 0 84px;color:#c9b483;}' +
      '#hqPanel .hpV{flex:1;color:#f3e7c8;}' +
      '#hqPanel .hpHint{margin-top:9px;font-size:11px;color:#a99268;}';
    document.head.appendChild(st);
  }
}
function renderHqPanel(){
  if(!hqPanelSide || !hqPanelEl) return;
  if(S.over){ closeHqPanel(); return; }                       // 对局结束：收起面板（结算面板优先）
  if(hqPanelEl.style && hqPanelEl.style.display === 'none') return;
  hqPanelEl.innerHTML = hqPanelHTML(hqPanelSide);
}
function openHqPanel(side){
  ensureHqPanel();
  if(!hqPanelEl) return;
  hqPanelSide = (side === 'a') ? 'a' : 'p';
  hqPanelEl.innerHTML = hqPanelHTML(hqPanelSide);
  hqPanelEl.style.display = 'block';
}
function closeHqPanel(){
  hqPanelSide = null;
  if(hqPanelEl){ hqPanelEl.innerHTML = ''; hqPanelEl.style.display = 'none'; }
}
function toggleHqPanel(side){ if(hqPanelSide === side) closeHqPanel(); else openHqPanel(side); }

/* ---------- 战场适配（整页 zoom 缩放） ----------
   战场是固定像素布局（约 880px 高），小窗口/笔记本会纵向溢出、需要上下拖动。
   方案：按视口高度量取 #table 自然尺寸，对 <html> 施加 zoom 缩放（≤1），
   使整场对局恰好装进一屏；窗口大小变化或对局内容增高（手牌换行等）时自动重算。
   - 覆盖层菜单 .ovview 自带内部滚动（max-height:94vh; overflow-y:auto），缩放不影响浏览；
   - 无头/测试环境缺少 window.innerHeight 或 documentElement 时自动跳过。 */
let _fitLastKey = '', _fitAt = 0, _fitLastH = 0;
function fitBattleView(){
  if(typeof document === 'undefined' || !document.documentElement || !window || typeof window.innerHeight !== 'number' || typeof window.innerWidth !== 'number') return;
  const html = document.documentElement;
  const vw = window.innerWidth, vh = window.innerHeight;
  const now = Date.now();
  const key = vw + 'x' + vh;
  if(key === _fitLastKey && now - _fitAt < 350) return; // 节流：视口未变且刚适配过
  const tbl = document.getElementById('table');
  if(!tbl || typeof tbl.getBoundingClientRect !== 'function') return;
  html.style.zoom = '1'; // 量自然尺寸（先复位，避免叠加）
  const r = tbl.getBoundingClientRect();
  const H = Math.max(1, r.height);
  const W = Math.max(1, r.width, tbl.scrollWidth || r.width);
  // 部署/抽牌等引起的高度小幅波动不重排（防卡槽视觉跳变）：±10% 内沿用当前缩放
  const sameViewport = key === _fitLastKey;
  if(sameViewport && _fitLastH && Math.abs(H - _fitLastH) <= _fitLastH * 0.1){
    _fitAt = now;
    return;
  }
  // 全端统一：一套布局，仅按窗口大小整体缩放（小屏=缩放后的同一界面）
  let s = 1;
  if(H > vh - 6) s = Math.min(s, (vh - 6) / H);
  if(W > vw - 4) s = Math.min(s, (vw - 4) / W);
  if(s >= 1){ if(html.style.zoom) html.style.zoom = ''; }
  else html.style.zoom = String(Math.max(0.25, s));
  _fitLastKey = key; _fitAt = now; _fitLastH = H;
}
function bindFitResize(){
  if(typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('resize', () => { _fitLastKey = ''; fitBattleView(); });
  if(window.visualViewport && typeof window.visualViewport.addEventListener === 'function'){
    window.visualViewport.addEventListener('resize', () => { _fitLastKey = ''; fitBattleView(); }); // 手机地址栏伸缩
    window.visualViewport.addEventListener('orientationchange', () => { _fitLastKey = ''; fitBattleView(); });
  }
}

/* ---------- 国家旗名（筛选用图标/国家/.png；卡背见下方卡背系统） ---------- */
const flagNameOf = k => ({ us:'美国', de:'德国', su:'苏联', gb:'英国', jp:'日本', pl:'波兰', fr:'法国', fi:'芬兰', it:'意大利' }[k] || k);
/* ---------- 卡背系统（装饰/卡背/{国}/{名称}_{磨损序号}.png；CARD_BACKS 由构建脚本生成） ----------
   组卡器可为卡组装配卡背（中立/盟国素材暂不可用）；
   对局中：己方=该卡组装备卡背的随机 1 张磨损图；敌方=AI 按实力（难度）装配。 */
function backById(id){ return (CARD_BACKS || []).find(b => b.id === id) || null; }
const NATION_DIR = { us:'美', de:'德', su:'苏', gb:'英', jp:'日', pl:'波', fr:'法', fi:'芬', it:'意' }; // 引擎国家键 ↔ 卡背目录码
function backDefaultId(nation){ // 默认：本国「基础」卡背
  const dir = NATION_DIR[nation] || flagNameOf(nation);
  const n = flagNameOf(nation);
  const lst = (CARD_BACKS || []).filter(b => b.nation === dir);
  const b = lst.find(x => x.name === (n + '基础')) || lst[0] || (CARD_BACKS || [])[0];
  return b ? b.id : null;
}
function aiBackId(nation, difficulty){ // AI 按实力装配：新兵→基础 / 老练→空军 / 守望→老兵 / 元帅→精锐(多磨损)
  const dir = NATION_DIR[nation] || flagNameOf(nation);
  const n = flagNameOf(nation);
  const lst = (CARD_BACKS || []).filter(b => b.nation === dir);
  const byName = nm => lst.find(x => x.name === nm);
  const d = difficulty || 'recruit';
  let b = null;
  if(d === 'recruit') b = byName(n + '基础');
  else if(d === 'veteran') b = byName(n + '空军');
  else if(d === 'warder') b = byName(n + '老兵');
  else b = lst.find(x => x.wears.length >= 4) || byName('战区·' + n) || byName(n + '老兵');
  b = b || lst[0] || (CARD_BACKS || [])[0];
  return b ? b.id : null;
}
function backIdOf(side){ // 当前对局该侧装备的卡背 id（缺失回退默认）
  if(S && S.backOf && S.backOf[side] && backById(S.backOf[side])) return S.backOf[side];
  return null;
}
let _backCache = { p: null, a: null }; // 每局随机一次磨损图后固定（避免每帧闪烁）
function backUriOf(side){
  const id = backIdOf(side) || backDefaultId(side === 'p' ? S.pNation : S.aNation);
  const b = backById(id);
  if(!b || !b.wears.length) return '';
  if(!_backCache[side]) _backCache[side] = b.wears[Math.floor(Math.random() * b.wears.length)];
  return IMG_MAP[_backCache[side]] || '';
}
/* 指定卡背的指定磨损图（组卡器预览用；wearIdx 省略=随机 1 张） */
function backArtOf(id, wearIdx){
  const b = backById(id);
  if(!b || !b.wears.length) return '';
  const k = (wearIdx === undefined || wearIdx === null)
    ? b.wears[Math.floor(Math.random() * b.wears.length)]
    : b.wears[Math.min(wearIdx, b.wears.length - 1)];
  return IMG_MAP[k] || '';
}
/* ---------- 总部场景（装饰/总部/{国}/{场景}.png 多幅） ----------
   默认：本国经典图（德/但泽 美/瑟堡 英/亚历山大港 日/特鲁克 苏/斯大林格勒）；
   组卡器可为卡组选定场景（S.hqOf[side] 覆盖），卡图上印有数字时由黑幕数据留档（当前不启用）。 */
const HQ_DIR = { us:'美', de:'德', su:'苏', gb:'英', jp:'日', pl:'波', fr:'法', fi:'芬', it:'意' };
function hqPathOf(side){
  return (S.hqOf && S.hqOf[side]) || nationOf(side).hq;
}
function hqUriOf(side){ return IMG_MAP[hqPathOf(side)] || imgUrl(hqPathOf(side)); }
/* ---------- 桌面背景（装饰/桌面/） ----------
   初始/默认背景 = 默认兼初始桌面_4.png（菜单、结算等）；
   对战背景 = 友方总部对应桌布（总部场景名匹配 总部对应桌布/{场景}.png，
   如 地堡_德国 → 地堡.png）；无对应桌布时从初始桌面中随机一张。 */
function deskDefaultUri(){ return (typeof IMG_MAP !== 'undefined' && IMG_MAP[DESK_DEFAULT_KEY]) || ''; }
function deskBattleUri(){
  const scene = (S && S.hqOf && S.hqOf.p) || '';
  if(scene){
    let base = scene.split('/').pop().replace(/\.png$/, '');
    base = base.replace(/_(德国|日本|美国|苏联|英国|德|日|美|苏|英)$/, '');
    if(typeof DESK_TABLE !== 'undefined' && DESK_TABLE[base] && IMG_MAP[DESK_TABLE[base]]) return IMG_MAP[DESK_TABLE[base]];
  }
  const list = (typeof DESK_INITIAL !== 'undefined') ? DESK_INITIAL : [];
  if(list.length){
    const pick = list[Math.floor(Math.random() * list.length)];
    if(IMG_MAP[pick]) return IMG_MAP[pick];
  }
  return deskDefaultUri();
}
function applyDesk(battle){
  if(typeof document === 'undefined' || !document.body) return;
  const uri = battle ? deskBattleUri() : deskDefaultUri();
  if(uri){
    document.body.style.backgroundImage = 'url("' + uri + '")';
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
  } else {
    document.body.style.backgroundImage = '';
  }
  // 菜单类界面：遮罩层以桌面为背景（不露出对战界面）；对战：显示战场、隐藏遮罩
  const ovl = document.getElementById ? document.getElementById('overlay') : null;
  if(ovl){
    if(uri){ ovl.style.backgroundImage = 'url("' + uri + '")'; ovl.style.backgroundSize = 'cover'; ovl.style.backgroundPosition = 'center'; }
    else { ovl.style.backgroundImage = ''; }
  }
  const tbl = document.getElementById ? document.getElementById('table') : null;
  if(tbl) tbl.style.display = battle ? '' : 'none';
}

/* ---------- 敌方手牌（伪3D）：未知=卡背卡图（无图时国旗卡背兜底）；明牌(revealed)=正面直显小卡 ---------- */
function renderAiHand(){
  const el = $('aiHand');
  if(!el) return;
  const an = S.bossMode ? Object.assign({}, nationOf('a'), {name: bossDisplayName()}) : nationOf('a');
  const flag = '筛选用图标/国家/' + flagNameOf(S.aNation || 'us') + '.png';
  const bk = backUriOf('a');
  el.innerHTML = S.a.hand.map(c => {
    if(c && c.revealed && c.img){
      return '<div class="aiCard face" title="明牌：'+esc(c.n)+'（对方已知）">'+
        '<span class="fglow"></span><div class="artbox"><img src="'+imgUrl(c.img)+'" alt="" loading="lazy"></div>'+
        '<div class="fname">'+esc(c.n)+'</div></div>';
    }
    return '<div class="aiCard back" title="'+esc(an.name)+' 手牌（未知）">'+
      '<div class="bk">'+
        '<span class="bkFlag"><img src="'+imgUrl(flag)+'" alt="" loading="lazy"></span>'+
        '<span class="bkRib">'+esc(an.name)+'</span>'+
        (bk ? '<img class="bkArt" src="'+bk+'" alt="" onerror="this.style.display=\'none\'">' : '')+
      '</div></div>';
  }).join('');
}

/* ---------- 左右牌堆（左=生产牌堆 右=卡组牌堆）：计数 + 发光(可发牌)/暗态(不可) ---------- */
function renderPiles(){
  const prod = $('prodPile'), deck = $('deckPile');
  if(!prod || !deck || !prod.querySelector) return; // 无头沙箱保护（stub 元素无 querySelector）
  const flag = '筛选用图标/国家/' + flagNameOf(S.pNation || 'us') + '.png';
  const pimg = prod.querySelector('.bkFlag img'), dimg = deck.querySelector('.bkFlag img');
  if(pimg && pimg.src.indexOf('data:') !== 0) pimg.src = imgUrl(flag);
  if(dimg && dimg.src.indexOf('data:') !== 0) dimg.src = imgUrl(flag);
  // 牌堆顶卡卡图：生产堆=生产卡图（已知内容）；卡组堆=国家卡背卡图（未知内容）
  const pa = prod.querySelector('.pcard .pArt'), da = deck.querySelector('.pcard .pArt');
  const prodArt = imgUrl('卡牌/中立/生产.jpg');
  if(pa && pa.src !== prodArt){ pa.style.display = ''; pa.src = prodArt; }
  const bk = backUriOf('p');
  if(da && bk && da.src !== bk){ da.style.display = ''; da.src = bk; }
  const pc = $('prodPileCnt'), dc = $('deckPileCnt');
  if(pc) pc.textContent = S.p.prodDeck.length;
  if(dc) dc.textContent = S.p.deck.length;
  const pending = !!(S.drawPending && S.phase === 'player' && !S.over);
  prod.classList.toggle('glow', pending && S.p.prodDeck.length > 0);
  deck.classList.toggle('glow', pending && S.p.deck.length > 0);
  prod.classList.toggle('off', !pending);
  deck.classList.toggle('off', !pending);
  // [fx] 牌堆堆叠：可见层板随余量增减（约每 4 张一层、上限 8 层），直观看出剩余多少
  syncPileStack(prod, S.p.prodDeck.length);
  syncPileStack(deck, S.p.deck.length);
}

/* 牌堆堆叠层板：在 .pcard 之前插入 N 块卡背层板（伪3D 阶梯），余量越多越厚 */
function syncPileStack(pileEl, cnt){
  if(!pileEl || typeof pileEl.querySelector !== 'function') return;
  const st = pileEl.querySelector('.pileStack');
  if(!st || typeof st.querySelectorAll !== 'function') return;
  try{
    st.querySelectorAll('.pslab').forEach(n => { try{ n.remove(); }catch(e){} });
    if(cnt <= 0) return;
    const slabs = Math.min(8, Math.max(1, Math.ceil(cnt / 4)));
    for(let i = 0; i < slabs; i++){
      const s = document.createElement('div');
      s.className = 'pslab';
      s.style.transform = 'rotateX(52deg) translateY(' + (i * 3) + 'px)';
      st.insertBefore(s, st.firstChild); // pcard 保持最后 → 盖在最上层
    }
  }catch(e){ /* 装饰失败不致命 */ }
}

/* ============================================================
   [v2 特效层] 敌方揭示旅程 / 抽牌飞行翻面 / 满手爆牌
   纯装饰：不改 S、不改玩法、不改渲染输出结构；无头沙箱或
   无真实布局时静默跳过；临时元素动画结束/超时自动移除。
   ============================================================ */

let fxSkipNextEnemyIn = false;  // 敌方揭示旅程已展示：抑制下一次「敌方进手」的通用左侧飞入
let fxSkipAge = 0;              // 抑制标志存留的渲染帧数（防跨局残留误抑制后续进手）
let fxPrev = null;              // 抽牌 diff 基线：{aHand,pHand,pDeck,pProd,turn,over,inGame}

/* 特效舞台：挂到 #table 下 fixed 覆盖层（z 56，位于抉择/换牌/结算之下、指令闪现之上）；
   无 WAAPI（含无头 stub DOM）的环境整体禁用装饰层 */
let fxStageEl = null, fxStageAnim = false;
function fxGetStage(){
  if(typeof document === 'undefined') return null;
  if(fxStageEl) return fxStageAnim ? fxStageEl : null;
  const table = document.getElementById('table');
  if(!table || typeof table.appendChild !== 'function') return null;
  const stage = document.createElement('div');
  if(!stage || typeof stage.appendChild !== 'function') return null;
  fxStageAnim = typeof stage.animate === 'function';
  if(!fxStageAnim) return null;                    // stub / 极旧浏览器：跳过装饰
  stage.id = 'fxStage';
  table.appendChild(stage);
  try{
    if(document.head && typeof document.head.appendChild === 'function'){
      const st = document.createElement('style');
      st.textContent =
        '#fxStage{position:fixed;left:0;top:0;right:0;bottom:0;z-index:56;pointer-events:none;overflow:hidden;}' +
        '#fxStage .fxGhost{position:absolute;left:0;top:0;pointer-events:none;will-change:transform,opacity;}' +
        '#fxStage .fxFlip{position:relative;width:100%;height:100%;transform-style:preserve-3d;}' +
        '#fxStage .fxSide{position:absolute;left:0;top:0;width:100%;height:100%;border-radius:9px;overflow:hidden;backface-visibility:hidden;-webkit-backface-visibility:hidden;border:2.5px solid #4a2f14;box-shadow:0 8px 20px rgba(0,0,0,.55);}' +
        '#fxStage .fxFace{background:linear-gradient(170deg,#f2e5c0,#d3bd8e 60%,#b89e6a);}' +
        '#fxStage .fxBack{transform:rotateY(180deg);background:repeating-linear-gradient(45deg,rgba(150,95,30,.55) 0 7px,rgba(70,40,12,.55) 7px 14px),linear-gradient(165deg,#4a3016,#1f1004);}' +
        '#fxStage .fxSide img.fxArt{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}' +
        '#fxStage .fxTag{position:absolute;left:0;right:0;bottom:0;padding:10px 2px 3px;text-align:center;font-size:10px;letter-spacing:2px;color:#ffe9b0;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.6));text-shadow:0 1px 2px #000;}' +
        '#fxStage .fxRing{position:absolute;border-radius:50%;pointer-events:none;border:2px solid rgba(240,200,120,.85);box-shadow:0 0 22px rgba(240,180,80,.55),inset 0 0 14px rgba(240,180,80,.35);will-change:transform,opacity;}';
      document.head.appendChild(st);
    }
  }catch(e){ /* 样式注入失败不致命 */ }
  fxStageEl = stage;
  return stage;
}
/* 清空舞台并复位防重标志（对局切换/重置时调用，防跨局残留） */
function fxClearStage(){
  try{ if(fxStageEl && fxStageEl.innerHTML !== undefined) fxStageEl.innerHTML = ''; }catch(e){}
  fxSkipNextEnemyIn = false;
  fxSkipAge = 0;
}

/* 元素中心（视口坐标）；无真实布局（rect 缺失/宽高为 0）返回 null */
function fxRectCenter(el){
  if(!el || typeof el.getBoundingClientRect !== 'function') return null;
  let r = null;
  try{ r = el.getBoundingClientRect(); }catch(e){ return null; }
  if(!r || !r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/* WAAPI 封装：不可用/异常返回 null，调用方静默跳过 */
function fxTrans(el, kfs, opt){
  if(!el || typeof el.animate !== 'function') return null;
  try{ return el.animate(kfs, Object.assign({ fill: 'both' }, opt || {})); }
  catch(e){ return null; }
}
/* 超时兜底清理（动画正常结束也会再走一次，removeChild 幂等） */
function fxCleanup(el, ms){
  setTimeout(() => {
    try{ if(el && el.parentNode) el.parentNode.removeChild(el); }catch(e){}
    try{ if(el && typeof el.remove === 'function') el.remove(); }catch(e2){}
  }, ms || 600);
}

/* 造幽灵卡：faceRel=正面相对图路径(空→无图纸面)；backUri=卡背图 dataURI(空→CSS 底纹)；
   初始以背面朝观众（外层动画负责翻面） */
function fxMakeGhost(faceRel, backUri, tag){
  const stage = fxGetStage();
  if(!stage) return null;
  const g = document.createElement('div');
  g.className = 'fxGhost';
  const faceImg = faceRel ? '<img class="fxArt" alt="" src="' + imgUrl(faceRel) + '">' : '';
  const backImg = backUri ? '<img class="fxArt" alt="" src="' + backUri + '">' : '';
  g.innerHTML =
    '<div class="fxFlip">' +
      '<div class="fxSide fxFace">' + faceImg + (tag ? '<span class="fxTag">' + esc(tag) + '</span>' : '') + '</div>' +
      '<div class="fxSide fxBack">' + backImg + '</div>' +
    '</div>';
  stage.appendChild(g);
  const flip = g.firstChild;
  if(flip) flip.style.transform = 'rotateY(180deg)'; // 登场先见卡背
  return { g: g, flip: flip };
}

/* 敌方抽取揭示旅程（side='a' 揭示卡）：卡背从屏幕左侧飞向中央展示位(≈50%/45%)
   → 翻面露出卡图 → 短暂停留 → 飞向敌方手牌行(#aiHand 区域)淡出；总时长约 1.45s */
function fxEnemyRevealJourney(card){
  const stage = fxGetStage();
  if(!stage || !card) return;
  let vw = 0, vh = 0;
  try{
    vw = window.innerWidth || document.documentElement.clientWidth || 0;
    vh = window.innerHeight || document.documentElement.clientHeight || 0;
  }catch(e){}
  if(!vw || !vh) return;
  const w = 120, h = 168, total = 1450;
  const air = fxRectCenter(document.getElementById('aiHandRow')) || fxRectCenter(document.getElementById('aiHand'));
  const sy = air ? air.y - h / 2 : Math.round(vh * 0.1);
  const cx = Math.round(vw / 2 - w / 2);
  const cy = Math.round(vh * 0.45 - h / 2);
  let ex = cx, ey = sy;
  if(air){ ex = Math.round(air.x - w / 2); ey = Math.round(air.y - h / 2); }
  const g = fxMakeGhost((card.img || ''), backUriOf('a'), card.n || '');
  if(!g) return;
  g.g.style.width = w + 'px';
  g.g.style.height = h + 'px';
  const sx = -Math.round(w * 0.9);
  fxTrans(g.g, [
    { offset: 0,   transform: 'translate(' + sx + 'px,' + sy + 'px) scale(.88)', opacity: 0, easing: 'ease-out' },
    { offset: .06, transform: 'translate(' + (sx + 22) + 'px,' + sy + 'px) scale(.96)', opacity: 1, easing: 'cubic-bezier(.25,.75,.3,1.06)' },
    { offset: .3,  transform: 'translate(' + cx + 'px,' + cy + 'px) scale(1.04)', opacity: 1 },
    { offset: .42, transform: 'translate(' + cx + 'px,' + cy + 'px) scale(1)', opacity: 1, easing: 'ease-in-out' },
    { offset: .55, transform: 'translate(' + cx + 'px,' + (cy - 6) + 'px) scale(1.01)', opacity: 1, easing: 'ease-in-out' },
    { offset: .68, transform: 'translate(' + cx + 'px,' + cy + 'px) scale(1)', opacity: 1, easing: 'cubic-bezier(.5,.05,.72,.3)' },
    { offset: 1,   transform: 'translate(' + ex + 'px,' + ey + 'px) scale(.92)', opacity: 0 }
  ], { duration: total });
  if(g.flip) fxTrans(g.flip, [
    { offset: 0,   transform: 'rotateY(180deg)' },
    { offset: .28, transform: 'rotateY(180deg)' },
    { offset: .52, transform: 'rotateY(360deg)', easing: 'ease-in-out' }
  ], { duration: total });
  fxCleanup(g.g, total + 150);
}

/* ---------- 敌方弃牌揭示（HOOKS.onFoeDiscard 实现） ----------
   用户 2026-09-13 原话：「友方丢弃敌方手牌的动画缺失，我都不知道丢了对面什么卡。。。」
   引擎事实（勿改）：discardCard（严惩/莫洛托夫鸡尾酒/战争海军/狼群战术/U型潜艇/二式战…）与
   handCardToDeckTop（布莱切利庄园）在**受害方 = AI** 时同步调用 HOOKS.onFoeDiscard(card, reason)，
   reason = '弃牌' | '返回卡组顶'。这里做两层装饰（不改 S、同步返回不阻塞、pointer-events:none）：
   ① 字幕条 #foeDiscardTip（注入式 CSS，**不依赖 WAAPI**）：卡面缩略 + 「敌方弃掉「X」」/
      「敌方将「X」返回卡组顶」；同一批（450ms 内连续弃，如 U 型潜艇弃 2 张）合并显示、不互相顶掉；
   ② 飞行：卡背从敌方手牌行(#aiHandRow)抽出 → 中央翻面亮出卡面 → 停留 → 飞走
      （弃牌 = 右下外侧旋转淡出；返回卡组顶 = 飞回敌方手牌区缩小淡出）。
   特效层需要 WAAPI；没有时静默跳过飞行，字幕条仍把「丢了哪张」讲清楚。 */
let foeDiscardHostEl = null, foeDiscardTimer = null, foeDiscardLastAt = 0, foeDiscardBatch = [];
function foeDiscardHost(){
  if(foeDiscardHostEl) return foeDiscardHostEl;
  if(typeof document === 'undefined' || !document.createElement) return null;
  const table = document.getElementById('table');
  if(!table || typeof table.appendChild !== 'function') return null;
  const box = document.createElement('div');
  box.id = 'foeDiscardTip';
  table.appendChild(box);
  try{
    if(document.head && typeof document.head.appendChild === 'function'){
      const st = document.createElement('style');
      st.textContent =
        '#foeDiscardTip{position:fixed;left:50%;top:58%;transform:translate(-50%,0) scale(.94);z-index:56;pointer-events:none;opacity:0;' +
          'display:flex;flex-direction:column;align-items:center;gap:6px;transition:opacity .16s ease,transform .16s ease;}' +
        '#foeDiscardTip.show{opacity:1;transform:translate(-50%,0) scale(1);animation:fdPop .26s cubic-bezier(.2,1.5,.4,1);}' +
        '#foeDiscardTip .fdRow{display:flex;gap:8px;}' +
        '#foeDiscardTip .fdCard{width:96px;height:134px;border-radius:9px;overflow:hidden;border:2.5px solid #f0d58a;' +
          'background:linear-gradient(170deg,#f2e5c0,#d3bd8e 60%,#b89e6a);box-shadow:0 10px 26px rgba(0,0,0,.72),0 0 22px rgba(240,200,120,.4);}' +
        '#foeDiscardTip .fdCard img{width:100%;height:100%;object-fit:cover;display:block;}' +
        '#foeDiscardTip .fdText{padding:5px 12px;border-radius:8px;background:rgba(18,12,6,.88);border:1px solid rgba(240,213,138,.55);' +
          'color:#ffe9b0;font-size:14px;letter-spacing:1px;text-shadow:0 1px 3px #000;max-width:70vw;text-align:center;}' +
        '#foeDiscardTip .fdText b{color:#ff9d6b;}' +
        '@keyframes fdPop{0%{transform:translate(-50%,0) scale(.86);}60%{transform:translate(-50%,0) scale(1.03);}100%{transform:translate(-50%,0) scale(1);}}';
      document.head.appendChild(st);
    }
  }catch(e){ /* 样式注入失败不致命 */ }
  foeDiscardHostEl = box;
  return box;
}
function uiFoeDiscard(card, reason){
  try{
    if(!card) return;
    const back = (reason === '返回卡组顶');
    const now = Date.now();
    if(now - foeDiscardLastAt > 450) foeDiscardBatch = [];   // 新的一批弃牌：清掉上一批，避免误合并
    foeDiscardLastAt = now;
    foeDiscardBatch.push({ n: card.n || '?', img: card.img || '', back: back });
    if(foeDiscardBatch.length > 3) foeDiscardBatch = foeDiscardBatch.slice(-3);   // 极端情况（一次弃 3+）只留最后 3 张
    const host = foeDiscardHost();
    if(host){
      const thumbs = foeDiscardBatch.filter(it => it.img).map(it => '<div class="fdCard"><img alt="" src="' + imgUrl(it.img) + '"></div>').join('');
      const txt = foeDiscardBatch.map(it => (it.back ? '将「' + uiSafeText(it.n) + '」返回卡组顶' : '弃掉「' + uiSafeText(it.n) + '」')).join('、');
      host.innerHTML = (thumbs ? '<div class="fdRow">' + thumbs + '</div>' : '') + '<div class="fdText">敌方' + txt + '</div>';
      if(host.classList){
        host.classList.remove('show');
        void host.offsetWidth;                 // 触发一次重排：同一帧内连弃 2 张也能各自重播入场动画
        host.classList.add('show');
      }
      clearTimeout(foeDiscardTimer);
      foeDiscardTimer = setTimeout(function(){
        try{ if(foeDiscardHostEl && foeDiscardHostEl.classList) foeDiscardHostEl.classList.remove('show'); }catch(e){}
      }, 1750);
    }
    fxFoeDiscardJourney(card, back);
  }catch(e){ /* 装饰失败绝不能影响结算：钩子是同步调用 */ }
}
function fxFoeDiscardJourney(card, toDeckTop){
  const stage = fxGetStage();
  if(!stage) return;                            // 无 WAAPI / stub 环境：字幕条已给出信息，静默跳过飞行
  let vw = 0, vh = 0;
  try{
    vw = window.innerWidth || document.documentElement.clientWidth || 0;
    vh = window.innerHeight || document.documentElement.clientHeight || 0;
  }catch(e){}
  if(!vw || !vh) return;
  const w = 116, h = 162, total = 1250;
  const air = fxRectCenter(document.getElementById('aiHandRow')) || fxRectCenter(document.getElementById('aiHand'));
  const sx = air ? Math.round(air.x - w / 2) : Math.round(vw / 2 - w / 2);
  const sy = air ? Math.round(air.y - h / 2) : Math.round(vh * 0.12);
  const cx = Math.round(vw / 2 - w / 2);
  const cy = Math.round(vh * 0.42 - h / 2);
  // 终点：返回卡组顶 → 飞回敌方手牌行（塞回牌堆）；弃牌 → 右下外侧（弃牌区）旋转淡出
  const ex = toDeckTop ? sx : Math.round(vw * 0.72);
  const ey = toDeckTop ? sy : Math.round(vh * 0.86);
  const g = fxMakeGhost((card.img || ''), backUriOf('a'), card.n || '');
  if(!g) return;
  g.g.style.width = w + 'px';
  g.g.style.height = h + 'px';
  fxTrans(g.g, [
    { offset: 0,   transform: 'translate(' + sx + 'px,' + sy + 'px) scale(.9)', opacity: 0, easing: 'ease-out' },
    { offset: .1,  transform: 'translate(' + sx + 'px,' + (sy + 8) + 'px) scale(1)', opacity: 1, easing: 'cubic-bezier(.25,.75,.3,1.06)' },
    { offset: .34, transform: 'translate(' + cx + 'px,' + cy + 'px) scale(1.06)', opacity: 1 },
    { offset: .46, transform: 'translate(' + cx + 'px,' + cy + 'px) scale(1)', opacity: 1, easing: 'ease-in-out' },
    { offset: .68, transform: 'translate(' + cx + 'px,' + (cy - 6) + 'px) scale(1.01)', opacity: 1, easing: 'ease-in-out' },
    { offset: .8,  transform: 'translate(' + cx + 'px,' + cy + 'px) scale(1)', opacity: 1, easing: 'cubic-bezier(.5,.05,.72,.3)' },
    { offset: 1,   transform: 'translate(' + ex + 'px,' + ey + 'px) scale(.7) rotate(' + (toDeckTop ? -6 : 12) + 'deg)', opacity: 0 }
  ], { duration: total });
  if(g.flip) fxTrans(g.flip, [
    { offset: 0,   transform: 'rotateY(180deg)' },
    { offset: .2,  transform: 'rotateY(180deg)' },
    { offset: .44, transform: 'rotateY(360deg)', easing: 'ease-in-out' }
  ], { duration: total });
  fxCleanup(g.g, total + 150);
}

/* 敌方进手（抽牌/加入）通用动画：k 个敌国卡背从屏幕左侧(x≈-90)飞入
   #aiHand 行中央淡出；逐张错峰 120ms，不需要精确落位 */
function fxEnemyDrawIn(k){
  if(k > 6) k = 6;
  const stage = fxGetStage();
  if(!stage) return;
  const air = fxRectCenter(document.getElementById('aiHandRow')) || fxRectCenter(document.getElementById('aiHand'));
  if(!air) return;
  const w = 84, h = 120, bk = backUriOf('a');
  for(let j = 0; j < k; j++){
    setTimeout(() => {
      const g = fxMakeGhost('', bk, '');
      if(!g) return;
      g.g.style.width = w + 'px';
      g.g.style.height = h + 'px';
      const sx = -100 - j * 16, sy = air.y - h / 2 + j * 10;
      const tx = air.x - w / 2, ty = air.y - h / 2;
      fxTrans(g.g, [
        { offset: 0,   transform: 'translate(' + sx + 'px,' + sy + 'px) scale(.92)', opacity: 0, easing: 'ease-out' },
        { offset: .12, transform: 'translate(' + (sx + 20) + 'px,' + sy + 'px) scale(1)', opacity: 1, easing: 'cubic-bezier(.25,.7,.3,1.05)' },
        { offset: .82, transform: 'translate(' + tx + 'px,' + ty + 'px) scale(1.02)', opacity: 1, easing: 'ease-out' },
        { offset: .9,  transform: 'translate(' + (tx - 12) + 'px,' + (ty + 4) + 'px) scale(.98)', opacity: .9, easing: 'ease-in' },
        { offset: 1,   transform: 'translate(' + tx + 'px,' + ty + 'px) scale(1)', opacity: 0 }
      ], { duration: 780 });
      fxCleanup(g.g, 850);
    }, j * 120);
  }
}

/* 北北布次香菜 二阶段：牌堆获得的日机依次从牌桌中央翻面亮相
   → 飞入敌方手牌行(#aiHandRow) → 再向左移入敌方卡组（逐张错峰 150ms，总时长约 2.9s） */
function fxEnemyGrantToDeck(cards){
  const stage = fxGetStage();
  if(!stage || !cards || !cards.length) return;
  const air = fxRectCenter(document.getElementById('aiHandRow')) || fxRectCenter(document.getElementById('aiHand'));
  if(!air) return;
  let vw = 0, vh = 0;
  try{ vw = window.innerWidth || document.documentElement.clientWidth || 0; vh = window.innerHeight || document.documentElement.clientHeight || 0; }catch(e){}
  if(!vw || !vh) return;
  const w = 96, h = 134, bk = backUriOf('a');
  const cx = Math.round(vw / 2 - w / 2), cy = Math.round(vh * 0.42 - h / 2);
  const hx = Math.round(air.x - w / 2), hy = Math.round(air.y - h / 2);
  const dx = Math.round(Math.max(48, air.x - 360) - w / 2); // 敌方卡组：敌方手牌行左侧
  cards.slice(0, 9).forEach((card, j) => {
    setTimeout(() => {
      const g = fxMakeGhost(card.img || '', bk, card.n || '');
      if(!g) return;
      g.g.style.width = w + 'px';
      g.g.style.height = h + 'px';
      fxTrans(g.g, [
        { offset: 0,   transform: 'translate(' + cx + 'px,' + (cy + 26) + 'px) scale(.72)', opacity: 0, easing: 'ease-out' },
        { offset: .12, transform: 'translate(' + cx + 'px,' + cy + 'px) scale(1.02)', opacity: 1, easing: 'cubic-bezier(.2,.75,.28,1.06)' },
        { offset: .42, transform: 'translate(' + cx + 'px,' + cy + 'px) scale(1)', opacity: 1 },
        { offset: .62, transform: 'translate(' + hx + 'px,' + hy + 'px) scale(.94)', opacity: 1, easing: 'ease-in-out' },
        { offset: .76, transform: 'translate(' + hx + 'px,' + hy + 'px) scale(.94)', opacity: 1 },
        { offset: 1,   transform: 'translate(' + dx + 'px,' + hy + 'px) scale(.74)', opacity: 0, easing: 'ease-in' }
      ], { duration: 1500 });
      if(g.flip) fxTrans(g.flip, [
        { offset: 0,   transform: 'rotateY(180deg)' },
        { offset: .3,  transform: 'rotateY(180deg)' },
        { offset: .46, transform: 'rotateY(360deg)', easing: 'ease-in-out' }
      ], { duration: 1500 });
      fxCleanup(g.g, 1620);
    }, j * 150);
  });
}
/* Boss 二阶段启动：屏幕震动 + 红光一闪（无头/无动画环境静默跳过） */
function fxBossPhase2(){
  if(typeof document === 'undefined' || !document.getElementById) return;
  const tbl = document.getElementById('table');
  if(tbl && tbl.classList){
    tbl.classList.remove('bossShake');
    void tbl.offsetWidth;
    tbl.classList.add('bossShake');
    setTimeout(() => { if(tbl.classList) tbl.classList.remove('bossShake'); }, 1100);
  }
  try{
    if(!document.body || typeof document.body.appendChild !== 'function') return;
    const f = document.createElement('div');
    f.className = 'bossFlash';
    document.body.appendChild(f);
    setTimeout(() => { try{ if(f.parentNode) f.parentNode.removeChild(f); }catch(e){} }, 1300);
  }catch(e){}
}

/* 玩家抽牌（来自卡组，diff 确认）：Δk 张「卡背从 #deckPile 位置飞向 #hand 区域，
   途中翻面露出卡图(imgUrl(card.img)) 落位淡出」；逐张错峰 120ms */
function fxPlayerDrawIn(k, fromIdx){
  const stage = fxGetStage();
  if(!stage) return;
  const deckPile = document.getElementById('deckPile');
  let src = null;
  try{
    if(deckPile && typeof deckPile.querySelector === 'function'){
      src = fxRectCenter(deckPile.querySelector('.pcard')) || fxRectCenter(deckPile);
    }
  }catch(e){}
  if(!src) return;
  const handEl = document.getElementById('hand');
  const w = 92, h = 132, bk = backUriOf('p');
  for(let j = 0; j < k; j++){
    const idx = fromIdx + j;
    const card = (S.p.hand && S.p.hand[idx]) || null; // 开播前快照：动画期间手牌变化不影响卡图
    setTimeout(() => {
      if(!card) return;
      let dst = null;
      try{
        if(document.querySelector) dst = fxRectCenter(document.querySelector('#hand .card[data-i="' + idx + '"]'));
      }catch(e){ dst = null; }
      if(!dst) dst = fxRectCenter(handEl);
      if(!dst) return;
      const g = fxMakeGhost(card.img || '', bk, card.n || '');
      if(!g) return;
      g.g.style.width = w + 'px';
      g.g.style.height = h + 'px';
      const sx = src.x - w / 2, sy = src.y - h / 2;
      const tx = dst.x - w / 2, ty = dst.y - h / 2;
      const mx = ((sx + tx) / 2 - 8).toFixed(1), my = ((sy + ty) / 2 - 16).toFixed(1);
      fxTrans(g.g, [
        { offset: 0,   transform: 'translate(' + sx + 'px,' + sy + 'px) scale(.9)', opacity: 0, easing: 'ease-out' },
        { offset: .09, transform: 'translate(' + (sx + 6) + 'px,' + (sy - 4) + 'px) scale(.97)', opacity: 1, easing: 'cubic-bezier(.2,.75,.28,1.06)' },
        { offset: .55, transform: 'translate(' + mx + 'px,' + my + 'px) scale(1.03)', opacity: 1, easing: 'ease-in-out' },
        { offset: .9,  transform: 'translate(' + tx + 'px,' + ty + 'px) scale(1.05)', opacity: 1, easing: 'ease-out' },
        { offset: 1,   transform: 'translate(' + tx + 'px,' + ty + 'px) scale(1.06)', opacity: 0 }
      ], { duration: 680 });
      if(g.flip) fxTrans(g.flip, [
        { offset: 0,   transform: 'rotateY(180deg)' },
        { offset: .42, transform: 'rotateY(180deg)' },
        { offset: .58, transform: 'rotateY(270deg)', easing: 'ease-in-out' },
        { offset: .8,  transform: 'rotateY(360deg)' }
      ], { duration: 680 });
      fxCleanup(g.g, 750);
    }, j * 120);
  }
}

/* 爆牌通用核心：临时卡幽灵从 at(中心) 滑向场外并淡出（a 向左 / p 向右，约 0.62s）。
   有卡图用正面；无卡图用 CSS 卡背样式兜底；结束后自清理 */
function fxBurst(cardDef, side, at){
  const stage = fxGetStage();
  if(!stage) return;
  const def = cardDef || {};
  const w = 96, h = 134;
  let cx, cy;
  if(at && typeof at.x === 'number' && typeof at.y === 'number'){ cx = at.x; cy = at.y; }
  else {
    const anchor = (side === 'a') ? (document.getElementById('aiHandRow') || document.getElementById('aiHand')) : document.getElementById('hand');
    const r = fxRectCenter(anchor);
    if(!r) return;
    cx = r.x; cy = r.y;
  }
  const g = fxMakeGhost(def.img || '', '', def.n || '');
  if(!g) return;
  g.g.style.width = w + 'px';
  g.g.style.height = h + 'px';
  const dx = (side === 'a') ? -220 : 220;
  // 扩散闪环
  const ring = document.createElement('div');
  ring.className = 'fxRing';
  stage.appendChild(ring);
  const rs = 120;
  ring.style.width = rs + 'px';
  ring.style.height = rs + 'px';
  ring.style.left = (cx - rs / 2) + 'px';
  ring.style.top = (cy - rs / 2) + 'px';
  fxTrans(ring, [
    { transform: 'scale(.35)', opacity: .95 },
    { transform: 'scale(1.4)', opacity: 0 }
  ], { duration: 540 });
  fxCleanup(ring, 600);
  fxTrans(g.g, [
    { offset: 0, transform: 'translate(' + (cx - w / 2) + 'px,' + (cy - h / 2) + 'px) scale(1)', opacity: 1 },
    { offset: .3, transform: 'translate(' + (cx - w / 2 + dx * .15) + 'px,' + (cy - h / 2 - 8) + 'px) scale(1.05) rotate(' + (side === 'a' ? -5 : 5) + 'deg)', opacity: 1, easing: 'ease-out' },
    { offset: 1, transform: 'translate(' + (cx - w / 2 + dx) + 'px,' + (cy - h / 2 - 30) + 'px) scale(.88) rotate(' + (side === 'a' ? -14 : 14) + 'deg)', opacity: 0 }
  ], { duration: 620, easing: 'ease-in' });
  fxCleanup(g.g, 700);
}

/* 引擎满手爆牌钩子（HOOKS.onCardBurst 实现）：定位到被处理对象附近再爆 */
function uiCardBurst(cardDef, side){
  if(!cardDef) return;
  const def = cardDef.def ? cardDef.def : cardDef; // 兼容单位实例/纯卡面定义
  let at = null;
  // 棋盘单位：此刻 DOM 仍是结算前画面，找同名同侧单位作爆点；找不到回退到手牌/牌堆区
  if(typeof document !== 'undefined' && typeof document.querySelectorAll === 'function' && def.n){
    try{
      const units = document.querySelectorAll('#table [data-act="unit"]');
      for(let i = 0; i < units.length; i++){
        const el = units[i];
        if(!el || !el.classList) continue;
        const isEnemy = !!el.classList.contains('enemy');
        if(isEnemy !== (side === 'a')) continue;
        const t = (typeof el.getAttribute === 'function' && el.getAttribute('title')) || '';
        if(t.indexOf(def.n + '：') === 0){ at = fxRectCenter(el); if(at) break; }
      }
    }catch(e){ at = null; }
  }
  fxBurst(def, side, at);
}

/* 生产牌堆满手弃置爆牌（bindInput drawProd 分支直接调用）：卡图=生产、位置≈#prodPile */
function uiProdBurst(){
  const stage = fxGetStage();
  if(!stage) return;
  const pileEl = document.getElementById('prodPile');
  let at = null;
  try{
    if(pileEl && typeof pileEl.querySelector === 'function'){
      at = fxRectCenter(pileEl.querySelector('.pcard')) || fxRectCenter(pileEl);
    }
  }catch(e){}
  if(!at) return;
  fxBurst({ img: '卡牌/中立/生产.jpg', n: '生产' }, 'p', at);
}

/* 抽牌/进手 diff 检测（uiRender 末尾调用，纯装饰）：
   · 敌方手牌增长 Δk → 播 k 个卡背左侧飞入 #aiHand 行（fxSkipNextEnemyIn 时跳过）
   · 玩家手牌增长且 pDeck 减少、pProd 未动（卡组抽牌）→ 播 Δk 张飞行翻面；
     生产堆抽取与「加入手牌」(deck 不减) 一律不播
   · 对局重置（回合倒退/上局结束/手牌骤减）只重建基线不播 */
function fxDrawDiff(){
  if(!S || !S.p || !S.a) return;
  const aHand = S.a.hand ? S.a.hand.length : 0;
  const pHand = S.p.hand ? S.p.hand.length : 0;
  const pDeck = S.p.deck ? S.p.deck.length : 0;
  const pProd = S.p.prodDeck ? S.p.prodDeck.length : 0;
  const turn = S.turn | 0;
  const over = !!S.over;
  const inGame = turn > 0 && (S.phase === 'player' || S.phase === 'ai');
  if(!fxPrev){ fxPrev = { aHand, pHand, pDeck, pProd, turn, over, inGame }; return; } // 首帧建基线
  const pv = fxPrev;
  const fresh = (!pv.inGame && inGame) || (pv.over && !over) || (turn < pv.turn) || over;
  const crash = (pHand < pv.pHand - 2) || (aHand < pv.aHand - 2); // 手牌骤减=新局/清场
  if(fresh || crash){ fxPrev = { aHand, pHand, pDeck, pProd, turn, over, inGame }; fxClearStage(); return; }
  const dA = aHand - pv.aHand;
  const dP = pHand - pv.pHand;
  const deckDraw = (pDeck < pv.pDeck) && (pProd === pv.pProd);
  // 敌方揭示旅程防重：旅程已展示同一次进手 → 本帧跳过通用左侧飞入并清标志
  const suppressed = fxSkipNextEnemyIn;
  if(fxSkipNextEnemyIn){
    fxSkipAge++;
    if(dA > 0 || fxSkipAge >= 3){ fxSkipNextEnemyIn = false; fxSkipAge = 0; }
  }
  if(dA > 0 && !suppressed) fxEnemyDrawIn(dA);
  if(dP > 0 && deckDraw) fxPlayerDrawIn(dP, pv.pHand);
  fxPrev = { aHand, pHand, pDeck, pProd, turn, over, inGame };
}

/* ---------- 画面目标合法性（渲染辅助） ---------- */
function isTarget(u, row, col){
  const m = S.mode;
  if(!m) return false;
  if(m.type === 'deployPick') return deployPickValid(m, u);
  if(m.type === 'order' && m.card && m.card.target){
    return orderTargets(m.card, 'p').some(t => t.row===row && t.col===col);
  }
  if(m.type === 'attack'){
    return attackTargets(u.owner, m.row, m.col).some(t=>!t.hq && t.row===row && t.col===col);
  }
  return false;
}
function slotPlaceable(row,col){
  const m = S.mode;
  return !!(m && m.type==='place' && row===backRowOf('p') && S.phase==='player' && !unitAt(row,col));
}
/* 推进落点：选中的己方底线单位可推进 → 前线空槽高亮（落地当回合只有闪击能移动） */
function slotMovable(row,col){
  const m = S.mode;
  if(!m || m.type !== 'attack') return false;
  if(row !== 1 || unitAt(row,col)) return false;
  const u = unitAt(m.row, m.col);
  if(!u || u.owner !== 'p' || m.row !== backRowOf('p')) return false;
  if(u.movedThisTurn) return false;
  if(u.summonedThisTurn && !hasSig(u,'blitz')) return false;
  const isMoveFlex = u.def.t==='tank' || hasFx(u,'moveNattack');
  if(!isMoveFlex && u.attackedN) return false;
  return true;
}

/* ---------- 选卡组 / 重开（选卡组面板渲染在 main.js：renderNationPicker） ----------
   v2：组卡自定义(PENDING.customDeck)在此消费；AI 难度经 setAI_DIFFICULTY(ai.js)切换。
   deckP：null=强制初始默认卡组；undefined=沿用激活槽位卡组（组卡器开战）；数组=指定自定义卡组 */
function pickNation(key, deckP, backId, hqPath){
  if(!AC){ try{ AC = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} }
  if(AC && AC.state === 'suspended' && typeof AC.resume === 'function'){ try{ AC.resume(); }catch(e){} } // 手势内解锁（移动端）
  if(!_sfxWarmed){ _sfxWarmed = true; SFX_WARM.forEach(sfxDecode); }
  hideChoiceBox(); // 新对局前清空抉择面板（防跨局残留）
  S.pNation = key;
  const bossKind = PENDING.boss;
  PENDING.boss = false;
  const pDeck = (deckP === null) ? null : (deckP || activePlayerDeck(key));
  if(bossKind){                                     // Boss 挑战：梦之泪伤 / 阿尔卑斯要塞 / 北北布次香菜
    S.aNation = bossKind === 'meme' ? 'jp' : 'us';  // 北北布次香菜：日美合流（紫电主场）
    setGAME_RULES_OFF();
    setAI_DIFFICULTY('marshal');
    setDeckOverride({ p: pDeck, a: buildBossDeck(bossKind) });
    setBossKind(bossKind); // resetGameState 会在 startGame 内读取
  } else {                                         // 自由对战
    setGAME_RULES_OFF();
    setAI_DIFFICULTY(SAVE.settings.lastDifficulty || 'recruit');
    const others = Object.keys(NATIONS).filter(k=>k!==key && !NATIONS[k].allyOnly); // 盟国不能当敌方主国
    S.aNation = others[Math.floor(Math.random()*others.length)];
    setDeckOverride({ p: pDeck, a: null });
  }
  sfx('card');
  // 卡背装配：己方=卡组装备（缺省→本国基础）；敌方=AI 按难度（实力）装配
  S.backOf = { p: backId || null, a: aiBackId(S.aNation, AI_DIFFICULTY) };
  _backCache = { p: null, a: null };
  // 总部场景：卡组选定（默认=本国经典图）；桌面：友方总部对应桌布（无对应则随机初始桌面）
  S.hqOf = { p: hqPath || null, a: null };
  applyDesk(true);
  $('overlay').classList.add('hidden'); // 覆盖层隐藏（引擎零 DOM）
  startGame();
  bgmLockForMatch(null);   // 开局锁定本局曲目：全库随机一首（Boss 战也不再固定曲目 —— 用户 2026-09-17）
  bgmStart();          // 按锁定的曲目换 BGM（没配曲/曲子没入库则继续放默认曲）
}
/* 当前出战卡组 = 激活槽位方案(契约 §3.3:自由对战与战役均用当前卡组;国家不匹配回退原版)。v2 模块覆盖。 */
function activePlayerDeck(key){ return null; }
function cancelMode(){ S.mode = null; render(); }

/* ---------- 背景音乐（国家曲 + 场景曲 + 默认曲回退；随音效开关） ----------
   BGM_TRACKS[国家键] / BGM_SCENES['@场景'] = 曲目文件名**数组**（相对 音乐/背景音乐/）；
   一个国家写多首就按局轮换（同一国连打两局不会重复），文件没入库的自动跳过；
   该键一首可用都没有 → 回退 BGM_DEFAULT_FILE（不报错、不静音）。
   加曲子两步：①mp3 丢进 音乐/背景音乐/（build.mjs 递归内嵌进 AUDIO_MAP）；②在表里补一行。 */
const BGM_DIR = '音乐/背景音乐/';
const BGM_DEFAULT_FILE = '老牧师.mp3';   // 通用兜底：国家没配曲/曲子没入库时放它
const BGM_TRACKS = {
  us: ['DAWALI达瓦里-全网同名 - In The Mood 兴致勃勃.mp3', 'DAWALI达瓦里-全网同名 - Miller’s mood 米勒的心情.mp3', 'DAWALI达瓦里-全网同名 - Moonlight Serenade月光小夜曲.mp3', 'DAWALI达瓦里-全网同名 - Star Dust 星尘.mp3', 'DAWALI达瓦里-全网同名 - Tribute to Miller - Eric Swann.mp3', 'DAWALI达瓦里-全网同名 - 蓝色主旋律 Blue Theme.mp3', 'Edward Holmes - Night Blue.mp3', 'Robert Busby - Sweet And Slow.mp3'],
  gb: ['DAWALI达瓦里-全网同名 - It\'s A Long Way To Tipperary 漫漫长路到蒂珀雷里.mp3', 'DAWALI达瓦里-全网同名 - Londonderry Air 伦敦德里小调.mp3', 'DAWALI达瓦里-全网同名 - 后会有期 We\'ll meet again.mp3', 'DAWALI达瓦里-全网同名 - 邦德街反弹 Bond Street Bounce.mp3'],
  jp: ['DAWALI达瓦里-全网同名 - oiwake 追分.mp3', 'DAWALI达瓦里-全网同名 - 船夫很可爱 船頭可愛いや.mp3', 'DAWALI达瓦里-全网同名 - 荒镇的月 荒城の月.mp3', 'DAWALI达瓦里-全网同名 - 鸭绿江节 鴨緑江祭り.mp3', '山田リョウの依存 - 【杉井幸一】大漁節Tairyo-Bushi.mp3'],
  su: ['DAWALI达瓦里-全网同名 - Калинка 卡林卡 雪球花.mp3', 'DAWALI达瓦里-全网同名 - 伏尔加河纤夫曲Glenn Miller jazz版.mp3', 'DAWALI达瓦里-全网同名 - 伏尔加船夫 Эй, ухнем!.mp3', 'DAWALI达瓦里-全网同名 - 在满洲的山岗上 На сопках Маньчжурии.mp3'],
  de: ['DAWALI达瓦里-全网同名 - Ich liebe die Sonne den Mond und die Sterne 我爱日月与星辰.mp3', 'DAWALI达瓦里-全网同名 - Oh Tannenbaum 哦，圣诞树.mp3', 'DAWALI达瓦里-全网同名 - Wenn ich die blonde Inge abends nach Hause br 带金发姑娘回家.mp3', 'Lale Andersen - Lili Marleen.mp3', '松风葛衣轻 - 血色的玫瑰（Blutrote Rosen）.mp3'],
  it: ['DAWALI达瓦里-全网同名 - O sole mio 我的太阳.mp3', 'DAWALI达瓦里-全网同名 - Santa Lucia 桑塔露琪亚.mp3', 'DAWALI达瓦里-全网同名 - Tarantella Napoletana 那不勒斯的塔兰泰拉舞曲.mp3', 'DAWALI达瓦里-全网同名 - Tesoro mio 我亲爱的宝贝.mp3'],
  pl: ['DAWALI达瓦里-全网同名 - 我的步枪 Mój karabin.mp3'],
};
/* 场景槽（键带 @，与 NATIONS 的国家键不会撞）：
   '@menu'  = 主菜单轮换；'@extra' = **不绑定场景**的曲子（只参与全库随机 / 设置里选曲）。
   用户 2026-09-17：征程之路与 Boss 挑战**不再固定曲目，全部随机** ——
   原来挂在 '@run' / '@boss' 上的两首改挂 '@extra'，这样它们仍在随机池里，但不再被场景钉死。 */
const BGM_SCENES = {
  '@menu': ['SadSvit - Море.mp3', '郑浩Z-Hao,冰洁 - 琵琶曲 (DJ筱轩版).mp3'],
  '@extra': ['Fall Out Boy - Immortals.mp3', 'Sean Household - The Warrior Song.mp3'],
};
let bgmAudio = null, bgmRel = null;   // bgmRel = 当前音源（同一首不打断，换曲才换源）
const BGM_VOL = 0.3;      // 背景音乐基准音量（压低到音效之下，保证单位语音听得清）
const BGM_DUCK = 0.1;     // 音效播放时背景音乐闪避到的音量
let _bgmDuckT = null;
/* 曲目解析：国家键 / '@场景' → 实际音源路径（缺配置 / 缺文件一律回退默认曲） */
function bgmHasAsset(rel){
  try{ return !!(typeof AUDIO_MAP !== 'undefined' && AUDIO_MAP && AUDIO_MAP[rel]); }catch(e){ return false; }
}
function bgmHasFile(file){ return !!(file && bgmHasAsset(BGM_DIR + file)); }
function bgmListOf(key){ return (key && (BGM_TRACKS[key] || BGM_SCENES[key])) || null; }
/* 可用曲目：支持「主国+盟国」合池键（如 'de+pl'）——波兰/意大利等只能当盟国，
   不合成播放列表的话它们的曲子永远轮不到播 */
function bgmAvailOf(key){
  if(!key) return [];
  if(key === '@all') return bgmAllFiles();          // 全部曲子（设置里换歌时的兜底曲单）
  if(String(key).indexOf('+') > 0){
    const out = [];
    String(key).split('+').forEach(k => (bgmListOf(k) || []).forEach(f => { if(bgmHasFile(f) && out.indexOf(f) < 0) out.push(f); }));
    return out;
  }
  return (bgmListOf(key) || []).filter(bgmHasFile);
}
function bgmHasTracks(key){ return bgmAvailOf(key).length > 0; }
/* 轮换：每个键各记一个下标，advance=true 时才前进（同一国连打两局换一首；不落盘） */
const _bgmRot = Object.create(null);
function bgmFileOf(key, advance){
  const avail = bgmAvailOf(key);
  if(!avail.length) return BGM_DEFAULT_FILE;
  const i = (_bgmRot[key] || 0) % avail.length;
  if(advance) _bgmRot[key] = (i + 1) % avail.length;
  return avail[i];
}
function bgmRotate(key){ if(bgmHasTracks(key)) bgmFileOf(key, true); }
/* 纯查询（不轮换）：国家键 → 路径；key 为空 = 主菜单当前那首 */
function bgmPathOf(key){
  if(!key) return BGM_DIR + bgmFileOf('@menu', false);
  return BGM_DIR + bgmFileOf(key, false);
}
/* 盟国兜底：主国没配曲时，用卡组里带来的盟国牌找一首——波兰等盟国只能作为盟国出战，
   主国永远是别国，没有这一条它们的曲子永远轮不到播 */
function bgmAllyKey(main){
  try{
    /* 开局那一刻整副牌还没动过：抽牌堆 + 起手手牌合起来才是完整卡组 */
    const piles = (typeof S !== 'undefined' && S && S.p) ? [S.p.deck, S.p.hand] : [];
    for(const pile of piles) for(const cd of (pile || [])){
      const k = cd && cd.nation;
      if(k && k !== main && bgmHasTracks(k)) return k;
    }
  }catch(e){}
  return null;
}
/* 本局取曲：开局锁一次（局中牌会移动，现算会在最后一波兰牌离手时突然换曲）。
   BGM_NATION_MODE=false（用户 2026-09-16：先不限定国家，所有曲子随机放，国家归属以后补）：
   普通对局 = 从整个曲库随机一首；**Boss 挑战与征程之路也不再固定曲目，同样全库随机**
   （用户 2026-09-17；原来 '@boss'/'@run' 两个场景槽已取消，那两首曲子挪到不绑定场景的 '@extra'）。
   以后国家表补好了，把 BGM_NATION_MODE 改成 true 即按 主国 → 盟国 限定曲单（表与逻辑都留着）。 */
const BGM_NATION_MODE = false;
/* 随机挑一首：pool 省略 = 整个曲库；exclude = 尽量避开的那首（不连放同一首） */
function bgmRandomFile(exclude, pool){
  const all = (pool && pool.length) ? pool : bgmAllFiles();
  if(!all.length) return BGM_DEFAULT_FILE;
  if(all.length === 1) return all[0];
  let f = exclude, n = 0;
  while(f === exclude && n++ < 40) f = all[Math.floor(Math.random() * all.length)];
  return f;
}
let bgmKeyLocked = null, bgmFileLocked = null;
function bgmLockForMatch(scene, rotate){
  const prev = bgmFileLocked;
  const adv = rotate !== false;
  bgmKeyLocked = null; bgmFileLocked = null;
  try{
    const scenePool = (scene != null) ? bgmAvailOf(scene) : null;
    if(scenePool && scenePool.length){               // 场景槽：在场景自己的曲单里随机（单首则固定）
      bgmKeyLocked = scene;
      bgmFileLocked = adv ? bgmRandomFile(prev, scenePool)
                          : (scenePool.indexOf(prev) >= 0 ? prev : scenePool[0]);
      return bgmFileLocked;
    }
    if(BGM_NATION_MODE){
      const main = (typeof S !== 'undefined' && S && S.pNation) || null;
      const ally = main ? bgmAllyKey(main) : null;
      bgmKeyLocked = (main && ally) ? (main + '+' + ally) : main;   // 带盟国牌 = 主国+盟国 合池
      bgmFileLocked = bgmFileOf(bgmKeyLocked, adv);
    } else {
      bgmKeyLocked = '@all';
      bgmFileLocked = adv ? bgmRandomFile(prev) : (prev || bgmRandomFile(null));
    }
  }catch(e){ bgmKeyLocked = null; bgmFileLocked = prev; }
  return bgmFileLocked;
}
/* 本局该放的音源：锁定过就用锁定那首，没锁定（主菜单）在菜单曲单里随机挑一首并记住 */
function bgmCurrentPath(){
  if(!bgmFileLocked) bgmFileLocked = bgmRandomFile(null, bgmAvailOf('@menu'));
  return BGM_DIR + bgmFileLocked;
}
function bgmNationKey(){ return bgmKeyLocked; }
/* 回主菜单：解除本局锁定，在菜单曲单里随机换一首（否则每次点击都会把对局曲目又换回来） */
function bgmBackToMenu(){ bgmKeyLocked = '@menu'; bgmFileLocked = bgmRandomFile(bgmFileLocked, bgmAvailOf('@menu')); bgmStart(); }
/* ---------- 设置面板里的「换歌」 ---------- */
/* 全部可用曲子（各国 + 场景，去重）——本局曲单只有一首时（Boss/征程）改在这里翻 */
function bgmAllFiles(){
  const out = [];
  const push = list => (list || []).forEach(f => { if(bgmHasFile(f) && out.indexOf(f) < 0) out.push(f); });
  Object.keys(BGM_TRACKS).forEach(k => push(BGM_TRACKS[k]));
  Object.keys(BGM_SCENES).forEach(k => push(BGM_SCENES[k]));
  return out;
}
function bgmPoolName(key){
  if(!key || key === '@menu') return '主菜单';
  if(key === '@extra') return '其他曲子（不绑定场景）';
  if(key === '@all')  return '全部曲子';
  if(key === '@pick') return '自选曲目';
  return String(key).split('+').map(k => (typeof NATIONS !== 'undefined' && NATIONS[k] && NATIONS[k].name) || k).join(' + ');
}
function bgmNowFile(){ return bgmFileLocked || bgmFileOf(bgmKeyLocked || '@menu', false); }
/* 曲名显示用短名：去扩展名 + 去搬运号前缀（「DAWALI达瓦里-全网同名 - 」这类） */
function bgmShortName(file){
  return String(file || '').replace(/\.(mp3|ogg|wav|m4a)$/i, '').replace(/^DAWALI达瓦里-全网同名 - /, '');
}
/* 给设置面板看的当前曲目文案：随机模式 = 「随机播放 · 曲名（曲库 N 首）」，场景 = 「场景名 · 曲名」 */
function bgmNowText(){
  const key = bgmKeyLocked || '@all';
  const file = bgmNowFile();
  const n = bgmAvailOf(key).length;
  const name = bgmShortName(file);
  if(key === '@pick') return '自选 · ' + name;
  if(key === '@all') return '随机播放 · ' + name + '（曲库 ' + n + ' 首）';
  return bgmPoolName(key) + ' · ' + name + (n > 1 ? '（' + n + ' 首随机）' : '');
}
/* 换一首：从整个曲库里随机挑一首（不连放同一首）；场景槽也一并退出 */
function bgmNext(){
  bgmKeyLocked = '@all';
  bgmFileLocked = bgmRandomFile(bgmFileLocked || bgmNowFile());
  bgmStart();          // 音源变了就会换曲；同一首则什么都不做（曲库只有一首时）
  return bgmNowText();
}
/* ---------- 自选换歌（设置面板的下拉）：直接点名放哪一首 ---------- */
/* 曲库清单（去重，带归属池键，供下拉分组） */
function bgmAllEntries(){
  const out = [];
  const push = (key, list) => (list || []).forEach(f => {
    if(bgmHasFile(f) && !out.some(e => e.file === f)) out.push({ file:f, key:key });
  });
  Object.keys(BGM_TRACKS).forEach(k => push(k, BGM_TRACKS[k]));
  Object.keys(BGM_SCENES).forEach(k => push(k, BGM_SCENES[k]));
  return out;
}
/* 点名播放：不在曲库里的忽略；选中后标记为「自选」（下一局/回菜单会由场景逻辑接管） */
function bgmPickFile(file){
  if(!bgmHasFile(file)) return false;
  bgmKeyLocked = '@pick';
  bgmFileLocked = file;
  bgmStart();
  return true;
}
/* 音效闪避（sidechain）：有音效播放时把背景音乐压低，1.5s 后回到基准——
   否则 AI 回合连续部署/推进的音效会被 0.45 的背景音乐盖掉（用户反馈「听不到敌方音效」） */
function bgmDuck(ms){
  if(!bgmAudio) return;
  try{ bgmAudio.volume = bgmDuckVol(); }catch(e){ return; }
  if(_bgmDuckT) clearTimeout(_bgmDuckT);
  _bgmDuckT = setTimeout(()=>{ _bgmDuckT = null; try{ if(bgmAudio && (!mkSettings || mkSettings().sound)) bgmAudio.volume = bgmBaseVol(); }catch(e){} }, ms || 1500);
}
/* 起播/换曲：key 省略 = 放本局锁定的曲子（没锁定 = 主菜单当前曲）；key=null = 主菜单；
   同一首直接返回（点击处理器每次点击都会调它），只有换曲才换源，并保留原播放状态与音量 */
function bgmStart(key){
  if(typeof Audio === 'undefined') return; // 无头沙箱保护
  const rel = (key === undefined) ? bgmCurrentPath() : bgmPathOf(key);
  if(bgmAudio && bgmRel === rel) return;
  const wasPlaying = !!(bgmAudio && !bgmAudio.paused);
  try{
    if(bgmAudio){ try{ bgmAudio.pause(); }catch(e){} }
    bgmAudio = new Audio(audioUrl(rel));
    bgmAudio.loop = true;
    bgmAudio.volume = bgmBaseVol();
    bgmRel = rel;
    const sndOn = (typeof mkSettings === 'function') ? !!mkSettings().sound : true;
    if(wasPlaying && sndOn) bgmAudio.play().catch(()=>{});
  }catch(e){ bgmAudio = null; bgmRel = null; }
}
function bgmResume(){
  if(!bgmAudio) return;
  if(mkSettings().sound) bgmAudio.play().catch(()=>{}); // 需要用户手势后浏览器才允许播放
  else bgmAudio.pause();
}
/* ---------- 音量（局内可调）：SAVE.settings.bgmVol / sfxVol（0~1，缺省 1=原音量，不改变老玩家听感） ----------
   音效音量作用于 sfxPlayEl 的最终音量（不改 sfxVolume 的叠音调压）；背景音乐作用于基准与闪避两处音量，
   拖动滑杆时若正在闪避（bgmDuck 计时中）只更新「回弹目标」，否则立刻落到 bgmAudio.volume。 */
function sfxVol(){
  try{ const v = (typeof mkSettings === 'function') ? mkSettings().sfxVol : undefined; return (v == null) ? 1 : Math.max(0, Math.min(1, +v)); }catch(e){ return 1; }
}
function bgmVol(){
  try{ const v = (typeof mkSettings === 'function') ? mkSettings().bgmVol : undefined; return (v == null) ? 1 : Math.max(0, Math.min(1, +v)); }catch(e){ return 1; }
}
function bgmBaseVol(){ return Math.max(0, Math.min(1, BGM_VOL * bgmVol())); }   // 基准音量 × 用户音量
function bgmDuckVol(){ return Math.max(0, Math.min(1, BGM_DUCK * bgmVol())); }  // 闪避音量 × 用户音量
function bgmApply(){
  if(!bgmAudio) return;
  try{ bgmAudio.volume = _bgmDuckT ? bgmDuckVol() : bgmBaseVol(); }catch(e){}
}
function setBgmVol(v){ SAVE.settings.bgmVol = Math.max(0, Math.min(1, +v)); bgmApply(); }
function setSfxVol(v){ SAVE.settings.sfxVol = Math.max(0, Math.min(1, +v)); }

/* ---------- 局内「设 置」按钮（#topbar 里 #helpBtn 右边；用户 2026-09-13：原「音 量」按钮直接换成设置） ---------- */
let setBtnEl = null, setPanelEl = null;
function topbarHost(doc){
  try{ return doc.getElementById('topbar') || (doc.querySelector ? doc.querySelector('#topbar') : null); }catch(e){ return null; }
}
/* 局内入口：开设置面板（v2ui.openSettings：音效开关/背景音乐/音效音量/动画速度/AI 难度/存档）；
   面板不可用时退到自带的迷你浮层（只含音量两条滑杆） */
function openSettingsEntry(){
  if(typeof openSettings === 'function'){ openSettings(); return; }
  const p = ensureSetPanel();
  if(!p) return;
  bindVolSliders(p);
  p.style.display = 'block';
}
function ensureSetBtn(){
  if(setBtnEl || typeof document === 'undefined' || typeof document.getElementById !== 'function') return setBtnEl;
  const bar = topbarHost(document);
  if(!bar || typeof document.createElement !== 'function') return null;
  let b = null;
  try{ b = document.getElementById('setBtn') || (document.querySelector ? document.querySelector('#setBtn') : null); }catch(e){ b = null; }
  if(!b){
    b = document.createElement('button');
    b.id = 'setBtn';
    b.type = 'button';
    b.textContent = '设 置';
    b.style.cssText = 'margin-left:6px;cursor:pointer;pointer-events:auto;';   // 不抢焦点、不拦棋盘（#topbar 本身不接事件）
    if(typeof b.setAttribute === 'function') b.setAttribute('aria-label', '设置');
  }
  if(!b.textContent) b.textContent = '设 置';
  b.title = '设置（音乐/音效音量 · 动画速度 · AI 难度）';
  try{ b.onclick = e => { if(e && e.preventDefault) e.preventDefault(); openSettingsEntry(); return false; }; }catch(e){}
  // 放在 #helpBtn 旁边（右侧）；找不到 #helpBtn 就追加到 #topbar 末尾；重复调用不会重复插入
  try{
    if(b.parentNode === bar) return (setBtnEl = b);
    const help = (document.getElementById && document.getElementById('helpBtn')) || null;
    if(help && help.parentNode === bar && typeof bar.insertBefore === 'function') bar.insertBefore(b, help.nextSibling);
    else if(typeof bar.appendChild === 'function') bar.appendChild(b);
  }catch(e){ /* 注入失败不影响对局 */ }
  return (setBtnEl = b);
}
/* 迷你设置浮层（openSettings 不可用时的兜底；样式与总部面板/弃牌字幕条同风格，一条注入式 CSS） */
function ensureSetPanel(){
  if(setPanelEl) return setPanelEl;
  if(typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  let p = null;
  try{ p = document.getElementById('setPanel'); }catch(e){ p = null; }
  if(!p) p = document.createElement('div');
  p.id = 'setPanel';
  p.style.display = 'none';
  p.innerHTML =
    '<div class="vpTitle">设 置</div>' +
    volRowHTML('bgmVol', '🎵 背景音乐', 'bgmVolVal') +
    volRowHTML('sfxVol', '🔊 音效', 'sfxVolVal') +
    '<div class="vpFoot"><button type="button" data-volclose="1">关 闭</button></div>';
  if(typeof p.setAttribute === 'function') p.setAttribute('data-setpanel', '1');
  if(typeof document.head !== 'undefined' && document.head && typeof document.head.appendChild === 'function' &&
     typeof document.getElementById === 'function' && !document.getElementById('setPanelCss')){
    const st = document.createElement('style'); st.id = 'setPanelCss';
    st.textContent = '#setPanel{position:fixed;right:12px;top:46px;z-index:60;min-width:214px;padding:8px 10px 10px;' +
      'font:13px/1.5 inherit;color:#f0dfae;background:rgba(24,16,8,.95);border:1px solid #6a4a20;border-radius:8px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.5)}' +
      '#setPanel .vpTitle{text-align:center;color:#f0d58a;letter-spacing:5px;margin-bottom:6px}' +
      '#setPanel .vpRow{display:flex;align-items:center;gap:8px;margin:5px 0}' +
      '#setPanel .vpRow .vpLab{flex:0 0 88px;white-space:nowrap}' +
      '#setPanel input[type=range]{flex:1;min-width:74px}' +
      '#setPanel .vpVal{width:38px;text-align:right;color:#c9a45a}' +
      '#setPanel .vpFoot{text-align:center;margin-top:6px}' +
      '#setPanel button{cursor:pointer}';
    try{ document.head.appendChild(st); }catch(e){}
  }
  const host = (typeof document.body !== 'undefined' && document.body && typeof document.body.appendChild === 'function')
    ? document.body : (document.documentElement || null);
  try{ if(host) host.appendChild(p); }catch(e){ return null; }
  try{
    p.addEventListener('click', e => {
      const t = e && e.target;
      if(t && t.getAttribute && t.getAttribute('data-volclose')) p.style.display = 'none';
    });
  }catch(e){}
  return (setPanelEl = p);
}
function volRowHTML(key, label, valId){
  return '<div class="vpRow" data-volrow="' + key + '"><span class="vpLab">' + label + '</span>' +
    '<input type="range" min="0" max="100" step="5" data-vol="' + key + '" id="' + key + 'Slider" value="100">' +
    '<span class="vpVal" id="' + valId + '">100%</span></div>';
}
/* 滑杆装配（设置面板与迷你浮层共用）：实时生效 + 显示百分比 + 落盘 —— #volPanel 与 #modalPanel 里都能用 */
function bindVolSliders(root){
  if(!root || typeof root.querySelectorAll !== 'function') return;
  const map = { bgmVol: setBgmVol, sfxVol: setSfxVol };
  let ins = [];
  try{ ins = Array.prototype.slice.call(root.querySelectorAll('[data-vol]')); }catch(e){ ins = []; }
  ins.forEach(inp => {
    const key = inp && inp.dataset ? inp.dataset.vol : '';
    const set = map[key];
    if(!set) return;
    const pct = Math.round(((key === 'bgmVol') ? bgmVol() : sfxVol()) * 100);
    inp.value = String(pct);
    const valEl = inp.parentNode && inp.parentNode.querySelector ? inp.parentNode.querySelector('.vpVal') : null;
    if(valEl) valEl.textContent = pct + '%';
    inp.oninput = inp.onchange = e => {
      const v = Math.max(0, Math.min(100, +(e && e.target ? e.target.value : inp.value) || 0));
      set(v / 100);
      if(valEl) valEl.textContent = Math.round(v) + '%';
      if(typeof saveV2Save === 'function') saveV2Save();   // 实时落盘（拖动过程中也写，掉电不丢）
      return true;
    };
  });
}

/* ---------- 输入装配 ---------- */
function bindInput(){
  ensureSetBtn();   // 局内设置入口：顶栏「设 置」按钮（挨着 #helpBtn；模板里已有按钮，这里只兜底+挂事件）
  document.addEventListener('click', e => {
    if(_longFired){ _longFired = false; return; } // 长按查看卡牌后吞掉紧随手牌的点击
    bgmStart(); bgmResume(); // 首次点击后启动背景音乐（随音效开关）
    sfxUnlock(); // 首个手势里解锁音频（WebAudio resume）：之后 AI 回合的音效在手机上也放得出
    // 必须先摸牌才能行动（左右牌堆触碰放行）；投降按钮随时可点；换牌窗口期间只能换牌
    if((S.drawPending || S.mulliganPending) && S.phase==='player' && !S.over &&
       !e.target.closest('.pile') && !e.target.closest('#surrenderBtn') && !e.target.closest('#mullBox')){
      toast(S.mulliganPending ? '请先完成换牌' : '请先摸牌再行动'); return;
    }
    // 触碰牌堆发牌（替换原摸牌按钮）：左=生产牌堆 右=卡组牌堆（牌堆内容未知，背面是国家卡背）
    const pileEl = e.target.closest('[data-act="drawProd"],[data-act="drawDeck"]');
    if(pileEl && S.phase==='player' && !S.over){
      if(S.mulliganPending){ toast('请先完成换牌'); return; }
      if(!S.drawPending) return; // 未到摸牌时机（暗态牌堆不可发）
      if(pileEl.dataset.act === 'drawProd'){
        if(!S.p.prodDeck.length){ toast('生产牌堆已空'); return; }
        if(S.p.hand.length >= MAX_HAND){ toast('手牌已满（9张），生产牌被弃置'); S.p.prodDeck.pop(); uiProdBurst(); } // [v2 特效] 满手弃置：生产卡爆牌动画
        else { S.p.hand.push(S.p.prodDeck.pop()); logMsg('你摸了一张生产牌。'); }
        sfx('draw'); hideDrawChoice();
      } else {
        drawCards(S.p, 1, false, true); // 每回合摸 1 张（Boss 挑战不再额外摸牌）
        // 先完成玩家摸牌，再结算 216团 等摸牌后特效（hideDrawChoice 触发）
        hideDrawChoice();
      }
      return;
    }
    // 换牌：点击卡牌多选/取消选择
    if(S.mulliganPending && S.phase==='player' && !S.over && e.target.closest('[data-act="mullPick"]')){
      const i = +e.target.closest('[data-act="mullPick"]').dataset.i;
      if(mullSel.has(i)) mullSel.delete(i); else mullSel.add(i);
      renderMulligan(); sfx('card');
      return;
    }
    // 换牌：确认（可 0 张 = 全部保留）
    if(S.mulliganPending && S.phase==='player' && !S.over && e.target.closest('[data-act="mullGo"]')){
      const cards = S.p.hand.filter(c => !(c.kind === 'order' && c.eff === 'produce'));
      const picked = [...mullSel].map(i => cards[i]).filter(Boolean);
      mullSel = new Set();
      doMulligan(picked);
      render();
      return;
    }
    // 抉择未定（玩家）：点选抉择卡=结算；点击其他处=取消使用——卡牌返回手牌、不消耗
    if(S.pendingChoice && S.pendingChoice.side === 'p' && !S.over && !e.target.closest('[data-act="choicePick"]')){
      cancelChoice(); hideChoiceBox(); return;
    }
    // 选卡组：初始卡组 / 自定义卡组（原选国页）
    const dpk = e.target.closest('[data-act="deckPick"]');
    if(dpk){
      if(dpk.dataset.kind === 'slot'){
        const slot = +dpk.dataset.slot;
        const d = (SAVE.deckSlots || [])[slot];
        if(!d || !d.cards || !d.cards.length){ toast('该卡组为空'); return; }
        dispatchDeckPick({ kind:'slot', slot, key:d.nation, deckP: buildDeckCustom(d.nation, d.ally || null, d.cards), back: d.back || null, hq: d.hq || null });
      } else dispatchDeckPick({ kind:'init', key: dpk.dataset.key, deckP: null });
      return;
    }
    const nat = e.target.closest('[data-act="nation"]');
    if(nat){ pickNation(nat.dataset.key, null); return; }
    const t = e.target.closest('[data-act]');
    if(!t){ cancelMode(); return; }
    const act = t.dataset.act;
    if(act === 'choicePick'){ resolveChoice(t.dataset.id); hideChoiceBox(); return; }
    // 总部面板（用户 2026-09-13）：点信息条打开/收起；点 ✕ 关闭。
    // 有进行中的点选/待选时保持老行为（信息条过去属于「点空白处」→ 取消当前模式），不做旁路。
    if(act === 'hqClose'){ closeHqPanel(); return; }
    if(act === 'hqinfo'){
      if(S.mode || S.discardPick || S.gordonPick){ cancelMode(); return; }
      toggleHqPanel(t.dataset.side === 'a' ? 'a' : 'p'); return;
    }
    if(act === 'hq'){
      const m = S.mode;
      // 空中闪击/俾斯麦号（文档：对1个总部造成伤害）：指向己方或敌方总部均可
      if(m && m.type==='orderHq' && m.card && (t.dataset.side === 'a' || t.dataset.side === 'p') && S.phase === 'player' && !S.over){
        const card = m.card;
        const cost = playCost(S.p, card); // 指向总部无红魔加成
        if(S.p.kredit < cost){ toast('指挥点不足'); S.mode=null; render(); return; }
        S.mode = null;
        S.p.kredit -= cost;
        const idx = S.p.hand.indexOf(card); if(idx>-1) S.p.hand.splice(idx,1);
        orderEffect(card, {hq:true, hqSide: t.dataset.side});
        render();
        return;
      }
      // 炮艇任务/轰炸突袭/快速胜利/航母战/外交专员/嗡嗡炸弹：指向模式点选总部
      if(m && m.type==='order' && m.card && (m.card.eff==='gunboat' || m.card.eff==='bombRaid' || m.card.eff==='quickWin' || m.card.eff==='carrierWar' || m.card.eff==='diplomat' || m.card.eff==='buzzBomb') && t.dataset.side === 'a' && S.phase === 'player' && !S.over){
        const card = m.card;
        const cost = playCost(S.p, card); // 指向总部无红魔加成
        if(S.p.kredit < cost){ toast('指挥点不足'); S.mode=null; render(); return; }
        S.mode = null;
        S.p.kredit -= cost;
        const idx = S.p.hand.indexOf(card); if(idx>-1) S.p.hand.splice(idx,1);
        orderEffect(card, {hq:true});
        render();
        return;
      }
      // 零战部署：指向总部（造成 1 点伤害）
      if(m && m.type==='deployPick' && m.card && m.card.target==='any' && t.dataset.side === 'a' && S.phase === 'player' && !S.over){
        S.pickTarget = {hq:true, hqSide:'a'};
        S.mode = {type:'place', card: m.card};
        sfx('card'); render();
        return;
      }
      if(m && m.type==='attack' && t.dataset.side === 'a'){
        const u = unitAt(m.row,m.col);
        const valid = u && attackTargets(u.owner, m.row, m.col).some(v=>v.hq);
        if(valid){ combat({row:m.row, col:m.col}, {hq:true}); S.mode=null; }
      }
      return;
    }
    if(act === 'slot'){
      const m = S.mode;
      if(m && m.type === 'orderHq'){ cancelMode(); return; } // 总部瞄准中：点战场空槽 = 取消
      if(m && m.type === 'place' && S.phase === 'player' && !S.over){
        const row = +t.dataset.row, col = +t.dataset.col;
        if(row !== backRowOf('p')){ toast('新部署的单位只能进入己方底线'); return; }
        if(deployBlocked('p')){ toast('敌方的封锁仍在生效，无法部署'); return; }
        const card = m.card;
        const pickT = S.pickTarget; // spawnUnit 会消费并清空，先捕获
        // 红魔空降步兵团：部署指向敌方红魔时 +1 花费（花费不够则不能部署）
        const sur = targetSurcharge('p', S.pickTarget);
        const cost = playCost(S.p, card) + sur;
        if(S.p.kredit < cost){ toast('指挥点不足（部署需 '+cost+' 点）'); S.mode=null; render(); return; }
        spawnUnit('p', card, row, col);
        S.p.kredit -= cost;
        if(sur) logMsg('红魔空降步兵团：部署指向花费 +1。');
        r75Targeted('p', pickT); // 步兵第75团：被敌方部署效果指向时复制到友方总部相邻处
        checkEnemyDeployDmg('p', unitAt(row,col), row, col); // 反制·无心漫谈（只对从手牌部署的单位触发一次）
        const idx = S.p.hand.indexOf(card); if(idx>-1) S.p.hand.splice(idx,1);
        // 巴顿：部署后具有闪击
        if(S.p.patton){
          const dep = unitAt(row,col);
          if(dep && !hasSig(dep,'blitz')){ dep.def.sig.push('blitz'); logMsg('巴顿：'+dep.def.n+' 部署后获得闪击。'); }
        }
        logMsg('你部署了 ' + card.n + '（-'+(card.blood||0)+' 指挥点）。');
        sfx('place');
        S.mode = null; render();
        return;
      }
      // 推进：点击选中的底线单位后，点击前线空槽=推进到该槽（前线被对方占领则无法推进）
      // 统一走引擎 moveForward（指定目标格）：推进音效/滑行动画/烟幕散去/成长/工兵增益等全部只在一处实现
      if(m && m.type === 'attack' && S.phase === 'player' && !S.over){
        const row = +t.dataset.row, col = +t.dataset.col;
        if(row !== 1 || unitAt(row,col)) return;
        const u = unitAt(m.row, m.col);
        if(!u || u.owner !== 'p' || m.row !== backRowOf('p')){ S.mode = null; render(); return; }
        moveForward('p', m.row, m.col, col); // 不合法的推进由引擎给出 toast 说明（行动过/油不够/前线被占等）
        S.mode = null; render();
      }
      return;
    }
    if(act === 'unit'){
      const row = +t.dataset.row, col = +t.dataset.col;
      const u = unitAt(row,col);
      if(!u) return;
      const m = S.mode;
      if(m && m.type === 'orderHq'){ cancelMode(); return; } // 总部瞄准中：点单位 = 取消
      if(m && m.type === 'deployPick' && deployPickValid(m, u) && S.phase === 'player' && !S.over){
        S.pickTarget = u;
        S.mode = {type:'place', card: m.card};
        sfx('card'); render();
        return;
      }
      if(m && m.type === 'order' && (m.tgtOwner === u.owner || (m.card && m.card.target === 'any')) && S.phase === 'player' && !S.over){
        const card = m.card;
        if(card.target){
          const okT = orderTargets(card, 'p').some(t => t.row===row && t.col===col);
          if(!okT){ toast('该目标不可用'); return; }
        }
        // 红魔空降步兵团：敌方指向本单位时 +1 花费（花费不够则不能打出）
        const sur = targetSurcharge('p', u);
        const cost = playCost(S.p, card) + sur;
        if(S.p.kredit < cost){ toast('指挥点不足（打出需 '+cost+' 点）'); S.mode=null; render(); return; }
        S.mode = null;
        S.p.kredit -= cost;
        if(sur) logMsg('红魔空降步兵团：指向花费 +1。');
        r75Targeted('p', u); // 步兵第75团：被敌方效果指向时复制到友方总部相邻处
        const idx = S.p.hand.indexOf(card); if(idx>-1) S.p.hand.splice(idx,1);
        orderEffect(card, {row, col});
        render();
        return;
      }
      if(m && m.type === 'attack' && u.owner !== 'p'){
        const attUnit = unitAt(m.row,m.col);
        const valid = attUnit && attackTargets(attUnit.owner, m.row, m.col).some(v=>v.row===row && v.col===col);
        if(valid){ combat({row:m.row, col:m.col}, {row, col}); S.mode=null; render(); }
        return;
      }
      // 进入行动模式：可攻击（canAct）或可推进的单位均可。
      // 落地当回合只有闪击能移动（坦克无闪击也一样）；坦克/「可移动并攻击」可攻击后再移动
      const isMoveFlex = u.def.t==='tank' || hasFx(u,'moveNattack');
      const canPushSel = u.owner==='p' && row===backRowOf('p') && !u.movedThisTurn && !u.suppressed &&
        !(u.summonedThisTurn && !hasSig(u,'blitz')) && (isMoveFlex || !u.attackedN);
      if(u.owner === 'p' && S.phase==='player' && !S.over && (canAct(u) || canPushSel)){
        if(m && m.type==='attack' && m.row===row && m.col===col){ cancelMode(); return; }
        S.mode = {type:'attack', row, col};
        sfx('card'); render();
      } else if(u.owner === 'p' && S.phase==='player' && !S.over && u && (u.summonedThisTurn || u.movedThisTurn || u.suppressed)){
        toast(u.suppressed ? '该单位被压制，无法行动' : (u.summonedThisTurn ? '该单位本回合刚落地，还不能攻击' : '该单位本回合已推进，不能再攻击'));
      }
      return;
    }
    if(act === 'hand'){
      if(S.phase !== 'player' || S.over) return;
      const idx = +t.dataset.i;
      const card = S.p.hand[idx];
      if(!card) return;
      if(S.mode && S.mode.type === 'place' && S.mode.card === card){ cancelMode(); return; }
      if(S.mode && S.mode.type === 'orderHq'){ if(S.mode.card === card){ cancelMode(); return; } cancelMode(); } // 总部瞄准中：重选手牌先取消
      if(S.discardPick){
        if(S.discardPick.shuffleIn){                     // 调整：洗入卡组（P1 的 handToDeckResolve 已支持 shuffleIn 分支）
          if(card === S.discardPick.card){ toast('请点击要洗入卡组的牌（不是「调整」本身）'); return; }
          handToDeckResolve(card);
          return;
        }
        if(S.discardPick.toDeck){                        // 霹雳师/第175步兵团：返回卡组顶
          if(card === S.discardPick.card){ toast('请点击要返回卡组顶的牌（不是本单位）'); return; }
          handToDeckResolve(card);
          return;
        }
        if(card === S.discardPick.card){ toast('请点击其他手牌（不是「' + (S.discardPick.label || '权衡') + '」本身）'); return; }
        discardPickResolve(card);
        return;
      }
      if(S.gordonPick){                                  // 戈登高人团：点击浮起的指令触发
        if(card.kind === 'order'){ gordonResolve(card); }
        else toast('请点击一张浮起的指令');
        return;
      }
      if(card.kind === 'unit'){
        if(!canAfford(S.p, card)){ toast('指挥点不足（需要 '+(playCost(S.p, card))+' 点）'); return; }
        // 指向型部署效果（第17步兵团/零战/第二挺进团等）：先点场上目标，再部署。
        // 与指令不同：没有合法目标（效果无法触发）时可直接部署，效果不触发
        if(card.target){
          // 目标归属：凡 friendly* 一律归己方（含 friendly-unit/-tank/-infantry/-fighter/-army/-ground/-guard/-air）
          const tgtOwner = String(card.target).indexOf('friendly') === 0 ? 'p' : 'a';
          if(deployCanTarget(card, 'p')){
            S.pickTarget = null;
            S.mode = {type:'deployPick', card, tgtOwner};
            sfx('card'); render();
            return;
          }
        }
        S.mode = {type:'place', card};
        sfx('card'); render();
      } else if(card.kind === 'counter'){
        activateCounter(card);   // 引擎切换：激活(扣指挥点) ←→ 收回(退还指挥点)；敌方触发才算打出
      } else {
        if(!canAfford(S.p, card)){ toast('指挥点不足'); return; }
        // 指向型指令：先检查有无合法目标，没有则无法打出
        if(card.target){
          const tgts = orderTargets(card, 'p');
          if(!tgts.length){ toast('没有可用目标，无法打出「'+card.n+'」'); return; }
          S.mode = {type:'order', card, tgtOwner: String(card.target).indexOf('friendly') === 0 ? 'p' : 'a'};
          sfx('card'); render();
          return;
        }
        // 空中闪击/俾斯麦号/英联邦：文案为「对1个总部造成伤害」→ 进入瞄准模式，可点己方或敌方总部
        if(card.eff === 'airStrike' || card.eff === 'bismarck' || card.eff === 'commonwealth'){
          S.mode = {type:'orderHq', card};
          toast('点选总部施放：可打己方或敌方总部（点击其他处取消）');
          sfx('card'); render();
          return;
        }
        const ok = orderEffect(card, null);
        if(!S.pendingChoice && !S.discardPick){
          if(ok === false) return; // 条件不满足（如英联邦总部防御不足）：不消耗、留在手牌
          // 普通指令：立即消耗
          S.p.kredit -= playCost(S.p, card);
          S.p.hand.splice(idx,1);
        } else if(S.discardPick){
          // 权衡：点手牌弃 1 张后才消耗（discardPickResolve 内结算）；结束回合自动弃最低费
          logMsg('「' + card.n + '」已打出，请点击手牌弃掉 1 张（按 ESC 或结束回合将自动弃花费最低的）。');
        } else {
          // 抉择卡：点选 抉择1/抉择2 后才消耗（resolveChoice 内结算）；点击其他处可取消，不算使用
          logMsg('「' + card.n + '」已打出，请抉择（点击其他处取消，不消耗）。');
        }
        render();
      }
      return;
    }
  });
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape'){
      if(S.pendingChoice && S.pendingChoice.side === 'p'){ cancelChoice(); hideChoiceBox(); }
      if(S.discardPick && S.discardPick.toDeck) cancelHandToDeck(); // 霹雳师/第175：放弃选牌 → 回合结束自动返回卡组顶
      else if(S.discardPick) cancelDiscardPick(); // 权衡：放弃手动选牌 → 回合结束自动弃最低费
      cancelMode();
    }
  });
  /* ---------- 按钮装配 ---------- */
  $('endTurn').addEventListener('click', endPlayerTurn);
  // 投降：快速结束本局视为战败（双击确认防误触；战役按战败结算，可直接再来一局）
  let surrenderArmed = false, surrenderTimer = null;
  $('surrenderBtn').addEventListener('click', () => {
    if(S.over) return;
    if(!surrenderArmed){
      surrenderArmed = true;
      const b = $('surrenderBtn'); if(b){ b.textContent = '再点一次确认'; b.style.filter = 'brightness(1.4)'; }
      clearTimeout(surrenderTimer);
      surrenderTimer = setTimeout(() => { surrenderArmed = false; const b2 = $('surrenderBtn'); if(b2){ b2.textContent = '投 降'; b2.style.filter = ''; } }, 2500);
      return;
    }
    surrenderArmed = false;
    const b = $('surrenderBtn'); if(b){ b.textContent = '投 降'; b.style.filter = ''; }
    endGame('a'); // 视为战败：走完整结算流程（战败结算/再战按钮/征程战败重置）
  });
  $('helpBtn').addEventListener('click', ()=> $('help').classList.add('show'));
  $('helpBtn2').addEventListener('click', ()=> $('help').classList.add('show'));
  $('helpClose').addEventListener('click', ()=> $('help').classList.remove('show'));
  $('randomBtn').addEventListener('click', ()=>{
    const list = listDeckEntries();
    if(!list.length) return;
    dispatchDeckPick(list[Math.floor(Math.random()*list.length)]); // 随机卡组：自定义或初始
  });
  /* [v2] rematchBtn/repickBtn 已移除,换为 btnRematch(v2 事件委托) + backBtn */
  $('backBtn').addEventListener('click', backToMenu);
  document.addEventListener('contextmenu', e => { if(e.target.closest('#table')) e.preventDefault(); });
  // 总部面板：点面板外收起。独立监听、**不 stopPropagation** —— 上面的出牌/点选流程照常收到同一个点击
  document.addEventListener('click', e => {
    if(!hqPanelSide) return;
    const inside = (e.target && e.target.closest) ? e.target.closest('#hqPanel,[data-act="hqinfo"]') : null;
    if(!inside) closeHqPanel();   // 面板内/信息条上的点击由各自分支处理（✕ = data-act="hqClose"）
  });
}

/* ---------- 指令动画（双方打出指令时，牌桌中央播放约 1 秒） ---------- */
let orderAnimEl = null, orderAnimFx = null, orderAnimTimer = null;
function uiShowOrderAnim(card){
  if(!card || typeof document === 'undefined') return;
  sfxDebug('事件 指令 ' + (card.n || '?'));
  // 指令音效：同名牌 → 贴膜 → 苏联费用档 → 日本/英国「其他牌」（未命中时引擎的 sfx('order') 合成兜底）
  sfxPlay(orderAudio(card), { volume: sfxVolume('order', .58) });
  if(!document.head || !document.head.appendChild) return;   // 无头沙箱保护
  const table = document.getElementById('table');
  if(!table) return;
  if(!orderAnimEl){
    orderAnimEl = document.createElement('div');
    orderAnimEl.id = 'orderAnim';
    table.appendChild(orderAnimEl);
    const st = document.createElement('style');
    st.textContent =
      '#orderAnim{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:55;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:6px;opacity:0;transition:opacity .18s;}' +
      '#orderAnim.show{opacity:1;}' +
      '#orderAnim .oaFx{position:fixed;left:50%;top:50%;width:420px;height:420px;margin:-210px 0 0 -210px;border-radius:50%;background:radial-gradient(ellipse at center,rgba(240,200,120,.28),transparent 62%);animation:oaFlash .95s ease-out;}' +
      '#orderAnim .oaCard{width:158px;height:216px;border-radius:12px;background:linear-gradient(170deg,#f2e5c0,#d3bd8e 60%,#b89e6a);border:3px solid #4a2f14;box-shadow:0 0 34px rgba(240,200,120,.6),0 12px 34px rgba(0,0,0,.75);padding:8px;display:flex;flex-direction:column;animation:oaIn .32s cubic-bezier(.2,1.4,.4,1);}' +
      '#orderAnim .oaImg{flex:1;border-radius:8px;overflow:hidden;background:#14100c;border:1px solid #2a1a0a;display:flex;align-items:center;justify-content:center;}' +
      '#orderAnim .oaImg img{width:100%;height:100%;object-fit:cover;}' +
      '#orderAnim .oaName{font-size:16px;font-weight:bold;color:#3a2410;text-align:center;margin-top:4px;letter-spacing:2px;}' +
      '@keyframes oaIn{from{transform:scale(.5) rotate(-4deg);opacity:0;}to{transform:none;opacity:1;}}' +
      '@keyframes oaFlash{from{opacity:1;transform:scale(.6);}to{opacity:0;transform:scale(1.15);}}';
    document.head.appendChild(st);
    orderAnimFx = document.createElement('div');
    orderAnimFx.className = 'oaFx';
    orderAnimEl.appendChild(orderAnimFx);
  }
  const cardEl = orderAnimEl.querySelector('.oaCard') || (orderAnimEl.appendChild(document.createElement('div')), orderAnimEl.lastChild);
  cardEl.className = 'oaCard';
  cardEl.style.animation = 'none'; void cardEl.offsetWidth; cardEl.style.animation = ''; // 重播入场动画
  cardEl.innerHTML = '<div class="oaImg">' + artHTML(card, false) + '</div><div class="oaName">' + esc(card.n || '') + '</div>';
  if(orderAnimFx){ orderAnimFx.style.animation = 'none'; void orderAnimFx.offsetWidth; orderAnimFx.style.animation = ''; }
  orderAnimEl.classList.add('show');
  clearTimeout(orderAnimTimer);
  orderAnimTimer = setTimeout(() => { if(orderAnimEl) orderAnimEl.classList.remove('show'); }, 1000);
}

/* ---------- 抉择面板（航母掩护：抉择1 屏幕正中偏左 / 抉择2 屏幕正中偏右） ---------- */
let choiceEl = null;
function uiShowChoice(options){
  if(typeof document === 'undefined') return;
  if(S.pendingChoice && S.pendingChoice.side !== 'p') return; // AI 的抉择由引擎自动结算，不弹面板
  const table = document.getElementById('table');
  if(!table) return;
  if(!choiceEl){
    choiceEl = document.createElement('div');
    choiceEl.id = 'choiceBox';
    table.appendChild(choiceEl);
    const st = document.createElement('style');
    if(document.head && document.head.appendChild){
      st.textContent =
        '#choiceBox{position:fixed;left:0;right:0;top:50%;transform:translateY(-50%);z-index:58;display:flex;justify-content:center;align-items:center;gap:26vw;pointer-events:auto;}' +
        '#choiceBox .choiceCard{width:150px;height:215px;border-radius:12px;cursor:pointer;background:linear-gradient(170deg,#f2e5c0,#d3bd8e 60%,#b89e6a);border:3px solid #f0d58a;box-shadow:0 0 26px rgba(240,200,120,.65),0 10px 30px rgba(0,0,0,.75);padding:8px;display:flex;flex-direction:column;transition:transform .15s,box-shadow .15s;animation:oaIn .32s cubic-bezier(.2,1.4,.4,1);}' +
        '#choiceBox .choiceCard:hover{transform:translateY(-8px) scale(1.05);box-shadow:0 0 38px rgba(255,220,140,.9),0 14px 34px rgba(0,0,0,.85);}' +
        '#choiceBox .choiceCard.left{transform-origin:right center;}' +
        '#choiceBox .choiceCard.right{transform-origin:left center;}' +
        '#choiceBox .choiceImg{flex:1;border-radius:8px;overflow:hidden;background:#14100c;border:1px solid #2a1a0a;display:flex;align-items:center;justify-content:center;}' +
        '#choiceBox .choiceImg img{width:100%;height:100%;object-fit:cover;}' +
        '#choiceBox .choiceName{font-size:14px;font-weight:bold;color:#3a2410;text-align:center;margin-top:5px;letter-spacing:2px;}' +
        '#choiceBox .choiceDesc{font-size:9px;color:#5d4423;text-align:center;margin-top:2px;line-height:1.35;}' +
        '#choiceBox .choiceHint{position:fixed;left:0;right:0;bottom:14vh;text-align:center;font-size:14px;letter-spacing:4px;color:#f0d58a;text-shadow:0 2px 6px #000;}';
      document.head.appendChild(st);
    }
  }
  choiceEl.innerHTML = (options||[]).map((o,i)=>{
    const cls = options.length <= 2 ? (i===0?'left':'right') : 'mid';
    return '<div class="choiceCard '+cls+'" data-act="choicePick" data-id="'+o.id+'" title="'+esc(o.desc)+'">'+
      '<div class="choiceImg"><img src="'+imgUrl(o.img)+'" alt="" loading="lazy"></div>'+
      '<div class="choiceName">'+esc(o.n)+'</div>'+
      '<div class="choiceDesc">'+esc(o.desc)+'</div>'+
    '</div>';
  }).join('') + '<div class="choiceHint">' + (options && options.length > 2 ? '选 择 一 张 · 点击其他处取消' : '抉 择 · 点击其他处取消') + '</div>';
  // 3 张及以上：收紧间距（默认 26vw 是为左右两张设计的）
  choiceEl.style.gap = (options && options.length > 2) ? '2.2vw' : '';
}
function hideChoiceBox(){ if(choiceEl) choiceEl.innerHTML = ''; }

/* ---------- 换牌窗口（首回合：屏幕正中显示 4 张卡组牌，可多选换牌/不换） ---------- */
let mullEl = null, mullSel = new Set();
function renderMulligan(){
  if(typeof document === 'undefined') return;
  const table = document.getElementById('table');
  if(!table) return;
  if(!mullEl){
    mullEl = document.createElement('div');
    mullEl.id = 'mullBox';
    table.appendChild(mullEl);
    const st = document.createElement('style');
    if(document.head && document.head.appendChild){
      st.textContent =
        '#mullBox{position:fixed;left:0;right:0;top:0;bottom:0;z-index:57;background:rgba(8,5,2,.78);display:flex;flex-direction:column;justify-content:center;align-items:center;pointer-events:auto;animation:oaIn .3s ease;}' +
        '#mullBox .mullHead{font-size:24px;letter-spacing:10px;color:#f0d58a;text-shadow:0 2px 8px #000;margin-bottom:18px;}' +
        '#mullBox .mullRow{display:flex;gap:18px;justify-content:center;}' +
        '#mullBox .mullCard{width:118px;padding:6px;background:linear-gradient(170deg,#f2e5c0,#d3bd8e 60%,#b89e6a);border:3px solid #f0d58a;border-radius:10px;cursor:pointer;text-align:center;box-shadow:0 8px 22px rgba(0,0,0,.6);transition:transform .15s,box-shadow .15s,border-color .15s;}' +
        '#mullBox .mullCard:hover{transform:translateY(-6px);}' +
        '#mullBox .mullCard.sel{border-color:#ff6a3d;box-shadow:0 0 0 3px rgba(255,106,61,.55),0 10px 26px rgba(0,0,0,.7);transform:translateY(-10px) scale(1.04);}' +
        '#mullBox .mullCard img{width:100%;height:96px;object-fit:cover;border-radius:6px;display:block;}' +
        '#mullBox .mullName{font-size:13px;font-weight:bold;color:#3a2410;margin-top:4px;}' +
        '#mullBox .mullCost{font-size:10px;color:#5d4423;margin-top:2px;}' +
        '#mullBox .mullHint{font-size:13px;letter-spacing:3px;color:#e8d9ae;margin-top:16px;text-shadow:0 1px 4px #000;}' +
        '#mullBox .mullGo{margin-top:14px;padding:10px 44px;font-size:16px;letter-spacing:6px;border:none;border-radius:8px;cursor:pointer;background:linear-gradient(170deg,#f2c86a,#c99a3f);color:#2a1a08;font-weight:bold;box-shadow:0 6px 16px rgba(0,0,0,.55);}' +
        '#mullBox .mullGo:hover{filter:brightness(1.15);}';
      document.head.appendChild(st);
    }
  }
  if(!(S.mulliganPending && S.phase === 'player' && !S.over)){
    // 必须连同遮罩一起隐藏：只清内容会让全屏深色背景残留并拦截点击
    mullEl.style.display = 'none';
    mullEl.innerHTML = '';
    return;
  }
  mullEl.style.display = 'flex';
  // 生产牌不参与换牌窗口；剩余 4 张卡组牌按序展示（data-i 对应当前渲染序）
  const cards = S.p.hand.filter(c => !(c.kind === 'order' && c.eff === 'produce'));
  mullEl.innerHTML =
    '<div class="mullHead">首 回 合 换 牌</div>' +
    '<div class="mullRow">' + cards.map((c, i) => {
      const sel = mullSel.has(i) ? ' sel' : '';
      const stats = c.kind === 'unit'
        ? c.blood + '费/' + (c.fuel||0) + '油 ⚔' + c.atk + ' ❤' + c.hp
        : c.blood + '费';
      return '<div class="mullCard' + sel + '" data-act="mullPick" data-i="' + i + '" data-info="'+(c.nation||S.pNation)+':'+c.kind+':'+c.id+'" title="' + esc(c.desc) + '">' +
        '<img src="' + imgUrl(c.img) + '" alt="" loading="lazy">' +
        '<div class="mullName">' + esc(c.n) + '</div>' +
        '<div class="mullCost">' + stats + '</div>' +
      '</div>';
    }).join('') + '</div>' +
    '<div class="mullHint">点击选择要换掉的牌（可多选，也可不选）</div>' +
    '<button class="mullGo" data-act="mullGo">换 牌</button>';
}function hideMullBox(){ if(mullEl){ mullEl.style.display = 'none'; mullEl.innerHTML = ''; } }
/* 抽取：抽到时向对手展示。
   side==='p'：维持旧版屏幕中央闪现（uiShowOrderAnim）；
   side==='a'：敌方「抽取揭示旅程」（左侧飞入→中央翻面→飞向敌方手牌行），
   并设 fxSkipNextEnemyIn 供下一次 uiRender 的敌方进手 diff 跳过通用左侧飞入 */
function uiRevealDrawn(card, side){
  if(side === 'a' && card){
    fxSkipNextEnemyIn = true;
    fxSkipAge = 0;
    fxEnemyRevealJourney(card);
  } else {
    uiShowOrderAnim(card);
  }
}

/* ---------- 总部血量数字变色（HOOKS.onHqHpChange 实现） ----------
   受伤→红、加血→绿、直接更改→白（默认白；数字与卡图印字重合，颜色反馈不受字号影响） */
function uiHqHpChange(side, kind){
  if(typeof document === 'undefined' || !document.getElementById) return;
  const el = side === 'a' ? document.getElementById('aiHqHp') : document.getElementById('pHqHp');
  if(!el) return;
  el.style.color = kind === 'damage' ? '#ff5a4a' : (kind === 'heal' ? '#6dff7d' : '#ffffff');
}

/* ---------- 向引擎注入真实实现 ---------- */
function installHooks(){
  HOOKS.onRender = uiRender;
  HOOKS.onSfx = uiSfx;
  HOOKS.toast = uiToast;
  // 收缴（seize）结算音：引擎侧无 onSfx 出口（不入 engine.js），按引擎日志名兜底——
  // seizeCopy 成功时正好只发一条「收缴：<名> 的 1/1 复制加入手牌。」（另两条是「手牌已满，无法收缴。」/「收缴：没有可收缴的单位」，不以此开头）
  HOOKS.onLog = msg => { try{ if(String(msg == null ? '' : msg).indexOf('收缴：') === 0) sfxPlay(SFX.ordSeize, { volume:.6 }); }catch(e){} };
  HOOKS.onGameEnd = uiGameEnd;
  HOOKS.onOrderPlayed = uiShowOrderAnim;
  HOOKS.onDrawnReveal = uiRevealDrawn;
  HOOKS.onCardBurst = uiCardBurst;      // 满手爆牌：卡/单位被丢弃或摧毁（引擎已接线）
  HOOKS.onFoeDiscard = uiFoeDiscard;    // 敌方（AI）手牌被夺走：弃牌/返回卡组顶的揭示动画（引擎已接线，同步调用）
  HOOKS.onHqHpChange = uiHqHpChange;    // 总部血量变化：数字变色（红/绿/白）
  HOOKS.onAttack = uiAttackFx;          // 攻击行动可见：扑击/红闪/飘字（瞬态）
  HOOKS.onCounterTrigger = uiCounterTriggerFx; // 反制触发：卡牌滑出展示
  HOOKS.onUnitDeploy = uiUnitDeployFx;  // 单位上线：入场/部署特效
  HOOKS.onUnitDeath = uiUnitDeathFx;    // 单位死亡：死亡动画
  HOOKS.onMoveForward = uiMoveForwardFx; // 单位推进前线：入位滑行动画
  HOOKS.onHqExplode = uiHqExplodeFx;    // 总部爆炸（配合 3 秒延迟结算）
  HOOKS.onBossPhase2 = fxBossPhase2;    // Boss 二阶段：屏幕震动 + 红光（牌堆发卡动画在其后播放）
  HOOKS.onBossGrant = info => {         // Boss 获得卡牌：飞入敌方手牌 → 移入左侧敌方卡组（等震动结束）
    if(info && info.cards && info.cards.length) setTimeout(() => fxEnemyGrantToDeck(info.cards), 1150);
  };
  HOOKS.onChoice = uiShowChoice;
  HOOKS.wait = ms => waitMs(ms * Math.max(0.5, mkSettings().speed || 1)); // [v2] 动画速度倍率(设置面板)
  bindFitResize(); // 战场适配：窗口尺寸变化时自动重排缩放
  lockLandscapeNoZoom(); // 手机：固定横屏（尽力锁定方向）＋ 禁手势缩放兜底
  mobileCardInfoBind();  // 手机：长按/双击卡牌 → 弹出卡牌数据（卡牌仅显示卡图）
}
/* ---------- 全端卡牌数据查看：长按 / 双击（鼠标长按同样适用） ---------- */
let _longFired = false; // 长按触发后吞掉紧随的 click（防误把手牌打出去）
function mobileCardInfoBind(){
  if(typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  document.addEventListener('contextmenu', e => { if(e && e.preventDefault) e.preventDefault(); }); // 长按不出系统菜单
  let timer = null;
  const clear = () => { if(timer){ clearTimeout(timer); timer = null; } };
  document.addEventListener('pointerdown', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-info]') : null;
    if(!el) return;
    clear();
    timer = setTimeout(() => {
      timer = null;
      _longFired = true;
      uiCardInfo(el);
    }, 600);
  });
  document.addEventListener('pointermove', clear);
  document.addEventListener('pointerup', clear);
  document.addEventListener('pointercancel', clear);
  document.addEventListener('dblclick', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-info]') : null;
    if(el) uiCardInfo(el);
  });
}
function uiCardInfo(el){
  const v = String(el && el.dataset ? (el.dataset.info || '') : '').split(':');
  if(v.length === 3 && typeof showCardDetail === 'function') showCardDetail(v[0], v[1], v[2]);
}
/* 手机固定横屏与禁缩放兜底：竖屏提示层由模板 CSS 负责；
   gesture 事件与屏幕方向锁定做尽力而为（需全屏/浏览器支持时静默失败） */
function lockLandscapeNoZoom(){
  if(typeof window === 'undefined' || typeof document === 'undefined') return;
  if(typeof document.addEventListener === 'function'){
    const stop = e => { e.preventDefault && e.preventDefault(); return false; };
    document.addEventListener('gesturestart', stop);
    document.addEventListener('gesturechange', stop);
    document.addEventListener('gestureend', stop);
    document.addEventListener('touchmove', e => {
      if(e.touches && e.touches.length > 1){ e.preventDefault(); } // 双指=捏合缩放手势，禁用
    }, { passive: false });
  }
  try{
    if(screen.orientation && typeof screen.orientation.lock === 'function') screen.orientation.lock('landscape').catch(()=>{});
  }catch(e){ /* 不支持时忽略 */ }
}

/* ============================================================
   [v2] UI 升级层已拆分至 src/v2ui.js(build.mjs LOAD_ORDER:ui.js → v2ui.js → main.js)
   ============================================================ */
/* Node 导出（浏览器下跳过；本文件顶层无 DOM 访问） */
if (typeof module !== 'undefined') module.exports = {
  installHooks, bindInput, pickNation, cancelMode,
  uiRender, renderBoard, renderHand, cardHTML, unitHTML, artHTML, sigBadges,
  isTarget, slotPlaceable, slotMovable
};

