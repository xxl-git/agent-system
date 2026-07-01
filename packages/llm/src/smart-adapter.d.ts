import type { ChatMessage, ChatCompletionResponse, LMStudioAdapter } from './types';
export interface SmartAdapterConfig {
    callTimeoutMs: number;
    maxRetries: number;
    retryBaseMs: number;
    minContentLength: number;
    emptyLoopThreshold: number;
    maxToolCallsPerResponse: number;
    repetitionThreshold: number;
    maxSimilarConsecutive: number;
    ngramSize: number;
}
export declare class SmartAdapter {
    private raw;
    private config;
    private consecutiveEmpties;
    private recentResponses;
    private consecutiveSimilar;
    private probeMode;
    setProbeMode(enabled: boolean): void;
    get model(): string;
    constructor(rawAdapter: LMStudioAdapter, config?: Partial<SmartAdapterConfig>);
    chat(messages: ChatMessage[]): Promise<ChatCompletionResponse>;
    private callWithTimeout;
    private filterValidToolCalls;
    private degradedFallback;
    ping(): Promise<boolean>;
    listModels(): Promise<any[]>;
    getCurrentModel(): Promise<string>;
    setModel(name: string): void;
    setReasoning(level: 'off' | 'low' | 'medium' | 'high' | 'on'): void;
    clearReasoning(): void;
    getReasoning(): 'off' | 'low' | 'medium' | 'high' | 'on' | undefined;
    get contextLength(): number;
    getEffectiveContextWindow(): number;
    markSessionReset(): void;
    isSessionReset(): boolean;
    clearSessionReset(): void;
    asChatFn(): (messages: ChatMessage[]) => Promise<ChatCompletionResponse>;
    reset(): void;
    chatStream(messages: ChatMessage[]): AsyncGenerator<string>;
    private checkRepetition;
    private sleep;
}
//# sourceMappingURL=smart-adapter.d.ts.map