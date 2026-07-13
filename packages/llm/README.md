# @agent-system/llm

LLM routing, SmartAdapter, and LM Studio adapter.

## Contents

- **LLMRouter** — Unified LLM call interface with task-type-based routing and payload broadcasting
- **SmartAdapter** — High-level adapter with 5x exponential backoff retry, error classification
- **LMStudioAdapter** — LM Studio REST API adapter (chat, chatStream, ping, listModels, loadModel, unloadModel)

## Dependencies

- `@agent-system/events`

## Usage

```typescript
import { getLLMRouter } from '@agent-system/llm';
const router = getLLMRouter();
const response = await router.call({
  taskType: 'chat',
  messages: [{ role: 'user', content: 'Hello' }],
});
```
