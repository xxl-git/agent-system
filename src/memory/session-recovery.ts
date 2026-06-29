// 跨会话记忆恢复 — 加载历史决策/实体/摘要，注入 system prompt
// Phase 5 P1: 解决重启失忆
import { getDBStore, type DecisionRecord, type EntityRecord, type SummaryRecord } from './db-store';
import { getMemoryStore } from './file-store';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import * as path from 'path';
import logger from '../logger';

export interface MemoryInjection {
  /** 最近决策（按时间倒序） */
  recentDecisions: DecisionRecord[];
  /** 近期实体 */
  trackedEntities: EntityRecord[];
  /** 最近会话摘要 */
  recentSummaries: SummaryRecord[];
  /** 最近文件记忆（最近N天的markdown文件摘要） */
  recentFileMemory: string;
  /** 生成的系统提示注入文本 */
  systemPromptBlock: string;
}

export interface RecoveryConfig {
  maxDecisions: number;      // 最多注入多少条决策
  maxEntities: number;       // 最多注入多少实体
  maxSummaries: number;      // 最多注入多少会话摘要
  recentDays: number;        // 回溯多少天的文件记忆
  maxInjectionChars: number; // 注入总长度上限
}

const DEFAULT_CONFIG: RecoveryConfig = {
  maxDecisions: 10,
  maxEntities: 10,
  maxSummaries: 3,
  recentDays: 7,
  maxInjectionChars: 3000,
};

export class SessionRecoverer {
  private config: RecoveryConfig;

  constructor(config?: Partial<RecoveryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 从 DB + 文件层恢复记忆，生成注入用的上下文文本 */
  recover(): MemoryInjection {
    let recentDecisions: DecisionRecord[] = [];
    let trackedEntities: EntityRecord[] = [];
    let recentSummaries: SummaryRecord[] = [];
    let recentFileMemory = '';

    // ── DB 层恢复 ───────────────────────────────────────────────
    try {
      const db = getDBStore();
      // 直接查询，不过滤 stats（stats 字符串匹配不可靠）
      recentDecisions = this.loadRecentDecisions(db);
      trackedEntities = this.loadTopEntities(db);
      recentSummaries = this.loadRecentSummaries(db);
      logger.debug(`[Recovery] DB: ${recentDecisions.length} 决策, ${trackedEntities.length} 实体, ${recentSummaries.length} 摘要`);
    } catch (err) {
      logger.warn('[Recovery] DB load failed, continuing with file-only', err);
    }

    // ── 文件层恢复 ──────────────────────────────────────────────
    try {
      const memStore = getMemoryStore();
      recentFileMemory = this.loadRecentFileMemory(memStore);
    } catch (err) {
      logger.warn('[Recovery] File memory load failed', err);
    }

    const systemPromptBlock = this.buildPromptBlock(
      recentDecisions,
      trackedEntities,
      recentSummaries,
      recentFileMemory,
    );

    return {
      recentDecisions,
      trackedEntities,
      recentSummaries,
      recentFileMemory,
      systemPromptBlock,
    };
  }

  // ─── DB 层加载（修复：sql.js exec() 不支持参数化 LIMIT） ──────

  private loadRecentDecisions(db: any): DecisionRecord[] {
    try {
      const limit = Math.min(this.config.maxDecisions, 100);
      const sql = `SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ${limit}`;
      const rows = db.db.exec(sql);
      if (rows.length === 0 || rows[0].values.length === 0) return [];
      const { columns, values } = rows[0];
      return values.map((row: any[]) => {
        const obj: any = {};
        columns.forEach((c: string, i: number) => { obj[c] = row[i]; });
        return obj as DecisionRecord;
      });
    } catch (err) {
      logger.debug('[Recovery] loadRecentDecisions failed', err);
      return [];
    }
  }

  private loadTopEntities(db: any): EntityRecord[] {
    try {
      const limit = Math.min(this.config.maxEntities, 100);
      const sql = `SELECT * FROM entities ORDER BY mention_count DESC LIMIT ${limit}`;
      const rows = db.db.exec(sql);
      if (rows.length === 0 || rows[0].values.length === 0) return [];
      const { columns, values } = rows[0];
      return values.map((row: any[]) => {
        const obj: any = {};
        columns.forEach((c: string, i: number) => { obj[c] = row[i]; });
        return obj as EntityRecord;
      });
    } catch (err) {
      logger.debug('[Recovery] loadTopEntities failed', err);
      return [];
    }
  }

  private loadRecentSummaries(db: any): SummaryRecord[] {
    try {
      const limit = Math.min(this.config.maxSummaries, 20);
      const sql = `SELECT * FROM summaries ORDER BY timestamp DESC LIMIT ${limit}`;
      const rows = db.db.exec(sql);
      if (rows.length === 0 || rows[0].values.length === 0) return [];
      const { columns, values } = rows[0];
      return values.map((row: any[]) => {
        const obj: any = {};
        columns.forEach((c: string, i: number) => { obj[c] = row[i]; });
        return obj as DecisionRecord;
      });
    } catch (err) {
      logger.debug('[Recovery] loadRecentSummaries failed', err);
      return [];
    }
  }

  // ─── 文件层加载 ──────────────────────────────────────────────

  private loadRecentFileMemory(memStore: any): string {
    const parts: string[] = [];
    const now = Date.now();
    const memoryDir = path.join(process.cwd(), 'memory');
    const ageThreshold = this.config.recentDays * 86400000; // ms

    if (!existsSync(memoryDir)) return '';

    try {
      // 通过 FileMemoryStore 读取今天的内容
      const todayContent = memStore.readToday();
      if (todayContent) {
        const brief = todayContent.slice(0, 500).replace(/\n{3,}/g, '\n\n');
        const date = new Date().toISOString().split('T')[0];
        parts.push(`  [今天 ${date}]: ${brief}${todayContent.length > 500 ? '...' : ''}`);
      }

      // 读取之前 N 天的文件（按修改时间降序，最多 N-1 个，跳过已读今天）
      const todayDate = new Date().toISOString().split('T')[0];
      const files = readdirSync(memoryDir)
        .filter((f: string) => f.endsWith('.md') && f.replace('.md', '') !== todayDate)
        .sort()
        .reverse() // newest first
        .slice(0, this.config.recentDays - 1);

      for (const file of files) {
        const filePath = path.join(memoryDir, file);
        const stat = statSync(filePath);
        // 跳过超过 N 天的旧文件
        if (now - stat.mtimeMs > ageThreshold) continue;

        const content = readFileSync(filePath, 'utf-8');
        const brief = content.slice(0, 300).replace(/\n{3,}/g, '\n\n');
        parts.push(`  [${file.replace('.md', '')}]: ${brief}${content.length > 300 ? '...' : ''}`);
      }
    } catch (err) {
      logger.warn('[Recovery] reading memory files failed', err);
    }

    return parts.join('\n');
  }

  // ─── 构建注入文本 ────────────────────────────────────────────

  private buildPromptBlock(
    decisions: DecisionRecord[],
    entities: EntityRecord[],
    summaries: SummaryRecord[],
    fileMem: string,
  ): string {
    const lines: string[] = [];
    let charCount = 0;
    const limit = this.config.maxInjectionChars;

    if (decisions.length === 0 && entities.length === 0 && summaries.length === 0 && !fileMem) {
      return ''; // 无历史记忆时返回空字符串
    }

    // 1. 最近决策
    if (decisions.length > 0) {
      lines.push('[PAST DECISIONS]');
      for (const d of decisions) {
        const line = `  [${(d.timestamp ?? '').slice(0, 16) ?? '?'}] ${d.category}: ${d.summary}`;
        if (charCount + line.length > limit) break;
        lines.push(line);
        charCount += line.length + 1;
      }
    }

    // 2. 跟踪实体
    if (entities.length > 0 && charCount < limit) {
      lines.push('[TRACKED ENTITIES]');
      for (const e of entities) {
        const line = `  ${e.type}: ${e.name} (mentioned ${e.mention_count}x)${e.notes ? ' - ' + e.notes : ''}`;
        if (charCount + line.length > limit) break;
        lines.push(line);
        charCount += line.length + 1;
      }
    }

    // 3. 最近会话摘要
    if (summaries.length > 0 && charCount < limit) {
      lines.push('[RECENT SESSION SUMMARIES]');
      for (const s of summaries) {
        const line = `  [${(s.timestamp ?? '').slice(0, 16) ?? '?'}] ${s.content}`;
        if (charCount + line.length > limit) break;
        lines.push(line);
        charCount += line.length + 1;
      }
    }

    // 4. 近期文件记忆
    if (fileMem && charCount < limit) {
      const remaining = limit - charCount;
      const truncated = fileMem.length > remaining
        ? fileMem.slice(0, remaining - 3) + '...'
        : fileMem;
      lines.push('[RECENT FILE MEMORY]');
      lines.push(truncated);
    }

    return lines.join('\n');
  }
}

// 全局单例
let recoverer: SessionRecoverer | null = null;

export function getSessionRecoverer(config?: Partial<RecoveryConfig>): SessionRecoverer {
  if (!recoverer || config) {
    recoverer = new SessionRecoverer(config);
  }
  return recoverer;
}
