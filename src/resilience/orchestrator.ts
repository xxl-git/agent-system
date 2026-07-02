/**
 * =============================================================================
 * 5F RecoveryOrchestrator — 恢复编排器
 * =============================================================================
 *
 * ## 功能定位
 * 韧性保障层的核心大脑。将 HealthMonitor、RetryEngine、CircuitBreaker、
 * CheckpointManager、DegradationPath 五个模块串联成完整的恢复链路，
 * 在任务执行失败时自动执行检测→分类→重试→熔断→降级的全流程。
 *
 * ## 恢复循环（核心算法）
 *
 * ```
 * while (任务未完成 && 未达最大恢复次数):
 *   try:
 *     execute_step()                    // 执行当前步骤
 *     save_checkpoint()                 // 成功 → 保存检查点
 *     continue                          // 继续下一步
 *   catch error:
 *     failure = classify(error)         // Step 1: 故障分类
 *     strategy = match(failure)         // Step 2: 匹配策略
 *     if fatal: → 直接走降级
 *
 *     for attempt in 1..maxRetries:     // Step 3: 尝试恢复
 *       delay = calcDelay(attempt)
 *       sleep(delay)
 *       for action in recoveryActions:  // Step 4: 执行恢复动作
 *         result = apply_recovery(action)
 *         if !result.ok:
 *           circuit_breaker.trip(action) // 恢复路径熔断
 *           continue next_action
 *       try:
 *         execute_step()                // Step 5: 重试执行
 *         circuit_breaker.reset_all()  // 成功 → 重置熔断器
 *         save_checkpoint()
 *         break                         // 恢复成功，继续任务
 *       catch retry_error:
 *         continue                      // 继续下一次重试
 *
 *     if all_recoveries_failed:         // Step 6: 所有恢复失败
 *       degrade(task)                   // 走降级
 *       if degradation_ok:
 *         complete_partial()            // 部分完成
 *       else:
 *         notify_user()                 // 通知用户介入
 *         save_final_checkpoint()       // 保留现场
 * ```
 *
 * ## 与 Agent Core 的集成点
 *
 * Agent Core 在执行每个步骤时，由 RecoveryOrchestrator 包装：
 *
 * ```typescript
 * // 在 agent-core.ts 中
 * const result = await this.recovery.executeProtected(
 *   async () => {
 *     // 正常执行逻辑
 *     return await this.orchestrator.executeStep(step);
 *   },
 *   {
 *     taskId: dag.id,
 *     step: currentStep,
 *     context: { model: this.adapter.model },
 *   }
 * );
 * ```
 *
 * ## 设计决策
 * - 无状态编排器：RecoveryOrchestrator 本身不存储状态，所有状态存于
 *   HealthMonitor / CircuitBreaker / CheckpointManager 中
 * - 事件传递：HealthMonitor 检测到故障 → 直接触发恢复（同步）
 *   而不是等待主循环轮询（减少延迟）
 * - 可观测性：每次恢复尝试都记录详细日志和事件
 * - 最大恢复时间：设有全局超时（默认 5 分钟），防止恢复本身变成死循环
 *
 * ## 恢复动作执行器
 *
 * 各恢复动作的具体实现：
 * - wait_reconnect: sleep 5s，然后 ping 模型
 * - switch_model: 通知 SmartRouter 切换到 fallback 模型
 * - truncate_context: 调用 ContextTruncator 裁剪消息
 * - kill_restart: 杀模型进程 + 从 CheckpointManager 恢复
 * - reload_config: 重新调用 loadConfig()
 * - disable_tool: 熔断当前工具
 * - reset_session: 清空对话历史
 */

import { EventEmitter } from 'events';
import { HealthMonitor, getHealthMonitor, type HealthEvent } from './health-monitor';
import { RetryEngine, getRetryEngine, type ClassifiedFailure, type RecoveryAction } from './retry-engine';
import { CircuitBreaker, getCircuitBreaker } from './circuit-breaker';
import { CheckpointManager, getCheckpointManager, type CompletedStep, type FailureRecord } from './checkpoint';
import { DegradationPath, getDegradationPath, type DegradationResult } from './degradation';
import type { SubTask, TaskDAG } from '@agent-system/resilience';
import type { ChatMessage } from '../models/adapters/lmstudio';
import logger from '../logger';

// --- 类型定义 ---

/** 受保护的执行上下文 */
export interface ProtectedContext {
  /** 任务 ID */
  taskId: string;
  /** 当前步骤（如果已知） */
  step?: SubTask;
  /** 额外上下文（模型名等） */
  context?: Record<string, unknown>;
}

/** 受保护的执行结果 */
export interface ProtectedResult {
  success: boolean;
  output?: string;
  error?: string;
  /** 是否经历了恢复 */
  recovered: boolean;
  /** 恢复尝试次数 */
  recoveryAttempts: number;
  /** 恢复动作记录 */
  recoveryLog: string[];
  /** 是否为降级结果 */
  degraded: boolean;
  /** 降级级别（如果降级） */
  degradationLevel?: number;
  /** 总耗时 (ms) */
  durationMs: number;
}

/** 编排器配置 */
export interface RecoveryConfig {
  /** 最大恢复尝试次数（全局，含重试+降级） */
  maxRecoveryAttempts: number;
  /** 恢复总超时 (ms) */
  recoveryTimeoutMs: number;
}

const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  maxRecoveryAttempts: 2,  // 2 次恢复尝试 + 1 次降级 = 最多 3 次机会
  recoveryTimeoutMs: 300000, // 5 分钟
};

// --- 主类 ---

export class RecoveryOrchestrator extends EventEmitter {
  public config: RecoveryConfig;
  private hm: HealthMonitor;
  private re: RetryEngine;
  private cb: CircuitBreaker;
  private ckm: CheckpointManager;
  private dg: DegradationPath;
  // 全局重试统计
  private _recoveryAttempts = 0;
  private _successfulRecoveries = 0;
  private _failedRecoveries = 0;
  private _degradations = 0;
  private _recoveryHistory: { timestamp: number; type: string; message: string; taskId: string | null }[] = [];

  constructor(config?: Partial<RecoveryConfig>) {
    super();
    this.config = { ...DEFAULT_RECOVERY_CONFIG, ...config };
    this.hm = getHealthMonitor();
    this.re = getRetryEngine();
    this.cb = getCircuitBreaker();
    this.ckm = getCheckpointManager();
    this.dg = getDegradationPath();

    // 监听 HealthMonitor 事件，直接触发恢复
    this.setupHealthListeners();
  }

  // ===== 核心方法：受保护执行 =====

  /**
   * 包装一次执行（单个步骤），自动处理失败恢复。
   * 这是与 Agent Core 集成的主入口。
   */
  async executeProtected(
    executor: () => Promise<string>,
    ctx: ProtectedContext,
  ): Promise<ProtectedResult> {
    const startTime = Date.now();
    const recoveryLog: string[] = [];
    let recoveryAttempts = 0;
    let _wasRecovered = false;
    let _wasDegraded = false;

    try {
      // 正常执行
      const output = await executor();
      return {
        success: true,
        output,
        recovered: false,
        recoveryAttempts: 0,
        recoveryLog,
        degraded: false,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      // 故障分类
      const failure = this.re.classify(error);
      const strategy = this.re.match(failure);
      recoveryLog.push('故障: ' + failure.type + ' — ' + failure.message.slice(0, 80));
      logger.warn('[Recovery] ' + failure.type + ': ' + failure.message.slice(0, 120));

      // 致命错误 → 直接降级
      if (strategy.fatal) {
        recoveryLog.push('致命错误，走降级');
        return this.handleDegradation(ctx.taskId, ctx.step, failure, recoveryLog, startTime);
      }

      // 检查任务级别超时
      if (startTime && Date.now() - startTime > this.config.recoveryTimeoutMs) {
        recoveryLog.push('恢复总超时，走降级');
        return this.handleDegradation(ctx.taskId, ctx.step, failure, recoveryLog, startTime);
      }

      // 尝试恢复
      for (let attempt = 0; attempt < strategy.maxRetries; attempt++) {
        recoveryAttempts++;

        // 计算退避
        const delay = this.re.calcDelay(strategy, attempt);
        recoveryLog.push(`重试 ${attempt + 1}/${strategy.maxRetries} (等待 ${delay}ms)`);
        logger.info('[Recovery] Retry ' + (attempt + 1) + '/' + strategy.maxRetries +
          ' — waiting ' + delay + 'ms');
        await this.sleep(delay);

        // 执行恢复动作
        for (const action of strategy.recoveryActions) {
          if (!this.cb.canUsePath(action)) {
            recoveryLog.push('  动作 ' + action + ' 已熔断，跳过');
            continue;
          }
          try {
            recoveryLog.push('  执行: ' + this.re.actionLabel(action));
            await this.executeRecoveryAction(action, ctx, failure);
            this.cb.pathSuccess(action);
          } catch (actionErr) {
            logger.warn('[Recovery] 恢复动作执行失败', actionErr);
            recoveryLog.push('  ❌ 动作失败: ' + this.extractMsg(actionErr));
            this.cb.pathFailure(action, this.extractMsg(actionErr));
          }
        }

        // 重试执行
        try {
          const output = await executor();
          // 成功！
          this.cb.resetAll();
          this._recoveryAttempts++;
          if (recoveryAttempts > 0) { this._successfulRecoveries++; this._recordHistory('recovered', recoveryLog.join(' | '), ctx.taskId ?? null); }
          return {
            success: true,
            output,
            recovered: recoveryAttempts > 0,
            recoveryAttempts,
            recoveryLog,
            degraded: false,
            durationMs: Date.now() - startTime,
          };
        } catch (retryErr) {
          logger.debug('[Recovery] executor 重试失败', retryErr);
          recoveryLog.push('  重试失败: ' + this.extractMsg(retryErr).slice(0, 80));
          // 继续下一次重试
        }
      }

      // 所有重试失败 → 降级
      recoveryLog.push('重试耗尽，走降级');
      this._recoveryAttempts++;
      this._failedRecoveries++;
      this._recordHistory('failed', recoveryLog.join(' | '), ctx.taskId ?? null);
      return this.handleDegradation(ctx.taskId, ctx.step, failure, recoveryLog, startTime);
    }
  }

  /** 处理降级 */
  private async handleDegradation(
    taskId: string,
    step: SubTask | undefined,
    failure: ClassifiedFailure,
    recoveryLog: string[],
    startTime: number,
  ): Promise<ProtectedResult> {
    // 保存故障记录到检查点
    if (taskId) {
      this.ckm.recordFailure(taskId, {
        type: failure.type,
        message: failure.message,
        stepIndex: step ? 0 : -1, // TODO: 从 checkpoint 获取实际步骤索引
        recovered: false,
      });
    }

    // 走降级
    const taskDesc = step?.description ?? taskId;
    const degResult = await this.dg.executeWithDegradation(
      async () => {
        // 最终兜底：返回诊断信息
        return this.dg.generateDiagnostics(taskDesc, recoveryLog);
      },
      { originalTask: taskDesc },
    );

    this._degradations++;
    this._recordHistory('degraded', `降级(${degResult.level}): ${failure.message}`, taskId ?? null);
    logger.error(`[Recovery] 降级(${degResult.level}): ${failure.type} — ${failure.message}`, { taskId });
    return {
      success: degResult.partialSuccess,
      output: degResult.output,
      error: failure.message,
      recovered: false,
      recoveryAttempts: 0,
      recoveryLog,
      degraded: true,
      degradationLevel: degResult.level,
      durationMs: Date.now() - startTime,
    };
  }

  private _recordHistory(type: string, message: string, taskId: string | null): void {
    this._recoveryHistory.push({ timestamp: Date.now(), type, message, taskId });
    if (this._recoveryHistory.length > 100) {
      this._recoveryHistory = this._recoveryHistory.slice(-100);
    }
  }

  // ===== 恢复动作执行器 =====

  /**
   * 执行单个恢复动作。
   * 每个动作是一个具体的操作，如切换模型、裁剪上下文等。
   */
  private async executeRecoveryAction(
    action: RecoveryAction,
    ctx: ProtectedContext,
    failure: ClassifiedFailure,
  ): Promise<void> {
    switch (action) {
      case 'wait_reconnect': {
        logger.info('[Recovery] ⏳ 等待模型重连 (5s)...');
        await this.sleep(5000);
        // 重连后由调用方通过 HealthMonitor.recordPing() 确认
        break;
      }

      case 'switch_model': {
        logger.info('[Recovery] 🔄 切换模型...');
        // 标记当前模型熔断
        const currentModel = String(ctx.context?.model ?? 'unknown');
        this.cb.modelFailure(currentModel, failure.message);
        // SmartRouter 会在下次路由时自动选择备用模型
        // 这里只做标记，实际切换由 agent-core 在下次 sendMessage 时完成
        this.emit('model_switch_needed', { currentModel, reason: failure.message });
        break;
      }

      case 'truncate_context': {
        logger.info('[Recovery] ✂️ 裁剪上下文...');
        // 上下文裁剪由 agent-core 在下次发送前完成
        this.emit('context_truncate_needed');
        break;
      }

      case 'kill_restart': {
        logger.warn('[Recovery] 💀 触发杀进程+从检查点恢复...');
        // 1. 重置 HealthMonitor
        this.hm.reset();
        // 2. 保存当前检查点（如果有）
        if (ctx.step && ctx.taskId) {
          const completed: CompletedStep = {
            step: ctx.step,
            result: { success: false, output: '', error: failure.message },
            completedAt: new Date().toISOString(),
          };
          this.ckm.save(ctx.taskId, completed, [], []);
        }
        // 3. 重置空循环计数
        this.hm.resetEmptyLoop();
        // 4. 通知 agent-core 重置 Adapter
        this.emit('adapter_reset_needed');
        break;
      }

      case 'reload_config': {
        logger.info('[Recovery] 🔄 重载配置...');
        this.emit('config_reload_needed');
        break;
      }

      case 'disable_tool': {
        const toolName = String(ctx.context?.toolName ?? 'unknown_tool');
        logger.warn('[Recovery] ⛔ 熔断工具: ' + toolName);
        this.cb.toolFailure(toolName, failure.message);
        break;
      }

      case 'reset_session': {
        logger.info('[Recovery] 🔄 重置对话 session...');
        this.emit('session_reset_needed');
        break;
      }

      case 'retry_with_backoff': {
        // 纯退避等待，不做额外动作
        logger.debug('[Recovery] ⏸️ 退避等待中...');
        break;
      }

      default:
        logger.warn('[Recovery] 未知恢复动作: ' + action);
    }
  }

  // ===== 批量执行（整个 DAG 的受保护执行） =====

  /**
   * 执行整个任务 DAG，每一步都受到韧性保护。
   * Agent Core 的 handleTask() 应使用此方法替代直接调用 orchestrator.execute()。
   */
  async executeDAGProtected(
    dag: TaskDAG,
    executeStep: (step: SubTask) => Promise<string>,
    messages: ChatMessage[],
  ): Promise<ProtectedResult[]> {
    const results: ProtectedResult[] = [];
    const taskId = 'dag-' + Date.now();

    // 注册任务
    this.ckm.registerTask(taskId, dag.originalRequest || '', dag.tasks);

    for (const step of dag.tasks) {
      // 检查熔断器状态
      if (step.tool && !this.cb.canUseTool(step.tool)) {
        logger.warn('[Recovery] Tool ' + step.tool + ' is circuit-broken, skipping step: ' + step.title);
        results.push({
          success: false,
          error: 'Tool ' + step.tool + ' is circuit-broken',
          recovered: false,
          recoveryAttempts: 0,
          recoveryLog: [],
          degraded: false,
          durationMs: 0,
        });
        continue;
      }

      const result = await this.executeProtected(
        () => executeStep(step),
        {
          taskId,
          step,
          context: { toolName: step.tool },
        },
      );
      results.push(result);

      // 保存检查点
      if (result.success || result.degraded) {
        const remainingSteps = dag.tasks.filter(s => s.status !== 'done' && s !== step);
        const completed: CompletedStep = {
          step,
          result: { success: result.success, output: result.output ?? '', error: result.error },
          completedAt: new Date().toISOString(),
        };
        this.ckm.save(taskId, completed, remainingSteps, messages);
      }

      // 如果降级且不可继续，停止执行
      if (result.degraded && result.degradationLevel !== undefined && result.degradationLevel >= 3) {
        logger.warn('[Recovery] 降级到 Level ' + result.degradationLevel + '，停止后续步骤');
        break;
      }
    }

    // 任务完成，清理检查点
    this.ckm.complete(taskId);
    return results;
  }

  // ===== 健康监听 =====

  private setupHealthListeners(): void {
    // Token 流卡死
    this.hm.on('stuck', (event: HealthEvent) => {
      logger.error('[Recovery] Token stream stuck detected!');
      this.emit('recovery_needed', {
        type: 'timeout',
        event,
        severity: 'high',
      });
    });

    // 死循环
    this.hm.on('dead_loop', (event: HealthEvent) => {
      logger.error('[Recovery] Dead loop detected!');
      // 死循环不等待，直接触发 kill_restart
      this.hm.reset();
      this.hm.resetEmptyLoop();
      this.emit('recovery_needed', {
        type: 'empty_loop',
        event,
        severity: 'critical',
      });
    });

    // 模型不可达
    this.hm.on('model_dead', (event: HealthEvent) => {
      logger.error('[Recovery] Model dead! Triggering model switch');
      this.emit('recovery_needed', {
        type: 'model_unreachable',
        event,
        severity: 'critical',
      });
    });

    // 工具超时
    this.hm.on('tool_timeout', (event: HealthEvent) => {
      const toolName = event.detail?.toolName as string;
      if (toolName) {
        this.cb.toolFailure(toolName, 'HealthMonitor detected timeout');
      }
    });
  }

  // ===== 工具方法 =====

  /** 获取恢复状态摘要 */
  status(): string {
    return [
      this.hm.status(),
      '',
      this.cb.status(),
      '',
      this.ckm.recoverySummary(),
    ].join('\n');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private extractMsg(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  /** 获取重试统计（供 API/Dashboard 使用） */
  getStats(): {
    recoveryAttempts: number;
    successfulRecoveries: number;
    failedRecoveries: number;
    degradations: number;
    recentEvents: { timestamp: string; type: string; message: string; taskId: string | null }[];
  } {
    return {
      recoveryAttempts: this._recoveryAttempts,
      successfulRecoveries: this._successfulRecoveries,
      failedRecoveries: this._failedRecoveries,
      degradations: this._degradations,
      recentEvents: this._recoveryHistory.slice(-20).map((e) => ({
        timestamp: new Date(e.timestamp).toISOString(),
        type: e.type,
        message: e.message,
        taskId: e.taskId,
      })),
    };
  }
}

// 单例
let _instance: RecoveryOrchestrator | null = null;
export function getRecoveryOrchestrator(): RecoveryOrchestrator {
  if (!_instance) _instance = new RecoveryOrchestrator();
  return _instance;
}
