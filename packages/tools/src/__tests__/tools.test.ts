// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('tools: registry module loads', async () => {
  const mod = await import('../registry');
  assert.ok(mod, 'registry should load');
});

test('tools: base-tools module loads', async () => {
  const mod = await import('../base-tools');
  assert.ok(mod, 'base-tools should load');
});
