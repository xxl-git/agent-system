# @agent-system/models-core

Model probing, profiling, and difficulty assessment.

## Contents

- **CapabilityProbe** — Tests model capabilities (json, code, reasoning, tool_calls)
- **ModelProfileStore** — JSON profile persistence (data/profiles/*.json)
- **assessDifficulty** — Estimates task difficulty for model routing

## Usage

```typescript
import { CapabilityProbe, ModelProfileStore } from '@agent-system/models-core';
const probe = new CapabilityProbe();
const profile = await probe.probe('qwen3.5-9b');
```
