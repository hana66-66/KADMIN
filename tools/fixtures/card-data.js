// fixtures/card-data.js —— 《铭刻前线》真实卡池数据（转录自 角色/文档.txt × 5 份，字段与旧 HTML NATIONS 同构）
// 用途：供 fixtures/mock-engine-full.js 使用，让 verify.mjs 的 T-* 场景在 t1 交付前也能用真实数值自检。
// 字段：单位 {id,n,t,c,f,a,h,s,r,e,d,target}; 指令 {id,n,c,e,target}; 反制 {id,n,c,e}
export const NATIONS = {
  us: { name: '美国', hq: '', units: [
    { id: 'b17', n: 'B-17飞行堡垒', t: 'bomber', c: 8, f: 3, a: 5, h: 5, r: 1, d: 'elimRand' },
    { id: 'p51', n: 'P-51野马', t: 'fighter', c: 6, f: 2, a: 6, h: 4, d: 'dmgFlyRand5' },
    { id: 'p40', n: 'P-40战鹰', t: 'fighter', c: 3, f: 2, a: 2, h: 3, e: ['vsArmy3'] },
    { id: 'm7', n: 'M7牧师', t: 'artillery', c: 3, f: 1, a: 2, h: 2, d: 'frontAlly11' },
    { id: 'f4u', n: 'F4U-1C海盗', t: 'fighter', c: 5, f: 2, a: 4, h: 6 },
    { id: 'b25', n: 'B-25米切尔', t: 'bomber', c: 6, f: 3, a: 4, h: 5, d: 'dmgRand3' },
    { id: 'm18', n: 'M18地狱猫', t: 'tank', c: 3, f: 1, a: 4, h: 2, s: ['blitz'], e: ['vsTank2x'] },
    { id: 'sbd', n: 'SBD 3 无畏', t: 'bomber', c: 3, f: 2, a: 3, h: 3, r: 1 },
    { id: 'r17', n: '第17步兵团', t: 'infantry', c: 2, f: 1, a: 2, h: 2, d: 'ally11', target: 'friendly' },
    { id: 'r506', n: '第506空降步兵团', t: 'infantry', c: 1, f: 1, a: 2, h: 2 },
  ], orders: [
    { id: 'gunboat', n: '炮艇任务', c: 2, e: 'gunboat', target: 'enemy-backline' },
    { id: 'deathfromabove', n: '死神降临', c: 4, e: 'deathFromAbove' },
    { id: 'warmachine', n: '战争机器', c: 2, e: 'warMachine' },
  ], counters: [
    { id: 'spot', n: '发现敌人', c: 1, e: 'spotEnemy' },
  ] },
  de: { name: '德国', hq: '', units: [
    { id: 'leopold', n: '利奥波德', t: 'artillery', c: 10, f: 3, a: 6, h: 4, d: 'enemiesBack' },
    { id: 'pz2', n: '二号坦克A型', t: 'tank', c: 1, f: 1, a: 1, h: 3, s: ['blitz', 'smoke'] },
    { id: 'pz35', n: '35（t）坦克', t: 'tank', c: 2, f: 1, a: 2, h: 2, s: ['blitz'], d: 'allyInfantryOil' },
    { id: 'r59', n: '第59装甲掷弹兵团', t: 'infantry', c: 2, f: 1, a: 3, h: 3, e: ['moveNattack'] },
    { id: 'bf109', n: 'BF 109 E', t: 'fighter', c: 3, f: 1, a: 3, h: 4 },
    { id: 'tiger', n: '虎式坦克H型', t: 'tank', c: 8, f: 3, a: 8, h: 8, r: 2, e: ['immuneSuppress'] },
    { id: 'r980', n: '第980国民掷弹兵团', t: 'infantry', c: 3, f: 1, a: 3, h: 6 },
  ], orders: [
    { id: 'eagleclaw', n: '鹰爪', c: 3, e: 'eagleClaw' },
    { id: 'airstrike', n: '空中闪击', c: 3, e: 'airStrike' },
    { id: 'bismarck', n: 'KM 俾斯麦号', c: 10, e: 'bismarck' },
  ], counters: [
    { id: 'smalltalk', n: '无心漫谈', c: 1, e: 'enemyDeployDmg' },
  ] },
  su: { name: '苏联', hq: '', units: [
    { id: 'r84', n: '步兵第84团', t: 'infantry', c: 3, f: 1, a: 1, h: 8, s: ['guard'] },
    { id: 'i16', n: '伊-16 毛驴', t: 'fighter', c: 2, f: 1, a: 2, h: 2 },
    { id: 'r554', n: '步兵第554团', t: 'infantry', c: 0, f: 0, a: 1, h: 1, s: ['blitz'] },
    { id: 'r89', n: '步兵第89团', t: 'infantry', c: 1, f: 1, a: 1, h: 3, s: ['guard'] },
    { id: 't34', n: 'T-34 1942', t: 'tank', c: 5, f: 2, a: 5, h: 5, s: ['blitz'] },
    { id: 't70', n: 'T-70', t: 'tank', c: 2, f: 1, a: 3, h: 2, s: ['guard'] },
    { id: 'su76', n: 'SU-76M', t: 'tank', c: 3, f: 1, a: 5, h: 4, d: 'hqDmg2' },
    { id: 'katyusha', n: '喀秋沙', t: 'artillery', c: 2, f: 1, a: 1, h: 2, s: ['blitz'], e: ['chanceExtra1'] },
    { id: 'il28', n: '伊尔-28M', t: 'bomber', c: 4, f: 2, a: 4, h: 3, r: 1, e: ['overflowHq'] },
    { id: 'yak9', n: '雅克-9', t: 'fighter', c: 5, f: 2, a: 4, h: 5, e: ['deathDraw'] },
  ], orders: [
    { id: 'burningsky', n: '燃烧的天空', c: 1, e: 'burningSky', target: 'enemy-fly' },
    { id: 'frompeople', n: '来自人民', c: 3, e: 'fromPeople', target: 'enemy-unit' },
    { id: 'winterwar', n: '冬季战争', c: 1, e: 'winterWar' },
    { id: 'bloodsickle', n: '血红镰刀', c: 1, e: 'bloodSickle', target: 'enemy-unit' },
    { id: 'gw', n: '伟大的卫国战争', c: 6, e: 'greatWar' },
  ], counters: [] },
  gb: { name: '英国', hq: '', units: [
    { id: 'r5', n: '第5步兵团', t: 'infantry', c: 2, f: 1, a: 1, h: 5, s: ['guard'] },
    { id: 'humber', n: '亨伯MKII', t: 'tank', c: 1, f: 1, a: 1, h: 3, s: ['fight'] },
    { id: 'churchill', n: '丘吉尔Mk VI', t: 'tank', c: 5, f: 2, a: 2, h: 7, s: ['guard'], r: 1 },
    { id: 'lancaster', n: '兰卡斯特Mk I', t: 'bomber', c: 8, f: 3, a: 7, h: 4, s: ['blitz'] },
    { id: 'swordfish', n: '剑鱼 MKI', t: 'bomber', c: 1, f: 1, a: 1, h: 3 },
    { id: 'spitfire', n: '喷火Mk la', t: 'fighter', c: 5, f: 2, a: 5, h: 5 },
  ], orders: [
    { id: 'fort', n: '防御工事', c: 3, e: 'fortify' },
    { id: 'carpet', n: '地毯式轰炸', c: 7, e: 'carpetBomb' },
    { id: 'desert', n: '沙漠之鼠', c: 1, e: 'desertRat', target: 'enemy-unit' },
    { id: 'monty', n: '蒙哥马利', c: 1, e: 'montgomery', target: 'enemy-unit' },
    { id: 'mx175', n: 'MX 175 护航队', c: 3, e: 'draw2' },
  ], counters: [
    { id: 'firewatch', n: '国家消防局', c: 2, e: 'hqCap' },
  ] },
  jp: { name: '日本', hq: '', units: [
    { id: 'a6m2', n: 'A6M2零战', t: 'fighter', c: 4, f: 2, a: 4, h: 4, s: ['ambush'], d: 'dmgRand1', target: 'enemy-unit' },
    { id: 'd3a', n: 'D3A2九九舰爆', t: 'bomber', c: 3, f: 1, a: 3, h: 2, s: ['smoke'], e: ['perAllyD3'] },
    { id: 't93', n: '九三式装甲车', t: 'tank', c: 1, f: 1, a: 1, h: 1, e: ['auraAtk1'] },
    { id: 'r2', n: '第二挺进团', t: 'infantry', c: 3, f: 1, a: 2, h: 2, s: ['blitz'], d: 'destroyAtk2', target: 'enemy-unit' },
    { id: 'sendai', n: '仙台联队', t: 'infantry', c: 4, f: 1, a: 2, h: 3, s: ['smoke'], d: 'exile', target: 'enemy-unit' },
    { id: 's33', n: '搜索第33联队', t: 'infantry', c: 1, f: 1, a: 1, h: 2, e: ['onDamagedDraw'] },
    { id: 'c15', n: '骑兵第15联队', t: 'infantry', c: 1, f: 0, a: 2, h: 1, s: ['blitz'] },
    { id: 't41', n: '四一式山炮', t: 'artillery', c: 2, f: 2, a: 3, h: 2, e: ['noHq'] },
  ], orders: [
    { id: 'amphib', n: '两栖进攻', c: 3, e: 'amphibious', target: 'enemy-unit' },
    { id: 'power', n: '火力爆发', c: 1, e: 'powerSurge', target: 'friendly-fighter' },
    { id: 'bomraid', n: '轰炸突袭', c: 4, e: 'bombRaid', target: 'enemy-unit' },
  ], counters: [] },
};
