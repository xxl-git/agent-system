// 空闲任务管理器 — 心跳期间自动处理带优先级的待办任务
// 职责：优先队列 · 执行日志 · 并发控制 · 定时统计
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';



/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type IdleTaskPriority = 'P0' | 'P1' | 'P2';

export interface IdleTask {
  id: string;
  name: string;
  description: string;
  priority: IdleTaskPriority;
  /** 每次心跳最多执行一次的 throttle */
  cooldownMs: number;
  lastRun: number;
  /** true = 任务正在执行中 */
  running: boolean;
  /** 执行函数，返回 true 表示任务完成，false 表示需要保留在队列中 */
  execute: () => Promise<boolean>;
  /** 创建时间 */
  createdAt: number;
  /** 失败次数 */
  failCount: number;
  /** 最大失败次数后自动移除 */
  maxFails: number;
}

export interface IdleTaskLogEntry {
  taskId: string;
  taskName: string;
  timestamp: string;
  durationMs: number;
  success: boolean;
  result: string;
  priority: IdleTaskPriority;
}

export class IdleTaskManager {
  private tasks: IdleTask[] = [];
  private logFile: string;
  private logEntries: IdleTaskLogEntry[] = [];
  private processing = false;
  private stats = { executed: 0, succeeded: 0, failed: 0, skipped: 0 };

  constructor(logDir?: string) {
    const dir = logDir || path.join(process.cwd(), 'data', 'idle-logs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.logFile = path.join(dir, 'idle-execution-log.jsonl');
    // 加载历史日志（只保留最近 1000 条）
    try {
      if (fs.existsSync(this.logFile)) {
        const lines = fs.readFileSync(this.logFile, 'utf-8').trim().split('\n');
        this.logEntries = lines.slice(-1000).map(l => JSON.parse(l));
      }
    } catch {
      this.logEntries = [];
    }
  }

  /** 注册空闲任务 */
  register(task: IdleTask): void {
    const existing = this.tasks.find(t => t.id === task.id);
    if (existing) {
      existing.priority = task.priority;
      existing.execute = task.execute;
      existing.description = task.description;
      existing.cooldownMs = task.cooldownMs;
      return;
    }
    this.tasks.push(task);
    this.tasks.sort(this.prioritySort);
    logger.debug(`[IdleTask] 注册: ${task.name} (${task.priority})`);
  }

  /** 移除空闲任务 */
  unregister(id: string): void {
    this.tasks = this.tasks.filter(t => t.id !== id);
  }

  /** 心跳触发的处理入口 — 按优先级依次执行空闲任务 */
  async processAll(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    const now = Date.now();

    try {
      // 按优先级排序并过滤冷却中的任务
      const ready = this.tasks
        .filter(t => !t.running && (now - t.lastRun >= t.cooldownMs))
        .sort(this.prioritySort);

      if (ready.length === 0) {
        this.processing = false;
        return;
      }

      for (const task of ready) {
        if (this.isCooldown(task, now)) {
          this.stats.skipped++;
          continue;
        }
        task.running = true;
        const t0 = Date.now();
        let success = false;
        let result = '';

        try {
          const done = await task.execute();
          success = done;
          result = done ? '完成' : '需继续执行';
          task.lastRun = now;
          if (done) {
            this.tasks = this.tasks.filter(t => t.id !== task.id);
            logger.info(`[IdleTask] ✅ ${task.name} 完成`);
          }
        } catch (err: unknown) {
          success = false;
          result = `错误: ${errorMessage(err)}`;
          task.failCount++;
          task.lastRun = now;
          logger.warn(`[IdleTask] ❌ ${task.name} 失败 (${task.failCount}/${task.maxFails}): ${errorMessage(err)}`);

          if (task.failCount >= task.maxFails) {
            this.tasks = this.tasks.filter(t => t.id !== task.id);
            logger.warn(`[IdleTask] 🗑️ ${task.name} 已达最大失败次数，已移除`);
          }
        } finally {
          task.running = false;
          const duration = Date.now() - t0;
          this.stats.executed++;
          if (success) this.stats.succeeded++;
          else this.stats.failed++;

          this.logExecution({
            taskId: task.id,
            taskName: task.name,
            timestamp: new Date().toISOString(),
            durationMs: duration,
            success,
            result,
            priority: task.priority,
          });
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** 获取等待执行的任务（按优先级排序） */
  getPendingTasks(): { id: string; name: string; priority: IdleTaskPriority; description: string }[] {
    return this.tasks
      .filter(t => !t.running)
      .sort(this.prioritySort)
      .map(t => ({ id: t.id, name: t.name, priority: t.priority, description: t.description }));
  }

  /** 获取执行统计 */
  getStats(): { executed: number; succeeded: number; failed: number; skipped: number; pending: number } {
    return {
      ...this.stats,
      pending: this.tasks.filter(t => !t.running).length,
    };
  }

  /** 获取最近执行日志 */
  getRecentLogs(count: number = 20): IdleTaskLogEntry[] {
    return this.logEntries.slice(-count);
  }

  /** 持久化执行日志 */
  flushLogs(): void {
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 只持久化未写入的部分（最近 100 条）
      const recent = this.logEntries.slice(-100);
      fs.writeFileSync(this.logFile, recent.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    } catch (err) {
      logger.warn(`[IdleTask] 日志写入失败: ${err}`);
    }
  }

  private prioritySort(a: IdleTask, b: IdleTask): number {
    const pMap: Record<IdleTaskPriority, number> = { P0: 0, P1: 1, P2: 2 };
    const diff = pMap[a.priority] - pMap[b.priority];
    if (diff !== 0) return diff;
    return a.createdAt - b.createdAt; // 同优先级按创建时间
  }

  private isCooldown(task: IdleTask, now: number): boolean {
    return (now - task.lastRun) < task.cooldownMs;
  }

  private logExecution(entry: IdleTaskLogEntry): void {
    this.logEntries.push(entry);
    // 保持日志在合理大小
    if (this.logEntries.length > 10000) {
      this.logEntries = this.logEntries.slice(-5000);
    }
    this.flushLogs();
  }
}

// 单例
let instance: IdleTaskManager | null = null;

export function getIdleTaskManager(logDir?: string): IdleTaskManager {
  if (!instance) instance = new IdleTaskManager(logDir);
  return instance;
}
