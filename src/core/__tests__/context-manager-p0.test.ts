// P0 修复单元测试 — 验证 ContextManager 压缩摘要的 role 为 'user'
import { ContextManager } from '../context-manager';
import type { ChatMessage } from '../../models/adapters/lmstudio';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 创建测试消息 */
function createMessages(count: number, baseLength: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    const content = `这是第 ${i + 1} 条测试消息。` + '这是测试内容。'.repeat(baseLength);
    msgs.push({
      role: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'system',
      content,
    });
  }
  return msgs;
}

/** 模拟 summarizer（返回一个固定摘要） */
async function mockSummarizer(prompt: string): Promise<string> {
  return `[自动摘要] 这是对 ${prompt.length} 字符的对话内容的摘要。`;
}

// ─── 测试用例 ───────────────────────────────────────────────────────────────

async function testSimpleTruncate() {
  console.log('\n=== 测试 1: _simpleTruncate (attentionEnabled=false) ===');
  
  const cm = new ContextManager({
    maxTokens: 500,
    hotWindowSize: 5,
    summaryTokenBudget: 200,
    compressionThreshold: 0.75,
    preserveToolResults: true,
    preserveSystem: true,
    attentionEnabled: false,  // 关键：关闭注意力，触发 _simpleTruncate
  });

  // 创建足够多的消息触发压缩（~3000 tokens）
  const msgs = createMessages(20, 50);
  console.log(`输入: ${msgs.length} 条消息`);

  const result = await cm.process(msgs, '当前用户问题', mockSummarizer);
  
  console.log(`压缩: ${result.compressed}`);
  console.log(`输出消息数: ${result.messages.length}`);
  
  // 检查是否有 role: 'user' 的摘要块
  const summaryMsgs = result.messages.filter(m => 
    m.content?.includes('[部分历史已截断]') || 
    m.content?.includes('[对话历史摘要]')
  );
  
  if (summaryMsgs.length > 0) {
    const allUserRole = summaryMsgs.every(m => m.role === 'user');
    console.log(`✅ 找到 ${summaryMsgs.length} 个摘要块，role 均为 'user': ${allUserRole}`);
    if (!allUserRole) {
      summaryMsgs.forEach(m => console.log(`   ❌ 错误 role: ${m.role}`));
    }
  } else {
    console.log('⚠️  未找到摘要块（可能压缩逻辑未触发）');
  }
  
  return result;
}

async function testNormalCompression() {
  console.log('\n=== 测试 2: 正常压缩 (attentionEnabled=true) ===');
  
  const cm = new ContextManager({
    maxTokens: 800,
    hotWindowSize: 5,
    summaryTokenBudget: 200,
    compressionThreshold: 0.75,
    preserveToolResults: true,
    preserveSystem: true,
    attentionEnabled: true,  // 正常路径
  });

  // 创建足够多的消息触发压缩
  const msgs = createMessages(25, 60);
  console.log(`输入: ${msgs.length} 条消息`);

  const result = await cm.process(msgs, '当前用户问题', mockSummarizer);
  
  console.log(`压缩: ${result.compressed}`);
  console.log(`输出消息数: ${result.messages.length}`);
  
  // 检查是否有 role: 'user' 的摘要块
  const summaryMsgs = result.messages.filter(m => 
    m.content?.includes('[此前对话摘要]') || 
    m.content?.includes('[对话历史摘要]')
  );
  
  if (summaryMsgs.length > 0) {
    const allUserRole = summaryMsgs.every(m => m.role === 'user');
    console.log(`✅ 找到 ${summaryMsgs.length} 个摘要块，role 均为 'user': ${allUserRole}`);
    if (!allUserRole) {
      summaryMsgs.forEach(m => console.log(`   ❌ 错误 role: ${m.role}`));
    }
  } else {
    console.log('⚠️  未找到摘要块（可能压缩逻辑未触发或 summarizer 未生成摘要）');
  }
  
  return result;
}

async function testOverBudgetSummary() {
  console.log('\n=== 测试 3: 摘要超预算 (summary over budget) ===');
  
  const cm = new ContextManager({
    maxTokens: 800,
    hotWindowSize: 5,
    summaryTokenBudget: 50,  // 很小的预算，让摘要超预算
    compressionThreshold: 0.75,
    preserveToolResults: true,
    preserveSystem: true,
    attentionEnabled: true,
  });

  const msgs = createMessages(30, 80);
  console.log(`输入: ${msgs.length} 条消息`);

  const result = await cm.process(msgs, '当前用户问题', mockSummarizer);
  
  console.log(`压缩: ${result.compressed}`);
  
  // 检查是否有 role: 'user' 的摘要块（超预算情况）
  const summaryMsgs = result.messages.filter(m => 
    m.content?.includes('[对话历史摘要]')
  );
  
  if (summaryMsgs.length > 0) {
    const allUserRole = summaryMsgs.every(m => m.role === 'user');
    console.log(`✅ 找到 ${summaryMsgs.length} 个摘要块，role 均为 'user': ${allUserRole}`);
  } else {
    console.log('⚠️  未找到 [对话历史摘要] 块');
  }
  
  return result;
}

// ─── 主函数 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('开始 P0 修复单元测试...\n');
  
  try {
    await testSimpleTruncate();
    await testNormalCompression();
    await testOverBudgetSummary();
    
    console.log('\n✅ 所有测试完成！');
    console.log('请检查上述输出，确认所有摘要块的 role 均为 "user"。');
  } catch (err) {
    console.error('\n❌ 测试失败:', err);
    process.exit(1);
  }
}

main();
