// 模型画像存储 (Phase 2A)
// 持久化 capabilities.json，支持行为学习更新
import * as fs from 'fs';
import * as path from 'path';
import type { CapabilityProfile, BehaviorStrategy } from '../probe/capability-probe';
import logger from '../../logger';
import { getConfigSection } from '../../config/agent-system-config';

export interface InteractionRecord {
  timestamp: string;
  taskType: string;
  success: boolean;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  tokensUsed?: number;
  notes?: string;
}

export interface ModelProfile {
  modelName: string;
  capability: CapabilityProfile | null;
  behavior: BehaviorStrategy;
  interactionHistory: InteractionRecord[];
  stats: {
    totalInteractions: number;
    successRate: number;
    avgDurationMs: number;
    toolErrorRate: number;
    lastUsed: string;
    preferredTasks: string[];  // 擅长哪些任务类型
  };
  stage: 'probing' | 'learning' | 'stable' | 'degraded';
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_BEHAVIOR: BehaviorStrategy = {
  maxTools: 3,
  useCoT: false,
  maxTokens: 2048,
  temperature: 0.5,
  parallelToolCalls: false,
  retryOnToolError: true,
  promptWrapper: 'structured',
};

export class ModelProfileStore {
  private storeDir: string;
  private memoryCache: Map<string, ModelProfile> = new Map();

  constructor(storeDir: string = './data/profiles') {
    this.storeDir = path.resolve(storeDir);
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
    this.loadAll();
  }

  /** 加载所有画像到内存 */
  private loadAll(): void {
    if (!fs.existsSync(this.storeDir)) return;
    const files = fs.readdirSync(this.storeDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(this.storeDir, file), 'utf-8');
        const profile = JSON.parse(data) as ModelProfile;
        this.memoryCache.set(profile.modelName, profile);
      } catch (err) {
        logger.warn(`[Profile] 解析失败: ${file}`, err);
      }
    }
    logger.debug(`[Profile] 加载了 ${this.memoryCache.size} 个模型画像`);
  }

  /** 获取或创建画像 */
  get(modelName: string): ModelProfile {
    if (this.memoryCache.has(modelName)) {
      return this.memoryCache.get(modelName)!;
    }

    // 创建默认画像
    const profile: ModelProfile = {
      modelName,
      capability: null,
      behavior: { ...DEFAULT_BEHAVIOR },
      interactionHistory: [],
      stats: {
        totalInteractions: 0,
        successRate: 0,
        avgDurationMs: 0,
        toolErrorRate: 0,
        lastUsed: new Date().toISOString(),
        preferredTasks: [],
      },
      stage: 'probing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.memoryCache.set(modelName, profile);
    this.save(modelName);
    return profile;
  }

  /** 更新能力画像（探测完成后调用） */
  setCapability(modelName: string, capability: CapabilityProfile): void {
    const profile = this.get(modelName);
    profile.capability = capability;
    profile.behavior = capability.strategy;
    profile.stage = 'learning';
    profile.updatedAt = new Date().toISOString();
    this.save(modelName);
    logger.info(`[Profile] 📊 ${modelName}: 能力画像已更新 (score=${capability.overallScore.toFixed(2)})`);
  }

  /** 记录一次交互 */
  recordInteraction(
    modelName: string,
    record: Omit<InteractionRecord, 'timestamp'>
  ): void {
    const profile = this.get(modelName);
    const entry: InteractionRecord = {
      ...record,
      timestamp: new Date().toISOString(),
    };

    profile.interactionHistory.push(entry);
    // 只保留最近 200 条
    if (profile.interactionHistory.length > 200) {
      profile.interactionHistory = profile.interactionHistory.slice(-200);
    }

    // 更新统计
    const interactions = profile.interactionHistory;
    profile.stats.totalInteractions = interactions.length;
    profile.stats.successRate = interactions.filter(i => i.success).length / interactions.length;
    profile.stats.avgDurationMs = interactions.reduce((s, i) => s + i.durationMs, 0) / interactions.length;
    profile.stats.toolErrorRate = interactions.reduce((s, i) => s + i.toolErrors, 0) /
      Math.max(1, interactions.reduce((s, i) => s + i.toolCalls, 0));
    profile.stats.lastUsed = entry.timestamp;

    // 跟踪擅长的任务类型
    if (entry.success) {
      if (!profile.stats.preferredTasks.includes(entry.taskType)) {
        profile.stats.preferredTasks.push(entry.taskType);
      }
    }

    // 足够数据 → 标记为稳定
    if (profile.stage === 'learning' && interactions.length >= 50) {
      profile.stage = 'stable';
      logger.info(`[Profile] ✅ ${modelName} 磨合完成 → stable`);
    }

    profile.updatedAt = entry.timestamp;
    this.save(modelName);
  }

  /** 调整策略（行为学习） */
  adjustStrategy(modelName: string, patch: Partial<BehaviorStrategy>): void {
    const profile = this.get(modelName);
    profile.behavior = { ...profile.behavior, ...patch };
    profile.updatedAt = new Date().toISOString();
    this.save(modelName);
    logger.debug(`[Profile] 🔧 ${modelName} 策略调整: ${JSON.stringify(patch)}`);
  }

  /** 列出所有已知模型 */
  listModels(): string[] {
    return Array.from(this.memoryCache.keys());
  }

  /** 获取模型画像摘要 */
  summary(modelName: string): string {
    const profile = this.get(modelName);
    if (!profile.capability) {
      return `${modelName}: 未探测 (${profile.stage})`;
    }

    const c = profile.capability;
    return [
      `🤖 ${modelName}`,
      `   阶段: ${profile.stage}`,
      `   综合分: ${(c.overallScore * 100).toFixed(0)}%`,
      `   成功率: ${(profile.stats.successRate * 100).toFixed(0)}%`,
      `   交互次数: ${profile.stats.totalInteractions}`,
      c.recommendations.length > 0 ? `   建议: ${c.recommendations[0]}` : '',
      c.warnings.length > 0 ? `   ⚠️ ${c.warnings[0]}` : '',
    ].filter(Boolean).join('\n');
  }

  private save(modelName: string): void {
    const profile = this.memoryCache.get(modelName);
    if (!profile) return;

    const safeName = modelName.replace(/[^a-zA-Z0-9\-_.]/g, '_');
    const filePath = path.join(this.storeDir, `${safeName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
  }
}

// 单例
let _instance: ModelProfileStore | null = null;
export function getProfileStore(): ModelProfileStore {
  if (!_instance) {
    const profilesCfg = (() => { try { return getConfigSection('profiles'); } catch { return null; } })();
    const storeDir = profilesCfg?.dataDir || undefined;
    _instance = new ModelProfileStore(storeDir);
  }
  return _instance;
}
