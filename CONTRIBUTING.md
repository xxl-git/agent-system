# Contributing to Agent System

## Development Setup

```bash
# Clone
git clone https://github.com/xxl-git/agent-system.git
cd agent-system

# Install dependencies (npm workspaces auto-links packages)
npm install

# Build all packages
npm run build

# Type check (no emit)
npm run typecheck

# Run unit tests
npm run test:units
```

## Project Structure

```
agent-system/
├── packages/           # @agent-system/* workspace packages
│   ├── core/           # AgentCore, handlers, context manager
│   ├── events/         # Event bus
│   ├── experience/     # Experience extraction and retrieval
│   ├── llm/            # LLM router, SmartAdapter, LM Studio adapter
│   ├── memory/         # DB store, file store, summarizer
│   ├── models-core/    # Model probing and profiling
│   ├── prompts/        # Prompt registry and assembler
│   ├── resilience/     # Circuit breaker, retry, health monitor
│   ├── skills/         # Skill registry and gap detection
│   └── tools/          # Built-in tools (exec, file I/O)
├── src/                # Server and entry point
│   ├── server/         # HTTP server, routes, dashboard API
│   └── index.ts        # CLI entry
├── config/             # YAML configuration
├── docs/archive/       # Historical reports
└── tests/              # Integration tests
```

## Coding Standards

- **TypeScript strict mode**: All code must pass `tsc --noEmit`
- **No `@ts-nocheck`**: Fix type errors, don't suppress them
- **No `any` types**: Use proper interfaces and types
- **Use `logger` not `console`**: Except in entry points (index.ts) and logger.ts itself
- **Error handling**: All async operations must have try/catch with logger
- **UTF-8 encoding**: All files must be UTF-8

## Commit Convention

```
<type>(<scope>): <subject>

Types: feat, fix, docs, refactor, chore, test, ci
Scopes: core, server, resilience, memory, etc.
```

Examples:
- `feat(core): add model hot-switch API`
- `fix(resilience): circuit breaker state transition`
- `docs: update README`

## Testing

- Unit tests go in `__tests__/` directories next to source
- Test files: `*.test.ts`
- Run: `npm run test:units`

## Pull Requests

1. Create a feature branch: `git checkout -b feat/your-feature`
2. Make changes, add tests
3. Ensure: `npm run typecheck` and `npm run test:units` pass
4. Submit PR with clear description
