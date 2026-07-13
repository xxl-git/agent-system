import { test } from 'node:test';
import assert from 'node:assert/strict';

test('memory: file-store module loads', async () => {
  const mod = await import('../file-store');
  assert.ok(mod, 'file-store should load');
});

test('memory: db-store module loads', async () => {
  const mod = await import('../db-store');
  assert.ok(mod, 'db-store should load');
});

test('memory: file-store has FileStore class', async () => {
  const mod = await import('../file-store');
  const cls = mod.FileMemoryStore || mod.default;
  assert.ok(cls, 'FileMemoryStore class should exist');
});
