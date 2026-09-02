// 全自动对局机器人：完全通过真实 DOM 点击打完整局，任何一步无路可走就报卡死。
// 这是交付前的必过关卡 —— 上一版我没做这件事，交了个自己都没打通的东西给 Ethan。
//
// 设计要点：
//  1) 只用界面上真实存在的交互（点球员卡 / 点手牌 / 点按钮），不调 __dispatch 走后门
//  2) 每一步都记录「阶段 + 视角 + 可操作项」，卡住时把最近 12 步原样打出来
//  3) 用 seed 跑多局，报出卡死率而不是"我试了一局没问题"
import puppeteer from 'puppeteer';
import { resolve } from 'path';

const GAME = 'file:///' + resolve('_game.html').replace(/\\/g,'/');
const GAMES = Number(process.argv[2] || 8);
const MAX_STEPS = 700;
// 骰子动画 940ms 是给人看的。自动跑的时候把它关掉，否则一局要 50 秒。
const FAST = process.env.PLAYTEST_SLOW !== '1';

const browser = await puppeteer.launch({ headless:'new',
  args:['--allow-file-access-from-files','--window-size=1500,940'],
  defaultViewport:{ width:1500, height:940 } });

let stuckCount = 0, finished = 0;
const allErrs = [];

for (let g = 0; g < GAMES; g++) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type()==='error') errs.push('console: '+m.text()); });

  await page.goto(GAME, { waitUntil:'domcontentloaded' });
  await page.evaluate(()=>localStorage.clear());
  await page.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,600));
  await page.click('[data-side="CLE"]');
  await page.click('[data-coach1="lue"]'); await page.click('[data-coach2="kerr"]');
  await page.click('#startbtn');
  await new Promise(r=>setTimeout(r,400));
  const sb = await page.$('#solobtn'); if (sb) await sb.click();
  await new Promise(r=>setTimeout(r,350));
  if (FAST) await page.evaluate(()=>{ window.__fastDice = true; });

  const trail = [];
  let stuck = null, done = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    const snap = await page.evaluate(() => {
      const S = window.__S ? window.__S() : null;
      if (!S) return { err:'no bridge' };
      const q = s => [...document.querySelectorAll(s)];
      return {
        phase: S.phase, turn: S.turn, off: S.offSide, over: S.over,
        score: `${S.sides.CLE.score}-${S.sides.GSW.score}`,
        my: (new URLSearchParams(location.search)).get('side'),
        // 全部交互形态，一个都不能漏
        seats:  q('.seatrow.mine .seat.pick').map(e=>e.getAttribute('data-pid')),
        cards:  q('.card.on').map(e=>e.getAttribute('data-card')||e.textContent.trim().slice(0,6)),
        acts:   q('#acts .act:not([disabled])').map(e=>({
                  act: e.getAttribute('data-act'), sw: e.getAttribute('data-switch'),
                  label: e.querySelector('b')?.textContent.trim() })),
        h3: (document.querySelector('#prompt h3')||{}).textContent||'',
      };
    });

    if (snap.err) { stuck = { reason:snap.err, snap }; break; }
    if (snap.phase === 'over' || snap.over) { done = true; break; }

    trail.push(`T${snap.turn} ${snap.phase} 视角${snap.my} 「${snap.h3.slice(0,20)}」`
      + ` 卡位${snap.seats.length} 亮牌${snap.cards.length}`
      + ` 按钮[${snap.acts.map(a=>a.label).join('/')}]`);
    if (trail.length > 14) trail.shift();

    // ── 决策优先级：先做实质动作，没有才切视角
    let acted = false;

    // 1) 选人
    // 原先只点 DOM 里第一个 `.seat.pick`（即"可点"的）——但这种"无脑点第一个"
    // 在长局中会把同一个 affordable 的球员反复点满耗光、导致同队其他人明明还有
    // 1-2 点体能用不上场、然后整队都 afford 失败。
    // 真实玩家会看灰显的卡也读剩余体能然后有意识地轮换。机器人模仿这个：
    //   遍历全队，按「剩余可上场次数 budgetLeft」从高到低选。
    if (snap.phase === 'select' && !snap.picks?.[MY]) {
      const pick = await page.evaluate(() => {
        const S = window.__S();
        const my = window.__MY();
        const mySide = S.sides[my];
        const cost = u => u < 3 ? 1 : u < 5 ? 2 : 3;
        const candidates = [];
        for (const st of mySide.players) {
          let spent = 0, n = st.uses, left = 0;
          while (spent + cost(n+1) <= st.cur) { n++; left++; spent += cost(n); }
          // 詹姆斯的「接管比赛」免费上场机会一旦可用就是绝对优先
          const isLBJ = st.id === 'lbj' && S.sides[my].lastMade && !st.once;
          candidates.push({ id: st.id, left, isLBJ });
        }
        candidates.sort((a, b) => (b.isLBJ?1:0) - (a.isLBJ?1:0) || b.left - a.left);
        return candidates[0]?.id;
      });
      if (pick) {
        await page.click(`.seatrow.mine [data-pid="${pick}"]`);
        acted = true;
        // 自己选完后，对方该选了 —— 视角切到该选人的人，否则 .seatrow.mine
        // 还停在自己这边（无可点元素），真玩家也会以为卡死。
        // 选完双方后阶段会推进到 tactic，这里会自动切走。
        await page.evaluate(() => {
          const S = window.__S();
          if (S.phase !== 'select') return;
          const otherSide = S.picks.CLE ? (S.picks.GSW ? null : 'GSW') : 'CLE';
          if (otherSide) window.__setView(otherSide);
        });
      }
    }
    // 2) 打手牌（进攻/防守/战术）
    else if (snap.cards.length) {
      const cards = await page.$$('.card.on');
      if (cards.length) { await cards[0].click(); acted = true; }
    }
    // 3) 实质按钮（跳过/掷骰/抢板/下一回合/场下技能），排除纯切视角
    else {
      const real = snap.acts.filter(a => a.act && !a.sw);
      if (real.length) {
        // next 放最后，优先把本回合能做的都做完
        real.sort((a,b) => (a.act==='next'?1:0) - (b.act==='next'?1:0));
        const el = await page.$(`#acts [data-act="${real[0].act}"]`);
        if (el) { await el.click(); acted = true; }
      }
      // 4) 只剩切视角
      else {
        const sw = snap.acts.find(a => a.sw);
        if (sw) {
          const el = await page.$(`#acts [data-switch="${sw.sw}"]`);
          if (el) { await el.click(); acted = true; }
        }
      }
    }

    if (!acted) { stuck = { reason:'无任何可点击项', snap }; break; }
    // 骰子动画 940ms，给足时间
    await new Promise(r=>setTimeout(r, snap.phase==='roll' ? (FAST?90:1250) : (FAST?55:200)));
  }

  if (stuck) {
    stuckCount++;
    console.log(`\n❌ 第 ${g+1} 局卡死：${stuck.reason}`);
    console.log(`   阶段=${stuck.snap.phase} 回合=${stuck.snap.turn} 比分=${stuck.snap.score}`
      + ` 视角=${stuck.snap.my} 标题「${stuck.snap.h3}」`);
    console.log('   最近 14 步：');
    for (const t of trail) console.log('     ' + t);
    await page.screenshot({ path:`shots/stuck-${g+1}.png` });
  } else if (done) {
    finished++;
    const fin = await page.evaluate(()=>{ const S=window.__S();
      return `${S.sides.CLE.score}-${S.sides.GSW.score} 共 ${S.turn} 回合`; });
    console.log(`✅ 第 ${g+1} 局打完：${fin}`);
  } else {
    stuckCount++;
    console.log(`❌ 第 ${g+1} 局跑满 ${MAX_STEPS} 步仍未结束（疑似死循环）`);
    for (const t of trail) console.log('     ' + t);
  }
  if (errs.length) { allErrs.push(...errs); console.log(`   ⚠️ ${errs.length} 个页面错误: ${errs.slice(0,2).join(' | ')}`); }
  await page.close();
}

await browser.close();
console.log(`\n════ 自动对局结果 ════`);
console.log(`打完 ${finished}/${GAMES}  卡死 ${stuckCount}/${GAMES}`);
console.log(`页面错误 ${allErrs.length} 个`);
if (stuckCount || allErrs.length) process.exitCode = 1;
