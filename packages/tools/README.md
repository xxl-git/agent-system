# @agent-system/tools

Built-in tools for Agent System — exec, file read/write, web search.

## Contents

- **ToolRegistry** — Tool registration with circuit breaker support
- **BaseTools** — Built-in tools:
  - `exec` — Shell command execution
  - `file_read` — Read file contents
  - `file_write` — Write file contents
  - `web_search` — Web search (placeholder)

## Usage

```typescript
import { toolRegistry } from '@agent-system/tools';
const result = await toolRegistry.execute('file_read', { path: '/tmp/test.txt' });
```
