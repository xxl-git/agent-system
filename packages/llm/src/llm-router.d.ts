import type { ChatMessage, ChatCompletionResponse } from './types';
import { SmartAdapter } from './smart-adapter';
import { type LLMTaskType } from '@agent-system/events';
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
export declare class LLMRouter {
    private adapter;
    constructor(adapter: SmartAdapter);
    call(req: LLMCallRequest): Promise<ChatCompletionResponse>;
    callWithDefaults(req: LLMCallRequest): Promise<ChatCompletionResponse>;
    callStream(req: LLMCallRequest): AsyncGenerator<string>;
    getDefaults(taskType: LLMTaskType): Partial<LLMParams>;
    get rawAdapter(): SmartAdapter;
    private broadcastPayload;
}
export declare function initLLMRouter(adapter: SmartAdapter): LLMRouter;
export declare function getLLMRouter(): LLMRouter;
//# sourceMappingURL=llm-router.d.ts.map