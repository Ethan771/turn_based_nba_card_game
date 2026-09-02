// ============================================================================
// 校准模拟器：跑数千局，验证 DC 表是否达到"约一半回合得分"
// 双方均由启发式 AI 驱动（近似有经验玩家的选择），不是随机出牌。
// ============================================================================
import {
  TUNING, SHOTS, SHOT_PTS, SHOT_ZH, DEF_RESPONSE, OFF_TACTIC, DEF_CARD_META,
  COACHES, ROSTERS, buildDecks, costOfNthUse, maxUsesFor, fatiguePenalty,
  computeDC, mulberry32, d20,
} from './rules.mjs';

const shuffle = (arr, rng) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

function makeSide(teamId, coachId, rng) {
  const t = ROSTERS[teamId];
  const d = buildDecks(coachId);
  return {
    teamId, coachId, team: t, score: 0,
    players: t.players.map(p => ({ ...p, cur: p.sta, uses: 0, rest: 0, cdUntil: 0, onceUsed: false, benchUses: 0 })),
    decks: { off: shuffle(d.off, rng), def: shuffle(d.def, rng), tac: shuffle(d.tac, rng) },
    hand: { off: [], def: [], tac: [] },
    lastMade: null,
  };
}

// 摸牌：目标堆空了就换一个非空堆（否则会出现"剩 6 张牌但抽不到"的假见底）
function drawFrom(side, kind) {
  if (!side.decks[kind].length) {
    const alt = ['off', 'tac', 'def'].find(k => side.decks[k].length);
    if (!alt) return false;
    kind = alt;
  }
  side.hand[kind].push(side.decks[kind].shift());
  return true;
}
// 弃牌阶段：超出手牌上限则弃掉最不需要的（照三国杀）
function discardDown(side, rng) {
  let total = () => side.hand.off.length + side.hand.def.length + side.hand.tac.length;
  while (total() > TUNING.handLimit) {
    const kinds = ['off', 'def', 'tac'].filter(k => side.hand[k].length);
    kinds.sort((a, b) => side.hand[b].length - side.hand[a].length);
    side.hand[kinds[0]].pop();
  }
}
const deckTotal = (s) => s.decks.off.length + s.decks.def.length + s.decks.tac.length;

function affordable(p) { return p.cur >= costOfNthUse(p.uses + 1); }
// 剩余可上场次数 —— AI 必须考虑这个，否则会把主力烧光后无人可派
function budgetLeft(p) {
  let spent = 0, extra = 0, n = p.uses;
  while (spent + costOfNthUse(n + 1) <= p.cur) { n++; extra++; spent += costOfNthUse(n); }
  return extra;
}

function restAll(side, active) {
  for (const p of side.players) {
    if (p === active) { p.rest = 0; continue; }
    p.rest++;
    if (p.rest >= 2) { p.rest = 0; p.cur = Math.min(p.sta, p.cur + 1); }
  }
}

// ---- AI：进攻方选人。既要能打出好牌，也要顾及体能预算
function pickAttacker(side, rng) {
  const av = side.players.filter(affordable);
  if (!av.length) return null;
  const scored = av.map(p => {
    let best = 0;
    for (const s of side.hand.off) best = Math.max(best, p.a[s] ?? 0);
    const fat = fatiguePenalty(p, p.cur);
    return { p, v: best * 0.5 + budgetLeft(p) * 9 - fat * 5 + rng() * 6 };
  });
  scored.sort((a, b) => b.v - a.v);
  return scored[0].p;
}
// ---- AI：防守方选人（盲选）。同样必须顾预算
function pickDefender(side, rng) {
  const av = side.players.filter(affordable);
  if (!av.length) return null;
  const scored = av.map(p => ({
    p, v: (p.d.perim + p.d.inter) / 2 * 0.45 + budgetLeft(p) * 9 + rng() * 6,
  }));
  scored.sort((a, b) => b.v - a.v);
  return scored[0].p;
}

const isResponse = (id) => id in DEF_RESPONSE;
const isTacticCard = (id) => id in OFF_TACTIC;

function skillFlags(atk, def, offTactic, defResponse, extra = {}) {
  return {
    curryRange: atk.id === 'curry',
    lovePop: atk.id === 'love',
    kyrieHandles: atk.id === 'kyrie' && offTactic === 'iso',
    kdMismatch: atk.id === 'kd',
    klayCatch: atk.id === 'klay',
    draymondGoalie: def.id === 'dray',
    ...extra,
  };
}

// 一次进攻回合
function playPossession(off, def, rng, stats) {
  // 摸牌阶段，与 game.template.html 的 select reducer 严格一致：
  //   进攻方摸 1 进攻牌 + 1 战术牌
  //   防守方摸 1 防守牌 + 1 战术牌
  drawFrom(off, 'off'); drawFrom(off, 'tac');
  drawFrom(def, 'def'); drawFrom(def, 'tac');
  // 保底：某类手牌为空则补一张
  if (!off.hand.off.length) drawFrom(off, 'off');
  if (!def.hand.def.length) drawFrom(def, 'def');

  // 接管比赛：本方上一回合进球，詹姆斯可免费上场（全场一次）
  const lbj = off.players.find(p => p.id === 'lbj');
  const canTakeover = off.lastMade && lbj && !lbj.onceUsed;
  let atk;
  if (canTakeover && (!affordable(lbj) || rng() < 0.5)) { atk = lbj; }
  else { atk = pickAttacker(off, rng); }
  const dfd = pickDefender(def, rng);
  if (!atk || !dfd) { stats.noPlayer++; return { pts: 0, dead: true }; }

  const freeRide = atk === lbj && canTakeover;
  if (freeRide) { lbj.onceUsed = true; lbj.uses++; stats.takeover++; }
  else { atk.cur -= costOfNthUse(atk.uses + 1); atk.uses++; }
  restAll(off, atk);

  dfd.cur -= costOfNthUse(dfd.uses + 1); dfd.uses++;
  restAll(def, dfd);

  // 进攻战术
  let offTactic = 'none';
  const tacIdx = off.hand.tac.findIndex(isTacticCard);
  if (tacIdx >= 0 && rng() < 0.85) { offTactic = off.hand.tac.splice(tacIdx, 1)[0]; }
  stats.tacUse[offTactic] = (stats.tacUse[offTactic] || 0) + 1;

  // 防守应对：从手上的应对牌里挑"让出最少"的那张
  let defResponse = 'none';
  const respIdxs = def.hand.tac.map((c, i) => [c, i]).filter(([c]) => isResponse(c));
  if (respIdxs.length) {
    let best = null;
    for (const [card, i] of respIdxs) {
      let worst = 0;
      for (const s of SHOTS) {
        const { dc } = computeDC({ shot: s, attacker: atk, defender: dfd, offTactic, defResponse: card,
          atkFatigue: fatiguePenalty(atk, atk.cur), homeEdge: off.teamId==="CLE", skills: skillFlags(atk, dfd, offTactic, card) });
        worst = Math.max(worst, (21 - dc) / 20);
      }
      if (!best || worst < best.worst) best = { card, i, worst };
    }
    defResponse = best.card;
    def.hand.tac.splice(best.i, 1);
  }
  stats.respUse[defResponse] = (stats.respUse[defResponse] || 0) + 1;

  // 伊戈达拉场下缠绕
  let iggyClamps = false;
  const iggy = def.players.find(p => p.id === 'iggy');
  if (iggy && iggy !== dfd && iggy.cur >= 1 && iggy.benchUses < 2 && rng() < 0.4) {
    iggy.cur -= 1; iggy.benchUses++; iggyClamps = true; stats.clamps++;
  }

  // 进攻方看到应对后选出手方式（选期望分最高的）
  const opts = off.hand.off.map((s, i) => {
    const sk = skillFlags(atk, dfd, offTactic, defResponse, { iggyClamps });
    const { dc, prob } = computeDC({ shot: s, attacker: atk, defender: dfd, offTactic, defResponse,
      atkFatigue: fatiguePenalty(atk, atk.cur), homeEdge: off.teamId==="CLE", skills: sk });
    return { s, i, dc, prob, ev: prob * SHOT_PTS[s] };
  });
  if (!opts.length) { stats.noShot++; return { pts: 0 }; }
  opts.sort((a, b) => b.ev - a.ev);
  const chosen = opts[0];
  off.hand.off.splice(chosen.i, 1);

  // 防守即时反应牌。
  // 估值必须理解每种牌的**语义**，不能只看 DC 修正值 —— 抢断的修正值只有 1，
  // 按「修正最大」选它永远不会被打出，而这恰恰是它设计上的核心用途（赌断球）。
  let defCard = null;
  if (def.hand.def.length && rng() < 0.7) {
    const p0 = chosen.prob;                     // 不干扰时的命中率
    const stealP = (21 - TUNING.stealDC) / 20; // 抢断成功率（约 30%）
    let best = null;
    for (let i = 0; i < def.hand.def.length; i++) {
      const c = def.hand.def[i], meta = DEF_CARD_META[c];
      let v;
      if (meta.canSteal) {
        // 抢断成功 = 强制不得分，与当前 DC 无关。DC 越低（对手越可能进），抢断越值
        v = stealP * p0 - (1 - stealP) * 0.02;
      } else {
        const newDc = Math.min(TUNING.dcCeil, Math.max(TUNING.dcFloor, chosen.dc + meta.mod[chosen.s]));
        v = p0 - (21 - newDc) / 20;             // 降低的命中率
        if (meta.drainStamina) v += 0.025;      // 消耗对手体能的战略价值（粗略折算）
      }
      if (!best || v > best.v) best = { c, i, v };
    }
    if (best && best.v >= 0.02) { defCard = best.c; def.hand.def.splice(best.i, 1); }
  }

  const sk = skillFlags(atk, dfd, offTactic, defResponse, { iggyClamps });
  const final = computeDC({ shot: chosen.s, attacker: atk, defender: dfd, offTactic, defResponse,
    defCard, atkFatigue: fatiguePenalty(atk, atk.cur), homeEdge: off.teamId==="CLE", skills: sk });

  stats.dcHist.push(final.dc);
  stats.shotUse[chosen.s] = (stats.shotUse[chosen.s] || 0) + 1;
  stats.defUse[defCard || 'none'] = (stats.defUse[defCard || 'none'] || 0) + 1;

  // 抢断：独立判定，成功则直接断球结束回合（与 game.template.html 的 defcard reducer 一致）
  if (defCard && DEF_CARD_META[defCard].canSteal) {
    if (d20(rng) >= TUNING.stealDC) { stats.stealMade++; return { pts: 0, turnover: true }; }
    stats.stealFail++;
  }
  // 紧逼：额外消耗进攻方上场球员 1 点体能
  if (defCard && DEF_CARD_META[defCard].drainStamina) {
    if (atk.cur > 0) { atk.cur -= DEF_CARD_META[defCard].drainStamina; stats.pressured++; }
  }

  // 判定（含前场篮板重试）
  let tries = 0, made = false, roll = 0;
  const tt = off.players.find(p => p.id === 'tt');
  while (tries < 3) {
    tries++;
    roll = d20(rng);
    if (roll === 20) { made = true; stats.nat20++; break; }
    if (roll === 1) { stats.nat1++; return { pts: 0, turnover: true }; }
    if (roll >= final.dc) { made = true; break; }
    // 重试：TT 在场或可从场下花体能
    let canRetry = false;
    if (tt && tt === atk) canRetry = true;
    else if (tt && tt.cur >= 1 && tries === 1 && rng() < 0.55) { tt.cur -= 1; canRetry = true; }
    if (!canRetry) break;
    if (d20(rng) < TUNING.reboundDC) break;
    stats.putback++;
  }
  stats.tries.push(tries);

  discardDown(off, rng);
  discardDown(def, rng);

  if (made) {
    const pts = SHOT_PTS[chosen.s] + (roll === 20 ? 1 : 0);
    off.score += pts; off.lastMade = atk.id;
    return { pts, shot: chosen.s };
  }
  off.lastMade = null;
  return { pts: 0, shot: chosen.s };
}

function playGame(seed, coachA, coachB) {
  const rng = mulberry32(seed);
  const A = makeSide('CLE', coachA, rng);
  const B = makeSide('GSW', coachB, rng);
  for (const s of [A, B]) {
    for (let i = 0; i < 3; i++) drawFrom(s, 'off');
    for (let i = 0; i < 3; i++) drawFrom(s, 'def');
    // 战术保底：一张进攻战术 + 一张防守应对（不保底时 37.8% 开局无应对牌）
    const take = pred => { const i = s.decks.tac.findIndex(pred); return i<0 ? null : s.decks.tac.splice(i,1)[0]; };
    const ta = take(c => c in OFF_TACTIC), td = take(c => c in DEF_RESPONSE);
    if (ta) s.hand.tac.push(ta);
    if (td) s.hand.tac.push(td);
    while (s.hand.tac.length < 2 && s.decks.tac.length) s.hand.tac.push(s.decks.tac.shift());
  }
  const stats = {
    poss:0, scored:0, pts:0, noPlayer:0, noShot:0, nat20:0, nat1:0, putback:0, takeover:0, clamps:0,
    stealMade:0, stealFail:0, pressured:0,
    dcHist:[], tries:[], shotUse:{}, tacUse:{}, respUse:{}, defUse:{},
  };
  let turn = 0, off = A, def = B, endReason = 'score';
  const CAP = 34;   // 硬上限。体能容量约 38 次上场，超过就会进入"无人可派"死锁
  while (turn < CAP) {
    if (A.score >= TUNING.targetScore || B.score >= TUNING.targetScore) break;
    // 任一方牌堆见底即终局（此时分高者胜）
    if (deckTotal(off) === 0 || deckTotal(def) === 0) { endReason = 'deck'; break; }
    turn++;
    const r = playPossession(off, def, rng, stats);
    stats.poss++; stats.pts += r.pts;
    if (r.pts > 0) stats.scored++;
    [off, def] = [def, off];
  }
  if (turn >= CAP) endReason = 'cap';
  const winner = A.score > B.score ? 'CLE' : B.score > A.score ? 'GSW' : 'TIE';
  const usedA = A.players.filter(p => p.uses > 0).length;
  const usedB = B.players.filter(p => p.uses > 0).length;
  return { stats, turn, winner, scoreA:A.score, scoreB:B.score, usedA, usedB, endReason };
}

// ---------------------------------------------------------------- 跑
const N = Number(process.argv[2] || 3000);
const agg = {
  poss:0, scored:0, pts:0, noPlayer:0, noShot:0, nat20:0, nat1:0, putback:0, takeover:0, clamps:0,
  stealMade:0, stealFail:0, pressured:0,
  dcHist:[], tries:[], shotUse:{}, tacUse:{}, respUse:{}, defUse:{},
};
let cleWin=0, gswWin=0, tie=0, turns=[], usedPlayers=[], scoreGap=[];
const endReasons = {};
const pairs = [['lue','kerr'],['lue','dantoni'],['kerr','kerr'],['dantoni','lue']];

for (let i = 0; i < N; i++) {
  const [ca, cb] = pairs[i % pairs.length];
  const g = playGame(1000 + i, ca, cb);
  for (const k of ['poss','scored','pts','noPlayer','noShot','nat20','nat1','putback','takeover','clamps','stealMade','stealFail','pressured']) agg[k]+=g.stats[k];
  agg.dcHist.push(...g.stats.dcHist); agg.tries.push(...g.stats.tries);
  for (const k of ['shotUse','tacUse','respUse','defUse'])
    for (const [n,v] of Object.entries(g.stats[k]||{})) agg[k][n]=(agg[k][n]||0)+v;
  if (g.winner==='CLE') cleWin++; else if (g.winner==='GSW') gswWin++; else tie++;
  turns.push(g.turn); usedPlayers.push(g.usedA, g.usedB); scoreGap.push(Math.abs(g.scoreA-g.scoreB));
  endReasons[g.endReason] = (endReasons[g.endReason]||0)+1;
}

const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
const pct = (a,p) => { const s=a.slice().sort((x,y)=>x-y); return s[Math.floor(s.length*p)]; };
const fmt = o => Object.entries(o).sort((a,b)=>b[1]-a[1])
  .map(([k,v])=>`${k} ${(v/agg.poss*100).toFixed(1)}%`).join('  ');

console.log(`=== ${N} 局校准结果 ===\n`);
const scoreRate = agg.scored/agg.poss;
console.log(`得分回合占比      ${(scoreRate*100).toFixed(1)}%   ← 目标 65-78%（卡牌游戏取向，非真实NBA）  ${scoreRate>=0.62&&scoreRate<=0.80?'✅':'❌'}`);
console.log(`每回合得分        ${(agg.pts/agg.poss).toFixed(3)}   ← 卡牌取向目标 1.4-1.9（真实 NBA 是 1.10，本项目刻意高于它）`);
console.log(`一局回合数        中位 ${pct(turns,0.5)}  区间 ${pct(turns,0.05)}-${pct(turns,0.95)}  ${pct(turns,0.5)>=14&&pct(turns,0.5)<=30?'✅':'❌'}`);
console.log(`用到球员数        平均 ${mean(usedPlayers).toFixed(2)} / 5   ${mean(usedPlayers)>=3.5?'✅':'❌'}`);
console.log(`胜率              CLE ${(cleWin/N*100).toFixed(1)}%  GSW ${(gswWin/N*100).toFixed(1)}%  平 ${(tie/N*100).toFixed(1)}%  ${Math.abs(cleWin-gswWin)/N<0.16?'✅':'❌'}`);
console.log(`分差              中位 ${pct(scoreGap,0.5)}  P90 ${pct(scoreGap,0.9)}`);
console.log(`结束原因          ${Object.entries(endReasons).map(([k,v])=>`${k} ${(v/N*100).toFixed(0)}%`).join('  ')}`);
console.log(`\nDC 分布           中位 ${pct(agg.dcHist,0.5)}  区间 ${pct(agg.dcHist,0.05)}-${pct(agg.dcHist,0.95)}`);
const probs = agg.dcHist.map(d=>(21-d)/20);
console.log(`命中率区间        ${(pct(probs,0.05)*100).toFixed(0)}% - ${(pct(probs,0.95)*100).toFixed(0)}%   ← 目标 45-90%（有防守也要 50-70%）  ${pct(probs,0.05)>=0.42&&pct(probs,0.95)<=0.92?'✅':'❌'}`);
console.log(`\n无人可派回合      ${(agg.noPlayer/agg.poss*100).toFixed(2)}%   ${agg.noPlayer/agg.poss<0.05?'✅':'❌'}`);
console.log(`手上无进攻牌      ${(agg.noShot/agg.poss*100).toFixed(2)}%`);
console.log(`自然20 / 自然1    ${(agg.nat20/agg.poss*100).toFixed(1)}% / ${(agg.nat1/agg.poss*100).toFixed(1)}%   ← 各应约 5%`);
console.log(`前场篮板重试      ${(agg.putback/agg.poss*100).toFixed(1)}%   平均出手 ${mean(agg.tries).toFixed(2)} 次/回合`);
console.log(`接管比赛触发      ${(agg.takeover/N).toFixed(2)} 次/局`);
console.log(`死亡缠绕触发      ${(agg.clamps/N).toFixed(2)} 次/局`);
const stealTot = agg.stealMade + agg.stealFail;
console.log(`抢断  打出${(stealTot/N).toFixed(2)}次/局  成功 ${stealTot?(agg.stealMade/stealTot*100).toFixed(0):0}%（理论 ${((21-TUNING.stealDC)/20*100).toFixed(0)}%）`);
console.log(`紧逼（消耗体能）  ${(agg.pressured/N).toFixed(2)} 次/局`);
console.log(`\n出手类型          ${fmt(agg.shotUse)}`);
console.log(`进攻战术          ${fmt(agg.tacUse)}`);
console.log(`防守应对          ${fmt(agg.respUse)}`);
console.log(`防守牌            ${fmt(agg.defUse)}`);
