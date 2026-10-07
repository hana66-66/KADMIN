// fixtures/mock-engine-full.js —— 真实卡池 + 简化规则的样例引擎（仅用于工具链全量自检）
// ⚠️ 不是正式引擎：规则仍是 mock 简化版，但卡池数据为《铭刻前线》真实数值，
//    用于在 t1 交付前"预演" verify.mjs T-* 场景（卡牌解析/摆放/战斗签名/状态形状）。
// 用法：node tools/verify.mjs --engine=tools/fixtures/mock-engine-full.js --ai=tools/fixtures/mock-ai.js
import { makeEngine, buildDeckFor } from './mock-engine.js';
import { NATIONS } from './card-data.js';

const _engine = makeEngine(NATIONS);
export { NATIONS };
export const buildDeck = (k, rng) => buildDeckFor(NATIONS, k, rng);
export const createGame = _engine.createGame;
