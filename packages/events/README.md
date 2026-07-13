# @agent-system/events

Agent event bus — singleton EventEmitter for status, payload, and chat chunk events.

## Contents

- **AgentEventBus** — Global event bus (thinking, intent_ready, executing_tools, model_responding, done, error, chat_chunk, chat_done, chat_error)

## Usage

```typescript
import { agentEventBus } from '@agent-system/events';
agentEventBus.thinking('task-1');
agentEventBus.done('task-1', 'result');
```
