import { test } from 'node:test';
import assert from 'node:assert/strict';

test('models-core: capability-probe loads', async () => {
  const mod = await import('../capability-probe');
  assert.ok(mod, 'capability-probe should load');
});

test('models-core: CapabilityProbe class exists', async () => {
  const mod = await import('../capability-probe');
  assert.ok(mod.CapabilityProbe, 'CapabilityProbe should be exported');
});
