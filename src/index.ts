// Agent System — Phase 4 入口
import * as readline from 'readline';
import { loadConfig } from './config';
import { logger } from './logger';
import { initMemoryStore } from './memory/file-store';
import { AgentCore } from './core/agent/agent-core';

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     Agent System v0.3.0 — Phase 4        ║');
  console.log('║ 多Agent协作 · 技能生态 · 智能路由 · 项目管理 ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  const config = loadConfig();
  logger.setLevel(config.logging.level as 'debug' | 'info' | 'warn' | 'error');

  initMemoryStore(config.memory.filePath);
  const agent = new AgentCore();
  const recoveryMsg = await agent.init();

  if (recoveryMsg) {
    console.log(recoveryMsg);
    console.log('');
  }

  console.log('✅ Agent 就绪。');
  console.log('命令: /help /status /project /models /router /skills /agents');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Agent> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (input === '/exit' || input === '/quit') {
      agent.stop();
      console.log('再见 👋');
      rl.close();
      process.exit(0);
    }
    if (!input) { rl.prompt(); return; }
    try {
      const reply = await agent.sendMessage(input);
      console.log(`\nAgent: ${reply}\n`);
    } catch (err) {
      console.log(`\n❌ 错误: ${err}\n`);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    agent.stop();
    console.log('\nAgent System 已关闭。');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
