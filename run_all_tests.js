const { execSync } = require('child_process');
const path = require('path');
const ROOT = 'D:/QClaw_Workspace/agent-system';
const tests = [
  'dist/__tests__/logger.test.js',
  'packages/core/dist/core/agent/__tests__/chat-handler.test.js',
  'packages/core/dist/core/agent/__tests__/command-handler.test.js',
  'packages/core/dist/core/agent/__tests__/task-handler.test.js',
  'packages/core/dist/core/__tests__/context-manager-p0.test.js',
  'packages/core/dist/core/__tests__/context-manager-pure.test.js',
  'packages/core/dist/core/__tests__/intent-parser.test.js',
  'packages/core/dist/core/__tests__/p2-fixes.test.js'
];
let totalPass = 0, totalFail = 0;
for (const t of tests) {
  const full = path.join(ROOT, t);
  try {
    const out = execSync(`node "${full}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = out.split('\n');
    const summary = (lines.filter(l => l.includes('通过') && l.includes('失败')).pop() || '(no summary)').trim();
    const pass = parseInt((out.match(/(\d+)\s*通过/) || [])[1] || '0', 10);
    const fail = parseInt((out.match(/(\d+)\s*失败/) || [])[1] || '0', 10);
    totalPass += pass; totalFail += fail;
    console.log(`[${fail === 0 ? 'OK' : 'FAIL'}] ${t}`);
    console.log('  ' + summary);
  } catch (e) {
    const msg = (e.stdout || '') + (e.stderr || e.message || '');
    const lines = msg.split('\n');
    const summary = (lines.filter(l => l.includes('通过') && l.includes('失败')).pop() || '(crashed)').trim();
    console.log(`[ERROR] ${t}`);
    console.log('  ' + summary);
    totalFail++;
  }
}
console.log('\n=== 汇总: 通过 ' + totalPass + ', 失败 ' + totalFail + ' ===');
console.log(totalFail === 0 ? 'ALL PASS' : 'HAS FAILURES');
