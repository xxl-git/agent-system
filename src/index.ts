// Agent System — CLI entry point
import * as readline from 'readline';
import { initConfig, logger } from '@agent-system/core';
import { initMemoryStore } from '@agent-system/memory';
import { AgentCore } from '@agent-system/core';

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     Agent System v0.9.2                        ║');
  console.log('║  Phase 5: router+skills+multi-agent+resilience  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  const config = initConfig();
  logger.setLevel(config.logging?.level || 'info');

  initMemoryStore(config.memory?.filePath || 'data/memory');
  const agent = new AgentCore();
  const recoveryMsg = await agent.init();

  if (recoveryMsg) {
    console.log('');
    console.log(`📦 Recovery: ${recoveryMsg}`);
  }

  console.log('');
  console.log('Agent core initialized. Type /help for commands.');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.setPrompt('agent> ');
  rl.prompt();

  rl.on('line', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    try {
      const response = await agent.sendMessage(trimmed);
      console.log('');
      console.log(`Agent: ${response}`);
      console.log('');
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`Error: ${error.message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('');
    console.log('Goodbye!');
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error('Fatal error:', error);
  process.exit(1);
});
