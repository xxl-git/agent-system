// LM Studio 适配器 — OpenAI 兼容 + v1 REST API 双路由 (Phase 7)
// 
// 默认使用 OpenAI 兼容端点（/v1/chat/completions）；
// 设置 reasoning 后自动切换到 v1 REST API（/api/v1/chat）并传递 reasoning 参数。
//
// v1 参考文档：https://lmstudio.ai/docs/developer/rest/chat
import { getConfig } from '../../config';
import logger from '../../logger';


/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}


export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
      reasoning_content?: string;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LMStudioModel {
  id: string;
  object: 'model';
  type: string;          // 'llm' | 'embedding' | 'unknown'
  publisher: string;
  arch: string;
  context_length: number;
  display_name?: string;  // 人类可读名称（如 'Qwen3.6 35B A3B'）
  quantization?: string;  // 量化方式（如 'Q4_K_M'）
  params_string?: string; // 参数量（如 '35B-A3B'）
  size_bytes?: number;    // 模型文件大小
  loaded: boolean;        // 是否已加载到内存
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: boolean;
  };
}

/** LM Studio v1 响应中的 output item 类型 */
interface V1OutputItem {
  type: 'message' | 'reasoning' | 'tool_call' | 'invalid_tool_call';
  content?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  reason?: string;
  provider_info?: Record<string, unknown>;
}

/** LM Studio v1 完整响应 */
interface V1ChatResponse {
  model_instance_id: string;
  output: V1OutputItem[];
  stats: {
    input_tokens: number;
    total_output_tokens: number;
    reasoning_output_tokens: number;
    tokens_per_second: number;
    time_to_first_token_seconds: number;
    model_load_time_seconds?: number;
  };
  response_id?: string;
}

/** Reasoning 级别 */
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'on';

export class LMStudioAdapter {
  private baseUrl: string;
  private v1BaseUrl: string;
  public model: string;
  private timeoutMs: number;
  public maxTokens: number;
  /** 模型实际上下文长度（从 listModels 获取） */
  public contextLength: number = 4096;
  /** 当前是否处于压缩后新会话 */
  private _sessionReset: boolean = false;
  /** reasoning 级别（设置后走 v1 API） */
  private _reasoning?: ReasoningLevel;
  /** v1 API 是否因 reasoning 参数不支持而被禁用 */
  private _v1Unsupported = false;

  constructor() {
    const cfg = getConfig();
    const provider = cfg.models.providers.lmstudio;
    this.baseUrl = provider.baseUrl;
    // 从 OpenAI 兼容 baseUrl（http://host:port/v1）推导 v1 API 的 baseUrl（http://host:port/api/v1）
    this.v1BaseUrl = this.baseUrl.replace(/\/v1\/?$/, '/api/v1');
    this.model = provider.model;
    this.timeoutMs = Math.min(provider.timeoutMs || 60000, 60000);
    this.maxTokens = provider.maxOutputTokens || 2048;

    // 自动读取 reasoning 配置（如有）
    if (provider.reasoning) {
      this._reasoning = provider.reasoning;
      logger.info(`[LMStudio] reasoning 从 config 自动加载: ${provider.reasoning}`);
    }
  }

  // ── Reasoning 控制 ──

  /** 设置 reasoning 级别（设置后 chat() 走 v1 API 并携带 reasoning 参数） */
  setReasoning(level: ReasoningLevel): void {
    this._reasoning = level;
    logger.info(`[LMStudio] reasoning 模式: ${level}`);
  }

  /** 清除 reasoning 设置（恢复 OpenAI 兼容端点默认行为） */
  clearReasoning(): void {
    this._reasoning = undefined;
    logger.info('[LMStudio] reasoning 恢复默认（OpenAI 兼容端点）');
  }

  /** 获取当前 reasoning 级别 */
  getReasoning(): ReasoningLevel | undefined {
    return this._reasoning;
  }

  /** 是否启用了 reasoning 控制 */
  hasReasoning(): boolean {
    return this._reasoning !== undefined;
  }

  /**
   * 标记会话边界：下次 chat() 视为一个全新的独立对话
   * 对 OpenAI 兼容 API 来说这是语义标记（messages 数组本身是自包含的）；
   * 对 stateful API（v1 previous_response_id 模式），下次请求不传 previous_response_id
   */
  markSessionReset(): void {
    this._sessionReset = true;
    logger.info('[LMStudio] 会话边界标记 — 下次请求开启新会话');
  }

  /** 查询是否处于会话边界状态 */
  isSessionReset(): boolean {
    return this._sessionReset;
  }

  /** 清除会话边界标记 */
  clearSessionReset(): void {
    this._sessionReset = false;
  }

  /**
   * 获取有效的上下文预算（用于 context manager 触发压缩）
   * 返回模型实际上下文长度的 80%，减去 max_tokens 输出预算，再减去安全边际
   */
  getEffectiveContextWindow(): number {
    const rawContext = this.contextLength || 4096;
    const forInput = Math.floor(rawContext * 0.80);
    const effectiveMax = Math.floor(forInput * 0.85);
    logger.debug(`[LMStudio] 有效上下文窗口: ${rawContext}×0.80×0.85 = ${effectiveMax}`);
    return effectiveMax;
  }

  // ── 主入口：根据 reasoning 状态路由（自动探测 v1 支持） ──

  /**
   * 聊天（自动路由）
   * - reasoning 未设置或设为 off → OpenAI 兼容端点
   * - reasoning 已设置且 v1 未被标记为不支持 → 尝试 v1 API
   * - v1 调用失败时，若错误与 reasoning 参数相关，自动禁用 v1 并降级到 OpenAI 兼容
   */
  async chat(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
    // reasoning 未设置，或设为 off，或已探测到 v1 不支持 → 走 OpenAI 兼容端点
    if (!this._reasoning || this._reasoning === 'off' || this._v1Unsupported) {
      return this.chatOpenAI(messages);
    }
    // reasoning 已设置（且不是 off）且 v1 尚未被标记为不支持 → 尝试 v1 API
    try {
      return await this.chatV1(messages);
    } catch (err: unknown) {
      // 如果 v1 失败是因为 reasoning 参数不支持，禁用 v1 并降级
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('reasoning') || errMsg.includes('reasoning configuration')) {
        logger.warn(`[LMStudio] 模型 ${this.model} 不支持 reasoning 参数，禁用 v1 API，后续改用 OpenAI 兼容端点`);
        this._v1Unsupported = true;
        return this.chatOpenAI(messages);
      }
      throw err;
    }
  }

  // ── OpenAI 兼容端点（原逻辑） ──

  private async chatOpenAI(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model: this.model,
      messages,
      temperature: 0.7,
      max_tokens: this.maxTokens,
      tool_choice: 'none' as const,
      parallel_tool_calls: false,
    };

    const lastMsg = messages[messages.length - 1];
    logger.info(`[LMStudio] >> ${this.model} msgs=${messages.length} last=${(lastMsg?.content || '').slice(0, 80)}`);
    logger.debug(`[LMStudio] >> POST ${url} body=${JSON.stringify(payload).slice(0, 500)}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn(`[LMStudio] << HTTP ${res.status}: ${text.slice(0, 200)}`);
      throw new Error(`LM Studio HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const contentLen = (choice?.message?.content || '').length;
    const reasoningLen = (choice?.message?.reasoning_content || '').length;
    // 推理模型可能把输出放在 reasoning_content，content 为空 → 移入 content
    if (choice?.message && !choice.message.content && choice.message.reasoning_content) {
      choice.message.content = choice.message.reasoning_content;
      choice.message.reasoning_content = '';
      logger.warn(`[LMStudio] content 为空，已将 reasoning_content(${(choice.message.reasoning_content || '').length}字) 移入 content`);
    }
    const rcNote = (choice?.message?.reasoning_content || '').length ? ` reasoning=${(choice.message.reasoning_content || '').length}字` : '';
    logger.info(`[LMStudio] << ${res.status} ${(choice?.message?.content || '').length}字${rcNote} finish=${choice?.finish_reason} ${Date.now() - 0}ms`);
    if (rcNote) {
      logger.debug(`[LMStudio] reasoning_content (${reasoningLen}字): ${choice!.message.reasoning_content!.slice(0, 200)}...`);
    }
    return data;
  }

  // ── v1 REST API（支持 reasoning 参数） ──

  private async chatV1(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
    const url = `${this.v1BaseUrl}/chat`;

    // 将 messages 分成 system_prompt 和 input 数组
    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');
    const systemPrompt = systemMsgs.map(m => m.content).join('\n');
    const input = nonSystemMsgs.map(m => ({ type: 'text' as const, content: m.content }));

    // 构建 v1 payload
    const payload: Record<string, unknown> = {
      model: this.model,
      input,
      reasoning: this._reasoning,
      max_output_tokens: this.maxTokens,
      temperature: 0.7,
      stream: false,
    };
    if (systemPrompt) {
      payload.system_prompt = systemPrompt;
    }
    // 如果在上次响应后标记了新会话，不传 previous_response_id
    // （当前实现不使用 stateful chat，所以这里不需要处理）

    const lastMsg = messages[messages.length - 1];
    logger.info(`[LMStudio][v1] >> ${this.model} reasoning=${this._reasoning} msgs=${messages.length} last=${(lastMsg?.content || '').slice(0, 80)}`);
    logger.debug(`[LMStudio][v1] >> POST ${url} body=${JSON.stringify(payload).slice(0, 500)}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn(`[LMStudio][v1] << HTTP ${res.status}: ${text.slice(0, 200)}`);
      throw new Error(`LM Studio v1 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json() as V1ChatResponse;
    return this.v1ResponseToOpenAI(data);
  }

  /** 将 v1 API 响应映射为 OpenAI 兼容格式 */
  private v1ResponseToOpenAI(v1: V1ChatResponse): ChatCompletionResponse {
    // 提取 reasoning 和 message 片段
    const reasoningParts: string[] = [];
    const messageParts: string[] = [];

    for (const item of v1.output) {
      if (item.type === 'reasoning' && item.content) {
        reasoningParts.push(item.content);
      } else if (item.type === 'message' && item.content) {
        messageParts.push(item.content);
      }
    }

    const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join('\n') : undefined;
    const content = messageParts.join('\n');

    logger.info(`[LMStudio][v1] << ${content.length}字${reasoningContent ? ` reasoning=${reasoningContent.length}字` : ''} tokens_in=${v1.stats.input_tokens} out=${v1.stats.total_output_tokens}`);

    return {
      choices: [{
        message: {
          role: 'assistant',
          content,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        },
        finish_reason: reasoningParts.length > 0 && messageParts.length === 0
          ? 'reasoning'
          : 'stop',
      }],
      usage: {
        prompt_tokens: v1.stats.input_tokens,
        completion_tokens: v1.stats.total_output_tokens,
        total_tokens: v1.stats.input_tokens + v1.stats.total_output_tokens,
      },
    };
  }

  // ── 模型发现 ──

  /**
   * 获取 LM Studio 中已加载的模型列表（OpenAI 兼容端点 /v1/models）
   * 只返回当前已加载到内存的模型
   */
  async listModels(): Promise<LMStudioModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];

      const json: any = await res.json();
      const list: LMStudioModel[] = Array.isArray(json.data) ? json.data : [];
      return list;
    } catch (err) {
      logger.warn('[LMStudio] 获取已加载模型列表失败', err);
      return [];
    }
  }

  /**
   * 获取 LM Studio 中所有可用模型（含加载状态）
   * 调用 LM Studio REST API (/api/v1/models)，返回本地所有已下载的模型，
   * 通过 loaded_instances 字段判断是否已加载到内存。
   * 同时合并 /v1/models 的在线状态以确保准确性。
   */
  async listAllModels(): Promise<LMStudioModel[]> {
    try {
      // 1. 获取已加载模型 ID 集合（用于准确判断加载状态）
      const loadedModels = await this.listModels();
      const loadedIds = new Set(loadedModels.map(m => m.id));

      // 2. 获取所有可用模型（REST API）
      const res = await fetch(`${this.v1BaseUrl}/models`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        // REST API 不可用时，只返回已加载模型
        return loadedModels.map(m => ({ ...m, loaded: true }));
      }

      const json: any = await res.json();
      const rawModels: any[] = Array.isArray(json.models) ? json.models : [];

      // 3. 合并信息：以 loaded_instances 为主，/v1/models 为辅
      const allModels: LMStudioModel[] = rawModels.map((m: any) => {
        const hasLoadedInstance = Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0;
        const isLoaded = hasLoadedInstance || loadedIds.has(m.key);
        // 从 loaded_instances 提取实际上下文长度（如果已加载）
        let actualCtx = m.max_context_length || 0;
        if (hasLoadedInstance) {
          const inst = m.loaded_instances[0];
          if (inst?.config?.context_length) {
            actualCtx = inst.config.context_length;
          }
        }
        return {
          id: m.key,
          object: 'model' as const,
          type: m.type || 'llm',
          publisher: m.publisher || 'unknown',
          arch: m.architecture || 'unknown',
          context_length: actualCtx,
          display_name: m.display_name,
          quantization: m.quantization?.name,
          params_string: m.params_string || undefined,
          size_bytes: m.size_bytes,
          loaded: isLoaded,
          capabilities: {
            vision: m.capabilities?.vision || false,
            trained_for_tool_use: m.capabilities?.trained_for_tool_use || false,
            reasoning: !!m.capabilities?.reasoning,
          },
        };
      });

      // 4. 确保已加载但不在 REST API 列表中的模型也包含在内
      for (const lm of loadedModels) {
        if (!allModels.some(am => am.id === lm.id)) {
          allModels.push({ ...lm, loaded: true });
        }
      }

      return allModels;
    } catch (err) {
      logger.warn('[LMStudio] 获取所有模型列表失败，降级为已加载模型', err);
      const loaded = await this.listModels();
      return loaded.map(m => ({ ...m, loaded: true }));
    }
  }

  /** 检测当前加载的模型 */
  async getCurrentModel(): Promise<string> {
    const models = await this.listModels();
    if (models.length > 0) {
      this.model = models[0].id;
      if (models[0].context_length) {
        this.contextLength = models[0].context_length;
        logger.info(`[LMStudio] 模型 ${this.model} 上下文: ${this.contextLength} tokens`);
      }
    } else if (this.model) {
      logger.warn(`[LMStudio] 模型列表为空，保留上次模型名: ${this.model}（LM Studio 可能未运行或未加载模型）`);
    } else {
      logger.warn(`[LMStudio] 模型列表为空且无历史模型名，配置可能异常`);
    }
    return this.model;
  }

  /** 切换模型 */
  setModel(modelName: string): void {
    this.model = modelName;
    logger.info(`[LMStudio] 模型切换: ${modelName}`);
  }

  /**
   * 加载模型到内存（LM Studio REST API）
   * @param modelKey 模型标识符（如 'qwen/qwen3-1.7b'）
   * @param options 可选参数：context_length, flash_attention, eval_batch_size, num_experts
   * @returns 加载结果，包含 instance_id 和 load_time_seconds
   */
  async loadModel(modelKey: string, options?: {
    context_length?: number;
    flash_attention?: boolean;
    eval_batch_size?: number;
    num_experts?: number;
    offload_kv_cache_to_gpu?: boolean;
  }): Promise<{
    type: string;
    instance_id: string;
    load_time_seconds: number;
    status: string;
  }> {
    const body: any = { model: modelKey, ...options };
    logger.info(`[LMStudio] 加载模型: ${modelKey}`, options || {});
    const res = await fetch(`${this.v1BaseUrl}/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000), // 加载大模型可能需要较长时间
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Load failed (${res.status}): ${errText}`);
    }
    const result: any = await res.json();
    logger.info(`[LMStudio] 模型加载完成: ${modelKey} -> ${result.instance_id} (${result.load_time_seconds}s)`);
    return result;
  }

  /**
   * 从内存卸载模型（LM Studio REST API）
   * @param instanceId 模型实例 ID（通常等于模型 key）
   * @returns 卸载结果
   */
  async unloadModel(instanceId: string): Promise<{ instance_id: string }> {
    logger.info(`[LMStudio] 卸载模型: ${instanceId}`);
    const res = await fetch(`${this.v1BaseUrl}/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: instanceId }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Unload failed (${res.status}): ${errText}`);
    }
    const result: any = await res.json();
    logger.info(`[LMStudio] 模型已卸载: ${instanceId}`);
    return result;
  }

  /** 适配器本身作为 chatFn 注入到探针 */
  asChatFn() {
    return (messages: ChatMessage[]) => this.chat(messages);
  }

  // ── 流式输出 ──

  /**
   * 流式聊天 — 使用 OpenAI 兼容端点 stream:true
   * 逐 token yield delta content
   * 如果流结束后没有任何内容，回退到非流式调用并分块 yield
   */
  async *chatStream(messages: ChatMessage[]): AsyncGenerator<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model: this.model,
      messages,
      temperature: 0.7,
      max_tokens: this.maxTokens,
      stream: true,
      tool_choice: 'none' as const,
      parallel_tool_calls: false,
    };

    const lastMsg = messages[messages.length - 1];
    logger.info(`[LMStudio][stream] >> ${this.model} msgs=${messages.length} last=${(lastMsg?.content || '').slice(0, 80)}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LM Studio stream HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    if (!res.body) {
      // 不支持流式，回退
      logger.warn('[LMStudio][stream] 响应无 body，回退到非流式');
      const data = await this.chat(messages);
      const content = data.choices?.[0]?.message?.content || '';
      // 分块 yield（模拟流式）
      const chunkSize = 20;
      for (let i = 0; i < content.length; i += chunkSize) {
        yield content.slice(i, i + chunkSize);
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalContent = '';
    let chunkCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后不完整的行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const json = JSON.parse(dataStr);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              totalContent += delta;
              chunkCount++;
              yield delta;
            }
          } catch {
            // 忽略解析错误的行
          }
        }
      }

      // 处理 buffer 中剩余的数据
      if (buffer.trim().startsWith('data: ')) {
        const dataStr = buffer.trim().slice(6);
        if (dataStr && dataStr !== '[DONE]') {
          try {
            const json = JSON.parse(dataStr);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              totalContent += delta;
              chunkCount++;
              yield delta;
            }
          } catch { /* ignore */ }
        }
      }

      // 如果流结束但没有任何内容，回退到非流式
      if (totalContent.length === 0) {
        logger.warn('[LMStudio][stream] 流式响应为空，回退到非流式');
        const data = await this.chat(messages);
        const content = data.choices?.[0]?.message?.content || '';
        const chunkSize = 20;
        for (let i = 0; i < content.length; i += chunkSize) {
          yield content.slice(i, i + chunkSize);
        }
        return;
      }

      logger.info(`[LMStudio][stream] << ${totalContent.length}字, ${chunkCount} chunks`);
    } finally {
      reader.releaseLock();
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.v1BaseUrl}/models`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
