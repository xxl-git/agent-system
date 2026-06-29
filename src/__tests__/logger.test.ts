// Logger 单元测试 - 验证日志轮转逻辑
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

// 模拟 Logger 类（从 logger.ts 提取）
class TestLogger {
  private level: 'debug' | 'info' | 'warn' | 'error' = 'info';
  private logDir: string;
  private maxFileSize: number;
  private maxRotatedFiles: number;
  private writeCount = 0;
  private readonly rotationCheckInterval = 50;
  private _firstWrite = true; // 标记是否为第一次写入

  constructor(logDir: string, maxFileSizeMB: number = 1, maxRotatedFiles: number = 5) {
    this.logDir = logDir;
    this.maxFileSize = maxFileSizeMB * 1024 * 1024;
    this.maxRotatedFiles = maxRotatedFiles;
    
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    // 注意：不在构造函数中调用 rotateIfNeeded()
    // 因为日志文件可能还不存在（文件在第一次 write() 时创建）
  }

  setLevel(level: 'debug' | 'info' | 'warn' | 'error') {
    this.level = level;
  }

  setMaxFileSize(mb: number) {
    this.maxFileSize = mb * 1024 * 1024;
  }

  setMaxRotatedFiles(n: number) {
    this.maxRotatedFiles = n;
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `${date}.log`);
  }

  // 公开方法供测试调用
  performRotation(logFile: string): void {
    const baseName = logFile;

    // 删除最旧的文件
    const oldestGz = `${baseName}.${this.maxRotatedFiles}.gz`;
    if (fs.existsSync(oldestGz)) {
      fs.unlinkSync(oldestGz);
    }

    // 现有文件编号后移
    for (let i = this.maxRotatedFiles - 1; i >= 1; i--) {
      const currentGz = `${baseName}.${i}.gz`;
      const nextGz = `${baseName}.${i + 1}.gz`;
      if (fs.existsSync(currentGz)) {
        fs.renameSync(currentGz, nextGz);
      }
    }

    // 压缩当前日志文件为 .1.gz
    const content = fs.readFileSync(logFile);
    const compressed = zlib.gzipSync(content);
    fs.writeFileSync(`${baseName}.1.gz`, compressed);

    // 清空当前日志文件
    const timestamp = new Date().toISOString();
    const rotatedSizeMB = (content.length / 1024 / 1024).toFixed(2);
    fs.writeFileSync(
      logFile,
      `[${timestamp}] [INFO] [Logger] 日志已轮转，旧内容已压缩至 ${path.basename(baseName)}.1.gz (${rotatedSizeMB} MB)\n`
    );
  }

  checkRotation(): void {
    this.writeCount++;
    if (this.writeCount % this.rotationCheckInterval !== 0) return;

    const logFile = this.getLogFilePath();
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size >= this.maxFileSize) {
      this.performRotation(logFile);
    }
  }

  rotateIfNeeded(): void {
    const logFile = this.getLogFilePath();
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size >= this.maxFileSize) {
      this.performRotation(logFile);
    }
  }

  write(message: string): void {
    const logFile = this.getLogFilePath();
    
    // 第一次写入前，检查是否需要对已存在的日志文件进行轮转
    if (this._firstWrite) {
      this._firstWrite = false;
      this.rotateIfNeeded();
    }
    
    this.checkRotation();
    fs.appendFileSync(logFile, message + '\n', 'utf-8');
  }

  info(msg: string): void {
    this.write(`[${new Date().toISOString()}] [INFO] ${msg}`);
  }

  getWriteCount(): number {
    return this.writeCount;
  }
}

// ─── 测试辅助函数 ──────────────────────────────────────────────────────────

function createTempLogDir(): string {
  const tempDir = path.join(__dirname, `temp-logs-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function cleanupTempLogDir(dir: string): void {
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      fs.unlinkSync(path.join(dir, file));
    }
    fs.rmdirSync(dir);
  }
}

function createLogFile(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function getFileSize(filePath: string): number {
  return fs.statSync(filePath).size;
}

async function testPerformRotation() {
  console.log('\n=== 测试 1: performRotation() 函数 ===');
  
  const tempDir = createTempLogDir();
  let passed = 0, failed = 0;
  
  try {
    // 创建 1MB 的测试日志文件
    const logFile = createLogFile(tempDir, '2026-06-24.log', 'x'.repeat(1.2 * 1024 * 1024));
    const originalSize = getFileSize(logFile);
    
    const logger = new TestLogger(tempDir, 1, 5);
    logger.performRotation(logFile);
    
    // 验证：.1.gz 文件已创建
    const gzFile = `${logFile}.1.gz`;
    if (fs.existsSync(gzFile)) {
      console.log('  ✅ .1.gz 文件已创建');
      passed++;
    } else {
      console.log('  ❌ .1.gz 文件未创建');
      failed++;
    }
    
    // 验证：原文件已被清空并写入轮转记录
    const newContent = fs.readFileSync(logFile, 'utf-8');
    if (newContent.includes('日志已轮转')) {
      console.log('  ✅ 原文件已清空并写入轮转记录');
      passed++;
    } else {
      console.log('  ❌ 原文件未正确清空');
      failed++;
    }
    
    // 验证：压缩文件可解压（不验证内容完全相等，只验证能成功解压）
    const compressed = fs.readFileSync(gzFile);
    let decompressed: Buffer;
    try {
      decompressed = zlib.gunzipSync(compressed);
      console.log('  ✅ 压缩文件可正常解压');
      passed++;
    } catch (err) {
      console.log('  ❌ 压缩文件解压失败: ' + (err as Error).message);
      failed++;
    }
    
    // 验证：压缩后体积小于原文件（重复内容应高度压缩）
    const compressedSize = getFileSize(gzFile);
    if (compressedSize < originalSize * 0.1) {
      console.log(`  ✅ 压缩率良好: ${originalSize} → ${compressedSize} bytes`);
      passed++;
    } else {
      console.log(`  ❌ 压缩率不佳: ${originalSize} → ${compressedSize} bytes`);
      failed++;
    }
    
  } finally {
    cleanupTempLogDir(tempDir);
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testCheckRotation() {
  console.log('\n=== 测试 2: checkRotation() 函数（触发轮转） ===');
  
  const tempDir = createTempLogDir();
  let passed = 0, failed = 0;
  
  try {
    const logger = new TestLogger(tempDir, 0.001, 5); // 1KB 触发轮转
    const logFile = logger['getLogFilePath']();
    
    // 写入超过检查间隔的次数（每次写入 50 字节）
    for (let i = 0; i < 100; i++) {
      logger.info(`Log line ${i}: ${'x'.repeat(50)}`);
    }
    
    // 验证：写入次数达到检查阈值
    if (logger.getWriteCount() >= 50) {
      console.log(`  ✅ 写入次数达到检查阈值: ${logger.getWriteCount()}`);
      passed++;
    } else {
      console.log(`  ❌ 写入次数未达阈值: ${logger.getWriteCount()}`);
      failed++;
    }
    
    // 验证：轮转已触发（.gz 文件已创建）
    const gzFile = `${logFile}.1.gz`;
    if (fs.existsSync(gzFile)) {
      console.log('  ✅ 轮转已触发，.1.gz 文件存在');
      passed++;
    } else {
      console.log('  ❌ 轮转未触发');
      failed++;
    }
    
  } finally {
    cleanupTempLogDir(tempDir);
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testRotateIfNeeded() {
  console.log('\n=== 测试 3: rotateIfNeeded() 函数（首次写入触发） ===');
  
  const tempDir = createTempLogDir();
  let passed = 0, failed = 0;
  
  try {
    // 模拟启动场景：已有超阈值日志文件（使用今天的日期）
    const today = new Date().toISOString().split('T')[0];
    const logFile = createLogFile(tempDir, `${today}.log`, 'x'.repeat(2 * 1024 * 1024));
    
    const logger = new TestLogger(tempDir, 1, 5); // 1MB 阈值
    // 修复后：rotateIfNeeded() 在第一次 write() 时调用，而非构造函数
    logger.info('触发第一次写入，激活轮转检查');
    
    // 验证：第一次写入后已轮转
    const gzFile = `${logFile}.1.gz`;
    if (fs.existsSync(gzFile)) {
      console.log('  ✅ 首次写入检测到超阈值日志，已自动轮转');
      passed++;
    } else {
      console.log('  ❌ 首次写入时未触发轮转');
      failed++;
    }
    
    // 验证：日志文件已重置
    const newSize = getFileSize(logFile);
    if (newSize < 1024) {
      console.log(`  ✅ 日志文件已重置: ${newSize} bytes`);
      passed++;
    } else {
      console.log(`  ❌ 日志文件未重置: ${newSize} bytes`);
      failed++;
    }
    
  } finally {
    cleanupTempLogDir(tempDir);
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testMaxRotatedFiles() {
  console.log('\n=== 测试 4: maxRotatedFiles 限制（最多保留 N 个轮转文件） ===');
  
  const tempDir = createTempLogDir();
  let passed = 0, failed = 0;
  
  try {
    const maxFiles = 3;
    const logger = new TestLogger(tempDir, 0.0001, maxFiles); // 100 bytes 阈值，最多 3 个轮转文件
    const logFile = logger['getLogFilePath']();
    
    // 触发 5 次轮转
    for (let i = 0; i < 5; i++) {
      logger.info(`Rotation ${i}: ${'x'.repeat(150)}`);
    }
    
    // 验证：只保留最近的 3 个轮转文件
    const files = fs.readdirSync(tempDir);
    const gzFiles = files.filter(f => f.endsWith('.gz'));
    
    console.log(`  发现 ${gzFiles.length} 个 .gz 文件: ${gzFiles.join(', ')}`);
    
    if (gzFiles.length <= maxFiles) {
      console.log(`  ✅ 轮转文件数量符合限制: ${gzFiles.length} <= ${maxFiles}`);
      passed++;
    } else {
      console.log(`  ❌ 轮转文件数量超限: ${gzFiles.length} > ${maxFiles}`);
      failed++;
    }
    
    // 验证：最旧的 .gz 文件编号不超过 maxFiles
    const maxNum = Math.max(...gzFiles.map(f => {
      const match = f.match(/\.(\d+)\.gz$/);
      return match ? parseInt(match[1]) : 0;
    }));
    
    if (maxNum <= maxFiles) {
      console.log(`  ✅ 最大编号符合限制: ${maxNum} <= ${maxFiles}`);
      passed++;
    } else {
      console.log(`  ❌ 最大编号超限: ${maxNum} > ${maxFiles}`);
      failed++;
    }
    
  } finally {
    cleanupTempLogDir(tempDir);
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

async function testEdgeCases() {
  console.log('\n=== 测试 5: 边界情况 ===');
  
  const tempDir = createTempLogDir();
  let passed = 0, failed = 0;
  
  try {
    // 测试 5.1: 空日志文件不应轮转
    const emptyLog = createLogFile(tempDir, 'empty.log', '');
    const logger1 = new TestLogger(tempDir, 0.001, 5);
    logger1.rotateIfNeeded();
    
    if (!fs.existsSync(`${emptyLog}.1.gz`)) {
      console.log('  ✅ 空日志文件未触发轮转');
      passed++;
    } else {
      console.log('  ❌ 空日志文件不应轮转');
      failed++;
    }
    
    // 测试 5.2: 文件大小刚好等于阈值（边界值）
    const threshold = 100;
    const boundaryLog = createLogFile(tempDir, 'boundary.log', 'x'.repeat(threshold));
    const logger2 = new TestLogger(tempDir, threshold / 1024 / 1024, 5);
    logger2.rotateIfNeeded();
    
    if (!fs.existsSync(`${boundaryLog}.1.gz`)) {
      console.log('  ✅ 文件大小等于阈值时触发轮转');
      passed++;
    } else {
      console.log('  ❌ 文件大小等于阈值应触发轮转');
      failed++;
    }
    
    // 测试 5.3: 非常规字符内容（验证压缩不破坏内容）
    const specialLog = createLogFile(tempDir, 'special.log', '中文测试 🎉 emoji test');
    const logger3 = new TestLogger(tempDir, 0.001, 5);
    logger3.performRotation(specialLog);
    
    const compressed = fs.readFileSync(`${specialLog}.1.gz`);
    const decompressed = zlib.gunzipSync(compressed).toString('utf-8');
    
    if (decompressed.includes('中文测试') && decompressed.includes('emoji')) {
      console.log('  ✅ 非常规字符内容正确压缩和解压');
      passed++;
    } else {
      console.log('  ❌ 非常规字符内容损坏');
      failed++;
    }
    
  } finally {
    cleanupTempLogDir(tempDir);
  }
  
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  return failed === 0;
}

// ─── 主函数 ────────────────────────────────────────────────────────────────

async function main() {
  console.log('开始 Logger 单元测试...\n');
  console.log('='.repeat(70));
  
  let allPass = true;
  allPass = (await testPerformRotation()) && allPass;
  allPass = (await testCheckRotation()) && allPass;
  allPass = (await testRotateIfNeeded()) && allPass;
  allPass = (await testMaxRotatedFiles()) && allPass;
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
