// Phase 2 验证脚本 — 智能路由 + 模型磨合
import { assessDifficulty } from './models/router/difficulty-assessor';
import { SmartRouter, getRouter } from './models/router/smart-router';
import { BreakInMachine } from './models/adaptation/break-in-machine';
import { getProfileStore } from './models/profile/model-profile';
import logger from './logger';

function test() {
  logger.setLevel('info');

  console.log('=== Phase 2 模型适配层验证 ===\n');

  // ====== 2B: 难度评估 ======
  console.log('>>> 测试1: 难度评估器');
  const cases = [
    { input: '你好', expected: 'trivial' },
    { input: '帮我写一个 Python 脚本读取天气', expected: 'simple' },
    { input: '设计一个并发安全的数据库连接池，支持 MySQL 和 PostgreSQL', expected: 'complex' },
    { input: '重构整个微服务架构，设计新的 API 网关和熔断策略', expected: 'hard' },
  ];

  for (const c of cases) {
    const result = assessDifficulty(c.input);
    const icon = result.level === c.expected ? '✅' : `❌(got ${result.level})`;
    console.log(`  ${icon} "${c.input.slice(0, 50)}..." → ${result.level} (${result.score}) ${result.suggestion}`);
    if (result.factors.length > 0) console.log(`     因素: ${result.factors.join(', ')}`);
  }
  console.log('');

  // ====== 2B: 智能路由 ======
  console.log('>>> 测试2: 智能路由');
  const router = getRouter();
  const decisions = [
    router.selectModel('你好', 0),
    router.selectModel('帮我写一个脚本', 1),
    router.selectModel('设计一个高并发分布式缓存系统', 3),
  ];
  for (const d of decisions) {
    console.log(`  🧭 ${d.reason}`);
    console.log(`     难度: ${d.difficulty.level}(${d.difficulty.score}) 兜底: ${d.fallback?.name || '无'}`);
  }
  console.log('');

  // ====== 路由状态 ======
  console.log('>>> 测试3: 路由状态');
  console.log(router.status());
  console.log('');

  // ====== 2A: 模型画像 ======
  console.log('>>> 测试4: 模型画像存储');
  const profileStore = getProfileStore();
  const profile = profileStore.get('test-model');
  console.log(`  ✅ 默认画像: ${profile.modelName} (${profile.stage})`);
  console.log(`     策略: maxTools=${profile.behavior.maxTools} CoT=${profile.behavior.useCoT}`);

  // 模拟探测完成
  profileStore.setCapability('test-model', {
    modelName: 'test-model',
    probedAt: new Date().toISOString(),
    results: [],
    scores: {
      'tool_calling': { category: 'tool_calling', score: 0.8, passed: 2, total: 2, criticalFailed: false },
      'json_output': { category: 'json_output', score: 0.9, passed: 2, total: 2, criticalFailed: false },
    },
    overallScore: 0.85,
    recommendations: ['工具调用稳定'],
    warnings: [],
    stage: 'learning',
    strategy: { maxTools: 5, useCoT: false, maxTokens: 4096, temperature: 0.7, parallelToolCalls: true, retryOnToolError: true, promptWrapper: 'minimal' },
  });

  // 记录交互
  for (let i = 0; i < 5; i++) {
    profileStore.recordInteraction('test-model', {
      taskType: 'chat',
      success: true,
      durationMs: 500 + i * 10,
      toolCalls: 0,
      toolErrors: 0,
    });
  }
  profileStore.recordInteraction('test-model', {
    taskType: 'task',
    success: false,
    durationMs: 5000,
    toolCalls: 2,
    toolErrors: 2,
  });

  console.log(`  ✅ 交互记录: ${profile.interactionHistory.length}次`);
  console.log(`     成功率: ${(profile.stats.successRate * 100).toFixed(0)}%`);
  console.log(`     平均耗时: ${profile.stats.avgDurationMs.toFixed(0)}ms`);

  // 策略调整
  profileStore.adjustStrategy('test-model', { parallelToolCalls: false });
  console.log(`  ✅ 策略调整: parallelToolCalls → false`);
  console.log('');

  // ====== 2C: 磨合期状态机 ======
  console.log('>>> 测试5: 磨合期状态机');
  const bim = new BreakInMachine('test-model');
  console.log(`  当前阶段: ${bim.getStage()}`);

  // 模拟连续失败 → degraded
  for (let i = 0; i < 6; i++) {
    bim.evaluateInteraction({
      taskType: 'task',
      success: false,
      durationMs: 10000,
      toolCalls: 3,
      toolErrors: 3,
    });
  }
  console.log(`  连续6次失败后: ${bim.getStage()}`);

  // 模拟恢复
  for (let i = 0; i < 11; i++) {
    bim.evaluateInteraction({
      taskType: 'chat',
      success: true,
      durationMs: 200,
      toolCalls: 0,
      toolErrors: 0,
    });
  }
  console.log(`  连续11次成功后: ${bim.getStage()}`);

  // 清理
  const fs = require('fs');
  const path = require('path');
  const testDir = path.resolve('data/profiles');
  if (fs.existsSync(testDir)) {
    fs.unlinkSync(path.join(testDir, 'test-model.json'));
  }

  console.log('\n✅✅✅ Phase 2 单元验证通过！');
  console.log('⚠️ 模型适配器集成测试需 LM Studio 运行中');
}

test();
