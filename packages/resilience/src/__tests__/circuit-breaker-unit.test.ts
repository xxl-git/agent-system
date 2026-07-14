import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../circuit-breaker';

test('CircuitBreaker: initial state is CLOSED', () => {
  const cb = new CircuitBreaker();
  const inst = cb.model('test-model');
  assert.equal(inst.state, 'CLOSED');
  assert.equal(inst.failureCount, 0);
});

test('CircuitBreaker: canUseModel returns true for new model', () => {
  const cb = new CircuitBreaker();
  assert.equal(cb.canUseModel('new-model'), true);
});

test('CircuitBreaker: modelFailure increments failure count', () => {
  const cb = new CircuitBreaker();
  cb.modelFailure('m1', 'timeout');
  const inst = cb.model('m1');
  assert.equal(inst.failureCount, 1);
  assert.equal(inst.lastError, 'timeout');
});

test('CircuitBreaker: opens after threshold failures', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, halfOpenMaxAttempts: 1 });
  cb.modelFailure('m1');
  cb.modelFailure('m1');
  const inst = cb.modelFailure('m1');
  assert.equal(inst.state, 'OPEN');
  assert.equal(cb.canUseModel('m1'), false);
});

test('CircuitBreaker: modelSuccess resets to CLOSED', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, halfOpenMaxAttempts: 1 });
  cb.modelFailure('m1');
  cb.modelFailure('m1');
  cb.modelSuccess('m1');
  const inst = cb.model('m1');
  assert.equal(inst.state, 'CLOSED');
  assert.equal(inst.failureCount, 0);
});

test('CircuitBreaker: tool circuit works independently', () => {
  const cb = new CircuitBreaker();
  cb.toolFailure('web_search');
  const t1 = cb.tool('web_search');
  assert.equal(t1.failureCount, 1);
  // model circuit should be unaffected
  const m1 = cb.model('m1');
  assert.equal(m1.failureCount, 0);
});

test('CircuitBreaker: canUseTool returns false when OPEN', () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, halfOpenMaxAttempts: 1 });
  cb.toolFailure('t1');
  cb.toolFailure('t1');
  assert.equal(cb.canUseTool('t1'), false);
});

test('CircuitBreaker: toolSuccess resets state', () => {
  const cb = new CircuitBreaker();
  cb.toolFailure('t1');
  cb.toolSuccess('t1');
  const inst = cb.tool('t1');
  assert.equal(inst.state, 'CLOSED');
  assert.equal(inst.failureCount, 0);
});

test('CircuitBreaker: path circuit works', () => {
  const cb = new CircuitBreaker();
  cb.pathFailure('retry-path-1');
  const inst = cb.path('retry-path-1');
  assert.equal(inst.failureCount, 1);
});

test('CircuitBreaker: canUsePath respects OPEN state', () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, halfOpenMaxAttempts: 1 });
  cb.pathFailure('p1');
  assert.equal(cb.canUsePath('p1'), false);
});

test('CircuitBreaker: transition to HALF_OPEN after cooldown', () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50, halfOpenMaxAttempts: 1 });
  cb.modelFailure('m1');
  assert.equal(cb.canUseModel('m1'), false);
  // Wait for cooldown
  const inst = cb.model('m1');
  // Manually simulate cooldown passed
  inst.retryAfter = Date.now() - 1;
  // canUse should transition to HALF_OPEN
  const canUse = cb.canUseModel('m1');
  assert.equal(canUse, true);
  assert.equal(inst.state, 'HALF_OPEN');
});

test('CircuitBreaker: HALF_OPEN success returns to CLOSED', () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50, halfOpenMaxAttempts: 1 });
  cb.modelFailure('m1');
  const inst = cb.model('m1');
  inst.retryAfter = Date.now() - 1;
  cb.canUseModel('m1'); // triggers HALF_OPEN
  cb.modelSuccess('m1');
  assert.equal(inst.state, 'CLOSED');
});

test('CircuitBreaker: HALF_OPEN failure returns to OPEN', () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50, halfOpenMaxAttempts: 1 });
  cb.modelFailure('m1');
  const inst = cb.model('m1');
  inst.retryAfter = Date.now() - 1;
  cb.canUseModel('m1'); // triggers HALF_OPEN
  cb.modelFailure('m1');
  assert.equal(inst.state, 'OPEN');
});

test('CircuitBreaker: independent instances per model', () => {
  const cb = new CircuitBreaker();
  cb.modelFailure('m1');
  const m1 = cb.model('m1');
  const m2 = cb.model('m2');
  assert.equal(m1.failureCount, 1);
  assert.equal(m2.failureCount, 0);
});

test('CircuitBreaker: custom config overrides defaults', () => {
  const cb = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 5000, halfOpenMaxAttempts: 2 });
  assert.equal(cb.config.failureThreshold, 5);
  assert.equal(cb.config.cooldownMs, 5000);
  assert.equal(cb.config.halfOpenMaxAttempts, 2);
});
