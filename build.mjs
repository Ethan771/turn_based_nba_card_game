// 把 rules.mjs 内联进 HTML，产出单文件游戏。
// 这样"模拟校准用的规则"与"实际玩的规则"是同一份代码，物理上不可能不一致。
import { readFileSync, writeFileSync } from 'fs';

const rules = readFileSync('rules.mjs', 'utf8');
const tpl = readFileSync('game.template.html', 'utf8');

// 去掉 export 语句，改为直接定义在模块作用域（HTML 里是 type=module，同作用域可见）
const inlined = rules.replace(/\nexport \{[\s\S]*?\};\s*$/m, '\n// (exports stripped for inline use)\n');

if (inlined.includes('export {')) { console.error('❌ export 未被剥离'); process.exit(1); }
if (!tpl.includes('/*__RULES__*/')) { console.error('❌ 模板缺少注入点'); process.exit(1); }

const out = tpl.replace('/*__RULES__*/', inlined);

// 校验注入结果
const checks = [
  ['ROSTERS', /const ROSTERS = \{/],
  ['computeDC', /function computeDC/],
  ['COACHES', /const COACHES = \{/],
  ['TUNING', /const TUNING = \{/],
  ['SHOT_ZH', /const SHOT_ZH/],
];
for (const [name, re] of checks) {
  if (!re.test(out)) { console.error(`❌ 注入后缺少 ${name}`); process.exit(1); }
}

writeFileSync('game.html', out);
console.log(`✅ game.html 已生成  ${(out.length/1024).toFixed(1)} KB`);
console.log(`   规则内核 ${(inlined.length/1024).toFixed(1)} KB 已内联`);
