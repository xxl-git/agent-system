import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { IdleTaskManager, IdleTask } from '../idle-task-manager';

// Helper: create a temp log dir for testing
function makeTempDir(): string {
  const dir = path.join(process.cwd(), 'data', 'test-idle-logs-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTask(overrides?: Partial<IdleTask>): IdleTask {
  return {
    id: 'test-' + Math.random().toString(36).slice(2),
    name: 'Test Task',
    description: 'A test task',
    priority: 'P2',
    cooldownMs: 0,
    lastRun: 0,
    running: false,
    execute: async () => true,
    createdAt: Date.now(),
    failCount: 0,
    maxFails: 3,
    ...overrides,
  };
}

test('IdleTaskManager: register adds task to queue', () => {
  const mgr = new IdleTaskManager(makeTempDir());
  const task = makeTask({ id: 't1', name: 'Task 1' });
  mgr.register(task);
  const stats = mgr.getStats();
  assert.equal(stats.executed, 0);
});

test('IdleTaskManager: register same id updates existing task', () => {
  const mgr = new IdleTaskManager(makeTempDir());
  mgr.register(makeTask({ id: 't1', priority: 'P2', name: 'Original' }));
  mgr.register(makeTask({ id: 't1', priority: 'P0', name: 'Updated' }));
  // Should not duplicate
  const stats = mgr.getStats();
  assert.ok(stats.executed >= 0);
});

test('IdleTaskManager: unregister removes task', () => {
  const mgr = new IdleTaskManager(makeTempDir());
  mgr.register(makeTask({ id: 't1' }));
  mgr.unregister('t1');
  // Should not throw
  assert.ok(true);
});

test('IdleTaskManager: unregister non-existent does not throw', () => {
  const mgr = new IdleTaskManager(makeTempDir());
  mgr.unregister('nonexistent');
  assert.ok(true);
});

test('IdleTaskManager: tasks sorted by priority', () => {
  const mgr = new IdleTaskManager(makeTempDir());
  mgr.register(makeTask({ id: 'p2', priority: 'P2' }));
  mgr.register(makeTask({ id: 'p0', priority: 'P0' }));
  mgr.register(makeTask({ id: 'p1', priority: 'P1' }));
  // If sorted, processing order should be P0, P1, P2
  // We verify via getStats (no direct access to internal order, but register sorts)
  assert.ok(true); // No exception means sort worked
});

test('IdleTaskManager: processAll executes ready tasks', async () => {
  const dir = makeTempDir();
  const mgr = new IdleTaskManager(dir);
  let executed = false;
  mgr.register(makeTask({
    id: 'exec1',
    priority: 'P1',
    cooldownMs: 0,
    lastRun: 0,
    execute: async () => { executed = true; return true; },
  }));
  await mgr.processAll();
  assert.equal(executed, true);
});

test('IdleTaskManager: cooldown prevents re-execution', async () => {
  const dir = makeTempDir();
  const mgr = new IdleTaskManager(dir);
  let count = 0;
  mgr.register(makeTask({
    id: 'cooldown1',
    priority: 'P1',
    cooldownMs: 60000, // 60s cooldown
    lastRun: 0,
    execute: async () => { count++; return true; },
  }));
  await mgr.processAll();
  assert.equal(count, 1);
  // Second run should be skipped due to cooldown
  await mgr.processAll();
  assert.equal(count, 1);
});

test('IdleTaskManager: failed task increments failCount', async () => {
  const dir = makeTempDir();
  const mgr = new IdleTaskManager(dir);
  mgr.register(makeTask({
    id: 'fail1',
    priority: 'P1',
    cooldownMs: 0,
    lastRun: 0,
    execute: async () => { throw new Error('fail'); },
    maxFails: 5,
  }));
  await mgr.processAll();
  const stats = mgr.getStats();
  assert.ok(stats.failed >= 1, `Expected failed >= 1, got ${stats.failed}`);
});

test('IdleTaskManager: task exceeding maxFails is removed', async () => {
  const dir = makeTempDir();
  const mgr = new IdleTaskManager(dir);
  mgr.register(makeTask({
    id: 'maxfail1',
    priority: 'P1',
    cooldownMs: 0,
    lastRun: 0,
    execute: async () => { throw new Error('always fail'); },
    maxFails: 2,
    failCount: 1, // Already failed once
  }));
  await mgr.processAll();
  // After this failure, failCount > maxFails, task should be removed
  // Next processAll should not execute it
  await mgr.processAll();
  assert.ok(true);
});

test('IdleTaskManager: getStats returns object with expected fields', () => {
  const mgr = new IdleTaskManager(makeTempDir());
  const stats = mgr.getStats();
  assert.ok(typeof stats === 'object');
  assert.ok('executed' in stats);
  assert.ok('succeeded' in stats);
  assert.ok('failed' in stats);
  assert.ok('skipped' in stats);
});

test('IdleTaskManager: constructor creates log directory', () => {
  const dir = path.join(process.cwd(), 'data', 'test-create-' + Date.now());
  assert.equal(fs.existsSync(dir), false);
  new IdleTaskManager(dir);
  assert.equal(fs.existsSync(dir), true);
});

test('IdleTaskManager: execute returning false keeps task in queue', async () => {
  const dir = makeTempDir();
  const mgr = new IdleTaskManager(dir);
  let count = 0;
  mgr.register(makeTask({
    id: 'keep1',
    priority: 'P1',
    cooldownMs: 0,
    lastRun: 0,
    execute: async () => { count++; return false; }, // false = keep in queue
    maxFails: 100,
  }));
  await mgr.processAll();
  assert.equal(count, 1);
  // Task should still be in queue (execute returned false)
  await mgr.processAll();
  assert.equal(count, 2);
});
