# @agent-system/memory

Memory management module — DB store, file store, summarizer, and session recovery.

## Contents

- **DBStore** — SQLite persistence (sessions, decisions, entities, summaries tables)
- **FileStore** — Daily markdown files (memory/YYYY-MM-DD.md)
- **Summarizer** — LLM-powered conversation summarization
- **SessionRecovery** — Cross-session memory injection (decisions, summaries)

## Dependencies

- `sql.js`

## Usage

```typescript
import { DBStore, FileStore } from '@agent-system/memory';
const db = new DBStore('data/sessions.db');
await db.addDecision({ topic: 'config', decision: 'use YAML', rationale: 'flexible' });
```
