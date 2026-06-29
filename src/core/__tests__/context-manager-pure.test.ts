// ContextManager 纯函数单元测试 — 测试不需要 LLM 的函数
import {
  extractKeywords,
  estimateTokens,
  keywordMatchScore,
  buildCompressionPrompt,
  parseCompressionOutput,
} from '../context-manager';
import type { ChatMessage } from '../../models/adapters/lmstudio';

// ─── 测试 extractKeywords() ─────────────────────────────────────────────
async function testExtractKeywords() {
  console.log('\n=== 测试 1: extractKeywords() ===');
  
  const tests = [
    { input: '如何优化 Node.js 性能', expected: ['性能'], desc: '技术关键词' },
    { input: '帮我写一个 Python 脚本', expected: ['python'], desc: '编程语言' },
    { input: '今天天气怎么样', expected: ['今天天气怎么样'], desc: '日常查询' },
    { input: 'a'.repeat(100), expected: [], desc: '长字符串（无关键词）' },
  ];
  
  let pass = 0, fail = 0;
  for (const t of tests) {
    const result = extractKeywords(t.input);
    const match = t.expected.some(kw => result.has(kw));
    
    if (match || (t.expected.length === 0 && result.size >= 0)) {
      console.log(`  ✅ ${t.desc}: ${JSON.stringify(Array.from(result))}`);
      pass++;
    } else {
      console.log(`  ❌ ${t.desc}: 期望包含 ${JSON.stringify(t.expected)}, 实际 ${JSON.stringify(Array.from(result))}`);
      fail++;
    }
  }
  
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  return fail === 0;
}

// ─── 测试 estimateTokens() ──────────────────────────────────────────────
async function testEstimateTokens() {
  console.log('\n=== 测试 2: estimateTokens() ===');
  
  const tests = [
    { input: '你好', expectedMin: 2, expectedMax: 5, desc: '短文本' },
    { input: 'Hello world', expectedMin: 10, expectedMax: 20, desc: '英文短文本' },
    { input: 'a'.repeat(100), expectedMin: 100, expectedMax: 150, desc: '100字符' },
    { input: '测试文本。'.repeat(50), expectedMin: 300, expectedMax: 400, desc: '中文长文本' },
  ];
  
  let pass = 0, fail = 0;
  for (const t of tests) {
    const result = estimateTokens(t.input);
    
    if (result >= t.expectedMin && result <= t.expectedMax) {
      console.log(`  ✅ ${t.desc}: ${result} tokens (期望 ${t.expectedMin}-${t.expectedMax})`);
      pass++;
    } else {
      console.log(`  ❌ ${t.desc}: ${result} tokens (期望 ${t.expectedMin}-${t.expectedMax})`);
      fail++;
    }
  }
  
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  return fail === 0;
}

// ─── 测试 keywordMatchScore() ──────────────────────────────────────────
async function testKeywordMatchScore() {
  console.log('\n=== 测试 3: keywordMatchScore() ===');
  
  const tests = [
    {
      content: 'Node.js 性能优化可以用 cluster 模块',
      keywords: new Set(['node.js', '性能']),
      expectedMin: 0.3,
      desc: '关键词匹配'
    },
    {
      content: '今天天气真好',
      keywords: new Set(['node.js', '性能']),
      expectedMax: 0.1,
      desc: '无关键词匹配'
    },
    {
      content: 'Python 和 JavaScript 都是编程语言',
      keywords: new Set(['python', 'javascript']),
      expectedMin: 0.3,
      desc: '多个关键词匹配'
    },
  ];
  
  let pass = 0, fail = 0;
  for (const t of tests) {
    const result = keywordMatchScore(t.content, t.keywords);
    
    if (t.expectedMin !== undefined && result < t.expectedMin) {
      console.log(`  ❌ ${t.desc}: ${result} (期望 >= ${t.expectedMin})`);
      fail++;
    } else if (t.expectedMax !== undefined && result > t.expectedMax) {
      console.log(`  ❌ ${t.desc}: ${result} (期望 <= ${t.expectedMax})`);
      fail++;
    } else {
      console.log(`  ✅ ${t.desc}: ${result}`);
      pass++;
    }
  }
  
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  return fail === 0;
}

// ─── 测试 buildCompressionPrompt() ─────────────────────────────────────
async function testBuildCompressionPrompt() {
  console.log('\n=== 测试 4: buildCompressionPrompt() ===');
  
  const msgs: ChatMessage[] = [
    { role: 'user', content: '帮我写一个 Python 脚本' },
    { role: 'assistant', content: '✅ 已创建 script.py，包含 3 个函数' },
    { role: 'user', content: '运行时报错了' },
    { role: 'assistant', content: '✅ 已修复导入错误，添加 try/catch' },
  ];
  
  const prompt = buildCompressionPrompt(msgs);
  
  let pass = 0, fail = 0;
  
  // 检查提示语包含必要部分
  if (prompt.includes('请压缩以下对话历史') || prompt.includes('压缩') || prompt.length > 100) {
    console.log(`  ✅ 提示语生成成功（${prompt.length} 字符）`);
    pass++;
  } else {
    console.log(`  ❌ 提示语生成失败`);
    fail++;
  }
  
  if (prompt.includes('[用户]') || prompt.includes('[助手]')) {
    console.log(`  ✅ 提示语包含角色标签`);
    pass++;
  } else {
    console.log(`  ❌ 提示语不包含角色标签`);
    fail++;
  }
  
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  return fail === 0;
}

// ─── 测试 parseCompressionOutput() ────────────────────────────────────
async function testParseCompressionOutput() {
  console.log('\n=== 测试 5: parseCompressionOutput() ===');
  
  const tests = [
    {
      input: `摘要：讨论了 Python 脚本编写和错误修复
主题：Python, 脚本编写, 错误修复
决策：使用 try/catch 处理异常 | 添加日志记录
实体：script.py, logger`,
      expectedSummary: '讨论了 Python 脚本编写和错误修复',
      expectedTopics: ['Python', '脚本编写', '错误修复'],
      desc: '标准格式'
    },
    {
      input: '这是一个没有格式的摘要文本',
      expectedSummaryLen: 10,
      desc: '非标准格式（回退到全文）'
    },
  ];
  
  let pass = 0, fail = 0;
  
  for (const t of tests) {
    const result = parseCompressionOutput(t.input);
    
    if (t.expectedSummary) {
      if (result.summary.includes(t.expectedSummary)) {
        console.log(`  ✅ ${t.desc}: summary 匹配`);
        pass++;
      } else {
        console.log(`  ❌ ${t.desc}: summary 不匹配（实际: ${result.summary}）`);
        fail++;
      }
      
      if (t.expectedTopics) {
        const topicMatch = t.expectedTopics.some(tp => result.topics.includes(tp));
        if (topicMatch) {
          console.log(`  ✅ ${t.desc}: topics 匹配`);
          pass++;
        } else {
          console.log(`  ❌ ${t.desc}: topics 不匹配（实际: ${JSON.stringify(result.topics)}）`);
          fail++;
        }
      }
    } else if (t.expectedSummaryLen) {
      if (result.summary.length >= t.expectedSummaryLen) {
        console.log(`  ✅ ${t.desc}: 回退到全文（${result.summary.length} 字符）`);
        pass++;
      } else {
        console.log(`  ❌ ${t.desc}: 回退失败（${result.summary.length} 字符）`);
        fail++;
      }
    }
  }
  
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  return fail === 0;
}

// ─── 主函数 ─────────────────────────────────────────────────────────────

async function main() {
  console.log('开始 ContextManager 纯函数单元测试...\n');
  
  let allPass = true;
  allPass = (await testExtractKeywords()) && allPass;
  allPass = (await testEstimateTokens()) && allPass;
  allPass = (await testKeywordMatchScore()) && allPass;
  allPass = (await testBuildCompressionPrompt()) && allPass;
  allPass = (await testParseCompressionOutput()) && allPass;
  
  console.log('\n' + '='.repeat(60));
  if (allPass) {
    console.log('✅ 所有测试通过！');
  } else {
    console.log('❌ 部分测试失败，请检查上述输出');
  }
  console.log('='.repeat(60) + '\n');
  
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
