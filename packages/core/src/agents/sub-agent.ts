// 多 Agent 协作 — 子 Agent 运行时 (Phase 4)
// 独立上下文、独立模型参数、限时运行
import type { ChatMessage } from '../models/adapters/lmstudio';
import { LMStudioAdapter } from '../models/adapters/lmstudio';
import { getLLMRouter } from '@agent-system/l

/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

lm';
import logger from '../logger';

export interface SubAgentConfig {
  name: string;
  systemPrompt: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface SubAgentResult {
  agentName: string;
  success: boolean;
  output: string;
  durationMs: number;
  error?: string;
  toolCalls?: number;
  tokensUsed?: number;
}

export class SubAgent {
  config: SubAgentConfig;
  private adapter: LMStudioAdapter;
  private messages: ChatMessage[] = [];

  constructor(config: SubAgentConfig) {
    this.config = {
      timeoutMs: 120000,
      maxTokens: 2048,
      temperature: 0.5,
      ...config,
    };
    this.adapter = new LMStudioAdapter();
    if (config.model) {
      this.adapter.setModel(config.model);
    }
    this.messages.push({ role: 'system', content: config.systemPrompt });
  }

  /** 向子 Agent 发送消息并获取结果 */
  async run(task: string): Promise<SubAgentResult> {
    const start = Date.now();
    this.messages.push({ role: 'user', content: task });

    logger.info(`[SubAgent] 🤖 ${this.config.name}: 开始执行 "${task.slice(0, 60)}"`);

    try {
      const alive = await this.adapter.ping();
      if (!alive) {
        return {
          agentName: this.config.name,
          success: false,
          output: '',
          durationMs: Date.now() - start,
          error: 'LM Studio 未连接',
        };
      }

      const response = await getLLMRouter().call({
        taskType: 'subagent',
        messages: this.messages,
        params: { temperature: this.config.temperature, max_tokens: this.config.maxTokens },
      });
      const content = response.choices?.[0]?.message?.content ?? '(无输出)';
      this.messages.push({ role: 'assistant', content });

      logger.info(`[SubAgent] ✅ ${this.config.name}: 完成 (${Date.now() - start}ms)`);

      return {
        agentName: this.config.name,
        success: true,
        output: content,
        durationMs: Date.now() - start,
        tokensUsed: response.usage?.total_tokens,
      };
    } catch (err: unknown) {
      logger.warn(`[SubAgent] ❌ ${this.config.name}: ${errorMessage(err)}`);
      return {
        agentName: this.config.name,
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: errorMessage(err),
      };
    }
  }

  /** 清空上下文重新开始 */
  reset(systemPrompt?: string): void {
    this.messages = [{ role: 'system', content: systemPrompt || this.config.systemPrompt }];
  }
}
