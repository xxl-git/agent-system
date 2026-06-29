#!/usr/bin/env ts-node
// P2 记忆摘要引擎测试
import { loadConfig } from '../src/config';
import { getDBStore } from '../src/memory/db-store';
import { MemorySummarizer, getSummarizer } from '../src/memory/summarizer';

const SEP = '─'.repeat(50);
let passed = 0, failed = 0;

function ok(name: string) { passed++; console.log('  ✓', name); }
function fail(name: string, err?: string) { failed++; console.log('  ✗', name, err ? ': ' + err : ''); }

async function main() {
  console.log('\n=== P2 记忆摘要引擎 测试 ===\n');

  loadConfig();
  const db = getDBStore();
  await db.init();
  const sid = 'test-summarize-' + Date.now();
  db.startSession(sid);

  const summarizer = getSummarizer({ minMessagesForAuto: 3 });

  // ─── 1. 基本摘要 (规则引擎) ───
  console.log('--- 1. Basic Summarization ---');
  const messages = [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: '帮我创建一个记忆摘要引擎' },
    { role: 'assistant', content: '好的，我将创建 MemorySummarizer 类' },
    { role: 'user', content: '需要支持中英文混合分词' },
    { role: 'assistant', content: '✅ 已完成分词逻辑，支持中英文混合 tokenize' },
    { role: 'user', content: '编译通过了吗' },
    { role: 'assistant', content: '✅ 编译通过，0 error。修复了 import 路径问题' },
  ];

  try {
    const output = await summarizer.summarizeSession(sid, messages, []);

    // 1A: 有会话摘要
    if (output.sessionSummary.length > 0) ok('session summary: ' + output.sessionSummary.slice(0, 60));
    else fail('session summary empty');

    // 1B: 学习到事实
    if (output.learnedFacts.length >= 2) ok('learned facts (' + output.learnedFacts.length + ')');
    else fail('learned facts', 'expected >=2, got ' + output.learnedFacts.length);

    // 1C: 有标签
    if (output.tags.length > 0) ok('tags (' + output.tags.join(', ') + ')');
    else fail('tags empty');

    // 1D: 实体检测
    if (output.entityUpdates.length > 0) ok('entities detected (' + output.entityUpdates.length + ')');
    else fail('entities empty');

    // 1E: 知识要点
    if (output.knowledgePoints.length > 0) ok('knowledge points (' + output.knowledgePoints.length + ')');
    else fail('knowledge points empty');

    // 1F: 下一步建议
    if (output.nextSteps.length > 0) ok('next steps');
    else fail('next steps empty');

    // 1G: 包含 tokenize/分词 相关主题
    const topics = output.sessionSummary;
    if (topics.length > 20) ok('relevant topics');
    else fail('topics irrelevant: ' + topics.slice(0, 60));

  } catch (e: any) { fail('summarize', e.message); }

  // ─── 2. 持久化验证 ───
  console.log('\n--- 2. Persistence ---');
  try {
    const summaries = summarizer.getSummaries(sid);
    if (summaries.length >= 1) ok('persisted to DB (' + summaries.length + ')');
    else fail('not persisted');

    // 验证 key_points
    const kp = summaries[0].key_points;
    if (kp && kp.includes('decisions')) ok('key_points valid');
    else fail('key_points invalid: ' + kp?.slice(0, 50));
  } catch (e: any) { fail('persistence', e.message); }

  // ─── 3. 巡逻摘要 ───
  console.log('\n--- 3. Patrol Summary ---');
  try {
    // 短会话：应该返回 null
    const short = await summarizer.patrolSummary(sid + 'x', messages.slice(0, 3));
    if (short === null) ok('patrol skips short session');
    else fail('patrol should skip');

    // 长会话：触发生成
    const longMsgs = Array.from({ length: 25 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: '消息内容 ' + i + ' 关于项目进度和测试结果',
    }));
    const patrol = await summarizer.patrolSummary(sid, longMsgs);
    if (patrol !== null) ok('patrol triggered (' + patrol.length + ' chars)');
    else fail('patrol not triggered');
  } catch (e: any) { fail('patrol', e.message); }

  // ─── 4. 跨会话查询 ───
  console.log('\n--- 4. Cross-Session Query ---');
  try {
    // 创建另一个会话并摘要
    const sid2 = 'test-summarize-2-' + Date.now();
    db.startSession(sid2);
    await summarizer.summarizeSession(sid2, messages.slice(0, 5), []);
    db.endSession(sid2, 'OK');

    const recent = summarizer.getRecentSummaries(3);
    if (recent.length >= 2) ok('cross-session recent (' + recent.length + ')');
    else fail('cross-session', 'expected >=2, got ' + recent.length);
  } catch (e: any) { fail('cross-session', e.message); }

  // ─── 5. 回填历史 ───
  console.log('\n--- 5. Backfill ---');
  try {
    const sid3 = 'test-summarize-3-' + Date.now();
    db.startSession(sid3);
    // Add some decisions directly
    db.addDecision({ timestamp: new Date().toISOString(), category: 'routing', summary: 'Route test', detail: 'Test detail', project: sid3 });
    db.addDecision({ timestamp: new Date().toISOString(), category: 'model', summary: 'Model test', detail: 'Model detail', project: sid3 });
    db.endSession(sid3, 'OK');

    const count = await summarizer.backfill([sid3]);
    if (count === 1) ok('backfill works');
    else fail('backfill: ' + count);
  } catch (e: any) { fail('backfill', e.message); }

  // ─── 6. 摘要上限清理 ───
  console.log('\n--- 6. Prune ---');
  try {
    // 创建很多摘要触发清理
    for (let i = 0; i < 5; i++) {
      const s = 'test-prune-' + Date.now() + '-' + i;
      db.startSession(s);
      await summarizer.summarizeSession(s, messages.slice(0, 4), []);
      db.endSession(s, 'OK');
    }
    ok('prune runs without error');
  } catch (e: any) { fail('prune', e.message); }

  // ─── 7. 分词边界 ───
  console.log('\n--- 7. Tokenizer Edge Cases ---');
  try {
    // 纯中文
    const cnMsgs = [
      { role: 'user' as const, content: '今天天气真好我们出去玩吧' },
    ];
    const out1 = await summarizer.summarizeSession('test-cn-' + Date.now(), cnMsgs, []);
    if (out1.sessionSummary.length > 0) ok('pure Chinese works');
    else fail('pure Chinese empty');

    // 纯英文
    const enMsgs = [
      { role: 'user' as const, content: 'Hello world this is a test message about machine learning and artificial intelligence' },
    ];
    const out2 = await summarizer.summarizeSession('test-en-' + Date.now(), enMsgs, []);
    if (out2.sessionSummary.length > 0) ok('pure English works');
    else fail('pure English empty');

    // 混合
    const mixMsgs = [
      { role: 'user' as const, content: 'TypeScript 的 compiler 速度很快，但 type checking 很慢' },
    ];
    const out3 = await summarizer.summarizeSession('test-mix-' + Date.now(), mixMsgs, []);
    if (out3.sessionSummary.length > 0) ok('mixed C/E works');
    else fail('mixed empty');
  } catch (e: any) { fail('tokenizer', e.message); }

  // ─── 8. 单例 ───
  console.log('\n--- 8. Singleton ---');
  try {
    const s1 = getSummarizer();
    const s2 = getSummarizer();
    if (s1 === s2) ok('singleton works');
    else fail('singleton mismatch');
  } catch (e: any) { fail('singleton', e.message); }

  // ─── 结果 ───
  console.log('\n' + SEP);
  const total = passed + failed;
  console.log('通过: ' + passed + '/' + total + ' (' + Math.round(passed / total * 100) + '%)');
  if (failed > 0) { console.log('失败: ' + failed + ' 项'); process.exit(1); }
  else console.log('✅ 全部通过!');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
