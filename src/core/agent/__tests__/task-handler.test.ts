// TaskHandler 单元测试 - 验证任务处理逻辑
import * as path from 'path';

// 类型定义
interface Intent {
  summary: string;
  confidence: number;
  type: string;
}

interface MockAdapter {
  model: string;
  ping: () => Promise<boolean>;
}

interface MockSessionDiag {
  recordPing: (alive: boolean) => void;
  recordCircuitBreaker: (model: string, reason: string) => void;
}

interface MockHealthMon {
  recordPing: (alive: boolean) => void;
  watchTokenStream: () => void;
  endTokenStream: () => void;
}

interface MockProjectManager {
  getActiveProject: () => any;
  createProject: (name: string, opts: any) => void;
  addTodo: (project: string, todo: any) => void;
  recalculateProgress: (project: string) => void;
}

interface MockRecovery {
  executeProtected: (fn: () => Promise<string>, opts: any) => Promise<any>;
}

interface MockOrchestrator {
  execute: (intent: Intent, rawMessage: string) => Promise<string>;
}

interface TaskHandlerDeps {
  adapter: MockAdapter;
  sessionDiag: MockSessionDiag;
  healthMon: MockHealthMon;
  projectManager: MockProjectManager;
  recovery: MockRecovery;
  orchestrator: MockOrchestrator;
}

// 模拟 TaskHandler 类
class TestTaskHandler {
  private deps: TaskHandlerDeps;
  
  constructor(deps: TaskHandlerDeps) {
    this.deps = deps;
  }
  
  async handle(intent: Intent, rawMessage: string): Promise<string> {
    const alive = await this.deps.adapter.ping();
    this.deps.sessionDiag.recordPing(alive);
    
    if (!alive) {
      this.deps.healthMon.recordPing(false);
      this.deps.sessionDiag.recordCircuitBreaker(
        this.deps.adapter.model,
        'LM Studio 不可达 (handleTask)'
      );
      return 'WARN: LM Studio not connected.';
    }
    
    // 多Agent任务判断
    if (this.isMultiAgentTask(rawMessage)) {
      return await this.handleMultiAgentTask(intent, rawMessage);
    }
    
    // 创建或更新项目
    const active = this.deps.projectManager.getActiveProject();
    const summary = intent.summary || rawMessage.slice(0, 50);
    
    if (!active) {
      const name = this.sanitizeProjectName(summary || 'new-project');
      this.deps.projectManager.createProject(name, {
        description: rawMessage.slice(0, 200),
        priority: 'P1'
      });
      this.deps.projectManager.addTodo(name, {
        title: summary,
        status: 'in_progress',
        priority: 'P1'
      });
    } else {
      this.deps.projectManager.addTodo(active.project, {
        title: summary,
        status: 'in_progress',
        priority: intent.confidence > 0.8 ? 'P0' : 'P1'
      });
    }
    
    // 执行任务（带恢复保护）
    const taskId = 'task-' + Date.now();
    
    const result = await this.deps.recovery.executeProtected(async () => {
      this.deps.healthMon.watchTokenStream();
      try {
        const output = await this.deps.orchestrator.execute(intent, rawMessage);
        const proj = this.deps.projectManager.getActiveProject();
        if (proj) {
          this.deps.projectManager.recalculateProgress(proj.project);
        }
        return output;
      } finally {
        this.deps.healthMon.endTokenStream();
      }
    }, { taskId, context: { model: this.deps.adapter.model } });
    
    return this.formatRecoveryResult(result);
  }
  
  isMultiAgentTask(input: string): boolean {
    const keywords = ['同时', '并行', '分别', '多个', '团队', '协作', '分工'];
    return keywords.some(k => input.includes(k));
  }
  
  async handleMultiAgentTask(intent: Intent, rawMessage: string): Promise<string> {
    // 简化实现
    return 'multi-agent task completed';
  }
  
  sanitizeProjectName(input: string): string {
    return input.slice(0, 30)
      .replace(/[^a-zA-Z0-9\-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'project';
  }
  
  formatRecoveryResult(result: any): string {
    if (result.success) {
      let output = result.output ?? '';
      if (result.recovered) {
        const summary = result.recoveryLog.length > 0
          ? result.recoveryLog[result.recoveryLog.length - 1]
          : 'recovered';
        output = '[RECOVERED: ' + summary + ']\n\n' + output;
      }
      if (result.degraded) {
        output = '[DEGRADED L' + (result.degradationLevel ?? '?') + ']\n\n' + output;
      }
      return output;
    } else {
      let output = 'ERR: ' + (result.error || 'unknown error');
      if (result.fallbackUsed) {
        output += '\n[FALLBACK: ' + (result.fallbackReason || 'unknown') + ']';
      }
      return output;
    }
  }
}

// ─── 测试辅助函数 ──────────────────────────────────────────────────────────

function createMockAdapter(overrides?: Partial<MockAdapter>): MockAdapter {
  return {
    model: 'test-model',
    ping: async () => true,
    ...overrides
  };
}

function createMockSessionDiag(): MockSessionDiag {
  return {
    recordPing: () => {},
    recordCircuitBreaker: () => {}
  };
}

function createMockHealthMon(): MockHealthMon {
  return {
    recordPing: () => {},
    watchTokenStream: () => {},
    endTokenStream: () => {}
  };
}

function createMockProjectManager(overrides?: Partial<MockProjectManager>): MockProjectManager {
  return {
    getActiveProject: () => null,
    createProject: () => {},
    addTodo: () => {},
    recalculateProgress: () => {},
    ...overrides
  };
}

function createMockRecovery(overrides?: Partial<MockRecovery>): MockRecovery {
  return {
    executeProtected: async (fn: () => Promise<string>, opts: any) => {
      const output = await fn();
      return { success: true, output };
    },
    ...overrides
  };
}

function createMockOrchestrator(overrides?: Partial<MockOrchestrator>): MockOrchestrator {
  return {
    execute: async (intent: Intent, raw: string) => 'Task completed successfully',
    ...overrides
  };
}

// ─── 测试函数 ──────────────────────────────────────────────────────────────

async function testHandleMethod() {
  console.log('\n=== 测试 1: handle() 方法 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const deps: TaskHandlerDeps = {
      adapter: createMockAdapter(),
      sessionDiag: createMockSessionDiag(),
      healthMon: createMockHealthMon(),
      projectManager: createMockProjectManager(),
      recovery: createMockRecovery(),
      orchestrator: createMockOrchestrator()
    };
    
    const handler = new TestTaskHandler(deps);
    const intent: Intent = { summary: 'Test task', confidence: 0.9, type: 'task' };
    
    const result = await handler.handle(intent, 'Test message');
    
    if (result.includes('completed') || result.includes('RECOVERED')) {
      console.log('  ✅ 任务处理成功');
      passed++;
    } else {
      console.log(`  ❌ 任务处理失败: ${result}`);
      failed++;
    }
    
    // 测试 1.2: 模型不可达
    const depsUnreachable: TaskHandlerDeps = {
      ...deps,
      adapter: createMockAdapter({ ping: async () => false })
    };
    
    const handlerUnreachable = new TestTaskHandler(depsUnreachable);
    const result2 = await handlerUnreachable.handle(intent, 'Test');
    
    if (result2.includes('WARN') && result2.includes('not connected')) {
      console.log('  ✅ 模型不可达时正确提示');
      passed++;
    } else {
      console.log(`  ❌ 模型不可达提示错误: ${result2}`);
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testTaskCreation() {
  console.log('\n=== 测试 2: 任务创建和执行流程 ===');
  
  let passed = 0, failed = 0;
  
  try {
    // 测试 2.1: 创建新项目
    let createdProject: string | null = null;
    const deps1: TaskHandlerDeps = {
      adapter: createMockAdapter(),
      sessionDiag: createMockSessionDiag(),
      healthMon: createMockHealthMon(),
      projectManager: createMockProjectManager({
        createProject: (name: string, opts: any) => { createdProject = name; },
        getActiveProject: () => null
      }),
      recovery: createMockRecovery(),
      orchestrator: createMockOrchestrator()
    };
    
    const handler1 = new TestTaskHandler(deps1);
    await handler1.handle({ summary: 'New project task', confidence: 0.8, type: 'task' }, 'Create a new feature');
    
    if (createdProject !== null) {
      console.log('  ✅ 无活跃项目时自动创建新项目');
      passed++;
    } else {
      console.log('  ❌ 应创建新项目');
      failed++;
    }
    
    // 测试 2.2: 更新现有项目
    let addedTodo: any = null;
    const deps2: TaskHandlerDeps = {
      adapter: createMockAdapter(),
      sessionDiag: createMockSessionDiag(),
      healthMon: createMockHealthMon(),
      projectManager: createMockProjectManager({
        getActiveProject: () => ({ project: 'existing-project', status: 'active' }),
        addTodo: (project: string, todo: any) => { addedTodo = todo; }
      }),
      recovery: createMockRecovery(),
      orchestrator: createMockOrchestrator()
    };
    
    const handler2 = new TestTaskHandler(deps2);
    await handler2.handle({ summary: 'Update task', confidence: 0.9, type: 'task' }, 'Add new feature');
    
    if (addedTodo && addedTodo.priority === 'P0') {
      console.log('  ✅ 高置信度任务设置为 P0 优先级');
      passed++;
    } else {
      console.log(`  ❌ 优先级设置错误: ${JSON.stringify(addedTodo)}`);
      failed++;
    }
    
    // 测试 2.3: 执行流程
    let executed = false;
    const deps3: TaskHandlerDeps = {
      adapter: createMockAdapter(),
      sessionDiag: createMockSessionDiag(),
      healthMon: createMockHealthMon(),
      projectManager: createMockProjectManager({
        getActiveProject: () => ({ project: 'test', status: 'active' })
      }),
      recovery: createMockRecovery(),
      orchestrator: createMockOrchestrator({
        execute: async () => { executed = true; return 'Done'; }
      })
    };
    
    const handler3 = new TestTaskHandler(deps3);
    await handler3.handle({ summary: 'Execute test', confidence: 0.7, type: 'task' }, 'Execute');
    
    if (executed) {
      console.log('  ✅ orchestrator.execute 被正确调用');
      passed++;
    } else {
      console.log('  ❌ orchestrator 未被调用');
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testMultiAgentDetection() {
  console.log('\n=== 测试 3: 多Agent任务检测 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const deps: TaskHandlerDeps = {
      adapter: createMockAdapter(),
      sessionDiag: createMockSessionDiag(),
      healthMon: createMockHealthMon(),
      projectManager: createMockProjectManager(),
      recovery: createMockRecovery(),
      orchestrator: createMockOrchestrator()
    };
    
    const handler = new TestTaskHandler(deps);
    
    // 测试 3.1: 检测并行关键词
    const testCases = [
      { input: '同时完成前端和后端', expected: true },
      { input: '并行处理两个任务', expected: true },
      { input: '分别创建两个页面', expected: true },
      { input: '多个任务同时进行', expected: true },
      { input: '团队协作完成任务', expected: true },
      { input: '分工合作开发', expected: true },
      { input: '普通单任务', expected: false },
      { input: '简单查询', expected: false },
    ];
    
    for (const tc of testCases) {
      const result = handler.isMultiAgentTask(tc.input);
      if (result === tc.expected) {
        console.log(`  ✅ "${tc.input}" 检测${tc.expected ? '为' : '不为'}多Agent任务`);
        passed++;
      } else {
        console.log(`  ❌ "${tc.input}" 应${tc.expected ? '为' : '不为'}多Agent任务，实际${result ? '是' : '否'}`);
        failed++;
      }
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testErrorHandling() {
  console.log('\n=== 测试 4: 错误处理 ===');
  
  let passed = 0, failed = 0;
  
  try {
    // 测试 4.1: 任务失败恢复
    const deps1: TaskHandlerDeps = {
      adapter: createMockAdapter(),
      sessionDiag: createMockSessionDiag(),
      healthMon: createMockHealthMon(),
      projectManager: createMockProjectManager({
        getActiveProject: () => ({ project: 'test', status: 'active' })
      }),
      recovery: createMockRecovery({
        executeProtected: async () => ({
          success: false,
          error: 'Task execution failed',
          fallbackUsed: true,
          fallbackReason: 'Circuit breaker triggered'
        })
      }),
      orchestrator: createMockOrchestrator()
    };
    
    const handler1 = new TestTaskHandler(deps1);
    const result1 = await handler1.handle({ summary: 'Fail task', confidence: 0.8, type: 'task' }, 'Test');
    
    if (result1.includes('ERR:') && result1.includes('FALLBACK')) {
      console.log('  ✅ 任务失败时正确返回错误和回退信息');
      passed++;
    } else {
      console.log(`  ❌ 错误信息不完整: ${result1}`);
      failed++;
    }
    
    // 测试 4.2: 降级模式
    const deps2: TaskHandlerDeps = {
      adapter: createMockAdapter(),
      sessionDiag: createMockSessionDiag(),
      healthMon: createMockHealthMon(),
      projectManager: createMockProjectManager({
        getActiveProject: () => ({ project: 'test', status: 'active' })
      }),
      recovery: createMockRecovery({
        executeProtected: async () => ({
          success: true,
          output: 'Task completed with degraded mode',
          degraded: true,
          degradationLevel: 2
        })
      }),
      orchestrator: createMockOrchestrator()
    };
    
    const handler2 = new TestTaskHandler(deps2);
    const result2 = await handler2.handle({ summary: 'Degraded task', confidence: 0.8, type: 'task' }, 'Test');
    
    if (result2.includes('DEGRADED L2')) {
      console.log('  ✅ 降级模式正确标记');
      passed++;
    } else {
      console.log(`  ❌ 降级标记缺失: ${result2}`);
      failed++;
    }
    
    // 测试 4.3: 超时处理
    const deps3: TaskHandlerDeps = {
      adapter: createMockAdapter(),
      sessionDiag: createMockSessionDiag(),
      healthMon: createMockHealthMon(),
      projectManager: createMockProjectManager(),
      recovery: createMockRecovery({
        executeProtected: async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return { success: true, output: 'Timeout test' };
        }
      }),
      orchestrator: createMockOrchestrator()
    };
    
    const handler3 = new TestTaskHandler(deps3);
    const result3 = await handler3.handle({ summary: 'Timeout', confidence: 0.5, type: 'task' }, 'Test');
    
    // 应正常返回（超时由 recovery 层处理）
    if (result3.includes('Timeout test')) {
      console.log('  ✅ 超时任务正常返回');
      passed++;
    } else {
      console.log(`  ❌ 超时处理异常: ${result3}`);
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testFormatRecoveryResult() {
  console.log('\n=== 测试 5: formatRecoveryResult 方法 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const deps: TaskHandlerDeps = {
      adapter: createMockAdapter(),
      sessionDiag: createMockSessionDiag(),
      healthMon: createMockHealthMon(),
      projectManager: createMockProjectManager(),
      recovery: createMockRecovery(),
      orchestrator: createMockOrchestrator()
    };
    
    const handler = new TestTaskHandler(deps);
    
    // 测试 5.1: 成功结果
    const result1 = handler.formatRecoveryResult({
      success: true,
      output: 'Success output'
    });
    if (result1 === 'Success output') {
      console.log('  ✅ 成功结果正确格式化');
      passed++;
    } else {
      console.log(`  ❌ 格式化错误: ${result1}`);
      failed++;
    }
    
    // 测试 5.2: 恢复结果
    const result2 = handler.formatRecoveryResult({
      success: true,
      output: 'Recovered output',
      recovered: true,
      recoveryLog: ['Attempt 1', 'Attempt 2', 'Recovered']
    });
    if (result2.includes('RECOVERED') && result2.includes('Recovered')) {
      console.log('  ✅ 恢复结果正确标记');
      passed++;
    } else {
      console.log(`  ❌ 恢复标记错误: ${result2}`);
      failed++;
    }
    
    // 测试 5.3: 降级结果
    const result3 = handler.formatRecoveryResult({
      success: true,
      output: 'Degraded output',
      degraded: true,
      degradationLevel: 3
    });
    if (result3.includes('DEGRADED L3')) {
      console.log('  ✅ 降级结果正确标记');
      passed++;
    } else {
      console.log(`  ❌ 降级标记错误: ${result3}`);
      failed++;
    }
    
    // 测试 5.4: 失败结果
    const result4 = handler.formatRecoveryResult({
      success: false,
      error: 'Task failed',
      fallbackUsed: true,
      fallbackReason: 'Retry limit exceeded'
    });
    if (result4.includes('ERR:') && result4.includes('FALLBACK')) {
      console.log('  ✅ 失败结果正确格式化');
      passed++;
    } else {
      console.log(`  ❌ 失败格式化错误: ${result4}`);
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

// ─── 主函数 ────────────────────────────────────────────────────────────────

async function main() {
  console.log('开始 TaskHandler 单元测试...\n');
  console.log('='.repeat(70));
  
  let allPass = true;
  allPass = (await testHandleMethod()) && allPass;
  allPass = (await testTaskCreation()) && allPass;
  allPass = (await testMultiAgentDetection()) && allPass;
  allPass = (await testErrorHandling()) && allPass;
  allPass = (await testFormatRecoveryResult()) && allPass;
  
  console.log('='.repeat(70));
  if (allPass) {
    console.log('✅ 所有测试通过！\n');
  } else {
    console.log('❌ 部分测试失败，请检查上述输出\n');
  }
  
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
