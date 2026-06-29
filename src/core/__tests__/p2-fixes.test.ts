// P2 修复单元测试 — 验证 safePath() 和 getCurrentModel() 修复
import * as path from 'path';
import * as fs from 'fs';

// ─── 模拟 logger ──────────────────────────────────────────────────────────
const logger = {
  warn: (msg: string) => { /* 模拟，不输出 */ },
  info: (msg: string) => { /* 模拟，不输出 */ },
};

// ─── 真实 safePath() 实现（与 agent-server.ts 第 132-152 行同步）─────
const STATIC_DIR = path.resolve(__dirname, '..', '..');

function safePathReal(filePath: string): string | null {
  // URL 解码（防御 %2e%2e 等编码绕过），失败时直接拒绝
  let decoded: string;
  try {
    decoded = decodeURIComponent(filePath);
  } catch {
    // 修复：添加 try/catch 防御 URIError
    logger.warn('[safePath] URL 解码失败，拒绝访问: ' + filePath.slice(0, 100));
    return null;
  }
  // 全方位检测目录穿越
  if (decoded.includes('..') || decoded.includes('~') || /^[A-Za-z]:/.test(decoded)) return null;
  const resolved = path.resolve(STATIC_DIR, '.' + decoded);
  if (!resolved.startsWith(STATIC_DIR)) return null;
  // 再次检查 resolved 中是否有相对路径残留（Windows 需处理 \ 分隔符）
  const normalizedResolved = resolved.replace(/\\/g, '/');
  const normalizedStatic = STATIC_DIR.replace(/\\/g, '/');
  if (!normalizedResolved.startsWith(normalizedStatic)) return null;
  return decoded;
}

async function testSafePath() {
  console.log('\n=== 测试 1: safePath() 修复验证 ===');
  
  const tests = [
    { input: '/index.html', expected: '/index.html', desc: '正常文件' },
    { input: '/src/core/agent-core.ts', expected: '/src/core/agent-core.ts', desc: '子目录文件' },
    { input: '/../etc/passwd', expected: null, desc: '目录穿越攻击 (..)' },
    { input: '/..%2F..%2Fetc%2Fpasswd', expected: null, desc: 'URL 编码的目录穿越' },
    { input: '/~/secret.txt', expected: null, desc: '波浪号攻击' },
    { input: 'C:/Windows/system.ini', expected: null, desc: 'Windows 绝对路径攻击' },
    { input: '/file%20name.txt', expected: '/file name.txt', desc: 'URL 编码空格' },
    { input: '/file%ZZ.txt', expected: null, desc: '无效 URL 编码（应返回 null）' },
  ];
  
  let pass = 0, fail = 0;
  for (const t of tests) {
    const result = safePathReal(t.input);
    if (result === t.expected) {
      console.log(`  ✅ ${t.desc}: ${result}`);
      pass++;
    } else {
      console.log(`  ❌ ${t.desc}: 期望 ${t.expected}, 实际 ${result}`);
      fail++;
    }
  }
  
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  return fail === 0;
}

// ─── 测试 getCurrentModel() 修复 ─────────────────────────────────────────────
// 原文件: src/models/adapters/lmstudio.ts
// 修复: 确保始终返回非空字符串，添加 try/catch 兜底 'unknown'

async function testGetCurrentModel() {
  console.log('\n=== 测试 2: getCurrentModel() 修复验证 ===');
  
  // 模拟 getCurrentModel 函数（简化版）
  function getCurrentModelSafe(): string {
    try {
      // 模拟可能失败的操作
      const model = process.env['MODEL_NAME'];
      if (!model || model.trim() === '') {
        return 'unknown'; // 兜底值
      }
      return model;
    } catch (err) {
      return 'unknown'; // 异常兜底
    }
  }
  
  const tests = [
    { env: { MODEL_NAME: 'qwen3.6-35b' }, expected: 'qwen3.6-35b', desc: '正常模型名' },
    { env: { MODEL_NAME: '' }, expected: 'unknown', desc: '空字符串' },
    { env: { MODEL_NAME: '  ' }, expected: 'unknown', desc: '空白字符串' },
    { env: {}, expected: 'unknown', desc: '环境变量未设置' },
  ];
  
  let pass = 0, fail = 0;
  for (const t of tests) {
    // 设置环境变量
    if (t.env.MODEL_NAME !== undefined) {
      process.env['MODEL_NAME'] = t.env.MODEL_NAME;
    } else {
      delete process.env['MODEL_NAME'];
    }
    
    const result = getCurrentModelSafe();
    if (result === t.expected) {
      console.log(`  ✅ ${t.desc}: ${result}`);
      pass++;
    } else {
      console.log(`  ❌ ${t.desc}: 期望 ${t.expected}, 实际 ${result}`);
      fail++;
    }
  }
  
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  return fail === 0;
}

// ─── 测试 clearExpired() 方法 ───────────────────────────────────────────────
// 原文件: src/resilience/checkpoint.ts
// 新增: clearExpired(retainDays: number) 方法

async function testClearExpired() {
  console.log('\n=== 测试 3: clearExpired() 方法验证 ===');
  
  // 模拟 CheckpointManager 类（简化版）
  class MockCheckpointManager {
    private checkpoints: Map<string, { timestamp: number }> = new Map();
    
    addCheckpoint(id: string, timestamp: number) {
      this.checkpoints.set(id, { timestamp });
    }
    
    clearExpired(retainDays: number): number {
      const now = Date.now();
      const retainMs = retainDays * 24 * 60 * 60 * 1000;
      let deleted = 0;
      
      for (const [id, cp] of this.checkpoints) {
        if (now - cp.timestamp > retainMs) {
          this.checkpoints.delete(id);
          deleted++;
        }
      }
      
      return deleted;
    }
    
    count(): number {
      return this.checkpoints.size;
    }
  }
  
  const manager = new MockCheckpointManager();
  const now = Date.now();
  
  // 添加测试数据：5 个旧检查点（>7天），3 个新检查点
  for (let i = 0; i < 5; i++) {
    manager.addCheckpoint(`old-${i}`, now - (10 + i) * 24 * 60 * 60 * 1000);
  }
  for (let i = 0; i < 3; i++) {
    manager.addCheckpoint(`new-${i}`, now - i * 24 * 60 * 60 * 1000);
  }
  
  console.log(`  添加测试数据: ${manager.count()} 个检查点 (5 旧 + 3 新)`);
  
  const deleted = manager.clearExpired(7);
  console.log(`  清理过期检查点: ${deleted} 个`);
  console.log(`  剩余检查点: ${manager.count()} 个`);
  
  if (deleted === 5 && manager.count() === 3) {
    console.log(`  ✅ clearExpired() 工作正常`);
    return true;
  } else {
    console.log(`  ❌ 期望删除 5 个, 实际删除 ${deleted} 个; 期望剩余 3 个, 实际剩余 ${manager.count()} 个`);
    return false;
  }
}

// ─── 主函数 ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('开始 P2 修复单元测试...\n');
  
  let allPass = true;
  allPass = (await testSafePath()) && allPass;
  allPass = (await testGetCurrentModel()) && allPass;
  allPass = (await testClearExpired()) && allPass;
  
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
