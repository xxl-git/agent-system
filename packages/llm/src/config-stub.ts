// Config stub — decoupled from root config system
// Returns a minimal config structure so LMStudioAdapter compiles standalone.
// In the root project, the real getConfig() is used.

export function getConfig(): any {
  return {
    models: {
      providers: {
        lmstudio: {
          baseUrl: 'http://localhost:1234/v1',
          model: 'local-model',
          timeoutMs: 60000,
          maxTokens: 2048,
        },
      },
    },
  };
}
