# @agent-system/experience

Experience management module — extract, store, and retrieve agent experiences.

## Contents

- **Extractor** — LLM-powered experience refinement from raw descriptions
- **Store** — SQLite-backed experience persistence (data/experiences.db)
- **Retriever** — Semantic similarity retrieval for relevant past experiences
- **Commands** — ExperienceCommandHandler for `/exp` CLI commands

## Dependencies

- `@agent-system/llm`, `@agent-system/prompts`

## Usage

```typescript
import { ExperienceExtractor, ExperienceStore, ExperienceRetriever } from '@agent-system/experience';
const store = new ExperienceStore();
const extractor = new ExperienceExtractor(store);
await extractor.extract('How to fix npm install errors', 'Run npm cache clean --force');
```
