// ============================================================================
// 骑勇大战 · 规则内核（唯一真相源）
// 这个文件同时被 sim.mjs（校准）与 build.mjs（注入 HTML）使用。
// 目的：让"模拟的规则"与"实际玩的规则"物理上不可能不一致。
// ============================================================================

// ---------------------------------------------------------------- 可调系数
const TUNING = {
  // ═══ 命中率标定（第三次重标定，2026-09-02）═══
  // 设计取向：这是卡牌游戏，不是命中率模拟器。Ethan 的原话是决定性的 ——
  //   「有防守人的情况也应该在 50~70% 至少，因为这个游戏大部分情况下是有对策牌的，
  //     不能让进攻效率那么差，反而应该高一点才好玩，所以有防守和无防守不能差太多」
  // 因此放弃「对齐真实 NBA 命中率」这个目标（那是 manager-sim 项目的事）。
  //
  // 实测结果（手上 3 张进攻牌时的最优出手，即真实决策场景）：
  //   中位 70%，P05 55%，低于 50% 只占 0.9%
  // 有防守应对 + 干扰牌下：三分 50% / 中投·突破 60% / 扣篮·空接 70%
  // 唯一的 35% 是「TT 投三分」—— 他真 2K17 的 3PT 是 25，这是写实惩罚不是缺陷。
  baseDC: { three: 10, mid: 7, drive: 6, dunk: 4, alley: 5 },
  // 修正项统一缩放系数。原始跨度太大（三分一项 27 格 DC）而目标区间只有 8 格，
  // 不缩放则大量组合被封顶挤在下界，防守牌打不打都一样。0.55 实测封顶率仅 1.9%。
  modScale: 0.55,
  attrScale: 0.115,     // 进攻属性每高于 50 一点，DC 降多少（会再乘 modScale）
  defScale: 0.068,      // 防守属性每高于 50 一点，DC 升多少（会再乘 modScale）
  fatigueStep: 2,       // 体能过半后每缺 1 点，DC 升多少（乘以耐力折扣）
  reboundDC: 12,        // 前场篮板争抢难度
  stealDC: 15,          // 抢断成功难度
  dcFloor: 3,           // DC 下限 → 最高命中 90%（再好的机会也不是必进）
  // DC 上限的四次调整史，每次都有实测依据：
  //  20（初版）→ made = (roll >= dc) 且掷 20 本就是自然 20 必进，所以 DC 20 与 21 数学等价，
  //              是防守干扰牌的「一票否决」。实测 11.5% 的组合被顶到 20，玩家看到「需 20 · 5%」。
  //  18        → 最低 15%，但「≤15% 的组合占 25.7%」，四分之一的出手堆在下界。
  //  16        → 最低 25%，对齐真实下界（Disney Research 追踪数据：贴身三分 26.6%）。
  //              但 Ethan 指出这个取向本身就错了 —— 卡牌游戏不该按模拟器标定。
  //  14（现在）→ 最低 35%，配合 modScale 0.55，让「有防守」落在 50-70%。
  dcCeil: 14,
  // 手牌上限 11、起手 8（3攻/3防/2战，硬编码在 freshState 里）。
  // 原来上限 7 且起手就是 7 —— 于是每回合摸 2 张就立刻触发弃牌（摸了又扔），
  // 玩家永远只有 1 张进攻牌可选。留 3 张囤牌空间才有「存着用」的余地
  // （Ethan 早先提过「有些牌可以存着用」）。
  handLimit: 11,
  drawPerTurn: 2,
  startHand: 8,
  targetScore: 15,
  // 骑士整体属性弱于死亡五小约 25%（历史事实：勇士 4-1 赢下 2017 总决赛）。
  // 但重标定后（modScale 0.55 把属性差压缩了 45% + 命中率整体拉高到 50-90%），
  // 勇士的先天优势已被显著削弱 —— 此时再给骑士 -1 DC 会让他们反超到 55.7%。
  // 所以主场补偿归零，让压缩后的属性差自己说话。
  homeEdge: 0,
};

const SHOTS = ['three', 'mid', 'drive', 'dunk', 'alley'];
const SHOT_PTS = { three: 3, mid: 2, drive: 2, dunk: 2, alley: 2 };
const SHOT_ZH  = { three: '三分', mid: '中投', drive: '突破', dunk: '扣篮', alley: '空接' };

// ---------------------------------------------------------------- 防守应对
// 全部为非负修正：数字小 = "这种防守必须让出这种球"。
// 依据真实挡拆防守相克表（Coverage Cheat Sheet / nbaplaybook）。
const DEF_RESPONSE = {
  drop:   { zh:'沉退',     mod:{three:1, mid:1, drive:4, dunk:6, alley:6}, gives:'外线跳投与大个外弹' },
  hedge:  { zh:'延误',     mod:{three:4, mid:3, drive:4, dunk:1, alley:0}, gives:'短挡拆顺下 4 打 3' },
  swtch:  { zh:'无限换防', mod:{three:5, mid:3, drive:1, dunk:1, alley:2}, gives:'错位单打' },
  ice:    { zh:'侧翼封堵', mod:{three:2, mid:5, drive:3, dunk:3, alley:3}, gives:'弱侧底角三分' },
  blitz:  { zh:'包夹',     mod:{three:3, mid:6, drive:5, dunk:1, alley:0}, gives:'后场 4 打 3', summons:true },
  scram:  { zh:'缩防换位', mod:{three:2, mid:2, drive:4, dunk:4, alley:4}, gives:'外围出手' },
  allsw:  { zh:'全员换防', mod:{three:3, mid:3, drive:3, dunk:3, alley:3}, gives:'无', coachOnly:'dantoni' },
  none:   { zh:'原始对位', mod:{three:0, mid:0, drive:0, dunk:0, alley:0}, gives:'一切' },
};

// ---------------------------------------------------------------- 进攻战术
const OFF_TACTIC = {
  pnr:    { zh:'挡拆',     mod:{three:-3, mid:-3, drive:-2, dunk:-1, alley:-2} },
  horns:  { zh:'牛角',     mod:{three:-2, mid:-3, drive:-1, dunk:-3, alley:-3} },
  motion: { zh:'无球跑动', mod:{three:-5, mid:-2, drive:0,  dunk:0,  alley:0}  },
  iso:    { zh:'单打',     mod:{three:0,  mid:-3, drive:-4, dunk:-2, alley:0}  },
  dho:    { zh:'手递手',   mod:{three:-4, mid:-2, drive:-1, dunk:0,  alley:0}  },
  split:  { zh:'分球空切', mod:{three:-4, mid:-2, drive:-1, dunk:0,  alley:-1}, coachOnly:'kerr' },
  liftup: { zh:'中锋上提', mod:{three:-1, mid:-2, drive:-3, dunk:-2, alley:-2}, coachOnly:'lue', forceWorstDefender:true },
  none:   { zh:'无战术',   mod:{three:0,  mid:0,  drive:0,  dunk:0,  alley:0}  },
};

// ------------------------------------------------------- 二阶反制（教科书惩罚）
// [进攻战术, 出手类型, 被反制的防守应对, 额外 DC 修正]
const COUNTERS = [
  // Drop 必须让出挡拆后跳投与大个外弹
  ['pnr',   'three', 'drop',  -3, '挡拆外弹惩罚沉退'],
  ['pnr',   'mid',   'drop',  -3, '沉退让出拉杆跳投'],
  ['horns', 'three', 'drop',  -3, '双高位外弹惩罚沉退'],
  // Hedge / Blitz 必须让出顺下 4 打 3
  ['pnr',   'alley', 'hedge', -3, '口袋传球穿延误'],
  ['horns', 'alley', 'hedge', -3, '短挡拆 4 打 3'],
  ['pnr',   'alley', 'blitz', -4, '穿越包夹的口袋传球'],
  ['horns', 'alley', 'blitz', -4, '包夹后场 4 打 3'],
  ['pnr',   'dunk',  'blitz', -3, '包夹后顺下终结'],
  // Switch 必须让出错位单打
  ['iso',   'drive', 'swtch', -3, '直接单打错位'],
  ['iso',   'mid',   'swtch', -3, '错位背身'],
  // Ice 必须让出弱侧与中路
  ['motion','three', 'ice',   -3, '弱侧转移'],
  ['iso',   'drive', 'ice',   -3, '拒绝挡拆走中路'],
  // Scram 只化解错位与顺下，仍让出外线
  ['pnr',   'mid',   'scram', -2, 're-screen 再打一次'],
  ['motion','three', 'scram', -2, '缩防后外线空档'],
];

// ---------------------------------------------------------------- 牌表
// 牌堆总量必须能在约 25-30 个回合内抽完，否则"牌堆见底"终局永不触发，
// 比赛会拖到体能耗尽 → 无人可派 → 谁都不得分 → 死锁。
// 每方每个自己的进攻回合摸 2 张，一局约 16-20 总回合 = 自己约 8-10 次进攻 = 摸 16-20 张。
// 故三堆合计约 30 张（含起手 7 张）。
// 牌堆厚度按「一局最长约 21 回合」反推（中位 16，P95 约 21）：
//   每方进攻约 10-11 次 → off 需 11 + 起手 3 = 14
//   每方防守约 10-11 次 → def 需 11 + 起手 2 = 13
//   每回合双方各摸 1 张战术 → tac 需 21 + 起手 2 = 23
// 原来的 14 / 8 / 20 厚薄失衡：防守堆尤其薄（只有 3 种共 8 张），
// 打到后半局必然枯竭 —— 这就是 Ethan「打到后面能出的牌少得可怜」的根因。
function buildDecks(coachId) {
  const off = [];
  const push = (arr, id, n) => { for (let i = 0; i < n; i++) arr.push(id); };
  push(off, 'three', 5); push(off, 'mid', 4); push(off, 'drive', 4);
  push(off, 'dunk', 3);  push(off, 'alley', 3);

  const def = [];
  push(def, 'contest', 5); push(def, 'block', 5);
  push(def, 'steal', 3);   push(def, 'pressure', 3);

  const tac = [];
  const T = {
    pnr:3, horns:2, motion:2, iso:2, dho:2,
    drop:3, hedge:3, swtch:3, ice:2, blitz:2, scram:1,
    hunt:1, timeout:1,
  };
  const coach = COACHES[coachId];
  if (coach) for (const [k, d] of Object.entries(coach.deckDelta)) T[k] = Math.max(0, (T[k] || 0) + d);
  if (coach?.unlock) T[coach.unlock] = (T[coach.unlock] || 0) + 2;
  for (const [k, n] of Object.entries(T)) push(tac, k, n);

  return { off, def, tac };
}

const TAC_META = {
  hunt:    { zh:'点哥战术', kind:'special', text:'指定对方一名场下球员，扣其 1 点体能并强制其成为本回合防守人' },
  timeout: { zh:'教练暂停', kind:'special', text:'取消对方刚打出的一张战术牌' },
};
// 防守牌（即时干扰层，进攻方选定出手后打出）。
// 设计原则：四种牌必须有四种**不同的用途**，不能只是数值大小的差别。
// Ethan 反馈「防守牌的区分度不够 有时候会显得千篇一律」——
// 根因是原来三种全是纯 DC 修正矩阵，玩家只看到「+X 难度」，
// 而且 `canSteal`/`stealDC` 定义了却从未被使用，抢断退化成普通的封盖。
const DEF_CARD_META = {
  // 举手干扰：专克外线跳投，对突破和篮下几乎无效
  contest: { zh:'干扰投篮', mod:{three:4, mid:4, drive:1, dunk:0, alley:0},
             role:'克跳投', text:'三分与中投难度 +4，对突破和篮下几乎无效' },
  // 护框：专克内线，对外线基本无效
  block:   { zh:'封盖',     mod:{three:0, mid:1, drive:3, dunk:5, alley:5},
             role:'克内线', text:'扣篮与空接难度 +5，对外线基本无效' },
  // 赌博式：几乎不提难度，但有机会直接断球（掷 d20 ≥ stealDC）
  steal:   { zh:'抢断',     mod:{three:1, mid:1, drive:1, dunk:1, alley:1},
             role:'赌断球', canSteal:true,
             text:`几乎不提难度；掷 d20 ≥ ${TUNING.stealDC} 则直接断球，本回合结束` },
  // 消耗战：中等提难度，但额外消耗对手上场球员 1 点体能
  pressure:{ zh:'紧逼',     mod:{three:2, mid:2, drive:2, dunk:2, alley:2},
             role:'耗体能', drainStamina:1,
             text:'各类出手难度 +2，并额外消耗对手上场球员 1 点体能' },
};

// ---------------------------------------------------------------- 教练
const COACHES = {
  kerr: {
    zh:'史蒂夫·科尔', system:'传切体系',
    note:'"4" Pop Fist / Motion Weak / Loop Punch Stagger Split，复出首场全队 34 次助攻',
    deckDelta:{ motion:+2, dho:+1, iso:-1 }, unlock:'split',
    unlockText:'解锁【分球空切】×2：三分 DC -4，可翻出第二射手执行',
  },
  dantoni: {
    zh:'迈克·德安东尼', system:'七秒快攻 · 全员换防',
    note:'"Talk it. Touch it. Switch it. Grab it." 2017 年度最佳教练',
    deckDelta:{ swtch:+2, blitz:+1, drop:-1 }, unlock:'allsw',
    unlockText:'解锁【全员换防】×2：所有出手 DC +3，且免疫错位惩罚',
  },
  lue: {
    zh:'泰伦·卢', system:'猎杀错位',
    note:'派中锋做掩护逼对手换防到詹姆斯身上；G1 詹姆斯发起 1.11 PPP vs 欧文 0.8 PPP',
    deckDelta:{ pnr:+2, iso:+1, motion:-1 }, unlock:'liftup',
    unlockText:'解锁【中锋上提】×2：强制对手换上体能最低的球员防守',
  },
};

// ---------------------------------------------------------------- 球员
// 体能点数 = round(2017 总决赛 G4 真实出场分钟 / 7)
// 属性主干来自真 2K17 的 OVR/3PT/DNK，其余维度按角色手工设计
const ROSTERS = {
  CLE: {
    zh:'克利夫兰骑士', abbr:'CLE', main:'#860038', alt:'#FDBB30', ink:'#ffffff',
    players: [
      { id:'lbj',  zh:'勒布朗·詹姆斯', short:'詹姆斯', no:23, pos:'SF', sta:6, min:41,
        a:{three:76, mid:80, drive:95, dunk:85, alley:92}, d:{perim:82, inter:78, steal:72},
        skill:{ id:'takeover', zh:'接管比赛', kind:'once',
          text:'本方上一回合进球后，本回合可让詹姆斯上场且不消耗体能（全场一次）' } },
      { id:'kyrie',zh:'凯里·欧文', short:'欧文', no:2, pos:'PG', sta:6, min:41,
        a:{three:84, mid:88, drive:92, dunk:30, alley:80}, d:{perim:58, inter:40, steal:55},
        skill:{ id:'handles', zh:'单挑无解', kind:'cd', cd:2,
          text:'打出【单打】时突破与中投 DC -4；但本回合失去重试机会' } },
      { id:'love', zh:'凯文·勒夫', short:'勒夫', no:0, pos:'PF', sta:4, min:29,
        a:{three:84, mid:74, drive:55, dunk:55, alley:62}, d:{perim:52, inter:66, steal:48},
        skill:{ id:'pop', zh:'高位外弹', kind:'free',
          text:'对手应对为【沉退】或【包夹】时，三分 DC 额外 -4' } },
      { id:'jr',   zh:'J.R. 史密斯', short:'JR', no:5, pos:'SG', sta:4, min:29,
        a:{three:89, mid:70, drive:66, dunk:70, alley:64}, d:{perim:70, inter:45, steal:62},
        skill:{ id:'ambush', zh:'弱侧埋伏', kind:'bench', cost:1,
          text:'对手应对为【包夹】或【侧翼封堵】时，可从场下接手本回合出手，三分 DC -3' } },
      { id:'tt',   zh:'特里斯坦·汤普森', short:'TT', no:13, pos:'C', sta:5, min:36,
        a:{three:25, mid:35, drive:58, dunk:75, alley:78}, d:{perim:62, inter:82, steal:42},
        skill:{ id:'putback', zh:'二次进攻', kind:'free', benchCost:1,
          text:'出手不中时掷骰争抢前场篮板（DC 12），成功则获得一次重试；在场下可花 1 体能发动' } },
    ],
  },
  GSW: {
    zh:'金州勇士', abbr:'GSW', main:'#1D428A', alt:'#FFC72C', ink:'#ffffff',
    players: [
      { id:'kd',   zh:'凯文·杜兰特', short:'杜兰特', no:35, pos:'SF', sta:6, min:39,
        a:{three:90, mid:92, drive:86, dunk:75, alley:88}, d:{perim:80, inter:74, steal:62},
        skill:{ id:'unguardable', zh:'错位死刑', kind:'cd', cd:1,
          text:'当防守人外围防守低于 85 时，中投与三分 DC -5' } },
      { id:'dray', zh:'德雷蒙德·格林', short:'格林', no:23, pos:'PF', sta:6, min:39,
        a:{three:80, mid:62, drive:66, dunk:74, alley:72}, d:{perim:88, inter:86, steal:82},
        skill:{ id:'goalie', zh:'守门员', kind:'free', benchCost:1,
          text:'在场时对手扣篮与空接 DC +4；在场下可花 1 体能对本回合发动一次' } },
      { id:'curry',zh:'斯蒂芬·库里', short:'库里', no:30, pos:'PG', sta:5, min:38,
        a:{three:99, mid:90, drive:82, dunk:36, alley:78}, d:{perim:62, inter:34, steal:70},
        skill:{ id:'range', zh:'无限射程', kind:'free',
          text:'防守应对对库里三分的 DC 加成永不超过 +2' } },
      { id:'klay', zh:'克莱·汤普森', short:'克莱', no:11, pos:'SG', sta:5, min:34,
        a:{three:98, mid:84, drive:68, dunk:65, alley:70}, d:{perim:82, inter:52, steal:58},
        skill:{ id:'catchshoot', zh:'接球就投', kind:'free',
          text:'打出【无球跑动】或【手递手】后三分 DC -5；不能作为【单打】执行人' } },
      { id:'iggy', zh:'安德烈·伊戈达拉', short:'伊戈达拉', no:9, pos:'SF', sta:3, min:21,
        a:{three:80, mid:72, drive:78, dunk:80, alley:78}, d:{perim:90, inter:66, steal:76},
        skill:{ id:'clamps', zh:'死亡缠绕', kind:'bench', cost:1, maxUses:2,
          text:'对手判定前可从场下接防，本回合对手所有出手 DC +5（全场两次）' } },
    ],
  },
};

// 真 2K17 三列锚点（OVR/3PT/DNK），仅供界面标注来源
const K17 = {
  lbj:[96,76,85], kyrie:[89,84,30], love:[82,84,55], jr:[77,89,70], tt:[81,25,75],
  curry:[94,99,36], kd:[93,90,75], klay:[90,98,65], dray:[90,80,74], iggy:[81,80,80],
};

// ---------------------------------------------------------------- 体能
// 消耗按本局累计上场次数递增（不是连续次数——连续会被交替使用绕过）
function costOfNthUse(n) { return n <= 3 ? 1 : n <= 5 ? 2 : 3; }
function maxUsesFor(sta) {
  let spent = 0, uses = 0;
  while (spent + costOfNthUse(uses + 1) <= sta) { uses++; spent += costOfNthUse(uses); }
  return uses;
}
// 2K Stamina 在此的正确用法：决定体能过半后的手感衰减速度
const STAMINA_2K = {
  lbj:98, kyrie:97, love:93, jr:92, tt:90,
  curry:98, kd:98, klay:91, dray:88, iggy:80,
};
function fatiguePenalty(p, cur) {
  const half = p.sta / 2;
  if (cur > half) return 0;
  const missing = half - cur + 1;
  const tough = (STAMINA_2K[p.id] ?? 90) / 98;   // 耐力好的人衰减慢
  return Math.round(missing * TUNING.fatigueStep * (2 - tough));
}

// ---------------------------------------------------------------- DC 计算
// 返回 { dc, parts:[{label, v}] }，parts 用于界面把每一项摊开给玩家看
function computeDC(ctx) {
  const {
    shot, attacker, defender, offTactic = 'none', defResponse = 'none',
    defCard = null, atkFatigue = 0, skills = {},
  } = ctx;
  const parts = [];
  let dc = TUNING.baseDC[shot];
  parts.push({ label: `${SHOT_ZH[shot]}基准`, v: dc });

  // 所有「修正项」统一走 mod()，乘 TUNING.modScale 后取整。
  // 为什么必须这样：修正项的原始跨度太大 —— 实测三分一项的总跨度是 27 格 DC
  // （出手基准差 6 + 进攻属性 9 + 防守应对 5 + 干扰牌 4 + 防守属性 3），
  // 而「45%~80%」这个目标区间在 d20 上只有 8 格。不缩放的话无论怎么调基准和上下限
  // 都塞不进去，结果就是大量组合被封顶挤在下界，防守牌打不打都一样。
  // Ethan 的要求：「有防守人的情况也应该在 50~70% 至少，有防守和无防守不能差太多，
  // 大部分情况下是有对策牌的，不能让进攻效率那么差，反而应该高一点才好玩。」
  const mod = (label, v) => {
    if (!v) return;
    const s = Math.round(v * TUNING.modScale);
    if (!s) return;
    parts.push({ label, v: s });
    dc += s;
  };

  const av = attacker.a[shot];
  mod(`${attacker.short} ${SHOT_ZH[shot]} ${av}`, -Math.round((av - 50) * TUNING.attrScale));

  const dv = (shot === 'three' || shot === 'mid') ? defender.d.perim : defender.d.inter;
  mod(`${defender.short} 防守 ${dv}`, Math.round((dv - 50) * TUNING.defScale));

  let respMod = DEF_RESPONSE[defResponse].mod[shot];
  if (skills.curryRange && attacker.id === 'curry' && shot === 'three') respMod = Math.min(respMod, 2);
  mod(DEF_RESPONSE[defResponse].zh, respMod);

  mod(OFF_TACTIC[offTactic].zh, OFF_TACTIC[offTactic].mod[shot]);

  for (const [t, s, r, v, why] of COUNTERS) {
    if (t === offTactic && s === shot && r === defResponse) {
      if (defResponse === 'allsw') continue;              // 全员换防免疫错位惩罚
      mod(why, v);
    }
  }

  if (defCard) mod(DEF_CARD_META[defCard].zh, DEF_CARD_META[defCard].mod[shot]);

  if (skills.lovePop && (defResponse === 'drop' || defResponse === 'blitz') && shot === 'three')
    mod('高位外弹', -4);
  if (skills.kyrieHandles && offTactic === 'iso' && (shot === 'drive' || shot === 'mid'))
    mod('单挑无解', -4);
  if (skills.kdMismatch && defender.d.perim < 85 && (shot === 'mid' || shot === 'three'))
    mod('错位死刑', -5);
  if (skills.klayCatch && (offTactic === 'motion' || offTactic === 'dho') && shot === 'three')
    mod('接球就投', -5);
  if (skills.jrAmbush && shot === 'three') mod('弱侧埋伏', -3);
  if (skills.draymondGoalie && (shot === 'dunk' || shot === 'alley')) mod('守门员', 4);
  if (skills.iggyClamps) mod('死亡缠绕', 5);

  mod('体能下降', atkFatigue);
  if (ctx.homeEdge) mod('主场之势', -TUNING.homeEdge);

  dc = Math.max(TUNING.dcFloor, Math.min(TUNING.dcCeil, dc));
  return { dc, parts, prob: (21 - dc) / 20 };
}

// ---------------------------------------------------------------- 随机
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const d20 = (rng) => 1 + Math.floor(rng() * 20);

export {
  TUNING, SHOTS, SHOT_PTS, SHOT_ZH, DEF_RESPONSE, OFF_TACTIC, COUNTERS,
  DEF_CARD_META, TAC_META, COACHES, ROSTERS, K17, STAMINA_2K,
  buildDecks, costOfNthUse, maxUsesFor, fatiguePenalty, computeDC, mulberry32, d20,
};
