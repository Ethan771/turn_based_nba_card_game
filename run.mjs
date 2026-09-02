// 一行命令跑完：模拟校准 → 构建 → 浏览器断言测试 → 自动对局机器人。
// puppeteer 只装在 nba2k-player-ratings 里，所以测试在那边执行；
// 这个脚本负责搬运与清理，避免每次手动 cp 出错（已经因此丢过一次选择器修正）。
//
// ⚠️ playtest（自动对局）是交付前的必过关卡。
// 教训：曾交付过一个「88 项断言全绿但玩家实际操作两步就卡死」的版本 ——
// 断言测试只走脚本设计好的那条路径，走不到玩家真实操作序列的角落。
// 只有让机器人从头到尾打完整局、每一步都必须找到可点击项，才能证明"能玩"。
import { execFileSync } from 'child_process';
import { copyFileSync, rmSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve } from 'path';

const NODE = process.execPath;
const HERE = process.cwd();
const PUP = resolve(HERE, '../nba2k-player-ratings');   // 有 puppeteer 的目录

const step = (t) => console.log(`\n\x1b[1m▸ ${t}\x1b[0m`);
const run = (args, cwd) => execFileSync(NODE, args, { cwd, stdio:'inherit' });

const only = process.argv[2];   // sim / build / test / play 只跑一步
const collectShots = () => {
  const src = resolve(PUP,'shots');
  if (existsSync(src)) {
    mkdirSync(resolve(HERE,'shots'), { recursive:true });
    for (const f of readdirSync(src)) copyFileSync(resolve(src,f), resolve(HERE,'shots',f));
    rmSync(src, { recursive:true, force:true });
  }
};
const cleanup = (files) => {
  for (const f of files) { const t = resolve(PUP,f); if (existsSync(t)) rmSync(t); }
};

try {
  if (!only || only==='sim') {
    step('模拟校准（4000 局）');
    run(['sim.mjs','4000'], HERE);
  }
  if (!only || only==='build') {
    step('构建 game.html');
    run(['build.mjs'], HERE);
  }
  if (!only || only==='test') {
    step('浏览器断言测试');
    copyFileSync(resolve(HERE,'game.html'), resolve(PUP,'_game.html'));
    copyFileSync(resolve(HERE,'uitest.mjs'), resolve(PUP,'_uitest.mjs'));
    const p = resolve(PUP,'_uitest.mjs');
    const fs = await import('fs');
    fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace("resolve('game.html')", "resolve('_game.html')"));
    try { run(['_uitest.mjs'], PUP); }
    finally { collectShots(); cleanup(['_uitest.mjs']); }
  }
  if (!only || only==='play') {
    step('自动对局机器人（8 局完整对战，任何一局卡死即失败）');
    copyFileSync(resolve(HERE,'game.html'), resolve(PUP,'_game.html'));
    copyFileSync(resolve(HERE,'playtest.mjs'), resolve(PUP,'playtest.mjs'));
    try { run(['playtest.mjs','8'], PUP); }
    finally { collectShots(); cleanup(['_game.html','playtest.mjs']); }
  }
  console.log('\n\x1b[32m✔ 全部完成\x1b[0m  产物: game.html  截图: shots/');
} catch (e) {
  console.error(`\n\x1b[31m✘ 失败 —— 未通过的关卡不要交付\x1b[0m`);
  process.exitCode = 1;
}
