// ChatHandler 单元测试 - 验证聊天处理逻辑
import * as path from 'path';

// 类型定义


/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface MockAdapter {
  model: string;
  ping: () => Promise<boolean>;
  call: (messages: ChatMessage[]) => Promise<{ choices: Array<{ message: { content: string } }> }>;
  getEffectiveContextWindow: () => number;
  markSessionReset: () => void;
}

// 模拟 ChatHandler 类（简化版）
class TestChatHandler {
  private adapter: MockAdapter;
  private messages: ChatMessage[];
  
  constructor(deps: { adapter: MockAdapter; messages: ChatMessage[] }) {
    this.adapter = deps.adapter;
    this.messages = deps.messages;
  }
  
  async handle(userInput: string): Promise<string> {
    // 模拟 ping 检查
    const alive = await this.adapter.ping();
    if (!alive) {
      throw new Error('model_unreachable');
    }
    
    // 模拟 LLM 调用
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: userInput }
    ];
    
    try {
      const response = await this.adapter.call(messages);
      const content = response.choices?.[0]?.message?.content;
      
      if (!content) {
        throw new Error('empty_response');
      }
      
      return content;
    } catch (err: unknown) {
      if (errorMessage(err)?.includes('timeout')) {
        throw new Error('llm_timeout');
      }
      throw err;
    }
  }
  
  async handleStream(userInput: string): Promise<string> {
    const alive = await this.adapter.ping();
    if (!alive) {
      throw new Error('model_unreachable');
    }
    
    // 模拟流式响应
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: userInput }
    ];
    
    const response = await this.adapter.call(messages);
    return response.choices?.[0]?.message?.content || '(empty)';
  }
}

// ─── 测试辅助函数 ──────────────────────────────────────────────────────────

function createMockAdapter(overrides?: Partial<MockAdapter>): MockAdapter {
  return {
    model: 'test-model',
    ping: async () => true,
    call: async (messages: ChatMessage[]) => ({
      choices: [{ message: { content: 'Mock response' } }]
    }),
    getEffectiveContextWindow: () => 4096,
    markSessionReset: () => {},
    ...overrides
  };
}

// ─── 测试函数 ──────────────────────────────────────────────────────────────

async function testHandleMethod() {
  console.log('\n=== 测试 1: handle() 方法 ===');
  
  let passed = 0, failed = 0;
  
  try {
    // 测试 1.1: 正常聊天
    const adapter1 = createMockAdapter();
    const handler1 = new TestChatHandler({
      adapter: adapter1,
      messages: []
    });
    
    const result1 = await handler1.handle('Hello');
    
    if (result1 === 'Mock response') {
      console.log('  ✅ 正常聊天返回正确响应');
      passed++;
    } else {
      console.log(`  ❌ 期望 "Mock response"，实际 "${result1}"`);
      failed++;
    }
    
    // 测试 1.2: 模型不可达
    const adapter2 = createMockAdapter({ ping: async () => false });
    const handler2 = new TestChatHandler({
      adapter: adapter2,
      messages: []
    });
    
    try {
      await handler2.handle('Test');
      console.log('  ❌ 应抛出 model_unreachable 错误');
      failed++;
    } catch (err: unknown) {
      if (errorMessage(err) === 'model_unreachable') {
        console.log('  ✅ 模型不可达时抛出正确错误');
        passed++;
      } else {
        console.log(`  ❌ 错误消息不匹配: ${errorMessage(err)}`);
        failed++;
      }
    }
    
    // 测试 1.3: 空响应
    const adapter3 = createMockAdapter({
      call: async () => ({ choices: [] })
    });
    const handler3 = new TestChatHandler({
      adapter: adapter3,
      messages: []
    });
    
    try {
      await handler3.handle('Test');
      console.log('  ❌ 应抛出 empty_response 错误');
      failed++;
    } catch (err: unknown) {
      if (errorMessage(err) === 'empty_response') {
        console.log('  ✅ 空响应时抛出正确错误');
        passed++;
      } else {
        console.log(`  ❌ 错误消息不匹配: ${errorMessage(err)}`);
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

async function testHandleStreamMethod() {
  console.log('\n=== 测试 2: handleStream() 方法 ===');
  
  let passed = 0, failed = 0;
  
  try {
    // 测试 2.1: 正常流式响应
    const adapter1 = createMockAdapter();
    const handler1 = new TestChatHandler({
      adapter: adapter1,
      messages: []
    });
    
    const result1 = await handler1.handleStream('Hello stream');
    
    if (result1 === 'Mock response') {
      console.log('  ✅ 流式聊天返回正确响应');
      passed++;
    } else {
      console.log(`  ❌ 期望 "Mock response"，实际 "${result1}"`);
      failed++;
    }
    
    // 测试 2.2: 模型不可达
    const adapter2 = createMockAdapter({ ping: async () => false });
    const handler2 = new TestChatHandler({
      adapter: adapter2,
      messages: []
    });
    
    try {
      await handler2.handleStream('Test');
      console.log('  ❌ 应抛出 model_unreachable 错误');
      failed++;
    } catch (err: unknown) {
      if (errorMessage(err) === 'model_unreachable') {
        console.log('  ✅ 流式聊天模型不可达时正确处理');
        passed++;
      } else {
        console.log(`  ❌ 错误消息不匹配: ${errorMessage(err)}`);
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

async function testErrorHandling() {
  console.log('\n=== 测试 3: 错误处理 ===');
  
  let passed = 0, failed = 0;
  
  try {
    // 测试 3.1: LLM 超时
    const adapter1 = createMockAdapter({
      call: async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        throw new Error('Request timeout after 5000ms');
      }
    });
    const handler1 = new TestChatHandler({
      adapter: adapter1,
      messages: []
    });
    
    try {
      await handler1.handle('Timeout test');
      console.log('  ❌ 应抛出超时错误');
      failed++;
    } catch (err: unknown) {
      if (errorMessage(err) === 'llm_timeout') {
        console.log('  ✅ LLM 超时正确处理');
        passed++;
      } else {
        console.log(`  ❌ 错误消息不匹配: ${errorMessage(err)}`);
        failed++;
      }
    }
    
    // 测试 3.2: 无效输入（空字符串）
    const adapter2 = createMockAdapter();
    const handler2 = new TestChatHandler({
      adapter: adapter2,
      messages: []
    });
    
    const result2 = await handler2.handle('');
    
    // 空输入应正常处理（或根据实际需求调整）
    if (result2 === 'Mock response') {
      console.log('  ✅ 空输入正常处理');
      passed++;
    } else {
      console.log(`  ❌ 空输入处理异常`);
      failed++;
    }
    
    // 测试 3.3: 特殊字符输入
    const adapter3 = createMockAdapter();
    const handler3 = new TestChatHandler({
      adapter: adapter3,
      messages: []
    });
    
    const specialInput = '<script>alert("xss")</script> {{template}} {{}}';
    const result3 = await handler3.handle(specialInput);
    
    if (result3 === 'Mock response') {
      console.log('  ✅ 特殊字符输入正常处理');
      passed++;
    } else {
      console.log(`  ❌ 特殊字符输入处理异常`);
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testMockDependencies() {
  console.log('\n=== 测试 4: Mock 依赖验证 ===');
  
  let passed = 0, failed = 0;
  
  try {
    // 验证 mock adapter 各方法可正确调用
    const adapter = createMockAdapter();
    
    // 验证 ping
    const pingResult = await adapter.ping();
    if (pingResult === true) {
      console.log('  ✅ mock adapter.ping() 正常');
      passed++;
    } else {
      console.log('  ❌ mock adapter.ping() 异常');
      failed++;
    }
    
    // 验证 call
    const callResult = await adapter.call([
      { role: 'user', content: 'Test' }
    ]);
    if (callResult.choices[0].message.content === 'Mock response') {
      console.log('  ✅ mock adapter.call() 正常');
      passed++;
    } else {
      console.log('  ❌ mock adapter.call() 异常');
      failed++;
    }
    
    // 验证 getEffectiveContextWindow
    const window = adapter.getEffectiveContextWindow();
    if (window === 4096) {
      console.log('  ✅ mock adapter.getEffectiveContextWindow() 正常');
      passed++;
    } else {
      console.log('  ❌ mock adapter.getEffectiveContextWindow() 异常');
      failed++;
    }
    
    // 验证 markSessionReset
    adapter.markSessionReset();
    console.log('  ✅ mock adapter.markSessionReset() 正常');
    passed++;
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

// ─── 主函数 ────────────────────────────────────────────────────────────────

async function main() {
  console.log('开始 ChatHandler 单元测试...\n');
  console.log('='.repeat(70));
  
  let allPass = true;
  allPass = (await testHandleMethod()) && allPass;
  allPass = (await testHandleStreamMethod()) && allPass;
  allPass = (await testErrorHandling()) && allPass;
  allPass = (await testMockDependencies()) && allPass;
  
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
