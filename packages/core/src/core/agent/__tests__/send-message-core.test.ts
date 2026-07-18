// send-message-core.test.ts
// sendMessageCore 单元测试

import { sendMessageCore } from '../send-message-core';

function makeMockAgent(overrides: any = {}) {
  const messages: Array<{ role: string; content: string }> = [];
  const calls: string[] = [];
  const agent = {
    messages,
    sessionId: 'test-session',
    config: { agent: { skipIntentParsing: false } },
    intentParser: {
      async parse(input: string) {
        calls.push('intentParser.parse');
        return { type: 'chat', summary: input.slice(0, 50), entities: [], confidence: 0.9, needsClarification: false, missingInfo: [] };
      },
    },
    async handleCommand(input: string) { calls.push('handleCommand'); return 'cmd-result'; },
    async handleTask(intent: any, input: string) { calls.push('handleTask'); return 'task-result'; },
    async handleChat(input: string) { calls.push('handleChat'); return 'chat-result'; },
    async handleChatStream(input: string) { calls.push('handleChatStream'); return 'stream-result'; },
    recordInteraction(input: string, reply: string) { calls.push('recordInteraction'); },
    breakIn: { evaluateInteraction(opts: any) { calls.push('breakIn.evaluate'); } },
    checkPendingApplies() { calls.push('checkPendingApplies'); },
    auditLog: { logDecision(type: string, summary: string, result: string, meta: any) { calls.push('auditLog.logDecision'); } },
    recordDecision(intent: any, input: string, reply: string, isError: boolean) { calls.push('recordDecision'); },
    recordEntities(input: string) { calls.push('recordEntities'); },
    experienceInitialized: false,
    experienceExtractor: { async extract() { return null; } },
    adapter: { model: 'test-model' },
    _tracer: undefined,
    ...overrides,
  };
  return { agent, calls };
}

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

async function main() {
  console.log('=== sendMessageCore 单元测试 ===\n');

  // 测试 1: /命令 快速通道
  console.log('测试 1: /命令 快速通道 → handleCommand()');
  {
    const { agent, calls } = makeMockAgent();
    const result = await sendMessageCore(agent, '/help', false);
    assert(result === 'cmd-result', '返回 handleCommand 结果');
    assert(calls.includes('handleCommand'), '调用了 handleCommand');
    assert(!calls.includes('intentParser.parse'), '跳过意图解析');
  }
  console.log();

  // 测试 2: chat 意图 → handleChat() (非流式)
  console.log('测试 2: chat 意图 → handleChat() (非流式)');
  {
    const { agent, calls } = makeMockAgent();
    const result = await sendMessageCore(agent, '你好', false);
    assert(result === 'chat-result', '返回 handleChat 结果');
    assert(calls.includes('handleChat'), '调用了 handleChat');
    assert(!calls.includes('handleChatStream'), '未调用 handleChatStream');
    assert(calls.includes('recordInteraction'), '记录了交互');
    assert(calls.includes('recordDecision'), '记录了决策');
    assert(calls.includes('recordEntities'), '记录了实体');
  }
  console.log();

  // 测试 3: chat 意图 → handleChatStream() (流式)
  console.log('测试 3: chat 意图 → handleChatStream() (流式)');
  {
    const { agent, calls } = makeMockAgent();
    const result = await sendMessageCore(agent, '你好', true);
    assert(result === 'stream-result', '返回 handleChatStream 结果');
    assert(calls.includes('handleChatStream'), '调用了 handleChatStream');
    assert(!calls.includes('handleChat'), '未调用 handleChat');
  }
  console.log();

  // 测试 4: task 意图 → handleTask()
  console.log('测试 4: task 意图 → handleTask()');
  {
    const { agent, calls } = makeMockAgent({
      intentParser: {
        async parse(input: string) {
          return { type: 'task', summary: input.slice(0, 50), entities: [], confidence: 0.85, needsClarification: false, missingInfo: [] };
        },
      },
    });
    const result = await sendMessageCore(agent, '创建文件', false);
    assert(result === 'task-result', '返回 handleTask 结果');
    assert(calls.includes('handleTask'), '调用了 handleTask');
  }
  console.log();

  // 测试 5: 需要澄清
  console.log('测试 5: needsClarification → 返回 missing info');
  {
    const { agent } = makeMockAgent({
      intentParser: {
        async parse(input: string) {
          return { type: 'task', summary: input, entities: [], confidence: 0.5, needsClarification: true, missingInfo: ['文件名', '路径'] };
        },
      },
    });
    const result = await sendMessageCore(agent, '创建文件', false);
    assert(result.includes('Not enough info'), '返回需要澄清消息');
    assert(result.includes('文件名'), '包含缺失信息: 文件名');
    assert(result.includes('路径'), '包含缺失信息: 路径');
  }
  console.log();

  // 测试 6: skipIntentParsing=true
  console.log('测试 6: skipIntentParsing=true → 跳过意图解析');
  {
    const { agent, calls } = makeMockAgent({
      config: { agent: { skipIntentParsing: true } },
    });
    const result = await sendMessageCore(agent, '你好', false);
    assert(result === 'chat-result', '返回 chat 结果');
    assert(!calls.includes('intentParser.parse'), '跳过了意图解析');
  }
  console.log();

  // 测试 7: 意图解析失败 → 降级
  console.log('测试 7: 意图解析失败 → 降级为 unknown');
  {
    const { agent, calls } = makeMockAgent({
      intentParser: {
        async parse(input: string) { throw new Error('parse error'); },
      },
    });
    const result = await sendMessageCore(agent, '你好', false);
    assert(result === 'chat-result', '降级到 handleChat');
    assert(calls.includes('handleChat'), '调用了 handleChat');
  }
  console.log();

  // 测试 8: command 意图但非 / 开头 → 回退
  console.log('测试 8: command 意图但非 / 开头 → 回退到 chat');
  {
    const { agent, calls } = makeMockAgent({
      intentParser: {
        async parse(input: string) {
          return { type: 'command', summary: input, entities: [], confidence: 0.7, needsClarification: false, missingInfo: [] };
        },
      },
    });
    const result = await sendMessageCore(agent, 'help me', false);
    assert(result === 'chat-result', '回退到 handleChat');
    assert(calls.includes('handleChat'), '调用了 handleChat');
    assert(!calls.includes('handleCommand'), '未调用 handleCommand');
  }
  console.log();

  // 测试 9: ERR 响应
  console.log('测试 9: ERR 响应标记为错误');
  {
    const { agent, calls } = makeMockAgent({
      async handleChat(input: string) { return 'ERR: something went wrong'; },
    });
    const result = await sendMessageCore(agent, '你好', false);
    assert(result.startsWith('ERR'), '返回 ERR 响应');
    assert(calls.includes('auditLog.logDecision'), '记录了审计日志');
  }
  console.log();

  // 测试 10: experience 异步提取
  console.log('测试 10: experienceInitialized=true → 触发经验提取');
  {
    let extractCalled = false;
    const { agent } = makeMockAgent({
      experienceInitialized: true,
      experienceExtractor: {
        async extract() { extractCalled = true; return 42; },
      },
    });
    await sendMessageCore(agent, '你好', false);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(extractCalled, '经验提取被调用');
  }
  console.log();

  console.log(`============================================`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log(`============================================`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
