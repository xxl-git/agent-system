// Shared types for LLM adapters and router
// Decoupled from root project — these mirror lmstudio.ts types

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

/** Reasoning 级别 */
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'on';

/**
 * LLM Adapter interface — any adapter (LM Studio, OpenAI, Anthropic, etc.)
 * must implement this interface to work with SmartAdapter.
 * The actual LMStudioAdapter lives in the root project; this is the minimal
 * interface needed for standalone compilation of SmartAdapter + LLMRouter.
 */
export interface LMStudioAdapter {
  model: string;
  chat(messages: ChatMessage[]): Promise<ChatCompletionResponse>;
  chatStream(messages: ChatMessage[]): AsyncGenerator<string>;
  ping(): Promise<boolean>;
  setModel(name: string): void;
  listModels(): Promise<any[]>;
  getCurrentModel(): Promise<string>;
  setReasoning(level: ReasoningLevel): void;
  clearReasoning(): void;
  getReasoning(): ReasoningLevel | undefined;
  contextLength?: number;
  maxTokens?: number;
  getEffectiveContextWindow(): number;
  markSessionReset(): void;
  isSessionReset(): boolean;
  clearSessionReset(): void;
  asChatFn(): (messages: ChatMessage[]) => Promise<ChatCompletionResponse>;
}
