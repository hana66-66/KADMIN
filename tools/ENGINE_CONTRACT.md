# 无头引擎对接基准（落地版）

> 本文档由 QA 验证官（t3）更新。t1 实际交付形态 = **模块态**（HTML 逐行等价重构），
> 与 `tools/engineAdapter.mjs` 的归一化层共同构成 t3/t5 的对接基准。
> 引擎工程师后续若要改 API，只需保证导出名仍在（或同步改 adapter），sim/verify 无需变动。

---

## 1. 实际交付（t1，2026-08-27 16:05+）

| 文件 | 形态 | 关键导出 |
|---|---|---|
| `src/cards.js` | CJS，零 DOM（canvas 除外） | `NATIONS`（5 国原始卡池数据）、`SIGINFO`、`TYPEINFO`、`pathFor`、`unitDesc`、`orderDesc`、`counterDesc`、`ART`、`drawSprite` |
| `src/engine.js` | CJS，零 DOM；**全局单实例状态 `const S`**；引擎/UI 全部耦合收口到 `HOOKS` | `S`、`HOOKS`（`onLog/onSfx/onRender/wait/toast/onGameEnd`）、**`GAME_RULES`（v2 战场规则钩子：`{enemyExtraDraw:0, playerKreditShift:0, hqHpBonus:{a:0,p:0}, enemyStatMul:1}`，默认=现有行为等价）**、`resetGameState`、`startGame`、`spawnUnit`、`moveForward`、`combat`、`orderEffect`、`activateCounter`、`drawCards`、`attackTargets`、`canAct`、`killUnit`、`applySuppress`、`beginPlayerTurn`、`endPlayerTurn`、`startAiTurn`（async，await `HOOKS.wait`）、`resetUnitFlags`、`clearSuppress`、`checkGameOver`、`emptyBacklineSlot`、`orderTargets`、`enemyList`/`allyList`、`makeUnit`、`unitAt`、`buildDeck`、`mkUnitDef`… |
| `src/ai.js` | CJS；**仅 a 侧**，直接操作全局 `S`；Node 下 `Object.assign(globalThis, engine+自身)` | `aiChoosePlay()`、`aiAttackTarget(r,c,u,tgts)`、`aiPickOrderTarget`、`aiFindSlot`、`aiSacTarget`、`aiNeedBlood`、**`AI_DIFFICULTY`（默认 'veteran'；recruit=veteran+20% 失误，warder=进阶）、`setAI_DIFFICULTY(d)`** |
| `src/ui.js` / `src/main.js` | 浏览器层（installHooks/bindInput/boot），Node 不加载 | — |

引擎语义 = 旧 HTML 固定后版本（A1/A2/A3、B1/B2、B6/B7 均已修复；B3/B4/B5/B8 保留现状）。

## 2. 关键实现细节（适配器已按此对接）

- **状态**：`S = { turn, wins, losses, phase('idle'|'player'|'ai'|'over'), mode, over, log[], pNation, aNation, board(3×5), p, a }`；双方 Player = `{ hp, maxHp, kredit, kreditSlots, hand[], deck[], counters[], prodDeck[5], fatigue }`。
- **费用扣除**：引擎不在 `spawnUnit/orderEffect/activateCounter` 内扣指挥点（调用方扣）；`moveForward/combat` 内部扣油费。适配器把部署/指令/反制的费用统一移到 `eng.*` 包装内（校验后可负担，扣费在成功之后）。
- **胜负**：`checkGameOver → endGame(winner)` 只发 `HOOKS.onGameEnd(winner)`、++wins/losses，**不写 S.winner**。适配器在 `HOOKS.onGameEnd` 中落 `S.winner`（sim 统计依赖）。
- **v2 战场规则钩子**：`GAME_RULES` 由适配器**每局强制归零**（默认全零，sim/verify 以零加成对局为准；战役规则由 t6 引擎侧按需设置）。`ai.js` 难度档：适配器不动，sim 支持 `--difficulty=` 调 `setAI_DIFFICULTY`。
- **回合计数**：仅玩家侧 `beginPlayerTurn()` 时 `turn++`（每轮 1 次）。
- **hqCap（国家消防局）**：所有者下回合开始移除 — 适配器在 `beginTurn(side)` 过滤 `S[side].counters` 的 `hqCap`（与 HTML 行 951/1023 等价）。
- **压制**：`clearSuppress(side)` 于该侧回合结束（适配器 `endTurn(side)`）。
- **HOOKS.wait**：引擎 `startAiTurn` `await HOOKS.wait(x)` — 无头下适配器设为同步 `() => undefined`（立即返回）。

## 3. 归一化接口（sim.mjs / verify.mjs 消费）

```js
import { loadEngine } from './engineAdapter.mjs';
const loaded = await loadEngine();          // { ok, reason, source, factory, NATIONS, mod, ai }
const eng = loaded.factory.fn({ pNation, aNation, rng, hooks, log });  // → 规范引擎实例
eng.state                        // 引擎全局 S（可读可写，场景测试直接改）
eng.drawCards(side,n) / drawProduce(side) / hideDraw()
eng.spawnUnit(side,card,row?,col?) / moveForward(side,r,c) / combat(att,tgt)
eng.orderEffect(card,tgt,side) / activateCounter(side,card)
eng.attackTargets(side,r,c) / canAct(side,r,c) / killUnit(r,c) / applySuppress(u)
eng.beginTurn(side) / endTurn(side) / checkGameOver() / unitAt / makeUnit
eng.ai = { choose(side), attack(side,r,c,u,tgts), push(side) }
//   choose/attack 在 a 侧走 src/ai.js 原实现；p 侧与缺省走同策略镜像（generic）
eng.destroy()                     // 预留
```

随机性：`opts.rng`（`() => [0,1)`）→ 适配器在对局期间替换 `Math.random`（洗牌/战斗随机/部署随机确定化）。

## 4. verify.mjs 场景约定

- 摆盘直置：`ctx.place(eng, side, nationKey, cardId, row, col, { summoned?, suppressed?, ... })` — 经 `eng.makeUnit` 直摆（**不**触发部署效果/反制/光环/费用），再清旗标。
- 需触发部署/光环的场景：`ctx.spawn(...)`/`eng.spawnUnit(...)`（**会**触发部署效果与反制，需先 `ctx.kredit(eng, side, n)`）。
- 断言：`ctx.at(eng, r, c)` 取单位；失败自动输出棋盘/状态 dump。

## 5. 已知待办（与引擎相关的验证发现，已报 captain）

1. ~~F1 烟幕反转~~ —— **已修复（t1 16:29）**：`smokeHidden = x => !x.smokeOut && (…)`，T6 通过。
2. ~~F2 落地推进~~ —— **已修复（t1 16:29）**：`moveForward` 拦截 `summonedThisTurn && !blitz && !tank && !moveNattack`，T5 通过。
3. **坦克落地攻击（语义保留）**：`canAct` 对 `summonedThisTurn && !blitz` 一律 false（坦克不豁免）；规则"坦克能在同一回合移动并攻击"。属 HTML 基线继承，待主线确认（T5 INFO 记录）。
4. **AI vs AI 退化**：ai.js 生产优先 + 指令杀单位 + 直击总部 → 对局 10-21 回合、先手方系统性全胜（确定性 sweep）。属 AI 策略观察（AI_DIFFICULTY 三档已出，sim 支持 --difficulty 切换）；不影响 sim/verify 工具链正确性。
5. **战役接口（t6 前置）**：`buildCampaignDeck`/`S.aiDifficulty`/`S.battleRules` 尚未落地（引擎当前为 `GAME_RULES` 全局钩子，默认全零，适配器每局强制归零）。t6 落地后：verify 增加"钩子不抛错"烟雾断言（T20 预留），sim 增加战役模式参数（暂不实现）。
