# @agent-system/skills

Skill registry, gap detection, and development pipeline.

## Contents

- **SkillRegistry** — Skill registration and lookup
- **GapDetector** — Identifies missing skills based on task requirements
- **SkillPipeline** — Automated skill development workflow

## Usage

```typescript
import { SkillRegistry } from '@agent-system/skills';
const registry = new SkillRegistry();
registry.register({ name: 'web-search', handler: searchHandler });
```
