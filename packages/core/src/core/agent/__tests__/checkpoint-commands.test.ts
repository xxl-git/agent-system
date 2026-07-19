// checkpoint-commands.test.ts
// checkpoint-commands 单元测试

import { handleCkptCommand, handlePauseCommand } from '../checkpoint-commands';

function makeMockCheckpointData(overrides: any = {}) {
  return {
    taskId: 'task-001',
    originalRequest: '创建一个 hello.txt 文件',
    completedSteps: [
      { step: { title: '步骤1' }, result: { output: 'done' } },
    ],
    pendingSteps: [
      { title: '步骤2', description: '写入内容' },
      { title: '步骤3', description: '验证文件' },
    ],
    retryCount: 1,
    timestamp: new Date(Date.now() - 5 * 60000).toISOString(), // 5分钟前
    version: 1,
    failures: [
      { type: 'timeout', message: '执行超时，已重试' },
    ],
    ...overrides,
  };
}

function makeMockAgent(overrides: any = {}) {
  const checkpoints: Record<string, any> = {};
  let cleared = false;
  return {
    agent: {
      checkpointMgr: {
        listPendingTasks() {
          if (cleared) return [];
          return Object.keys(checkpoints);
        },
        load(taskId: string) {
          return checkpoints[taskId] || null;
        },
        clearAll() {
          cleared = true;
          for (const k of Object.keys(checkpoints)) delete checkpoints[k];
        },
      },
      pendingTaskIds: Object.keys(checkpoints),
      orchestrator: { busy: false },
      ...overrides,
    },
    checkpoints,
    get cleared() { return cleared; },
  };
}

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

function main() {
  console.log('=== checkpoint-commands 单元测试 ===\n');

  // 测试 1: /ckpt list — 无检查点
  console.log('测试 1: /ckpt list — 无检查点');
  {
    const { agent } = makeMockAgent();
    const result = handleCkptCommand(agent, ['list']);
    assert(result.includes('无检查点'), '显示无检查点');
  }
  console.log();

  // 测试 2: /ckpt list — 有检查点
  console.log('测试 2: /ckpt list — 有检查点');
  {
    const ctx = makeMockAgent();
    ctx.checkpoints['task-001'] = makeMockCheckpointData();
    ctx.agent.pendingTaskIds = ['task-001'];
    const result = handleCkptCommand(ctx.agent, ['list']);
    assert(result.includes('1)'), '显示检查点数量');
    assert(result.includes('task-001'), '包含任务 ID');
    assert(result.includes('33%') || result.includes('50%'), '显示进度百分比');
    assert(result.includes('5分钟前'), '显示创建时间');
  }
  console.log();

  // 测试 3: /ckpt list 默认子命令
  console.log('测试 3: /ckpt (无参数) → 默认 list');
  {
    const ctx = makeMockAgent();
    ctx.checkpoints['task-001'] = makeMockCheckpointData();
    ctx.agent.pendingTaskIds = ['task-001'];
    const result = handleCkptCommand(ctx.agent, []);
    assert(result.includes('检查点列表') || result.includes('无检查点'), '默认执行 list');
  }
  console.log();

  // 测试 4: /ckpt show — 有效序号
  console.log('测试 4: /ckpt show 0 — 有效序号');
  {
    const ctx = makeMockAgent();
    ctx.checkpoints['task-001'] = makeMockCheckpointData();
    ctx.agent.pendingTaskIds = ['task-001'];
    const result = handleCkptCommand(ctx.agent, ['show', '0']);
    assert(result.includes('检查点详情'), '显示详情标题');
    assert(result.includes('task-001'), '包含任务 ID');
    assert(result.includes('创建一个 hello.txt'), '包含原始请求');
    assert(result.includes('已完成步骤'), '包含已完成步骤');
    assert(result.includes('待执行步骤'), '包含待执行步骤');
    assert(result.includes('故障历史'), '包含故障历史');
  }
  console.log();

  // 测试 5: /ckpt show — 无效序号
  console.log('测试 5: /ckpt show abc — 无效序号');
  {
    const ctx = makeMockAgent();
    ctx.checkpoints['task-001'] = makeMockCheckpointData();
    ctx.agent.pendingTaskIds = ['task-001'];
    const result = handleCkptCommand(ctx.agent, ['show', 'abc']);
    assert(result.includes('用法'), '显示用法提示');
  }
  console.log();

  // 测试 6: /ckpt show — 超出范围
  console.log('测试 6: /ckpt show 99 — 超出范围');
  {
    const ctx = makeMockAgent();
    ctx.checkpoints['task-001'] = makeMockCheckpointData();
    ctx.agent.pendingTaskIds = ['task-001'];
    const result = handleCkptCommand(ctx.agent, ['show', '99']);
    assert(result.includes('用法'), '显示用法提示');
  }
  console.log();

  // 测试 7: /ckpt clear
  console.log('测试 7: /ckpt clear — 清除所有');
  {
    const ctx = makeMockAgent();
    ctx.checkpoints['task-001'] = makeMockCheckpointData();
    ctx.checkpoints['task-002'] = makeMockCheckpointData({ taskId: 'task-002' });
    ctx.agent.pendingTaskIds = ['task-001', 'task-002'];
    const result = handleCkptCommand(ctx.agent, ['clear']);
    assert(result.includes('已清除'), '显示清除成功');
    assert(ctx.agent.pendingTaskIds.length === 0, 'pendingTaskIds 已清空');
    assert(ctx.cleared === true, '调用了 clearAll');
  }
  console.log();

  // 测试 8: /ckpt clearall 别名
  console.log('测试 8: /ckpt clearall — clear 的别名');
  {
    const ctx = makeMockAgent();
    ctx.checkpoints['task-001'] = makeMockCheckpointData();
    ctx.agent.pendingTaskIds = ['task-001'];
    const result = handleCkptCommand(ctx.agent, ['clearall']);
    assert(result.includes('已清除'), 'clearall 与 clear 效果相同');
  }
  console.log();

  // 测试 9: /ckpt 未知子命令
  console.log('测试 9: /ckpt unknown — 未知子命令');
  {
    const { agent } = makeMockAgent();
    const result = handleCkptCommand(agent, ['unknown']);
    assert(result.includes('用法'), '显示用法提示');
  }
  console.log();

  // 测试 10: /pause — 无正在执行的任务
  console.log('测试 10: /pause — 无正在执行的任务');
  {
    const { agent } = makeMockAgent();
    const result = handlePauseCommand(agent, []);
    assert(result.includes('无正在执行'), '提示无任务');
  }
  console.log();

  // 测试 11: /pause — 有正在执行的任务且有检查点
  console.log('测试 11: /pause — 有任务且有检查点');
  {
    const ctx = makeMockAgent();
    ctx.checkpoints['task-001'] = makeMockCheckpointData();
    ctx.agent.pendingTaskIds = ['task-001'];
    ctx.agent.orchestrator.busy = true;
    const result = handlePauseCommand(ctx.agent, []);
    assert(result.includes('任务已暂停'), '显示暂停成功');
    assert(result.includes('/resume'), '提示使用 /resume');
    assert(result.includes('1 个任务'), '显示待恢复任务数');
  }
  console.log();

  // 测试 12: /pause — 有任务但无检查点
  console.log('测试 12: /pause — 有任务但无检查点');
  {
    const ctx = makeMockAgent();
    ctx.agent.orchestrator.busy = true;
    const result = handlePauseCommand(ctx.agent, []);
    assert(result.includes('未找到检查点'), '提示未找到检查点');
  }
  console.log();

  console.log(`============================================`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log(`============================================`);
  if (fail > 0) process.exit(1);
}

main();
