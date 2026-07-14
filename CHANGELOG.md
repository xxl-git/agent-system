# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- LICENSE (MIT)
- CONTRIBUTING.md
- `.github/workflows/ci.yml` — CI pipeline (build + typecheck + test + audit)
- `.github/workflows/publish.yml` — npm publish on git tag
- `.github/dependabot.yml` — weekly dependency update checks
- README.md for all 10 `@agent-system/*` packages
- `package.json` scripts: `typecheck`, `build:clean`, `test:units`, `clean`
- 3 new resilience unit test files (39 test cases):
  - `nonsense-detector.test.ts` (12 tests) — gibberish detection + conversation lifecycle
  - `circuit-breaker-unit.test.ts` (15 tests) — circuit breaker state machine (CLOSED/OPEN/HALF_OPEN)
  - `idle-task-manager.test.ts` (12 tests) — task registration, cooldown, maxFails removal
- CORS origin allowlist configuration (`server.cors.allowedOrigins` in `agent-system.yaml`)

### Changed
- Replaced 14 `console.*` calls with `logger` in `agent-server.ts`
- Archived 14 historical `.md` reports to `docs/archive/`
- Root directory `.md` files: 18 → 4 (README, HANDOVER, PLAN, CHANGELOG)
- Test coverage: 17% → 20% (20 test files / 100 source files)
- `test:units` script and CI workflow updated to include 3 new test files

### Fixed
- Removed all 13 `@ts-nocheck` directives (4 source + 9 test files)
- Added `.env`, `.env.local`, `uploads/` to `.gitignore`
- Fixed garbled comments in `audit-server.ts`
- Cleared 96 stale files from `data/pending-diagnostics/`
- Reduced logs size: 15.9 MB → 8.8 MB
- CORS no longer uses wildcard `*` — dynamic origin validation via allowlist

## [0.9.2] - 2026-06-28

### Added
- **Local model auto-detection + hot-switching**
  - `onboardModel()` enhanced — calls `listModels()` to list all loaded models
  - `POST /api/models/switch` — validate → `setModel()` → update context → persist to YAML
  - `POST /api/models/scan` — rescan LM Studio loaded models
  - Enhanced `GET /api/models` — full metadata + connection status + current model
  - CLI: `/models list|scan|switch <name>`
  - Frontend: model dropdown with context/arch info, refresh button, hot-switch without restart

## [0.9.1] - 2026-06-28

### Added
- **Complex long-task handling enhancement**
  - Step-level checkpoints: `orchestrator.execute()` saves after each step
  - Dynamic replanning (Observe → Replan): LLM evaluates whether to adjust plan
  - `/resume` command — list/resume incomplete tasks
  - `/ckpt` command — checkpoint management (list/show/clear)
  - `/pause` command — pause current task
  - Cross-session task recovery: `init()` no longer clears checkpoints

- **Idle Tasks registered** (Phase 1C)
  - `memory-organization` (P2, 7-day archive)
  - `task-monitor-alerts` (P1, 1-hour check)
  - `session-summary-gc` (P1, 1-day GC)

## [0.9.0] - 2026-06-25

### Added
- **Phase 1-4 modular refactoring complete**
  - Extracted `CommandHandler` (810 lines), `ChatHandler` (420 lines), `TaskHandler` (260 lines)
  - `agent-core.ts` `init()` split into 10 private methods
  - Memory block data flow optimization
  - 106 unit tests across 6 new test files (100% pass rate)

- **Error handling and retry mechanism**
  - `RetryEngine`: 12 failure modes + 5 retry strategies + exponential backoff
  - `CircuitBreaker`: 3-level (model/tool/path), state machine
  - `ResilienceOrchestrator`: `executeProtected()` wraps tool calls
  - Tool-level circuit breaker in `ToolRegistry.register()`
  - API endpoints: `GET/POST /api/resilience/status`

- **P0 fix: decisions and entities now recorded to database**
  - `recordDecision()` and `recordEntities()` methods added to `AgentCore`

- **P2 fixes**
  - Token estimation: separate Chinese (1.5 chars/token) vs English (4 chars/token)
  - Summary wrapper logic: append `[摘要结束]` when missing
  - `safePath()` defensive try/catch
  - `getCurrentModel()` ensures non-empty return

## [0.6.5] - 2026-06-21

### Added
- **Agent real-time status bar** (event bus + SSE + UI)
  - `agent-event-bus.ts`: EventEmitter with predefined status events
  - AgentCore emits: thinking / intent_ready / executing_tools / model_responding / done / error
  - `/api/events` SSE broadcasts `agent_status` events
  - UI status bar: 3-stage status + progress bar + elapsed time

## [0.6.4] - 2026-06-20

### Fixed
- LM Studio adapter: `reasoning_content` moved into `content`
- `chat()` routing correction
- LM Studio v1 API input discriminator type fix (`message` → `text`)

## [0.6.0] - 2026-06-19

### Added
- Inference model compatibility fixes
- Context Manager with TF-IDF + position weight + role weight attention scoring
- Two-layer compression: summary + eviction

## [0.1.0] - 2026-06-16

### Added
- Initial release
- Basic Agent loop: receive message → call model → reply
- LM Studio adapter
- CLI entry point
- Configuration loading with JSON Schema validation
- File-based and SQLite memory systems
- Intent parser, task decomposer, tool registry
- Project management (PROGRESS/JOURNAL/TODO/DESIGN.md)
