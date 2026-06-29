/**
 * =============================================================================
 * 5E DegradationPath — 降级路径
 * =============================================================================
 *
 * ## 功能定位
 * 当所有恢复手段都失败时，不直接报错中止，而是沿预先定义的降级路径逐步
 * 降低任务复杂度，尽可能产出部分结果，最后才向用户报告无法完成。
 *
 * ## 降级层级
 *
 * ```
 * Level 0: 完整任务（正常执行，不做任何缩减）
 *   ↓ 降级触发
 * Level 1: 精简执行（减少工具调用，用更简单的方式）
 *   - 用 read/write 替代 exec
 *   - 用本地推理替代联网搜索
 *   - 跳过非必要步骤
 *   ↓ 降级触发
 * Level 2: 最小产出（只产出思考结果，不执行变更）
 *   - 不创建文件，只输出代码/建议
 *   - 不执行命令，只输出命令列表
 *   - 不搜索网络，只用已有知识
 *   ↓ 降级触发
 * Level 3: 建议模式（完全不执行，只给建议）
 *   - 输出"由于XX问题无法完成，建议您手动执行以下步骤"
 *   - 附带详细的手动操作指南
 *   ↓ 降级触发
 * Level 4: 最终兜底（通知用户，保留现场）
 *   - 保存检查点
 *   - 输出故障诊断信息
 *   - 请用户介入
 * ```
 *
 * ## 降级触发条件
 * 由 RecoveryOrchestrator 在以下情况触发降级：
 * 1. maxRetries 耗尽（重试了指定次数仍失败）
 * 2. 所有恢复路径都被熔断（CircuitBreaker 全部 OPEN）
 * 3. 致命错误无法恢复（auth_error 等）
 * 4. 恢复尝试总耗时超过上限（防止无限循环）
 *
 * ## 使用方式
 * ```
 * const dg = getDegradationPath();
 *
 * // 尝试执行，失败后降级
 * const result = await dg.executeWithDegradation(async (level) => {
 *   if (level === 0) return await doFullTask();
 *   if (level === 1) return await doSimplifiedTask();
 *   if (level === 2) return await doMinimalTask();
 *   if (level === 3) return { output: '建议: ...', partial: true };
 * }, { originalTask: request });
 * ```
 *
 * ## 设计决策
 * - 逐级降级：不是一次性跳过所有层级，而是每级都尝试
 * - 用户知情：降级后输出说明（"因XX问题，已降级处理为…"）
 * - 部分成功 > 完全失败：哪怕只产出一个建议，也比报错中止好
 * - 级别可配置：不同任务类型可配置不同降级链
 */

import { logger } from './logger';

// --- 类型定义 ---

/** 降级级别 */
export type DegradationLevel = 0 | 1 | 2 | 3 | 4;

/** 降级结果 */
export interface DegradationResult {
  /** 最终输出的级别 */
  level: DegradationLevel;
  /** 输出文本 */
  output: string;
  /** 是否部分成功（至少产出了可用的东西） */
  partialSuccess: boolean;
  /** 降级原因（从哪个级别降下来的） */
  degradeReasons: string[];
  /** 原始错误信息 */
  originalError?: string;
  /** 建议用户执行的手动步骤（Level 3 时使用） */
  manualSteps?: string[];
  /** 故障诊断信息（Level 4 时使用） */
  diagnostics?: string;
}

/** 降级配置 */
export interface DegradationConfig {
  /** 最大降级级别（超过此级别直接最终兜底） */
  maxLevel: DegradationLevel;
  /** 单级别超时 (ms) */
  perLevelTimeoutMs: number;
  /** 总降级超时 (ms) */
  totalTimeoutMs: number;
}

const DEFAULT_CONFIG: DegradationConfig = {
  maxLevel: 4,
  perLevelTimeoutMs: 60000,
  totalTimeoutMs: 300000,
};

// --- 主类 ---

export class DegradationPath {
  public config: DegradationConfig;

  constructor(config?: Partial<DegradationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 执行带降级的任务。
   *
   * @param executor 执行函数，接收当前降级级别，返回结果文本
   * @param options.originalTask 原始任务描述（用于 Level 3/4 生成建议）
   * @param options.context 额外上下文信息
   * @returns 降级结果
   */
  async executeWithDegradation(
    executor: (level: DegradationLevel) => Promise<string>,
    options: {
      originalTask: string;
      context?: string;
    },
  ): Promise<DegradationResult> {
    const degradeReasons: string[] = [];
    const startTime = Date.now();

    for (let l = 0; l <= this.config.maxLevel; l++) {
      const level = l as DegradationLevel;
      // 检查总超时
      if (Date.now() - startTime > this.config.totalTimeoutMs) {
        degradeReasons.push('总降级超时 (' + this.config.totalTimeoutMs / 1000 + 's)');
        return this.finalFallback(options.originalTask, degradeReasons);
      }

      try {
        logger.info('[Degradation] Level ' + level + ': ' + this.levelLabel(level));
        const output = await this.withTimeout(
          executor(level),
          this.config.perLevelTimeoutMs,
        );

        // 成功！
        const result: DegradationResult = {
          level,
          output: this.addDegradationNote(output, level, degradeReasons),
          partialSuccess: level > 0, // Level 0 = 完全成功
          degradeReasons,
        };
        logger.info('[Degradation] Level ' + level + ' OK' + (level > 0 ? ' (degraded)' : ''));
        return result;

      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 100);
        degradeReasons.push('L' + level + ': ' + reason);
        logger.warn('[Degradation] Level ' + level + ' failed: ' + reason);

        if (level >= this.config.maxLevel) {
          return this.finalFallback(options.originalTask, degradeReasons);
        }
        // 继续下一级
      }
    }

    // 不应该到这里，但以防万一
    return this.finalFallback(options.originalTask, degradeReasons);
  }

  /** 最终兜底：Level 4 */
  private finalFallback(originalTask: string, reasons: string[]): DegradationResult {
    const diag = this.generateDiagnostics(originalTask, reasons);
    return {
      level: 4,
      output: diag,
      partialSuccess: false,
      degradeReasons: reasons,
      diagnostics: diag,
    };
  }

  /** 生成带降级说明的输出 */
  private addDegradationNote(output: string, level: DegradationLevel, reasons: string[]): string {
    if (level === 0) return output; // 正常完成，不加说明

    const note = this.levelNote(level, reasons);
    return note + '\n\n---\n' + output;
  }

  /** 降级说明 */
  private levelNote(level: DegradationLevel, reasons: string[]): string {
    const labels: Record<DegradationLevel, string> = {
      0: '',
      1: '⚠️ 精简模式（减少了工具调用）',
      2: '⚠️ 最小模式（仅输出建议，未执行变更）',
      3: '⚠️ 建议模式（请手动执行）',
      4: '❌ 无法完成',
    };

    let note = labels[level] ?? '';
    if (reasons.length > 0) {
      note += '\n> 原因：' + reasons.join(' → ');
    }
    return note;
  }

  /** 降级级别名称 */
  levelLabel(level: DegradationLevel): string {
    const labels: Record<number, string> = {
      0: '完整执行',
      1: '精简执行',
      2: '最小产出',
      3: '建议模式',
      4: '最终兜底',
    };
    return labels[level] ?? 'Level ' + level;
  }

  /** 生成诊断信息 */
  generateDiagnostics(originalTask: string, reasons: string[]): string {
    return [
      '❌ 经过 ' + reasons.length + ' 级降级尝试后仍无法完成任务：',
      '',
      '**原始任务**: ' + originalTask,
      '',
      '**降级链记录**:',
      ...reasons.map((r, i) => '  ' + (i + 1) + '. ' + r),
      '',
      '**建议**:',
      '1. 检查模型服务是否正常运行（LM Studio / Ollama）',
      '2. 检查网络连接',
      '3. 尝试手动执行任务',
      '4. 重启 Agent System 后从检查点恢复',
      '',
      '检查点已保存，重启后可通过 `/project resume` 恢复。',
    ].join('\n');
  }

  /** 带超时的 Promise */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (ms <= 0) return promise;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Degradation timeout: ' + ms + 'ms')), ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}

// 单例
let _instance: DegradationPath | null = null;
export function getDegradationPath(): DegradationPath {
  if (!_instance) _instance = new DegradationPath();
  return _instance;
}
