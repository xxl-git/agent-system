// Phase 0 验证脚本 — 非交互式端到端测试
import { loadConfig } from './config';
import { initMemoryStore } from './memory/file-store';
import { AgentCore } from './core/agent/agent-core';
import logger from './logger';

async function test() {
  console.log('=== Phase 0 验证测试 ===\n');

  const cfg = loadConfig();
  logger.setLevel('debug');
  console.log('✅ 配置加载: OK');

  initMemoryStore(cfg.memory.filePath);
  console.log('✅ 记忆系统: OK');

  const agent = new AgentCore();
  agent.init();
  console.log('✅ Agent 初始化: OK\n');

  console.log('>>> 发送: "用中文回复：你好"');
  const start = Date.now();
  const reply = await agent.sendMessage('用中文回复：你好');
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n<<< Agent (${elapsed}s):\n${reply}\n`);

  if (reply && reply.length > 0 && !reply.includes('LM Studio 未连接')) {
    console.log('✅ Phase 0 验证通过！');
    process.exit(0);
  } else {
    console.log('❌ 验证失败：Agent 返回无效响应');
    process.exit(1);
  }
}

test().catch(err => {
  console.error('❌ 测试异常:', err);
  process.exit(1);
});
