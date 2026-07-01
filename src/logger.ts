// 日志系统（含大小轮转 + gzip 压缩 + 错误单独记录）
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const LOG_DIR = path.resolve(__dirname, '../logs');
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_ROTATED = 5;

/** 确保日志目录存在 */
function ensureLogDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 获取当日日志文件名 */
function getTodayLogFilename(): string {
  const date = new Date().toISOString().split('T')[0];
  return `${date}.log`;
}

/** 获取当日错误日志文件名 */
function getTodayErrorFilename(): string {
  const date = new Date().toISOString().split('T')[0];
  return `${date}-errors.log`;
}

class Logger {
  private level: LogLevel = 'info';
  private logDir: string;
  private errorLogDir: string;
  private maxFileSize: number = DEFAULT_MAX_FILE_SIZE;
  private maxRotatedFiles: number = DEFAULT_MAX_ROTATED;
  private writeCount = 0;
  private readonly rotationCheckInterval = 50; // 每 50 次写入检查一次大小
  private _firstWrite = true; // 首次写入前检查轮转

  constructor(logDir: string) {
    this.logDir = logDir;
    this.errorLogDir = logDir; // 错误日志在同一目录
    ensureLogDir(logDir);
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
    return path.join(this.logDir, getTodayLogFilename());
  }

  /** 获取当日错误日志文件路径 */
  private getErrorLogFilePath(): string {
    return path.join(this.errorLogDir, getTodayErrorFilename());
  }

  /** 启动时若当日日志已超阈值，立即轮转 */
  private rotateIfNeeded() {
    const logFile = this.getLogFilePath();
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size >= this.maxFileSize) {
      this.performRotation(logFile, false);
    }
    // 同时检查错误日志
    const errFile = this.getErrorLogFilePath();
    if (fs.existsSync(errFile) && fs.statSync(errFile).size >= this.maxFileSize) {
      this.performRotation(errFile, true);
    }
  }

  /**
   * 执行轮转：
   *   1. 删除最旧的 .N.gz（若存在）
   *   2. 现有 .N.gz 编号后移
   *   3. 压缩当前日志为 .1.gz
   *   4. 清空当前日志文件
   */
  private performRotation(logFile: string, isErrorLog: boolean) {
    const baseName = logFile;

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
    const label = isErrorLog ? '错误日志' : '日志';
    fs.writeFileSync(
      logFile,
      `[${timestamp}] [INFO] [Logger] ${label}已轮转，旧内容已压缩至 ${path.basename(baseName)}.1.gz (${rotatedSizeMB} MB)\n`
    );
  }

  /** 检查并执行轮转（每 rotationCheckInterval 次写入检查一次） */
  private checkRotation() {
    // 首次写入前检查轮转（修复：应用重启时 log 文件已存在但 _firstWrite 为 true 导致不检查）
    if (this._firstWrite) {
      this._firstWrite = false;
      this.rotateIfNeeded();
      return;
    }
    this.writeCount++;
    if (this.writeCount % this.rotationCheckInterval !== 0) return;

    const logFile = this.getLogFilePath();
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size >= this.maxFileSize) {
      this.performRotation(logFile, false);
    }
    // 检查错误日志
    const errFile = this.getErrorLogFilePath();
    if (fs.existsSync(errFile) && fs.statSync(errFile).size >= this.maxFileSize) {
      this.performRotation(errFile, true);
    }
  }

  /** 写入错误日志到单独文件 */
  private writeErrorToFile(timestamp: string, level: LogLevel, content: string) {
    const errFile = this.getErrorLogFilePath();
    ensureLogDir(this.errorLogDir);
    const line = `[${timestamp}] [${level.toUpperCase()}] ${content}`;
    // 错误日志也参与轮转检查
    if (fs.existsSync(errFile)) {
      const stats = fs.statSync(errFile);
      if (stats.size >= this.maxFileSize) {
        this.performRotation(errFile, true);
      }
    }
    fs.appendFileSync(errFile, line + '\n', 'utf-8');
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

    // 错误和警告额外写入错误日志文件
    if (level === 'error' || level === 'warn') {
      this.writeErrorToFile(timestamp, level, content);
    }
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

const logDir = path.resolve(process.cwd(), 'logs');
export const logger = new Logger(logDir);

export default logger;

/**
 * 便捷方法：记录错误并附带上下文
 * 用法：logError('Agent', 'sendMessage 失败', err, { intent: intent.type, msgLen: message.length })
 */
export function logError(context: string, message: string, error: unknown, contextObj?: Record<string, unknown>) {
  const errMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const ctx = contextObj ? ` | ctx: ${JSON.stringify(contextObj)}` : '';
  logger.error(`[${context}] ${message}: ${errMsg}${ctx}`);
  if (error instanceof Error && error.stack) {
    logger.debug(`[${context}] Stack: ${error.stack.split('\n').slice(0, 5).join('\n')}`);
  }
}

/**
 * 便捷方法：记录警告并附带上下文
 */
export function logWarn(context: string, message: string, contextObj?: Record<string, unknown>) {
  const ctx = contextObj ? ` | ctx: ${JSON.stringify(contextObj)}` : '';
  logger.warn(`[${context}] ${message}${ctx}`);
}
