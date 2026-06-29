// Stub for prompts registry in memory package
// The summarizer dynamically imports this; in the standalone package it falls back gracefully
export function getPromptRegistry() {
  return {
    get: (_key: string) => ({ system: '', user: '', params: {} }),
  };
}
