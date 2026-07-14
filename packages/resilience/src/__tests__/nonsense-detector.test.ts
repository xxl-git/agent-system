import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NonsenseDetector } from '../nonsense-detector';

test('NonsenseDetector: detectGibberish returns null for normal text', () => {
  const result = NonsenseDetector.detectGibberish('Hello, this is a normal response with enough content.');
  assert.equal(result, null);
});

test('NonsenseDetector: detectGibberish detects empty response', () => {
  const result = NonsenseDetector.detectGibberish('');
  assert.equal(result, '空响应');
});

test('NonsenseDetector: detectGibberish detects whitespace-only response', () => {
  const result = NonsenseDetector.detectGibberish('   ');
  assert.equal(result, '空响应');
});

test('NonsenseDetector: detectGibberish detects very short response', () => {
  const result = NonsenseDetector.detectGibberish('ok');
  assert.ok(result, 'Short response should be detected as gibberish');
});

test('NonsenseDetector: markConversationStart sets active state', () => {
  const det = new NonsenseDetector();
  assert.equal(det.isConversationActive(), false);
  det.markConversationStart('test input');
  assert.equal(det.isConversationActive(), true);
});

test('NonsenseDetector: markConversationEnd clears active state', () => {
  const det = new NonsenseDetector();
  det.markConversationStart('test input');
  det.markConversationEnd(true, 'test input', 'normal output');
  assert.equal(det.isConversationActive(), false);
});

test('NonsenseDetector: markConversationEnd stores last conversation', () => {
  const det = new NonsenseDetector();
  det.markConversationStart('hello');
  det.markConversationEnd(true, 'hello', 'world');
  const last = det.getLastConversation();
  assert.ok(last, 'Should have last conversation');
  assert.equal(last?.input, 'hello');
  assert.equal(last?.output, 'world');
  assert.equal(last?.endedNormally, true);
});

test('NonsenseDetector: markConversationEnd with abnormal reason', () => {
  const det = new NonsenseDetector();
  det.markConversationStart('test');
  det.markConversationEnd(false, 'test', 'bad output', 'gibberish detected');
  const last = det.getLastConversation();
  assert.ok(last);
  assert.equal(last?.endedNormally, false);
  assert.equal(last?.reason, 'gibberish detected');
});

test('NonsenseDetector: getConversationElapsedMs returns 0 when inactive', () => {
  const det = new NonsenseDetector();
  assert.equal(det.getConversationElapsedMs(), 0);
});

test('NonsenseDetector: getConversationElapsedMs returns positive when active', () => {
  const det = new NonsenseDetector();
  det.markConversationStart('test');
  const elapsed = det.getConversationElapsedMs();
  assert.ok(elapsed >= 0, 'Elapsed should be non-negative');
});

test('NonsenseDetector: setModelName does not throw', () => {
  const det = new NonsenseDetector();
  det.setModelName('test-model');
  // No exception means pass
  assert.ok(true);
});

test('NonsenseDetector: conversation record truncates long text', () => {
  const det = new NonsenseDetector();
  const longInput = 'a'.repeat(1000);
  const longOutput = 'b'.repeat(1000);
  det.markConversationStart(longInput);
  det.markConversationEnd(true, longInput, longOutput);
  const last = det.getLastConversation();
  assert.ok(last);
  assert.ok(last!.input.length <= 500, 'Input should be truncated to 500 chars');
  assert.ok(last!.output.length <= 500, 'Output should be truncated to 500 chars');
});
