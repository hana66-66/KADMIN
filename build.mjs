#!/usr/bin/env node
/* ============================================================
    KADMIN-卡兹铭刻 —— 零依赖构建脚本（build.mjs）
   用法：node build.mjs
   - 按 load 顺序读取 src/cards.js → engine.js → ai.js → ui.js → main.js
   - 与 HTML/CSS 骨架模板（自 v1.html.bak 原样提取）拼装，
     自动补 <script> 包装，输出同目录 KADMIN-卡兹铭刻.html（UTF-8）。
   - 自带校验：node --check 逐文件语法检查 + new Function 编译拼接产物。
   无任何 npm 依赖，Node 原生即可。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOAD_ORDER = ['cards.js', 'engine.js', 'ai.js', 'ui.js', 'v2ui.js', 'run.js', 'runui.js', 'main.js', 'dev.js']; // 征程模式:run.js 逻辑层 + runui.js UI 层；dev.js = 开发者模式桥（最后加载，可调用前面所有引擎函数）
const OUT = path.join(__dirname, 'KADMIN-卡兹铭刻.html');
const SRC = f => path.join(__dirname, 'src', f);

/* ---------- HTML/CSS 骨架（原 HTML 提取，未改动） ---------- */
const TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>KADMIN-卡兹铭刻</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  /* 启动加载遮罩：单文件体积大，解析/解码期间有一小会卡顿——纯 CSS 动画在合成器线程播放，主线程阻塞不影响转圈 */
  #loading { position: fixed; inset: 0; z-index: 999999; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; background: radial-gradient(ellipse at center, #1c1108, #0b0603 78%); }
  #loading .spin { width: 64px; height: 64px; border-radius: 50%; border: 5px solid rgba(240,200,120,.18); border-top-color: #f0d58a; animation: spin 0.9s linear infinite; box-shadow: 0 0 24px rgba(240,180,80,.25); }
  #loading .ltext { font-size: 15px; letter-spacing: 6px; color: #d8c48e; text-shadow: 0 1px 4px #000; }
  #loading.done { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  body {
    font-family: 'KaiTi','STKaiti','SimSun',serif;
    background:
      radial-gradient(ellipse at center, rgba(150,95,35,.28), rgba(0,0,0,.78) 78%),
      repeating-linear-gradient(90deg, rgba(70,40,14,.55) 0 4px, rgba(95,58,22,.55) 4px 150px),
      repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 2px, transparent 2px 16px),
      #160c06;
    color: #e8d9b0;
    user-select: none; overflow-x: hidden;
  }
  #table { max-width: 900px; margin: 0 auto; padding: 4px 10px 10px; position: relative; min-height: 100vh; display: flex; flex-direction: column; }
  #topbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 1px; }
  #turnInfo { font-size: 13px; color: #c9b27e; letter-spacing: 2px; text-shadow: 0 0 6px #000; }
  #helpBtn, #setBtn { background: linear-gradient(#6a4a24, #422a10); border: 2px solid #2a1808; color: #ecd9a8; border-radius: 6px; padding: 2px 14px; font-family: inherit; font-size: 13px; cursor: pointer; }
  #helpBtn:hover, #setBtn:hover { filter: brightness(1.25); }
  #topbar #helpBtn { margin-left: auto; }   /* 顶栏三个元素：左边回合信息，右边「规 则 + 设 置」成组（否则 space-between 会把规则挤到中间） */
  #topbar #setBtn { margin-left: 6px; }
  /* ===== 伪3D：顶部敌方手牌（未知=卡背/明牌正面直显） ===== */
  #aiHandRow { display: flex; align-items: flex-end; justify-content: center; gap: 10px; margin: 0 0 1px; min-height: 92px; perspective: 620px; }
  #aiHandRow .aiHandCap { font-size: 11px; color: #8a6a3a; letter-spacing: 4px; writing-mode: vertical-rl; text-align: center; align-self: center; text-shadow: 0 1px 2px #000; }
  #aiHand { display: flex; justify-content: center; gap: 6px; transform-style: preserve-3d; padding: 10px 6px 0; }
  .aiCard { width: 60px; height: 84px; border-radius: 8px; position: relative; flex: none;
    transform: rotateX(36deg); transform-origin: 50% 100%; transition: transform .18s; }
  #aiHand:hover .aiCard { transform: rotateX(26deg); }
  .aiCard .bk { position: absolute; inset: 0; border-radius: 8px; overflow: hidden;
    background: repeating-linear-gradient(45deg, rgba(150,95,30,.5) 0 7px, rgba(70,40,12,.5) 7px 14px), linear-gradient(165deg, #4a3016, #1f1004);
    border: 2px solid #8a6a3a; box-shadow: inset 0 0 12px rgba(0,0,0,.85), 0 3px 8px rgba(0,0,0,.55);
    display: flex; align-items: center; justify-content: center; }
  .aiCard .bk .bkArt { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .aiCard .bk .bkFlag img { width: 34px; height: 24px; border-radius: 4px; border: 2px solid #caa86a; box-shadow: 0 2px 6px rgba(0,0,0,.7); }
  .aiCard .bk .bkRib { position: absolute; left: 0; right: 0; bottom: 4px; text-align: center; font-size: 7px; letter-spacing: 2px; color: #caa86a; text-shadow: 0 1px 2px #000; }
  .aiCard.face { background: linear-gradient(170deg, #efe0b8, #c9b27e); border: 2px solid #4a2f14; box-shadow: 0 3px 10px rgba(0,0,0,.6); }
  .aiCard.face .artbox { position: absolute; left: 3px; top: 3px; right: 3px; bottom: 13px; border-radius: 5px; overflow: hidden; border: 1px solid #2a1a0a; background: #14100c; display: flex; align-items: center; justify-content: center; }
  .aiCard.face .artbox img { width: 100%; height: 100%; object-fit: cover; }
  .aiCard.face .fname { position: absolute; left: 1px; right: 1px; bottom: 1px; font-size: 7.5px; line-height: 1.25; text-align: center; color: #fff; text-shadow: 0 1px 3px #000; padding: 0 1px; white-space: nowrap; overflow: hidden; }
  .aiCard.face .fglow { position: absolute; top: -1px; right: -1px; width: 10px; height: 10px; border-radius: 50%; background: radial-gradient(circle, #ffd94a, rgba(255,200,60,.1)); box-shadow: 0 0 8px rgba(255,200,60,.9); }
  /* ===== 左右牌堆（触碰发牌：左生产 / 右卡组） ===== */
  .pile { position: absolute; bottom: 210px; width: 100px; text-align: center; cursor: pointer; z-index: 8; }
  .pileL { left: 0; } .pileR { right: 0; }
  .pile .pileStack { height: 128px; position: relative; perspective: 500px; }
  .pile .pcard { position: absolute; left: 50%; bottom: 0; width: 80px; height: 110px; margin-left: -40px; border-radius: 9px;
    background: repeating-linear-gradient(45deg, rgba(150,95,30,.5) 0 7px, rgba(70,40,12,.5) 7px 14px), linear-gradient(165deg, #4a3016, #1f1004);
    border: 2px solid #8a6a3a; transform: rotateX(52deg); transform-origin: 50% 100%;
    box-shadow: inset 0 0 14px rgba(0,0,0,.85), 0 14px 18px rgba(0,0,0,.55);
    display: flex; align-items: center; justify-content: center; transition: transform .15s, filter .15s; overflow: hidden; }
  /* 牌堆堆叠层板（renderPiles 按余量插入；伪3D 阶梯，层数≈余量/4，直观看出剩余张数） */
  .pile .pileStack .pslab { position: absolute; left: 50%; bottom: 0; width: 80px; height: 110px; margin-left: -40px; border-radius: 9px;
    background: repeating-linear-gradient(45deg, rgba(130,85,30,.42) 0 7px, rgba(60,35,10,.42) 7px 14px), linear-gradient(165deg, #33200c, #120902);
    border: 2px solid #5d3f1e; transform: rotateX(52deg); transform-origin: 50% 100%;
    box-shadow: inset 0 0 10px rgba(0,0,0,.7); }
  .pile .pcard .pArt { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; z-index: 2; }
  .pile .pcard .bkFlag img { width: 38px; height: 26px; border-radius: 4px; border: 2px solid #caa86a; box-shadow: 0 2px 6px rgba(0,0,0,.75); }
  .pile:hover .pcard { transform: rotateX(44deg) translateY(-7px); filter: brightness(1.18); }
  .pile .pileMeta { margin-top: 10px; font-size: 11px; color: #c9b27e; letter-spacing: 2px; text-shadow: 0 1px 3px #000; line-height: 1.5; }
  .pile .pileMeta .pileCnt { color: #ffcf5a; font-size: 13px; font-weight: bold; }
  .pile.glow .pcard { border-color: #f0d58a; animation: pulseGold 1.1s infinite; }
  .pile.off { filter: grayscale(.55) brightness(.55); cursor: default; }
  .pile.off:hover .pcard { transform: rotateX(52deg) translateY(0); filter: none; }
  #hqRow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 1px; }
  #phaseMsg { font-size: 15px; letter-spacing: 3px; color: #f0d58a; text-shadow: 0 0 10px rgba(240,180,80,.5); text-align: center; white-space: nowrap; }
  /* 总部卡面：按总部卡图本身的比例（竖版 ≈0.72，如 756×1053）放大，整张卡图完整可见；
     生命数字精确压在卡图印字位置（暗色盾徽上的浅色数字，测量值：中心 48.7%/60.5%，字高≈9%），
     实时数字盖住印图上的数字，看起来就是卡图自带的数值；顶部国名仍由卡图印字呈现 */
  .hqchip { width: 130px; height: 180px; border-radius: 12px; position: relative; cursor: default; overflow: hidden; background: linear-gradient(#3a2410, #241407); border: 3px solid #6a4a24; box-shadow: 0 4px 10px rgba(0,0,0,.65), inset 0 0 0 1px rgba(0,0,0,.5); }
  .hqchip .hqbg { position: absolute; inset: 0; background-size: 100% 100%; background-position: center; }
  .hqchip .hqhp { position: absolute; left: 48.7%; top: 60.5%; transform: translate(-50%,-50%); text-align: center; color: #ffffff; font-weight: bold; font-size: 22px; line-height: 1; letter-spacing: 0; text-shadow: 0 1px 2px rgba(0,0,0,.5); z-index: 2; }
  /* 卡图已印国名与数值徽章：隐藏程序叠加的国名层（老牧师名不随艺术图，仅对局内信息行显示） */
  .hqchip .hqname, .hqchip .hqov { display: none; }
  .hqchip.targetable { border-color: #e04a3a; box-shadow: 0 0 16px rgba(224,74,58,.8); cursor: crosshair; animation: pulseRed 1s infinite; }
  #aiInfo, #pInfo { text-align: center; font-size: 13px; color: #d8c48e; letter-spacing: 1px; text-shadow: 0 1px 3px #000; min-height: 18px; line-height: 1.4; }
  #aiInfo .aikredit { color: #8ad0ff; font-weight: bold; }
  #pInfo b { color: #ffb0a0; } #pInfo i { color: #8ad0ff; font-style: normal; }
  .res { display: inline-block; margin: 0 5px; }
  .res .dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; vertical-align: -1px; margin-right: 3px; }
  .res.blood .dot { background: radial-gradient(circle at 35% 30%, #ff8a7a, #a01010); box-shadow: 0 0 6px rgba(255,80,60,.7); }
  .res.teeth .dot { width: 9px; height: 12px; border-radius: 3px 3px 5px 5px; background: linear-gradient(#fff, #c9c2ae); border: 1px solid #8a8575; }
  .res.kredit .dot { width: 12px; height: 12px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #8ad0ff, #1a4a8a); box-shadow: 0 0 6px rgba(120,190,255,.7); }
  #counters { font-size: 12px; color: #8ad0ff; letter-spacing: 1px; min-height: 16px; text-align: center; }
  .row { display: flex; gap: 6px; align-items: center; justify-content: center; margin-bottom: 4px; }
  .rowlabel { width: 30px; font-size: 11px; color: #8a6a3a; writing-mode: vertical-rl; text-orientation: mixed; letter-spacing: 3px; text-align: center; }
  .row.front .rowlabel { color: #e8c87a; text-shadow: 0 0 8px rgba(232,200,122,.6); }
  .row .rowwrap { display: flex; gap: 6px; }
  .slot { width: 96px; height: 135px; border-radius: 8px; position: relative; background: linear-gradient(160deg, rgba(58,37,19,.42), rgba(34,17,5,.48) 70%); border: 2px solid rgba(93,58,24,.85); box-shadow: inset 0 0 18px rgba(0,0,0,.35), 0 3px 8px rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; }
  .row.front .slot { border-color: rgba(138,106,42,.9); background: linear-gradient(160deg, rgba(58,45,18,.4), rgba(36,23,5,.46) 70%); }
  .slot.placeable, .slot.movetarget { border-color: #e8c87a; box-shadow: 0 0 14px rgba(232,200,122,.55), inset 0 0 12px rgba(232,200,122,.25); animation: pulseGold 1.1s infinite; }
  .slot.targetable { border-color: #e04a3a; box-shadow: 0 0 16px rgba(224,74,58,.8); animation: pulseRed 1s infinite; cursor: crosshair; }
  .cardback { width: 70px; height: 90px; border-radius: 7px; background: repeating-linear-gradient(45deg, #5d1f1f 0 8px, #3a1212 8px 16px); border: 2px solid #2a0a0a; box-shadow: inset 0 0 10px rgba(0,0,0,.7); }
  .unit { width: 96px; height: 135px; border-radius: 8px; padding: 0; background: linear-gradient(170deg, #efe0b8, #c9b27e); border: 3px solid #4a2f14; cursor: pointer; transition: transform .15s, box-shadow .15s; display: flex; flex-direction: row; position: relative; align-items: stretch; }
  .unit.justAttacked { animation: atkLunge .55s ease; z-index: 6; }
  .unit.justAttacked.dr { --dx: 30px; }
  .unit.justAttacked.dl { --dx: -30px; }
  @keyframes atkLunge { 0% { transform: none; } 45% { transform: translateX(var(--dx, 30px)) scale(1.16); filter: brightness(1.25); } 100% { transform: none; } }
  .unit.justHit { animation: hitFlash .55s ease; }
  @keyframes hitFlash { 0%,100% { filter: none; } 30% { filter: brightness(1.9) saturate(1.7); box-shadow: 0 0 18px rgba(255,90,60,.95); } }
  .dmgFloat { position: absolute; top: -24px; right: 6px; z-index: 20; font-size: 17px; font-weight: bold; color: #ff6a5a; text-shadow: 0 2px 4px #000, 0 0 8px rgba(255,60,40,.6); animation: floatUp .95s ease forwards; pointer-events: none; }
  .dmgFloat.retal { color: #ffcf5a; }
  .dmgFloat.kill { top: -42px; right: 2px; color: #ffd94a; font-size: 12px; letter-spacing: 2px; }
  .dmgFloat.hqfloat { top: -30px; left: 14px; font-size: 22px; }
  @keyframes floatUp { 0% { opacity: 0; transform: translateY(8px); } 18% { opacity: 1; } 100% { opacity: 0; transform: translateY(-26px); } }
  .hqchip.hqHit { animation: hqShake .5s ease; z-index: 5; }
  @keyframes hqShake { 0%,100% { transform: none; } 25% { transform: translateX(-7px) rotate(-1.5deg); filter: brightness(1.55); } 60% { transform: translateX(6px) rotate(1deg); filter: brightness(1.75); } }
  .unit.deployFx { animation: deployDrop .75s ease; z-index: 5; }
  @keyframes deployDrop { 0% { transform: translateY(-30px) scale(.55); opacity: .15; filter: brightness(2); } 55% { transform: translateY(5px) scale(1.07); opacity: 1; } 100% { transform: none; filter: none; } }
  .unit.movedInUp { animation: moveInUp .62s cubic-bezier(.3,1.6,.5,1); z-index: 5; }
  .unit.movedInDown { animation: moveInDown .62s cubic-bezier(.3,1.6,.5,1); z-index: 5; }
  @keyframes moveInUp { 0% { transform: translateY(56px); opacity: .55; } 62% { transform: translateY(-7px); opacity: 1; } 100% { transform: none; } }
  @keyframes moveInDown { 0% { transform: translateY(-56px); opacity: .55; } 62% { transform: translateY(7px); opacity: 1; } 100% { transform: none; } }
  .unit.movedInUp::after, .unit.movedInDown::after { content: ''; position: absolute; left: 12%; right: 12%; bottom: -5px; height: 9px; border-radius: 50%; background: radial-gradient(ellipse, rgba(210,170,100,.6), transparent 72%); animation: dustPuff .75s ease-out forwards; pointer-events: none; }
  @keyframes dustPuff { 0% { opacity: .95; transform: scale(.5); } 100% { opacity: 0; transform: scale(1.8) translateY(5px); } }
  .slot.deathFx { animation: deathFlash .95s ease; z-index: 5; }
  @keyframes deathFlash { 0% { box-shadow: 0 0 0 rgba(0,0,0,0); filter: none; } 22% { box-shadow: 0 0 30px rgba(255,120,40,.95); filter: brightness(1.8); } 100% { box-shadow: 0 0 0 rgba(0,0,0,0); filter: none; } }
  .dmgFloat.skull { top: -32px; right: 10px; font-size: 21px; color: #ffb45a; animation: floatUp 1.05s ease forwards; }
  .dmgFloat.dlDeploy { top: -30px; right: 4px; font-size: 12px; color: #ffd94a; letter-spacing: 3px; animation: floatUp 1s ease forwards; }
  #fxCounterLayer { position: absolute; inset: 0; pointer-events: none; z-index: 40; }
  .fxCounterCard { position: absolute; top: 118px; width: 86px; padding: 4px 4px 3px; border-radius: 9px; background: linear-gradient(170deg,#f2e5c0,#d3bd8e 60%,#b89e6a); border: 3px solid #4a2f14; box-shadow: 0 10px 26px rgba(0,0,0,.8); text-align: center; }
  .fxCounterCard.fromP { left: calc(50% - 268px); animation: counterSlideP 1.7s ease forwards; }
  .fxCounterCard.fromA { left: calc(50% + 182px); animation: counterSlideA 1.7s ease forwards; }
  .fxCounterCard .fxcArt { height: 62px; display: flex; align-items: center; justify-content: center; background: #14100c; border-radius: 6px; overflow: hidden; border: 1px solid #2a1a0a; }
  .fxCounterCard .fxcArt img { max-width: 100%; max-height: 100%; }
  .fxCounterCard .fxcName { font-size: 11px; font-weight: bold; color: #3a2410; margin-top: 2px; white-space: nowrap; overflow: hidden; }
  @keyframes counterSlideP { 0% { transform: translateX(190px) scale(.45) rotate(6deg); opacity: 0; } 14% { transform: none rotate(0); opacity: 1; } 82% { transform: none; opacity: 1; } 100% { transform: translateX(70px) scale(.75); opacity: 0; } }
  @keyframes counterSlideA { 0% { transform: translateX(-190px) scale(.45) rotate(-6deg); opacity: 0; } 14% { transform: none rotate(0); opacity: 1; } 82% { transform: none; opacity: 1; } 100% { transform: translateX(-70px) scale(.75); opacity: 0; } }
  .hqchip.hqExploded { animation: hqExplode 5.2s ease forwards; z-index: 6; }
  @keyframes hqExplode {
    0% { transform: none; filter: none; }
    5% { filter: brightness(3.4) saturate(.3); }
    12% { transform: scale(1.16) rotate(2.5deg); filter: brightness(2.4); }
    24% { transform: scale(.92) rotate(-3deg); filter: brightness(1.4) sepia(.8); box-shadow: 0 0 40px rgba(255,170,60,.9); }
    38% { transform: scale(1.05) rotate(1.5deg); filter: brightness(1.1) sepia(1); }
    55% { transform: scale(.96) rotate(-1deg) translateY(3px); filter: brightness(.8) sepia(1) saturate(2); box-shadow: 0 0 26px rgba(255,120,40,.6); }
    75% { transform: scale(1.02) translateY(5px); filter: brightness(.5) saturate(.8); }
    100% { transform: scale(.98) translateY(6px); filter: brightness(.22) saturate(.3); opacity: .7; }
  }
  .hqBoom { position: absolute; inset: -22px; border-radius: 50%; pointer-events: none; transform: scale(.2); opacity: 0; background: radial-gradient(circle, #fff8d0 0%, #ffd94a 22%, #ff7a2a 45%, rgba(255,60,20,.35) 65%, transparent 78%); }
  .hqBoom.go { animation: boomExpand 3s ease-out forwards; }
  @keyframes boomExpand { 0% { transform: scale(.15); opacity: .1; } 12% { transform: scale(1.35); opacity: .95; } 30% { transform: scale(1.8); opacity: .6; } 55% { transform: scale(2.3); opacity: .3; } 100% { transform: scale(2.9); opacity: 0; } }
  #table.boomWhite { animation: boomWhite .7s ease; }
  @keyframes boomWhite { 0% { filter: none; } 10% { filter: brightness(2.6); } 100% { filter: none; } }
  /* Boss 二阶段（第一次被击败后重生）：屏幕震动 + 红光一闪 */
  #table.bossShake { animation: bossShake .95s cubic-bezier(.36,.07,.19,.97) both; }
  @keyframes bossShake {
    0%, 100% { transform: translate(0,0); }
    8%  { transform: translate(-12px,5px) rotate(-.6deg); }
    16% { transform: translate(11px,-6px) rotate(.5deg); }
    26% { transform: translate(-9px,-4px) rotate(-.4deg); }
    36% { transform: translate(8px,5px) rotate(.35deg); }
    48% { transform: translate(-6px,3px) rotate(-.25deg); }
    62% { transform: translate(5px,-3px) rotate(.2deg); }
    78% { transform: translate(-3px,2px); }
    90% { transform: translate(2px,-1px); }
  }
  .bossFlash { position: fixed; inset: 0; z-index: 70; pointer-events: none; background: radial-gradient(circle at 50% 45%, rgba(255,90,60,.55), rgba(150,10,10,.28) 55%, rgba(0,0,0,0) 82%); animation: bossFlash .95s ease-out both; }
  @keyframes bossFlash { 0% { opacity: 0; } 12% { opacity: .95; } 55% { opacity: .45; } 100% { opacity: 0; } }
  .unit:hover { transform: translateY(-3px); }
  .unit.used { filter: grayscale(.85) brightness(.75); }
  .unit.selected { border-color: #ffd94a; box-shadow: 0 0 18px rgba(255,217,74,.9); transform: translateY(-4px); }
  .unit.targetable { border-color: #e04a3a; box-shadow: 0 0 16px rgba(224,74,58,.9); cursor: crosshair; }
  .unit.enemy { cursor: default; }
  .unit.enemy:hover { transform: none; }
  .unit.mobile { border-color: #a8d0ff; }
  .unit.mobile:hover { transform: translateY(-3px); }
  .unit .artbox { width: 50px; height: 74px; flex: none; background: #14100c; border-radius: 5px; border: 1px solid #2a1a0a; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .artbox img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .unit .uinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 0 1px; }
  .unit .uname { font-size: 11px; font-weight: bold; color: #3a2410; text-align: center; line-height: 1.1; white-space: nowrap; overflow: hidden; max-width: 58px; }
  .unit .ustats { display: flex; justify-content: center; gap: 7px; font-weight: bold; font-size: 12px; margin-top: 1px; }
  .unit .ustats .atk { color: #7a1f1f; } .unit .ustats .hp { color: #1f5a2a; }
  .unit .usig { position: absolute; right: 1px; top: 1px; font-size: 8px; display: flex; flex-direction: column; gap: 2px; align-items: flex-end; max-height: 56px; overflow: hidden; z-index: 4; }
  .unit .usig span { background: rgba(0,0,0,.55); border-radius: 3px; padding: 0 2px; }
  .unit .usig .sigIcon { display: inline-block; width: 18px; height: 18px; padding: 0; background-color: rgba(0,0,0,.5); background-size: contain; background-repeat: no-repeat; background-position: center; border-radius: 3px; box-shadow: 0 1px 3px rgba(0,0,0,.7); }
  .unit .usig .sigIcon.supIcon { box-shadow: 0 0 8px #ff5a3a, 0 1px 3px rgba(0,0,0,.7); }
  .unit .usig .supTxt { color: #ff9a80; }
  .unit .usig .sigNum { font-style: normal; font-size: 9px; color: #ffe0a0; text-shadow: 0 1px 2px #000; margin-left: -3px; }
  .unit .uflag { position: absolute; bottom: 1px; left: 2px; font-size: 8px; color: #8a5a2a; text-shadow: 0 1px 1px #fff; }
  .unit .utype { font-size: 9px; color: #5d4423; text-align: center; line-height: 1; }
  .unit.mobile { border-color: #a8d0ff; }
  .unit.mobile:hover { transform: translateY(-3px); }
  #log { font-size: 11px; color: #b39a66; max-width: 620px; min-height: 16px; text-align: center; line-height: 1.5; margin: 0 auto; }
  #hand { display: flex; justify-content: center; gap: 8px; min-height: 158px; padding: 9px 4px 4px; overflow-x: auto; align-items: flex-end; perspective: 820px; }
  .card { width: 100px; height: 148px; border-radius: 10px; position: relative; cursor: pointer; flex: none; background: linear-gradient(170deg, #f2e5c0, #d3bd8e 60%, #b89e6a); border: 3px solid #4a2f14; box-shadow: 0 4px 10px rgba(0,0,0,.55); padding: 4px; display: flex; flex-direction: column; transition: transform .15s, box-shadow .15s; transform: rotateX(18deg); transform-origin: 50% 100%; animation: dealIn .3s ease backwards; }
  .card:hover { transform: rotateX(4deg) translateY(-14px); box-shadow: 0 14px 22px rgba(0,0,0,.65); }
  .card.selected { border-color: #ffd94a; box-shadow: 0 0 16px rgba(255,217,74,.85); transform: rotateX(2deg) translateY(-12px); }
  .card.counterArmed { border-color: #8ad0ff; box-shadow: 0 0 14px rgba(138,208,255,.75); }
  .card.counterArmed:hover { transform: rotateX(4deg) translateY(-14px); }
  .card.gordonLift { animation: gordonPulse 1.1s ease-in-out infinite; }
  @keyframes gordonPulse { 0%,100% { transform: rotateX(4deg) translateY(-16px); box-shadow: 0 0 12px rgba(255,217,74,.55); } 50% { transform: rotateX(4deg) translateY(-22px); box-shadow: 0 0 22px rgba(255,217,74,.95); } }
  .card.disabled { filter: grayscale(.7) brightness(.72); cursor: not-allowed; }
  .card.disabled:hover { transform: rotateX(18deg); box-shadow: 0 4px 10px rgba(0,0,0,.55); }
  .card .costs { position: absolute; top: 3px; left: 4px; display: flex; flex-direction: column; gap: 3px; z-index: 2; }
  .cost { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; font-weight: bold; color: #fff; text-shadow: 0 1px 2px #000; }
  .cost .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .cost.kredit .dot { width: 12px; height: 12px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #8ad0ff, #1a4a8a); }
  .cost.kredit.free { color: #a5e39a; } .cost.kredit.free .dot { background: radial-gradient(circle at 35% 30%, #b8f0a0, #1a7a2a); }
  .cost.orig { font-size: 9px; color: #e8d0a0; text-decoration: line-through; opacity: .8; }
  .cost.movek .dot { width: 9px; height: 11px; border-radius: 40%; background: linear-gradient(#8ad0ff,#2a5da0); }
  .card .freebadge { position: absolute; top: 3px; right: 3px; background: #2a6a2a; color: #cfc; font-size: 10px; padding: 1px 5px; border-radius: 4px; }
  .card .cflag { position: absolute; top: 3px; right: 3px; background: #5d3a8a; color: #e8d0ff; font-size: 10px; padding: 1px 5px; border-radius: 4px; z-index: 2; }
  .card .artbox { height: 62px; background: #14100c; border-radius: 7px; margin-bottom: 3px; display: flex; align-items: center; justify-content: center; border: 1px solid #2a1a0a; overflow: hidden; }
  .card .cname { font-size: 13px; font-weight: bold; color: #3a2410; text-align: center; line-height: 1.15; white-space: nowrap; overflow: hidden; }
  .card .ctype { font-size: 9px; color: #7a5a2a; text-align: center; letter-spacing: 1px; }
  .card .cstats { display: flex; justify-content: space-between; padding: 0 8px; font-weight: bold; font-size: 14px; margin-top: 1px; }
  .card .cstats .atk { color: #7a1f1f; } .card .cstats .hp { color: #1f5a2a; }
  .card .csig { font-size: 9px; color: #5d4423; text-align: center; margin-top: 1px; white-space: nowrap; overflow: hidden; }
  .card .ceff { font-size: 8px; color: #6a4a2a; text-align: center; line-height: 1.3; margin-top: 1px; max-height: 21px; overflow: hidden; }
  .card.order { background: linear-gradient(170deg, #e8d4c0, #c2a088 60%, #a88462); }
  .card.order .ceffect { font-size: 10px; color: #4a2a14; text-align: center; padding: 1px 3px; line-height: 1.3; margin-top: 1px; }
  #actions { text-align: center; margin-top: 2px; }
  #endTurn { font-family: inherit; font-size: 15px; letter-spacing: 4px; padding: 5px 30px; cursor: pointer; background: linear-gradient(#6a4a24, #3a2410); color: #f0d58a; border: 2px solid #2a1808; border-radius: 8px; box-shadow: 0 3px 8px rgba(0,0,0,.6); }
  #endTurn:hover { filter: brightness(1.3); }
  #endTurn:disabled { filter: grayscale(.8) brightness(.6); cursor: wait; }
  #surrenderBtn { font-family: inherit; font-size: 12px; letter-spacing: 3px; padding: 4px 18px; margin-left: 10px; cursor: pointer; background: linear-gradient(#5a2a1e, #30120a); color: #ffb0a0; border: 2px solid #6a2a1a; border-radius: 8px; box-shadow: 0 3px 8px rgba(0,0,0,.6); }
  #surrenderBtn:hover { filter: brightness(1.3); }
  #surrenderBtn:disabled { filter: grayscale(.8) brightness(.6); cursor: wait; }
  #overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; text-align: center; background: radial-gradient(ellipse at center, rgba(60,35,12,.5), rgba(0,0,0,.93)); }
  #overlay.hidden { display: none; }
  #overlay h1 { font-size: 44px; letter-spacing: 10px; color: #f0d58a; text-shadow: 0 0 24px rgba(240,180,80,.6), 0 4px 10px #000; margin-bottom: 4px; }
  #overlay .sub { font-size: 14px; color: #b39a66; letter-spacing: 4px; margin-bottom: 18px; }
  #overlay .flavor { font-size: 16px; color: #d8c48e; line-height: 1.9; letter-spacing: 2px; margin-bottom: 18px; min-height: 52px; }
  #overlay .flavor.dim { color: #9a8a5a; }
  #nationPicker { display: flex; gap: 14px; justify-content: center; margin-bottom: 20px; flex-wrap: wrap; }
  /* 选卡组分组标签（自定义卡组 / 初始卡组） */
  #nationPicker .dpSec { flex-basis: 100%; text-align: center; font-size: 12px; letter-spacing: 6px; color: #a98d55; margin: 8px 0 2px; text-shadow: 0 1px 3px #000; }
  .nationCard { width: 148px; height: 196px; border-radius: 12px; position: relative; cursor: pointer; overflow: hidden; border: 3px solid #4a2f14; box-shadow: 0 6px 16px rgba(0,0,0,.7); transition: transform .18s, box-shadow .18s; background: #241407; }
  .nationCard:hover { transform: translateY(-8px) scale(1.04); border-color: #f0d58a; box-shadow: 0 12px 26px rgba(0,0,0,.85); }
  .nationCard .nb { position: absolute; inset: 0; background-size: cover; background-position: center; }
  .nationCard .no { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(8,5,2,.1), rgba(8,5,2,.88)); }
  .nationCard .nn { position: absolute; bottom: 0; left: 0; right: 0; padding: 6px 4px 8px; }
  .nationCard .nn .nm { font-size: 19px; font-weight: bold; color: #f0d58a; letter-spacing: 4px; text-shadow: 0 2px 4px #000; }
  .nationCard .nn .np { font-size: 10.5px; color: #d8c48e; text-shadow: 0 1px 3px #000; margin-top: 3px; line-height: 1.4; }
  .bigbtn { font-family: inherit; font-size: 18px; letter-spacing: 6px; padding: 9px 38px; margin: 0 8px; cursor: pointer; background: linear-gradient(#6a4a24, #3a2410); color: #f0d58a; border: 2px solid #2a1808; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,.7); }
  .bigbtn:hover { filter: brightness(1.35); }
  #help { position: fixed; inset: 0; z-index: 70; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.75); }
  #help.show { display: flex; }
  #help .panel { width: 680px; max-height: 82vh; overflow: auto; padding: 24px 30px; border-radius: 12px; background: linear-gradient(#2e1c0c, #1c1006); border: 3px solid #6a4a24; box-shadow: 0 0 40px rgba(0,0,0,.9); text-align: left; line-height: 1.8; font-size: 15px; color: #d8c48e; }
  #help h2 { color: #f0d58a; letter-spacing: 6px; text-align: center; margin-bottom: 12px; }
  #help b { color: #ffcf5a; }
  #help .close { display: block; margin: 14px auto 0; }
  #toast { position: fixed; left: 50%; bottom: 60px; transform: translateX(-50%); z-index: 80; background: rgba(20,10,4,.92); border: 2px solid #8a6a3a; color: #f0d58a; border-radius: 8px; padding: 8px 20px; font-size: 15px; letter-spacing: 2px; opacity: 0; transition: opacity .25s; pointer-events: none; }
  #toast.show { opacity: 1; }
  @keyframes flick { 0% { transform: rotate(-3deg) scaleY(1); } 100% { transform: rotate(3deg) scaleY(1.12) scaleX(.92); } }
  @keyframes pulseGold { 0%,100% { box-shadow: 0 0 10px rgba(232,200,122,.4); } 50% { box-shadow: 0 0 20px rgba(232,200,122,.8); } }
  @keyframes pulseRed { 0%,100% { box-shadow: 0 0 10px rgba(224,74,58,.5); } 50% { box-shadow: 0 0 22px rgba(224,74,58,.95); } }
  @keyframes dealIn { from { transform: translateY(46px) scale(.55) rotateX(18deg); opacity: 0; } to { transform: rotateX(18deg); opacity: 1; } }
  ::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-thumb { background: #6a4a24; border-radius: 4px; }

  /* ================= UI v2 :主菜单/战役/组卡/图鉴/设置 ================= */
  #overlay .ovview { max-width: 1060px; width: 96vw; max-height: 94vh; overflow-y: auto; padding: 8px 12px 16px; border-radius: 14px; background: radial-gradient(ellipse at 50% 0%, rgba(96,58,20,.35), transparent 70%); }
  #overlay .ovview.hidden { display: none; }
  #overlay .ovview h1 { font-size: 40px; letter-spacing: 9px; }
  #overlay .ovview .sub { margin-bottom: 12px; }
  .menuBtns { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin: 4px 0 12px; }
  .bigbtn.menuBtn { min-width: 200px; font-size: 17px; letter-spacing: 5px; }
  #settingsBtn { position: absolute; top: 10px; right: 14px; width: 40px; height: 40px; border-radius: 50%; border: 2px solid #6a4a24; background: linear-gradient(#6a4a24, #3a2410); color: #f0d58a; font-size: 19px; cursor: pointer; z-index: 5; }
  #settingsBtn:hover { filter: brightness(1.3); }
  #ovResult { min-height: 34px; font-size: 17px; letter-spacing: 2px; color: #f0d58a; margin: 8px 0; line-height: 1.6; }
  #ovResult.dim { color: #9a8a5a; }
  .tagBadge { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; letter-spacing: 1px; padding: 1px 7px; border-radius: 8px; background: linear-gradient(#5a3d1e, #3a2410); border: 1px solid #8a6a3a; color: #e8c87a; }
  /* 组卡器两栏：用 grid 定死 4:1（flex-wrap 会被内容影响，曾把两栏挤反）；左=卡池 4/5，右=我的卡组 1/5 */
  .deckWrap { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 1fr); gap: 14px; align-items: start; margin-top: 8px; text-align: left; }
  .deckPool { min-width: 0; }   /* 左「选卡空间」4/5（比例由 .deckWrap 的 grid 定） */
  .deckPool h3, .deckList h3 { font-size: 14px; letter-spacing: 3px; color: #f0d58a; margin: 4px 0 6px; }
  .poolGroup { margin-bottom: 8px; }
  .poolGroup .pgTitle { font-size: 12px; color: #a98d55; letter-spacing: 2px; margin: 2px 0 4px; }
  /* 卡池：每张卡面**不小于 190px**（窗口再窄也不会缩成看不清），宽屏下正好一行 4 个 */
  .poolCards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
  .poolItem { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 8px; background: linear-gradient(#2e1c0c, #1c1006); border: 2px solid #5d3a18; cursor: pointer; transition: transform .12s, border-color .12s; }
  .poolItem:hover { transform: translateY(-2px); border-color: #e8c87a; }
  .poolItem .piImg { width: 40px; height: 52px; flex: none; border-radius: 5px; border: 1px solid #2a1a0a; background: #14100c; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .poolItem .piImg img { width: 100%; height: 100%; object-fit: cover; }
  .poolItem .piBody { min-width: 0; flex: 1; }
  .poolItem .piName { font-size: 12px; color: #e8d0a0; white-space: nowrap; overflow: hidden; }
  .poolItem .piMeta { font-size: 10px; color: #a98d55; margin-top: 2px; }
  .poolItem .piCnt { flex: none; font-size: 11px; color: #ffcf5a; background: rgba(0,0,0,.45); border-radius: 7px; padding: 1px 7px; }
  .poolItem.maxed { opacity: .5; cursor: not-allowed; }
  .poolItem.maxed:hover { transform: none; border-color: #5d3a18; }
  .deckList { min-width: 0; max-width: 100%; }   /* 右「我的卡组」1/5 */
  .deckSheet { border: 2px solid #6a4a24; border-radius: 9px; background: linear-gradient(#2a1a0b, #180e05); padding: 8px 10px; min-height: 240px; }
  /* 我的卡组：保持原有的「一行一张」列表排列（用户 2026-09-13 要求恢复；排序仍按费用） */
  .deckGrid { display: flex; flex-direction: column; gap: 2px; margin: 4px 0 2px; }
  .deckCount { font-size: 13px; letter-spacing: 1px; color: #e8c87a; margin-bottom: 6px; }
  .deckCount.bad { color: #ff7a6a; }
  .deckItem { display: flex; gap: 6px; align-items: center; padding: 3px 6px; border-radius: 6px; font-size: 12px; color: #d8c48e; cursor: pointer; }
  .deckItem:hover { background: rgba(255,220,140,.08); color: #f0d58a; }
  .deckItem .diCnt { flex: none; color: #ffcf5a; font-size: 12px; letter-spacing: .5px; }
  /* 费用角标（用户 2026-09-13：我的卡组要显示费用） */
  .deckItem .diCost { flex: none; min-width: 16px; text-align: center; font-size: 11px; line-height: 15px; color: #f0d58a;
                      background: rgba(0,0,0,.45); border: 1px solid #6a4a24; border-radius: 4px; padding: 0 2px; }
  .deckItem .diX { flex: none; margin-left: 4px; color: #8a6a3a; font-size: 13px; }
  .deckItem:hover .diX { color: #ff7a6a; }
  /* 行内「国家小旗」与「微缩卡图」都做成和字一样大（用户 2026-09-13） */
  .deckItem .natFlag.sm { margin: 0; }
  .deckItem .natFlag.sm img { width: auto; height: 1.05em; aspect-ratio: 22 / 15; border-radius: 2px; }
  .deckItem .diArt { flex: none; height: 1.35em; aspect-ratio: 470 / 660; border-radius: 2px; overflow: hidden;
                     background: #14100c; box-shadow: 0 0 0 1px rgba(0,0,0,.7); }
  .deckItem .diArt img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .deckItem .diArt canvas { width: 100%; height: 100%; display: block; }
  .rarity { font-weight: bold; letter-spacing: 1px; }
  .rarity.rgold { color: #ffcf5a; text-shadow: 0 0 6px rgba(255,200,80,.5); }
  .rarity.rsilver { color: #c9d4e8; }
  .rarity.rbronze { color: #d8945a; }
  .rarity.riron { color: #a8a8a0; }
  .deckWarn { font-size: 12px; letter-spacing: 1px; margin-top: 6px; line-height: 1.7; color: #ffb0a0; }
  .deckWarn.ok { color: #9fd48a; }
  .deckSlots { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }   /* 1/5 窄栏：槽位可换行 */
  .deckSlot { flex: 1 1 86px; min-width: 86px; text-align: center; padding: 6px 4px; border-radius: 8px; background: linear-gradient(#3a2410, #241407); border: 2px solid #5d3a18; cursor: pointer; font-size: 12px; color: #d8c48e; }
  .deckSlot.active { border-color: #f0d58a; color: #f0d58a; box-shadow: 0 0 12px rgba(232,200,122,.4); }
  .deckSlot .dsName { white-space: nowrap; overflow: hidden; }
  .deckSlot .dsMeta { font-size: 10px; color: #8a6a3a; margin-top: 2px; }
  .deckNameRow { display: flex; gap: 8px; margin: 8px 0; align-items: center; flex-wrap: wrap; }
  .deckNameRow input { flex: 1; min-width: 140px; font-family: inherit; font-size: 13px; letter-spacing: 1px; background: #1c1006; color: #f0d58a; border: 2px solid #5d3a18; border-radius: 7px; padding: 6px 10px; outline: none; }
  .deckNameRow input:focus { border-color: #e8c87a; }
  .smBtn { font-family: inherit; font-size: 12px; letter-spacing: 2px; padding: 5px 14px; cursor: pointer; background: linear-gradient(#6a4a24, #3a2410); color: #f0d58a; border: 2px solid #2a1808; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; }
  .smBtn:hover { filter: brightness(1.3); }
  /* 组卡器国家图标：小旗（国家/{国名}.png）标注每张卡的主国/盟国归属 */
  .natFlag { display: inline-flex; flex: none; vertical-align: middle; }
  .natFlag img { width: 22px; height: 15px; object-fit: cover; border-radius: 2px; box-shadow: 0 0 0 1px rgba(0,0,0,.7); }
  .natFlag.sm { margin-right: 4px; }
  .natFlag.sm img { width: 17px; height: 12px; border-radius: 2px; }
  .poolItem .piName { display: flex; align-items: center; }
  .poolItem .piName .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .deckItem .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .deckActions { text-align: center; margin-top: 10px; }
  .codexTabs { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-bottom: 10px; }
  /* 筛选条（图鉴/组卡器共用样式）：图标按钮（筛选用图标/{国家,类型,花费}） */
  .codexFilters, .deckFilters { display: flex; flex-wrap: wrap; gap: 6px 9px; align-items: center; justify-content: center; margin-bottom: 10px; }
  /* 组卡器：每组筛选独立一行（花费 / 类型 / 国家） */
  .deckFilters { flex-direction: column; align-items: stretch; gap: 5px; margin: 4px 0 10px; }
  .deckFilters .fltRow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  /* 组卡器：卡背选择器（每种卡背随机 1 张磨损图预览；中立/盟国暂不可用） */
  .backRow { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; margin: 0 0 8px; }   /* 1/5 窄栏：标签与预览可换行 */
  .backRow .fltLabel { line-height: 22px; }
  .backGrid { display: flex; flex-wrap: wrap; gap: 6px; max-height: 120px; overflow-y: auto; }
  .backOpt { width: 52px; height: 72px; flex: none; padding: 2px; border-radius: 6px; border: 2px solid #5d3a18; background: #241407; cursor: pointer; opacity: .78; transition: border-color .12s, opacity .12s, transform .1s; }
  .backOpt img { width: 100%; height: 100%; object-fit: cover; border-radius: 4px; display: block; }
  .backOpt:hover { opacity: 1; filter: brightness(1.15); }
  .backOpt.on { border-color: #f0d58a; box-shadow: 0 0 9px rgba(232,200,122,.55); opacity: 1; transform: translateY(-1px); }
  .fltLabel { font-size: 11px; letter-spacing: 2px; color: #8a6a3a; text-shadow: 0 1px 2px #000; min-width: 26px; }
  .fltBtn { min-width: 30px; height: 28px; padding: 2px 3px; border-radius: 7px; border: 2px solid #5d3a18; background: #241407; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; opacity: .7; transition: transform .1s, border-color .12s, opacity .12s; }
  .fltBtn img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .fltBtn:hover { filter: brightness(1.3); opacity: 1; }
  .fltBtn.on { border-color: #f0d58a; box-shadow: 0 0 9px rgba(232,200,122,.55); opacity: 1; transform: translateY(-1px); }
  .codexTab { display: flex; align-items: center; gap: 6px; padding: 5px 14px; border-radius: 18px; background: linear-gradient(#3a2410, #241407); border: 2px solid #5d3a18; cursor: pointer; font-size: 13px; letter-spacing: 2px; color: #d8c48e; }
  .codexTab.active { border-color: #f0d58a; color: #f0d58a; box-shadow: 0 0 10px rgba(232,200,122,.35); }
  .codexTab .ctImg { width: 22px; height: 15px; border-radius: 3px; border: 1px solid #5d3a18; background-size: cover; background-position: center; }
  .codexFilter { display: flex; gap: 8px; justify-content: center; margin-bottom: 10px; }
  .codexFilter input { width: 340px; max-width: 70vw; font-family: inherit; font-size: 13px; letter-spacing: 1px; background: #1c1006; color: #f0d58a; border: 2px solid #5d3a18; border-radius: 7px; padding: 6px 12px; outline: none; }
  .codexFilter input:focus { border-color: #e8c87a; }
  .codexGrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; max-width: 570px; margin: 0 auto; }  /* 一行 4 个、居中留白；卡面按 470:660 显示（≈132px 宽，比旧版 7 列时更小） */
  .codexCard { border-radius: 9px; padding: 5px 5px 7px; background: linear-gradient(170deg, #f2e5c0, #d3bd8e 60%, #b89e6a); border: 3px solid #4a2f14; cursor: pointer; transition: transform .15s, box-shadow .15s; text-align: center; }
  .codexCard.order { background: linear-gradient(170deg, #e8d4c0, #c2a088 60%, #a88462); }
  .codexCard:hover { transform: translateY(-4px) scale(1.03); box-shadow: 0 8px 16px rgba(0,0,0,.55); }
  .codexCard .cxImg { height: 74px; border-radius: 6px; background: #14100c; border: 1px solid #2a1a0a; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .codexCard .cxImg img { max-width: 100%; max-height: 100%; }
  .codexCard .cxName { margin-top: 3px; font-size: 12px; font-weight: bold; color: #3a2410; white-space: nowrap; overflow: hidden; }
  .codexCard .cxMeta { font-size: 10px; color: #7a5a2a; margin-top: 1px; }
  .v2modal { position: fixed; inset: 0; z-index: 75; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.78); }
  .v2modal.show { display: flex; }
  .v2modal .panel { width: 560px; max-width: 94vw; max-height: 84vh; overflow: auto; padding: 20px 26px; border-radius: 12px; background: linear-gradient(#2e1c0c, #1c1006); border: 3px solid #6a4a24; box-shadow: 0 0 40px rgba(0,0,0,.9); text-align: left; }
  .v2modal .cardHero { display: flex; gap: 14px; align-items: center; }
  .v2modal .cardHero .chImg { width: 108px; height: 148px; flex: none; border-radius: 9px; border: 3px solid #4a2f14; background: linear-gradient(170deg, #f2e5c0, #d3bd8e 60%, #b89e6a); padding: 5px; }
  .v2modal .cardHero.chOrder .chImg { background: linear-gradient(170deg, #e8d4c0, #c2a088 60%, #a88462); }
  .v2modal .cardHero .chImg .artbox { width: 100%; height: 96px; }
  .v2modal .chName { font-size: 19px; font-weight: bold; color: #f0d58a; letter-spacing: 2px; }
  .v2modal .chSub { font-size: 12px; color: #a98d55; margin-top: 4px; letter-spacing: 1px; line-height: 1.6; }
  .v2modal .chChips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
  .v2modal .chChips .tagBadge { font-size: 11px; }
  .v2modal .chDesc { margin-top: 10px; font-size: 13px; color: #d8c48e; line-height: 1.9; letter-spacing: .5px; border-top: 1px solid #4a3118; padding-top: 9px; }
  .v2modal .chNation { margin-top: 8px; font-size: 12px; color: #8ad0ff; letter-spacing: 2px; }
  .setRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 4px; border-bottom: 1px dashed #4a3118; font-size: 14px; letter-spacing: 1px; }
  .setRow:last-child { border-bottom: none; }
  .setRow .setCtrl { display: flex; gap: 8px; align-items: center; }
  .setRow select { font-family: inherit; font-size: 13px; background: #1c1006; color: #f0d58a; border: 2px solid #5d3a18; border-radius: 7px; padding: 4px 8px; outline: none; }
  .speedSeg { display: flex; border: 2px solid #5d3a18; border-radius: 8px; overflow: hidden; }
  .speedSeg button { font-family: inherit; font-size: 12px; padding: 4px 12px; background: #241407; color: #a98d55; border: none; cursor: pointer; }
  .speedSeg button.on { background: linear-gradient(#6a4a24, #3a2410); color: #f0d58a; }
  .dangerBtn { background: linear-gradient(#6a2424, #3a1010) !important; border-color: #8a2a2a !important; color: #ffb0a0 !important; }
  /* ===== 固定横屏：竖屏时旋转提示；禁止手势缩放 ===== */
  #rotateHint { position: fixed; inset: 0; z-index: 300; background: #100a05; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 14px; color: #f0d58a; font-size: 19px; letter-spacing: 4px; }
  #rotateHint .rhIcon { font-size: 58px; animation: rotateBob 1.5s ease-in-out infinite; }
  #rotateHint .rhSub { font-size: 12px; color: #a98d55; letter-spacing: 2px; }
  @keyframes rotateBob { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(90deg); } }
  @media (orientation: portrait) and (pointer: coarse) and (max-width: 940px) {
    #rotateHint { display: flex; }
    body { overflow: hidden; touch-action: none; }
  }
  /* 窄屏兜底：卡池自适应、图鉴降 2 列（横屏正常尺寸不受影响）
     注意：组卡器**任何宽度下都是左右并排**（用户 2026-09-13：我的卡组必须在右边，不许掉到下面） */
  @media (max-width: 560px) {
    .poolCards { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }   /* 窄屏：卡池自适应，最小 150px */
    .codexGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  #table, #overlay .ovview, #runOverlay, body { -webkit-text-size-adjust: 100%; }
  html, body { touch-action: manipulation; }
  #table { touch-action: manipulation; } /* 禁双击缩放；单指滚动保留 */
  /* ===== 全端统一：卡牌仅显示卡图，长按/双击查看数据 ===== */
  .card .cname, .card .ctype, .card .cstats, .card .csig, .card .ceff, .card .ceffect, .card .costs, .card .cflag { display: none !important; }
  .card { padding: 3px; }
  .card .artbox { width: 100%; height: 100%; margin: 0; }
  .card .artbox img { width: 100%; height: 100%; object-fit: contain; }
  .unit { padding: 0; }
  .unit .uinfo { display: none; }
  .unit .artbox { flex: 1; min-width: 0; width: 100%; height: 100%; }
  .unit .artbox img { width: 100%; height: 100%; object-fit: contain; }  /* 卡槽=卡面比例，完整显示无拉伸 */
  /* 单位攻/血/油角标：攻=左下 血=右下 油=左上（全端统一，仅数字） */
  .mmStats { display: inline-flex; align-items: center; gap: 1px; position: absolute; z-index: 3; font-size: 12px; font-weight: bold; background: rgba(0,0,0,.62); border-radius: 3px; padding: 0 4px; text-shadow: 0 1px 1px #000; }
  .mmStats.mAtk { left: 1px; bottom: 1px; color: #ff9a80; }
  .mmStats.mHp { right: 1px; bottom: 1px; color: #9ae39a; }
  .mmStats.mFuel { left: 1px; top: 1px; color: #8ad0ff; }
  .mullCard .mullName, .mullCard .mullCost { display: none !important; }
  .mullCard { width: 118px; }
  .mullCard img { height: 150px; object-fit: contain; }
  .codexCard .cxName, .codexCard .cxMeta { display: none; }
  .codexCard { padding: 3px; }
  .codexCard .cxImg { height: auto; aspect-ratio: 470 / 660; }
  .codexCard .cxImg img { width: 100%; height: 100%; object-fit: contain; }
  .poolItem { position: relative; padding: 3px; }
  .poolItem .piBody { display: none; }
  .poolItem .piImg { width: 100%; height: auto; aspect-ratio: 470 / 660; border: none; }
  .poolItem .piImg img { width: 100%; height: 100%; object-fit: contain; }
  .poolItem .piCnt { position: absolute; bottom: 4px; right: 6px; z-index: 3; background: rgba(0,0,0,.55); }
  .deckItem .nm { display: block; }   /* 卡图模式下「我的卡组」仍是列表：显示卡名 + *数量，不显示卡图 */
  .runMiniCard .rmName, .runMiniCard .rmStats, .runMiniCard .rmSig, .runMiniCard .rmEff { display: none; }
  .runMiniCard { padding: 3px; }
  .runMiniCard .rmImg { height: auto; aspect-ratio: 470 / 660; }
  .runMiniCard .rmImg img { width: 100%; height: 100%; object-fit: contain; }
  .runDraftCard .rdName, .runDraftCard .rdStats, .runDraftCard .rdSig, .runDraftCard .rdFrom { display: none; }
  .runDraftCard { padding: 4px; }
  .runDraftCard .rdImg { height: auto; aspect-ratio: 470 / 660; }
  .runDraftCard .rdImg img { width: 100%; height: 100%; object-fit: contain; }
  /* ===== 战场等比缩放（用户 2026-09-16：手机端战斗中比例失调）=====
     战场所有尺寸都改成 --bw（战场卡宽，桌面 = 96px 与旧值逐项等价）的倍数：
     窄窗口/矮屏只改 --bw 一个变量，卡槽·单位·总部·牌堆·手牌·字号一起等比缩放，
     不会再出现「棋盘比屏幕宽 → 横向溢出、其它元素原地不动」的比例失调。
     下限 56px：再小就靠纵向滚动，避免字缩到看不清。 */
  :root { --bw: 96px; }
  @media (max-width: 780px), (max-height: 600px) {
    :root { --bw: clamp(48px, min(calc((100vw - 44px) / 5.625), calc((100vh - 50px) / 9.3)), 96px); }
  }
  /* 手机横屏（屏高很矮）：省掉「AI 手牌预览」那一行 + 收紧上下留白，保证战场一屏装得下（手牌仍可横向滑动） */
  @media (max-height: 520px) {
    #aiHandRow { display: none; }
    #table { padding: 2px 6px 4px; }
    #hand { min-height: calc(var(--bw) * 1.5); padding-top: calc(var(--bw) * 0.05); }
    .pile { bottom: calc(var(--bw) * 1.9); }
  }
  .slot, .unit { width: var(--bw); height: calc(var(--bw) * 1.40625); }
  .cardback { width: calc(var(--bw) * 0.72917); height: calc(var(--bw) * 0.9375); }
  .row { gap: calc(var(--bw) * 0.0625); margin-bottom: calc(var(--bw) * 0.04167); }
  .row .rowwrap { gap: calc(var(--bw) * 0.0625); }
  .rowlabel { width: calc(var(--bw) * 0.3125); font-size: calc(var(--bw) * 0.11458); }
  .mmStats { font-size: calc(var(--bw) * 0.125); gap: 1px; }
  .unit .usig { font-size: calc(var(--bw) * 0.08333); max-height: calc(var(--bw) * 0.58333); }
  .unit .usig .sigIcon { width: calc(var(--bw) * 0.1875); height: calc(var(--bw) * 0.1875); }
  .unit .usig .sigNum { font-size: calc(var(--bw) * 0.09375); }
  .unit .uflag { font-size: calc(var(--bw) * 0.08333); }
  .hqchip { width: calc(var(--bw) * 1.35417); height: calc(var(--bw) * 1.875); }
  .hqchip .hqhp { font-size: calc(var(--bw) * 0.22917); }
  #phaseMsg { font-size: calc(var(--bw) * 0.15625); }
  #aiInfo, #pInfo { font-size: calc(var(--bw) * 0.13542); min-height: calc(var(--bw) * 0.1875); }
  #counters { font-size: calc(var(--bw) * 0.125); min-height: calc(var(--bw) * 0.16667); }
  #aiHandRow { min-height: calc(var(--bw) * 0.95833); gap: calc(var(--bw) * 0.10417); }
  #aiHand { gap: calc(var(--bw) * 0.0625); padding: calc(var(--bw) * 0.10417) 6px 0; }
  .aiCard { width: calc(var(--bw) * 0.625); height: calc(var(--bw) * 0.875); }
  .aiCard .bk .bkFlag img { width: calc(var(--bw) * 0.35417); height: calc(var(--bw) * 0.25); }
  .aiCard .bk .bkRib { font-size: calc(var(--bw) * 0.07292); }
  .aiCard.face .fname { font-size: calc(var(--bw) * 0.07813); }
  .pile { width: calc(var(--bw) * 1.04167); bottom: calc(var(--bw) * 2.1875); }
  .pile .pileStack { height: calc(var(--bw) * 1.33333); }
  .pile .pcard, .pile .pileStack .pslab { width: calc(var(--bw) * 0.83333); height: calc(var(--bw) * 1.14583); margin-left: calc(var(--bw) * -0.41667); }
  .pile .pcard .bkFlag img { width: calc(var(--bw) * 0.39583); height: calc(var(--bw) * 0.27083); }
  .pile .pileMeta { font-size: calc(var(--bw) * 0.11458); margin-top: calc(var(--bw) * 0.10417); }
  .pile .pileMeta .pileCnt { font-size: calc(var(--bw) * 0.13542); }
  #hand { gap: calc(var(--bw) * 0.08333); min-height: calc(var(--bw) * 1.64583); padding: calc(var(--bw) * 0.09375) 4px calc(var(--bw) * 0.04167); }
  .card { width: calc(var(--bw) * 1.04167); height: calc(var(--bw) * 1.54167); }
  .card .cname { font-size: calc(var(--bw) * 0.13542); }
  .card .costs { gap: calc(var(--bw) * 0.03125); }
  .card.order .ceffect { font-size: calc(var(--bw) * 0.10417); }
  .dmgFloat { font-size: calc(var(--bw) * 0.17708); }
  .dmgFloat.kill { font-size: calc(var(--bw) * 0.125); }
  .dmgFloat.hqfloat { font-size: calc(var(--bw) * 0.22917); }
  .fxCounterCard { width: calc(var(--bw) * 0.89583); top: calc(var(--bw) * 1.22917); }
  .fxCounterCard.fromP { left: calc(50% - var(--bw) * 2.79167); }
  .fxCounterCard.fromA { left: calc(50% + var(--bw) * 1.89583); }
  .fxCounterCard .fxcArt { height: calc(var(--bw) * 0.64583); }
  .fxCounterCard .fxcName { font-size: calc(var(--bw) * 0.11458); }
  .mullCard { width: calc(var(--bw) * 1.22917); }
  .mullCard img { height: calc(var(--bw) * 1.5625); }
</style>
</head>
<body>

<div id="loading"><div class="spin"></div><div class="ltext">战 场 加 载 中…</div></div>
<div id="rotateHint">
  <div class="rhIcon">📱</div>
  <div>请将设备横过来</div>
  <div class="rhSub">本游戏固定横屏游玩 · 已禁用捏合缩放</div>
</div>

<div id="table">
  <div id="topbar">
    <span id="turnInfo">卡兹铭刻 · 五国战场</span>
    <button id="helpBtn">规 则</button>
  <button id="setBtn" title="设置（音乐/音效音量 · 动画速度 · AI 难度）">设 置</button>
  </div>
  <!-- 敌方手牌（伪3D：未知牌显示对应国家卡背；彗星/航母战/航母打击群/卡罗纳多等明牌正面直显） -->
  <div id="aiHandRow">
    <span class="aiHandCap">敌 方 手 牌</span>
    <div id="aiHand"></div>
  </div>
  <div id="hqRow">
    <div class="hqchip" id="aiHqChip" data-act="hq" data-side="a" title="敌方总部">
      <div class="hqbg" id="aiHqBg"></div><div class="hqov"></div>
      <div class="hqname" id="aiHqName">敌总部</div><div class="hqhp" id="aiHqHp">20</div>
    </div>
    <div id="phaseMsg">你的回合</div>
    <div class="hqchip" id="pHqChip" data-act="hq" data-side="p" title="己方总部">
      <div class="hqbg" id="pHqBg"></div><div class="hqov"></div>
      <div class="hqname" id="pHqName">我总部</div><div class="hqhp" id="pHqHp">20</div>
    </div>
  </div>
  <div id="aiInfo">老牧师 · 生命 <b class="aihp">20</b> · 指挥点 <span class="aikredit">0</span> · 手牌 <span class="aihand">0</span> · 牌库 <span class="aideck">0</span></div>
  <div class="row" id="row0Wrap"><span class="rowlabel">敌底线</span><span id="row0" class="rowwrap"></span></div>
  <div class="row front" id="row1Wrap"><span class="rowlabel">前线</span><span id="row1" class="rowwrap"></span></div>
  <div class="row" id="row2Wrap"><span class="rowlabel">我底线</span><span id="row2" class="rowwrap"></span></div>
  <div id="pInfo">
    <span class="res kredit"><span class="dot"></span>指挥点 <b id="pKredit">0</b>/<i id="pSlot">0</i></span>
    生命 <b class="php">20</b> · 牌库 <span class="pdeck">0</span>
  </div>
  <div id="counters"></div>
  <!-- 左右牌堆：左=生产牌堆 右=卡组牌堆（按钮改为触碰牌堆发牌；背面为对应国家卡背） -->
  <!-- 注意：img 初始不带 src=""（空 src 会被浏览器当作加载当前页并报错，onerror 会永久藏图） -->
  <div class="pile pileL" id="prodPile" data-act="drawProd" title="生产牌堆 · 触碰发牌">
    <div class="pileStack"><div class="pcard"><span class="bkFlag"><img alt=""></span><img class="pArt" alt="" onerror="this.style.display='none'"></div></div>
    <div class="pileMeta">生 产 牌 堆<br><b class="pileCnt" id="prodPileCnt">5</b> 张</div>
  </div>
  <div class="pile pileR" id="deckPile" data-act="drawDeck" title="卡组牌堆 · 触碰发牌">
    <div class="pileStack"><div class="pcard"><span class="bkFlag"><img alt=""></span><img class="pArt" alt="" onerror="this.style.display='none'"></div></div>
    <div class="pileMeta">卡 组 牌 堆<br><b class="pileCnt" id="deckPileCnt">40</b> 张</div>
  </div>
  <div id="log"></div>
  <div id="hand"></div>
  <div id="actions"><button id="endTurn">结束回合</button><button id="surrenderBtn" title="快速结束本局（视为战败）">投 降</button></div>
</div>

<div id="overlay">
  <!-- 主菜单（仅按钮） -->
  <div id="ovMenu" class="ovview">
    <button id="settingsBtn" data-act="settingsOpen" title="设置">⚙</button>
    <h1>卡 兹 铭 刻</h1>
    <div class="sub">KADMIN · KARDS × 邪恶铭刻 同人桌游</div>
    <div class="flavor" id="ovFlavorMenu">雨夜。烛火。森林深处的礼拜堂。<br>牌桌上摊开五面军旗，老牧师推了推鼻梁上的眼镜。<br>「选一个去路吧，客人。狼群已经到前线了。」</div>
    <div id="ovResult"></div>
    <div class="menuBtns">
      <button class="bigbtn menuBtn" data-act="btnFree">自 由 对 战</button>
      <button class="bigbtn menuBtn" data-act="btnBoss">Boss 挑 战</button>
      <button class="bigbtn menuBtn" data-act="btnDeck">组 卡</button>
      <button class="bigbtn menuBtn" data-act="btnCodex">图 鉴</button>
    </div>
    <div>
      <button class="bigbtn" id="btnRematch" data-act="btnRematch" style="display:none">再 战 一 局</button>
      <button class="bigbtn" id="helpBtn2">规 则</button>
    </div>
  </div>
  <!-- Boss 挑战：选择 Boss -->
  <div id="ovBoss" class="ovview hidden">
    <h1 id="ovBossTitle">Boss 挑 战</h1>
    <div class="sub">击败要塞，或溺于泪海</div>
    <div class="bossPickList" id="bossPickList"></div>
    <div style="text-align:center">
      <button class="bigbtn" data-act="bossBack">返 回 菜 单</button>
    </div>
    <style>
      .bossPickList{display:flex;gap:26px;justify-content:center;flex-wrap:wrap;margin:22px 0;}
      .bossCard{width:290px;padding:18px;border-radius:14px;cursor:pointer;text-align:center;
        background:linear-gradient(170deg,#2c2115,#171009 70%);border:2px solid #6b5333;
        box-shadow:0 8px 22px rgba(0,0,0,.6);transition:transform .18s,border-color .18s,box-shadow .18s;}
      .bossCard:hover{transform:translateY(-6px);border-color:#f0d58a;box-shadow:0 0 26px rgba(240,200,120,.35),0 12px 26px rgba(0,0,0,.7);}
      .bossName{font-size:22px;letter-spacing:6px;color:#f0d58a;text-shadow:0 2px 6px #000;margin-bottom:8px;}
      .bossLine{font-size:12px;letter-spacing:2px;color:#c9ab6e;margin-bottom:10px;}
      .bossFlavor{font-size:12px;line-height:1.7;color:#9a8560;}
    </style>
  </div>
  <!-- 选卡组（自由对战 / Boss 出战共用；原选国页） -->
  <div id="ovNation" class="ovview hidden">
    <h1 id="ovNationTitle">选 择 卡 组</h1>
    <div class="sub" id="ovNationSub">选择你的出战卡组</div>
    <div class="flavor" id="ovFlavor">雨夜。烛火。森林深处的礼拜堂。<br>桌面上摊开你的卡组：五国初始，或亲手编排的战群。<br>选一份，然后坐吧。狼群已经到前线了。</div>
    <div id="nationPicker"></div>
    <div>
      <button class="bigbtn" id="randomBtn">随 机 卡 组</button>
      <button class="bigbtn" id="backBtn">返 回 菜 单</button>
    </div>
  </div>
  <!-- 组卡器 -->
  <div id="ovDeck" class="ovview hidden">
    <h1>组 卡</h1>
    <div class="sub">以一国之力，整装待发</div>
    <div id="deckBox"></div>
  </div>
  <!-- 图鉴 -->
  <div id="ovCodex" class="ovview hidden">
    <h1>图 鉴</h1>
    <div class="sub">战火中刻下的每一张牌</div>
    <div id="codexTabs" class="codexTabs"></div>
    <div id="codexFilters" class="codexFilters"></div>
    <div class="codexFilter"><input id="codexQuery" type="text" placeholder="搜索：卡名 / 类型 / 词条 / 效果关键词…"></div>
    <div id="codexGrid" class="codexGrid"></div>
    <div style="text-align:center">
      <button class="bigbtn" data-act="backMenu">返 回 菜 单</button>
    </div>
  </div>
</div>

<!-- 图鉴卡详情 / 设置 modal -->
<div id="modal" class="v2modal">
  <div class="panel" id="modalPanel"></div>
</div>

<div id="help">
  <div class="panel">
    <h2>对 局 规 则</h2>
    <p><b>胜利条件</b>：摧毁敌方总部（双方各 20 点生命，显示在双方总部上）。</p>
    <p><b>阵营</b>：五国卡池为真实 KARDS 卡牌（按《文档.txt》数据）。</p>
    <p><b>战场</b>（3×5 共享棋盘）：第一行敌方底线、第二行前线、第三行我方底线。<b>前线封锁</b>：前线被对方占领则无法推进。牌桌两侧是牌堆：<b>左侧生产牌堆、右侧卡组牌堆</b>（牌堆背面是己方国家卡背，内容未知）。</p>
    <p><b>摸牌</b>：每回合开始<b>必须先摸牌</b>——触碰左侧生产牌堆或右侧卡组牌堆即可发牌，摸完才能行动。生产牌为 0 费指令「生产」，打出后获得 1 指挥点（生产牌堆共 5 张）。敌方手牌未知（仅见对方国家卡背）；抽到明牌（如彗星、航母战、航母打击群、卡罗纳多等触发特效的牌）会正面显示。</p>
    <p><b>资源（指挥点）</b>：指挥点槽每回合 +1（初始第 1 回合为 1），每回合开始获得等同于指挥点槽的指挥点，<b>不保留</b>上回合剩余指挥点。<b>部署、推进（移动）与攻击</b>均消耗其行动花费（卡面小数字）的指挥点。</p>
    <p><b>类型</b>：<b>步兵/坦克</b>=只能攻击相邻战线（底线地面打敌前线；前线地面打敌底线）；<b>炮兵</b>=攻击不受反击、能攻击被守护的单位；<b>战斗机</b>=可攻击任意阵线（含敌方后线）并封锁轰炸机（敌方战斗机所在战线的单位无法被轰炸机攻击）；<b>轰炸机</b>=可攻击任意阵线、攻击不受反击、能攻击被守护的单位，但被敌方战斗机拦截（无法攻击战斗机所在战线的非战斗机单位）。</p>
    <p><b>词条</b>：<b>闪击</b>=落地当回合即可行动（移动或攻击，二选一）；<b>守护</b>=保护相邻单位与总部——地面单位（炮兵/轰炸机/战斗机除外）必须先攻击守护单位、无法攻击其相邻单位与总部；<b>重甲X</b>=受到伤害-X；<b>伏击</b>=每回合首次被攻击时先反击；<b>烟幕</b>=无法被攻击，移动或攻击后失去；<b>奋战</b>=一回合可攻击两次；<b>协力</b>=使用该卡牌时，除非回合开始时场上有相同国家的友方单位，否则总部受到 1 点士气伤害（无法减免）。</p>
    <p><b>战线</b>：双方<b>不能共用前线</b>——前线被对方占领则无法推进；敌方总部视为后线（打穿战线后可攻击）。</p>
    <p><b>部署与推进</b>：部署只能进己方底线（付部署费）。<b>推进</b>：点击己方底线单位（蓝框=可推进），再点击前线空槽（金色高亮）即推进——前线单位不能自行撤回后线。落地当回合不能移动或攻击（<b>闪击</b>/坦克、「本单位能移动并攻击」的除外）。</p>
    <p><b>指令</b>：单次效果，多数自动选择目标。反制卡（紫色标记）激活后等待敌方触发条件。</p>
    <p><b>操作</b>：点击手牌→点己方底线空槽；点己方单位→点敌方单位攻击，或点前线空槽推进；Esc 取消。</p>
    <button class="bigbtn close" id="helpClose">收 起</button>
  </div>
</div>

<div id="toast"></div>

<!--SCRIPT-->
</body>
</html>
`;

/* ---------- 校验：node --check 逐文件语法检查 ----------
   注：stdio: 'inherit' —— 在受限沙箱下 pipe 捕获会被拒（EPERM），
   inherit 直接把子进程输出透传到终端，状态码仍可读取。 */
function checkSyntax(file){
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if(r.status !== 0){
    console.error('[失败] node --check ' + path.basename(file));
    process.exit(1);
  }
  console.log('[通过] node --check ' + path.basename(file));
}

/* ---------- 构建 ---------- */
const parts = [];
for(const f of LOAD_ORDER){
  const p = SRC(f);
  if(!fs.existsSync(p)){ console.error('[失败] 缺少源文件 ' + p); process.exit(1); }
  checkSyntax(p);
  const code = fs.readFileSync(p, 'utf8');
  parts.push('/* ================== src/' + f + ' ================== */');
  parts.push(code);
}
const bundle = parts.join('\n\n');
/* 整包语法再编译一次（new Function 只编译不执行，捕捉重名/残留问题） */
try { new Function(bundle); } catch(e){ console.error('[失败] 拼接产物编译错误：' + e.message); process.exit(1); }
console.log('[通过] 拼接产物编译检查（' + bundle.split('\n').length + ' 行）');

/* ---------- 图片内嵌（单文件分享：角色卡图/总部/生产全部 base64 进 HTML） ---------- */
const IMG_MIME = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif' };
function collectImages(dir, out = {}){
  for(const e of fs.readdirSync(dir, { withFileTypes: true })){
    const p = path.join(dir, e.name);
    if(e.isDirectory()) collectImages(p, out);
    else if(IMG_MIME[path.extname(e.name).toLowerCase()]){
      const key = path.relative(__dirname, p).replace(/\\/g, '/'); // 如 卡牌/美/xxx.png
      const buf = fs.readFileSync(p);
      // 压缩后的 .png 实际是 JPEG 字节：按内容嗅探 MIME（data URI 不能错标，否则部分环境不渲染）
      const mime = (buf[0] === 0xFF && buf[1] === 0xD8) ? 'image/jpeg' : IMG_MIME[path.extname(e.name).toLowerCase()];
      out[key] = 'data:' + mime + ';base64,' + buf.toString('base64');
    }
  }
  return out;
}
const IMG_MAP = collectImages(path.join(__dirname, '卡牌'));
collectImages(path.join(__dirname, '装饰', '总部'), IMG_MAP);
collectImages(path.join(__dirname, '装饰', '卡背'), IMG_MAP);   // 国家卡背（选卡组/牌堆/敌方手牌）
collectImages(path.join(__dirname, '筛选用图标'), IMG_MAP);    // 筛选图标：国家/类型/花费/版本
collectImages(path.join(__dirname, '装饰', '桌面'), IMG_MAP);  // 桌面背景：初始桌面 + 总部对应桌布
collectImages(path.join(__dirname, '装饰', '词条'), IMG_MAP);  // 词条图标：闪击/守护/压制/重甲……（文件名=词条中文名）
/* 词条图标表：装饰/词条/{词条名}.png → { 闪击:'装饰/词条/闪击.png', ... }（缺图时 UI 回退文字） */
const SIG_ICONS = {};
for(const k of Object.keys(IMG_MAP)){
  const m = k.match(/^装饰\/词条\/([^/]+)\.(png|jpg|jpeg|webp)$/i);
  if(m) SIG_ICONS[m[1]] = k;
}
/* 卡背：中立素材暂不可用——移除（体积过大且不进入选择列表）；盟国卡背保留（新国家只能当盟国） */
for(const k of Object.keys(IMG_MAP)){
  if(k.startsWith('装饰/卡背/中立/')) delete IMG_MAP[k];
}
/* 卡背目录 → 结构化数据：{id:'德:德国基础', nation:'德', name:'德国基础', wears:[...]}
   name = 文件名去掉尾部 _磨损序号；纹理图（roughness/normal/metal 等）不收录；
   盟国卡背（装饰/卡背/盟国/{波,法,芬,意}/{poland|france|finland|italy}_{a|b|c}.png）
   归到各自国家目录码下，名称统一为「{中文名}基础」 */
const ALLY_BACK_DIRS = { 波:'波兰', 法:'法国', 芬:'芬兰', 意:'意大利' };
const BACK_NATION_ORDER = { 德:0, 日:1, 美:2, 苏:3, 英:4, 波:5, 法:6, 芬:7, 意:8 };
function computeCardBacks(map){
  const backs = {};
  for(const key of Object.keys(map)){
    let grp = null, base = null;
    const mAlly = key.match(/^装饰\/卡背\/盟国\/([^/]+)\/([^/]+)\.png$/);
    if(mAlly && ALLY_BACK_DIRS[mAlly[1]]){
      grp = mAlly[1];
      base = ALLY_BACK_DIRS[mAlly[1]] + '基础';        // poland_a → 波兰基础
    } else {
      const m = key.match(/^装饰\/卡背\/([^/]+)\/([^/]+)\.png$/);
      if(!m) continue;
      if(m[1] === '中立' || m[1] === '盟国') continue;
      grp = m[1];
      base = m[2];
      if(/(roughness|normal|metal|metallic|_uv)/i.test(base)) continue;
      base = base.replace(/_\d+$/, '');
    }
    const id = grp + ':' + base;
    (backs[id] = backs[id] || { id, nation: grp, name: base, wears: [] }).wears.push(key);
  }
  return Object.values(backs)
    .sort((a,b)=> ((BACK_NATION_ORDER[a.nation]??9) - (BACK_NATION_ORDER[b.nation]??9)) || a.name.localeCompare(b.name,'zh'))
    .map(b => ({ ...b, wears: b.wears.sort() }));
}
const CARD_BACKS = computeCardBacks(IMG_MAP);
/* ---------- 桌面背景数据 ----------
   初始桌面（含默认）：默认兼初始桌面_4.png 为菜单/默认背景；
   总部对应桌布：按总部场景名匹配（场景基名=桌布名，如 地堡_德国→地堡.png），
   没有对应桌布时对局随机取初始桌面之一（ui 层逻辑）。 */
const DESK_INITIAL = Object.keys(IMG_MAP).filter(k => /^装饰\/桌面\/[^/]+桌面_\d+\.png$/.test(k)).sort();
const DESK_DEFAULT_KEY = '装饰/桌面/默认兼初始桌面_4.png';
const DESK_TABLE = {};
for(const k of Object.keys(IMG_MAP)){
  const m = k.match(/^装饰\/桌面\/总部对应桌布\/([^/]+)\.png$/);
  if(m) DESK_TABLE[m[1]] = k;
}
/* ---------- 总部卡图：印字位置测量（RGBA PNG 解码 → 中部亮块 bbox） ----------
   对局显示数字前用黑幕盖住卡图上印刷的数字；数据随每张场景图自动生成（HQ_NUM_MASK），
   并生成每国场景列表（HQ_SCENES，对局随机取景）。 */
function pngRGBA(file){
  const buf = fs.readFileSync(file);
  if(buf.readUInt32BE(0) !== 0x89504E47) return null;
  let off = 8, w = 0, h = 0, bit = 0, color = 0;
  const idat = [];
  while(off < buf.length){
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if(type === 'IHDR'){ w = data.readUInt32BE(0); h = data.readUInt32BE(4); bit = data[8]; color = data[9]; }
    else if(type === 'IDAT') idat.push(data);
    else if(type === 'IEND') break;
    off += 12 + len;
  }
  if(bit !== 8 || color !== 6 || !w || !h) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4, out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for(let y = 0; y < h; y++){
    const ft = raw[pos++];
    for(let i = 0; i < stride; i++){
      const a = i >= 4 ? out[y * stride + i - 4] : 0;
      const b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      let v = raw[pos + i];
      if(ft === 1) v = (v + a) & 255;
      else if(ft === 2) v = (v + b) & 255;
      else if(ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if(ft === 4){ const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255; }
      out[y * stride + i] = v;
    }
    prev = out.subarray(y * stride, y * stride + stride);
    pos += stride;
  }
  return { w, h, data: out };
}
const HQ_NUM_MASK = {};
const HQ_SCENES = {};
(function scanHq(){
  const stack = [path.join(__dirname, '装饰', '总部')];
  while(stack.length){
    const dir = stack.pop();
    for(const e of fs.readdirSync(dir, { withFileTypes: true })){
      const p = path.join(dir, e.name);
      if(e.isDirectory()) stack.push(p);
      else if(e.name.toLowerCase().endsWith('.png')){
        const rel = path.relative(__dirname, p).replace(/\\/g, '/');
        const parts = rel.split('/');
        const nat = parts[2] || 'us';
        const px = pngRGBA(p);
        let mask = null;
        if(px){
          const x1 = Math.floor(px.w * 0.36), x2 = Math.ceil(px.w * 0.64);
          const y1 = Math.floor(px.h * 0.42), y2 = Math.ceil(px.h * 0.74);
          let mnX = 1e9, mxX = -1, mnY = 1e9, mxY = -1, n = 0;
          for(let y = y1; y < y2; y++) for(let x = x1; x < x2; x++){
            const i = (y * px.w + x) * 4;
            const lum = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
            if(lum > 165){ if(x < mnX) mnX = x; if(x > mxX) mxX = x; if(y < mnY) mnY = y; if(y > mxY) mxY = y; n++; }
          }
          if(n > 50){
            const pad = Math.max(2, Math.round(Math.min(mxX - mnX, mxY - mnY) * 0.04));
            mask = {
              x: +(((mnX - pad) / px.w) * 100).toFixed(2),
              y: +(((mnY - pad) / px.h) * 100).toFixed(2),
              w: +(((mxX - mnX + 1 + pad * 2) / px.w) * 100).toFixed(2),
              h: +(((mxY - mnY + 1 + pad * 2) / px.h) * 100).toFixed(2)
            };
          }
        }
        if(mask) HQ_NUM_MASK[rel] = mask;
        (HQ_SCENES[nat] = HQ_SCENES[nat] || []).push(rel);
      }
    }
  }
})();
/* 音频内嵌（背景音乐等：角色/音乐/** 下的 mp3/ogg/wav/m4a 全部 base64 进 HTML） */
const AUDIO_MIME = { '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav', '.m4a':'audio/mp4' };
function collectAudio(dir, out = {}){
  for(const e of fs.readdirSync(dir, { withFileTypes: true })){
    const p = path.join(dir, e.name);
    if(e.isDirectory()) collectAudio(p, out);
    else if(AUDIO_MIME[path.extname(e.name).toLowerCase()]){
      const key = path.relative(__dirname, p).replace(/\\/g, '/');
      out[key] = 'data:' + AUDIO_MIME[path.extname(e.name).toLowerCase()] + ';base64,' + fs.readFileSync(p).toString('base64');
    }
  }
  return out;
}
const AUDIO_MAP = collectAudio(path.join(__dirname, '音乐'));
const BUILD_ID = new Date().toISOString().slice(0, 16).replace('T', ' ');
const IMG_JS = 'const IMG_MAP = ' + JSON.stringify(IMG_MAP) + ';\n' +
  'const BUILD_ID = ' + JSON.stringify(BUILD_ID) + ';\n' +
  'const CARD_BACKS = ' + JSON.stringify(CARD_BACKS) + ';\n' +
  'const HQ_NUM_MASK = ' + JSON.stringify(HQ_NUM_MASK) + ';\n' +
  'const HQ_SCENES = ' + JSON.stringify(Object.fromEntries(Object.entries(HQ_SCENES).map(([k,v])=>[k,v.sort()]))) + ';\n' +
  'const DESK_INITIAL = ' + JSON.stringify(DESK_INITIAL) + ';\n' +
  'const DESK_DEFAULT_KEY = ' + JSON.stringify(DESK_DEFAULT_KEY) + ';\n' +
  'const DESK_TABLE = ' + JSON.stringify(DESK_TABLE) + ';\n' +
  'const SIG_ICONS = ' + JSON.stringify(SIG_ICONS) + ';\n' +
  'const AUDIO_MAP = ' + JSON.stringify(AUDIO_MAP) + ';\n' +
  "const imgUrl = rel => { const k = rel.replace(/\\\\/g,'/'); return IMG_MAP[k] || encodeURI(k); };\n" +
  "const audioUrl = rel => { const k = rel.replace(/\\\\/g,'/'); return AUDIO_MAP[k] || encodeURI(k); };";
// 注入图片映射：匹配 src/ui.js 的 imgUrl 定义行（单行实现，容许三元/函数体/空值保护等写法）
let bundleFinal = bundle.replace(/const imgUrl = rel =>[^\n]*;/, IMG_JS);
if(bundleFinal === bundle) bundleFinal = bundle.replace(/const imgUrl = rel => encodeURI\(rel\.replace\(.*?\)\);/, IMG_JS);
if(bundleFinal === bundle){ console.error('[失败] 未找到 imgUrl 定义，跳过图片内嵌'); bundleFinal = bundle; }
else {
  try { new Function(bundleFinal); } catch(e){ console.error('[失败] 内嵌后编译错误：' + e.message); process.exit(1); }
  console.log('[通过] 图片内嵌 ' + Object.keys(IMG_MAP).length + ' 张（' + Math.round((bundleFinal.length-bundle.length)/1024) + ' KB 增量）');
  console.log('[通过] 音频内嵌 ' + Object.keys(AUDIO_MAP).length + ' 个（' + Math.round((bundleFinal.length-bundle.length)/1024) + ' KB 含音频）');
}

const html = TEMPLATE.replace(
  '<!--SCRIPT-->',
  '<script>\n/* 本文件由 build.mjs 从 src/*.js 拼接生成，请勿直接编辑源码；修改请改 src/ 后重新运行 node build.mjs */\n' +
  bundleFinal + '\n</script>'
);
fs.writeFileSync(OUT, html, 'utf8');
console.log('[完成] 已写出 ' + OUT + '（' + html.length + ' 字节）');
