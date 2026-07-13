# @agent-system/resilience

Resilience module — circuit breaker, retry engine, health monitor, and more.

## Contents

- **CircuitBreaker** — Three-level circuit breaker (model/tool/path) with CLOSED→OPEN→HALF_OPEN state machine
- **RetryEngine** — 12 failure modes, 5 retry strategies, exponential backoff with jitter
- **HealthMonitor** — Ping tracking, token stream watching, degradation alerts
- **CheckpointManager** — Task checkpoint persistence for crash recovery
- **IdleTaskManager** — Background tasks when agent is idle (memory org, alert checks, GC)
- **NonsenseDetector** — Gibberish/non-sensical output detection
- **SessionDiagnostics** — Session health tracking (ping stats, response times)
- **Orchestrator** — Resilience orchestration (executeProtected wrapper)
- **AssemblyInspector** — Message assembly pipeline tracing
- **Tracer** — Distributed tracing with nested spans

## Usage

```typescript
import { CircuitBreaker, RetryEngine } from '@agent-system/resilience';
const breaker = new CircuitBreaker({ threshold: 5, resetTimeout: 30000 });
const result = await breaker.execute(() => apiCall());
```
