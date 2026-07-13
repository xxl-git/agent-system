import { test } from 'node:test';
import assert from 'node:assert/strict';

test('prompts: assembler module loads', async () => {
  const mod = await import('../assembler');
  assert.ok(mod, 'assembler should load');
});

test('prompts: registry module loads', async () => {
  const mod = await import('../registry');
  assert.ok(mod, 'registry should load');
});

test('prompts: PromptAssembler class exists', async () => {
  const mod = await import('../assembler');
  const cls = mod.PromptAssembler || mod.default;
  assert.ok(cls, 'PromptAssembler class should exist');
});
