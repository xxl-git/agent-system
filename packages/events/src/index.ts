// Agent Event Bus — extracted as independent package
import { EventEmitter } from 'events';

// ── Status 事件 ──

export interface AgentStatusEvent {
  status: AgentStatus;
  detail?: string;
  elapsedMs?: number;
  progress?: number; // 0-100
  toolCalls?: string[];
  model?: string;
  step?: number;
  totalSteps?: number;
}

// ── Model Payload 事件 ──

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LLMTaskType = 'intent' | 'decompose' | 'chat' | 'summarize' | 'probe' | 'breakin' | 'subagent';

export interface ModelPayloadEvent {
  taskType: LLMTaskType;
  messages: ModelMessage[];
  systemPromptLen: number;
  userPromptLen: number;
  assistantPromptLen: number;
  messageCount: number;
  model: string;
  params: {
    temperature: number;
    max_tokens: number;
    reasoning?: string;
  };
  ts: string;
}

// ── Agent Status ──

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'intent_ready'
  | 'executing_tools'
  | 'model_responding'
  | 'done'
  | 'error';

// ── Event Bus ──

export class AgentEventBus extends EventEmitter {
  private _status: AgentStatus = 'idle';
  private _startTime = 0;
  private _step = 0;
  private _totalSteps = 0;

  get status(): AgentStatus { return this._status; }

  startSession(totalSteps = 3) {
    this._startTime = Date.now();
    this._step = 0;
    this._totalSteps = totalSteps;
    this._status = 'thinking';
    this._emit({ status: 'thinking', detail: '理解输入中...', progress: 0, step: 0, totalSteps });
  }

  stepDone(step: number, status: AgentStatus, detail?: string, extra?: Partial<AgentStatusEvent>) {
    this._step = step;
    this._status = status;
    const progress = this._totalSteps > 0 ? Math.round((step / this._totalSteps) * 100) : 0;
    this._emit({ status, detail, progress, step, totalSteps: this._totalSteps, elapsedMs: Date.now() - this._startTime, ...extra });
  }

  toolsExecuting(tools: string[]) {
    this._status = 'executing_tools';
    this._emit({ status: 'executing_tools', detail: `调用 ${tools.join(', ')}...`, toolCalls: tools, elapsedMs: Date.now() - this._startTime });
  }

  modelResponding(model?: string) {
    this._status = 'model_responding';
    this._emit({ status: 'model_responding', detail: '模型思考中...', model, elapsedMs: Date.now() - this._startTime });
  }

  endSession(success: boolean, detail?: string) {
    this._status = success ? 'done' : 'error';
    this._emit({ status: this._status, detail: detail || (success ? '完成' : '出错'), progress: 100, step: this._totalSteps, totalSteps: this._totalSteps, elapsedMs: Date.now() - this._startTime });
    setTimeout(() => {
      if (this._status === 'done' || this._status === 'error') {
        this._status = 'idle';
        this._emit({ status: 'idle', progress: 0, step: 0, totalSteps: 0 });
      }
    }, 2000);
  }

  private _emit(data: AgentStatusEvent) {
    this.emit('status', data);
  }

  emitModelPayload(payload: ModelPayloadEvent) {
    this.emit('model_payload', payload);
  }

  emitChatChunk(chunk: string) {
    this.emit('chat_chunk', chunk);
  }

  emitChatDone(fullReply: string, durationMs: number) {
    this.emit('chat_done', { fullReply, durationMs });
  }

  emitChatError(error: string) {
    this.emit('chat_error', error);
  }
}

// ── Singleton ──

export const agentEventBus = new AgentEventBus();
