// 智能路由器 (Phase 2B)
// 难度评估 → 模型选择 → 成本控制 → 兜底切换
import { assessDifficulty, type DifficultyReport } from './difficulty-assessor';
import { getProfileStore, type ModelProfile } from '../profile/model-profile';
import logger from '../../logger';

export interface ModelEndpoint {
  name: string;
  provider: 'lmstudio' | 'openai' | 'deepseek' | 'claude' | 'ollama';
  baseUrl: string;
  apiKey: string;
  model: string;
  costPer1kTokens?: number;  // 美元
  maxTokens: number;
  local: boolean;            // 本地模型？
  enabled: boolean;
  priority: number;          // 同级别内优先级，越小越高
}

export interface RouterDecision {
  selected: ModelEndpoint;
  fallback: ModelEndpoint | null;
  difficulty: DifficultyReport;
  reason: string;
  costEstimate: number;
}

export interface RouterConfig {
  localBudgetMonthly: number;  // 在线模型月度预算 $
  maxLocalAttempts: number;
  fallbackOnFailure: boolean;
  endpoints: ModelEndpoint[];
}

const DEFAULT_ENDPOINTS: ModelEndpoint[] = [
  {
    name: 'lmstudio',
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'not-needed',
    model: 'qwen3.6-35b-a3b-mtp',
    maxTokens: 131072,
    local: true,
    enabled: true,
    priority: 1,
  },
  {
    name: 'deepseek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    costPer1kTokens: 0.00014,
    maxTokens: 65536,
    local: false,
    enabled: true,
    priority: 2,
  },
];

export class SmartRouter {
  config: RouterConfig;
  private fallbackStack: Map<string, ModelEndpoint[]> = new Map();
  private costUsedThisMonth = 0;

  constructor(config?: Partial<RouterConfig>) {
    this.config = {
      localBudgetMonthly: 5,
      maxLocalAttempts: 2,
      fallbackOnFailure: true,
      endpoints: [...DEFAULT_ENDPOINTS],
      ...config,
    };

    // 构建兜底链：每个端点 → 可用的备选列表
    for (const ep of this.config.endpoints) {
      const fallbacks = this.config.endpoints.filter(
        f => f.name !== ep.name && f.enabled
      );
      // 排序：本地优先、同 provider 优先、priority 低优先
      fallbacks.sort((a, b) => {
        if (a.local !== b.local) return a.local ? -1 : 1;
        return a.priority - b.priority;
      });
      this.fallbackStack.set(ep.name, fallbacks);
    }
    logger.debug(`[Router] 已配置 ${this.config.endpoints.length} 个端点`);
  }

  /** 选择最佳模型 */
  selectModel(userInput: string, toolCount = 0): RouterDecision {
    const difficulty = assessDifficulty(userInput, toolCount);

    // 根据难度筛选候选
    const localCandidates = this.config.endpoints.filter(e => e.local && e.enabled);
    const onlineCandidates = this.config.endpoints.filter(e => !e.local && e.enabled);

    let selected: ModelEndpoint;
    let fallback: ModelEndpoint | null = null;
    let reason: string;

    switch (difficulty.level) {
      case 'trivial':
      case 'simple': {
        // 本地优先
        if (localCandidates.length > 0) {
          selected = localCandidates.sort((a, b) => a.priority - b.priority)[0];
          reason = `简单任务 → 本地模型 ${selected.name}`;
        } else {
          selected = onlineCandidates[0] || this.anyEndpoint();
          reason = '无可用本地模型，使用在线';
        }
        break;
      }

      case 'moderate': {
        // 本地优先，但检查模型能力
        if (localCandidates.length > 0) {
          const bestLocal = this.pickBestLocalForDifficultTask(localCandidates, difficulty);
          selected = bestLocal;
          // 设置在线兜底
          if (onlineCandidates.length > 0) {
            fallback = onlineCandidates.sort(
              (a, b) => (a.costPer1kTokens || 999) - (b.costPer1kTokens || 999)
            )[0];
          }
          reason = `中等任务 → 本地模型 ${selected.name} (兜底: ${fallback?.name || '无'})`;
        } else {
          selected = onlineCandidates[0] || this.anyEndpoint();
          reason = '无本地模型，使用在线';
        }
        break;
      }

      case 'complex':
      case 'hard':
      default: {
        // 在线优先（高推理需求）
        if (onlineCandidates.length > 0 && this.costUsedThisMonth < this.config.localBudgetMonthly) {
          selected = onlineCandidates.sort(
            (a, b) => (a.costPer1kTokens || 999) - (b.costPer1kTokens || 999)
          )[0];
          // 在线挂了用本地
          if (localCandidates.length > 0) {
            fallback = localCandidates.sort((a, b) => a.priority - b.priority)[0];
          }
          reason = `高难度任务 → 在线模型 ${selected.name} (月度预算剩余: $${(this.config.localBudgetMonthly - this.costUsedThisMonth).toFixed(2)})`;
        } else if (localCandidates.length > 0) {
          selected = this.pickBestLocalForDifficultTask(localCandidates, difficulty);
          reason = `预算超限/无在线 → 降级本地模型 ${selected.name} + CoT`;
        } else {
          selected = this.anyEndpoint();
          reason = '无可用模型（紧急兜底）';
        }
        break;
      }
    }

    // 估算成本
    const costEstimate = selected.costPer1kTokens
      ? (selected.costPer1kTokens * (userInput.length / 4 / 1000))  // 粗略估计
      : 0;

    const decision: RouterDecision = {
      selected,
      fallback,
      difficulty,
      reason,
      costEstimate,
    };

    logger.info(`[Router] 🧭 ${reason}`);
    return decision;
  }

  /** 记录实际成本 */
  recordCost(tokens: number, endpoint: ModelEndpoint): void {
    if (endpoint.costPer1kTokens) {
      this.costUsedThisMonth += (tokens / 1000) * endpoint.costPer1kTokens;
    }
  }

  /** 查找兜底 */
  getFallback(endpointName: string): ModelEndpoint | null {
    const fallbacks = this.fallbackStack.get(endpointName);
    if (!fallbacks || fallbacks.length === 0) return null;
    return fallbacks[0];
  }

  /** 选择最适合本地的模型（考虑画像） */
  private pickBestLocalForDifficultTask(
    candidates: ModelEndpoint[],
    difficulty: DifficultyReport
  ): ModelEndpoint {
    const profileStore = getProfileStore();

    let best: ModelEndpoint | null = null;
    let bestScore = -1;

    for (const ep of candidates) {
      let score = 0;
      // priority 越低越好
      score += (10 - ep.priority) * 5;

      // 模型画像加成
      try {
        const profile = profileStore.get(ep.model);
        if (profile.capability) {
          score += profile.capability.overallScore * 30;
        }
        if (profile.stage === 'stable') score += 10;
      } catch { /* 无画像不扣分 */ }

      // 上下文窗口够大？
      if (ep.maxTokens >= 32000) score += 10;

      if (score > bestScore) {
        bestScore = score;
        best = ep;
      }
    }

    return best || candidates[0];
  }

  private anyEndpoint(): ModelEndpoint {
    return this.config.endpoints.find(e => e.enabled) || this.config.endpoints[0];
  }

  /** 获取端点状态摘要 */
  status(): string {
    const lines = ['🧭 智能路由状态:'];
    for (const ep of this.config.endpoints) {
      const profileStore = getProfileStore();
      let profileInfo = '';
      try {
        const p = profileStore.get(ep.model);
        profileInfo = p.capability ? ` (综合:${(p.capability.overallScore * 100).toFixed(0)}% ${p.stage})` : ' (未探测)';
      } catch { /* ignore */ }

      lines.push(`  ${ep.enabled ? '✅' : '❌'} ${ep.name} [${ep.local ? '本地' : '在线'}] ${ep.model}${profileInfo}`);
    }
    lines.push(`  💰 月度在线预算: $${(this.config.localBudgetMonthly - this.costUsedThisMonth).toFixed(2)} / $${this.config.localBudgetMonthly}`);
    return lines.join('\n');
  }
}

// 单例
let _instance: SmartRouter | null = null;
export function getRouter(config?: Partial<RouterConfig>): SmartRouter {
  if (!_instance) _instance = new SmartRouter(config);
  return _instance;
}
