// 快速测试：验证 LM Studio v1 API input 格式修复
import { LMStudioAdapter } from '../src/models/adapters/lmstudio';
import { loadConfig } from '../src/config';

async function main() {
  console.log('[Test] 加载配置...');
  loadConfig();

  const adapter = new LMStudioAdapter();
  adapter.setReasoning('off'); // 使用 OpenAI 兼容端点（不走 v1）

  console.log(`[Test] 模型: ${adapter.model}`);
  console.log('[Test] 发送测试消息...');

  try {
    const response = await adapter.chat([
      { role: 'user', content: '你好，请只回复「收到」两个字' },
    ]);
    const content = response.choices?.[0]?.message?.content || '';
    console.log('[Test] ✅ 成功！响应:', content.slice(0, 100));
    process.exit(0);
  } catch (e: any) {
    console.error('[Test] ❌ 失败:', e.message?.slice(0, 300));
    process.exit(1);
  }
}

main();
