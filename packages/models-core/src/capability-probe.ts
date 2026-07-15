import type { Probe, ProbeCategory } from './probes';
import { STANDARD_PROBES } from './probes';
import type { ChatMessage } f

/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

rom './chat-stub';
import { logger } from './logger';

export interface ProbeResult {
  probeId: string; category: ProbeCategory; passed: boolean;
  durationMs: number; response: string; error?: string;
}
export interface CapabilityScore {
  category: ProbeCategory; score: number; passed: number;
  total: number; criticalFailed: boolean;
}
export interface CapabilityProfile {
  modelName: string; probedAt: string; results: ProbeResult[];
  scores: Record<string, CapabilityScore>; overallScore: number;
  recommendations: string[]; warnings: string[];
  stage: 'probing' | 'learning' | 'stable';
  strategy: BehaviorStrategy;
}
export interface BehaviorStrategy {
  maxTools: number; useCoT: boolean; maxTokens: number;
  temperature: number; parallelToolCalls: boolean;
  retryOnToolError: boolean; promptWrapper: 'minimal' | 'structured' | 'verbose';
}
export type ChatFn = (messages: ChatMessage[]) => Promise<{
  choices?: Array<{ message?: { content?: string; reasoning_content?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>
}>;

export class CapabilityProbe {
  private chatFn: ChatFn; private modelName: string;
  private results: ProbeResult[] = [];
  constructor(chatFn: ChatFn, modelName: string) { this.chatFn = chatFn; this.modelName = modelName; }

  async runAll(probes: Probe[] = STANDARD_PROBES, concurrency = 3): Promise<CapabilityProfile> {
    logger.info(`[Probe] 开始探测模型: ${this.modelName} (${probes.length} 个探针)`);
    this.results = [];
    for (let i = 0; i < probes.length; i += concurrency) {
      const batch = probes.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map((probe, j) => this.runProbe(probe, i + j)));
      for (const result of batchResults) { this.results.push(result); }
    }
    return this.buildProfile();
  }

  private async runProbe(probe: Probe, index: number): Promise<ProbeResult> {
    const start = Date.now();
    const messages: ChatMessage[] = [{ role: 'user', content: probe.prompt }];
    try {
      const response = await this.chatFn(messages);
      const content = response.choices?.[0]?.message?.content ?? '';
      const reasoningContent = response.choices?.[0]?.message?.reasoning_content ?? '';
      const passed = probe.judge(content || reasoningContent);
      return { probeId: probe.id, category: probe.category, passed,
        durationMs: Date.now() - start, response: (content || reasoningContent).slice(0, 200) };
    } catch (err: unknown) {
      return { probeId: probe.id, category: probe.category, passed: false,
        durationMs: Date.now() - start, response: '', error: errorMessage(err) };
    }
  }

  private buildProfile(): CapabilityProfile {
    const scores = this.calcScores();
    const overallScore = Object.values(scores).reduce((sum, s) => sum + s.score, 0) /
      Math.max(1, Object.values(scores).length);
    const recommendations: string[] = [];
    const warnings: string[] = [];
    const toolScore = scores['tool_calling'];
    if (toolScore) {
      if (toolScore.score >= 0.8) recommendations.push('工具调用稳定，可放心使用 parallelToolCalls');
      else if (toolScore.score >= 0.4) { recommendations.push('工具调用基本可用，建议限制 sequential 调用'); warnings.push('工具调用偶发问题，需监控'); }
      else { recommendations.push('工具调用不稳定，建议禁用 parallelToolCalls'); warnings.push('工具调用能力弱，考虑纯文本降级模式'); }
    }
    return { modelName: this.modelName, probedAt: new Date().toISOString(),
      results: this.results, scores, overallScore, recommendations, warnings,
      stage: 'probing', strategy: this.buildStrategy(scores) };
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
      scores[cat] = { category: cat as ProbeCategory, score: Math.max(0, passed / total - (criticalFailed ? 0.3 : 0)), passed, total, criticalFailed };
    }
    return scores;
  }

  private buildStrategy(scores: Record<string, CapabilityScore>): BehaviorStrategy {
    const toolScore = scores['tool_calling']?.score ?? 0;
    const jsonScore = scores['json_output']?.score ?? 0;
    const stabilityScore = scores['stability']?.score ?? 0;
    const overall = toolScore * 0.5 + jsonScore * 0.3 + stabilityScore * 0.2;
    if (overall >= 0.8) return { maxTools: 5, useCoT: false, maxTokens: 4096, temperature: 0.7, parallelToolCalls: true, retryOnToolError: true, promptWrapper: 'minimal' };
    if (overall >= 0.5) return { maxTools: 3, useCoT: toolScore < 0.6, maxTokens: 2048, temperature: 0.5, parallelToolCalls: false, retryOnToolError: true, promptWrapper: 'structured' };
    return { maxTools: 0, useCoT: true, maxTokens: 1024, temperature: 0.3, parallelToolCalls: false, retryOnToolError: false, promptWrapper: 'verbose' };
  }
}
