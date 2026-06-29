#!/usr/bin/env ts-node
// P1 集成测试 — 跨会话记忆恢复 + 审计日志
import { loadConfig } from '../src/config';
import { SessionRecoverer, getSessionRecoverer } from '../src/memory/session-recovery';
import { AuditLog, getAuditLog, type AuditEvent } from '../src/audit/audit-log';
import { getDBStore } from '../src/memory/db-store';
import { initMemoryStore } from '../src/memory/file-store';
import logger from '../src/logger';

const SEP = '─'.repeat(50);
let passed = 0, failed = 0;

function ok(name: string) { passed++; console.log('  ✓', name); }
function fail(name: string, err?: string) { failed++; console.log('  ✗', name, err ? ': ' + err : ''); }

async function main() {
  console.log('\n=== P1 跨会话记忆恢复 + 审计日志 测试 ===\n');

  // 初始化基础设施
  loadConfig();
  const db = getDBStore();
  await db.init();

  // 写入测试数据
  db.startSession('test-session-recovery');
  db.addDecision({ timestamp: new Date().toISOString(), category: 'routing', summary: 'Routed task to ollama', detail: 'Chose ollama/llama3.2 for simple task', project: 'test' });
  db.addDecision({ timestamp: new Date().toISOString(), category: 'model', summary: 'Switched model due to timeout', detail: 'Switched from qwen to mistral', project: 'test' });
  db.upsertEntity({ name: 'ollama/llama3.2', type: 'model', first_seen: new Date().toISOString(), notes: '本地模型，免费' });
  db.upsertEntity({ name: 'qwen3.6-35b', type: 'model', first_seen: new Date().toISOString(), notes: 'LM Studio 主力' });
  db.endSession('test-session-recovery', 'Test session summary');

  // ─── 1. SessionRecoverer (7项) ───
  console.log('--- 1. Session Recoverer ---');
  const recoverer = getSessionRecoverer({ maxDecisions: 5, maxEntities: 5, maxSummaries: 3, recentDays: 7, maxInjectionChars: 2000 });

  try {
    const injection = recoverer.recover();
    
    // 1A: 决策恢复
    if (injection.recentDecisions.length >= 2) ok('decisions recovered (' + injection.recentDecisions.length + ')');
    else fail('decisions', 'expected >=2, got ' + injection.recentDecisions.length);

    // 1B: 实体恢复
    if (injection.trackedEntities.length >= 2) ok('entities recovered (' + injection.trackedEntities.length + ')');
    else fail('entities', 'expected >=2, got ' + injection.trackedEntities.length);

    // 1C: systemPromptBlock 非空
    if (injection.systemPromptBlock.length > 0) ok('system prompt block generated (' + injection.systemPromptBlock.length + ' chars)');
    else fail('prompt block empty');

    // 1D: 包含决策信息
    if (injection.systemPromptBlock.includes('Routed task')) ok('prompt contains decision content');
    else fail('prompt missing decision');

    // 1E: 包含实体信息
    if (injection.systemPromptBlock.includes('ollama')) ok('prompt contains entity');
    else fail('prompt missing entity');

    // 1F: 未超长度上限
    if (injection.systemPromptBlock.length <= 2100) ok('prompt within char limit');
    else fail('prompt too long: ' + injection.systemPromptBlock.length);

    // 1G: 单例获取
    const r2 = getSessionRecoverer();
    if (r2 === recoverer) ok('singleton works');
    else fail('singleton mismatch');
  } catch (e: any) { fail('recoverer', e.message); }

  // ─── 2. AuditLog (8项) ───
  console.log('\n--- 2. Audit Log ---');
  const audit = getAuditLog();

  try {
    // 2A: 启停会话
    const sid = 'test-audit-' + Date.now();
    audit.startSession(sid);
    ok('audit session started');
    audit.endSession('OK');
    ok('audit session ended');

    // 2B: 记录工具调用
    audit.logToolCall('write_file', { path: '/tmp/test.txt', size: 1024 }, 'success', 150);
    ok('tool call logged');

    // 2C: 记录决策
    audit.logDecision('routing', 'Chose best model', 'success', { durationMs: 23 });
    ok('decision logged');

    // 2D: 记录错误
    audit.logError('LMStudioAdapter', 'Connection refused', { url: 'http://localhost:1234' });
    ok('error logged');

    // 2E: 记录模型切换
    audit.logModelSwitch('qwen3.6', 'mistral', 'timeout');
    ok('model switch logged');

    // 2F: 记录恢复
    audit.logRecovery('retry', 'chat-task', 'success', 1200);
    ok('recovery logged');

    // 2G: 查询 - 全量
    const all = audit.query({ limit: 50 });
    if (all.length >= 4) ok('query returns events (' + all.length + ')');
    else fail('query', 'expected >=4, got ' + all.length);

    // 2H: 查询 - 按分类过滤
    const errors = audit.query({ category: 'error', limit: 10 });
    if (errors.length >= 1) ok('query by category');
    else fail('query category');

    // 2I: 查询 - 按关键词
    const found = audit.query({ keyword: 'mistral', limit: 10 });
    if (found.length >= 1) ok('query by keyword');
    else fail('query keyword');

    // 2J: 会话摘要
    const summary = audit.getSessionSummary();
    if (summary.includes('success') || summary.includes('events')) ok('session summary generated'); else fail('summary');
  } catch (e: any) { fail('audit', e.message); }

  // ─── 3. AuditLog 边界测试 (3项) ───
  console.log('\n--- 3. Audit Edge Cases ---');
  try {
    // 3A: 查询不存在
    const empty = audit.query({ keyword: 'nonexistent_xyz_999', limit: 5 });
    if (empty.length === 0) ok('empty query returns []');
    else fail('empty query returned ' + empty.length);

    // 3B: 长参数截断
    const longParams = { content: 'x'.repeat(2000) };
    audit.logToolCall('read_file', longParams, 'success', 10);
    ok('long params handled');

    // 3C: 事件计数
    const count = audit.getEventCount();
    if (count > 0) ok('event counter works (' + count + ')');
    else fail('event count zero');
  } catch (e: any) { fail('edge', e.message); }

  // ─── 4. 集成验证 (2项) ───
  console.log('\n--- 4. Integration ---');
  try {
    // 4A: 审计事件可序列化回读
    const recent = audit.query({ limit: 1 });
    if (recent.length > 0) {
      const json = JSON.stringify(recent[0]);
      const parsed: AuditEvent = JSON.parse(json);
      if (parsed.category && parsed.timestamp) ok('audit event roundtrip OK');
      else fail('roundtrip corrupt');
    } else { fail('no events to roundtrip'); }

    // 4B: DB + 审计共存
    db.endSession("test-audit-" + Date.now(), audit.getSessionSummary());
    ok('DB + audit coexistence');
  } catch (e: any) { fail('integration', e.message); }

  // ─── 结果 ───
  console.log('\n' + SEP);
  const total = passed + failed;
  console.log('通过: ' + passed + '/' + total + ' (' + Math.round(passed / total * 100) + '%)');
  if (failed > 0) { console.log('失败: ' + failed + ' 项'); process.exit(1); }
  else console.log('✅ 全部通过!');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
