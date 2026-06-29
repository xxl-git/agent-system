// Shared types for @agent-system/prompts package
// These types mirror the ones in @agent-system/models to avoid direct dependency

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LLMTaskType = 
  | 'intent'
  | 'decompose'
  | 'chat'
  | 'summarize'
  | 'probe'
  | 'breakin'
  | 'subagent';

export interface LLMParams {
  temperature: number;
  max_tokens: number;
  reasoning?: string;
}
