// CheckpointManager 单元测试 - 验证检查点管理逻辑
import * as fs from 'fs';
import * as path from 'path';

// 类型定义
interface FailureRecord {
  timestamp: Date;
  type: string;
  message: string;
  stepIndex: number;
  recovered: boolean;
}

interface SubTask {
  id: string;
  title: string;
  description?: string;
  status: string;
}

interface CompletedStep {
  step: SubTask;
  result: { success: boolean; output: string; error?: string };
  completedAt: string;
}

interface TaskCheckpoint {
  taskId: string;
  originalRequest: string;
  stepIndex: number;
  completedSteps: CompletedStep[];
  pendingSteps: SubTask[];
  context: any[];
  retryCount: number;
  failures: FailureRecord[];
  timestamp: string;
  version: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 模拟 CheckpointManager 类
class TestCheckpointManager {
  private dataDir: string;
  private contextWindow: number;
  private maxRecoveryAttempts: number;

  constructor(config: { dataDir: string; contextWindow?: number; maxRecoveryAttempts?: number }) {
    this.dataDir = config.dataDir;
    this.contextWindow = config.contextWindow || 20;
    this.maxRecoveryAttempts = config.maxRecoveryAttempts || 3;
    
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private filePath(taskId: string): string {
    const sanitized = taskId.replace(/[<>:"/\\|?*]/g, '_').slice(0, 120);
    return path.join(this.dataDir, `${sanitized}.json`);
  }

  createCheckpoint(taskId: string, request: string, pendingSteps: SubTask[]): TaskCheckpoint {
    const cp: TaskCheckpoint = {
      taskId,
      originalRequest: request,
      stepIndex: 0,
      completedSteps: [],
      pendingSteps,
      context: [],
      retryCount: 0,
      failures: [],
      timestamp: new Date().toISOString(),
      version: 1,
    };
    this.write(cp);
    return cp;
  }

  save(
    taskId: string,
    completedStep: CompletedStep,
    remainingSteps: SubTask[],
    messages: ChatMessage[],
    stepIndex?: number
  ): TaskCheckpoint {
    const existing = this.load(taskId);
    const completedSteps = existing ? [...existing.completedSteps, completedStep] : [completedStep];
    const context = messages.slice(-this.contextWindow);

    const cp: TaskCheckpoint = {
      taskId,
      originalRequest: existing?.originalRequest ?? '',
      stepIndex: stepIndex ?? completedSteps.length,
      completedSteps,
      pendingSteps: remainingSteps,
      context,
      retryCount: existing?.retryCount ?? 0,
      failures: existing?.failures ?? [],
      timestamp: new Date().toISOString(),
      version: (existing?.version ?? 0) + 1,
    };
    this.write(cp);
    return cp;
  }

  load(taskId: string): TaskCheckpoint | null {
    const file = this.filePath(taskId);
    if (!fs.existsSync(file)) return null;

    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const cp: TaskCheckpoint = JSON.parse(raw);
      // 解析时间字段
      cp.timestamp = cp.timestamp ?? new Date().toISOString();
      cp.failures = cp.failures.map(f => ({ ...f, timestamp: new Date(f.timestamp) }));
      cp.completedSteps = cp.completedSteps.map(s => ({
        ...s,
        completedAt: s.completedAt ?? new Date().toISOString(),
      }));
      return cp;
    } catch (err) {
      console.error('[TestCkpt] Failed to load checkpoint:', file, err);
      return null;
    }
  }

  recoverTask(taskId: string): { checkpoint: TaskCheckpoint; canRecover: boolean; reason?: string } | null {
    const cp = this.load(taskId);
    if (!cp) return null;

    if (cp.retryCount >= this.maxRecoveryAttempts) {
      return {
        checkpoint: cp,
        canRecover: false,
        reason: `已达到最大恢复次数 (${cp.retryCount}/${this.maxRecoveryAttempts})`
      };
    }

    if (cp.pendingSteps.length === 0) {
      return {
        checkpoint: cp,
        canRecover: false,
        reason: '所有步骤已完成'
      };
    }

    return { checkpoint: cp, canRecover: true };
  }

  listCheckpoints(): string[] {
    const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.json'));
    return files.map(f => f.replace('.json', ''));
  }

  complete(taskId: string): void {
    const file = this.filePath(taskId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  recordFailure(taskId: string, failure: Omit<FailureRecord, 'timestamp'>): TaskCheckpoint | null {
    const cp = this.load(taskId);
    if (!cp) return null;

    cp.failures.push({ ...failure, timestamp: new Date() });
    cp.retryCount++;
    cp.timestamp = new Date().toISOString();
    cp.version++;
    this.write(cp);
    return cp;
  }

  private write(cp: TaskCheckpoint): void {
    const file = this.filePath(cp.taskId);
    fs.writeFileSync(file, JSON.stringify(cp, null, 2), 'utf-8');
  }
}

// ─── 测试辅助函数 ──────────────────────────────────────────────────────────

function createTempDir(): string {
  const tempDir = path.join(__dirname, `temp-checkpoints-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      fs.unlinkSync(path.join(dir, file));
    }
    fs.rmdirSync(dir);
  }
}

function createMockSubTask(id: string, title: string): SubTask {
  return { id, title, status: 'pending' };
}

function createMockCompletedStep(id: string, success: boolean, output: string): CompletedStep {
  return {
    step: createMockSubTask(id, `Step ${id}`),
    result: { success, output, error: success ? undefined : 'Test error' },
    completedAt: new Date().toISOString(),
  };
}

// ─── 测试函数 ──────────────────────────────────────────────────────────────

async function testCreateCheckpoint() {
  console.log('\n=== 测试 1: createCheckpoint() 函数 ===');
  
  const tempDir = createTempDir();
  let passed = 0, failed = 0;
  
  try {
    const manager = new TestCheckpointManager({ dataDir: tempDir });
    
    // 创建检查点
    const taskId = 'test-task-001';
    const request = 'Test task request';
    const pendingSteps = [
      createMockSubTask('step1', 'First step'),
      createMockSubTask('step2', 'Second step'),
    ];
    
    const cp = manager.createCheckpoint(taskId, request, pendingSteps);
    
    // 验证：检查点已创建
    if (cp.taskId === taskId) {
      console.log('  ✅ taskId 正确');
      passed++;
    } else {
      console.log('  ❌ taskId 不匹配');
      failed++;
    }
    
    // 验证：originalRequest 正确
    if (cp.originalRequest === request) {
      console.log('  ✅ originalRequest 正确');
      passed++;
    } else {
      console.log('  ❌ originalRequest 不匹配');
      failed++;
    }
    
    // 验证：pendingSteps 正确
    if (cp.pendingSteps.length === 2) {
      console.log('  ✅ pendingSteps 数量正确');
      passed++;
    } else {
      console.log('  ❌ pendingSteps 数量不匹配');
      failed++;
    }
    
    // 验证：completedSteps 为空
    if (cp.completedSteps.length === 0) {
      console.log('  ✅ completedSteps 为空');
      passed++;
    } else {
      console.log('  ❌ completedSteps 应为空');
      failed++;
    }
    
    // 验证：文件已创建
    const files = fs.readdirSync(tempDir);
    if (files.some(f => f.includes(taskId))) {
      console.log('  ✅ 检查点文件已创建');
      passed++;
    } else {
      console.log('  ❌ 检查点文件未创建');
      failed++;
    }
    
  } finally {
    cleanupTempDir(tempDir);
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testRecoverTask() {
  console.log('\n=== 测试 2: recoverTask() 函数 ===');
  
  const tempDir = createTempDir();
  let passed = 0, failed = 0;
  
  try {
    const manager = new TestCheckpointManager({ dataDir: tempDir });
    
    // 测试 2.1: 正常恢复
    const taskId = 'test-recover-001';
    manager.createCheckpoint(taskId, 'Test', [
      createMockSubTask('step1', 'First'),
      createMockSubTask('step2', 'Second'),
    ]);
    
    // 完成第一步
    manager.save(taskId, createMockCompletedStep('step1', true, 'Done'), [
      createMockSubTask('step2', 'Second'),
    ], [
      { role: 'user', content: 'Test message' }
    ]);
    
    const result = manager.recoverTask(taskId);
    
    if (result && result.canRecover) {
      console.log('  ✅ 任务可以恢复');
      passed++;
    } else {
      console.log('  ❌ 任务应可恢复');
      failed++;
    }
    
    if (result && result.checkpoint.completedSteps.length === 1) {
      console.log('  ✅ 已完成步骤数量正确');
      passed++;
    } else {
      console.log('  ❌ 已完成步骤数量不匹配');
      failed++;
    }
    
    // 测试 2.2: 超过最大恢复次数
    for (let i = 0; i < 3; i++) {
      manager.recordFailure(taskId, {
        type: 'timeout',
        message: 'Test failure',
        stepIndex: 0,
        recovered: false
      });
    }
    
    const result2 = manager.recoverTask(taskId);
    
    if (result2 && !result2.canRecover && result2.reason?.includes('最大恢复次数')) {
      console.log('  ✅ 超过最大恢复次数时拒绝恢复');
      passed++;
    } else {
      console.log('  ❌ 应拒绝恢复');
      failed++;
    }
    
    // 测试 2.3: 所有步骤已完成
    const taskId2 = 'test-complete-002';
    manager.createCheckpoint(taskId2, 'Test', [createMockSubTask('step1', 'Only step')]);
    manager.save(taskId2, createMockCompletedStep('step1', true, 'Done'), [], []);
    
    const result3 = manager.recoverTask(taskId2);
    
    if (result3 && !result3.canRecover && result3.reason?.includes('所有步骤已完成')) {
      console.log('  ✅ 已完成任务拒绝恢复');
      passed++;
    } else {
      console.log('  ❌ 已完成任务应拒绝恢复');
      failed++;
    }
    
  } finally {
    cleanupTempDir(tempDir);
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testListCheckpoints() {
  console.log('\n=== 测试 3: listCheckpoints() 函数 ===');
  
  const tempDir = createTempDir();
  let passed = 0, failed = 0;
  
  try {
    const manager = new TestCheckpointManager({ dataDir: tempDir });
    
    // 创建多个检查点
    for (let i = 1; i <= 3; i++) {
      manager.createCheckpoint(`task-${i}`, `Task ${i}`, [createMockSubTask('s1', 'Step')]);
    }
    
    const list = manager.listCheckpoints();
    
    // 验证：列出所有检查点
    if (list.length === 3) {
      console.log(`  ✅ 正确列出 ${list.length} 个检查点`);
      passed++;
    } else {
      console.log(`  ❌ 应有 3 个检查点，实际 ${list.length} 个`);
      failed++;
    }
    
    // 验证：包含所有 taskId
    if (list.includes('task-1') && list.includes('task-2') && list.includes('task-3')) {
      console.log('  ✅ 包含所有检查点 ID');
      passed++;
    } else {
      console.log('  ❌ 检查点 ID 缺失');
      failed++;
    }
    
    // 完成一个任务
    manager.complete('task-2');
    
    const list2 = manager.listCheckpoints();
    
    // 验证：完成的任务不在列表中
    if (list2.length === 2 && !list2.includes('task-2')) {
      console.log('  ✅ 完成的任务已从列表移除');
      passed++;
    } else {
      console.log('  ❌ 完成的任务应移除');
      failed++;
    }
    
  } finally {
    cleanupTempDir(tempDir);
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testErrorHandling() {
  console.log('\n=== 测试 4: 错误处理（无效数据、文件损坏） ===');
  
  const tempDir = createTempDir();
  let passed = 0, failed = 0;
  
  try {
    const manager = new TestCheckpointManager({ dataDir: tempDir });
    
    // 测试 4.1: 加载不存在的检查点
    const result1 = manager.load('nonexistent-task');
    
    if (result1 === null) {
      console.log('  ✅ 不存在的检查点返回 null');
      passed++;
    } else {
      console.log('  ❌ 应返回 null');
      failed++;
    }
    
    // 测试 4.2: 损坏的 JSON 文件
    const corruptFile = path.join(tempDir, 'corrupt.json');
    fs.writeFileSync(corruptFile, '{ invalid json }', 'utf-8');
    
    const result2 = manager.load('corrupt');
    
    if (result2 === null) {
      console.log('  ✅ 损坏文件返回 null（不抛异常）');
      passed++;
    } else {
      console.log('  ❌ 损坏文件应返回 null');
      failed++;
    }
    
    // 测试 4.3: 空文件
    const emptyFile = path.join(tempDir, 'empty.json');
    fs.writeFileSync(emptyFile, '', 'utf-8');
    
    const result3 = manager.load('empty');
    
    if (result3 === null) {
      console.log('  ✅ 空文件返回 null');
      passed++;
    } else {
      console.log('  ❌ 空文件应返回 null');
      failed++;
    }
    
    // 测试 4.4: 特殊字符 taskId（路径注入防护）
    const maliciousTaskId = '../../../etc/passwd';
    manager.createCheckpoint(maliciousTaskId, 'Test', [createMockSubTask('s1', 'Step')]);
    
    const result4 = manager.load(maliciousTaskId);
    
    if (result4 !== null && result4.taskId === maliciousTaskId) {
      console.log('  ✅ 特殊字符 taskId 正确处理');
      passed++;
    } else {
      console.log('  ❌ 特殊字符处理失败');
      failed++;
    }
    
    // 验证：文件名已清理（不包含 / 或 \）
    const files = fs.readdirSync(tempDir);
    const passwdFile = files.find(f => f.includes('passwd'));
    
    if (passwdFile) {
      // 检查文件名是否包含危险字符（/ 或 \）
      const hasDangerousChars = passwdFile.includes('/') || passwdFile.includes('\\');
      if (!hasDangerousChars) {
        console.log('  ✅ 文件名已清理（无路径穿越）');
        passed++;
      } else {
        console.log(`  ❌ 文件名未正确清理: ${passwdFile}`);
        failed++;
      }
    } else {
      console.log('  ❌ 未找到检查点文件');
      failed++;
    }
    
  } finally {
    cleanupTempDir(tempDir);
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

// ─── 主函数 ────────────────────────────────────────────────────────────────

async function main() {
  console.log('开始 CheckpointManager 单元测试...\n');
  console.log('='.repeat(70));
  
  let allPass = true;
  allPass = (await testCreateCheckpoint()) && allPass;
  allPass = (await testRecoverTask()) && allPass;
  allPass = (await testListCheckpoints()) && allPass;
  allPass = (await testErrorHandling()) && allPass;
  
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
