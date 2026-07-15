// 能力探测引擎 (Phase 2A)
// 自动对模型执行探针集，生成能力画像
import type { Probe, ProbeCategory } from './probes';
import { STANDARD_PROBES } from './probes';
import type { ChatMessage } from '../adapters/lmstudio';
import logger from '../../logger';



/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface ProbeResult {
  probeId: string;
  category: ProbeCategory;
  passed: boolean;
  durationMs: number;
  response: string;
  error?: string;
}

export interface CapabilityScore {
  category: ProbeCategory;
  score: number;        // 0.0 - 1.0
  passed: number;
  total: number;
  criticalFailed: boolean;
}

export interface CapabilityProfile {
  modelName: string;
  probedAt: string;
  results: ProbeResult[];
  scores: Record<string, CapabilityScore>;
  overallScore: number; // 0.0 - 1.0
  recommendations: string[];
  warnings: string[];
  /** 磨合阶段 */
  stage: 'probing' | 'learning' | 'stable';
  /** 建议：最大工具数、是否需要 CoT、平行调用 */
  strategy: BehaviorStrategy;
}

export interface BehaviorStrategy {
  maxTools: number;
  useCoT: boolean;
  maxTokens: number;
  temperature: number;
  parallelToolCalls: boolean;
  retryOnToolError: boolean;
  promptWrapper: 'minimal' | 'structured' | 'verbose';
}

/** Chat 函数签名 — 适配器注入 */
export type ChatFn = (messages: ChatMessage[]) => Promise<{
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    }
  }>;
}>;

export class CapabilityProbe {
  private chatFn: ChatFn;
  private modelName: string;
  private results: ProbeResult[] = [];

  constructor(chatFn: ChatFn, modelName: string) {
    this.chatFn = chatFn;
    this.modelName = modelName;
  }

  /** 执行完整探测 — 支持并行批次执行 */
  async runAll(probes: Probe[] = STANDARD_PROBES, concurrency = 3): Promise<CapabilityProfile> {
    logger.info(`[Probe] 🔍 开始探测模型: ${this.modelName} (${probes.length} 个探针, concurrency=${concurrency})`);
    this.results = [];

    // 按批次并行执行：每批 concurrency 个探针并行跑
    for (let i = 0; i < probes.length; i += concurrency) {
      const batch = probes.slice(i, i + concurrency);
      logger.info(`[Probe] ⏳ 批次 #${Math.floor(i / concurrency) + 1}: ${batch.map(p => p.id).join(', ')}`);
      const batchResults = await Promise.all(batch.map((probe, j) =>
        this.runProbe(probe, i + j)
      ));
      for (const result of batchResults) {
        this.results.push(result);
        const icon = result.passed ? '✅' : '❌';
        logger.info(`[Probe] ${icon} ${result.probeId} (${result.durationMs}ms)`);
      }
    }

    return this.buildProfile();
  }

  /** 执行单个探针 */
  private async runProbe(probe: Probe, index: number): Promise<ProbeResult> {
    const start = Date.now();
    const messages: ChatMessage[] = [{ role: 'user', content: probe.prompt }];

    logger.info(`[Probe] ▶ #${index + 1} ${probe.id} (${probe.category}): "${probe.prompt.slice(0, 60)}..."`);

    try {
      // 超时由 SmartAdapter 统一控制（callTimeoutMs=30s），避免 Probe 和 Adapter 双重超时竞争
      const response = await this.chatFn(messages);
      const content = response.choices?.[0]?.message?.content ?? '';
      const reasoningContent = response.choices?.[0]?.message?.reasoning_content ?? '';
      const toolCalls = response.choices?.[0]?.message?.tool_calls;

      // 也分析 tool_calls 内容
      let fullResponse = content || reasoningContent;
      if (toolCalls && toolCalls.length > 0) {
        const callsStr = toolCalls
          .map(tc => tc.function?.name || '(empty)')
          .join(', ');
        fullResponse += `\n[TOOL_CALLS: ${callsStr}]`;
      }

      const duration = Date.now() - start;
      const passed = probe.judge(content || reasoningContent);

      logger.info(`[Probe] ${passed ? '✅' : '❌'} #${index + 1} ${probe.id} (${duration}ms) content=${content.length}字 reasoning=${reasoningContent.length}字 passed=${passed}`);
      logger.debug(`[Probe] ${probe.id} response: ${(content || reasoningContent).slice(0, 150)}`);

      // 超时警告
      if (probe.expectedMs && duration > probe.expectedMs) {
        logger.warn(`[Probe] ⚠️ ${probe.id} 超时: ${duration}ms > ${probe.expectedMs}ms`);
      }

      return {
        probeId: probe.id,
        category: probe.category,
        passed,
        durationMs: duration,
        response: fullResponse.slice(0, 200),
      };
    } catch (err: unknown) {
      logger.warn(`[Probe] ❌ #${index + 1} ${probe.id} error: ${errorMessage(err)} (${Date.now() - start}ms)`);
      return {
        probeId: probe.id,
        category: probe.category,
        passed: false,
        durationMs: Date.now() - start,
        response: '',
        error: errorMessage(err),
      };
    }
  }

  /** 构建能力画像 */
  private buildProfile(): CapabilityProfile {
    const scores = this.calcScores();
    const overallScore = Object.values(scores).reduce((sum, s) => sum + s.score, 0) /
      Object.values(scores).length;

    const recommendations: string[] = [];
    const warnings: string[] = [];

    // 工具调用分析
    const toolScore = scores['tool_calling'];
    if (toolScore) {
      if (toolScore.score >= 0.8) {
        recommendations.push('工具调用稳定，可放心使用 parallelToolCalls');
      } else if (toolScore.score >= 0.4) {
        recommendations.push('工具调用基本可用，建议限制 sequential 调用');
        warnings.push('工具调用偶发问题，需监控');
      } else {
        recommendations.push('工具调用不稳定，建议禁用 parallelToolCalls');
        warnings.push('工具调用能力弱，考虑纯文本降级模式');
      }
    }

    // JSON 分析
    const jsonScore = scores['json_output'];
    if (jsonScore && jsonScore.score < 0.5) {
      recommendations.push('JSON 输出不稳定，建议使用 structured prompt wrapper');
    }

    // 速度分析
    const contextProbe = this.results.find(r => r.probeId === 'context_8k');
    if (contextProbe && !contextProbe.passed) {
      warnings.push('8K 上下文测试失败，可能上下文窗口较小');
      recommendations.push('建议分块发送长上下文');
    }

    // 生成策略
    const strategy = this.buildStrategy(scores);

    return {
      modelName: this.modelName,
      probedAt: new Date().toISOString(),
      results: this.results,
      scores,
      overallScore,
      recommendations,
      warnings,
      stage: 'probing',
      strategy,
    };
  }

  private calcScores(): Record<string, CapabilityScore> {
    const byCategory = new Map<string, ProbeResult[]>();
    for (const r of this.results) {
      if (!byCategory.has(r.category)) byCategory.set(r.category, []);
      byCategory.get(r.category)!.push(r);
    }

    const scores: Record<string, CapabilityScore> = {};
    for (const [cat, results] of byCategory) {
      const passed = results.filter(r => r.passed).length;
      const total = results.length;
      const criticalFailed = results.some(r => {
        const probe = STANDARD_PROBES.find(p => p.id === r.probeId);
        return probe?.critical && !r.passed;
      });

      // 加权：关键探针失败严重拉低分数
      const rawScore = passed / total;
      const penalty = criticalFailed ? 0.3 : 0;
      const score = Math.max(0, rawScore - penalty);

      scores[cat] = { category: cat as ProbeCategory, score, passed, total, criticalFailed };
    }
    return scores;
  }

  private buildStrategy(scores: Record<string, CapabilityScore>): BehaviorStrategy {
    const toolScore = scores['tool_calling']?.score ?? 0;
    const jsonScore = scores['json_output']?.score ?? 0;
    const stabilityScore = scores['stability']?.score ?? 0;
    const overallToolScore = (toolScore * 0.5 + jsonScore * 0.3 + stabilityScore * 0.2);

    if (overallToolScore >= 0.8) {
      return {
        maxTools: 5,
        useCoT: false,
        maxTokens: 4096,
        temperature: 0.7,
        parallelToolCalls: true,
        retryOnToolError: true,
        promptWrapper: 'minimal',
      };
    } else if (overallToolScore >= 0.5) {
      return {
        maxTools: 3,
        useCoT: toolScore < 0.6,
        maxTokens: 2048,
        temperature: 0.5,
        parallelToolCalls: false,
        retryOnToolError: true,
        promptWrapper: 'structured',
      };
    } else {
      return {
        maxTools: 0,
        useCoT: true,
        maxTokens: 1024,
        temperature: 0.3,
        parallelToolCalls: false,
        retryOnToolError: false,
        promptWrapper: 'verbose',
      };
    }
  }
}
