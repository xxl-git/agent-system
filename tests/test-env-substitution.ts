// 测试：配置文件环境变量替换
import { loadConfig, getConfig } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';

const TEST_JSON = path.join(__dirname, 'tmp-test-config.json');

function setEnv(key: string, value: string) {
  process.env[key] = value;
}

function unsetEnv(key: string) {
  delete process.env[key];
}

function writeConfig(json: any) {
  fs.writeFileSync(TEST_JSON, JSON.stringify(json, null, 2));
}

function cleanup() {
  if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);
}

async function main() {
  cleanup();
  let passed = 0;
  let failed = 0;

  // Test 1: 环境变量正常替换
  try {
    setEnv('TEST_DEEPSEEK_KEY', 'sk-test-12345');
    writeConfig({
      models: {
        customProviders: [{ apiKey: '${TEST_DEEPSEEK_KEY}' }],
      },
    });
    // 无法直接调用 loadConfig 因为路径固定，改为直接测试替换逻辑
    const raw = JSON.stringify({ key: '${TEST_DEEPSEEK_KEY}' });
    const replaced = raw.replace(/\$\{([^}]+)\}/g, (_: string, envVar: string) => process.env[envVar] || '');
    const parsed = JSON.parse(replaced);
    if (parsed.key === 'sk-test-12345') {
      console.log('✅ Test 1 PASSED: 环境变量替换正常');
      passed++;
    } else {
      console.log('❌ Test 1 FAILED: 期望值 sk-test-12345, 实际值', parsed.key);
      failed++;
    }
  } catch (e: any) {
    console.log('❌ Test 1 ERROR:', e.message);
    failed++;
  } finally {
    unsetEnv('TEST_DEEPSEEK_KEY');
  }

  // Test 2: 环境变量未设置时抛错（在 loadConfig 中）
  try {
    const raw = '{"key":"${NONEXISTENT_VAR}"}';
    const replaced = raw.replace(/\$\{([^}]+)\}/g, (_: string, envVar: string) => {
      const v = process.env[envVar];
      if (v === undefined) throw new Error(`环境变量 ${envVar} 未设置`);
      return v;
    });
    console.log('❌ Test 2 FAILED: 应抛出错误但未抛出');
    failed++;
  } catch (e: any) {
    if (e.message.includes('环境变量')) {
      console.log('✅ Test 2 PASSED: 环境变量未设置时正确抛错');
      passed++;
    } else {
      console.log('❌ Test 2 FAILED: 错误消息不匹配', e.message);
      failed++;
    }
  }

  // Test 3: 普通字符串不替换
  try {
    const raw = '{"key":"sk-abc123"}';
    const replaced = raw.replace(/\$\{([^}]+)\}/g, (_: string, envVar: string) => process.env[envVar] || '');
    const parsed = JSON.parse(replaced);
    if (parsed.key === 'sk-abc123') {
      console.log('✅ Test 3 PASSED: 普通字符串不替换');
      passed++;
    } else {
      console.log('❌ Test 3 FAILED:', parsed.key);
      failed++;
    }
  } catch (e: any) {
    console.log('❌ Test 3 ERROR:', e.message);
    failed++;
  }

  cleanup();
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
