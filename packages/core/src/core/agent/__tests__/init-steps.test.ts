// init-steps.test.ts
// init-steps 单元测试

import {
  initMemoryStore,
  initCheckpoints,
  initMemoryRecovery,
  initExperience,
  initSystemMessage,
  initModel,
} from '../init-steps';

function makeMockAgent(overrides: any = {}) {
  return {
    sessionId: 'test-session',
    checkpointMgr: {
      listPendingTasks() { return []; },
      recoverySummary() { return 'No pending recovery tasks'; },
    },
    pendingTaskIds: [],
    dbInitialized: false,
    lastMemoryInjection: null,
    summarizer: null,
    experienceStore: {
      async init() {},
      getStats() { return { total: 0, active: 0, patterns: 0, pitfalls: 0 }; },
    },
    experienceInitialized: false,
    promptRegistry: {
      get(id: string, vars: any) { return { system: 'You are a test agent.' }; },
    },
    messages: [] as Array<{ role: string; content: string }>,
    _cachedMemoryBlock: '',
    getIdentityVars() { return { agent_name: 'TestAgent' }; },
    async onboardModel() { return 'Model: test-model'; },
    projectManager: { recoverySummary() { return ''; } },
    registry: { size: 0 },
    adapter: { model: 'test-model' },
    sessionDiag: { setModelName(name: string) {} },
    nonsenseDetector: { setModelName(name: string) {}, startMonitor() {} },
    registerDiagnosticPingTask() {},
    registerModelListHeartbeat() {},
    registerProactiveTasks() {},
    orchestrator: { startHeartbeat() {} },
    chatHandler: null,
    commandHandler: null,
    taskHandler: null,
    sessionRecoverer: {
      recover() {
        return {
          recentDecisions: [],
          trackedEntities: [],
          recentSummaries: [],
          systemPromptBlock: 'test memory block',
        };
      },
    },
    ...overrides,
  };
}

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

async function main() {
  console.log('=== init-steps 单元测试 ===\n');

  // 测试 1: initMemoryStore 不抛异常
  console.log('测试 1: initMemoryStore() 正常执行');
  {
    try {
      initMemoryStore();
      assert(true, 'initMemoryStore 不抛异常');
    } catch (err) {
      assert(false, `initMemoryStore 抛异常: ${(err as Error).message}`);
    }
  }
  console.log();

  // 测试 2: initCheckpoints - 无待恢复任务
  console.log('测试 2: initCheckpoints() - 无待恢复任务');
  {
    const agent = makeMockAgent();
    initCheckpoints(agent);
    assert(agent.pendingTaskIds.length === 0, 'pendingTaskIds 为空');
  }
  console.log();

  // 测试 3: initCheckpoints - 有待恢复任务
  console.log('测试 3: initCheckpoints() - 有待恢复任务');
  {
    const agent = makeMockAgent({
      checkpointMgr: {
        listPendingTasks() { return [{ id: 'task-1', status: 'pending' }]; },
        recoverySummary() { return '1 pending task'; },
      },
    });
    initCheckpoints(agent);
    assert(agent.pendingTaskIds.length === 1, 'pendingTaskIds 有 1 个任务');
  }
  console.log();

  // 测试 4: initCheckpoints - 异常情况
  console.log('测试 4: initCheckpoints() - 异常情况');
  {
    const agent = makeMockAgent({
      checkpointMgr: {
        listPendingTasks() { throw new Error('checkpoint error'); },
        recoverySummary() { return ''; },
      },
    });
    initCheckpoints(agent);
    assert(Array.isArray(agent.pendingTaskIds), '异常时 pendingTaskIds 仍为数组');
    assert(agent.pendingTaskIds.length === 0, '异常时 pendingTaskIds 为空');
  }
  console.log();

  // 测试 5: initMemoryRecovery - 正常恢复
  console.log('测试 5: initMemoryRecovery() 正常恢复');
  {
    const agent = makeMockAgent();
    const result = initMemoryRecovery(agent);
    assert(result.memRecoveryTime >= 0, 'memRecoveryTime >= 0');
    assert(agent.lastMemoryInjection !== null, 'lastMemoryInjection 已设置');
  }
  console.log();

  // 测试 6: initMemoryRecovery - 异常情况
  console.log('测试 6: initMemoryRecovery() 异常情况');
  {
    const agent = makeMockAgent({
      sessionRecoverer: {
        recover() { throw new Error('recovery error'); },
      },
    });
    const result = initMemoryRecovery(agent);
    assert(result.memRecoveryTime === 0, '异常时 memRecoveryTime=0');
  }
  console.log();

  // 测试 7: initExperience - 正常初始化
  console.log('测试 7: initExperience() 正常初始化');
  {
    const agent = makeMockAgent();
    await initExperience(agent);
    assert(agent.experienceInitialized === true, 'experienceInitialized = true');
  }
  console.log();

  // 测试 8: initExperience - 异常情况
  console.log('测试 8: initExperience() 异常情况');
  {
    const agent = makeMockAgent({
      experienceStore: {
        async init() { throw new Error('experience init error'); },
        getStats() { return { total: 0, active: 0, patterns: 0, pitfalls: 0 }; },
      },
    });
    await initExperience(agent);
    assert(agent.experienceInitialized === false, '异常时 experienceInitialized = false');
  }
  console.log();

  // 测试 9: initSystemMessage - 设置 messages
  console.log('测试 9: initSystemMessage() 设置 messages');
  {
    const agent = makeMockAgent();
    initSystemMessage(agent, 'test memory block');
    assert(agent.messages.length === 1, 'messages 有 1 条');
    assert(agent.messages[0].role === 'system', '第一条消息 role=system');
    assert(agent.messages[0].content === 'You are a test agent.', 'system 内容正确');
  }
  console.log();

  // 测试 10: initSystemMessage - 缓存 memoryBlock
  console.log('测试 10: initSystemMessage() 缓存 memoryBlock');
  {
    const agent = makeMockAgent({
      lastMemoryInjection: {
        recentDecisions: [],
        trackedEntities: [],
        recentSummaries: [],
        systemPromptBlock: 'test memory block',
      },
    });
    initSystemMessage(agent, '');
    assert(agent._cachedMemoryBlock === 'test memory block', '_cachedMemoryBlock 已缓存');
  }
  console.log();

  // 测试 11: initSystemMessage - 无 memoryBlock
  console.log('测试 11: initSystemMessage() 无 memoryBlock');
  {
    const agent = makeMockAgent({
      lastMemoryInjection: null,
    });
    initSystemMessage(agent, '');
    assert(agent._cachedMemoryBlock === '', '_cachedMemoryBlock 为空');
  }
  console.log();

  // 测试 12: initModel - 返回 onboard 结果
  console.log('测试 12: initModel() 返回 onboard 结果');
  {
    const agent = makeMockAgent();
    const result = await initModel(agent);
    assert(result === 'Model: test-model', '返回正确的 onboard 结果');
  }
  console.log();

  // 测试 13: initSystemMessage - 默认值
  console.log('测试 13: initSystemMessage() PromptRegistry 返回空');
  {
    const agent = makeMockAgent({
      promptRegistry: {
        get(id: string, vars: any) { return {}; },
      },
    });
    initSystemMessage(agent, '');
    assert(agent.messages[0].content.includes('intelligent Agent'), '使用默认 system message');
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
