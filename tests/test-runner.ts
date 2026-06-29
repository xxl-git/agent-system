#!/usr/bin/env ts-node
// 统一测试运行器 — 运行所有测试
import * as path from 'path';
import * as fs from 'fs';

const SEP = '═'.repeat(60);
let totalPass = 0;
let totalFail = 0;

async function runTest(name: string, testFile: string) {
  console.log(`\n${SEP}`);
  console.log(`  运行测试: ${name}`);
  console.log(SEP + '\n');

  try {
    // 动态导入测试模块
    const testPath = path.resolve(process.cwd(), testFile);
    if (!fs.existsSync(testPath)) {
      console.log(`⚠️  测试文件不存在: ${testFile}`);
      totalFail++;
      return;
    }

    // 使用 require 运行 JS 文件（如果 TS 文件存在则先编译）
    const jsPath = testPath.replace(/\.ts$/, '.js').replace('src/', 'dist/');
    if (fs.existsSync(jsPath)) {
      require(jsPath);
    } else {
      console.log(`⚠️  JS 文件不存在: ${jsPath}`);
      console.log(`   请先编译: npm run build`);
      totalFail++;
    }
  } catch (err) {
    console.error(`❌ 测试失败: ${name}`);
    console.error(err);
    totalFail++;
  }
}

async function main() {
  console.log(`\n${SEP}`);
  console.log(`  Agent-System 测试运行器`);
  console.log(SEP + '\n');

  // 运行所有测试
  await runTest('P0 修复验证 (ContextManager)', 'dist/core/__tests__/context-manager.p0.test.js');
  
  // 可以添加更多测试
  // await runTest('干跑测试', 'tests/test-dry-run.ts');

  // 汇总
  console.log(`\n${SEP}`);
  console.log(`  测试完成: ✅ ${totalPass} 通过, ❌ ${totalFail} 失败`);
  console.log(SEP + '\n');

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试运行器错误:', err);
  process.exit(1);
});
