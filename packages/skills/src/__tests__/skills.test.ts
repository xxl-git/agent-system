import { test } from 'node:test';
import assert from 'node:assert/strict';

test('skills: registry module loads', async () => {
  const mod = await import('../registry');
  assert.ok(mod, 'registry should load');
});

test('skills: gap-detector module loads', async () => {
  const mod = await import('../gap-detector');
  assert.ok(mod, 'gap-detector should load');
});

test('skills: pipeline module loads', async () => {
  const mod = await import('../pipeline');
  assert.ok(mod, 'pipeline should load');
});
