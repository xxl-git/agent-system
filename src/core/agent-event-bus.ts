// Agent 事件总线 — 解耦 AgentCore 与外层（HTTP Server / SSE）
// 所有 pipeline 状态变更都通过这里广播
import { EventEmitter } from 'events';

// ── Status 事件 ──

export interface AgentStatusEvent {
  status: AgentStatus;
  detail?: string;
  elapsedMs?: number;
  progress?: number; // 0-100
  toolCalls?: string[];
  /** 模型名（调试用） */
  model?: string;
  /** 当前在第几步 */
  step?: number;
  /** 总步骤数 */
  totalSteps?: number;
}

// ── Model Payload 事件（调试用） ──

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LLMTaskType = 'intent' | 'decompose' | 'chat' | 'summarize' | 'probe' | 'breakin' | 'subagent';

export interface ModelPayloadEvent {
  /** 任务类型（标识这是哪类 LLM 调用） */
  taskType: LLMTaskType;
  /** 发送给模型的完整 messages 数组 */
  messages: ModelMessage[];
  /** system prompt 总长度 */
  systemPromptLen: number;
  /** user messages 总长度 */
  userPromptLen: number;
  /** assistant messages 总长度 */
  assistantPromptLen: number;
  /** 消息条数 */
  messageCount: number;
  /** 模型标识符 */
  model: string;
  /** 本次调用的关键参数 */
  params: {
    temperature: number;
    max_tokens: number;
    reasoning?: string;
  };
  /** 发送时间（ISO） */
  ts: string;
}

export type AgentStatus =
  | 'idle'             // 空闲
  | 'thinking'         // 理解意图 / 解析命令
  | 'intent_ready'      // 意图已确定
  | 'executing_tools'   // 调用工具
  | 'model_responding'  // 模型输出中
  | 'done'             // 完成
  | 'error'           // 出错
  | 'task_alert';     // 任务监控告警           // 出错

class AgentEventBus extends EventEmitter {
  private _status: AgentStatus = 'idle';
  private _startTime = 0;
  private _step = 0;
  private _totalSteps = 0;

  get status(): AgentStatus { return this._status; }

  /** 开始一个会话的 pipeline（重置计数器） */
  startSession(totalSteps = 3) {
    this._startTime = Date.now();
    this._step = 0;
    this._totalSteps = totalSteps;
    this._status = 'thinking';
    this._emit({ status: 'thinking', detail: '理解输入中...', progress: 0, step: 0, totalSteps });
  }

  /** 每完成一步，调用一次 */
  stepDone(step: number, status: AgentStatus, detail?: string, extra?: Partial<AgentStatusEvent>) {
    this._step = step;
    this._status = status;
    const progress = this._totalSteps > 0 ? Math.round((step / this._totalSteps) * 100) : 0;
    this._emit({
      status,
      detail,
      progress,
      step,
      totalSteps: this._totalSteps,
      elapsedMs: Date.now() - this._startTime,
      ...extra,
    });
  }

  /** 标记工具调用中 */
  toolsExecuting(tools: string[]) {
    this._status = 'executing_tools';
    this._emit({
      status: 'executing_tools',
      detail: `调用 ${tools.length > 0 ? tools.join(', ') : '工具'}...`,
      toolCalls: tools,
      elapsedMs: Date.now() - this._startTime,
    });
  }

  /** 标记模型响应中 */
  modelResponding(model?: string) {
    this._status = 'model_responding';
    this._emit({
      status: 'model_responding',
      detail: '模型思考中...',
      model,
      elapsedMs: Date.now() - this._startTime,
    });
  }

  /** 结束会话 */
  endSession(success: boolean, detail?: string) {
    this._status = success ? 'done' : 'error';
    this._emit({
      status: this._status,
      detail: detail || (success ? '完成' : '出错'),
      progress: 100,
      step: this._totalSteps,
      totalSteps: this._totalSteps,
      elapsedMs: Date.now() - this._startTime,
    });
    // 2秒后自动恢复 idle
    setTimeout(() => {
      if (this._status === 'done' || this._status === 'error') {
        this._status = 'idle';
        this._emit({ status: 'idle', progress: 0, step: 0, totalSteps: 0 });
      }
    }, 2000);
  }

  /** 发射主动通知事件（如任务监控告警），不影响主 pipeline 状态 */
  emitStatus(status: 'task_alert', extra?: Partial<AgentStatusEvent>) {
    this._emit({ status, detail: extra?.detail, elapsedMs: Date.now() - this._startTime });
  }

  private _emit(data: AgentStatusEvent) {
    this.emit('status', data);
  }

  /** 发射模型_payload 事件（发送前调用，供调试 UI 展示完整 prompt） */
  emitModelPayload(payload: ModelPayloadEvent) {
    this.emit('model_payload', payload);
  }

  /** 发射聊天 chunk 事件（流式输出时逐 chunk 调用） */
  emitChatChunk(chunk: string) {
    this.emit('chat_chunk', chunk);
  }

  /** 发射聊天完成事件（流式输出结束后调用） */
  emitChatDone(fullReply: string, durationMs: number) {
    this.emit('chat_done', { fullReply, durationMs });
  }

  /** 发射聊天错误事件（流式输出出错时调用） */
  emitChatError(error: string) {
    this.emit('chat_error', error);
  }
}

// 单例
export const agentEventBus = new AgentEventBus();
