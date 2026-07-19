// summarize-command.test.ts
// summarize-command 单元测试

import { handleSummarizeCommand } from '../summarize-command';

function makeMockAgent(overrides: any = {}) {
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！有什么可以帮你的吗？' },
    { role: 'user', content: '创建文件' },
    { role: 'assistant', content: '已创建文件。' },
    { role: 'user', content: '谢谢' },
    { role: 'assistant', content: '不客气！' },
  ];
  return {
    agent: {
      messages,
      sessionId: 'test-session-001',
      summarizer: {
        async summarizeSession(sessionId: string, msgs: any[], _: any[]) {
          return {
            sessionSummary: '用户与助手进行了3轮对话',
            keyDecisions: [
              { category: 'file', summary: '创建了一个文件' },
            ],
            learnedFacts: ['用户喜欢中文', '用户使用 Windows'],
            tags: ['chat', 'file-creation'],
            nextSteps: ['继续协助用户'],
          };
        },
        getSummaries(sessionId: string) {
          return [
            { timestamp: '2026-07-19T10:00:00Z', content: '上午的对话摘要内容' },
            { timestamp: '2026-07-19T14:00:00Z', content: '下午的对话摘要内容' },
          ];
        },
        getRecentSummaries(n: number) {
          return [
            { timestamp: '2026-07-19T14:00:00Z', content: '最近的对话摘要' },
          ];
        },
        async patrolSummary(sessionId: string, msgs: any[]) {
          if (msgs.length > 5) return 'Patrol: 建议进行摘要';
          return null;
        },
      },
      ...overrides,
    },
    messages,
  };
}

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

async function main() {
  console.log('=== summarize-command 单元测试 ===\n');

  // 测试 1: /summarize now
  console.log('测试 1: /summarize now');
  {
    const { agent } = makeMockAgent();
    const result = await handleSummarizeCommand(agent, ['now']);
    assert(result.includes('Summary for'), '显示摘要标题');
    assert(result.includes('test-session'), '包含 session ID');
    assert(result.includes('3轮对话'), '包含摘要内容');
    assert(result.includes('Key decisions'), '包含关键决策');
    assert(result.includes('file'), '包含决策分类');
    assert(result.includes('Facts learned'), '包含学到的事实');
    assert(result.includes('Tags'), '包含标签');
    assert(result.includes('Next'), '包含下一步');
  }
  console.log();

  // 测试 2: /summarize now 消息不足
  console.log('测试 2: /summarize now — 消息不足');
  {
    const { agent } = makeMockAgent({
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
    });
    const result = await handleSummarizeCommand(agent, ['now']);
    assert(result.includes('Not enough messages'), '提示消息不足');
  }
  console.log();

  // 测试 3: /summarize now 默认子命令
  console.log('测试 3: /summarize (无参数) → 默认 now');
  {
    const { agent } = makeMockAgent();
    const result = await handleSummarizeCommand(agent, []);
    assert(result.includes('Summary for'), '默认执行 now');
  }
  console.log();

  // 测试 4: /summarize list
  console.log('测试 4: /summarize list');
  {
    const { agent } = makeMockAgent();
    const result = await handleSummarizeCommand(agent, ['list']);
    assert(result.includes('Summaries'), '显示摘要列表');
    assert(result.includes('2)'), '显示数量');
    assert(result.includes('上午的对话'), '包含摘要内容');
  }
  console.log();

  // 测试 5: /summarize list — 无摘要
  console.log('测试 5: /summarize list — 无摘要');
  {
    const { agent } = makeMockAgent({
      summarizer: {
        async summarizeSession() { return {}; },
        getSummaries() { return []; },
        getRecentSummaries() { return []; },
        async patrolSummary() { return null; },
      },
    });
    const result = await handleSummarizeCommand(agent, ['list']);
    assert(result.includes('No summaries'), '提示无摘要');
  }
  console.log();

  // 测试 6: /summarize recent
  console.log('测试 6: /summarize recent');
  {
    const { agent } = makeMockAgent();
    const result = await handleSummarizeCommand(agent, ['recent']);
    assert(result.includes('Recent'), '显示最近摘要');
    assert(result.includes('最近的对话'), '包含内容');
  }
  console.log();

  // 测试 7: /summarize recent — 无摘要
  console.log('测试 7: /summarize recent — 无摘要');
  {
    const { agent } = makeMockAgent({
      summarizer: {
        async summarizeSession() { return {}; },
        getSummaries() { return []; },
        getRecentSummaries() { return []; },
        async patrolSummary() { return null; },
      },
    });
    const result = await handleSummarizeCommand(agent, ['recent']);
    assert(result.includes('No recent'), '提示无最近摘要');
  }
  console.log();

  // 测试 8: /summarize patrol — 需要摘要
  console.log('测试 8: /summarize patrol — 建议摘要');
  {
    const { agent } = makeMockAgent();
    const result = await handleSummarizeCommand(agent, ['patrol']);
    assert(result.includes('Patrol'), '返回巡逻摘要建议');
  }
  console.log();

  // 测试 9: /summarize patrol — 低于阈值
  console.log('测试 9: /summarize patrol — 低于阈值');
  {
    const { agent } = makeMockAgent({
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
      summarizer: {
        async summarizeSession() { return {}; },
        getSummaries() { return []; },
        getRecentSummaries() { return []; },
        async patrolSummary() { return null; },
      },
    });
    const result = await handleSummarizeCommand(agent, ['patrol']);
    assert(result.includes('Below patrol threshold'), '返回低于阈值提示');
  }
  console.log();

  // 测试 10: /summarize now — summarizeSession 异常
  console.log('测试 10: /summarize now — summarizeSession 异常');
  {
    const { agent } = makeMockAgent({
      summarizer: {
        async summarizeSession() { throw new Error('LLM timeout'); },
        getSummaries() { return []; },
        getRecentSummaries() { return []; },
        async patrolSummary() { return null; },
      },
    });
    const result = await handleSummarizeCommand(agent, ['now']);
    assert(result.includes('Summarization failed'), '显示失败信息');
    assert(result.includes('LLM timeout'), '包含错误详情');
  }
  console.log();

  // 测试 11: /summarize unknown — 未知子命令
  console.log('测试 11: /summarize unknown — 未知子命令');
  {
    const { agent } = makeMockAgent();
    const result = await handleSummarizeCommand(agent, ['unknown']);
    assert(result.includes('用法') || result.includes('Summarize'), '显示用法提示');
  }
  console.log();

  // 测试 12: /summarize now — 过滤 system 消息
  console.log('测试 12: /summarize now — 过滤 system 消息');
  {
    let receivedMsgs: any[] = [];
    const { agent } = makeMockAgent({
      summarizer: {
        async summarizeSession(sid: string, msgs: any[]) {
          receivedMsgs = msgs;
          return { sessionSummary: 'test', keyDecisions: [], learnedFacts: [], tags: [], nextSteps: [] };
        },
        getSummaries() { return []; },
        getRecentSummaries() { return []; },
        async patrolSummary() { return null; },
      },
    });
    await handleSummarizeCommand(agent, ['now']);
    assert(!receivedMsgs.some(m => m.role === 'system'), '已过滤 system 消息');
    assert(receivedMsgs.length === 6, '只传了 6 条非 system 消息');
  }
  console.log();

  console.log(`============================================`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log(`============================================`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
