// 数据库层记忆 — sql.js (纯 JS，无需原生编译)
// 表结构：sessions, decisions, entities, summaries
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface DBConfig {
  dbPath: string;
  autoSaveIntervalMs: number;
}

export interface SessionRecord {
  id: string;
  started_at: string;
  ended_at: string | null;
  message_count: number;
  summary: string;
  tags: string;
}

export interface DecisionRecord {
  id?: number;
  timestamp: string;
  category: string;
  summary: string;
  detail: string;
  project: string;
}

export interface EntityRecord {
  id?: number;
  name: string;
  type: string; // person, company, product, project, tool, concept
  first_seen: string;
  last_seen: string;
  mention_count: number;
  notes: string;
}

export interface SummaryRecord {
  id?: number;
  session_id: string;
  timestamp: string;
  content: string;
  key_points: string;
}

export class DBStore {
  private db!: Database;
  private SQL!: SqlJsStatic;
  private dbPath: string;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private autoSaveInterval: number;
  private initialized = false;

  constructor(config?: Partial<DBConfig>) {
    this.dbPath = config?.dbPath || path.join(process.cwd(), 'data', 'agent.db');
    this.autoSaveInterval = config?.autoSaveIntervalMs || 60000; // 每分钟自动保存
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.SQL = await initSqlJs();

    // 确保目录存在
    const dir = path.dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // 加载或创建数据库
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
      logger.info(`[DB] 已加载数据库: ${this.dbPath}`);
    } else {
      this.db = new this.SQL.Database();
      logger.info('[DB] 已创建新数据库');
    }

    this.createTables();
    this.startAutoSave();
    this.initialized = true;
  }

  private createTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        message_count INTEGER DEFAULT 0,
        summary TEXT DEFAULT '',
        tags TEXT DEFAULT ''
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT DEFAULT '',
        session_id TEXT DEFAULT '',
        project TEXT DEFAULT ''
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        mention_count INTEGER DEFAULT 1,
        notes TEXT DEFAULT ''
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL,
        key_points TEXT DEFAULT ''
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
    `);

    // 向后兼容: 旧库可能缺 session_id 列
    try {
      this.db.run('ALTER TABLE decisions ADD COLUMN session_id TEXT DEFAULT \'\'');
    } catch { /* 列已存在 */ }

    this.save();
  }

  // === Session 操作 ===
  startSession(id: string): void {
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO sessions (id, started_at) VALUES (?, ?)',
      [id, now]
    );
    logger.info(`[DB] 会话开始: ${id}`);
  }

  endSession(id: string, summary?: string, messageCount?: number): void {
    const now = new Date().toISOString();
    this.db.run(
      'UPDATE sessions SET ended_at = ?, summary = COALESCE(?, summary), message_count = ? WHERE id = ?',
      [now, summary || null, messageCount ?? 1, id]
    );
    logger.info(`[DB] 会话结束: ${id} (${messageCount ?? 1} 条消息)`);
  }

  getSession(id: string): SessionRecord | null {
    const rows = this.db.exec('SELECT * FROM sessions WHERE id = ?', [id]);
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    const cols = rows[0].columns;
    const vals = rows[0].values[0];
    const obj: Record<string, any> = {};
    cols.forEach((c: string, i: number) => { obj[c] = vals[i]; });
    return obj as SessionRecord;
  }

  // === Decision 操作 ===
  addDecision(decision: DecisionRecord): number {
    const stmt = this.db.run(
      'INSERT INTO decisions (timestamp, category, summary, detail, project) VALUES (?, ?, ?, ?, ?)',
      [decision.timestamp, decision.category, decision.summary, decision.detail, decision.project]
    );
    logger.debug(`[DB] 决策记录: ${decision.summary.slice(0, 50)}`);
    return Number(this.db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
  }

  searchDecisions(keyword: string, limit = 20): DecisionRecord[] {
    const rows = this.db.exec(
      `SELECT * FROM decisions WHERE summary LIKE ? OR detail LIKE ? ORDER BY timestamp DESC LIMIT ?`,
      [`%${keyword}%`, `%${keyword}%`, limit]
    );
    return this.rowsToObjects(rows) as DecisionRecord[];
  }

  // === Entity 操作 ===
  upsertEntity(entity: Omit<EntityRecord, 'id' | 'mention_count' | 'last_seen'>): void {
    const now = new Date().toISOString();
    const existing = this.db.exec('SELECT mention_count FROM entities WHERE name = ?', [entity.name]);

    if (existing.length > 0 && existing[0].values.length > 0) {
      const count = Number(existing[0].values[0][0]) + 1;
      this.db.run(
        'UPDATE entities SET last_seen = ?, mention_count = ?, notes = COALESCE(?, notes) WHERE name = ?',
        [now, count, entity.notes || null, entity.name]
      );
    } else {
      this.db.run(
        'INSERT INTO entities (name, type, first_seen, last_seen, mention_count, notes) VALUES (?, ?, ?, ?, 1, ?)',
        [entity.name, entity.type, entity.first_seen, now, entity.notes]
      );
    }
  }

  getEntity(name: string): EntityRecord | null {
    const rows = this.db.exec('SELECT * FROM entities WHERE name = ?', [name]);
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    const cols = rows[0].columns;
    const vals = rows[0].values[0];
    const obj: Record<string, any> = {};
    cols.forEach((c: string, i: number) => { obj[c] = vals[i]; });
    return obj as EntityRecord;
  }

  searchEntities(keyword: string, limit = 20): EntityRecord[] {
    const rows = this.db.exec(
      `SELECT * FROM entities WHERE name LIKE ? OR notes LIKE ? ORDER BY mention_count DESC LIMIT ?`,
      [`%${keyword}%`, `%${keyword}%`, limit]
    );
    return this.rowsToObjects(rows) as EntityRecord[];
  }

  // === Summary 操作 ===
  addSummary(summary: SummaryRecord): number {
    const stmt = this.db.run(
      'INSERT INTO summaries (session_id, timestamp, content, key_points) VALUES (?, ?, ?, ?)',
      [summary.session_id, summary.timestamp, summary.content, summary.key_points]
    );
    return Number(this.db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
  }

  
  getSessionSummaries(sessionId: string): SummaryRecord[] {
    const rows = this.db.exec(
      'SELECT * FROM summaries WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    );
    return this.rowsToObjects(rows) as SummaryRecord[];
  }

  /** 查询摘要 - 支持limit */
  querySummaries(sessionId: string, opts: { limit?: number } = {}): SummaryRecord[] {
    const limit = opts.limit || 50;
    const rows = this.db.exec(
      'SELECT * FROM summaries WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?',
      [sessionId, limit]
    );
    return this.rowsToObjects(rows) as SummaryRecord[];
  }

  /** 跨会话最近摘要 */
  queryRecentSummaries(limit: number = 5): SummaryRecord[] {
    const rows = this.db.exec(
      'SELECT * FROM summaries ORDER BY timestamp DESC LIMIT ?',
      [limit]
    );
    return this.rowsToObjects(rows) as SummaryRecord[];
  }

  /** 清理旧摘要，只保留最新的 N 条 */
  pruneSummaries(maxToKeep: number): void {
    const rows = this.db.exec('SELECT COUNT(*) as cnt FROM summaries');
    if (rows.length === 0 || rows[0].values.length === 0) return;
    const count = Number(rows[0].values[0][0]);
    if (count <= maxToKeep) return;

    const deleteCount = count - maxToKeep;
    this.db.run(
      'DELETE FROM summaries WHERE id IN (SELECT id FROM summaries ORDER BY timestamp ASC LIMIT ?)',
      [deleteCount]
    );
    logger.debug(`[DB] 清理了 ${deleteCount} 条旧摘要`);
  }

  /** 按 sessionId 查询决策 */
  queryDecisions(opts: { sessionId?: string; project?: string; limit?: number }): DecisionRecord[] {
    const limit = opts.limit || 20;
    if (opts.sessionId) {
      const rows = this.db.exec(
        'SELECT * FROM decisions WHERE session_id = ? OR project = ? ORDER BY timestamp DESC LIMIT ?',
        [opts.sessionId, opts.sessionId, limit]
      );
      return this.rowsToObjects(rows) as DecisionRecord[];
    } else if (opts.project) {
      const rows = this.db.exec(
        'SELECT * FROM decisions WHERE project = ? ORDER BY timestamp DESC LIMIT ?',
        [opts.project, limit]
      );
      return this.rowsToObjects(rows) as DecisionRecord[];
    } else {
      const rows = this.db.exec(
        'SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?',
        [limit]
      );
      return this.rowsToObjects(rows) as DecisionRecord[];
    }
  }

  searchSummaries(keyword: string, limit = 10): SummaryRecord[] {
    const rows = this.db.exec(
      `SELECT * FROM summaries WHERE content LIKE ? OR key_points LIKE ? ORDER BY timestamp DESC LIMIT ?`,
      [`%${keyword}%`, `%${keyword}%`, limit]
    );
    return this.rowsToObjects(rows) as SummaryRecord[];
  }

  // === 通用搜索 ===
  searchAll(keyword: string, limit = 20): string {
    const results: string[] = [];

    const decisions = this.searchDecisions(keyword, 5);
    if (decisions.length > 0) {
      results.push(`**决策记录 (${decisions.length})**:`);
      decisions.forEach(d => results.push(`  [${d.timestamp}] ${d.summary}`));
    }

    const entities = this.searchEntities(keyword, 10);
    if (entities.length > 0) {
      results.push(`**相关实体 (${entities.length})**:`);
      entities.forEach(e => results.push(`  ${e.type}: ${e.name} (提及 ${e.mention_count} 次)`));
    }

    const summaries = this.searchSummaries(keyword, 3);
    if (summaries.length > 0) {
      results.push(`**相关摘要 (${summaries.length})**:`);
      summaries.forEach(s => results.push(`  [${s.timestamp}] ${s.content.slice(0, 100)}`));
    }

    return results.length > 0 ? results.join('\n') : '未找到相关记录';
  }

  // === 导出/统计 ===
  getStats(): string {
    const stats: string[] = [];
    const tables = ['sessions', 'decisions', 'entities', 'summaries'];
    for (const table of tables) {
      const rows = this.db.exec(`SELECT COUNT(*) as cnt FROM ${table}`);
      if (rows.length > 0 && rows[0].values.length > 0) {
        stats.push(`${table}: ${rows[0].values[0][0]} 条`);
      }
    }
    return stats.join('\n');
  }

  // === 内部方法 ===
  private rowsToObjects(rows: { columns: string[]; values: any[][] }[]): Record<string, any>[] {
    if (rows.length === 0) return [];
    const { columns, values } = rows[0];
    return values.map((row: any[]) => {
      const obj: Record<string, any> = {};
      columns.forEach((col: string, i: number) => { obj[col] = row[i]; });
      return obj;
    });
  }

  private startAutoSave(): void {
    this.autoSaveTimer = setInterval(() => {
      this.save();
    }, this.autoSaveInterval);
  }

  save(): void {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      writeFileSync(this.dbPath, buffer);
    } catch (err) {
      logger.error('[DB] 保存失败', err);
    }
  }

  close(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }
    this.save();
    this.db.close();
    logger.info('[DB] 数据库已关闭');
  }
}

// 单例
let instance: DBStore | null = null;
export function getDBStore(): DBStore {
  if (!instance) {
    instance = new DBStore();
  }
  return instance;
}
