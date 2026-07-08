// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('experience: commands module loads', async () => {
  const mod = await import('../commands');
  assert.ok(mod, 'commands module should load');
});

test('experience: extractor module loads', async () => {
  const mod = await import('../extractor');
  assert.ok(mod, 'extractor module should load');
});

test('experience: store module loads', async () => {
  const mod = await import('../store');
  assert.ok(mod, 'store module should load');
});
