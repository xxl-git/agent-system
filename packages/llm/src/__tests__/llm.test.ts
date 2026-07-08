// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('llm: llm-router module loads', async () => {
  const mod = await import('../llm-router');
  assert.ok(mod, 'llm-router should load');
});

test('llm: LLMRouter class exists', async () => {
  const mod = await import('../llm-router');
  assert.ok(mod.LLMRouter || mod.getLLMRouter, 'LLMRouter or getLLMRouter should be exported');
});
