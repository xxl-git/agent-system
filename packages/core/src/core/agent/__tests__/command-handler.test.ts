// CommandHandler 单元测试 - 验证命令处理逻辑
import * as path from 'path';

// 类型定义


/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
}

interface MockDeps {
  messages: any[];
  adapter: any;
  sessionId: string;
  projectManager: any;
  registry: any;
  buildStatus: () => string;
}

// 模拟 CommandHandler 类（简化版）
class TestCommandHandler {
  private deps: MockDeps;
  
  constructor(deps: MockDeps) {
    this.deps = deps;
  }
  
  async handle(input: string): Promise<string> {
    // 解析命令和参数（保持参数原样，只转换命令部分）
    const full = input.slice(1).trim();  // 去掉开头的 '/' 和首尾空格
    const firstSpaceIdx = full.indexOf(' ');
    
    let action: string;
    let args: string[];
    
    if (firstSpaceIdx === -1) {
      // 无参数命令
      action = full.toLowerCase();
      args = [action];
    } else {
      // 有参数命令：只转换命令部分，参数部分保持原样
      const cmdPart = full.slice(0, firstSpaceIdx);
      const argPart = full.slice(firstSpaceIdx + 1).trimStart();  // 去掉参数部分开头的空格
      
      action = cmdPart.toLowerCase();
      // 分割参数（多个空格合并为一个分隔符）
      args = [action, ...argPart.split(/\s+/).filter(s => s.length > 0)];
    }
    
    switch (action) {
      case 'exit':
      case 'quit':
        return 'EXIT_REQUESTED';
        
      case 'history':
        return this.handleHistory();
        
      case 'status':
        return this.deps.buildStatus();
        
      case 'project':
        return this.handleProject(args.slice(1));
        
      case 'skills':
        return this.handleSkills(args.slice(1));
        
      case 'help':
        return this.handleHelp();
        
      case 'echo':
        return args.slice(1).join(' ') || '(empty)';
        
      case 'invalid':
        throw new Error('Command validation failed');
        
      default:
        return 'Unknown command: ' + action + '. Type /help for available commands.';
    }
  }
  
  private handleHistory(): string {
    if (this.deps.messages.length <= 1) return 'No history';
    return 'History:\n' + 
      this.deps.messages
        .filter((m: any) => m.role !== 'system')
        .map((m: any) => '[' + m.role + '] ' + m.content.slice(0, 100))
        .join('\n');
  }
  
  private handleProject(args: string[]): string {
    const sub = args[0] || 'list';
    
    switch (sub) {
      case 'list':
        const projects = this.deps.projectManager.listProjects();
        return projects.length ? 'Projects:\n' + projects.join('\n') : 'No projects';
        
      case 'create':
        const name = args[1] || 'default-project';
        return 'Created: ' + name;
        
      case 'switch':
        if (!args[1]) return 'Usage: /project switch <name>';
        return 'Switched: ' + args[1];
        
      default:
        return 'Project: /project list|create|switch';
    }
  }
  
  private handleSkills(args: string[]): string {
    const sub = args[0] || 'list';
    
    switch (sub) {
      case 'list':
        const skills = this.deps.registry.list();
        return skills.length ? 'Skills:\n' + skills.join('\n') : 'No skills';
        
      case 'apply':
        if (!args[1]) return 'Usage: /skills apply <name>';
        return 'Applied: ' + args[1];
        
      default:
        return 'Skills: /skills list|apply';
    }
  }
  
  private handleHelp(): string {
    return `Available commands:
  /exit, /quit - Exit the agent
  /history - Show conversation history
  /status - Show agent status
  /project - Project management (list|create|switch)
  /skills - Skill management (list|apply)
  /help - Show this help message`;
  }
}

// ─── 测试辅助函数 ──────────────────────────────────────────────────────────

function createMockDeps(overrides?: Partial<MockDeps>): MockDeps {
  return {
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'First user message' },
      { role: 'assistant', content: 'First assistant response' },
      { role: 'user', content: 'Second user message' }
    ],
    adapter: { model: 'test-model' },
    sessionId: 'test-session-001',
    projectManager: {
      listProjects: () => ['project-1', 'project-2'],
      createProject: (name: string) => name,
      switchProject: (name: string) => name
    },
    registry: {
      list: () => ['skill-1', 'skill-2'],
      apply: (name: string) => 'Applied: ' + name
    },
    buildStatus: () => 'Status: OK',
    ...overrides
  };
}

// ─── 测试函数 ──────────────────────────────────────────────────────────────

async function testHandleMethod() {
  console.log('\n=== 测试 1: handle() 方法（各种命令） ===');
  
  let passed = 0, failed = 0;
  
  try {
    const deps = createMockDeps();
    const handler = new TestCommandHandler(deps);
    
    // 测试 1.1: /exit 命令
    const result1 = await handler.handle('/exit');
    if (result1 === 'EXIT_REQUESTED') {
      console.log('  ✅ /exit 命令正确');
      passed++;
    } else {
      console.log(`  ❌ /exit 期望 "EXIT_REQUESTED"，实际 "${result1}"`);
      failed++;
    }
    
    // 测试 1.2: /quit 命令
    const result2 = await handler.handle('/quit');
    if (result2 === 'EXIT_REQUESTED') {
      console.log('  ✅ /quit 命令正确');
      passed++;
    } else {
      console.log(`  ❌ /quit 期望 "EXIT_REQUESTED"，实际 "${result2}"`);
      failed++;
    }
    
    // 测试 1.3: /history 命令
    const result3 = await handler.handle('/history');
    if (result3.includes('First user message') && result3.includes('Second user message')) {
      console.log('  ✅ /history 命令正确');
      passed++;
    } else {
      console.log(`  ❌ /history 输出不正确`);
      failed++;
    }
    
    // 测试 1.4: /status 命令
    const result4 = await handler.handle('/status');
    if (result4 === 'Status: OK') {
      console.log('  ✅ /status 命令正确');
      passed++;
    } else {
      console.log(`  ❌ /status 期望 "Status: OK"，实际 "${result4}"`);
      failed++;
    }
    
    // 测试 1.5: /help 命令
    const result5 = await handler.handle('/help');
    if (result5.includes('/exit') && result5.includes('/history') && result5.includes('/status')) {
      console.log('  ✅ /help 命令正确');
      passed++;
    } else {
      console.log(`  ❌ /help 缺少必要命令说明`);
      failed++;
    }
    
    // 测试 1.6: 未知命令
    const result6 = await handler.handle('/unknown');
    if (result6.includes('Unknown command')) {
      console.log('  ✅ 未知命令正确处理');
      passed++;
    } else {
      console.log(`  ❌ 未知命令应提示错误`);
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testCommandParsing() {
  console.log('\n=== 测试 2: 命令解析和验证 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const deps = createMockDeps();
    const handler = new TestCommandHandler(deps);
    
    // 测试 2.1: 带参数的命令
    const result1 = await handler.handle('/echo Hello World Test');
    if (result1 === 'Hello World Test') {
      console.log('  ✅ 命令参数正确解析');
      passed++;
    } else {
      console.log(`  ❌ 参数解析错误: ${result1}`);
      failed++;
    }
    
    // 测试 2.2: 空参数
    const result2 = await handler.handle('/echo');
    if (result2 === '(empty)') {
      console.log('  ✅ 空参数正确处理');
      passed++;
    } else {
      console.log(`  ❌ 空参数应返回 "(empty)"`);
      failed++;
    }
    
    // 测试 2.3: 大小写不敏感
    const result3 = await handler.handle('/EXIT');
    if (result3 === 'EXIT_REQUESTED') {
      console.log('  ✅ 命令大小写不敏感');
      passed++;
    } else {
      console.log(`  ❌ 命令应不区分大小写`);
      failed++;
    }
    
    // 测试 2.4: 命令前后空格
    const result4 = await handler.handle('/exit  ');
    if (result4 === 'EXIT_REQUESTED') {
      console.log('  ✅ 命令前后空格正确处理');
      passed++;
    } else {
      console.log(`  ❌ 命令前后空格应被忽略`);
      failed++;
    }
    
    // 测试 2.5: 多空格分隔（应合并为单个空格）
    const result5 = await handler.handle('/echo  Hello   World  ');
    if (result5 === 'Hello World') {
      console.log('  ✅ 多空格分隔正确处理');
      passed++;
    } else {
      console.log(`  ❌ 多空格分隔错误: ${result5}`);
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testSubCommands() {
  console.log('\n=== 测试 3: 子命令处理 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const deps = createMockDeps();
    const handler = new TestCommandHandler(deps);
    
    // 测试 3.1: /project list
    const result1 = await handler.handle('/project list');
    if (result1.includes('project-1') && result1.includes('project-2')) {
      console.log('  ✅ /project list 正确');
      passed++;
    } else {
      console.log(`  ❌ /project list 输出错误`);
      failed++;
    }
    
    // 测试 3.2: /project create
    const result2 = await handler.handle('/project create test-project');
    if (result2 === 'Created: test-project') {
      console.log('  ✅ /project create 正确');
      passed++;
    } else {
      console.log(`  ❌ /project create 输出错误: ${result2}`);
      failed++;
    }
    
    // 测试 3.3: /project switch（缺少参数）
    const result3 = await handler.handle('/project switch');
    if (result3.includes('Usage:')) {
      console.log('  ✅ /project switch 缺少参数时提示用法');
      passed++;
    } else {
      console.log(`  ❌ 应提示用法`);
      failed++;
    }
    
    // 测试 3.4: /skills list
    const result4 = await handler.handle('/skills list');
    if (result4.includes('skill-1') && result4.includes('skill-2')) {
      console.log('  ✅ /skills list 正确');
      passed++;
    } else {
      console.log(`  ❌ /skills list 输出错误`);
      failed++;
    }
    
    // 测试 3.5: /skills apply（缺少参数）
    const result5 = await handler.handle('/skills apply');
    if (result5.includes('Usage:')) {
      console.log('  ✅ /skills apply 缺少参数时提示用法');
      passed++;
    } else {
      console.log(`  ❌ 应提示用法`);
      failed++;
    }
    
  } catch (err) {
    console.log(`  ❌ 测试异常: ${err}`);
    failed++;
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testErrorHandling() {
  console.log('\n=== 测试 4: 错误处理 ===');
  
  let passed = 0, failed = 0;
  
  try {
    const deps = createMockDeps();
    const handler = new TestCommandHandler(deps);
    
    // 测试 4.1: 命令执行抛出异常
    try {
      await handler.handle('/invalid');
      console.log('  ❌ 应抛出异常');
      failed++;
    } catch (err: unknown) {
      if (errorMessage(err) === 'Command validation failed') {
        console.log('  ✅ 命令异常正确抛出');
        passed++;
      } else {
        console.log(`  ❌ 错误消息不匹配: ${errorMessage(err)}`);
        failed++;
      }
    }
    
    // 测试 4.2: 空历史记录
    const depsEmpty = createMockDeps({
      messages: [{ role: 'system', content: 'System' }]
    });
    const handlerEmpty = new TestCommandHandler(depsEmpty);
    const result = await handlerEmpty.handle('/history');
    
    if (result === 'No history') {
      console.log('  ✅ 空历史记录正确处理');
      passed++;
    } else {
      console.log(`  ❌ 应返回 "No history"`);
      failed++;
    }
    
    // 测试 4.3: 空项目列表
    const depsEmptyProjects = createMockDeps({
      projectManager: { listProjects: () => [] }
    });
    const handlerEmptyProjects = new TestCommandHandler(depsEmptyProjects);
    const result2 = await handlerEmptyProjects.handle('/project list');
    
    if (result2 === 'No projects') {
      console.log('  ✅ 空项目列表正确处理');
      passed++;
    } else {
      console.log(`  ❌ 应返回 "No projects"`);
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
  console.log('开始 CommandHandler 单元测试...\n');
  console.log('='.repeat(70));
  
  let allPass = true;
  allPass = (await testHandleMethod()) && allPass;
  allPass = (await testCommandParsing()) && allPass;
  allPass = (await testSubCommands()) && allPass;
  allPass = (await testErrorHandling()) && allPass;
  
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
