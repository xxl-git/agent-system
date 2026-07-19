// model-commands.test.ts
// model-commands 单元测试

import { scanModels, switchModel } from '../model-commands';

function makeMockAgent(overrides: any = {}) {
  let currentModel = 'old-model';
  const setModelCalls: string[] = [];
  const diagCalls: string[] = [];
  const detectorCalls: string[] = [];
  const breakInCalls: string[] = [];
  return {
    agent: {
      adapter: {
        get model() { return currentModel; },
        async listModels() {
          return [
            { id: 'old-model', context_length: 4096, arch: 'qwen' },
            { id: 'new-model', context_length: 8192, arch: 'llama' },
            { id: 'tiny-model', context_length: 2048, arch: 'phi' },
          ];
        },
        setModel(name: string) { setModelCalls.push(name); currentModel = name; },
        raw: { contextLength: 4096 },
      },
      _availableModels: [] as any[],
      sessionDiag: { setModelName(name: string) { diagCalls.push(name); } },
      nonsenseDetector: { setModelName(name: string) { detectorCalls.push(name); } },
      breakIn: { setModelName(name: string) { breakInCalls.push(name); } },
      ...overrides,
    },
    setModelCalls,
    diagCalls,
    detectorCalls,
    breakInCalls,
  };
}

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

async function main() {
  console.log('=== model-commands 单元测试 ===\n');

  // 测试 1: scanModels 正常扫描
  console.log('测试 1: scanModels() 正常扫描');
  {
    const { agent } = makeMockAgent();
    const result = await scanModels(agent);
    assert(result.includes('3 个已加载模型'), '显示模型数量');
    assert(result.includes('old-model'), '包含 old-model');
    assert(result.includes('new-model'), '包含 new-model');
    assert(result.includes('← 当前'), '标记当前模型');
    assert(agent._availableModels.length === 3, '_availableModels 已更新');
  }
  console.log();

  // 测试 2: scanModels 空列表
  console.log('测试 2: scanModels() 无已加载模型');
  {
    const { agent } = makeMockAgent({
      adapter: {
        async listModels() { return []; },
        model: 'test',
        setModel() {},
        raw: {},
      },
    });
    const result = await scanModels(agent);
    assert(result.includes('无已加载模型'), '提示无模型');
    assert(result.includes('LM Studio'), '提及 LM Studio');
  }
  console.log();

  // 测试 3: scanModels 异常
  console.log('测试 3: scanModels() 异常情况');
  {
    const { agent } = makeMockAgent({
      adapter: {
        async listModels() { throw new Error('connection refused'); },
        model: 'test',
        setModel() {},
        raw: {},
      },
    });
    const result = await scanModels(agent);
    assert(result.includes('扫描失败'), '显示失败信息');
    assert(result.includes('connection refused'), '包含错误详情');
  }
  console.log();

  // 测试 4: switchModel 正常切换
  console.log('测试 4: switchModel() 正常切换');
  {
    const ctx = makeMockAgent();
    // 先扫描填充 _availableModels
    await scanModels(ctx.agent);
    const result = switchModel(ctx.agent, 'new-model');
    assert(result.includes('模型已切换'), '显示切换成功');
    assert(result.includes('old-model → new-model'), '显示新旧模型名');
    assert(ctx.setModelCalls.includes('new-model'), '调用了 setModel');
    assert(ctx.diagCalls.includes('new-model'), '更新了 sessionDiag');
    assert(ctx.detectorCalls.includes('new-model'), '更新了 nonsenseDetector');
    assert(ctx.breakInCalls.includes('new-model'), '更新了 breakIn');
  }
  console.log();

  // 测试 5: switchModel 目标不存在
  console.log('测试 5: switchModel() 目标模型不存在');
  {
    const ctx = makeMockAgent();
    await scanModels(ctx.agent);
    const result = switchModel(ctx.agent, 'nonexistent-model');
    assert(result.includes('未在 LM Studio 中加载'), '提示模型未加载');
    assert(ctx.setModelCalls.length === 0, '未调用 setModel');
  }
  console.log();

  // 测试 6: switchModel 相同模型
  console.log('测试 6: switchModel() 切换到当前模型');
  {
    const ctx = makeMockAgent();
    await scanModels(ctx.agent);
    const result = switchModel(ctx.agent, 'old-model');
    assert(result.includes('当前已使用'), '提示已是当前模型');
    assert(ctx.setModelCalls.length === 0, '未调用 setModel');
  }
  console.log();

  // 测试 7: switchModel 空模型列表
  console.log('测试 7: switchModel() 空模型列表');
  {
    const ctx = makeMockAgent({
      adapter: {
        async listModels() { return []; },
        model: 'test',
        setModel() {},
        raw: {},
      },
    });
    const result = switchModel(ctx.agent, 'any-model');
    assert(result.includes('未在 LM Studio 中加载'), '空列表时提示未加载');
  }
  console.log();

  // 测试 8: scanModels 更新上下文长度
  console.log('测试 8: switchModel() 更新上下文长度');
  {
    const ctx = makeMockAgent();
    await scanModels(ctx.agent);
    switchModel(ctx.agent, 'new-model');
    assert((ctx.agent.adapter as any).raw.contextLength === 8192, '上下文长度已更新为 8192');
  }
  console.log();

  console.log(`============================================`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log(`============================================`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
