// 日志系统（含大小轮转 + gzip 压缩 + 错误单独记录）
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const LOG_DIR = path.resolve(__dirname, '../logs');
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_ROTATED = 5;
const DEFAULT_LOG_RETENTION_DAYS = 30; // 超过 30 天的轮转.gz 文件自动清理
const MAX_WARN_KEYS = 500; // WARN 去重 Map 最大条目数

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
  private readonly rotationCheckInterval = 50;
  private _firstWrite = true;
  private _rotating = false; // 轮转互斥锁
  private _logRetentionDays: number = DEFAULT_LOG_RETENTION_DAYS;
  // WARN 去重：记录每条 WARN 消息关键 key 的最后写入时间
  private _lastWarnTimestamps = new Map<string, number>();

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

  /** 设置日志文件保留天数（超过此天数的 .gz 文件会被清理） */
  setLogRetentionDays(days: number) {
    this._logRetentionDays = days;
  }

  /** 获取当前日志级别 */
  getLevel(): LogLevel {
    return this.level;
  }

  /** 获取当日日志文件路径 */
  private getLogFilePath(): string {
    return path.join(this.logDir, getTodayLogFilename());
  }

  /** 获取当日错误日志文件路径 */
  private getErrorLogFilePath(): string {
    return path.join(this.errorLogDir, getTodayErrorFilename());
  }

  /**
   * 清理超过保留天数的旧 .gz 轮转文件
   */
  cleanupOldLogs(): number {
    const now = Date.now();
    const maxAge = this._logRetentionDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    try {
      const files = fs.readdirSync(this.logDir);
      for (const file of files) {
        // 匹配 .log.N.gz 或 -errors.log.N.gz 格式
        if (/\d+\.gz$/.test(file) && /\.log\.\d+\.gz$/.test(file)) {
          const filePath = path.join(this.logDir, file);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        }
      }
    } catch (err) {
      console.error(`[Logger] cleanupOldLogs error: ${err}`);
    }
    if (deleted > 0) {
      console.log(`[Logger] 清理了 ${deleted} 个过期轮转日志文件`);
    }
    return deleted;
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
   *
   * 线程安全：通过 _rotating 互斥锁防止并发轮转
   */
  private performRotation(logFile: string, isErrorLog: boolean) {
    this._rotating = true;
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
    this._rotating = false;
  }

  /** 检查并执行轮转（每 rotationCheckInterval 次写入检查一次） */
  private checkRotation() {
    // 轮转互斥：如果正在轮转，跳过本次检查
    if (this._rotating) return;

    // 首次写入前检查轮转
    if (this._firstWrite) {
      this._firstWrite = false;
      this.rotateIfNeeded();
      return;
    }
    this.writeCount++;
    if (this.writeCount < this.rotationCheckInterval) return;
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

    // 错误日志文件：ERROR 级别全部写入，WARN 级别按频率过滤
    if (level === 'error') {
      this.writeErrorToFile(timestamp, level, content);
    } else if (level === 'warn') {
      // 去重：相同前缀的 WARN 消息每 60 秒只写一次
      const warnKey = extractWarnKey(message);
      const now = Date.now();
      if (warnKey) {
        const last = this._lastWarnTimestamps.get(warnKey);
        if (!last || (now - last) >= 60000) {
          this._lastWarnTimestamps.set(warnKey, now);
          this.writeErrorToFile(timestamp, level, content);
          // 清理过期 key（超过 5 分钟前的记录）
          for (const [k, v] of this._lastWarnTimestamps) {
            if (now - v > 300000) this._lastWarnTimestamps.delete(k);
          }
        }
      } else {
        this.writeErrorToFile(timestamp, level, content);
      }
      // WARN Map 内存保护：超出上限时删除最旧的一半
      if (this._lastWarnTimestamps.size > MAX_WARN_KEYS) {
        const entries = [...this._lastWarnTimestamps.entries()];
        entries.sort((a, b) => a[1] - b[1]); // 按时间排序
        const toDelete = entries.slice(0, Math.floor(MAX_WARN_KEYS / 2));
        for (const [k] of toDelete) {
          this._lastWarnTimestamps.delete(k);
        }
      }
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

/** 提取 WARN 消息的去重 key（提取 [XXX] 标签 + 前 40 个字作为 key） */
function extractWarnKey(message: string): string | null {
  // 提取 [Agent] [LMStudio] [Diag] 等标签
  const tagMatch = message.match(/\[([^\]]+)\]/);
  if (!tagMatch) return null;
  const tag = tagMatch[0];
  // 取标签后的前 40 个字符作为内容 key
  const contentKey = message.slice(tag.length).trim().substring(0, 40);
  return `${tag} ${contentKey}`;
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
