/**
 * =============================================================================
 * 5C RetryEngine — 重试引擎
 * =============================================================================
 *
 * ## 功能定位
 * 根据故障类型匹配重试策略，自动执行恢复动作（不只是等待重试，而是在重试前
 * 做点什么来增加成功率）。是 RecoveorOrchestrator 的执行臂。
 *
 * ## 核心概念
 *
 * ### 失败类别 → 策略映射
 * 每种失败有对应的重试策略，策略包含：
 * - maxRetries: 最多重试几次
 * - backoff: 退避算法 (fixed / linear / exponential)
 * - recoveryActions: 重试前执行的恢复动作列表
 * - fatal: 是否致命错误（true = 不重试，直接降级）
 *
 * ### 恢复动作 (RecoveryAction)
 * 每次重试前执行的一系列操作，比如：
 * - switch_model: 切换到备用模型
 * - truncate_context: 裁剪上下文
 * - kill_restart: 杀进程 + 从检查点恢复
 * - wait_reconnect: 等待模型重连
 * - reload_config: 重新加载配置
 * - disable_tool: 熔断失败的工具
 *
 * ### 退避算法
 * - fixed: 固定间隔
 * - linear: 线性增长 (baseMs * retry)
 * - exponential: 指数增长 (baseMs * 2^retry)，有上限 maxMs
 *
 * ## 使用方式
 * ```
 * const re = getRetryEngine();
 *
 * try {
 *   await doSomething();
 * } catch (err) {
 *   const failure = re.classify(err);
 *   const strategy = re.match(failure);
 *
 *   for (let i = 0; i < strategy.maxRetries; i++) {
 *     const delay = re.calcDelay(strategy, i);
 *     await sleep(delay);
 *
 *     for (const action of strategy.recoveryActions) {
 *       await executeAction(action);
 *     }
 *
 *     try { await doSomething(); break; }
 *     catch { continue; }
 *   }
 * }
 * ```
 *
 * ## 设计决策
 * - 策略字典：集中管理所有故障类别的策略，方便调优
 * - 恢复动作可组合：一次重试可以执行多个恢复动作
 * - 致命错误不重试：如 API key 无效等永久性错误
 * - 动作执行失败也记录：恢复动作自身也可能失败，需要记录
 */

import { logger } from './logger';

// --- 类型定义 ---

/** 故障类别 */
export type FailureType =
  | 'timeout'           // 请求超时
  | 'tool_fail'         // 工具执行失败
  | 'tool_timeout'      // 工具执行超时
  | 'model_unreachable' // 模型不可达（进程挂了）
  | 'model_crash'       // 模型崩溃（返回 500）
  | 'empty_loop'        // 空 tool_calls 死循环
  | 'context_overflow'  // 上下文溢出
  | 'rate_limit'        // 速率限制
  | 'auth_error'        // 认证失败（API key 无效等）
  | 'parse_error'       // 响应解析失败
  | 'network_error'     // 网络错误
  | 'unknown';          // 未知错误

/** 退避算法 */
export type BackoffAlgorithm = 'fixed' | 'linear' | 'exponential';

/** 恢复动作 */
export type RecoveryAction =
  | 'wait_reconnect'    // 等待模型重连（sleep 5s 后重试）
  | 'switch_model'      // 切换到备用模型
  | 'truncate_context'  // 裁剪上下文到最近 N 轮
  | 'kill_restart'      // 杀进程 + 从检查点恢复
  | 'reload_config'     // 重新加载配置
  | 'disable_tool'      // 熔断当前失败的工具
  | 'reset_session'     // 重置对话 session
  | 'retry_with_backoff'// 仅退避等待

/** 重试策略 */
export interface RetryStrategy {
  /** 策略名称（调试用） */
  name: string;
  /** 最大重试次数 */
  maxRetries: number;
  /** 退避算法 */
  backoff: BackoffAlgorithm;
  /** 基础间隔 (ms) */
  baseMs: number;
  /** 最大间隔 (ms)（仅 exponential 使用） */
  maxMs: number;
  /** 恢复动作列表（按顺序执行） */
  recoveryActions: RecoveryAction[];
  /** 是否为致命错误（true = 不重试，直接走降级） */
  fatal: boolean;
  /** 减少工具调用的标记（重试时是否简化为不带工具的对话） */
  noTools?: boolean;
}

/** 分类后的故障信息 */
export interface ClassifiedFailure {
  type: FailureType;
  message: string;
  originalError: unknown;
  context?: Record<string, unknown>;
}

/** 重试结果 */
export interface RetryResult {
  success: boolean;
  attempts: number;
  totalTimeMs: number;
  lastError?: string;
  actionsExecuted: RecoveryAction[];
}

// --- 策略字典 ---

const STRATEGIES: Record<FailureType, RetryStrategy> = {
  timeout: {
    name: 'timeout',
    maxRetries: 2,
    backoff: 'exponential',
    baseMs: 2000,
    maxMs: 30000,
    recoveryActions: ['retry_with_backoff'],
    fatal: false,
  },
  tool_fail: {
    name: 'tool_fail',
    maxRetries: 2,
    backoff: 'linear',
    baseMs: 1000,
    maxMs: 5000,
    recoveryActions: ['disable_tool'],
    fatal: false,
    noTools: false, // 工具失败了但模型正常，换策略不用这个工具即可
  },
  tool_timeout: {
    name: 'tool_timeout',
    maxRetries: 1,
    backoff: 'fixed',
    baseMs: 2000,
    maxMs: 2000,
    recoveryActions: ['disable_tool', 'kill_restart'],
    fatal: false,
  },
  model_unreachable: {
    name: 'model_unreachable',
    maxRetries: 3,
    backoff: 'exponential',
    baseMs: 3000,
    maxMs: 30000,
    recoveryActions: ['wait_reconnect', 'switch_model'],
    fatal: false,
  },
  model_crash: {
    name: 'model_crash',
    maxRetries: 2,
    backoff: 'exponential',
    baseMs: 5000,
    maxMs: 20000,
    recoveryActions: ['kill_restart', 'switch_model'],
    fatal: false,
  },
  empty_loop: {
    name: 'empty_loop',
    maxRetries: 1,
    backoff: 'fixed',
    baseMs: 1000,
    maxMs: 1000,
    recoveryActions: ['kill_restart', 'switch_model'], // 死循环先杀再换模型
    fatal: false,
  },
  context_overflow: {
    name: 'context_overflow',
    maxRetries: 2,
    backoff: 'fixed',
    baseMs: 1000,
    maxMs: 1000,
    recoveryActions: ['truncate_context'],
    fatal: false,
    noTools: true,
  },
  rate_limit: {
    name: 'rate_limit',
    maxRetries: 3,
    backoff: 'exponential',
    baseMs: 5000,
    maxMs: 60000,
    recoveryActions: ['wait_reconnect'],
    fatal: false,
  },
  auth_error: {
    name: 'auth_error',
    maxRetries: 0,       // 不重试
    backoff: 'fixed',
    baseMs: 0,
    maxMs: 0,
    recoveryActions: [],
    fatal: true,          // 致命：API key 无效
  },
  parse_error: {
    name: 'parse_error',
    maxRetries: 2,
    backoff: 'fixed',
    baseMs: 500,
    maxMs: 500,
    recoveryActions: ['reset_session'],
    fatal: false,
  },
  network_error: {
    name: 'network_error',
    maxRetries: 3,
    backoff: 'exponential',
    baseMs: 1000,
    maxMs: 15000,
    recoveryActions: ['wait_reconnect'],
    fatal: false,
  },
  unknown: {
    name: 'unknown',
    maxRetries: 2,
    backoff: 'exponential',
    baseMs: 2000,
    maxMs: 10000,
    recoveryActions: ['retry_with_backoff'],
    fatal: false,
  },
};

/** 动作中文名（日志用） */
const ACTION_LABELS: Record<RecoveryAction, string> = {
  wait_reconnect: '等待重连',
  switch_model: '切换模型',
  truncate_context: '裁剪上下文',
  kill_restart: '杀进程重启',
  reload_config: '重载配置',
  disable_tool: '禁用工具',
  reset_session: '重置会话',
  retry_with_backoff: '退避等待',
};

// --- 主类 ---

export class RetryEngine {
  private strategies: Record<string, RetryStrategy>;

  constructor(customStrategies?: Partial<Record<FailureType, Partial<RetryStrategy>>>) {
    // 深拷贝默认策略
    this.strategies = JSON.parse(JSON.stringify(STRATEGIES));

    // 合并自定义策略
    if (customStrategies) {
      for (const [key, override] of Object.entries(customStrategies)) {
        if (this.strategies[key]) {
          Object.assign(this.strategies[key], override);
        }
      }
    }
  }

  // ===== 故障分类 =====

  /**
   * 从原始错误中推断故障类别。
   * 支持多种输入格式：Error 对象、字符串、Axios 错误、fetch 错误等。
   */
  classify(error: unknown): ClassifiedFailure {
    const msg = this.extractMessage(error);
    const lower = msg.toLowerCase();

    // 按优先级匹配
    if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
      return { type: 'auth_error', message: msg, originalError: error };
    }
    if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
      return { type: 'rate_limit', message: msg, originalError: error };
    }
    if (lower.includes('context length') || lower.includes('maximum context') ||
        lower.includes('token limit') || lower.includes('too long')) {
      return { type: 'context_overflow', message: msg, originalError: error };
    }
    if (lower.includes('econnrefused') || lower.includes('connection refused') ||
        lower.includes('connect error') || lower.includes('fetch failed')) {
      return { type: 'model_unreachable', message: msg, originalError: error };
    }
    if (lower.includes('econnreset') || lower.includes('enetunreach') ||
        lower.includes('enotfound') || lower.includes('dns')) {
      return { type: 'network_error', message: msg, originalError: error };
    }
    if (lower.includes('500') || lower.includes('internal server error') ||
        lower.includes('503') || lower.includes('service unavailable')) {
      return { type: 'model_crash', message: msg, originalError: error };
    }
    if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) {
      return { type: 'timeout', message: msg, originalError: error };
    }

    // 从 HealthMonitor 事件转发过来的
    if (lower.includes('dead_loop') || lower.includes('空循环') || lower.includes('empty loop')) {
      return { type: 'empty_loop', message: msg, originalError: error };
    }
    if (lower.includes('tool_timeout') || lower.includes('tool timeout')) {
      return { type: 'tool_timeout', message: msg, originalError: error };
    }
    if (lower.includes('tool_fail') || lower.includes('tool fail')) {
      return { type: 'tool_fail', message: msg, originalError: error };
    }
    if (lower.includes('parse') || lower.includes('json') || lower.includes('unexpected token')) {
      return { type: 'parse_error', message: msg, originalError: error };
    }

    return { type: 'unknown', message: msg, originalError: error };
  }

  // ===== 策略匹配 =====

  /** 获取对应故障类别的重试策略 */
  match(failure: ClassifiedFailure): RetryStrategy {
    return this.strategies[failure.type] ?? this.strategies.unknown;
  }

  /** 根据故障信息直接返回策略（快捷方式） */
  matchError(error: unknown): RetryStrategy {
    return this.match(this.classify(error));
  }

  // ===== 退避计算 =====

  /** 计算第 N 次重试应等待的毫秒数 */
  calcDelay(strategy: RetryStrategy, retryIndex: number): number {
    switch (strategy.backoff) {
      case 'fixed':
        return strategy.baseMs;
      case 'linear':
        return strategy.baseMs * (retryIndex + 1);
      case 'exponential': {
        const delay = strategy.baseMs * Math.pow(2, retryIndex);
        return Math.min(delay, strategy.maxMs);
      }
      default:
        return strategy.baseMs;
    }
  }

  // ===== 动作说明 =====

  /** 获取恢复动作的中文描述 */
  actionLabel(action: RecoveryAction): string {
    return ACTION_LABELS[action] ?? action;
  }

  /** 是否致命错误（不应重试） */
  isFatal(failure: ClassifiedFailure): boolean {
    return this.match(failure).fatal;
  }

  // ===== 状态 =====

  /** 列出所有策略（调试用） */
  listStrategies(): Array<{ type: string; name: string; maxRetries: number; fatal: boolean }> {
    return Object.entries(this.strategies).map(([type, s]) => ({
      type,
      name: s.name,
      maxRetries: s.maxRetries,
      fatal: s.fatal,
    }));
  }

  private extractMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) {
      return String((error as Record<string, unknown>).message);
    }
    return String(error);
  }
}

// 单例
let _instance: RetryEngine | null = null;
export function getRetryEngine(): RetryEngine {
  if (!_instance) _instance = new RetryEngine();
  return _instance;
}
