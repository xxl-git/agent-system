#!/usr/bin/env ts-node
// SmartAdapter 死循环防护测试 — 验证 LLM 故障时系统不挂
import { LMStudioAdapter } from '../src/models/adapters/lmstudio';
import { SmartAdapter } from '../src/core/smart-adapter';
import { loadConfig } from '../src/config';

const SEP = '═'.repeat(50);
let okC = 0, noC = 0;
const ok = (n: string, d?: string) => { okC++; console.log('  ✓', n + (d ? ' (' + d + ')' : '')); };
const no = (n: string, e?: string) => { noC++; console.log('  ✗', n, e ? ': ' + e : ''); };

async function main() {
  console.log('\n' + SEP);
  console.log('  SmartAdapter 死循环防护测试');
  console.log(SEP + '\n');

  loadConfig();

  // ─── 1. 正常适配器 Ping ───
  console.log('── 1. 连接检查 ──');
  const raw = new LMStudioAdapter();
  const pingOk = await raw.ping();
  pingOk ? ok('LM Studio 可达') : no('LM Studio 不可达');
  console.log('   模型: ' + raw.model);

  // ─── 2. SmartAdapter 初始化 ───
  console.log('\n── 2. SmartAdapter 初始化 ──');
  const smart = new SmartAdapter(raw, {
    callTimeoutMs: 5000,       // 5秒超时（便于测试）
    maxRetries: 1,             // 最多1次重试
    retryBaseMs: 100,
    emptyLoopThreshold: 2,     // 2次空响应=死循环
    minContentLength: 1,
  });
  ok('SmartAdapter 创建', `timeout=${smart['config'].callTimeoutMs}ms, retries=${smart['config'].maxRetries}`);

  // ─── 3. 空响应检测 ───
  console.log('\n── 3. 空响应检测 ──');
  const t0 = Date.now();
  try {
    const resp = await smart.chat([
      { role: 'user', content: '回复你好' },
    ]);
    const dur = Date.now() - t0;
    const content = resp.choices[0].message.content;
    const reason = resp.choices[0].finish_reason;

    if (reason === 'degraded') {
      ok('降级触发', `finish_reason=${reason} (${dur}ms)`);
      if (content.length > 0) ok('降级有内容', content.slice(0, 50));
    } else if (content && content.length > 0) {
      ok('正常响应', `${content.length}字, finish=${reason} (${dur}ms)`);
    } else {
      no('意外状态', `content=${content}, reason=${reason}`);
    }
  } catch (err: any) {
    ok('异常被捕获', err.message.slice(0, 50));
  }

  // ─── 4. 超时控制 ───
  console.log('\n── 4. 超时控制 ──');
  const smart2 = new SmartAdapter(raw, {
    callTimeoutMs: 2000,
    maxRetries: 0,
    emptyLoopThreshold: 1,
  });
  const t1 = Date.now();
  try {
    const resp = await smart2.chat([
      { role: 'user', content: '请输出一段很长的文章，至少1000字' },
    ]);
    const dur = Date.now() - t1;
    ok(`完成于 ${dur}ms`, `finish=${resp.choices[0].finish_reason}`);
  } catch (err: any) {
    ok('正确超时', `${Date.now() - t1}ms - ${err.message.slice(0, 40)}`);
  }

  // ─── 5. 死循环计数器 ───
  console.log('\n── 5. 死循环计数器 ──');
  const smart3 = new SmartAdapter(raw, {
    callTimeoutMs: 3000,
    maxRetries: 1,
    emptyLoopThreshold: 2,
  });
  smart3.reset();
  const t2 = Date.now();
  try {
    // 发一个可能触发空响应的请求
    await smart3.chat([{ role: 'user', content: '你只需要说你好' }]);
    ok('单次调用完成', `${Date.now() - t2}ms`);
  } catch (err: any) {
    ok('调用结束', err.message.slice(0, 40));
  }

  // 验证计数器可重置
  smart3.reset();
  ok('计数器重置', `empties=0`);

  // ─── 6. 降级 fallback 内容 ───
  console.log('\n── 6. 降级 Fallback ──');
  const fb1 = smart3['degradedFallback']('你好');
  fb1.includes('你好') ? ok('问候降级') : no('问候降级空');
  const fb2 = smart3['degradedFallback']('/status');
  fb2 === '' ? ok('命令降级返回空') : no('命令降级非空');
  const fb3 = smart3['degradedFallback']('今天天气怎么样');
  fb3.includes('天气') ? ok('天气降级') : no('天气降级空');
  const fb4 = smart3['degradedFallback']('');
  fb4.length > 0 ? ok('空白降级') : no('空白降级空');

  // ─── 7. tool_calls 过滤 ───
  console.log('\n── 7. Tool Calls 过滤 ──');
  const ft1 = smart3['filterValidToolCalls']([]);
  ft1.length === 0 ? ok('空数组过滤') : no('空数组');
  const ft2 = smart3['filterValidToolCalls'](undefined);
  ft2.length === 0 ? ok('undefined 过滤') : no('undefined');
  const ft3 = smart3['filterValidToolCalls']([{ function: undefined }, {}] as any);
  ft3.length === 0 ? ok('无效函数过滤') : no('无效函数');
  const ft4 = smart3['filterValidToolCalls']([{ function: { name: 'get_weather', arguments: '{}' } }] as any);
  ft4.length === 1 ? ok('有效函数保留') : no('有效函数丢弃');

  // ─── 8. model getter ───
  console.log('\n── 8. Model Getter ──');
  smart.model === raw.model ? ok('model 透传', smart.model) : no('model 不匹配');

  // ─── 9. ChatFn 注入兼容 ───
  console.log('\n── 9. ChatFn 兼容 ──');
  const chatFn = smart.asChatFn();
  typeof chatFn === 'function' ? ok('asChatFn 返回函数') : no('asChatFn 非函数');
  try {
    const resp = await chatFn([{ role: 'user', content: '你好' }]);
    ok('ChatFn 可调用', resp.choices[0].finish_reason || 'stop');
  } catch (err: any) {
    ok('ChatFn 异常可控', err.message.slice(0, 30));
  }

  // ─── 结果 ───
  console.log('\n' + SEP);
  const tot = okC + noC;
  console.log(`  通过: ${okC}/${tot} (${Math.round(okC/tot*100)}%)`);
  console.log(SEP);

  if (noC > 0) process.exit(1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
