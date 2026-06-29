#!/usr/bin/env ts-node
// Agent 试跑 — 连接 LM Studio 执行实际交互 + 审计日志收集
import { loadConfig } from '../src/config';
import { AgentCore } from '../src/core/agent/agent-core';
import { logger } from '../src/logger';
import * as path from 'path';
import * as fs from 'fs';

const SEP = '═'.repeat(60);

async function main() {
  console.log('\n' + SEP);
  console.log('  Agent System v0.5.0 — 试跑');
  console.log(SEP + '\n');

  loadConfig();
  logger.setLevel('info');

  const agent = new AgentCore();
  const initMsg = await agent.init();
  if (initMsg) console.log(initMsg + '\n');

  const testCases = [
    { label: '闲聊', input: '你好！我是你的创建者。今天有什么建议给我？' },
    { label: '状态查询', input: '/status' },
    { label: '模型信息', input: '/models' },
    { label: '知识问答', input: 'TypeScript 中 keyof 和 typeof 有什么区别？' },
    { label: '摘要命令', input: '/summarize now' },
    { label: '审计查询', input: '/audit last 5' },
  ];

  const results: Array<{ label: string; input: string; output: string; duration: number; ok: boolean }> = [];

  for (const tc of testCases) {
    console.log(`\n📥 [${tc.label}] → "${tc.input.slice(0, 60)}"`);
    const t0 = Date.now();
    try {
      const reply = await agent.sendMessage(tc.input);
      const dur = Date.now() - t0;
      const ok = reply.length > 0;
      results.push({ label: tc.label, input: tc.input, output: reply, duration: dur, ok });
      console.log(`📤 (${dur}ms, ${reply.length} chars) ${reply.slice(0, 120)}`);
    } catch (err: any) {
      const dur = Date.now() - t0;
      results.push({ label: tc.label, input: tc.input, output: 'ERROR: ' + err.message, duration: dur, ok: false });
      console.log(`❌ (${dur}ms) ${err.message}`);
    }
  }

  // 查看审计日志
  console.log('\n' + SEP);
  console.log('  审计日志摘要');
  console.log(SEP);
  try {
    const auditDir = path.resolve(__dirname, '..', 'data', 'audit');
    if (fs.existsSync(auditDir)) {
      const files = fs.readdirSync(auditDir).filter(f => f.endsWith('.json'));
      for (const f of files.slice(-3)) {
        const raw = fs.readFileSync(path.join(auditDir, f), 'utf-8');
        // 文件是行分隔的 JSON
        const lines = raw.trim().split('\n').filter(Boolean);
        console.log(`\n📋 ${f}: ${lines.length} 事件`);
        for (const line of lines.slice(-8)) {
          try {
            const evt = JSON.parse(line);
            console.log(`  [${evt.category}] ${evt.action} → ${evt.result} (${evt.meta?.durationMs || '?'}ms)`);
          } catch { console.log('  (parse err)'); }
        }
      }
    } else {
      console.log('  审计目录不存在 (数据将在首次 agent 运行后生成)');
    }
  } catch (e: any) { console.log('  ❌', e.message); }

  // 汇总
  const pass = results.filter(r => r.ok).length;
  console.log('\n' + SEP);
  console.log(`  试跑结果: ${pass}/${results.length} 通过`);
  const avgMs = results.reduce((s, r) => s + r.duration, 0) / results.length;
  console.log(`  平均响应: ${avgMs.toFixed(0)}ms`);
  console.log(SEP);

  agent.stop();

  if (pass < results.length) process.exit(1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
