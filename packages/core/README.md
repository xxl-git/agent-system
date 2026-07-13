# @agent-system/core

Core agent module for Agent System.

## Contents

- **AgentCore** — Main agent coordinator (init, message pipeline, handler delegation)
- **Handlers** — ChatHandler, CommandHandler, TaskHandler (extracted from agent-core.ts)
- **ContextManager** — Attention-based context compression (TF-IDF + position weight)
- **Orchestrator** — Task decomposition and execution (Plan → Execute → Observe → Replan)
- **IntentParser** — User message intent classification
- **ProjectManager** — Project tracking with TODO/PROGRESS/JOURNAL
- **SmartAdapter** — LLM adapter with retry, payload broadcasting
- **LMStudioAdapter** — LM Studio API adapter (chat, chatStream, ping, models)
- **ToolRegistry** — Tool registration and sandboxed execution
- **Logger** — Winston-based with rotation, gzip, module-level filtering

## Dependencies

- `@agent-system/events`, `@agent-system/experience`, `@agent-system/llm`
- `@agent-system/memory`, `@agent-system/models-core`, `@agent-system/prompts`
- `@agent-system/resilience`, `@agent-system/skills`, `@agent-system/tools`

## Usage

```typescript
import { AgentCore } from '@agent-system/core';
const agent = new AgentCore();
await agent.init();
await agent.sendMessage('Hello');
```
