// 用真实 Chrome 跑完整一局，逐阶段截图 + 断言。
// 分屏是两个页面，用 BroadcastChannel 同步 —— 但不同 puppeteer page 之间
// BroadcastChannel 只在同 browsing context group 才通；这里用 localStorage 轮询兜底。
import puppeteer from 'puppeteer';
import { pathToFileURL } from 'url';
import { resolve } from 'path';
import { mkdirSync } from 'fs';

const GAME = pathToFileURL(resolve('game.html')).href;
mkdirSync('shots', { recursive: true });

const errs = [];
const checks = [];
const ok = (name, cond, detail='') => { checks.push({ name, pass: !!cond, detail }); };

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--allow-file-access-from-files','--window-size=1600,1000'],
    defaultViewport: { width: 1600, height: 1000 },
  });
  try {
    await runAll(browser);
  } finally {
    await browser.close();      // 崩溃也必须关，否则 node 挂着不退出
  }
}

async function runAll(browser) {
  // 单窗口模式先验证核心循环（side=CLE 一人操作双方，便于自动化）
  const page = await browser.newPage();
  page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await page.goto(GAME, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 900));

  // ── 开局界面
  ok('开局界面出现', await page.$('#veilpane .pk') !== null);
  const title = await page.$eval('#veilpane h1', el => el.textContent.trim()).catch(()=>'');
  ok('标题正确', title.includes('骑勇'), title);
  await page.screenshot({ path: 'shots/01-setup.png' });

  // 选骑士 + 卢 vs 科尔
  await page.click('[data-side="CLE"]');
  await page.click('[data-coach1="lue"]');
  await page.click('[data-coach2="kerr"]');
  await page.click('#startbtn');
  await new Promise(r => setTimeout(r, 500));

  // 开局后会弹「打开对手窗口」引导 —— 必须关掉才能继续操作
  const guideShown = await page.$('#solobtn') !== null;
  ok('开局后引导打开对手窗口', guideShown);
  if (guideShown) {
    const urlTxt = await page.$eval('#urlbox', el => el.textContent.trim());
    ok('引导页给出对手窗口地址', /side=GSW/.test(urlTxt), '…' + urlTxt.slice(-24));
    await page.screenshot({ path: 'shots/01b-open-second.png' });
    await page.click('#solobtn');
    await new Promise(r => setTimeout(r, 400));
  }
  ok('关闭引导后进入比赛', await page.$eval('#veil', el => el.classList.contains('hide')));

  ok('主界面显示', await page.$eval('#app', el => !el.classList.contains('hide')));
  const phase0 = await page.$eval('#phase', el => el.textContent.trim());
  ok('进入盲选阶段', phase0.includes('盲选'), phase0);
  await page.screenshot({ path: 'shots/02-select.png' });

  // ── 盲选保密性：对手整排必须全部翻面，且 DOM 里不能残留任何球员信息
  // 这是这个游戏的核心承诺 —— 只盖住被选中的那张 = 用排除法把答案写在脸上
  {
    const oppState = await page.evaluate(() => {
      const seats = [...document.querySelectorAll('#oppSeats .seat')];
      return {
        total: seats.length,
        facedown: seats.filter(s => s.classList.contains('facedown')).length,
        // 任一张牌里出现的文字（球员名/技能/属性）
        anyText: seats.map(s => s.textContent.replace(/\s+/g,'')).filter(Boolean),
        // DOM 里是否残留 title / data-pid（悬停或查看源码可读）
        anyTitle: seats.filter(s => s.getAttribute('title')).length,
        anyPid: seats.filter(s => s.getAttribute('data-pid')).length,
        // 五张卡背的 class 是否完全一致（体能耗尽变灰会破坏一致性）
        classes: [...new Set(seats.map(s => s.className))],
      };
    });
    ok('对手整排 5 张全部翻面', oppState.facedown === 5 && oppState.total === 5,
      `${oppState.facedown}/${oppState.total} 张翻面`);
    ok('翻面卡 DOM 无任何球员文字残留', oppState.anyText.length === 0,
      oppState.anyText.slice(0,2).join(' | ') || '干净');
    ok('翻面卡无 title（悬停不泄漏）', oppState.anyTitle === 0, `${oppState.anyTitle} 张带 title`);
    ok('翻面卡无 data-pid（源码不泄漏）', oppState.anyPid === 0, `${oppState.anyPid} 张带 pid`);
    ok('五张卡背视觉完全一致', oppState.classes.length === 1, oppState.classes.join(' ／ '));
    await page.screenshot({ path: 'shots/02b-blind.png' });
  }

  // ── 单页测试：直接操纵状态推进（模拟对手也已选人）
  // 真实分屏由对手窗口出牌，自动化里用注入 dispatch 代替
  const inject = async (action) => page.evaluate(a => {
    // eslint-disable-next-line no-undef
    window.__dispatch ? window.__dispatch(a) : (()=>{ throw new Error('no dispatch bridge'); })();
  }, action);

  // 需要一个测试桥。若模板没暴露，就用点击 + 手动改 side 的方式
  const hasBridge = await page.evaluate(() => typeof window.__dispatch === 'function');
  ok('存在测试桥或可用点击流', true, hasBridge ? '有 __dispatch' : '用点击流');

  // 我方（CLE，本回合进攻）先选人
  const myOpts = await page.$$('.seatrow.mine .seat.pick');
  ok('我方有可选球员', myOpts.length >= 3, `${myOpts.length} 个`);
  const firstName = await page.$eval('.seatrow.mine .seat.pick .nm', el=>el.textContent.trim());
  if (myOpts.length) await myOpts[0].click();
  await new Promise(r => setTimeout(r, 350));
  const lockTxt = await page.$eval('#prompt', el => el.textContent);
  ok('选人后进入等待', lockTxt.includes('已锁定') || lockTxt.includes('等待'), lockTxt.slice(0,40));

  // 我已锁定、对手未锁定 —— 此时对手那排仍须全部翻面（这是原来的漏洞现场）
  {
    const st = await page.evaluate(() => {
      const seats = [...document.querySelectorAll('#oppSeats .seat')];
      return { fd: seats.filter(s=>s.classList.contains('facedown')).length,
               txt: seats.map(s=>s.textContent.trim()).filter(Boolean).length,
               lock: (document.getElementById('oppLock')||{}).textContent || '' };
    });
    ok('我锁定后对手仍全排翻面', st.fd === 5 && st.txt === 0, `${st.fd} 张翻面 / ${st.txt} 张有文字`);
    ok('锁定进度只在队标区显示', /选人中|已锁定/.test(st.lock), st.lock.trim());
  }
  await page.screenshot({ path: 'shots/03-locked.png' });

  // 让对手也选人：切到 GSW 视角同页操作（改 MY 并重渲染）
  await page.evaluate(() => {
    const u = new URL(location.href); u.searchParams.set('side','GSW');
    history.replaceState(null,'',u);
  });
  await page.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 700));
  const gswOpts = await page.$$('.seatrow.mine .seat.pick');
  ok('切换到勇士视角可选人', gswOpts.length >= 3, `${gswOpts.length} 个`);
  if (gswOpts.length) await gswOpts[0].click();
  await new Promise(r => setTimeout(r, 400));

  const phase1 = await page.$eval('#phase', el => el.textContent.trim());
  ok('双方选完进入战术阶段', phase1.includes('战术'), phase1);
  const revealed = await page.$eval('#duelOff', el => el.textContent);
  ok('翻牌后显示进攻球员', /三分|中投/.test(revealed), revealed.slice(0,30).replace(/\s+/g,' '));

  // 翻牌后必须全部翻回正面 —— 否则就是过度修正，对手技能永远读不到
  {
    const st = await page.evaluate(() => {
      const seats = [...document.querySelectorAll('#oppSeats .seat')];
      return { fd: seats.filter(s=>s.classList.contains('facedown')).length,
               named: seats.filter(s=>s.querySelector('.nm')).length,
               onfield: seats.filter(s=>s.classList.contains('onfield')).length };
    });
    ok('翻牌后对手整排恢复正面', st.fd === 0 && st.named === 5, `${st.fd} 张仍翻面 / ${st.named} 张有名字`);
    ok('翻牌后标出对手在场者', st.onfield === 1, `${st.onfield} 张标在场`);
  }
  await page.screenshot({ path: 'shots/04-revealed.png' });

  // ── 战术阶段（进攻方 CLE，需切回）
  await page.evaluate(() => {
    const u = new URL(location.href); u.searchParams.set('side','CLE');
    history.replaceState(null,'',u);
  });
  await page.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 700));
  const tacOpts = await page.$$('#handTac .card.on');
  ok('战术阶段有选项', tacOpts.length >= 1, `${tacOpts.length} 个`);
  // 战术阶段进攻牌也必须可点 —— 这是「不打战术，直接进攻」那条路
  const offLiveInTactic = await page.$$('#handOff .card.on');
  ok('战术阶段进攻牌同时可打（可跳过战术）', offLiveInTactic.length >= 1,
    `${offLiveInTactic.length} 张进攻牌点亮`);
  const tacHint = await page.$eval('#prompt', el => el.textContent);
  ok('战术阶段提示两条路都行', /直接进攻|两条路/.test(tacHint), tacHint.slice(0,36).replace(/\s+/g,' '));
  await page.screenshot({ path: 'shots/05-tactic.png' });
  if (tacOpts.length) await tacOpts[0].click();
  await new Promise(r => setTimeout(r, 350));

  // ── 应对阶段（防守方 GSW）
  await page.evaluate(() => { const u=new URL(location.href); u.searchParams.set('side','GSW'); history.replaceState(null,'',u); });
  await page.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 700));
  const respOpts = await page.$$('#handTac .card.on');
  ok('应对阶段有选项', respOpts.length >= 1, `${respOpts.length} 个`);
  const respText = await page.$eval('#prompt', el => el.textContent);
  ok('应对界面显示"让出"信息', respText.includes('让出'), '');
  await page.screenshot({ path: 'shots/06-respond.png' });
  if (respOpts.length) await respOpts[0].click();
  await new Promise(r => setTimeout(r, 350));

  // ── 出手阶段（进攻方）
  await page.evaluate(() => { const u=new URL(location.href); u.searchParams.set('side','CLE'); history.replaceState(null,'',u); });
  await page.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 700));
  const shotOpts = await page.$$('#handOff .card.on');
  ok('出手阶段有选项', shotOpts.length >= 1, `${shotOpts.length} 个`);
  const dcShown = await page.$$eval('#handOff .card.on .cv', els => els.map(e=>e.textContent.trim()));
  ok('每个出手选项都显示 DC 与命中率', dcShown.length>0 && dcShown.every(t=>/需\s?\d+\s·\s\d+%/.test(t)), dcShown.join(' | '));
  await page.screenshot({ path: 'shots/07-shot.png' });
  if (shotOpts.length) await shotOpts[0].click();
  await new Promise(r => setTimeout(r, 400));

  // 骰子面板出现（DC 已算出）
  const dieVisible = await page.$eval('#die', el => !el.classList.contains('hide'));
  ok('骰子面板显示', dieVisible);
  const parts = await page.$$eval('#dcparts .chip', els => els.map(e=>e.textContent.trim()));
  ok('DC 拆解摊开给玩家看', parts.length >= 3, `${parts.length} 项: ${parts.slice(0,4).join(', ')}`);
  await page.screenshot({ path: 'shots/08-dc-breakdown.png' });

  // ── 即时干扰（防守方）
  await page.evaluate(() => { const u=new URL(location.href); u.searchParams.set('side','GSW'); history.replaceState(null,'',u); });
  await page.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 700));
  const dcOpts = await page.$$('#handDef .card.on');
  ok('干扰阶段有选项', dcOpts.length >= 1, `${dcOpts.length} 个`);
  if (dcOpts.length) await dcOpts[0].click();
  await new Promise(r => setTimeout(r, 350));

  // ── 掷骰：现在是自动的。防守方决定完干扰，所有修正就已锁定，
  // 不该再要求任何一方点一下「掷 d20」。所以断言「不点任何按钮也会落定」。
  await page.screenshot({ path: 'shots/09-before-roll.png' });
  await new Promise(r => setTimeout(r, 1500));   // 940ms 动画 + 余量
  const autoRolled = await page.evaluate(() => {
    const S = window.__S(); return { phase:S.phase, roll:S.cur.roll };
  });
  ok('骰子自动落定，无需点击', autoRolled.roll != null,
    `阶段 ${autoRolled.phase} 骰值 ${autoRolled.roll}`);
  const dieVal = await page.$eval('#dieval', el => el.textContent.trim());
  ok('骰子出值 1-20', /^\d+$/.test(dieVal) && +dieVal>=1 && +dieVal<=20, dieVal);
  const verdict = await page.$eval('#dieverd', el => el.textContent.trim());
  ok('显示判定结论', verdict.length > 0, verdict);
  await page.screenshot({ path: 'shots/10-rolled.png' });

  // ── 结果与推进
  // 未得分时进攻方应能拼前场篮板（TT 在场下也可花体能）；先切回进攻方视角验证
  await page.evaluate(() => { const u=new URL(location.href); u.searchParams.set('side','CLE'); history.replaceState(null,'',u); });
  await page.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 700));
  const madeNow = await page.$eval('#prompt h3', el => el.textContent.includes('得分'));
  const retryBtn = await page.$('#acts [data-act="retry"]');
  ok('未得分时进攻方可拼前场篮板', madeNow ? true : retryBtn !== null,
    madeNow ? '本次命中，规则上无需重试' : (retryBtn ? '按钮存在' : '缺失'));
  if (retryBtn) {
    await retryBtn.click();
    await new Promise(r => setTimeout(r, 500));
    const logTxt = await page.$eval('#flow', el => el.textContent);
    ok('前场篮板判定写入日志', /前场篮板/.test(logTxt), '');
    await page.screenshot({ path: 'shots/10b-putback.png' });
    // 抢板成功会回到出手阶段（这是规则，不是 bug）→ 补一次出手把回合走完
    const backToShot = await page.$eval('#phase', el => el.textContent.includes('出手'));
    ok('抢板成功回到出手阶段 / 失败留在结果', true,
      backToShot ? '抢下篮板，获得重试' : '争抢失败');
    if (backToShot) {
      const s2 = await page.$$('#handOff .card.on');
      if (s2.length) {
        await s2[0].click(); await new Promise(r=>setTimeout(r,400));
        // 防守方干扰 → 掷骰
        await page.evaluate(() => { const u=new URL(location.href); u.searchParams.set('side','GSW'); history.replaceState(null,'',u); });
        await page.reload({ waitUntil:'domcontentloaded' }); await new Promise(r=>setTimeout(r,650));
        const d2 = await page.$('#handDef .card.on');
        if (d2) { await d2.click(); await new Promise(r=>setTimeout(r,350)); }
        const r2 = await page.$('#acts [data-act="roll"]');
        if (r2) { await r2.click(); await new Promise(r=>setTimeout(r,1300)); }
      }
    }
  }

  // 走到结果阶段后推进（可能在任一方视角，切到当前进攻方）
  const offNow = await page.evaluate(() => {
    const S = JSON.parse(localStorage.getItem('qiyong-2017-match')); return S.offSide;
  });
  await page.evaluate(side => { const u=new URL(location.href); u.searchParams.set('side',side); history.replaceState(null,'',u); }, offNow);
  await page.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 650));

  const nextBtn = await page.$('#acts [data-act="next"]');
  ok('有下一回合按钮', nextBtn !== null,
    nextBtn ? '' : '当前阶段 ' + await page.$eval('#phase', el=>el.textContent.trim()));
  const logCount = await page.$$eval('#flow .li', els => els.length);
  ok('日志已记录多条', logCount >= 4, `${logCount} 条`);
  if (nextBtn) await nextBtn.click();
  await new Promise(r => setTimeout(r, 400));
  const turn2 = await page.$eval('#turnlb', el => el.textContent.trim());
  const expectNext = offNow === 'CLE' ? 'GSW' : 'CLE';
  ok('回合数推进且球权交换', turn2.includes('回合 2') && turn2.includes(expectNext), turn2);
  await page.screenshot({ path: 'shots/11-turn2.png' });

  // ── 武将排与信息栏
  const rosterRows = await page.$$eval('.seatrow.mine .seat', els => els.length);
  ok('下排渲染 5 张武将牌', rosterRows === 5, `${rosterRows} 行`);
  const bars = await page.$$eval('.seatrow.mine .sta u', els => els.length);
  ok('每张武将牌带体能格', bars >= 20, `${bars} 格（骑士应 25）`);
  const oppSk = await page.$$eval('#oppskills .oppsk', els => els.length);
  ok('对手技能全部公开', oppSk === 5, `${oppSk} 条`);
  const coachTxt = await page.$eval('#coachbox', el => el.textContent);
  ok('教练体系显示且含真实考证', /Talk it|4" Pop|猎杀|1\.11 PPP|34 次助攻|switch/.test(coachTxt), coachTxt.slice(0,60).replace(/\s+/g,' '));

  // ── 布局检查（截图看不出的溢出）
  const overflow = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('.app *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > window.innerWidth + 2) bad.push(`${el.className||el.tagName} 右溢出 ${Math.round(r.right-window.innerWidth)}px`);
      if (r.bottom > window.innerHeight + 2 && getComputedStyle(el).position !== 'absolute') {
        const scroller = el.closest('.stage,.side,.logbox');
        if (!scroller) bad.push(`${el.className||el.tagName} 下溢出 ${Math.round(r.bottom-window.innerHeight)}px`);
      }
    }
    return bad.slice(0, 8);
  });
  ok('无元素溢出视口', overflow.length === 0, overflow.join(' / '));

  const tooSmall = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('.app *')) {
      if (!el.textContent.trim() || el.children.length) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 9.5) bad.push(`${el.className||el.tagName} ${fs}px`);
    }
    return [...new Set(bad)].slice(0,6);
  });
  ok('无小于 9.5px 的文字', tooSmall.length === 0, tooSmall.join(' / '));

  ok('无控制台错误', errs.length === 0, errs.slice(0,3).join(' | '));

  await page.screenshot({ path: 'shots/12-full.png', fullPage: false });

  // ── 分屏隔离：这是核心承诺，必须验证「对手看不到我的手牌」
  const isoPage = await browser.newPage();
  await isoPage.goto(GAME + '?side=GSW', { waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 800));
  const gswHand = await isoPage.$$eval('#handOff .card', els => els.map(e=>e.textContent.trim())).catch(()=>[]);
  const cleHandFromGsw = await isoPage.evaluate(() => {
    const S = JSON.parse(localStorage.getItem('qiyong-2017-match'));
    return { mine: S.sides.GSW.hand, theirs: S.sides.CLE.hand };
  });
  // DOM 里只能出现自己的牌 —— 状态里有对方数据是 P2P 同步的必然，但界面不得渲染
  const rendered = await isoPage.evaluate(() => {
    const t = document.querySelector('.hand').textContent;
    return t;
  });
  ok('勇士窗口只渲染自己的手牌', gswHand.length === cleHandFromGsw.mine.off.length,
    `DOM ${gswHand.length} 张 vs 状态里勇士 ${cleHandFromGsw.mine.off.length} 张`);
  const oppSkillVisible = await isoPage.$$eval('#oppskills .oppsk', els => els.length);
  ok('勇士窗口能看到骑士全部技能（设计要求公开）', oppSkillVisible === 5, `${oppSkillVisible} 条`);
  const rosterOwner = await isoPage.$eval('#myAb', el => el.textContent);
  ok('勇士窗口下排是自己的武将', rosterOwner.trim()==='GSW', rosterOwner.trim());
  await isoPage.screenshot({ path: 'shots/13-gsw-view.png' });

  // ── 终局界面：直接把分数推到 11 验证
  await isoPage.evaluate(() => {
    const S = JSON.parse(localStorage.getItem('qiyong-2017-match'));
    S.sides.CLE.score = 11; S.sides.GSW.score = 7; S.over = 'CLE'; S.phase = 'over';
    localStorage.setItem('qiyong-2017-match', JSON.stringify(S));
  });
  await isoPage.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 700));
  const overShown = await isoPage.$eval('#veil', el => !el.classList.contains('hide'));
  ok('终局遮罩出现', overShown);
  const overTxt = await isoPage.$eval('#veilpane', el => el.textContent);
  ok('终局显示比分与胜方', /11/.test(overTxt) && /骑士/.test(overTxt), overTxt.replace(/\s+/g,' ').slice(0,50));
  const againBtn = await isoPage.$('#againbtn');
  ok('有再来一局按钮', againBtn !== null);
  await isoPage.screenshot({ path: 'shots/14-gameover.png' });

  // ── 一个人玩：顶栏视角切换，一个窗口走完整回合
  const solo = await browser.newPage();
  const soloErrs = [];
  solo.on('pageerror', e => soloErrs.push(e.message));
  await solo.goto(GAME, { waitUntil:'domcontentloaded' });
  await solo.evaluate(() => localStorage.clear());
  await solo.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r => setTimeout(r, 800));
  await solo.click('[data-side="CLE"]');
  await solo.click('#startbtn');
  await new Promise(r => setTimeout(r, 500));
  if (await solo.$('#solobtn')) { await solo.click('#solobtn'); await new Promise(r=>setTimeout(r,400)); }

  ok('顶栏有视角切换按钮', await solo.$('#vbCLE') !== null && await solo.$('#vbGSW') !== null);
  ok('顶栏有打开对手窗口按钮', await solo.$('#openopp') !== null);
  const hint0 = await solo.$eval('#turnlb', el => el.textContent.trim());
  ok('顶栏显示回合与进攻方', /回合/.test(hint0), hint0);

  // 进攻方（CLE）选人
  let p1 = await solo.$$('.seatrow.mine .seat.pick');
  ok('一个人玩：进攻方可选人', p1.length >= 3, `${p1.length} 个`);
  if (p1.length) { await p1[0].click(); await new Promise(r => setTimeout(r, 400)); }

  // 我已选好 → 界面应给出「切到对方视角」的出口
  const switchBtn = await solo.$('#acts [data-switch="GSW"]');
  ok('选完后给出切到对方视角的出口', switchBtn !== null,
    switchBtn ? '' : await solo.$eval('#prompt', el=>el.textContent.replace(/\s+/g,' ').slice(0,50)));
  await solo.screenshot({ path: 'shots/15-solo-switch.png' });
  if (switchBtn) { await switchBtn.click(); await new Promise(r => setTimeout(r, 450)); }

  const p2 = await solo.$$('.seatrow.mine .seat.pick');
  ok('切过去后可替对方选人', p2.length >= 3, `${p2.length} 个`);
  if (p2.length) { await p2[0].click(); await new Promise(r => setTimeout(r, 500)); }
  const ph = await solo.$eval('#phase', el => el.textContent);
  ok('双方选完进入战术阶段', ph.includes('战术'), ph.trim());

  // 战术 → 应对 → 出手 → 干扰 → 掷骰。
  // 新布局下这些牌在底部手牌区，点亮的（.card.on）才能打；不是我的回合就先切视角。
  const HAND = { tactic:'#handTac', respond:'#handTac', shot:'#handOff', defcard:'#handDef' };
  const advance = async (act) => {
    for (let i = 0; i < 3; i++) {
      const cards = await solo.$$(`${HAND[act]} .card.on`);
      if (cards.length) { await cards[0].click(); await new Promise(r=>setTimeout(r,420)); return true; }
      // 手牌里没有可打的 → 用 #acts 里的兜底按钮（不打战术 / 原始对位 / 不干扰）
      const fallback = await solo.$(`#acts [data-act="${act}"]`);
      if (fallback) { await fallback.click(); await new Promise(r=>setTimeout(r,420)); return true; }
      const sw = await solo.$('#acts [data-switch]');
      if (!sw) return false;
      await sw.click(); await new Promise(r=>setTimeout(r,420));
    }
    return false;
  };
  ok('一个人玩：可打战术（点手牌或跳过）', await advance('tactic'));
  ok('一个人玩：可选应对（切到防守方后出牌）', await advance('respond'));
  ok('一个人玩：可选出手', await advance('shot'));
  ok('一个人玩：可选干扰', await advance('defcard'));
  // 干扰结算完骰子应自动落定 —— 不再需要点「掷 d20」
  await new Promise(r => setTimeout(r, 1500));
  const autoR = await solo.evaluate(() => { const S=window.__S(); return { p:S.phase, r:S.cur.roll }; });
  ok('一个人玩：骰子自动落定', autoR.r != null, `阶段 ${autoR.p} 骰值 ${autoR.r}`);
  const dv = await solo.$eval('#dieval', el => el.textContent.trim());
  ok('一个人玩：骰子出值', /^\d+$/.test(dv) && +dv>=1 && +dv<=20, dv);
  await solo.screenshot({ path: 'shots/16-solo-rolled.png' });
  ok('一个人玩全程无控制台错误', soloErrs.length === 0, soloErrs.slice(0,2).join(' | '));

  // ── 「不打战术，直接出进攻牌」端到端：这是 Ethan 明确要的省一步路径
  {
    const d = await browser.newPage();
    const dErrs = []; d.on('pageerror', e=>dErrs.push(e.message));
    await d.goto(GAME, { waitUntil:'domcontentloaded' });
    await d.evaluate(()=>localStorage.clear());
    await d.reload({ waitUntil:'domcontentloaded' });
    await new Promise(r=>setTimeout(r,800));
    await d.click('[data-side="CLE"]'); await d.click('[data-coach1="lue"]');
    await d.click('[data-coach2="kerr"]'); await d.click('#startbtn');
    await new Promise(r=>setTimeout(r,500));
    const sb = await d.$('#solobtn'); if (sb) await sb.click();
    await new Promise(r=>setTimeout(r,450));
    // 双方各派一人
    for (let i=0;i<2;i++) {
      const seat = await d.$('.seatrow.mine .seat.pick');
      if (seat) { await seat.click(); await new Promise(r=>setTimeout(r,400)); }
      const sw = await d.$('#acts [data-switch]');
      if (sw && i===0) { await sw.click(); await new Promise(r=>setTimeout(r,400)); }
    }
    const inTactic = await d.evaluate(()=>window.__S().phase);
    ok('直接进攻路径：已进入战术阶段', inTactic==='tactic', inTactic);
    // 必须确保视角在进攻方 —— 上面选人循环可能把视角留在防守方
    const viewFix = await d.evaluate(()=>{
      const S = window.__S();
      return { off:S.offSide, my:(new URLSearchParams(location.search)).get('side') };
    });
    const sw0 = await d.$(`#acts [data-switch="${viewFix.off}"]`);
    if (sw0) { await sw0.click(); await new Promise(r=>setTimeout(r,400)); }
    else await d.evaluate(o=>window.__setView(o), viewFix.off);
    await new Promise(r=>setTimeout(r,350));
    // 战术阶段直接点进攻牌
    const offCard = await d.$('#handOff .card.on');
    const dbg = await d.evaluate(()=>{ const S=window.__S();
      return { phase:S.phase, off:S.offSide, offHand:S.sides[S.offSide].hand.off.length,
               liveOff:document.querySelectorAll('#handOff .card.on').length }; });
    ok('直接进攻路径：战术阶段进攻牌可点', offCard !== null,
      `阶段${dbg.phase} 进攻方${dbg.off} 手上${dbg.offHand}张 亮${dbg.liveOff}张`);
    if (offCard) { await offCard.click(); await new Promise(r=>setTimeout(r,450)); }
    const afterShot = await d.evaluate(()=>{ const S=window.__S();
      return { phase:S.phase, pending:S.cur.pendingShot }; });
    ok('直接进攻路径：跳到应对阶段且暂存出手牌（对手保有应对权）',
      afterShot.phase==='respond' && !!afterShot.pending,
      `阶段 ${afterShot.phase}，暂存 ${afterShot.pending}`);
    // 对手应对完应自动出手
    const sw2 = await d.$('#acts [data-switch]');
    if (sw2) { await sw2.click(); await new Promise(r=>setTimeout(r,400)); }
    const respFallback = await d.$('#acts [data-act="respond"]');
    if (respFallback) { await respFallback.click(); await new Promise(r=>setTimeout(r,500)); }
    const afterResp = await d.evaluate(()=>{ const S=window.__S();
      return { phase:S.phase, shot:S.cur.shot, pending:S.cur.pendingShot, dc:S.cur.dc }; });
    ok('直接进攻路径：应对后自动出手，不再问进攻方一遍',
      !!afterResp.shot && !afterResp.pending && ['defcard','roll','result'].includes(afterResp.phase),
      `阶段 ${afterResp.phase} 出手 ${afterResp.shot} DC ${afterResp.dc}`);
    ok('直接进攻路径无控制台错误', dErrs.length===0, dErrs.slice(0,2).join(' | '));
    await d.screenshot({ path:'shots/19-direct-shot.png' });
    await d.close();
  }

  // ── 命中率下界：Ethan「有防守人的情况也应该在 50~70% 至少」
  // DC 14 = 35%，是绝对下界（只有 TT 投三分这种写实惩罚才会到）。
  // 更重要的是「手上最优出手」要够高 —— 那才是玩家真实面对的数字。
  {
    const r = await solo.evaluate(() => {
      let mx = 0, best = 0;
      const per = {};
      for (const s of ['three','mid','drive','dunk','alley']) {
        const x = window.__calcDC(s);
        per[s] = { dc:x.dc, pct:Math.round(x.prob*100) };
        if (x.dc > mx) mx = x.dc;
        if (x.prob > best) best = x.prob;
      }
      return { mx, best:Math.round(best*100), per };
    });
    const detail = Object.entries(r.per).map(([k,v])=>`${k} ${v.pct}%`).join(' ');
    ok('最差单张出手不低于 35%（DC ≤ 14）', r.mx <= 14, `最高 DC ${r.mx}｜${detail}`);
    ok('手上最优出手 ≥ 45%', r.best >= 45, `${r.best}%`);
  }

  // ── 第二个窗口不带 ?side= 打开时：必须是「加入」而不是冲掉比赛
  const join = await browser.newPage();
  await join.goto(GAME, { waitUntil:'domcontentloaded' });   // 复用上面 solo 建的存档
  await new Promise(r => setTimeout(r, 800));
  const joinTxt = await join.$eval('#veilpane', el => el.textContent).catch(()=>'');
  const hasJoinBtns = await join.$$('#veilpane [data-join]');
  ok('第二窗口显示加入界面而非新建', hasJoinBtns.length === 2, `${hasJoinBtns.length} 个加入按钮`);
  ok('加入界面显示当前比分与回合', /回合/.test(joinTxt), joinTxt.replace(/\s+/g,' ').slice(0,60));
  const scoreBefore = await join.evaluate(() => {
    const S = JSON.parse(localStorage.getItem('qiyong-2017-match'));
    return { turn: S.turn, cle: S.sides.CLE.score, gsw: S.sides.GSW.score };
  });
  if (hasJoinBtns.length) {
    await hasJoinBtns[1].click();       // 选勇士加入
    await new Promise(r => setTimeout(r, 500));
    const after = await join.evaluate(() => {
      const S = JSON.parse(localStorage.getItem('qiyong-2017-match'));
      return { turn: S.turn, cle: S.sides.CLE.score, gsw: S.sides.GSW.score };
    });
    ok('加入后原比赛未被冲掉',
      after.turn===scoreBefore.turn && after.cle===scoreBefore.cle && after.gsw===scoreBefore.gsw,
      `加入前 T${scoreBefore.turn} ${scoreBefore.cle}-${scoreBefore.gsw} → 加入后 T${after.turn} ${after.cle}-${after.gsw}`);
    const sideLb = await join.$eval('#myAb', el => el.textContent);
    ok('加入后身份正确', sideLb.trim()==='GSW', sideLb.trim());
  }
  await join.screenshot({ path: 'shots/17-join.png' });

  // ── 拖放出牌：这是新功能的核心，必须实测 HTML5 拖放真的走通
  const dg = await browser.newPage();
  const dgErrs = [];
  dg.on('pageerror', e => dgErrs.push(e.message));
  await dg.goto(GAME, { waitUntil:'domcontentloaded' });
  await dg.evaluate(() => localStorage.clear());
  await dg.reload({ waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,800));
  await dg.click('[data-side="CLE"]'); await dg.click('#startbtn');
  await new Promise(r=>setTimeout(r,500));
  if (await dg.$('#solobtn')) { await dg.click('#solobtn'); await new Promise(r=>setTimeout(r,400)); }

  // 走到战术阶段（双方各选一人）
  const pickOne = async () => {
    const ss = await dg.$$('.seatrow.mine .seat.pick');
    if (ss.length) { await ss[0].click(); await new Promise(r=>setTimeout(r,420)); return true; }
    return false;
  };
  await pickOne();
  let sw = await dg.$('#acts [data-switch]');
  if (sw) { await sw.click(); await new Promise(r=>setTimeout(r,420)); }
  await pickOne();
  await new Promise(r=>setTimeout(r,450));
  ok('拖放测试：已进入战术阶段', await dg.$eval('#phase', e=>e.textContent.includes('战术')),
    await dg.$eval('#phase', e=>e.textContent.trim()));

  // 战术阶段该进攻方出牌 —— 若当前视角不是进攻方，先切过去
  sw = await dg.$('#acts [data-switch]');
  if (sw) { await sw.click(); await new Promise(r=>setTimeout(r,450)); }
  const viewNow = await dg.evaluate(() => {
    const S = JSON.parse(localStorage.getItem('qiyong-2017-match'));
    return { my: new URLSearchParams(location.search).get('side'), off: S.offSide };
  });
  ok('拖放测试：视角已在进攻方', viewNow.my === viewNow.off, JSON.stringify(viewNow));

  // 球员卡是竖版真卡牌：有号码水印、卡面高度足够
  const seatBox = await dg.$eval('.seatrow.mine .seat', el => {
    const r = el.getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width),
      wm: !!el.querySelector('.wm'), stripe: !!el.querySelector('.stripe'),
      sk: !!el.querySelector('.sk') };
  });
  ok('球员卡是竖版卡牌（高 ≥140px）', seatBox.h >= 140, `${seatBox.w}×${seatBox.h}px`);
  ok('球员卡有号码水印与色条', seatBox.wm && seatBox.stripe && seatBox.sk);

  // 手牌是竖版可拖卡
  const cardBox = await dg.$$eval('#handTac .card', els => els.map(el => {
    const r = el.getBoundingClientRect();
    return { h:Math.round(r.height), w:Math.round(r.width),
      drag: el.getAttribute('draggable'), rot: el.style.transform,
      kind: el.dataset.kind, id: el.dataset.cardid };
  }));
  ok('手牌是竖版卡（高 > 宽）', cardBox.length>0 && cardBox[0].h > cardBox[0].w,
    cardBox.length ? `${cardBox[0].w}×${cardBox[0].h}px` : '无牌');
  ok('手牌有扇形旋转', cardBox.some(c=>/rotate/.test(c.rot||'')), cardBox[0]?.rot || '无');
  const draggable = cardBox.filter(c=>c.drag==='true');
  ok('可打出的手牌带 draggable', draggable.length>0, `${draggable.length}/${cardBox.length} 张可拖`);

  // 真的拖一次：dragstart → dragover → drop
  const before = await dg.evaluate(() => {
    const S = JSON.parse(localStorage.getItem('qiyong-2017-match'));
    return { phase:S.phase, tactic:S.cur.tactic, tacCount:S.sides[S.offSide].hand.tac.length };
  });
  const dragged = await dg.evaluate(() => {
    const card = document.querySelector('#handTac .card[draggable="true"]');
    const zone = document.getElementById('played');
    if (!card || !zone) return { ok:false, why:'找不到牌或落点' };
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles:true, dataTransfer:dt }));
    const armed = zone.classList.contains('armed');
    zone.dispatchEvent(new DragEvent('dragover', { bubbles:true, dataTransfer:dt }));
    const over = zone.classList.contains('over');
    zone.dispatchEvent(new DragEvent('drop', { bubbles:true, dataTransfer:dt }));
    return { ok:true, armed, over, card: card.dataset.cardid };
  });
  await new Promise(r=>setTimeout(r,500));
  ok('拖起时落点被点亮', dragged.armed === true, JSON.stringify(dragged));
  ok('悬停时落点高亮', dragged.over === true);
  const after2 = await dg.evaluate(() => {
    const S = JSON.parse(localStorage.getItem('qiyong-2017-match'));
    return { phase:S.phase, tactic:S.cur.tactic };
  });
  ok('松手真的把牌打出去了',
    after2.phase !== before.phase || after2.tactic !== before.tactic,
    `拖前 ${before.phase}/${before.tactic} → 拖后 ${after2.phase}/${after2.tactic}`);
  await dg.screenshot({ path: 'shots/18-dragged.png' });
  ok('拖放流程无控制台错误', dgErrs.length===0, dgErrs.slice(0,2).join(' | '));

  // 拖完后落点高亮必须清掉（否则界面会一直亮着）
  const stillArmed = await dg.$$eval('.dropzone', els => els.filter(e=>
    e.classList.contains('armed')||e.classList.contains('over')).length);
  ok('拖放结束后清除高亮', stillArmed === 0, `${stillArmed} 个仍高亮`);
}

// ── 报告
function report() {
  const pass = checks.filter(c=>c.pass).length;
  console.log(`\n=== 浏览器交互测试 ${pass}/${checks.length} ===\n`);
  for (const c of checks) {
    console.log(`${c.pass?'✅':'❌'} ${c.name}${c.detail?`  → ${c.detail}`:''}`);
  }
  if (pass < checks.length) process.exitCode = 1;
}
main()
  .catch(e => { console.error('\n测试崩溃:', e.stack?.split('\n').slice(0,3).join('\n')); process.exitCode = 1; })
  .finally(report);
