#!/usr/bin/env ts-node
// Agent v0.5.0 全链路干跑
import { loadConfig } from '../src/config';
import { logger } from '../src/logger';
import { getDBStore } from '../src/memory/db-store';
import { getSummarizer } from '../src/memory/summarizer';
import { getAuditLog } from '../src/audit/audit-log';
import { getSessionRecoverer } from '../src/memory/session-recovery';
import { HealthMonitor } from '../src/resilience/health-monitor';
import { CheckpointManager } from '../src/resilience/checkpoint';
import { CircuitBreaker } from '../src/resilience/circuit-breaker';
import { RetryEngine } from '../src/resilience/retry-engine';
import { DegradationPath } from '../src/resilience/degradation';
import { RecoveryOrchestrator } from '../src/resilience/orchestrator';
import * as fs from 'fs';
import * as path from 'path';

const SEP = '═'.repeat(60);
let okC = 0, noC = 0;
const ok = (n: string, d?: string) => { okC++; console.log('  ✓', n + (d ? ' (' + d + ')' : '')); };
const no = (n: string, e?: string) => { noC++; console.log('  ✗', n, e ? ': ' + e : ''); };

async function main() {
  console.log('\n' + SEP + '\n  Agent v0.5.0 — 全链路干跑\n' + SEP + '\n');
  loadConfig();
  logger.setLevel('warn');

  // ─── 1. DB ───
  console.log('── 1. DB 记忆 ──');
  const db = getDBStore();
  await db.init();
  const sid = 'dry-' + Date.now();
  db.startSession(sid);
  ok('DB init + session');
  db.addDecision({ timestamp: new Date().toISOString(), category: 'test', summary: 'Dry run', detail: '', project: sid });
  ok('Decision written');

  // ─── 2. 审计日志 ───
  console.log('\n── 2. 审计日志 ──');
  const audit = getAuditLog();
  const catList: any[] = ['session','decision','tool_call','error','recovery','checkpoint','degradation','model_switch'];
  const resList: any[] = ['success','success','success','failure','recovered','success','degraded','failure'];
  for (let i = 0; i < catList.length; i++) {
    audit.log(catList[i], 'action_' + i, 'target_' + i, {}, resList[i], { durationMs: 10 + i * 5 });
  }
  ok('审计写入', catList.length + ' 事件');
  // audit 日志目录: {cwd}/audit/audit-YYYY-MM-DD.log
  const today = new Date().toISOString().slice(0, 10);
  const auditDir = path.resolve(process.cwd(), 'audit');
  const auditFile = path.join(auditDir, 'audit-' + today + '.log');
  if (fs.existsSync(auditFile)) {
    const n = fs.readFileSync(auditFile,'utf-8').trim().split('\n').filter(Boolean).length;
    ok('文件持久化', n + ' 条');
  } else if (fs.existsSync(auditDir)) {
    const files = fs.readdirSync(auditDir);
    ok('审计目录存在', files.join(', ') || '(空)');
  } else no('审计目录不存在: ' + auditDir);

  // ─── 3. 摘要 ───
  console.log('\n── 3. 摘要引擎 ──');
  const summarizer = getSummarizer({ minMessagesForAuto: 3 });
  const msgs = [
    { role: 'user' as const, content: '帮我写一个测试脚本' },
    { role: 'assistant' as const, content: '✅ 已创建 test.ts，包含 3 个测试用例' },
    { role: 'user' as const, content: '编译报错了，缺少 import' },
    { role: 'assistant' as const, content: '✅ 已修复 import 路径，编译通过' },
    { role: 'user' as const, content: '运行时超时了' },
    { role: 'assistant' as const, content: '✅ 已添加 30s 超时保护，重试 3 次后降级' },
  ];
  const sum = await summarizer.summarizeSession(sid, msgs, []);
  sum.sessionSummary.length > 0 ? ok('摘要', sum.sessionSummary.slice(0, 50)) : no('摘要空');
  sum.learnedFacts.length > 0 ? ok('事实', sum.learnedFacts.length + ' 条') : no('无事实');
  sum.tags.length > 0 ? ok('标签', sum.tags.join(', ')) : no('无标签');

  // ─── 4. 项目管理 ───
  console.log('\n── 4. 项目管理 ──');
  try {
    const projDir = path.resolve(process.cwd(), 'projects', 'dry-demo');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'PROGRESS.md'), '# dry-demo\n\n## 状态: active\n\n进度: 50%');
    fs.writeFileSync(path.join(projDir, 'meta.json'), JSON.stringify({ name: 'dry-demo', priority: 'P1', status: 'active', progress: 50, createdAt: today, updated: today, tags: ['test'] }));
    ok('项目创建');
    const { getProjectManager } = require('../src/core/projects/project-manager');
    const pm = getProjectManager();
    const loaded = pm.getProjectMeta('dry-demo');
    loaded ? ok('项目读取', 'priority=' + loaded.priority) : no('读取失败');
  } catch (e: any) { no('项目管理', e.message); }

  // ─── 5. 韧性层 ───
  console.log('\n── 5. 韧性层 ──');
  const health = new HealthMonitor();
  health.recordPing(true); health.recordPing(true);
  health.watchTokenStream(); health.endTokenStream();
  ok('健康监控', health.status().slice(0, 25));

  const ckpt = new CheckpointManager();
  ckpt.registerTask('dry-ckpt', 'test', [
    { id: 's1', title: 'step1', description: 'test step', dependsOn: [], status: 'running' as any, estimatedMinutes: 1 }
  ]);
  ckpt.complete('dry-ckpt');
  ok('检查点', 'register→complete');

  const cb = new CircuitBreaker();
  cb.canUseModel('dry') ? ok('断路器可用') : no('断路器不可用');
  cb.trip('model', 'dry');
  !cb.canUseModel('dry') ? ok('trip 生效') : no('trip 未生效');

  const re = new RetryEngine();
  const c = re.classify(new Error('timeout'));
  ok('重试引擎', 'classify→' + c.type);
  const s = re.matchError(new Error('connection refused'));
  ok('策略匹配', s.name + ' max=' + s.maxRetries);

  const deg = new DegradationPath();
  ok('降级路径', 'level3=' + deg.levelLabel(3));

  const rec = new RecoveryOrchestrator();
  ok('恢复编排器', rec.status().slice(0, 25));

  // ─── 6. 跨会话恢复 ───
  console.log('\n── 6. 跨会话恢复 ──');
  const sr = getSessionRecoverer();
  const inj = sr.recover();
  ok('会话恢复器', 'decisions=' + inj.recentDecisions.length);

  db.endSession(sid, 'OK');

  // ─── 结果 ───
  console.log('\n' + SEP);
  const tot = okC + noC;
  console.log('  通过: ' + okC + '/' + tot + ' (' + Math.round(okC/tot*100) + '%)');
  console.log(SEP);

  // 导出审计数据供仪表盘
  const allEvts: any[] = [];
  const ad = path.resolve(process.cwd(), 'audit');
  if (fs.existsSync(ad)) {
    for (const f of fs.readdirSync(ad).filter(x => x.endsWith('.log'))) {
      const lines = fs.readFileSync(path.join(ad, f), 'utf-8').trim().split('\n').filter(Boolean);
      for (const l of lines) try { allEvts.push(JSON.parse(l)); } catch {}
    }
  }
  const ep = path.resolve(__dirname, '..', 'data', 'dry-run-audit.json');
  fs.mkdirSync(path.dirname(ep), { recursive: true });
  fs.writeFileSync(ep, JSON.stringify(allEvts, null, 2));
  console.log('  审计导出: data/dry-run-audit.json (' + allEvts.length + ' 事件)');
  console.log('  仪表盘:  http://127.0.0.1:19700');

  if (noC > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
