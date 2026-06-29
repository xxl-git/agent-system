// 统一 LLM 调用路由 — 所有 LLM 调用的唯一入口
// 职责：广播 model_payload（全链路可观测）+ 按任务类型自动参数
import type { ChatMessage, ChatCompletionResponse } from '../models/adapters/lmstudio';
import { SmartAdapter } from '../core/smart-adapter';
import { agentEventBus, type LLMTaskType, type ModelPayloadEvent } from '../core/agent-event-bus';
import logger from '../logger';

export interface LLMCallRequest {
  /** 任务类型 — 用于调试面板分类和参数策略 */
  taskType: LLMTaskType;
  /** 发送给模型的 messages */
  messages: ChatMessage[];
  /** 覆盖默认参数（可选） */
  params?: Partial<LLMParams>;
  /** 元数据（可选，透传到 payload 事件） */
  metadata?: Record<string, any>;
  /** 是否广播 payload（默认 true） */
  emitPayload?: boolean;
}

export interface LLMParams {
  temperature: number;
  max_tokens: number;
  reasoning?: string;
}

/** 按任务类型默认参数策略 */
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

  /** 统一调用入口 */
  async call(req: LLMCallRequest): Promise<ChatCompletionResponse> {
    const { taskType, messages, params, emitPayload = true } = req;

    // 广播 payload（在调用 LLM 之前）
    if (emitPayload) {
      this.broadcastPayload(taskType, messages, params);
    }

    // 调用底层适配器
    return this.adapter.chat(messages);
  }

  /** 带默认参数的快捷方法 */
  async callWithDefaults(req: LLMCallRequest): Promise<ChatCompletionResponse> {
    const defaults = TASK_PARAMS[req.taskType] || {};
    // params 如果传入则优先级更高
    const merged = { ...defaults, ...req.params };
    return this.call({ ...req, params: merged });
  }

  /**
   * 流式调用入口 — 广播 payload 后调用 adapter.chatStream()
   * 逐 chunk yield 字符串
   */
  async *callStream(req: LLMCallRequest): AsyncGenerator<string> {
    const { taskType, messages, emitPayload = true } = req;

    // 广播 payload（在调用 LLM 之前）
    if (emitPayload) {
      this.broadcastPayload(taskType, messages, req.params);
    }

    // 调用底层适配器的流式方法
    yield* this.adapter.chatStream(messages);
  }

  /** 获取任务类型的默认参数 */
  getDefaults(taskType: LLMTaskType): Partial<LLMParams> {
    return { ...(TASK_PARAMS[taskType] || {}) };
  }

  /** 底层适配器引用（向后兼容） */
  get rawAdapter(): SmartAdapter {
    return this.adapter;
  }

  /** 广播 model_payload 事件 */
  private broadcastPayload(
    taskType: LLMTaskType,
    messages: ChatMessage[],
    overrideParams?: Partial<LLMParams>,
  ): void {
    try {
      // 计算各角色长度
      const msgs = messages as Array<{ role: string; content: string }>;
      const systemLen = msgs.filter(m => m.role === 'system').reduce((a, m) => a + (m.content?.length || 0), 0);
      const userLen = msgs.filter(m => m.role === 'user').reduce((a, m) => a + (m.content?.length || 0), 0);
      const assistantLen = msgs.filter(m => m.role === 'assistant').reduce((a, m) => a + (m.content?.length || 0), 0);

      // 合并默认参数 + 覆盖参数
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
      // 广播失败不影响主流程
      logger.warn('[LLMRouter] payload broadcast failed:', err);
    }
  }
}

// ── 单例 ──

let _instance: LLMRouter | null = null;

export function initLLMRouter(adapter: SmartAdapter): LLMRouter {
  _instance = new LLMRouter(adapter);
  return _instance;
}

export function getLLMRouter(): LLMRouter {
  if (!_instance) {
    throw new Error('[LLMRouter] 未初始化 — 请先调用 initLLMRouter(adapter)');
  }
  return _instance;
}
