// ChatMessage stub — mirrors lmstudio.ts type
// Packages use this to avoid depending on the root project
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
