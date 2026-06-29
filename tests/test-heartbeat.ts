#!/usr/bin/env ts-node
// A 型心跳测试 — 验证空闲巡检机制
import { loadConfig } from '../src/config';
import { Orchestrator } from '../src/core/orchestrator';
import { getProjectManager } from '../src/core/projects/project-manager';
import { getRegistry } from '../src/skills/registry';
import { getGapDetector } from '../src/skills/gap-detector';
import { getCircuitBreaker } from '../src/resilience/circuit-breaker';
import { getCheckpointManager } from '../src/resilience/checkpoint';
import logger from '../src/logger';

const SEP = '─'.repeat(50);
let passed = 0, failed = 0;

function ok(name: string) { passed++; console.log('  ✓', name); }
function fail(name: string, err?: string) { failed++; console.log('  ✗', name, err ? ': ' + err : ''); }

async function main() {
  console.log('\n=== A 型心跳测试 ===\n');
  loadConfig();

  // ─── 1. 心跳启停 ───
  console.log('--- 1. Heartbeat Lifecycle ---');
  const orch = new Orchestrator({ heartbeatIntervalMs: 500 }); // 快频测试

  let heartbeats = 0;
  orch.on('heartbeat', () => { heartbeats++; });

  try {
    orch.startHeartbeat();
    ok('heartbeat started');
  } catch (e: any) { fail('start', e.message); }

  // 等待至少 1 次心跳
  await sleep(1200);
  try {
    if (heartbeats >= 1) ok('heartbeat fired (' + heartbeats + 'x in 1.2s @ 500ms interval)');
    else fail('heartbeat never fired');
  } catch (e: any) { fail('heartbeat check', e.message); }

  try {
    orch.stopHeartbeat();
    ok('heartbeat stopped');
  } catch (e: any) { fail('stop', e.message); }

  // ─── 2. 心跳不触发忙时 ───
  console.log('\n--- 2. Busy Gating ---');
  const orch2 = new Orchestrator({ heartbeatIntervalMs: 300 });
  let busyHeartbeats = 0;
  orch2.on('heartbeat', () => { busyHeartbeats++; });

  // 模拟忙碌（直接设置私有字段）
  (orch2 as any).isBusy = true;
  orch2.startHeartbeat();
  await sleep(1000);
  orch2.stopHeartbeat();

  try {
    if (busyHeartbeats === 0) ok('heartbeat skipped when busy');
    else fail('heartbeat fired while busy (' + busyHeartbeats + 'x)');
  } catch (e: any) { fail('busy gating', e.message); }

  // ─── 3. 心跳巡检内容 ───
  console.log('\n--- 3. Heartbeat Patrol ---');
  const pm = getProjectManager();
  const breaker = getCircuitBreaker();
  const ckpt = getCheckpointManager();

  // 创建测试项目
  const projName = 'hb-test-' + Date.now();
  pm.createProject(projName, { description: 'Heartbeat test', priority: 'P1' });
  pm.addTodo(projName, { title: 'Task 1', status: 'done', priority: 'P1' });
  pm.addTodo(projName, { title: 'Task 2', status: 'in_progress', priority: 'P1' });

  // 创建检查点
  ckpt.registerTask('hb-ckpt-test', 'test request', [{ id: 'hb-1', title: 'pending task', dependsOn: [], tool: 'none', description: 'test', status: 'pending' as const, estimatedMinutes: 1 }]);

  // 注册技能缺口
  const gap = getGapDetector();
  gap.detect({ action: 'test', needed: 'test_skill', error: 'test' });

  const orch3 = new Orchestrator({ heartbeatIntervalMs: 400 });
  let patrols = 0;
  orch3.on('heartbeat', () => { patrols++; });

  orch3.startHeartbeat();
  await sleep(1000);
  orch3.stopHeartbeat();

  try {
    if (patrols >= 1) ok('patrol heartbeat fired (' + patrols + 'x)');
    else fail('patrol never fired');
  } catch { fail('patrol check'); }

  // 清理
  // pm.deleteProject not available (skip cleanup)
  ckpt.complete('hb-ckpt-test');

  // ─── 4. 心跳配置验证 ───
  console.log('\n--- 4. Config Validation ---');
  try {
    const orch4 = new Orchestrator();
    if (orch4.config.heartbeatIntervalMs === 300000) ok('default interval = 5min');
    else fail('default interval mismatch: ' + orch4.config.heartbeatIntervalMs);
  } catch (e: any) { fail('config', e.message); }

  // ─── 5. 重复启动保护 ───
  console.log('\n--- 5. Double-Start Protection ---');
  const orch5 = new Orchestrator({ heartbeatIntervalMs: 1000 });
  orch5.startHeartbeat();
  orch5.startHeartbeat(); // 不应创建第二个定时器
  let hb5 = 0;
  orch5.on('heartbeat', () => { hb5++; });
  await sleep(1500);
  orch5.stopHeartbeat();

  try {
    if (hb5 <= 2) ok('no duplicate timers (hb=' + hb5 + ')');
    else fail('duplicate timers suspected (hb=' + hb5 + ')');
  } catch { fail('duplicate'); }

  // ─── 结果 ───
  console.log('\n' + SEP);
  const total = passed + failed;
  console.log('通过: ' + passed + '/' + total + ' (' + Math.round(passed / total * 100) + '%)');
  if (failed > 0) { console.log('失败: ' + failed + ' 项'); process.exit(1); }
  else console.log('✅ 全部通过!');
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
