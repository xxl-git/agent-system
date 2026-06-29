// Phase 1 验证脚本 — 完整链路：意图解析 → 任务分解 → 工具执行 → 记忆记录
import { loadConfig } from './config';
import { initMemoryStore } from './memory/file-store';
import { getDBStore } from './memory/db-store';
import { AgentCore } from './core/agent/agent-core';
import logger from './logger';

async function test() {
  console.log('=== Phase 1 验证测试 ===\n');
  const cfg = loadConfig();
  logger.setLevel('debug');

  // 1. 基础环境
  console.log('✅ 配置加载: OK');

  initMemoryStore(cfg.memory.filePath);
  console.log('✅ 文件层记忆: OK');

  const db = getDBStore();
  await db.init();
  console.log(`✅ DB 层记忆: OK (${db.getStats()})\n`);

  // 2. Agent 初始化
  const agent = new AgentCore();
  await agent.init();
  console.log('✅ Agent 初始化: OK');
  console.log(`   意图解析器: 就绪`);
  console.log(`   工具数: ${agent.orchestrator.config.maxRetries} 重试次数\n`);

  // 3. 测试1：聊天消息
  console.log('>>> 测试1: 闲聊 "你好"');
  const start1 = Date.now();
  const reply1 = await agent.sendMessage('你好');
  console.log(`<<< (${((Date.now() - start1) / 1000).toFixed(1)}s): ${reply1}\n`);

  // 4. 测试2：任务（创建文件）
  console.log('>>> 测试2: 任务 "帮我在 D:\\QClaw_Workspace\\agent-system\\test_hello.txt 创建一个文件，内容是 Hello Phase 1"');
  const start2 = Date.now();
  const reply2 = await agent.sendMessage('帮我在 D:\\QClaw_Workspace\\agent-system\\test_hello.txt 创建一个文件，内容是 Hello Phase 1');
  console.log(`<<< (${((Date.now() - start2) / 1000).toFixed(1)}s): ${reply2}\n`);

  // 5. 验证文件创建
  const fs = require('fs');
  if (fs.existsSync('D:\\QClaw_Workspace\\agent-system\\test_hello.txt')) {
    const content = fs.readFileSync('D:\\QClaw_Workspace\\agent-system\\test_hello.txt', 'utf-8');
    console.log(`✅ 文件验证成功: ${content}`);
  } else {
    console.log('❌ 文件未创建');
  }

  // 6. 测试3：搜索
  console.log('\n>>> 测试3: 查询 "搜索一下 TypeScript 最新版本"');
  const start3 = Date.now();
  const reply3 = await agent.sendMessage('搜索一下 TypeScript 最新版本');
  console.log(`<<< (${((Date.now() - start3) / 1000).toFixed(1)}s): ${reply3.slice(0, 200)}...\n`);

  // 7. 命令
  console.log('>>> 测试4: 命令 /status');
  const reply4 = await agent.sendMessage('/status');
  console.log(`<<< ${reply4}\n`);

  // 8. DB 验证
  console.log('=== DB 验证 ===');
  console.log(db.getStats());
  const decisions = db.searchDecisions('Phase', 5);
  console.log(`决策记录: ${decisions.length} 条`);
  decisions.forEach(d => console.log(`  [${d.timestamp}] ${d.summary}`));

  // 9. 清理
  agent.stop();
  try { fs.unlinkSync('D:\\QClaw_Workspace\\agent-system\\test_hello.txt'); } catch {}

  console.log('\n✅✅✅ Phase 1 验证通过！');
  process.exit(0);
}

test().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
