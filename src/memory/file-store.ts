// 文件层记忆 — 按日追加，永不覆盖
import * as fs from 'fs';
import * as path from 'path';
import logger from '../logger';

const MAX_FILE_AGE_DAYS = 30; // 文件记忆最长保留 30 天

/** 文件记忆存储 — 按日追加，有裁剪 */
export class FileMemoryStore {
  private memoryDir: string;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
  }

  /** 写入当天记忆文件（追加模式） */
  append(content: string): void {
    const date = new Date().toISOString().split('T')[0];
    const file = path.join(this.memoryDir, `${date}.md`);

    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entry = `\n## ${timestamp}\n${content}\n`;

    fs.appendFileSync(file, entry, 'utf-8');
    logger.debug(`[Memory] 写入 ${file}`);
  }

  /** 搜索记忆，返回匹配的文件名 + 匹配行片段 */
  search(keyword: string, daysBack: number = 7): Array<{ file: string; lines: string[] }> {
    const results: Array<{ file: string; lines: string[] }> = [];
    const now = Date.now();

    const files = fs.readdirSync(this.memoryDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    for (const file of files) {
      const filePath = path.join(this.memoryDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > daysBack * 86400000) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lowerContent = content.toLowerCase();
      const kw = keyword.toLowerCase();
      if (!lowerContent.includes(kw)) continue;

      // 提取匹配行（前后各保留 1 行上下文）
      const lines = content.split('\n');
      const matchedLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(kw)) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          for (let j = start; j < end; j++) {
            const trimmed = lines[j].trim();
            if (trimmed && !matchedLines.includes(trimmed)) {
              matchedLines.push(trimmed.slice(0, 200));
            }
          }
        }
      }

      results.push({ file, lines: matchedLines });
    }

    return results;
  }

  /** 读今天的内容 */
  readToday(): string {
    const date = new Date().toISOString().split('T')[0];
    const file = path.join(this.memoryDir, `${date}.md`);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf-8');
  }

  /** 获取统计：文件数、总大小、最大文件 */
  getStats(): { fileCount: number; totalBytes: number; oldestFile: string | null } {
    let totalBytes = 0;
    let fileCount = 0;
    let oldestFile: string | null = null;
    let oldestMtime = Infinity;

    const files = fs.readdirSync(this.memoryDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const stat = fs.statSync(path.join(this.memoryDir, file));
        totalBytes += stat.size;
        fileCount++;
        if (stat.mtimeMs < oldestMtime) {
          oldestMtime = stat.mtimeMs;
          oldestFile = file;
        }
      } catch { /* 跳过无法 stat 的文件 */ }
    }

    return { fileCount, totalBytes, oldestFile };
  }

  /** 裁剪旧文件：删除超过 N 天的记忆文件 */
  prune(maxAgeDays: number = MAX_FILE_AGE_DAYS): number {
    const now = Date.now();
    const cutoff = now - maxAgeDays * 86400000;
    let deleted = 0;

    const files = fs.readdirSync(this.memoryDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const filePath = path.join(this.memoryDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          deleted++;
          logger.debug(`[Memory] 裁剪旧文件: ${file}`);
        }
      } catch (err) {
        logger.warn(`[Memory] 裁剪失败: ${file}`, err);
      }
    }

    if (deleted > 0) {
      logger.info(`[Memory] 裁剪完成: 删除了 ${deleted} 个过期文件 (保留 ${maxAgeDays} 天)`);
    }
    return deleted;
  }
}

// 全局实例（由 bootstrap 初始化）
let store: FileMemoryStore | null = null;

export function initMemoryStore(dir: string): FileMemoryStore {
  store = new FileMemoryStore(dir);
  return store;
}

export function getMemoryStore(): FileMemoryStore {
  if (!store) {
    throw new Error('Memory store 未初始化');
  }
  return store;
}
