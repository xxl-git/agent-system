// 审计日志 — 记录所有决策/工具调用/错误/会话边界
// Phase 5 P1: 决策追溯基础
import { existsSync, statSync, renameSync, appendFileSync, readFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import logger from '../logger';

// ─── 审计事件类型 ───

export interface AuditEvent {
  timestamp: string;
  sessionId: string;
  category: AuditCategory;
  action: string;
  target: string;
  params: Record<string, any>;
  result: AuditResult;
  meta: AuditMeta;
}

export type AuditCategory = 
  | 'session'      // 会话启停
  | 'tool_call'    // 工具调用
  | 'decision'     // 决策（路由/切换/降级）
  | 'model_switch' // 模型切换
  | 'recovery'     // 恢复动作
  | 'degradation'  // 降级动作
  | 'checkpoint'   // 检查点操作
  | 'error';       // 错误

export type AuditResult = 
  | 'success' 
  | 'failure' 
  | 'pending' 
  | 'degraded' 
  | 'recovered';

export interface AuditMeta {
  durationMs?: number;
  retryCount?: number;
  errorMessage?: string;
  recoveryAction?: string;
  modelBefore?: string;
  modelAfter?: string;
  [key: string]: any;
}

export interface AuditConfig {
  logDir: string;
  maxLogSize: number;      // 单文件最大字节数
  rotateCount: number;     // 保留的日志文件数
  captureToolResults: boolean; // 是否记录工具返回内容
}

export interface AuditQuery {
  category?: AuditCategory | AuditCategory[];
  result?: AuditResult | AuditResult[];
  sessionId?: string;
  since?: string;          // ISO 时间
  until?: string;
  keyword?: string;
  limit?: number;
}

const DEFAULT_CONFIG: AuditConfig = {
  logDir: path.join(process.cwd(), 'audit'),
  maxLogSize: 5 * 1024 * 1024, // 5MB
  rotateCount: 5,
  captureToolResults: true,
};

export class AuditLog {
  private config: AuditConfig;
  private sessionId: string = '';
  private eventCount = 0;

  constructor(config?: Partial<AuditConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  // ─── 会话管理 ───

  startSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.log('session', 'start', 'agent', {}, 'success', {});
  }

  endSession(summary?: string): void {
    this.log('session', 'end', 'agent', {}, 'success', { summary });
  }

  // ─── 记录日志 ───

  log(
    category: AuditCategory,
    action: string,
    target: string,
    params: Record<string, any>,
    result: AuditResult,
    meta: AuditMeta = {},
  ): AuditEvent {
    this.eventCount++;
    this.maybeRotate();

    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      category,
      action,
      target,
      params: this.sanitizeParams(params),
      result,
      meta,
    };

    // 追加写入
    const line = JSON.stringify(event) + '\n';
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.config.logDir, `audit-${today}.log`);
    appendFileSync(logFile, line, 'utf-8');

    // 同步 logger
    const isError = result === 'failure' || result === 'degraded';
    if (isError) {
      logger.warn(`[Audit] ${category}/${action}: ${meta.errorMessage ?? 'unknown'} (${meta.durationMs ?? '?'}ms)`);
    } else {
      logger.debug(`[Audit] ${category}/${action}: ${result} (${meta.durationMs ?? '?'}ms)`);
    }

    return event;
  }

  // ─── 便捷方法 ───

  /** 记录工具调用 */
  logToolCall(tool: string, params: Record<string, any>, result: AuditResult, durationMs: number, error?: string): AuditEvent {
    return this.log('tool_call', 'execute', tool, params, result, {
      durationMs,
      errorMessage: error,
    });
  }

  /** 记录决策 */
  logDecision(decisionType: string, detail: string, result: AuditResult, meta: AuditMeta = {}): AuditEvent {
    return this.log('decision', decisionType, detail, {}, result, meta);
  }

  /** 记录模型切换 */
  logModelSwitch(from: string, to: string, reason: string): AuditEvent {
    return this.log('model_switch', 'switch', to, { from, reason }, 'success', {
      modelBefore: from,
      modelAfter: to,
    });
  }

  /** 记录恢复动作 */
  logRecovery(action: string, target: string, result: AuditResult, durationMs: number, error?: string): AuditEvent {
    return this.log('recovery', action, target, {}, result, {
      durationMs,
      errorMessage: error,
    });
  }

  /** 记录降级 */
  logDegradation(level: number, reason: string, from: string, to: string): AuditEvent {
    return this.log('degradation', `level_${level}`, from, { reason, to }, 'degraded', {});
  }

  /** 记录检查点 */
  logCheckpoint(action: string, taskId: string, result: AuditResult): AuditEvent {
    return this.log('checkpoint', action, taskId, {}, result, {});
  }

  /** 记录错误 */
  logError(source: string, error: string, params: Record<string, any> = {}): AuditEvent {
    return this.log('error', 'exception', source, params, 'failure', {
      errorMessage: error,
    });
  }

  // ─── 查询 ───

  query(q: AuditQuery): AuditEvent[] {
    const events: AuditEvent[] = [];
    const limit = q.limit ?? 100;

    // 读取最近几天的日志文件
    const files = this.getRecentLogFiles(7);
    for (const file of files) {
      if (events.length >= limit) break;
      if (!existsSync(file)) continue;

      try {
        const lines = readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
        for (const line of lines.reverse()) { // 从最新开始
          if (events.length >= limit) break;
          try {
            const event: AuditEvent = JSON.parse(line);
            if (this.matchesQuery(event, q)) {
              events.push(event);
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    return events;
  }

  /** 获取会话审计摘要 */
  getSessionSummary(sessionId?: string): string {
    const events = this.query({ sessionId: sessionId ?? this.sessionId, limit: 500 });

    const byCategory: Record<string, number> = {};
    let successCount = 0, failureCount = 0, degradedCount = 0;
    let totalDuration = 0, durationCount = 0;

    for (const e of events) {
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
      if (e.result === 'success') successCount++;
      else if (e.result === 'failure') failureCount++;
      else if (e.result === 'degraded') degradedCount++;
      if (e.meta.durationMs) {
        totalDuration += e.meta.durationMs;
        durationCount++;
      }
    }

    const lines = [
      `📊 审计摘要 (${events.length} events)`,
      `  ✅ success: ${successCount}  ❌ failure: ${failureCount}  ⚠️ degraded: ${degradedCount}`,
    ];

    if (durationCount > 0) {
      lines.push(`  ⏱️  avg: ${Math.round(totalDuration / durationCount)}ms (${durationCount} ops)`);
    }

    const cats = Object.entries(byCategory);
    if (cats.length > 0) {
      lines.push(`  📂 ${cats.map(([k, v]) => `${k}(${v})`).join(', ')}`);
    }

    return lines.join('\n');
  }

  // ─── 统计 ───

  getEventCount(): number { return this.eventCount; }

  // ─── 内部 ───

  private sanitizeParams(params: Record<string, any>): Record<string, any> {
    // 截断长字符串
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' && v.length > 500) {
        result[k] = v.slice(0, 497) + '...';
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  private maybeRotate(): void {
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.config.logDir, `audit-${today}.log`);

    if (existsSync(logFile)) {
      const stat = statSync(logFile);
      if (stat.size > this.config.maxLogSize) {
        // 重命名为 .1, .2 等
        for (let i = this.config.rotateCount - 1; i >= 1; i--) {
          const old = path.join(this.config.logDir, `audit-${today}.${i}.log`);
          const newer = path.join(this.config.logDir, `audit-${today}.${i - 1}.log`);
          if (existsSync(newer)) {
            renameSync(newer, old);
          }
        }
        renameSync(
          logFile,
          path.join(this.config.logDir, `audit-${today}.0.log`)
        );
      }
    }
  }

  private getRecentLogFiles(days: number): string[] {
    const files: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().split('T')[0];
      const base = path.join(this.config.logDir, `audit-${date}.log`);
      files.push(base);
      // 也检查轮转文件
      for (let j = 0; j < this.config.rotateCount; j++) {
        files.push(path.join(this.config.logDir, `audit-${date}.${j}.log`));
      }
    }
    return files;
  }

  private matchesQuery(event: AuditEvent, q: AuditQuery): boolean {
    if (q.category) {
      const cats = Array.isArray(q.category) ? q.category : [q.category];
      if (!cats.includes(event.category)) return false;
    }
    if (q.result) {
      const results = Array.isArray(q.result) ? q.result : [q.result];
      if (!results.includes(event.result)) return false;
    }
    if (q.sessionId && event.sessionId !== q.sessionId) return false;
    if (q.since && event.timestamp < q.since) return false;
    if (q.until && event.timestamp > q.until) return false;
    if (q.keyword) {
      const json = JSON.stringify(event).toLowerCase();
      if (!json.includes(q.keyword.toLowerCase())) return false;
    }
    return true;
  }
}

// 全局单例
let instance: AuditLog | null = null;

export function getAuditLog(config?: Partial<AuditConfig>): AuditLog {
  if (!instance || config) {
    instance = new AuditLog(config);
  }
  return instance;
}
