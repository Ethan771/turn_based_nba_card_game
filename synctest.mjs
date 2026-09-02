// 实测：file:// 协议下两个窗口能否通过 BroadcastChannel + localStorage 同步
import puppeteer from 'puppeteer';
import { pathToFileURL } from 'url';
import { resolve } from 'path';

const GAME = pathToFileURL(resolve('_game.html')).href;

const b = await puppeteer.launch({ headless:'new', args:['--allow-file-access-from-files'] });

// ── 场景 1：file:// 两窗口
const p1 = await b.newPage();
await p1.goto(GAME + '?side=CLE', { waitUntil:'domcontentloaded' });
await p1.evaluate(() => localStorage.clear());
await p1.reload({ waitUntil:'domcontentloaded' });
await new Promise(r=>setTimeout(r,700));

// 窗口1 建局
await p1.evaluate(() => {
  document.querySelector('[data-side="CLE"]')?.click();
  document.querySelector('#startbtn')?.click();
});
await new Promise(r=>setTimeout(r,600));
const s1 = await p1.evaluate(() => {
  const raw = localStorage.getItem('qiyong-2017-match');
  return { has: !!raw, seed: raw ? JSON.parse(raw).seed : null };
});
console.log('窗口1 建局:', s1);

// 窗口2 打开，看能否读到同一份存档
const p2 = await b.newPage();
await p2.goto(GAME + '?side=GSW', { waitUntil:'domcontentloaded' });
await new Promise(r=>setTimeout(r,800));
const s2 = await p2.evaluate(() => {
  const raw = localStorage.getItem('qiyong-2017-match');
  return { has: !!raw, seed: raw ? JSON.parse(raw).seed : null,
    appVisible: !document.getElementById('app').classList.contains('hide'),
    veilVisible: !document.getElementById('veil').classList.contains('hide') };
});
console.log('窗口2 读取  :', s2);
console.log('localStorage 跨窗口共享:', s1.seed === s2.seed && s2.has ? '✅ 是' : '❌ 否');

// 测 BroadcastChannel：窗口1 出招，看窗口2 是否收到
if (s2.seed === s1.seed) {
  await p1.evaluate(() => {
    const btn = document.querySelector('#actbox [data-act="pick"]');
    if (btn) btn.click();
  });
  await new Promise(r=>setTimeout(r,900));
  const picked = await p2.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('qiyong-2017-match'));
    return { cle: raw.picks.CLE, domShows: document.getElementById('cardOff').textContent.includes('已选定') };
  });
  console.log('窗口1 选人后，窗口2 状态:', picked);
  console.log('BroadcastChannel 跨窗口:', picked.cle ? '✅ 通' : '❌ 不通');
}

await b.close();
