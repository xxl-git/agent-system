# @agent-system/prompts

Prompt management module — registry and assembler.

## Contents

- **PromptRegistry** — Template registration with variable substitution
- **PromptAssembler** — Assembles final messages (identity + memory + experience + context + userInput)

## Dependencies

- `js-yaml`

## Usage

```typescript
import { PromptRegistry, PromptAssembler } from '@agent-system/prompts';
const registry = new PromptRegistry();
registry.loadDir('config/prompts');
const assembler = new PromptAssembler(registry);
const result = assembler.assemble({
  identityTemplateId: 'agent.identity',
  identityVars: { name: 'Agent' },
  context: messages,
});
```
