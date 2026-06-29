// LLM Router — unified entry point for all LLM calls with model_payload tracing
import type { ChatMessage, ChatCompletionResponse } from './types';
import { SmartAdapter } from './smart-adapter';
import { agentEventBus, type LLMTaskType, type ModelPayloadEvent } from '@agent-system/events';
import { logger } from './logger';

export interface LLMCallRequest {
  taskType: LLMTaskType;
  messages: ChatMessage[];
  params?: Partial<LLMParams>;
  metadata?: Record<string, any>;
  emitPayload?: boolean;
}

export interface LLMParams {
  temperature: number;
  max_tokens: number;
  reasoning?: string;
}

const TASK_PARAMS: Record<LLMTaskType, Partial<LLMParams>> = {
  intent:    { temperature: 0, max_tokens: 512, reasoning: 'off' },
  decompose: { temperature: 0, max_tokens: 1024, reasoning: 'off' },
  chat:      { temperature: 0.7, max_tokens: 2048 },
  summarize: { temperature: 0, max_tokens: 1024, reasoning: 'off' },
  probe:     { temperature: 0, max_tokens: 256, reasoning: 'off' },
  breakin:   { temperature: 0.7, max_tokens: 1024 },
  subagent:  { temperature: 0.7, max_tokens: 2048 },
};

export class LLMRouter {
  private adapter: SmartAdapter;

  constructor(adapter: SmartAdapter) {
    this.adapter = adapter;
  }

  async call(req: LLMCallRequest): Promise<ChatCompletionResponse> {
    const { taskType, messages, params, emitPayload = true } = req;
    if (emitPayload) this.broadcastPayload(taskType, messages, params);
    return this.adapter.chat(messages);
  }

  async callWithDefaults(req: LLMCallRequest): Promise<ChatCompletionResponse> {
    const defaults = TASK_PARAMS[req.taskType] || {};
    const merged = { ...defaults, ...req.params };
    return this.call({ ...req, params: merged });
  }

  async *callStream(req: LLMCallRequest): AsyncGenerator<string> {
    const { taskType, messages, emitPayload = true } = req;
    if (emitPayload) this.broadcastPayload(taskType, messages, req.params);
    yield* this.adapter.chatStream(messages);
  }

  getDefaults(taskType: LLMTaskType): Partial<LLMParams> {
    return { ...(TASK_PARAMS[taskType] || {}) };
  }

  get rawAdapter(): SmartAdapter { return this.adapter; }

  private broadcastPayload(taskType: LLMTaskType, messages: ChatMessage[], overrideParams?: Partial<LLMParams>): void {
    try {
      const msgs = messages as Array<{ role: string; content: string }>;
      const systemLen  = msgs.filter(m => m.role === 'system').reduce((a, m) => a + (m.content?.length || 0), 0);
      const userLen    = msgs.filter(m => m.role === 'user').reduce((a, m) => a + (m.content?.length || 0), 0);
      const assistantLen = msgs.filter(m => m.role === 'assistant').reduce((a, m) => a + (m.content?.length || 0), 0);
      const defaults = TASK_PARAMS[taskType] || {};
      const merged = { ...defaults, ...overrideParams };

      const payload: ModelPayloadEvent = {
        taskType,
        messages: msgs as any,
        systemPromptLen: systemLen,
        userPromptLen: userLen,
        assistantPromptLen: assistantLen,
        messageCount: msgs.length,
        model: this.adapter.model,
        params: {
          temperature: merged.temperature ?? 0.7,
          max_tokens: merged.max_tokens ?? 2048,
          reasoning: merged.reasoning,
        },
        ts: new Date().toISOString(),
      };
      agentEventBus.emitModelPayload(payload);
      logger.info(`[LLMRouter] 📤 payload: taskType=${taskType}, msgs=${msgs.length}, model=${payload.model}`);
    } catch (err) {
      logger.warn('[LLMRouter] payload broadcast failed:', err);
    }
  }
}

// ── Singleton ──

let _instance: LLMRouter | null = null;

export function initLLMRouter(adapter: SmartAdapter): LLMRouter {
  _instance = new LLMRouter(adapter);
  return _instance;
}

export function getLLMRouter(): LLMRouter {
  if (!_instance) throw new Error('[LLMRouter] 未初始化 — 请先调用 initLLMRouter(adapter)');
  return _instance;
}
