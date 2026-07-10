// 日志系统（含大小轮转 + gzip 压缩 + 错误单独记录 + 模块级过滤 + 缓冲区 + JSON 格式 + traceId）
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { AsyncLocalStorage } from 'async_hooks';

const LOG_DIR = path.resolve(__dirname, '../logs');
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_ROTATED = 5;
const DEFAULT_LOG_RETENTION_DAYS = 30; // 超过 30 天的轮转.gz 文件自动清理
const MAX_WARN_KEYS = 500; // WARN 去重 Map 最大条目数
const DEFAULT_BUFFER_SIZE = 50; // 缓冲 50 行后自动落盘
const DEFAULT_FLUSH_INTERVAL_MS = 5000; // 最长 5 秒强制落盘

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

/** 从日志消息中提取模块名（匹配开头的 [XXX] 标签） */
function extractModuleName(message: string): string | null {
  const match = message.match(/^\[([A-Za-z0-9_/-]+)\]/);
  return match ? match[1] : null;
}

/**
 * AsyncLocalStorage 用于 async 上下文的 traceId 传播。
 * 服务器层在请求入口处：logContext.run({traceId: sessionId}, () => handleRequest())
 */
export const logContext = new AsyncLocalStorage<{ traceId: string }>();

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

  // 模块级日志级别
  private _moduleLevels = new Map<string, LogLevel>();

  // JSON 格式 + traceId
  private _useJsonFormat = false;
  private _traceId: string | null = null;

  // 日志缓冲区（减少磁盘 I/O）
  private _buffer: string[] = [];
  private _bufferSize = DEFAULT_BUFFER_SIZE;
  private _flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
  private _flushTimer: NodeJS.Timeout | null = null;
  private _bufferEnabled = true;

  // WARN 去重：记录每条 WARN 消息关键 key 的最后写入时间
  private _lastWarnTimestamps = new Map<string, number>();

  constructor(logDir: string) {
    this.logDir = logDir;
    this.errorLogDir = logDir; // 错误日志在同一目录
    ensureLogDir(logDir);
    // 启动时检查当日日志是否已超过阈值，若是则立即轮转
    this.rotateIfNeeded();
    // 启动定时刷盘
    this._startFlushTimer();
  }

  /** 设置全局日志级别 */
  setLevel(level: LogLevel) {
    this.level = level;
  }

  /** 获取全局日志级别 */
  getLevel(): LogLevel {
    return this.level;
  }

  /** 启用/禁用 JSON 格式输出（控制台保持文本，文件写入 JSON 行） */
  setJsonFormat(enable: boolean) {
    this._useJsonFormat = enable;
  }

  /** 是否使用 JSON 格式 */
  getJsonFormat(): boolean {
    return this._useJsonFormat;
  }

  /** 设置 traceId（直接设置，优先级低于 AsyncLocalStorage 上下文） */
  setTraceId(id: string | null) {
    this._traceId = id;
  }

  /** 获取当前 traceId：AsyncLocalStorage > 直接设置 > null */
  getTraceId(): string | null {
    const store = logContext.getStore();
    return store?.traceId ?? this._traceId ?? null;
  }

  /** 设置模块级日志级别（空字符串或 null 恢复为全局级别） */
  setModuleLevel(module: string, level: LogLevel | null) {
    if (level === null) {
      this._moduleLevels.delete(module);
    } else {
      this._moduleLevels.set(module, level);
    }
  }

  /** 获取所有模块级级别设置 */
  getModuleLevels(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [mod, lvl] of this._moduleLevels) {
      result[mod] = lvl;
    }
    return result;
  }

  /** 检查某条消息在当前模块设置下是否应输出 */
  private _shouldLog(level: LogLevel, message: string): boolean {
    const moduleName = extractModuleName(message);
    let effectiveLevel = this.level;
    if (moduleName && this._moduleLevels.has(moduleName)) {
      effectiveLevel = this._moduleLevels.get(moduleName)!;
    }
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(effectiveLevel);
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

  /** 设置缓冲区行数（设为 1 禁用缓冲，每次写入直接落盘） */
  setBufferSize(lines: number) {
    this._bufferSize = Math.max(1, lines);
    this._bufferEnabled = lines > 1;
  }

  /** 强制将缓冲区内容写入磁盘 */
  flush(): void {
    if (this._buffer.length === 0) return;
    const lines = this._buffer.splice(0, this._buffer.length);
    try {
      const logFile = this.getLogFilePath();
      this.checkRotation();
      fs.appendFileSync(logFile, lines.join(''), 'utf-8');
    } catch (err) {
      console.error(`[Logger] buffer flush error: ${err}`);
    }
  }

  /** 启动定时刷盘 */
  private _startFlushTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => {
      if (this._bufferEnabled && this._buffer.length > 0) {
        this.flush();
      }
    }, this._flushIntervalMs);
    // 不让定时器阻止进程退出
    if (this._flushTimer && typeof this._flushTimer === 'object' && 'unref' in this._flushTimer) {
      this._flushTimer.unref();
    }
  }

  /** 停止定时刷盘（进程退出前调用） */
  close(): void {
    this.flush();
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
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
    let archived = 0;
    try {
      const files = fs.readdirSync(this.logDir);
      const todayLog = getTodayLogFilename();
      const todayErrorLog = getTodayErrorFilename();
      for (const file of files) {
        const filePath = path.join(this.logDir, file);
        // 1. 清理过期的 .gz 轮转文件
        if (/\d+\.gz$/.test(file) && /\.log\.\d+\.gz$/.test(file)) {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            deleted++;
          }
          continue;
        }
        // 2. 归档过大的未压缩旧日志文件（非当天的 .log 文件）
        if (/\.log$/.test(file) && file !== todayLog && file !== todayErrorLog) {
          try {
            const stat = fs.statSync(filePath);
            // 超过保留天数 或 超过大小阈值（3MB）的旧日志，压缩归档
            if (now - stat.mtimeMs > maxAge || stat.size >= 3 * 1024 * 1024) {
              const gzPath = filePath + '.gz';
              const content = fs.readFileSync(filePath);
              const gzipped = zlib.gzipSync(content);
              fs.writeFileSync(gzPath, gzipped);
              fs.unlinkSync(filePath);
              archived++;
              console.log(`[Logger] 归档旧日志: ${file} → ${file}.gz (${(content.length / 1024 / 1024).toFixed(2)} MB)`);
            }
          } catch (err) {
            console.error(`[Logger] 归档 ${file} 失败: ${err}`);
          }
        }
      }
    } catch (err) {
      console.error(`[Logger] cleanupOldLogs error: ${err}`);
    }
    if (deleted > 0) {
      console.log(`[Logger] 清理了 ${deleted} 个过期轮转日志文件`);
    }
    if (archived > 0) {
      console.log(`[Logger] 归档了 ${archived} 个旧日志文件`);
    }
    return deleted + archived;
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
   *   1. 先刷盘
   *   2. 删除最旧的 .N.gz（若存在）
   *   3. 现有 .N.gz 编号后移
   *   4. 压缩当前日志为 .1.gz
   *   5. 清空当前日志文件
   *
   * 线程安全：通过 _rotating 互斥锁防止并发轮转
   */
  private performRotation(logFile: string, isErrorLog: boolean) {
    this._rotating = true;
    const baseName = logFile;

    // 先刷盘，确保缓冲区的日志全部写入后才轮转
    this.flush();

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

  /** 写入单行日志到缓冲区（或直接写入文件） */
  private _writeLine(logFile: string, line: string): void {
    if (this._bufferEnabled) {
      this._buffer.push(line + '\n');
      if (this._buffer.length >= this._bufferSize) {
        this.flush();
      }
    } else {
      fs.appendFileSync(logFile, line + '\n', 'utf-8');
    }
  }

  /** 写入错误日志到单独文件（不经过缓冲区，直接落盘——避免混入主日志文件） */
  private writeErrorToFile(timestamp: string, level: LogLevel, content: string, moduleName: string | null = null) {
    const errFile = this.getErrorLogFilePath();
    ensureLogDir(this.errorLogDir);
    const traceId = this.getTraceId();
    let line: string;
    if (this._useJsonFormat) {
      line = this._formatJson(level, moduleName, content, traceId);
    } else {
      line = `[${timestamp}] [${level.toUpperCase()}]${moduleName ? ` [${moduleName}]` : ''} ${content}${traceId ? ` | trace:${traceId}` : ''}`;
    }
    // 错误日志也参与轮转检查
    if (fs.existsSync(errFile)) {
      const stats = fs.statSync(errFile);
      if (stats.size >= this.maxFileSize) {
        this.performRotation(errFile, true);
      }
    }
    // 直接落盘，不经过主日志缓冲区
    fs.appendFileSync(errFile, line + '\n', 'utf-8');
  }

  /** 格式化 JSON 日志行（content 中的模块标签已前置提取，此处不再重复） */
  private _formatJson(
    level: LogLevel, module: string | null, content: string, traceId: string | null
  ): string {
    const obj: Record<string, unknown> = {
      t: new Date().toISOString(),
      l: level.toUpperCase(),
    };
    if (module) obj.m = module;
    // 如果有模块名，从 content 中去除开头的 [Module] 标签避免重复
    obj.msg = module ? content.replace(/^\[[^\]]+\]\s*/, '').trim() : content;
    if (traceId) obj.trace = traceId;
    return JSON.stringify(obj);
  }

  private write(level: LogLevel, message: string, ...args: unknown[]) {
    // 模块级级别过滤
    if (!this._shouldLog(level, message)) return;

    const timestamp = new Date().toISOString();
    const content = args.length > 0
      ? `${message} ${args.map(a => formatArg(a)).join(' ')}`
      : message;

    const traceId = this.getTraceId();
    const moduleName = extractModuleName(message);

    // 如有模块名，去除 content 开头的 [Module] 标签避免重复
    const cleanContent = moduleName ? content.replace(/^\[[^\]]+\]\s*/, '').trim() : content;

    if (this._useJsonFormat) {
      // JSON 模式：文件写 JSON 行，控制台输出 JSON 行
      const jsonLine = this._formatJson(level, moduleName, content, traceId);
      const prefix =
        level === 'error' ? '❌' :
        level === 'warn' ? '⚠️' :
        level === 'debug' ? '🔍' : '📋';
      console.log(`${prefix} ${jsonLine}`);

      const logFile = this.getLogFilePath();
      this._writeLine(logFile, jsonLine);
    } else {
      // 文本模式
      const line = `[${timestamp}] [${level.toUpperCase()}]${moduleName ? ` [${moduleName}]` : ''} ${cleanContent}${traceId ? ` | trace:${traceId}` : ''}`;

      const prefix =
        level === 'error' ? '❌' :
        level === 'warn' ? '⚠️' :
        level === 'debug' ? '🔍' : '📋';
      console.log(`${prefix} ${line}`);

      const logFile = this.getLogFilePath();
      this._writeLine(logFile, line);
    }

    // 错误日志文件：ERROR 级别全部写入，WARN 级别按频率过滤
    if (level === 'error') {
      this.writeErrorToFile(timestamp, level, cleanContent, moduleName);
    } else if (level === 'warn') {
      // 去重：相同前缀的 WARN 消息每 60 秒只写一次
      const warnKey = extractWarnKey(message);
      const now = Date.now();
      if (warnKey) {
        const last = this._lastWarnTimestamps.get(warnKey);
        if (!last || (now - last) >= 60000) {
          this._lastWarnTimestamps.set(warnKey, now);
          this.writeErrorToFile(timestamp, level, cleanContent, moduleName);
          // 清理过期 key（超过 5 分钟前的记录）
          for (const [k, v] of this._lastWarnTimestamps) {
            if (now - v > 300000) this._lastWarnTimestamps.delete(k);
          }
        }
      } else {
        this.writeErrorToFile(timestamp, level, cleanContent, moduleName);
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
  const tagMatch = message.match(/\[([^\]]+)\]/);
  if (!tagMatch) return null;
  const tag = tagMatch[0];
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
