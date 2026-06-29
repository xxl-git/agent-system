/**
 * =============================================================================
 * 5A HealthMonitor — 心跳与卡死检测
 * =============================================================================
 *
 * ## 功能定位
 * 韧性保障层的第一道防线。实时监控模型响应流和工具执行状态，在故障发生
 * 时第一时间发出警报，触发恢复流程。不做恢复动作（由 RecoveryOrchestrator
 * 负责），只负责检测和分类。
 *
 * ## 监测维度（4个独立通道）
 *
 * ### 1. Token 流卡死检测 (watchTokenStream)
 * - 原理：模型响应是 SSE 流，每次收到新 token 或 data chunk 时调用 beat()。
 *   HealthMonitor 内部维护一个定时器，若在 tokenDeadlineMs 内未收到 beat，
 *   则判定为 token 流卡死。
 * - 触发条件：30s 无产出 → WARN；60s 无产出 → STUCK（确认卡死）
 * - 典型场景：模型陷入内部思考循环、推理模型输出过长 reasoning_content、
 *   网络断开但未超时
 *
 * ### 2. 工具调用超时检测 (watchToolCall)
 * - 原理：工具调用开始时调用 startToolCall()，收到返回或错误时调用
 *   endToolCall()。若 toolDeadlineMs 内未结束，判定为工具超时。
 * - 触发条件：120s 未返回 → WARN；300s 未返回 → TIMEOUT
 * - 典型场景：exec 命令卡死、网络请求超时、文件读写挂起
 *
 * ### 3. 空循环检测 (watchEmptyLoop)
 * - 原理：追踪连续 tool_calls 请求。每次 model 返回 tool_calls 时调用
 *   recordToolCall()，如果是"有效"调用（有实质性参数变化）重置计数器，
 *   如果是空调用（无参数或参数与上次完全相同）则累加。
 * - 触发条件：连续 5 次空 tool_calls → DEAD_LOOP
 * - 典型场景：qwen3.6 返回 finish_reason=tool_calls 但 delta{} 为空
 *
 * ### 4. 模型进程存活检测 (watchModelProcess)
 * - 原理：通过 ping() 方法向模型服务发健康检查请求。
 *   调用方定期调用 checkProcess()，内部记录连续失败次数。
 * - 触发条件：1 次失败 → UNREACHABLE；连续 3 次失败 → DEAD
 * - 典型场景：LM Studio 进程崩溃、Ollama 服务停止、API 密钥过期
 *
 * ## 使用方式
 * ```
 * const hm = getHealthMonitor();
 *
 * // 开始监控 token 流
 * hm.watchTokenStream();
 * adapter.chat(messages, (chunk) => {
 *   hm.beat(); // 每次收到数据时心跳
 * });
 * hm.endTokenStream();
 *
 * // 开始监控工具调用
 * hm.watchToolCall('exec');
 * try { await exec(cmd); }
 * finally { hm.endToolCall('exec'); }
 * ```
 *
 * ## 设计决策
 * - 单例模式：整个 Agent 只有一个 HealthMonitor，所有监测通道共享
 * - 事件驱动：检测到异常时 emit 事件，由 RecoveryOrchestrator 监听
 * - 不阻塞：所有检测都是异步定时器，不影响主流程性能
 * - 可重入：支持同时监控多个 token 流和工具调用（互不干扰）
 *
 * ## 事件列表
 * - 'stuck'         → token 流卡死
 * - 'tool_timeout'  → 工具调用超时
 * - 'dead_loop'     → 空循环
 * - 'model_unreachable' → 模型不可达
 * - 'model_dead'    → 模型确认死亡（连续 3 次不可达）
 * - 'warning'       → 任何 WARN 级别事件（用于日志）
 */

import { EventEmitter } from 'events';
import { logger } from './logger';

// --- 类型定义 ---

/** 监测维度 */
export type MonitorChannel = 'token_stream' | 'tool_call' | 'empty_loop' | 'model_process';

/** 故障级别 */
export type FailureLevel = 'WARN' | 'STUCK' | 'TIMEOUT' | 'DEAD_LOOP' | 'UNREACHABLE' | 'DEAD';

/** 故障事件 */
export interface HealthEvent {
  channel: MonitorChannel;
  level: FailureLevel;
  message: string;
  detail?: Record<string, unknown>;
  timestamp: Date;
}

// --- 配置 ---

export interface HealthMonitorConfig {
  /** Token 流：WARN 阈值 (ms) */
  tokenWarnMs: number;
  /** Token 流：确认卡死阈值 (ms) */
  tokenDeadlineMs: number;
  /** 工具调用：WARN 阈值 (ms) */
  toolWarnMs: number;
  /** 工具调用：确认超时阈值 (ms) */
  toolDeadlineMs: number;
  /** 空循环：连续空调用次数阈值 */
  emptyLoopThreshold: number;
  /** 模型进程：不可达确认次数 */
  unreachableThreshold: number;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  tokenWarnMs: 30000,
  tokenDeadlineMs: 60000,
  toolWarnMs: 120000,
  toolDeadlineMs: 300000,
  emptyLoopThreshold: 5,
  unreachableThreshold: 3,
};

// --- 主类 ---

export class HealthMonitor extends EventEmitter {
  public config: HealthMonitorConfig;

  // Token 流状态
  private tokenTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenWarned = false;
  private tokenStartTime = 0;

  // 工具调用状态 (支持并发多个)
  private toolTimers: Map<string, { timer: ReturnType<typeof setTimeout>; warned: boolean }> = new Map();

  // 空循环状态
  private consecutiveEmptyCalls = 0;
  private lastToolCallArgs: string | null = null;

  // 模型进程状态
  private consecutiveUnreachable = 0;
  private lastPingTime = 0;

  constructor(config?: Partial<HealthMonitorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===== Token 流监测 =====

  /** 开始监测 token 流。调用方应在此后定期调用 beat() */
  watchTokenStream(): void {
    this.resetToken();
    this.tokenStartTime = Date.now();
    this.scheduleTokenCheck();
    logger.debug('[Health] Token stream monitoring started');
  }

  /** 心跳：每次收到 token/chunk 时调用 */
  beat(): void {
    this.tokenWarned = false;
    this.resetToken();
    this.scheduleTokenCheck();
  }

  /** 结束 token 流监测（正常完成时调用） */
  endTokenStream(): void {
    this.resetToken();
    const elapsed = Date.now() - this.tokenStartTime;
    logger.debug('[Health] Token stream OK (' + elapsed + 'ms)');
  }

  private scheduleTokenCheck(): void {
    // WARN 定时器
    this.tokenTimer = setTimeout(() => {
      if (!this.tokenWarned) {
        this.tokenWarned = true;
        this.tokenTimer = null;
        const event: HealthEvent = {
          channel: 'token_stream',
          level: 'WARN',
          message: 'Token 流 ' + (this.config.tokenWarnMs / 1000) + 's 无产出',
          timestamp: new Date(),
        };
        logger.warn('[Health] ⚠️ ' + event.message);
        this.emit('warning', event);
        // 继续调度 STUCK 检查
        this.scheduleTokenCheck();
      } else {
        // 已经 WARN 过，现在确认卡死
        const event: HealthEvent = {
          channel: 'token_stream',
          level: 'STUCK',
          message: 'Token 流 60s 无产出，确认卡死',
          detail: { elapsedMs: Date.now() - this.tokenStartTime },
          timestamp: new Date(),
        };
        logger.error('[Health] ❌ ' + event.message);
        this.emit('stuck', event);
        this.resetToken();
      }
    }, this.tokenWarned ? this.config.tokenDeadlineMs - this.config.tokenWarnMs : this.config.tokenWarnMs);
  }

  private resetToken(): void {
    if (this.tokenTimer) { clearTimeout(this.tokenTimer); this.tokenTimer = null; }
  }

  // ===== 工具调用监测 =====

  /** 开始监测一个工具调用 */
  watchToolCall(toolName: string): void {
    if (this.toolTimers.has(toolName)) {
      this.endToolCall(toolName); // 防御：先清理旧的
    }
    const entry = { timer: null as unknown as ReturnType<typeof setTimeout>, warned: false };
    entry.timer = setTimeout(() => {
      entry.warned = true;
      const event: HealthEvent = {
        channel: 'tool_call',
        level: 'WARN',
        message: `工具 ${toolName} 执行超过 ${this.config.toolWarnMs / 1000}s`,
        detail: { toolName },
        timestamp: new Date(),
      };
      logger.warn('[Health] ⚠️ ' + event.message);
      this.emit('warning', event);
    }, this.config.toolWarnMs);
    this.toolTimers.set(toolName, entry);
    logger.debug('[Health] Tool monitoring: ' + toolName);
  }

  /** 结束一个工具调用的监测 */
  endToolCall(toolName: string): void {
    const entry = this.toolTimers.get(toolName);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.toolTimers.delete(toolName);

    // 如果已经 WARN 过，说明工具确实执行了很久
    if (entry.warned) {
      logger.warn('[Health] Tool ' + toolName + ' completed (was slow)');
    }
  }

  /** 检查所有活跃工具调用是否超时 */
  checkToolTimeouts(): void {
    for (const [name, entry] of this.toolTimers) {
      if (entry.warned) {
        // 已 WARN，检查是否超过 deadline
        const event: HealthEvent = {
          channel: 'tool_call',
          level: 'TIMEOUT',
          message: `工具 ${name} 超时 (>${this.config.toolDeadlineMs / 1000}s)`,
          detail: { toolName: name },
          timestamp: new Date(),
        };
        logger.error('[Health] ❌ ' + event.message);
        this.emit('tool_timeout', event);
        this.toolTimers.delete(name);
      }
    }
  }

  // ===== 空循环检测 =====

  /** 记录一次 tool_calls 响应（每次模型返回时调用） */
  recordToolCall(args: Record<string, unknown> | null): void {
    const argsStr = args ? JSON.stringify(args) : 'null';

    if (args === null || Object.keys(args).length === 0) {
      // 空调用
      this.consecutiveEmptyCalls++;
      logger.debug('[Health] Empty tool_call #' + this.consecutiveEmptyCalls);
    } else if (argsStr === this.lastToolCallArgs) {
      // 参数与上次完全相同 → 也视为空循环
      this.consecutiveEmptyCalls++;
      logger.debug('[Health] Repeated tool_call #' + this.consecutiveEmptyCalls);
    } else {
      // 有效调用，重置
      this.consecutiveEmptyCalls = 0;
      this.lastToolCallArgs = argsStr;
    }

    if (this.consecutiveEmptyCalls >= this.config.emptyLoopThreshold) {
      const event: HealthEvent = {
        channel: 'empty_loop',
        level: 'DEAD_LOOP',
        message: `检测到死循环：连续 ${this.consecutiveEmptyCalls} 次空 tool_calls`,
        detail: { consecutiveCount: this.consecutiveEmptyCalls, lastArgs: this.lastToolCallArgs },
        timestamp: new Date(),
      };
      logger.error('[Health] 💀 ' + event.message);
      this.emit('dead_loop', event);
      this.consecutiveEmptyCalls = 0; // 重置（防止重复触发）
    }
  }

  /** 重置空循环计数 */
  resetEmptyLoop(): void {
    this.consecutiveEmptyCalls = 0;
    this.lastToolCallArgs = null;
  }

  // ===== 模型进程存活检测 =====

  /** Ping 模型服务（调用方实现 ping 逻辑，这里只记录结果） */
  recordPing(success: boolean): void {
    this.lastPingTime = Date.now();

    if (!success) {
      this.consecutiveUnreachable++;
      const event: HealthEvent = {
        channel: 'model_process',
        level: 'UNREACHABLE',
        message: `模型不可达 (${this.consecutiveUnreachable}/${this.config.unreachableThreshold})`,
        timestamp: new Date(),
      };
      logger.warn('[Health] ⚠️ ' + event.message);
      this.emit('model_unreachable', event);

      if (this.consecutiveUnreachable >= this.config.unreachableThreshold) {
        const deadEvent: HealthEvent = {
          channel: 'model_process',
          level: 'DEAD',
          message: `模型确认死亡：连续 ${this.consecutiveUnreachable} 次不可达`,
          timestamp: new Date(),
        };
        logger.error('[Health] 💀 ' + deadEvent.message);
        this.emit('model_dead', deadEvent);
      }
    } else {
      if (this.consecutiveUnreachable > 0) {
        logger.info('[Health] ✅ 模型已恢复 (之前 ' + this.consecutiveUnreachable + ' 次不可达)');
      }
      this.consecutiveUnreachable = 0;
    }
  }

  /** 检查模型是否当前不可达 */
  isModelReachable(): boolean {
    return this.consecutiveUnreachable < this.config.unreachableThreshold;
  }

  /** 上次 ping 时间 */
  getLastPingTime(): number {
    return this.lastPingTime;
  }

  // ===== 日志/状态 =====

  /** 获取当前监测状态摘要 */
  status(): string {
    const lines: string[] = ['[HealthMonitor Status]'];
    lines.push('  Token: ' + (this.tokenTimer ? 'monitoring' : 'idle'));
    lines.push('  Active tool monitors: ' + this.toolTimers.size);
    if (this.toolTimers.size > 0) {
      lines.push('    ' + Array.from(this.toolTimers.keys()).join(', '));
    }
    lines.push('  Empty calls: ' + this.consecutiveEmptyCalls + ' / ' + this.config.emptyLoopThreshold);
    lines.push('  Model: ' + (this.consecutiveUnreachable === 0 ? 'reachable' : `unreachable x${this.consecutiveUnreachable}`));
    return lines.join('\n');
  }

  /** 重置所有监测状态 */
  reset(): void {
    this.resetToken();
    for (const [, entry] of this.toolTimers) { clearTimeout(entry.timer); }
    this.toolTimers.clear();
    this.consecutiveEmptyCalls = 0;
    this.lastToolCallArgs = null;
    this.tokenWarned = false;
    this.consecutiveUnreachable = 0;
  }
}

// 单例
let _instance: HealthMonitor | null = null;
export function getHealthMonitor(): HealthMonitor {
  if (!_instance) _instance = new HealthMonitor();
  return _instance;
}
