// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../logger';

test('events: logger export exists', () => {
  assert.ok(logger, 'logger should be exported');
});

test('events: logger has info method', () => {
  assert.equal(typeof logger.info, 'function');
});

test('events: logger has warn method', () => {
  assert.equal(typeof logger.warn, 'function');
});
