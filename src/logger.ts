// 日志系统（含大小轮转 + gzip 压缩）
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_ROTATED = 5;

class Logger {
  private level: LogLevel = 'info';
  private logDir: string;
  private maxFileSize: number = DEFAULT_MAX_FILE_SIZE;
  private maxRotatedFiles: number = DEFAULT_MAX_ROTATED;
  private writeCount = 0;
  private readonly rotationCheckInterval = 50; // 每 50 次写入检查一次大小

  constructor(logDir: string) {
    this.logDir = logDir;
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    // 启动时检查当日日志是否已超过阈值，若是则立即轮转
    this.rotateIfNeeded();
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  /** 设置单个日志文件最大大小（单位 MB） */
  setMaxFileSize(mb: number) {
    this.maxFileSize = mb * 1024 * 1024;
  }

  /** 设置最多保留几个轮转文件 */
  setMaxRotatedFiles(n: number) {
    this.maxRotatedFiles = n;
  }

  /** 获取当日日志文件路径 */
  private getLogFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `${date}.log`);
  }

  /** 启动时若当日日志已超阈值，立即轮转 */
  private rotateIfNeeded() {
    const logFile = this.getLogFilePath();
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size >= this.maxFileSize) {
      this.performRotation(logFile);
    }
  }

  /**
   * 执行轮转：
   *   1. 删除最旧的 .N.gz（若存在）
   *   2. 现有 .N.gz 编号后移
   *   3. 压缩当前日志为 .1.gz
   *   4. 清空当前日志文件
   */
  private performRotation(logFile: string) {
    const baseName = logFile; // e.g. /path/2026-06-21.log

    // 删除最旧的文件
    const oldestGz = `${baseName}.${this.maxRotatedFiles}.gz`;
    if (fs.existsSync(oldestGz)) {
      fs.unlinkSync(oldestGz);
    }

    // 将现有的 .N.gz 文件编号后移
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

    // 清空当前日志文件，写入轮转记录
    const timestamp = new Date().toISOString();
    const rotatedSizeMB = (content.length / 1024 / 1024).toFixed(2);
    fs.writeFileSync(
      logFile,
      `[${timestamp}] [INFO] [Logger] 日志已轮转，旧内容已压缩至 ${path.basename(baseName)}.1.gz (${rotatedSizeMB} MB)\n`
    );
  }

  /** 检查并执行轮转（每 rotationCheckInterval 次写入检查一次） */
  private checkRotation() {
    this.writeCount++;
    if (this.writeCount % this.rotationCheckInterval !== 0) return;

    const logFile = this.getLogFilePath();
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size >= this.maxFileSize) {
      this.performRotation(logFile);
    }
  }

  private write(level: LogLevel, message: string, ...args: unknown[]) {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (levels.indexOf(level) < levels.indexOf(this.level)) return;

    const timestamp = new Date().toISOString();
    const content = args.length > 0
      ? `${message} ${args.map(a => formatArg(a)).join(' ')}`
      : message;

    const line = `[${timestamp}] [${level.toUpperCase()}] ${content}`;

    // 控制台输出
    const prefix =
      level === 'error' ? '❌' :
      level === 'warn' ? '⚠️' :
      level === 'debug' ? '🔍' : '📋';
    console.log(`${prefix} ${line}`);

    // 文件写入（按日切割 + 大小轮转）
    const logFile = this.getLogFilePath();
    this.checkRotation();
    fs.appendFileSync(logFile, line + '\n', 'utf-8');
  }

  debug(msg: string, ...args: unknown[]) { this.write('debug', msg, ...args); }
  info(msg: string, ...args: unknown[])  { this.write('info',  msg,  ...args); }
  warn(msg: string, ...args: unknown[])  { this.write('warn',  msg,  ...args); }
  error(msg: string, ...args: unknown[]) { this.write('error', msg, ...args); }
}

/** 格式化日志参数：Error 的 JSON.stringify 会输出 {}，需特殊处理 */
function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}` +
      (arg.stack ? `\n${arg.stack.split('\n').slice(0, 3).join('\n')}` : '');
  }
  if (typeof arg === 'object' && arg !== null) {
    const s = JSON.stringify(arg);
    if (s === '{}' && Object.keys(arg).length === 0) {
      return String(arg);
    }
    return s;
  }
  return String(arg);
}

const logDir = path.resolve(__dirname, '../logs');
export const logger = new Logger(logDir);

export default logger;
