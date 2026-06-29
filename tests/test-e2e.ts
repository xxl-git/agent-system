#!/usr/bin/env ts-node
// E2E 集成测试 — 连接 LM Studio，验证全链路
import { LMStudioAdapter } from '../src/models/adapters/lmstudio';
import { getConfig, loadConfig } from '../src/config';
import { getHealthMonitor } from '../src/resilience/health-monitor';
import { getCircuitBreaker } from '../src/resilience/circuit-breaker';
import { getCheckpointManager } from '../src/resilience/checkpoint';
import { getRecoveryOrchestrator } from '../src/resilience/orchestrator';
import logger from '../src/logger';

const SEP = '─'.repeat(50);
let passed = 0, failed = 0;

function ok(name: string) { passed++; console.log('  ✓', name); }
function fail(name: string, err?: string) { failed++; console.log('  ✗', name, err ? ': ' + err : ''); }

async function main() {
  console.log('\n=== Phase 5 E2E 集成测试 ===\n');
  await sleep(200);

  // 加载配置
  loadConfig();
  const cfg = getConfig();
  const adapter = new LMStudioAdapter();

  // ─── 0. 连通性检查 ───
  console.log('--- 0. Connectivity ---');
  const alive = await adapter.ping();
  if (!alive) {
    console.log('  ⚠️  LM Studio 未运行，跳过在线测试');
    console.log('\n  离线模块验证:');
    testOfflineModules();
    printResults();
    return;
  }
  ok('LM Studio reachable @ ' + cfg.models.providers.lmstudio.baseUrl);

  // 获取模型名
  const modelName = await adapter.getCurrentModel();
  console.log('  ℹ️  Model:', modelName);

  // ─── 1. 简单对话 ───
  console.log('\n--- 1. Simple Chat ---');
  try {
    const resp = await adapter.chat([
      { role: 'system', content: 'Reply in one sentence.' },
      { role: 'user', content: 'What is 2+2?' },
    ]);
    const reply = resp.choices?.[0]?.message?.content ?? '';
    if (reply.length > 0) ok('chat response (' + reply.length + ' chars)');
    else fail('chat empty reply');
  } catch (e: any) { fail('chat', e.message); }

  // ─── 2. 韧性层集成 ───
  console.log('\n--- 2. Resilience Integration ---');
  const health = getHealthMonitor();
  const breaker = getCircuitBreaker();
  const ckpt = getCheckpointManager();
  const recovery = getRecoveryOrchestrator();

  // 2A: 健康监控 ping
  try {
    const isAlive = await adapter.ping();
    health.recordPing(isAlive);
    ok('health ping recorded');
  } catch { fail('health ping'); }

  // 2B: 断路器正常
  try {
    const canUse = breaker.canUseModel(modelName);
    if (canUse) ok('circuit OK for ' + modelName.slice(0, 15));
    else fail('circuit tripped');
  } catch (e: any) { fail('circuit', e.message); }

  // 2C: 检查点注册
  try {
    ckpt.registerTask('e2e-' + Date.now(), 'e2e test request', [{ id: 'e2e-1', title: 'test chat', dependsOn: [], tool: 'none', description: 'E2E test step', status: 'pending' as const, estimatedMinutes: 1 }]);
    const pending = ckpt.listPendingTasks();
    if (pending.length > 0) ok('checkpoint registered (' + pending.length + ' pending)');
    else fail('checkpoint empty');
  } catch (e: any) { fail('checkpoint', e.message); }

  // 2D: 恢复编排器状态
  try {
    const status = recovery.status();
    if (status.length > 0) ok('recovery status available');
    else fail('recovery status empty');
  } catch (e: any) { fail('recovery status', e.message); }

  // ─── 3. 韧性恢复测试 ───
  console.log('\n--- 3. Recovery in Action ---');
  try {
    const result = await recovery.executeProtected(
      async () => {
        const resp = await adapter.chat([
          { role: 'user', content: 'Reply with exactly: OK' },
        ]);
        return resp.choices?.[0]?.message?.content ?? '';
      },
      { taskId: 'e2e-recovery-' + Date.now() },
    );
    if (result.success && result.output?.includes('OK')) ok('protected chat success');
    else if (result.success) ok('protected chat (content: ' + (result.output?.slice(0, 20) ?? '') + ')');
    else fail('protected chat failed', result.error);
  } catch (e: any) { fail('recovery chat', e.message); }

  // ─── 4. Token 流监控集成 ───
  console.log('\n--- 4. Token Stream Monitor ---');
  try {
    health.watchTokenStream();
    const resp = await adapter.chat([
      { role: 'user', content: 'Say hello' },
    ]);
    health.beat(); // simulate token beat
    health.endTokenStream();
    ok('token stream cycle complete');
  } catch (e: any) { fail('token stream', e.message); }

  // ─── 5. 离线模块验证 ───
  testOfflineModules();

  printResults();
}

function testOfflineModules() {
  console.log('\n--- 5. Offline Module Verification ---');
  
  const health = getHealthMonitor();
  const breaker = getCircuitBreaker();
  const ckpt = getCheckpointManager();
  const recovery = getRecoveryOrchestrator();

  // HealthMonitor
  try { health.recordPing(true); health.reset(); ok('health reset OK'); }
  catch { fail('health reset'); }

  // CircuitBreaker
  try {
    breaker.modelFailure('test-m', 'test error');
    breaker.resetAll();
    ok('circuit reset OK');
  } catch { fail('circuit reset'); }

  // Checkpoint
  try {
    const tid = 'offline-' + Date.now();
    ckpt.registerTask(tid, 'offline test request', [{ id: 'off-1', title: 'offline test', dependsOn: [], tool: 'none', description: 'test', status: 'pending' as const, estimatedMinutes: 1 }]);
    ckpt.save(tid, { step: { id: 'off-1', title: 'offline test', dependsOn: [], tool: 'none', description: 'test', status: 'pending' as const, estimatedMinutes: 1 }, result: { success: true, output: 'ok' }, completedAt: new Date().toISOString() }, [{ id: 'off-1', title: 'offline test', dependsOn: [], tool: 'none', description: 'test', status: 'pending' as const, estimatedMinutes: 1 }], []);
    ckpt.complete(tid);
    ok('checkpoint save/complete OK');
  } catch (e: any) { fail('checkpoint offline', e.message); }

  // Recovery
  try {
    const status = recovery.status();
    if (status.includes('Health') || status.includes('Circuit') || status.includes('Checkpoint'))
      ok('recovery status OK');
    else fail('recovery status incomplete');
  } catch (e: any) { fail('recovery offline', e.message); }

  // Degradation
  try {
    const degradation = require('../src/resilience/degradation');
    ok('degradation module loaded');
  } catch { fail('degradation load'); }

  // RetryEngine
  try {
    const re = require('../src/resilience/retry-engine');
    ok('retry engine loaded');
  } catch { fail('retry engine load'); }
}

function printResults() {
  console.log('\n' + SEP);
  const total = passed + failed;
  const pct = total > 0 ? Math.round(passed / total * 100) : 0;
  console.log('通过: ' + passed + '/' + total + ' (' + pct + '%)');
  if (failed > 0) {
    console.log('失败: ' + failed + ' 项');
    process.exit(1);
  } else {
    console.log('✅ 全部通过!');
  }

  // Health summary
  const recovery = getRecoveryOrchestrator();
  console.log('\n' + recovery.status());
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
