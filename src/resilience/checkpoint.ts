/**
 * =============================================================================
 * 5B CheckpointManager — 任务级检查点管理器
 * =============================================================================
 *
 * ## 功能定位
 * 在任务执行的每一步完成后自动保存检查点。系统重启或任务崩溃时，可以从
 * 最近的检查点恢复，跳过已完成步骤，只执行剩余步骤。
 *
 * 与 Phase 1C ProjectManager 的区别：
 * - ProjectManager 是「项目级」：跟踪整个项目的 TODO 和进度
 * - CheckpointManager 是「步骤级」：跟踪单个任务 DAG 里的每一步
 * - 两者互补：ProjectManager 管"做什么"，CheckpointManager 管"做到哪了"
 *
 * ## 核心概念
 *
 * ### 检查点 (TaskCheckpoint)
 * 包含任务 DAG 的完整快照：
 * - 哪些步骤已完成（含执行结果）
 * - 哪些步骤待执行
 * - 关键上下文消息（用于恢复时重建对话状态）
 * - 已重试次数和故障历史（用于避免无限重试）
 *
 * ### 恢复流程
 * 1. 系统启动时，调用 recoverPendingTasks() 扫描未完成任务
 * 2. 对每个未完成任务，加载最后一个检查点
 * 3. 重建已完成步骤的上下文
 * 4. 从 pendingSteps[0] 继续执行
 * 5. 如果恢复也失败 → 通知用户，保留现场
 *
 * ## 存储策略
 * - 存储目录：data/checkpoints/{taskId}.json
 * - 格式：JSON（人类可读，方便调试和手动修复）
 * - 每个任务只保留最新检查点（覆盖写），不保留历史版本
 *   （如需要回退多个版本，由外部版本控制系统处理）
 *
 * ## 使用方式
 * ```
 * const ckm = getCheckpointManager();
 *
 * // 任务开始时注册
 * ckm.registerTask(taskId);
 *
 * // 每个步骤完成后保存
 * ckm.save(taskId, completedSteps, pendingSteps, messages);
 *
 * // 崩溃后恢复
 * const cp = ckm.load(taskId);
 * if (cp) { /* 从 cp.pendingSteps 继续 *\/ }
 *
 * // 任务完成时清理
 * ckm.complete(taskId);
 * ```
 *
 * ## 设计决策
 * - 单文件 JSON：简单可靠，无需引入新依赖
 * - 只保留最新检查点：减少磁盘占用，避免版本管理复杂度
 * - 上下文裁剪：保存时自动裁剪 messages 到最近 20 轮（防止检查点过大）
 * - 故障历史记录：保留所有故障事件，帮助诊断和避免重复走已失败的恢复路径
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SubTask, TaskDAG } from '../core/task-decomposer';
import type { ChatMessage } from '../models/adapters/lmstudio';
import logger from '../logger';
import { getConfigSection } from '../config/agent-system-config';

// --- 类型定义 ---

/** 故障记录 */
export interface FailureRecord {
  timestamp: Date;
  type: string;
  message: string;
  stepIndex: number;
  recovered: boolean;
}

/** 任务检查点 */
export interface TaskCheckpoint {
  taskId: string;
  originalRequest: string;
  /** 当前执行到第几步（0-based, 指向 pendingSteps[0]） */
  stepIndex: number;
  /** 已完成步骤（含结果） */
  completedSteps: CompletedStep[];
  /** 待执行步骤 */
  pendingSteps: SubTask[];
  /** 关键上下文消息（用于恢复对话状态） */
  context: ChatMessage[];
  /** 已重试次数（整个任务级别） */
  retryCount: number;
  /** 本次任务中所有故障记录 */
  failures: FailureRecord[];
  /** 检查点创建时间 */
  timestamp: string;
  /** 检查点迭代版本 */
  version: number;
}

/** 已完成的步骤（含执行结果） */
export interface CompletedStep {
  step: SubTask;
  result: { success: boolean; output: string; error?: string };
  completedAt: string;
}

// --- 配置 ---

export interface CheckpointConfig {
  /** 存储目录 */
  dataDir: string;
  /** 上下文消息保留最近 N 轮 */
  contextWindow: number;
  /** 最大恢复次数 */
  maxRecoveryAttempts: number;
}

const DEFAULT_CONFIG: CheckpointConfig = {
  dataDir: path.join(process.cwd(), 'data', 'checkpoints'),
  contextWindow: 20,
  maxRecoveryAttempts: 3,
};

// --- 主类 ---

export class CheckpointManager {
  public config: CheckpointConfig;

  constructor(config?: Partial<CheckpointConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDir();
  }

  /** 确保存储目录存在 */
  private ensureDir(): void {
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
  }

  /** 获取检查点文件路径 */
  private filePath(taskId: string): string {
    return path.join(this.config.dataDir, sanitizeFileName(taskId) + '.json');
  }

  // ===== 注册 / 保存 / 加载 / 完成 =====

  /** 注册一个新任务（创建初始检查点） */
  registerTask(taskId: string, request: string, pendingSteps: SubTask[]): TaskCheckpoint {
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
    logger.info('[Ckpt] Task registered: ' + taskId + ' (' + pendingSteps.length + ' steps)');
    return cp;
  }

  /** 保存检查点：完成了一个步骤 */
  save(
    taskId: string,
    completedStep: CompletedStep,
    remainingSteps: SubTask[],
    messages: ChatMessage[],
    stepIndex?: number,
  ): TaskCheckpoint {
    const existing = this.load(taskId);
    const completedSteps = existing
      ? [...existing.completedSteps, completedStep]
      : [completedStep];

    // 裁剪上下文到最近 N 轮
    const context = messages.slice(-this.config.contextWindow);

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
    logger.debug('[Ckpt] Saved checkpoint v' + cp.version + ' step ' + cp.stepIndex + '/' +
      (cp.completedSteps.length + cp.pendingSteps.length));
    return cp;
  }

  /** 加载检查点 */
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
      logger.error('[Ckpt] Failed to load checkpoint: ' + file + ' — ' + err);
      return null;
    }
  }

  /** 任务完成，删除检查点 */
  complete(taskId: string): void {
    const file = this.filePath(taskId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      logger.info('[Ckpt] Task completed, checkpoint removed: ' + taskId);
    }
  }

  // ===== 恢复相关 =====

  /** 恢复一个未完成的任务（从上次检查点开始） */
  resume(taskId: string): { checkpoint: TaskCheckpoint; canResume: boolean; reason?: string } | null {
    const cp = this.load(taskId);
    if (!cp) return null;

    // 检查是否超过最大恢复次数
    if (cp.retryCount >= this.config.maxRecoveryAttempts) {
      const reason = `已达到最大恢复次数 (${cp.retryCount}/${this.config.maxRecoveryAttempts})`;
      logger.error('[Ckpt] Cannot resume ' + taskId + ': ' + reason);
      return { checkpoint: cp, canResume: false, reason };
    }

    // 无待执行步骤 = 已完成
    if (cp.pendingSteps.length === 0) {
      return { checkpoint: cp, canResume: false, reason: '所有步骤已完成' };
    }

    return { checkpoint: cp, canResume: true };
  }

  /** 记录故障并递增重试次数 */
  recordFailure(
    taskId: string,
    failure: Omit<FailureRecord, 'timestamp'>,
  ): TaskCheckpoint | null {
    const cp = this.load(taskId);
    if (!cp) return null;

    cp.failures.push({ ...failure, timestamp: new Date() });
    cp.retryCount++;
    cp.timestamp = new Date().toISOString();
    cp.version++;
    this.write(cp);
    return cp;
  }

  /** 更新上下文字段（不改步骤） */
  updateContext(taskId: string, messages: ChatMessage[]): void {
    const cp = this.load(taskId);
    if (!cp) return;
    cp.context = messages.slice(-this.config.contextWindow);
    cp.timestamp = new Date().toISOString();
    this.write(cp);
  }

  /** 列出所有待恢复的任务 ID */
  listPendingTasks(): string[] {
    this.ensureDir();
    const files = fs.readdirSync(this.config.dataDir).filter(f => f.endsWith('.json'));
    const tasks: string[] = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(this.config.dataDir, f), 'utf-8');
        const cp: TaskCheckpoint = JSON.parse(raw);
        if (cp.pendingSteps && cp.pendingSteps.length > 0) {
          tasks.push(cp.taskId);
        }
      } catch { /* skip corrupted files */ }
    }
    return tasks;
  }

  /** 清空所有旧检查点（用于新会话开始时清理陈旧数据） */
  clearAll(): void {
    this.ensureDir();
    const files = fs.readdirSync(this.config.dataDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(this.config.dataDir, f));
      } catch { /* skip */ }
    }
    logger.info(`[Ckpt] 清理 ${files.length} 个旧检查点`);
  }

  /** 获取恢复摘要（供启动时显示） */
  recoverySummary(): string {
    const tasks = this.listPendingTasks();
    if (tasks.length === 0) return '无待恢复任务';

    const lines: string[] = [];
    for (const tid of tasks) {
      const cp = this.load(tid);
      if (!cp) continue;
      const done = cp.completedSteps.length;
      const total = done + cp.pendingSteps.length;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      lines.push(`  • ${cp.originalRequest.slice(0, 50)} [${done}/${total} ${pct}%] 重试${cp.retryCount}次`);
    }
    return '📋 待恢复任务 (' + tasks.length + '):\n' + lines.join('\n');
  }

  // ===== 内部 =====

  private write(cp: TaskCheckpoint): void {
    this.ensureDir();
    const file = this.filePath(cp.taskId);
    fs.writeFileSync(file, JSON.stringify(cp, null, 2), 'utf-8');
  }
}

// --- 工具函数 ---

/** (内部) 清理文件名，防止路径注入 */
function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 120);
}

// 单例
let _instance: CheckpointManager | null = null;
export function getCheckpointManager(): CheckpointManager {
  if (!_instance) {
    const cpCfg = (() => { try { return getConfigSection('checkpoint'); } catch { return null; } })();
    const config = cpCfg ? {
      dataDir: cpCfg.dataDir,
      contextWindow: cpCfg.contextWindow,
      maxRecoveryAttempts: cpCfg.maxRecoveryAttempts,
    } : undefined;
    _instance = new CheckpointManager(config);
  }
  return _instance;
}
