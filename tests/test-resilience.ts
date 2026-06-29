/**
 * Phase 5 韧性层集成测试
 * 验证: HealthMonitor + RetryEngine + CircuitBreaker + Checkpoint + DegradationPath + Orchestrator
 */
import { HealthMonitor, getHealthMonitor } from '../src/resilience/health-monitor';
import { RetryEngine, getRetryEngine } from '../src/resilience/retry-engine';
import { CircuitBreaker, getCircuitBreaker } from '../src/resilience/circuit-breaker';
import { CheckpointManager, getCheckpointManager } from '../src/resilience/checkpoint';
import { DegradationPath, getDegradationPath } from '../src/resilience/degradation';
import { RecoveryOrchestrator, getRecoveryOrchestrator } from '../src/resilience/orchestrator';
import type { SubTask } from '../src/core/task-decomposer';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string) { passed++; console.log('  \u2713 ' + name); }
function fail(name: string, msg: string) { failed++; failures.push(name + ': ' + msg); console.log('  \u2717 ' + name + ': ' + msg); }

// Helper: create a minimal SubTask
function subTask(title: string, extra?: Partial<SubTask>): SubTask {
  return { id: 's' + Date.now(), title, description: 'test', tool: undefined, toolArgs: undefined, dependsOn: [], status: 'pending', estimatedMinutes: 1, ...extra };
}

async function run() {
  console.log('\n=== Phase 5 韧性层集成测试 ===\n');

  // ========== 5A: HealthMonitor ==========
  console.log('--- 5A HealthMonitor ---');

  try {
    const hm = new HealthMonitor();
    hm.recordPing(true);
    ok('records ping OK');
  } catch (e: any) { fail('records ping OK', e.message); }

  try {
    const hm = new HealthMonitor();
    const p = new Promise<void>((resolve) => hm.on('model_dead', () => resolve()));
    hm.recordPing(false); hm.recordPing(false); hm.recordPing(false);
    const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000));
    await Promise.race([p, timeout]);
    ok('detects model dead after 3 failures');
  } catch (e: any) { fail('detects model dead after 3 failures', e.message); }

  try {
    const hm = new HealthMonitor();
    const p = new Promise<void>((resolve) => hm.on('dead_loop', () => resolve()));
    for (let i = 0; i < 5; i++) hm.recordToolCall(null)
    const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000));
    await Promise.race([p, timeout]);
    ok('detects dead loop after 5 empty calls');
  } catch (e: any) { fail('detects dead loop', e.message); }

  try {
    const hm = new HealthMonitor();
    hm.config.tokenWarnMs = 50;
    hm.config.tokenDeadlineMs = 100;
    const p = new Promise<void>((resolve) => hm.on('stuck', () => resolve()));
    hm.watchTokenStream();
    const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
    await Promise.race([p, timeout]);
    ok('watchTokenStream timeout fires stuck event');
  } catch (e: any) { fail('watchTokenStream stuck', e.message); }

  try {
    const hm = new HealthMonitor();
    hm.recordPing(false); hm.recordPing(false);
    hm.reset(); // clears counters
    let emitted = false;
    hm.on('model_dead', () => { emitted = true; });
    hm.recordPing(false); // first after reset
    await new Promise(r => setTimeout(r, 200));
    if (emitted) throw new Error('emitted model_dead after only 1 failure post-reset');
    ok('reset clears failure counters');
  } catch (e: any) { fail('reset', e.message); }

  // ========== 5B: RetryEngine ==========
  console.log('\n--- 5B RetryEngine ---');

  for (const t of [
    { n: 'classifies timeout', f: () => {
      const f = new RetryEngine().classify(new Error('Request timed out after 30000ms'));
      if (f.type !== 'timeout') throw new Error('got ' + f.type);
    }},
    { n: 'classifies model unreachable', f: () => {
      const f = new RetryEngine().classify(new Error('model_unreachable: connection refused'));
      if (f.type !== 'model_unreachable') throw new Error('got ' + f.type);
    }},
    { n: 'classifies context overflow', f: () => {
      const f = new RetryEngine().classify(new Error('maximum context length exceeded'));
      if (f.type !== 'context_overflow') throw new Error('got ' + f.type);
    }},
    { n: 'classifies auth error', f: () => {
      const f = new RetryEngine().classify(new Error('401 Unauthorized - invalid API key'));
      if (f.type !== 'auth_error') throw new Error('got ' + f.type);
    }},
    { n: 'matches strategy with recovery actions', f: () => {
      const re = new RetryEngine();
      const s = re.match(re.classify(new Error('Request timed out')));
      if (s.maxRetries < 1) throw new Error('retries < 1');
      if (s.recoveryActions.length === 0) throw new Error('no actions');
    }},
    { n: 'calcDelay uses exponential backoff', f: () => {
      const re = new RetryEngine();
      const f = re.classify(new Error('timeout'));
      const s = re.match(f);
      const d0 = re.calcDelay(s, 0);
      const d1 = re.calcDelay(s, 1);
      if (d1 <= d0) throw new Error('d1=' + d1 + ' <= d0=' + d0);
    }},
    { n: 'fatal errors skip retries', f: () => {
      const f = new RetryEngine().classify(new Error('auth_error: invalid API key'));
      if (!new RetryEngine().match(f).fatal) throw new Error('Expected fatal');
    }},
  ]) {
    try { t.f(); ok(t.n); } catch (e: any) { fail(t.n, e.message); }
  }

  // ========== 5C: CircuitBreaker ==========
  console.log('\n--- 5C CircuitBreaker ---');

  for (const t of [
    { n: 'canUseModel returns true for unknown', f: () => {
      if (!new CircuitBreaker().canUseModel('unknown')) throw new Error('Expected true');
    }},
    { n: 'modelFailure trips after threshold', f: () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });
      cb.modelFailure('m', 'e1'); cb.modelFailure('m', 'e2');
      if (!cb.canUseModel('m')) throw new Error('should be open before 3');
      cb.modelFailure('m', 'e3');
      if (cb.canUseModel('m')) throw new Error('should be tripped at 3');
    }},
    { n: 'toolFailure trips tool circuit', f: () => {
      const cb = new CircuitBreaker({ failureThreshold: 2 });
      cb.toolFailure('t', 'e'); cb.toolFailure('t', 'e');
      if (cb.canUseTool('t')) throw new Error('should be tripped');
    }},
    { n: 'resetAll clears circuits', f: () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      cb.modelFailure('m', 'e');
      cb.resetAll();
      if (!cb.canUseModel('m')) throw new Error('should be cleared');
    }},
    { n: 'trip forces OPEN', f: () => {
      const cb = new CircuitBreaker();
      cb.trip('model', 'm');
      if (cb.canUseModel('m')) throw new Error('should be OPEN after trip');
    }},
  ]) {
    try { t.f(); ok(t.n); } catch (e: any) { fail(t.n, e.message); }
  }

  // half-open probe
  try {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    cb.modelFailure('m', 'e');
    await new Promise(r => setTimeout(r, 100));
    cb.modelSuccess('m'); // should close again
    if (!cb.canUseModel('m')) throw new Error('should be CLOSED after half-open success');
    ok('half-open probe succeeds');
  } catch (e: any) { fail('half-open probe', e.message); }

  // ========== 5D: Checkpoint ==========
  console.log('\n--- 5D Checkpoint ---');

  try {
    const ckm = getCheckpointManager();
    const tid = 'test-' + Date.now();
    ckm.registerTask(tid, 'verify', [subTask('s1')]);
    const pending = ckm.listPendingTasks();
    if (pending.length === 0) throw new Error('not in pending');
    ok('registerTask creates checkpoint');
  } catch (e: any) { fail('registerTask', e.message); }

  try {
    const ckm = getCheckpointManager();
    const tid = 'test-save-' + Date.now();
    ckm.registerTask(tid, 'save test', [subTask('s1')]);
    const completed = { step: subTask('s1', { status: 'done' }), result: { success: true, output: 'OK' }, completedAt: new Date().toISOString() };
    ckm.save(tid, completed, [subTask('s2')], []);
    const restored = ckm.load(tid);
    if (!restored) throw new Error('load null');
    if (restored.completedSteps.length !== 1) throw new Error('steps: ' + restored.completedSteps.length);
    ok('save and load checkpoint');
  } catch (e: any) { fail('save/load', e.message); }

  try {
    const ckm = getCheckpointManager();
    const tid = 'test-fail-' + Date.now();
    ckm.registerTask(tid, 'fail test', [subTask('s1')]);
    ckm.recordFailure(tid, { type: 'timeout', message: 'timed out', stepIndex: 0, recovered: false });
    const r = ckm.load(tid);
    if (!r || r.failures.length !== 1) throw new Error('failures: ' + (r?.failures.length ?? 'null'));
    ok('recordFailure stores failure');
  } catch (e: any) { fail('recordFailure', e.message); }

  try {
    const ckm = getCheckpointManager();
    const tid = 'test-complete-' + Date.now();
    ckm.registerTask(tid, 'complete test', [subTask('s1')]);
    ckm.complete(tid);
    if (ckm.load(tid)) throw new Error('should be null after complete');
    ok('complete removes from pending');
  } catch (e: any) { fail('complete', e.message); }

  try {
    const ckm = getCheckpointManager();
    const tid = 'test-summary-' + Date.now();
    ckm.registerTask(tid, 'summary test', [subTask('s1')]);
    const s = ckm.recoverySummary();
    if (s === 'No pending recovery tasks') throw new Error('no pending tasks');
    ok('recoverySummary shows pending tasks');
  } catch (e: any) { fail('recoverySummary', e.message); }

  // ========== 5E: DegradationPath ==========
  console.log('\n--- 5E DegradationPath ---');

  try {
    const dg = new DegradationPath();
    const r = await dg.executeWithDegradation(
      async (level) => 'Success L' + level,
      { originalTask: 'test' },
    );
    if (r.level !== 0) throw new Error('L' + r.level);
    ok('executes full level if no error');
  } catch (e: any) { fail('full level', e.message); }

  try {
    const dg = new DegradationPath({ maxLevel: 3 });
    let attempts = 0;
    const r = await dg.executeWithDegradation(
      async (level) => { attempts++; if (level < 3) throw new Error('fail L' + level); return 'Partial L' + level; },
      { originalTask: 'degrade test' },
    );
    if (attempts !== 4) throw new Error('attempts: ' + attempts + ' != 4');
    if (r.level !== 3) throw new Error('level: ' + r.level);
    if (!r.partialSuccess) throw new Error('not partial');
    ok('degrades after failures');
  } catch (e: any) { fail('degrades', e.message); }

  try {
    const dg = new DegradationPath({ maxLevel: 1 });
    const r = await dg.executeWithDegradation(
      async () => { throw new Error('Always fail'); },
      { originalTask: 'fallback test' },
    );
    if (r.level !== 4) throw new Error('level: ' + r.level);
    if (r.partialSuccess) throw new Error('got partialSuccess');
    ok('final fallback when all levels fail');
  } catch (e: any) { fail('fallback', e.message); }

  try {
    const dg = new DegradationPath();
    const diag = dg.generateDiagnostics('task X', ['L0: fail', 'L1: timeout']);
    if (!diag.includes('task X')) throw new Error('missing task');
    ok('generateDiagnostics includes task and reasons');
  } catch (e: any) { fail('diagnostics', e.message); }

  // ========== 5F: RecoveryOrchestrator ==========
  console.log('\n--- 5F RecoveryOrchestrator ---');

  try {
    const rec = new RecoveryOrchestrator();
    const r = await rec.executeProtected(async () => 'hello', { taskId: 't1' });
    if (!r.success || r.recovered) throw new Error('unexpected');
    ok('executeProtected clean success');
  } catch (e: any) { fail('clean success', e.message); }

  try {
    const rec = new RecoveryOrchestrator({ recoveryTimeoutMs: 5000 });
    let calls = 0;
    const r = await rec.executeProtected(async () => {
      calls++;
      if (calls === 1) throw new Error('Request timed out');
      return 'recovered';
    }, { taskId: 't2' });
    if (!r.success || !r.recovered || calls < 2) throw new Error('calls=' + calls);
    ok('executeProtected retries and recovers');
  } catch (e: any) { fail('retries', e.message); }

  try {
    const rec = new RecoveryOrchestrator({ maxRecoveryAttempts: 1, recoveryTimeoutMs: 3000 });
    const r = await rec.executeProtected(async () => { throw new Error('auth_error: always fail'); }, { taskId: 't3' });
    if (r.success) throw new Error('should fail');
    if (!r.degraded) throw new Error('should degrade');
    ok('executeProtected degrades after max retries');
  } catch (e: any) { fail('degrades', e.message); }

  try {
    const rec = new RecoveryOrchestrator();
    const s = rec.status();
    if (s.length < 10) throw new Error('too short');
    ok('status returns health + circuit + checkpoint info');
  } catch (e: any) { fail('status', e.message); }

  // ========== 结果 ==========
  console.log('\n=== 结果 ===');
  const total = passed + failed;
  console.log('通过: ' + passed + '/' + total + ' (' + (total > 0 ? (passed / total * 100).toFixed(0) : '0') + '%)');

  if (failed > 0) {
    console.log('\n失败明细:');
    failures.forEach(f => console.log('  \u2717 ' + f));
    process.exit(1);
  } else {
    console.log('✅ 全部通过!\n');
  }
}

run();
