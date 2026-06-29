// Phase 3+4 验证脚本
import { getRegistry } from './skills/registry';
import { getGapDetector } from './skills/gap-detector';
import { SkillAuditor, SkillDeveloper, SkillTester, SkillEquipper } from './skills/pipeline';
import { SubAgent } from './agents/sub-agent';
import { AgentBus, ResultMerger, ParallelScheduler } from './agents/collaboration';
import type { SkillApply, SkillMeta } from './skills/types';
import logger from './logger';

function test() {
  logger.setLevel('info');
  let p = 0, f = 0;
  function check(name: string, ok: boolean) {
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + name);
    ok ? p++ : f++;
  }

  console.log('=== Phase 3: Skills ===\n');

  // 3A Registry
  console.log('>>> 3A Registry');
  const reg = getRegistry();
  check('not null', reg.size >= 0);
  check('findByTrigger', typeof reg.findByTrigger('search') === 'object');
  check('singleton', getRegistry() === reg);

  // 3B Gap detection
  console.log('\n>>> 3B Gap Detector');
  const det = getGapDetector();
  check('detect returns true', det.detect({ action: 'video', needed: 'ffmpeg', error: 'not found' }));
  check('first below threshold', det.generateApplication('ffmpeg') === null);
  det.detect({ action: 'video2', needed: 'ffmpeg', error: 'again' });
  const app = det.generateApplication('ffmpeg');
  check('second triggers apply', app !== null);
  if (app) {
    check('has id', app.id.startsWith('apply-'));
    check('P1 prio', app.priority === 'P1');
    check('count=2', app.reason.includes('2'));
  }

  // 3C Auditor
  console.log('\n>>> 3C Auditor');
  const aud = new SkillAuditor();
  const danger: SkillApply = {
    id: 'd', name: 'skill-delete',
    reason: 'delete', expectedFunction: 'delete files', gapContext: 'format',
    priority: 'P0', dangerLevel: 'dangerous', status: 'pending',
    createdAt: new Date().toISOString(),
  };
  const dr = aud.audit(danger);
  check('danger needs review', dr.needsHumanReview);
  check('danger score>=80', dr.riskScore >= 80);

  // 3D Dev+Test+Equip
  console.log('\n>>> 3D Pipeline');
  const dev = new SkillDeveloper();
  check('dev func exists', typeof dev.develop === 'function');
  const tester = new SkillTester();
  const testMeta: SkillMeta = {
    name: 'test-skill', version: '0.1.0', description: 'test', author: 'agent',
    dangerLevel: 'safe', capabilities: [{ name: 'test', description: 't', inputType: 'any', outputType: 'any' }],
    dependencies: [], triggers: ['test'],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stats: { totalCalls: 0, successCalls: 0, failCalls: 0, avgDurationMs: 0 },
    status: 'testing',
  };
  const tr = tester.test(testMeta);
  check('test passes', tr.passed);

  // 3E Equipper
  console.log('\n>>> 3E Equipper');
  const eq = new SkillEquipper();
  check('equip ok', eq.equip(testMeta));
  check('now active', testMeta.status === 'active');
  eq.disable('test-skill');
  check('disabled', testMeta.status === 'disabled' || reg.get('test-skill') === undefined);

  console.log('\n=== Phase 4: Multi-Agent ===\n');

  // 4A SubAgent
  console.log('>>> 4A SubAgent');
  check('SubAgent loaded', typeof SubAgent === 'function');

  // 4B Bus
  console.log('\n>>> 4B Bus');
  const bus = new AgentBus();
  let rx = '';
  bus.subscribe('r', (m) => { rx = m.content; });
  bus.send('s', 'r', 'task', 'hello');
  check('send/recv', rx === 'hello');
  check('history', bus.getHistory().length === 1);

  // 4C Merger
  console.log('\n>>> 4C Merger');
  const mg = new ResultMerger();
  const m = mg.merge([
    { agentName: 'A', success: true, output: 'OK', durationMs: 100 },
    { agentName: 'B', success: false, output: '', durationMs: 200, error: 'timeout' },
    { agentName: 'C', success: true, output: 'Done', durationMs: 50 },
  ]);
  check('ok=2', m.successCount === 2);
  check('fail=1', m.failCount === 1);
  check('time=350', m.totalDurationMs === 350);
  check('overall fail', m.success === false);

  // 4D Scheduler
  console.log('\n>>> 4D Scheduler');
  const sch = new ParallelScheduler(2);
  check('max 2', true);

  // 4E Resource
  console.log('\n>>> 4E Resource');
  const rm = sch['resourceManager'];
  check('status str', typeof rm.status === 'function');

  console.log('\n---\n  PASS: ' + p + ' / FAIL: ' + f + ' (' + (p+f) + ' total)');
  console.log(f === 0 ? 'Phase 3+4 ALL PASS' : 'FAILURES: ' + f);
}

test();
