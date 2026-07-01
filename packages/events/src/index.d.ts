import { EventEmitter } from 'events';
export interface AgentStatusEvent {
    status: AgentStatus;
    detail?: string;
    elapsedMs?: number;
    progress?: number;
    toolCalls?: string[];
    model?: string;
    step?: number;
    totalSteps?: number;
}
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
export type AgentStatus = 'idle' | 'thinking' | 'intent_ready' | 'executing_tools' | 'model_responding' | 'done' | 'error';
export declare class AgentEventBus extends EventEmitter {
    private _status;
    private _startTime;
    private _step;
    private _totalSteps;
    get status(): AgentStatus;
    startSession(totalSteps?: number): void;
    stepDone(step: number, status: AgentStatus, detail?: string, extra?: Partial<AgentStatusEvent>): void;
    toolsExecuting(tools: string[]): void;
    modelResponding(model?: string): void;
    endSession(success: boolean, detail?: string): void;
    private _emit;
    emitModelPayload(payload: ModelPayloadEvent): void;
    emitChatChunk(chunk: string): void;
    emitChatDone(fullReply: string, durationMs: number): void;
    emitChatError(error: string): void;
}
export declare const agentEventBus: AgentEventBus;
//# sourceMappingURL=index.d.ts.map