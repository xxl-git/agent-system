// packages/prompts/src/logger.ts — 本地日志模块（不依赖根项目）
import * as fs from 'fs';
import * as path from 'path';

const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, `prompts-${new Date().toISOString().slice(0, 10)}.log`);

export interface Logger {
  info(msg: string, ...args: any[]): void;
  warn(msg: string, ...args: any[]): void;
  error(msg: string, ...args: any[]): void;
  debug(msg: string, ...args: any[]): void;
}

class SimpleLogger implements Logger {
  private level: 'debug' | 'info' | 'warn' | 'error' = 'info';

  setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.level = level;
  }

  private shouldLog(level: string): boolean {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[level as keyof typeof levels] >= levels[this.level];
  }

  private write(level: string, msg: string): void {
    if (!this.shouldLog(level)) return;
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] [${level.toUpperCase()}] ${msg}\n`;
    fs.appendFileSync(logFile, logMsg);
    if (level === 'error' || level === 'warn') console[level](msg);
  }

  info(msg: string): void { this.write('info', msg); }
  warn(msg: string): void { this.write('warn', msg); }
  error(msg: string): void { this.write('error', msg); }
  debug(msg: string): void { this.write('debug', msg); }
}

export const logger: Logger = new SimpleLogger();
