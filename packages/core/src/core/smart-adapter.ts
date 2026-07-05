// 智能适配器封装 — LLM 作为纯发动机，系统掌控方向盘
// 职责：超时控制 · 空响应拦截 · tool_call 剥离 · 退避重试 · 循环检测 · 重复检测 · 降级 fallback
import type { ChatMessage, ChatCompletionResponse, LMStudioAdapter } from '../models/adapters/lmstudio';
import logger from '../logger';

export interface SmartAdapterConfig {
  /** 单次调用超时 (ms) */
  callTimeoutMs: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 退避基数 (ms) */
  retryBaseMs: number;
  /** 最小内容长度（低于此视为空响应） */
  minContentLength: number;
  /** 连续空响应触发降级阈值 */
  emptyLoopThreshold: number;
  /** tool_call 最大允许次数（超出视为循环） */
  maxToolCallsPerResponse: number;
  /** N-gram 唯一率低于此视为重复 (0-1) */
  repetitionThreshold: number;
  /** 连续相似回复触发降级 */
  maxSimilarConsecutive: number;
  /** N-gram 大小 */
  ngramSize: number;
}

const DEFAULT_CONFIG: SmartAdapterConfig = {
  callTimeoutMs: 120000,   // 推理模型思考时间长，默认 120s
  maxRetries: 5,            // 推理模型失败率高，增加重试次数
  retryBaseMs: 2000,        // 稍大的退避基数
  minContentLength: 1,
  emptyLoopThreshold: 3,
  maxToolCallsPerResponse: 0,
  repetitionThreshold: 0.3,    // N-gram 唯一率 < 30% = 重复
  maxSimilarConsecutive: 3,      // 连续 3 次相似 = 复读机
  ngramSize: 4,                  // 4-gram
};

export class SmartAdapter {
  private raw: LMStudioAdapter;
  private config: SmartAdapterConfig;
  private consecutiveEmpties = 0;
  private recentResponses: string[] = [];    // 最近 N 次响应（用于跨调用重复检测）
  private consecutiveSimilar = 0;            // 连续相似计数

    /** 探针模式：开启后禁用重复检测，避免探测时额外重试 */
  private probeMode = false;

  /** 设置探针模式 */
  setProbeMode(enabled: boolean): void {
    this.probeMode = enabled;
    logger.debug(`[SmartAdapter] 探针模式: ${enabled ? 'ON' : 'OFF'}`);
  }

  /** 当前模型名称 */
  get model(): string { return this.raw.model; }

  constructor(rawAdapter: LMStudioAdapter, config?: Partial<SmartAdapterConfig>) {
    this.raw = rawAdapter;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 核心方法：受控调用 LLM
   * - 超时自动中断
   * - 空响应自动重试（带退避）
   * - tool_calls 自动剥离
   * - 循环检测 + 降级
   */
  async chat(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
    const startTime = Date.now();
    let lastError: Error | null = null;
    let localTimeouts = 0;  // 仅本次调用内计超时，不跨调用共享

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        // ── 第1层：超时控制 ──
        const result = await this.callWithTimeout(messages);
        const elapsed = Date.now() - startTime;

        // ── 第2层：响应验证 ──
        // 兼容 reasoning 模型（如 qwen3/3.5 系列）：content 为空时 fallback 到 reasoning_content
        const msg = result.choices?.[0]?.message;
        // 兼容 reasoning 模型：content 为空时 fallback 到 reasoning_content
        if (msg && (!msg.content || msg.content.trim().length === 0) && msg.reasoning_content) {
          msg.content = msg.reasoning_content;
          delete msg.reasoning_content;
          logger.debug(`[SmartAdapter] ✓ reasoning_content → content (${msg.content.length} 字)`);
        }
        const content = msg?.content || msg?.reasoning_content || '';
        const toolCalls = msg?.tool_calls;

        // 剥离空/无效 tool_calls
        const validToolCalls = this.filterValidToolCalls(toolCalls);

        // tool_calls 超限检测
        if (validToolCalls.length > this.config.maxToolCallsPerResponse) {
          logger.warn(`[SmartAdapter] ⚠ tool_calls 超限: ${validToolCalls.length} > ${this.config.maxToolCallsPerResponse}，剥离`);
          result.choices[0].message.tool_calls = undefined;
        }

        // 空内容检测
        if (!content || content.trim().length < this.config.minContentLength) {
          this.consecutiveEmpties++;

          // 循环检测
          if (this.consecutiveEmpties >= this.config.emptyLoopThreshold) {
            logger.error(`[SmartAdapter] 🔴 连续 ${this.consecutiveEmpties} 次空响应 → 死循环，强制降级`);
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: this.degradedFallback(messages[messages.length - 1]?.content || ''),
                },
                finish_reason: 'degraded',
              }],
            };
          }

          // 重试
          if (attempt < this.config.maxRetries) {
            const delay = this.config.retryBaseMs * Math.pow(2, attempt);
            logger.warn(`[SmartAdapter] ⚠ 空响应 #${this.consecutiveEmpties}，${delay}ms 后重试 (${attempt + 1}/${this.config.maxRetries})`);
            await this.sleep(delay);
            continue;
          }

          // 最后一次也失败 → 降级
          logger.warn(`[SmartAdapter] ⚠ 重试耗尽，返回降级响应`);
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: this.degradedFallback(messages[messages.length - 1]?.content || ''),
              },
              finish_reason: 'degraded',
            }],
          };
        }

        // ── 第3层: 重复检测（探针模式下跳过，避免冗余重试） ──
        if (this.probeMode) {
          // 探针模式：跳过重复检测，直接返回
          this.consecutiveEmpties = 0;
          logger.debug(`[SmartAdapter] ✓ [probe] 响应 ${content.length}字, ${elapsed}ms, 尝试${attempt + 1}`);
          return result;
        }

        const repeatResult = this.checkRepetition(content);
        if (repeatResult.isRepeat) {
          this.consecutiveSimilar++;
          logger.warn(`[SmartAdapter] ⚠ 重复检测: ${repeatResult.reason} (连续${this.consecutiveSimilar}次)`);

          if (this.consecutiveSimilar >= this.config.maxSimilarConsecutive) {
            logger.error(`[SmartAdapter] 🔴 连续 ${this.consecutiveSimilar} 次重复 → 复读机，强制降级`);
            this.consecutiveSimilar = 0;
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: this.degradedFallback(messages[messages.length - 1]?.content || ''),
                },
                finish_reason: 'degraded',
              }],
            };
          }

          // 单次重复：截断到去重后的内容
          if (attempt < this.config.maxRetries) {
            const delay = this.config.retryBaseMs * Math.pow(2, attempt);
            logger.warn(`[SmartAdapter] ⚠ 重复内容，${delay}ms 后重试 (${attempt + 1}/${this.config.maxRetries})`);
            await this.sleep(delay);
            continue;
          }

          // 重试耗尽：返回去重后的截断版
          const deduped = repeatResult.deduped || content.slice(0, Math.floor(content.length / 2));
          result.choices[0].message.content = deduped;
          logger.warn(`[SmartAdapter] ⚠ 返回去重内容 (${deduped.length}/${content.length} 字)`);
        } else {
          this.consecutiveSimilar = 0;
        }

        // ── 成功：重置计数器 ──
        this.consecutiveEmpties = 0;

        logger.debug(`[SmartAdapter] ✓ 响应 ${content.length}字, ${elapsed}ms, 尝试${attempt + 1}`);
        return result;

      } catch (err: any) {
        lastError = err;
        const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout') || err.message?.includes('abort');

        if (isTimeout) {
          localTimeouts++;
          logger.warn(`[SmartAdapter] ⏱ 超时 #${localTimeouts} (${attempt + 1}/${this.config.maxRetries + 1})`);

          if (localTimeouts >= this.config.emptyLoopThreshold) {
            logger.error(`[SmartAdapter] 🔴 连续 ${localTimeouts} 次超时 → 死循环`);
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: '[系统] 模型服务暂时不可用，已自动降级。请稍后重试。',
                },
                finish_reason: 'degraded',
              }],
            };
          }

          if (attempt < this.config.maxRetries) {
            const delay = this.config.retryBaseMs * Math.pow(2, attempt);
            await this.sleep(delay);
            continue;
          }
        } else {
          // 非超时错误（HTTP 错误等）
          logger.error(`[SmartAdapter] ❌ 调用失败: ${err.message}`);
          if (attempt < this.config.maxRetries) {
            await this.sleep(this.config.retryBaseMs * Math.pow(2, attempt));
            continue;
          }
        }
      }
    }

    // 所有重试耗尽
    logger.error(`[SmartAdapter] 🔴 全部 ${this.config.maxRetries + 1} 次尝试失败: ${lastError?.message}`);
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: `[系统] 模型调用失败 (${this.config.maxRetries + 1}次重试): ${lastError?.message?.slice(0, 80)}`,
        },
        finish_reason: 'error',
      }],
    };
  }

  /** 带超时的单次调用（委托给下层适配器，不重复 HTTP 逻辑） */
  private async callWithTimeout(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('TimeoutError: SmartAdapter call timed out')), this.config.callTimeoutMs);
        });
        return Promise.race([this.raw.chat(messages), timeoutPromise]);
    }

  /** 过滤有效的 tool_calls（去掉空/无函数名的） */
  private filterValidToolCalls(toolCalls?: Array<{ function?: { name?: string; arguments?: string } }>): Array<{ function: { name: string; arguments: string } }> {
    if (!toolCalls || !Array.isArray(toolCalls)) return [];
    return toolCalls.filter(tc =>
      tc.function?.name && tc.function.name.length > 0
    ) as Array<{ function: { name: string; arguments: string } }>;
  }

  /** 降级 fallback 响应（根据用户意图生成静态回复） */
  private degradedFallback(userInput: string): string {
    const input = userInput.toLowerCase();

    if (input.startsWith('/')) {
      // 命令类：让 Agent Core 自己处理
      return '';
    }

    if (input.includes('天气') || input.includes('weather')) {
      return '抱歉，当前无法获取实时天气数据。请检查网络连接或稍后重试。';
    }

    if (input.includes('你好') || input.includes('hi') || input.includes('hello')) {
      return '你好！我是 Agent System v0.5.0。当前 LLM 服务暂不可用，回答基于本地规则生成。';
    }

    if (input.length < 10) {
      return '收到。当前模型服务正在恢复中，请稍候或输入 /help 查看可用命令。';
    }

    return `[降级响应] 已收到您的消息（${userInput.length}字）。当前模型服务暂不可用，系统已自动降级到规则引擎。\n\n可用操作：\n- /status 查看系统状态\n- /help 查看命令列表\n- /project list 查看项目`;
  }

  /** Ping 模型（不实际调用 LLM，只检查 HTTP 通不通） */
  async ping(): Promise<boolean> {
    return this.raw.ping();
  }

  /** 获取模型列表 */
  async listModels() { return this.raw.listModels(); }
  async getCurrentModel() { return this.raw.getCurrentModel(); }
  setModel(name: string) { this.raw.setModel(name); }

  /** 设置 reasoning 级别（委托给底层适配器） */
  setReasoning(level: 'off' | 'low' | 'medium' | 'high' | 'on'): void {
    this.raw.setReasoning(level);
  }

  /** 清除 reasoning */
  clearReasoning(): void {
    this.raw.clearReasoning();
  }

  /** 获取当前 reasoning 级别 */
  getReasoning(): 'off' | 'low' | 'medium' | 'high' | 'on' | undefined {
    return this.raw.getReasoning();
  }

  // ── 向下层适配器透明代理，避免 AgentCore 使用 (adapter as any) ──

  /** 模型实际上下文长度 */
  get contextLength(): number { return this.raw.contextLength || 4096; }

  /** 获取有效上下文窗口（用于 ContextManager 压缩触发） */
  getEffectiveContextWindow(): number {
    return this.raw.getEffectiveContextWindow();
  }

  /** 标记会话边界 */
  markSessionReset(): void {
    this.raw.markSessionReset();
  }

  /** 查询是否处于会话边界 */
  isSessionReset(): boolean {
    return this.raw.isSessionReset();
  }

  /** 清除会话边界标记 */
  clearSessionReset(): void {
    this.raw.clearSessionReset();
  }

  /** 注入到探针等外部消费者 */
  asChatFn() {
    return (messages: ChatMessage[]) => this.chat(messages);
  }

  /** 重置计数器（会话恢复后调用） */
  reset() {
    this.consecutiveEmpties = 0;
    this.consecutiveSimilar = 0;
    this.recentResponses = [];
  }

  /**
   * 流式聊天 — 直接委托给底层适配器，不走重试/重复检测逻辑
   * 流式场景下重试和重复检测不适用（用户已经看到了部分输出）
   */
  async *chatStream(messages: ChatMessage[]): AsyncGenerator<string> {
    yield* this.raw.chatStream(messages);
  }

  /** 检测回复是否重复 */
  private checkRepetition(content: string): { isRepeat: boolean; reason: string; deduped?: string } {
    if (!content || content.length < 20) return { isRepeat: false, reason: 'too short' };

    // ── 1. N-gram 内部重复率检测（单次回复内部的复读机） ──
    const ngrams = new Map<string, number>();
    const text = content.toLowerCase().replace(/\s+/g, ' ');
    const n = this.config.ngramSize;

    for (let i = 0; i <= text.length - n; i++) {
      const gram = text.slice(i, i + n);
      ngrams.set(gram, (ngrams.get(gram) || 0) + 1);
    }

    const totalNgrams = ngrams.size;
    const possibleNgrams = Math.max(1, text.length - n + 1);
    const uniqueness = totalNgrams / possibleNgrams;

    // 唯一率低于阈值 = 内容高度重复
    if (uniqueness < this.config.repetitionThreshold && possibleNgrams > 10) {
      // 尝试去重：只保留每种 N-gram 首次出现位置的文本
      const seen = new Set<string>();
      let deduped = '';
      for (let i = 0; i <= text.length - n; i++) {
        const gram = text.slice(i, i + n);
        if (!seen.has(gram)) {
          deduped += text[i];
          seen.add(gram);
        }
      }
      // 补上末尾
      deduped += text.slice(text.length - n + 1);

      return {
        isRepeat: true,
        reason: `N-gram 唯一率 ${(uniqueness * 100).toFixed(0)}% < ${(this.config.repetitionThreshold * 100).toFixed(0)}%`,
        deduped: deduped.slice(0, Math.max(content.length / 2, 50)),
      };
    }

    // ── 2. 跨请求相似检测 ──
    const normalized = text.slice(0, 200).replace(/\s+/g, '');
    for (const prev of this.recentResponses) {
      const prevNorm = prev.slice(0, 200).replace(/\s+/g, '');
      if (normalized === prevNorm) {
        return { isRepeat: true, reason: '与上次回复完全相同' };
      }
      // 模糊匹配：>80% 字符重复
      if (prevNorm.length > 20 && normalized.length > 20) {
        const overlap = [...normalized].filter(c => prevNorm.includes(c)).length;
        const similarity = overlap / Math.max(normalized.length, prevNorm.length);
        if (similarity > 0.85) {
          return { isRepeat: true, reason: `与上次回复相似度 ${(similarity*100).toFixed(0)}%` };
        }
      }
    }

    // 记录本次响应
    this.recentResponses.push(text.slice(0, 300));
    if (this.recentResponses.length > 10) this.recentResponses.shift();

    return { isRepeat: false, reason: 'ok' };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
