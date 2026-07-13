import { test } from 'node:test';
import assert from 'node:assert/strict';

test('resilience: circuit-breaker loads', async () => {
  const mod = await import('../circuit-breaker');
  assert.ok(mod, 'circuit-breaker should load');
});

test('resilience: CircuitBreaker class exists', async () => {
  const mod = await import('../circuit-breaker');
  assert.ok(mod.CircuitBreaker || mod.getCircuitBreaker, 'CircuitBreaker should be exported');
});

test('resilience: retry-engine loads', async () => {
  const mod = await import('../retry-engine');
  assert.ok(mod, 'retry-engine should load');
});

test('resilience: checkpoint loads', async () => {
  const mod = await import('../checkpoint');
  assert.ok(mod, 'checkpoint should load');
});

test('resilience: tracer getRecentTraces exists', async () => {
  const mod = await import('../tracer');
  assert.equal(typeof mod.getRecentTraces, 'function');
});
