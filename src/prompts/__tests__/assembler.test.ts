// PromptAssembler 单元测试 - 验证提示词组装逻辑
import * as path from 'path';

// 类型定义
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AssembleOptions {
  identityTemplateId?: string;
  identityVars?: Record<string, string>;
  memoryBlock?: string;
  experienceBlock?: string;
  context: ChatMessage[];
  taskInstruction?: string;
  userInput?: string;
  wrapper?: 'minimal' | 'structured' | 'verbose';
}

interface AssembledPrompt {
  messages: ChatMessage[];
  metadata: {
    systemIdentityLen: number;
    memoryBlockLen: number;
    experienceBlockLen: number;
    contextMsgCount: number;
    taskInstructionLen: number;
    userInputLen: number;
    totalMessages: number;
    hasMemory: boolean;
    hasExperience: boolean;
    hasSummary: boolean;
  };
}

// 模拟模板
interface MockTemplate {
  system?: string;
  user?: string;
}

// 模拟 PromptAssembler 类
class TestPromptAssembler {
  private templates: Map<string, MockTemplate> = new Map();
  
  constructor() {
    // 注册默认模板
    this.templates.set('agent.identity', {
      system: 'You are an intelligent Agent assistant. Reply concisely and directly.'
    });
    
    this.templates.set('agent.memory', {
      user: '[历史背景]\n{{memoryBlock}}'
    });
    
    this.templates.set('context.summary-block', {
      user: '[此前对话摘要]\n{{summary}}'
    });
  }
  
  get(id: string, vars?: Record<string, string>): MockTemplate {
    const tpl = this.templates.get(id);
    if (!tpl) return { system: 'Template not found: ' + id };
    
    // 简单变量替换
    let system = tpl.system;
    let user = tpl.user;
    
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        const placeholder = '{{' + key + '}}';
        if (system) system = system.replace(placeholder, value);
        if (user) user = user.replace(placeholder, value);
      }
    }
    
    return { system, user };
  }
  
  assemble(options: AssembleOptions): AssembledPrompt {
    const {
      identityTemplateId = 'agent.identity',
      identityVars,
      memoryBlock,
      experienceBlock,
      context,
      taskInstruction,
      userInput,
    } = options;
    
    const messages: ChatMessage[] = [];
    const meta = {
      systemIdentityLen: 0,
      memoryBlockLen: 0,
      experienceBlockLen: 0,
      contextMsgCount: 0,
      taskInstructionLen: 0,
      userInputLen: 0,
      totalMessages: 0,
      hasMemory: false,
      hasExperience: false,
      hasSummary: false,
    };
    
    // Step 1: System Identity
    const identityTpl = this.get(identityTemplateId, identityVars);
    const identityContent = identityTpl.system || 'You are an intelligent Agent assistant.';
    messages.push({ role: 'system', content: identityContent });
    meta.systemIdentityLen = identityContent.length;
    
    // Step 2: Memory Block
    if (memoryBlock && memoryBlock.trim()) {
      const memTpl = this.get('agent.memory', { memoryBlock: memoryBlock.trim() });
      const memContent = memTpl.user || `[历史背景]\n${memoryBlock.trim()}`;
      messages.push({ role: 'user', content: memContent });
      messages.push({ role: 'assistant', content: '好的，我已了解历史背景。' });
      meta.memoryBlockLen = memoryBlock.length;
      meta.hasMemory = true;
    }
    
    // Step 2.5: Experience Block
    if (experienceBlock && experienceBlock.trim()) {
      messages.push({ role: 'user', content: experienceBlock.trim() });
      messages.push({ role: 'assistant', content: '好的，我已了解相关经验。' });
      meta.experienceBlockLen = experienceBlock.length;
      meta.hasExperience = true;
    }
    
    // Step 3: Conversation Context
    const filteredContext = context.filter(m => m.role !== 'system');
    
    for (const msg of filteredContext) {
      if (msg.role === 'user' && this.isSummaryMessage(msg.content)) {
        meta.hasSummary = true;
        messages.push(msg);
      } else {
        messages.push(msg);
      }
    }
    meta.contextMsgCount = filteredContext.length;
    
    // Step 4: Task Instruction
    if (taskInstruction && taskInstruction.trim()) {
      messages.push({ role: 'user', content: taskInstruction.trim() });
      messages.push({ role: 'assistant', content: '明白，我会按照上述要求执行。' });
      meta.taskInstructionLen = taskInstruction.length;
    }
    
    // Step 5: User Input
    if (userInput && userInput.trim()) {
      const lastMsg = messages[messages.length - 1];
      if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== userInput.trim()) {
        messages.push({ role: 'user', content: userInput.trim() });
      }
      meta.userInputLen = userInput.length;
    }
    
    meta.totalMessages = messages.length;
    
    return { messages, metadata: meta };
  }
  
  private isSummaryMessage(content: string): boolean {
    return (
      content.includes('[SUMMARY]') ||
      content.includes('[此前对话摘要]') ||
      content.includes('[Conversation Summary]') ||
      content.includes('===压缩摘要===')
    );
  }
}

// ─── 测试函数 ──────────────────────────────────────────────────────────────

async function testAssembleBasic() {
  console.log('\n=== 测试 1: 基本组装功能 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const assembler = new TestPromptAssembler();
    
    // 测试 1.1: 最小化组装（仅 context）
    const result1 = assembler.assemble({
      context: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ]
    });
    
    if (result1.messages.length === 3) {
      console.log(`  ✅ 最小化组装: ${result1.messages.length} 条消息`);
      passed++;
    } else {
      console.log(`  ❌ 消息数量错误: ${result1.messages.length}`);
      failed++;
    }
    
    if (result1.messages[0].role === 'system') {
      console.log('  ✅ 第一条消息为 system 角色');
      passed++;
    } else {
      console.log('  ❌ 第一条消息应为 system');
      failed++;
    }
    
    // 测试 1.2: 完整组装
    const result2 = assembler.assemble({
      memoryBlock: 'Historical context here',
      experienceBlock: 'Relevant experience',
      context: [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' }
      ],
      taskInstruction: 'Complete the task',
      userInput: 'Final input'
    });
    
    if (result2.metadata.hasMemory && result2.metadata.hasExperience) {
      console.log('  ✅ Memory 和 Experience 正确注入');
      passed++;
    } else {
      console.log('  ❌ Memory 或 Experience 未正确注入');
      failed++;
    }
    
    if (result2.messages[result2.messages.length - 1].role === 'user') {
      console.log('  ✅ 最后一条消息为 user 角色');
      passed++;
    } else {
      console.log('  ❌ 最后一条消息应为 user');
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testEmptyContext() {
  console.log('\n=== 测试 2: 空上下文处理 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const assembler = new TestPromptAssembler();
    
    // 测试 2.1: 空上下文
    const result1 = assembler.assemble({
      context: [],
      userInput: 'Only user input'
    });
    
    if (result1.messages.length === 2) {
      console.log('  ✅ 空上下文时仅包含 system 和 user input');
      passed++;
    } else {
      console.log(`  ❌ 消息数量错误: ${result1.messages.length}`);
      failed++;
    }
    
    if (result1.metadata.contextMsgCount === 0) {
      console.log('  ✅ contextMsgCount 正确为 0');
      passed++;
    } else {
      console.log(`  ❌ contextMsgCount 应为 0`);
      failed++;
    }
    
    // 测试 2.2: 仅 system 消息的上下文
    const result2 = assembler.assemble({
      context: [
        { role: 'system', content: 'System message' }
      ],
      userInput: 'Test'
    });
    
    if (!result2.messages.some(m => m.content === 'System message')) {
      console.log('  ✅ System 消息已过滤（不重复注入）');
      passed++;
    } else {
      console.log('  ❌ System 消息应被过滤');
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testLargeContext() {
  console.log('\n=== 测试 3: 大上下文处理 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const assembler = new TestPromptAssembler();
    
    // 生成大量消息
    const largeContext: ChatMessage[] = [];
    for (let i = 0; i < 100; i++) {
      largeContext.push({ role: 'user', content: `User message ${i}: ${'x'.repeat(100)}` });
      largeContext.push({ role: 'assistant', content: `Assistant response ${i}: ${'y'.repeat(100)}` });
    }
    
    const result = assembler.assemble({
      context: largeContext,
      userInput: 'Final question'
    });
    
    // 验证消息数量（system + 200 context + 1 user input）
    const expectedCount = 1 + largeContext.length + 1;
    if (result.messages.length === expectedCount) {
      console.log(`  ✅ 大上下文正确处理: ${result.messages.length} 条消息`);
      passed++;
    } else {
      console.log(`  ❌ 消息数量错误: 期望 ${expectedCount}，实际 ${result.messages.length}`);
      failed++;
    }
    
    // 验证最后一条是用户输入
    const lastMsg = result.messages[result.messages.length - 1];
    if (lastMsg.role === 'user' && lastMsg.content === 'Final question') {
      console.log('  ✅ 最后一条消息为用户输入');
      passed++;
    } else {
      console.log('  ❌ 最后一条消息应为用户输入');
      failed++;
    }
    
    // 验证 metadata 统计
    if (result.metadata.contextMsgCount === largeContext.length) {
      console.log('  ✅ contextMsgCount 正确统计');
      passed++;
    } else {
      console.log(`  ❌ contextMsgCount 错误: ${result.metadata.contextMsgCount}`);
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testSummaryInjection() {
  console.log('\n=== 测试 4: 摘要注入 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const assembler = new TestPromptAssembler();
    
    // 测试 4.1: 包含摘要标记的上下文
    const result1 = assembler.assemble({
      context: [
        { role: 'user', content: 'Question 1' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user', content: '[SUMMARY] Previous conversation summary here...' },
        { role: 'assistant', content: 'Understood' }
      ],
      userInput: 'New question'
    });
    
    if (result1.metadata.hasSummary) {
      console.log('  ✅ 摘要正确识别');
      passed++;
    } else {
      console.log('  ❌ 摘要未正确识别');
      failed++;
    }
    
    // 测试 4.2: 不同摘要格式
    const summaryFormats = [
      '[SUMMARY] content',
      '[此前对话摘要] content',
      '[Conversation Summary] content',
      '===压缩摘要=== content'
    ];
    
    for (const fmt of summaryFormats) {
      const result = assembler.assemble({
        context: [
          { role: 'user', content: fmt }
        ],
        userInput: 'Test'
      });
      
      if (result.metadata.hasSummary) {
        console.log(`  ✅ 识别摘要格式: "${fmt.slice(0, 20)}..."`);
        passed++;
      } else {
        console.log(`  ❌ 未识别摘要格式: "${fmt.slice(0, 20)}..."`);
        failed++;
      }
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testMetadataAccuracy() {
  console.log('\n=== 测试 5: 元数据准确性 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const assembler = new TestPromptAssembler();
    
    const memoryBlock = 'Historical memory content';
    const experienceBlock = 'Experience knowledge base';
    const taskInstruction = 'Task instruction text';
    const userInput = 'User input content';
    
    const result = assembler.assemble({
      memoryBlock,
      experienceBlock,
      context: [
        { role: 'user', content: 'Context message' }
      ],
      taskInstruction,
      userInput
    });
    
    // 验证各字段长度
    if (result.metadata.memoryBlockLen === memoryBlock.length) {
      console.log('  ✅ memoryBlockLen 正确');
      passed++;
    } else {
      console.log(`  ❌ memoryBlockLen 错误: ${result.metadata.memoryBlockLen} != ${memoryBlock.length}`);
      failed++;
    }
    
    if (result.metadata.experienceBlockLen === experienceBlock.length) {
      console.log('  ✅ experienceBlockLen 正确');
      passed++;
    } else {
      console.log(`  ❌ experienceBlockLen 错误: ${result.metadata.experienceBlockLen} != ${experienceBlock.length}`);
      failed++;
    }
    
    if (result.metadata.taskInstructionLen === taskInstruction.length) {
      console.log('  ✅ taskInstructionLen 正确');
      passed++;
    } else {
      console.log(`  ❌ taskInstructionLen 错误: ${result.metadata.taskInstructionLen} != ${taskInstruction.length}`);
      failed++;
    }
    
    if (result.metadata.userInputLen === userInput.length) {
      console.log('  ✅ userInputLen 正确');
      passed++;
    } else {
      console.log(`  ❌ userInputLen 错误: ${result.metadata.userInputLen} != ${userInput.length}`);
      failed++;
    }
    
    if (result.metadata.totalMessages === result.messages.length) {
      console.log('  ✅ totalMessages 正确');
      passed++;
    } else {
      console.log(`  ❌ totalMessages 错误: ${result.metadata.totalMessages} != ${result.messages.length}`);
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testEdgeCases() {
  console.log('\n=== 测试 6: 边界情况 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const assembler = new TestPromptAssembler();
    
    // 测试 6.1: 空 memoryBlock
    const result1 = assembler.assemble({
      memoryBlock: '',
      context: [],
      userInput: 'Test'
    });
    
    if (!result1.metadata.hasMemory) {
      console.log('  ✅ 空 memoryBlock 不注入');
      passed++;
    } else {
      console.log('  ❌ 空 memoryBlock 应不注入');
      failed++;
    }
    
    // 测试 6.2: 空白 memoryBlock
    const result2 = assembler.assemble({
      memoryBlock: '   ',
      context: [],
      userInput: 'Test'
    });
    
    if (!result2.metadata.hasMemory) {
      console.log('  ✅ 空白 memoryBlock 不注入');
      passed++;
    } else {
      console.log('  ❌ 空白 memoryBlock 应不注入');
      failed++;
    }
    
    // 测试 6.3: user input 与 context 最后一条相同
    const result3 = assembler.assemble({
      context: [
        { role: 'user', content: 'Duplicate input' }
      ],
      userInput: 'Duplicate input'
    });
    
    const duplicateCount = result3.messages.filter(m => m.content === 'Duplicate input').length;
    if (duplicateCount === 1) {
      console.log('  ✅ 重复 user input 不重复添加');
      passed++;
    } else {
      console.log(`  ❌ 重复 user input 应只出现一次，实际 ${duplicateCount} 次`);
      failed++;
    }
    
    // 测试 6.4: 特殊字符内容
    const specialContent = '{{template}} <script>alert("xss")</script> \\n \\t';
    const result4 = assembler.assemble({
      context: [
        { role: 'user', content: specialContent }
      ],
      userInput: 'Test'
    });
    
    if (result4.messages.some(m => m.content === specialContent)) {
      console.log('  ✅ 特殊字符内容正确保留');
      passed++;
    } else {
      console.log('  ❌ 特殊字符内容丢失');
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

// ─── 主函数 ────────────────────────────────────────────────────────────────

async function main() {
  console.log('开始 PromptAssembler 单元测试...\n');
  console.log('='.repeat(70));
  
  let allPass = true;
  allPass = (await testAssembleBasic()) && allPass;
  allPass = (await testEmptyContext()) && allPass;
  allPass = (await testLargeContext()) && allPass;
  allPass = (await testSummaryInjection()) && allPass;
  allPass = (await testMetadataAccuracy()) && allPass;
  allPass = (await testEdgeCases()) && allPass;
  
  console.log('='.repeat(70));
  if (allPass) {
    console.log('✅ 所有测试通过！\n');
  } else {
    console.log('❌ 部分测试失败，请检查上述输出\n');
  }
  
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
