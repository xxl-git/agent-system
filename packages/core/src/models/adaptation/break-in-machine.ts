// 磨合期状态机 (Phase 2C)
// 新模型接入 → 自动探测 → 行为学习 → 稳定 / 劣化
import { CapabilityProbe, type CapabilityProfile } from '../probe/capability-probe';
import { getProfileStore, type InteractionRecord, type ModelProfile } from '../profile/model-profile';
import type { ChatFn } from '../probe/capability-probe';
import logger from '../../logger';
import { getConfigSection } from '../../config/agent-system-config';

export type BreakInStage = 'new' | 'probing' | 'learning' | 'stable' | 'degraded';

export interface BreakInConfig {
  stableThreshold: number;
  degradeThreshold: number;
  reProbeThreshold: number;
  maxHistorySize: number;
  /** 探针并行度（>1 启用并行探测加速） */
  probeConcurrency: number;
}

const DEFAULT_CONFIG: BreakInConfig = {
  stableThreshold: 50,
  degradeThreshold: 5,
  reProbeThreshold: 10,
  maxHistorySize: 500,
  probeConcurrency: 1,
};

export class BreakInMachine {
  private config: BreakInConfig;
  private chatFn: ChatFn | null = null;
  private modelName: string;
  private manualStage: BreakInStage = 'new';

  constructor(modelName: string, config?: Partial<BreakInConfig>) {
    this.modelName = modelName;
    // 从全局配置读取探针并发度
    const probesCfg = (() => { try { return getConfigSection('probes'); } catch { return null; } })();
    const probeConcurrency = probesCfg?.concurrency ?? DEFAULT_CONFIG.probeConcurrency;
    this.config = { ...DEFAULT_CONFIG, ...{ probeConcurrency }, ...config };
  }

  /** 接入新模型：开始磨合 */
  async onboard(chatFn: ChatFn): Promise<CapabilityProfile> {
    this.chatFn = chatFn;

    const profileStore = getProfileStore();
    const existing = profileStore.get(this.modelName);

    if (existing.capability) {
      const probeAge = Date.now() - new Date(existing.capability.probedAt).getTime();
      if (probeAge < 7 * 24 * 3600 * 1000) {
        this.manualStage = existing.stage as BreakInStage;
        logger.info(`[BreakIn] ${this.modelName}: 已有画像 (${this.manualStage})，跳过探测`);
        return existing.capability;
      }
      logger.info(`[BreakIn] ${this.modelName}: 画像已过期，重新探测`);
    }

    logger.info(`[BreakIn] 🔍 ${this.modelName}: 开始能力探测...`);
    const probe = new CapabilityProbe(chatFn, this.modelName);
    const concurrency = this.config.probeConcurrency;
    if (concurrency > 1) {
      logger.info(`[BreakIn] ⚡ 并行探测: concurrency=${concurrency}`);
    }
    const capability = await probe.runAll(undefined, concurrency);

    profileStore.setCapability(this.modelName, capability);
    this.manualStage = 'learning';

    logger.info([
      `[BreakIn] ${this.modelName} 探测完成:`,
      `  综合分: ${(capability.overallScore * 100).toFixed(0)}%`,
      `  阶段: ${this.manualStage}`,
      `  建议: ${capability.recommendations[0] || '无'}`,
      capability.warnings.length > 0 ? `  ⚠️ ${capability.warnings.join(', ')}` : '',
    ].filter(Boolean).join('\n'));

    return capability;
  }

  /** 记录一次交互并自动调整 */
  evaluateInteraction(record: Omit<InteractionRecord, 'timestamp'>): BreakInStage {
    const profileStore = getProfileStore();
    profileStore.recordInteraction(this.modelName, record);

    const profile = profileStore.get(this.modelName);
    const history = profile.interactionHistory;
    const currentStage = (profile.stage as BreakInStage) || this.manualStage;

    // 检测连续失败 → degraded
    const recentFails = this.countRecentConsecutiveFailures(history);
    if (recentFails >= this.config.degradeThreshold && currentStage === 'stable') {
      this.manualStage = 'degraded';
      this.forceStage(profile, 'degraded');
      logger.warn(`[BreakIn] ⚠️ ${this.modelName}: 连续 ${recentFails} 次失败 → degraded`);
      return 'degraded';
    }

    // 检测恢复 → 重新探测
    if (currentStage === 'degraded') {
      const recentSuccess = this.countRecentConsecutiveSuccesses(history);
      if (recentSuccess >= this.config.reProbeThreshold && this.chatFn) {
        logger.info(`[BreakIn] 🔄 ${this.modelName}: 恢复探测...`);
        this.manualStage = 'learning';
        this.forceStage(profile, 'learning');
        this.onboard(this.chatFn).catch(err =>
          logger.warn(`[BreakIn] 恢复探测失败:`, err)
        );
        return 'learning';
      }
    }

    this.manualStage = currentStage as BreakInStage;
    return currentStage as BreakInStage;
  }

  /** 获取当前阶段 */
  getStage(): BreakInStage {
    const profile = getProfileStore().get(this.modelName);
    return (profile.stage as BreakInStage) || this.manualStage;
  }

  /** 获取磨合状态摘要 */
  status(): string {
    return getProfileStore().summary(this.modelName);
  }

  private forceStage(profile: ModelProfile, stage: 'degraded' | 'learning'): void {
    profile.stage = stage;
    profile.updatedAt = new Date().toISOString();
  }

  private countRecentConsecutiveFailures(history: InteractionRecord[], n = 10): number {
    let count = 0;
    for (let i = history.length - 1; i >= Math.max(0, history.length - n); i--) {
      if (!history[i].success) count++;
      else break;
    }
    return count;
  }

  private countRecentConsecutiveSuccesses(history: InteractionRecord[], n = 20): number {
    let count = 0;
    for (let i = history.length - 1; i >= Math.max(0, history.length - n); i--) {
      if (history[i].success) count++;
      else break;
    }
    return count;
  }

  /** 设置实际模型名（探测后由 AgentCore 调用，对齐 config 与 LM Studio 加载名） */
  setModelName(name: string): void {
    this.modelName = name;
  }
}
