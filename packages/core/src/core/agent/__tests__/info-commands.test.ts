// info-commands.test.ts
// info-commands 单元测试 — 测试 8 个查询命令

import {
  handleAuditCommand,
  handleMemoryCommand,
  handleContextCommand,
  handleIdleCommand,
  handleDiagCommand,
} from '../info-commands';

function makeMockAgent(overrides: any = {}) {
  return {
    agent: {
      auditLog: {
        getSessionSummary() { return 'Audit: 5 events, 0 errors'; },
        query(opts: any) {
          if (opts.category === 'error') return [];
          if (opts.keyword) return [{ timestamp: '2026-07-19T10:00:00Z', category: 'tool', action: 'write' }];
          return [
            { timestamp: '2026-07-19T10:00:00Z', category: 'tool', action: 'write', result: 'ok' },
            { timestamp: '2026-07-19T11:00:00Z', category: 'chat', action: 'send', result: 'ok' },
          ];
        },
      },
      lastMemoryInjection: {
        recentDecisions: [
          { timestamp: '2026-07-19T09:00:00Z', category: 'tool', summary: '创建文件' },
        ],
        trackedEntities: [
          { type: 'file', name: 'hello.txt', mention_count: 3 },
        ],
        recentSummaries: [],
        recentFileMemory: 'some memory content',
        systemPromptBlock: 'memory block',
      },
      sessionRecoverer: {
        recover() {
          return {
            recentDecisions: [{ timestamp: '2026-07-19T09:00:00Z', category: 'tool', summary: '创建文件' }],
            trackedEntities: [{ type: 'file', name: 'hello.txt', mention_count: 3 }],
            recentSummaries: [],
            recentFileMemory: '',
            systemPromptBlock: 'reloaded block',
          };
        },
      },
      messages: [
        { role: 'system', content: 'You are an Agent.' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
      ctxManager: {
        getStats() {
          return {
            compressionLevel: 0,
            compressionCount: 0,
            compressedBlocks: 0,
            accumulatedSummary: 0,
            config: { maxTokens: 4096, hotWindowSize: 10, attentionEnabled: true, compressionThreshold: 0.8, summaryTokenBudget: 512 },
          };
        },
        reset() {},
      },
      adapter: {
        model: 'test-model',
        getEffectiveContextWindow() { return 4096; },
        isSessionReset() { return false; },
      },
      idleTaskMgr: {
        getStats() { return { executed: 5, succeeded: 4, failed: 1, skipped: 0, pending: 1 }; },
        getPendingTasks() { return [{ priority: 'P2', name: 'memory-organization', description: '整理记忆' }]; },
        getRecentLogs(n: number) { return [{ priority: 'P2', taskName: 'memory-organization', success: true, durationMs: 100, result: 'done' }]; },
        async processAll() {},
      },
      sessionDiag: {
        getStats() { return { totalSnapshots: 3, undiagnosed: 1, diagnosed: 2, reports: 0 }; },
        getUndiagnosedSnapshots() { return [{ id: 'snap-001', trigger: 'timeout', error: 'LLM 超时', timestamp: '2026-07-19T10:00:00Z' }]; },
        getReportPaths() { return []; },
        recordManual() {},
      },
      ...overrides,
    },
  };
}

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

function main() {
  console.log('=== info-commands 单元测试 ===\n');

  // === /audit ===
  console.log('测试 1: /audit summary');
  {
    const { agent } = makeMockAgent();
    const result = handleAuditCommand(agent, ['summary']);
    assert(result.includes('Audit'), '显示审计摘要');
  }
  console.log();

  console.log('测试 2: /audit recent');
  {
    const { agent } = makeMockAgent();
    const result = handleAuditCommand(agent, ['recent']);
    assert(result.includes('Recent'), '显示最近事件');
    assert(result.includes('tool'), '包含工具分类');
  }
  console.log();

  console.log('测试 3: /audit errors — 无错误');
  {
    const { agent } = makeMockAgent();
    const result = handleAuditCommand(agent, ['errors']);
    assert(result.includes('No errors'), '提示无错误');
  }
  console.log();

  console.log('测试 4: /audit search — 有匹配');
  {
    const { agent } = makeMockAgent();
    const result = handleAuditCommand(agent, ['search', 'write']);
    assert(result.includes('Matches'), '显示匹配结果');
  }
  console.log();

  console.log('测试 5: /audit search — 无关键词');
  {
    const { agent } = makeMockAgent();
    const result = handleAuditCommand(agent, ['search']);
    assert(result.includes('Usage'), '显示用法');
  }
  console.log();

  console.log('测试 6: /audit 默认 → summary');
  {
    const { agent } = makeMockAgent();
    const result = handleAuditCommand(agent, []);
    assert(result.includes('Audit'), '默认执行 summary');
  }
  console.log();

  // === /memory ===
  console.log('测试 7: /memory status');
  {
    const { agent } = makeMockAgent();
    const result = handleMemoryCommand(agent, ['status']);
    assert(result.includes('Memory status'), '显示记忆状态');
    assert(result.includes('Decisions: 1'), '显示决策数');
    assert(result.includes('Entities: 1'), '显示实体数');
  }
  console.log();

  console.log('测试 8: /memory status — 无记忆');
  {
    const { agent } = makeMockAgent({ lastMemoryInjection: null });
    const result = handleMemoryCommand(agent, ['status']);
    assert(result.includes('No memory'), '提示无记忆');
  }
  console.log();

  console.log('测试 9: /memory decisions');
  {
    const { agent } = makeMockAgent();
    const result = handleMemoryCommand(agent, ['decisions']);
    assert(result.includes('Recent decisions'), '显示决策列表');
    assert(result.includes('创建文件'), '包含决策内容');
  }
  console.log();

  console.log('测试 10: /memory entities');
  {
    const { agent } = makeMockAgent();
    const result = handleMemoryCommand(agent, ['entities']);
    assert(result.includes('Tracked entities'), '显示实体列表');
    assert(result.includes('hello.txt'), '包含实体名称');
  }
  console.log();

  console.log('测试 11: /memory reload');
  {
    const { agent } = makeMockAgent();
    const result = handleMemoryCommand(agent, ['reload']);
    assert(result.includes('Memory reloaded'), '显示重载成功');
    assert(result.includes('1 decisions'), '显示重载的决策数');
  }
  console.log();

  // === /context ===
  console.log('测试 12: /context status');
  {
    const { agent } = makeMockAgent();
    const result = handleContextCommand(agent, []);
    assert(result.includes('Context Manager'), '显示上下文管理器');
    assert(result.includes('maxTokens=4096'), '显示配置');
    assert(result.includes('4096 tokens'), '显示有效窗口');
    assert(result.includes('正常续聊'), '显示会话状态');
  }
  console.log();

  console.log('测试 13: /context reset');
  {
    const { agent } = makeMockAgent();
    agent.messages.push({ role: 'user', content: '[此前对话摘要] some summary' });
    const result = handleContextCommand(agent, ['reset']);
    assert(result.includes('已重置'), '显示重置成功');
    assert(agent.messages.length === 3, '摘要块被清理');
  }
  console.log();

  // === /idle ===
  console.log('测试 14: /idle status');
  {
    const { agent } = makeMockAgent();
    const result = handleIdleCommand(agent, ['status']);
    assert(result.includes('Idle Task Manager'), '显示空闲任务管理器');
    assert(result.includes('已执行: 5'), '显示执行统计');
    assert(result.includes('待处理: 1'), '显示待处理数');
  }
  console.log();

  console.log('测试 15: /idle pending');
  {
    const { agent } = makeMockAgent();
    const result = handleIdleCommand(agent, ['pending']);
    assert(result.includes('memory-organization'), '包含待处理任务名');
  }
  console.log();

  console.log('测试 16: /idle log');
  {
    const { agent } = makeMockAgent();
    const result = handleIdleCommand(agent, ['log']);
    assert(result.includes('空闲任务日志'), '显示日志');
    assert(result.includes('100ms'), '包含执行时间');
  }
  console.log();

  console.log('测试 17: /idle run');
  {
    const { agent } = makeMockAgent();
    const result = handleIdleCommand(agent, ['run']);
    assert(result.includes('已触发'), '显示触发成功');
  }
  console.log();

  // === /diag ===
  console.log('测试 18: /diag status');
  {
    const { agent } = makeMockAgent();
    const result = handleDiagCommand(agent, ['status']);
    assert(result.includes('Session Diagnostics'), '显示诊断状态');
    assert(result.includes('快照总数: 3'), '显示快照数');
    assert(result.includes('未诊断: 1'), '显示未诊断数');
  }
  console.log();

  console.log('测试 19: /diag list');
  {
    const { agent } = makeMockAgent();
    const result = handleDiagCommand(agent, ['list']);
    assert(result.includes('待诊断'), '显示待诊断列表');
    assert(result.includes('timeout'), '包含触发类型');
  }
  console.log();

  console.log('测试 20: /diag reports — 无报告');
  {
    const { agent } = makeMockAgent();
    const result = handleDiagCommand(agent, ['reports']);
    assert(result.includes('No') || result.includes('暂无'), '提示无报告');
  }
  console.log();

  console.log('测试 21: /diag force');
  {
    const { agent } = makeMockAgent();
    const result = handleDiagCommand(agent, ['force', '测试诊断']);
    assert(result.includes('已注册'), '显示诊断已注册');
  }
  console.log();

  console.log(`============================================`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log(`============================================`);
  if (fail > 0) process.exit(1);
}

main();
