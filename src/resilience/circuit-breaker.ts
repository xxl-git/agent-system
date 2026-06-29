/**
 * =============================================================================
 * 5D CircuitBreaker — 熔断器
 * =============================================================================
 *
 * ## 功能定位
 * 防止故障传播。当某个模型/工具/恢复路径连续失败时，自动将其标记为不可用，
 * 在一定时间内不再尝试。避免雪崩效应——一个组件坏了，整个系统不断重试，
 * 把资源耗尽。
 *
 * ## 核心概念
 *
 * ### 三态模型
 * ```
 * CLOSED ──→ 失败 N 次达到阈值 ──→ OPEN ──→ 冷却 T 秒 ──→ HALF_OPEN
 *   ✓ 正常放行                      ✗ 直接拒绝                   ✓ 试探1次
 *                                                                 成功→CLOSED
 *                                                                 失败→OPEN(重新计时)
 * ```
 * - CLOSED（正常）：请求正常通过，记录失败次数
 * - OPEN（熔断）：直接拒绝所有请求，返回 CircuitOpenError
 * - HALF_OPEN（试探）：允许一次请求通过，成功则恢复 CLOSED，失败则回到 OPEN
 *
 * ### 熔断对象
 * - 模型熔断：某模型连续失败 3 次 → 30s 内不再路由给它
 * - 工具熔断：某工具连续超时 2 次 → 当前任务禁用该工具
 * - 路径熔断：某恢复路径走了 2 次都失败 → 跳过，走下一级降级
 *
 * ## 使用方式
 * ```
 * const cb = getCircuitBreaker();
 *
 * // 保护模型
 * const modelCB = cb.model('qwen3.6');
 * if (modelCB.state === 'OPEN') { /* 已熔断，换模型 *\/ }
 * try { await callModel(); modelCB.recordSuccess(); }
 * catch { modelCB.recordFailure(); }
 *
 * // 保护工具
 * const toolCB = cb.tool('web_search');
 * if (toolCB.state === 'OPEN') { /* 已熔断，跳过此工具 *\/ }
 * ```
 *
 * ## 设计决策
 * - 线程安全：所有方法都是同步的（无 async），保证状态一致性
 * - 自动恢复：冷却后自动进入 HALF_OPEN 试探
 * - 内存存储：熔断状态在进程重启后重置（这是故意的——重启本身就是最大恢复）
 * - 独立跟踪：每个被保护对象都有自己的熔断器状态
 */

import logger from '../logger';
import { getConfigSection } from '../config/agent-system-config';

// --- 类型定义 ---

/** 熔断状态 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** 熔断器实例 */
export interface CircuitBreakerInstance {
  /** 当前状态 */
  state: CircuitState;
  /** 失败计数 */
  failureCount: number;
  /** 上次失败时间 */
  lastFailureTime: number;
  /** 下次可试探时间 (ms timestamp) */
  retryAfter: number;
  /** 最后一条错误信息 */
  lastError?: string;
}

/** 配置 */
export interface CircuitBreakerConfig {
  /** 触发熔断的连续失败次数 */
  failureThreshold: number;
  /** 熔断后冷却时间 (ms) */
  cooldownMs: number;
  /** HALF_OPEN 状态最多试探次数 */
  halfOpenMaxAttempts: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 30000,
  halfOpenMaxAttempts: 1,
};

/** 默认熔断器实例 */
function createInstance(): CircuitBreakerInstance {
  return {
    state: 'CLOSED',
    failureCount: 0,
    lastFailureTime: 0,
    retryAfter: 0,
  };
}

// --- 主类 ---

export class CircuitBreaker {
  public config: CircuitBreakerConfig;

  /** 模型熔断器 */
  private models: Map<string, CircuitBreakerInstance> = new Map();
  /** 工具熔断器 */
  private tools: Map<string, CircuitBreakerInstance> = new Map();
  /** 恢复路径熔断器 */
  private paths: Map<string, CircuitBreakerInstance> = new Map();

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===== 模型熔断 =====

  /** 获取或创建模型的熔断器 */
  model(name: string): CircuitBreakerInstance {
    if (!this.models.has(name)) {
      this.models.set(name, createInstance());
    }
    return this.models.get(name)!;
  }

  /** 记录模型请求成功 */
  modelSuccess(name: string): void {
    const cb = this.model(name);
    this.recordSuccess(cb, 'model', name);
  }

  /** 记录模型请求失败 */
  modelFailure(name: string, error?: string): CircuitBreakerInstance {
    const cb = this.model(name);
    return this.recordFailure(cb, 'model', name, error);
  }

  /** 检查模型是否可用（不修改状态） */
  canUseModel(name: string): boolean {
    return this.canUse(this.model(name));
  }

  // ===== 工具熔断 =====

  /** 获取或创建工具的熔断器 */
  tool(name: string): CircuitBreakerInstance {
    if (!this.tools.has(name)) {
      this.tools.set(name, createInstance());
    }
    return this.tools.get(name)!;
  }

  /** 记录工具调用成功 */
  toolSuccess(name: string): void {
    const cb = this.tool(name);
    this.recordSuccess(cb, 'tool', name);
  }

  /** 记录工具调用失败 */
  toolFailure(name: string, error?: string): CircuitBreakerInstance {
    const cb = this.tool(name);
    return this.recordFailure(cb, 'tool', name, error);
  }

  /** 检查工具是否可用 */
  canUseTool(name: string): boolean {
    return this.canUse(this.tool(name));
  }

  // ===== 路径熔断 =====

  /** 获取或创建恢复路径的熔断器 */
  path(name: string): CircuitBreakerInstance {
    if (!this.paths.has(name)) {
      this.paths.set(name, createInstance());
    }
    return this.paths.get(name)!;
  }

  /** 记录恢复路径成功 */
  pathSuccess(name: string): void {
    const cb = this.path(name);
    this.recordSuccess(cb, 'path', name);
  }

  /** 记录恢复路径失败 */
  pathFailure(name: string, error?: string): CircuitBreakerInstance {
    const cb = this.path(name);
    return this.recordFailure(cb, 'path', name, error);
  }

  /** 检查恢复路径是否可用 */
  canUsePath(name: string): boolean {
    return this.canUse(this.path(name));
  }

  // ===== 通用方法 =====

  /**
   * 检查实例是否可用。
   * CLOSED → true
   * OPEN → 检查冷却是否到期，是则转为 HALF_OPEN 返回 true
   * HALF_OPEN → true（允许试探）
   */
  private canUse(cb: CircuitBreakerInstance): boolean {
    if (cb.state === 'CLOSED') return true;
    if (cb.state === 'HALF_OPEN') return true;

    // OPEN 状态：检查是否冷却完成
    if (Date.now() >= cb.retryAfter) {
      cb.state = 'HALF_OPEN';
      logger.debug('[Circuit] Circuit HALF_OPEN (cooldown complete)');
      return true;
    }

    return false;
  }

  private recordSuccess(cb: CircuitBreakerInstance, kind: string, name: string): void {
    if (cb.state === 'HALF_OPEN') {
      // HALF_OPEN 试探成功 → 恢复为 CLOSED
      cb.state = 'CLOSED';
      cb.failureCount = 0;
      logger.info('[Circuit] ✅ ' + kind + ' "' + name + '" 恢复 (HALF_OPEN→CLOSED)');
    } else if (cb.state === 'CLOSED') {
      // CLOSED 状态下成功，重置失败计数
      cb.failureCount = 0;
    }
  }

  private recordFailure(
    cb: CircuitBreakerInstance,
    kind: string,
    name: string,
    error?: string,
  ): CircuitBreakerInstance {
    cb.failureCount++;
    cb.lastFailureTime = Date.now();
    cb.lastError = error;

    if (cb.state === 'HALF_OPEN') {
      // HALF_OPEN 试探失败 → 回到 OPEN
      cb.state = 'OPEN';
      cb.retryAfter = Date.now() + this.config.cooldownMs;
      logger.warn('[Circuit] ⛔ ' + kind + ' "' + name + '" 试探失败 → OPEN (' +
        this.config.cooldownMs / 1000 + 's cooldown)');
    } else if (cb.failureCount >= this.config.failureThreshold) {
      // CLOSED 失败达阈值 → OPEN
      cb.state = 'OPEN';
      cb.retryAfter = Date.now() + this.config.cooldownMs;
      logger.error('[Circuit] ⛔ ' + kind + ' "' + name + '" 熔断 (' +
        cb.failureCount + ' failures, ' + this.config.cooldownMs / 1000 + 's cooldown)');
    }

    return cb;
  }

  // ===== 主动操作 =====

  /** 手动关闭熔断器（重置为 CLOSED） */
  reset(kind: 'model' | 'tool' | 'path', name: string): void {
    const map = this.getMap(kind);
    if (map.has(name)) {
      map.get(name)!.state = 'CLOSED';
      map.get(name)!.failureCount = 0;
      logger.info('[Circuit] 🔄 ' + kind + ' "' + name + '" 手动重置 → CLOSED');
    }
  }

  /** 手动触发熔断 */
  trip(kind: 'model' | 'tool' | 'path', name: string): void {
    const map = this.getMap(kind);
    if (!map.has(name)) map.set(name, createInstance());
    const cb = map.get(name)!;
    cb.state = 'OPEN';
    cb.retryAfter = Date.now() + this.config.cooldownMs;
    logger.warn('[Circuit] 🔴 ' + kind + ' "' + name + '" 手动熔断 → OPEN');
  }

  /** 重置所有熔断器 */
  resetAll(): void {
    for (const map of [this.models, this.tools, this.paths]) {
      for (const cb of map.values()) {
        cb.state = 'CLOSED';
        cb.failureCount = 0;
      }
    }
    logger.info('[Circuit] 🔄 全部熔断器已重置');
  }

  // ===== 状态查询 =====

  /** 获取状态汇总 */
  status(): string {
    const lines: string[] = ['[CircuitBreaker Status]'];

    const modelOpen = Array.from(this.models.entries()).filter(([, cb]) => cb.state === 'OPEN');
    const toolOpen = Array.from(this.tools.entries()).filter(([, cb]) => cb.state === 'OPEN');
    const pathOpen = Array.from(this.paths.entries()).filter(([, cb]) => cb.state === 'OPEN');

    lines.push('  Models: ' + this.models.size + ' (OPEN: ' + modelOpen.length + ')');
    for (const [name, cb] of modelOpen) {
      const remaining = Math.max(0, cb.retryAfter - Date.now());
      lines.push('    ' + name + ' → 剩余 ' + Math.round(remaining / 1000) + 's');
    }

    lines.push('  Tools: ' + this.tools.size + ' (OPEN: ' + toolOpen.length + ')');
    for (const [name] of toolOpen) lines.push('    ' + name);

    lines.push('  Paths: ' + this.paths.size + ' (OPEN: ' + pathOpen.length + ')');
    for (const [name] of pathOpen) lines.push('    ' + name);

    return lines.join('\n');
  }

  /** 获取结构化状态（供 API / Dashboard 使用） */
  getStatus(): {
    state: string;
    modelState: Record<string, { state: string; failureCount: number; lastFailure: number | null }>;
    toolState: Record<string, { state: string; failureCount: number; lastFailure: number | null }>;
    pathState: Record<string, { state: string; failureCount: number; lastFailure: number | null }>;
    failureCount: number;
    lastFailure: number | null;
  } {
    const modelState: Record<string, any> = {};
    const toolState: Record<string, any> = {};
    const pathState: Record<string, any> = {};
    let totalFailures = 0;
    let latestFailure: number | null = null;

    for (const [name, cb] of this.models.entries()) {
      modelState[name] = { state: cb.state, failureCount: cb.failureCount, lastFailure: cb.lastFailureTime };
      totalFailures += cb.failureCount;
      if (cb.lastFailureTime && (!latestFailure || cb.lastFailureTime > latestFailure)) {
        latestFailure = cb.lastFailureTime;
      }
    }
    for (const [name, cb] of this.tools.entries()) {
      toolState[name] = { state: cb.state, failureCount: cb.failureCount, lastFailure: cb.lastFailureTime };
      totalFailures += cb.failureCount;
      if (cb.lastFailureTime && (!latestFailure || cb.lastFailureTime > latestFailure)) {
        latestFailure = cb.lastFailureTime;
      }
    }
    for (const [name, cb] of this.paths.entries()) {
      pathState[name] = { state: cb.state, failureCount: cb.failureCount, lastFailure: cb.lastFailureTime };
      totalFailures += cb.failureCount;
      if (cb.lastFailureTime && (!latestFailure || cb.lastFailureTime > latestFailure)) {
        latestFailure = cb.lastFailureTime;
      }
    }

    return {
      state: 'operational',
      modelState,
      toolState,
      pathState,
      failureCount: totalFailures,
      lastFailure: latestFailure,
    };
  }

  private getMap(kind: 'model' | 'tool' | 'path'): Map<string, CircuitBreakerInstance> {
    switch (kind) {
      case 'model': return this.models;
      case 'tool': return this.tools;
      case 'path': return this.paths;
    }
  }
}

// 单例
let _instance: CircuitBreaker | null = null;
export function getCircuitBreaker(): CircuitBreaker {
  if (!_instance) {
    const cbCfg = (() => { try { return getConfigSection('circuitBreaker'); } catch { return null; } })();
    const config = cbCfg ? {
      failureThreshold: cbCfg.failureThreshold,
      cooldownMs: cbCfg.resetTimeoutMs,
      halfOpenMaxAttempts: cbCfg.halfOpenMaxRequests,
    } : undefined;
    _instance = new CircuitBreaker(config);
  }
  return _instance;
}
