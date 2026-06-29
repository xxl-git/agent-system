// ExperienceStore — 经验存储层
// SQLite (data/experiences.db) + MD 文件 (data/experiences/) 双层存储
// 复用 sql.js 技术栈，与 db-store.ts 模式一致

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import * as path from 'path';
import logger from '../logger';
import type {
  ExperienceRecord,
  ExperienceInput,
  ExperienceOutcome,
  ExperienceStatus,
} from './types';

// ─── ExperienceStore ──────────────────────────────────────────────────────────

export class ExperienceStore {
  private db!: Database;
  private SQL!: SqlJsStatic;
  private dbPath: string;
  private mdDir: string;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(dbPath?: string, mdDir?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'experiences.db');
    this.mdDir = mdDir || path.join(process.cwd(), 'data', 'experiences');
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.SQL = await initSqlJs();

    const dir = path.dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(this.mdDir)) mkdirSync(this.mdDir, { recursive: true });

    if (existsSync(this.dbPath)) {
      this.db = new this.SQL.Database(readFileSync(this.dbPath));
      logger.info(`[ExperienceStore] 已加载数据库: ${this.dbPath}`);
    } else {
      this.db = new this.SQL.Database();
      logger.info('[ExperienceStore] 已创建新数据库');
    }

    this.createTables();
    this.startAutoSave();
    this.initialized = true;
  }

  private createTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS experiences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        source TEXT DEFAULT 'auto',
        scenario TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        project TEXT DEFAULT '',
        model_used TEXT DEFAULT '',
        problem TEXT NOT NULL,
        solution TEXT NOT NULL,
        reasoning TEXT DEFAULT '',
        code_snippet TEXT DEFAULT '',
        outcome TEXT NOT NULL,
        type TEXT NOT NULL,
        reuse_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        score REAL DEFAULT 1.0,
        last_used TEXT DEFAULT '',
        updated_at TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        deprecated_reason TEXT DEFAULT ''
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_exp_tags ON experiences(tags)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_exp_score ON experiences(score DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_exp_scenario ON experiences(scenario)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_exp_status ON experiences(status)`);

    this.persist();
  }

  // ─── 写入 ──────────────────────────────────────────────────────────────────

  /** 创建一条新经验 */
  save(input: ExperienceInput): number {
    const now = new Date().toISOString();
    const outcome = input.outcome;
    const baseScore = outcome === 'success' ? 1.0 : 0.8;

    this.db.run(
      `INSERT INTO experiences
        (created_at, session_id, source, scenario, tags, project, model_used,
         problem, solution, reasoning, code_snippet, outcome, type,
         reuse_count, success_count, fail_count, score,
         last_used, updated_at, status, deprecated_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, '', ?, 'active', '')`,
      [
        now,
        input.sessionId || '',
        input.source || 'auto',
        input.scenario,
        JSON.stringify(input.tags || []),
        input.project || '',
        input.modelUsed || '',
        input.problem,
        input.solution,
        input.reasoning || '',
        input.codeSnippet || '',
        outcome,
        input.type,
        baseScore,
        now,
      ],
    );

    const id = Number(this.db.exec('SELECT last_insert_rowid()')[0].values[0][0]);

    // 写 MD 文件（人类可读）
    this.writeMdFile(id, input, now);

    logger.info(`[ExperienceStore] 保存经验 #${id}: ${input.scenario} (${input.type}/${outcome})`);
    this.persist();
    return id;
  }

  // ─── 查询 ──────────────────────────────────────────────────────────────────

  getById(id: number): ExperienceRecord | null {
    const rows = this.db.exec('SELECT * FROM experiences WHERE id = ?', [id]);
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    return this.rowToObject(rows[0].columns, rows[0].values[0]);
  }

  getAll(limit = 100): ExperienceRecord[] {
    const rows = this.db.exec(
      'SELECT * FROM experiences ORDER BY score DESC, created_at DESC LIMIT ?',
      [limit],
    );
    return this.rowsToObjects(rows);
  }

  getByTags(tags: string[], limit = 10): ExperienceRecord[] {
    const conditions = tags.map(() => 'tags LIKE ?').join(' OR ');
    const params = tags.map(t => `%"${t}"%`);
    const rows = this.db.exec(
      `SELECT * FROM experiences WHERE (${conditions}) AND status = 'active' ORDER BY score DESC LIMIT ?`,
      [...params, limit],
    );
    return this.rowsToObjects(rows);
  }

  search(keyword: string, limit = 10): ExperienceRecord[] {
    const pattern = `%${keyword}%`;
    const rows = this.db.exec(
      `SELECT * FROM experiences
       WHERE (scenario LIKE ? OR problem LIKE ? OR solution LIKE ? OR tags LIKE ?)
       AND status = 'active'
       ORDER BY score DESC LIMIT ?`,
      [pattern, pattern, pattern, pattern, limit],
    );
    return this.rowsToObjects(rows);
  }

  /** 获取所有活跃经验（用于检索器全量扫描） */
  getActive(): ExperienceRecord[] {
    const rows = this.db.exec(
      `SELECT * FROM experiences WHERE status = 'active' ORDER BY score DESC`,
    );
    return this.rowsToObjects(rows);
  }

  // ─── 更新 ──────────────────────────────────────────────────────────────────

  recordUsage(id: number, success: boolean): void {
    const now = new Date().toISOString();
    const rec = this.getById(id);
    if (!rec) return;

    const newReuse = rec.reuseCount + 1;
    const newSuccess = rec.successCount + (success ? 1 : 0);
    const newFail = rec.failCount + (success ? 0 : 1);
    const newScore = this.computeScore(rec.outcome, newReuse, newSuccess, now);

    this.db.run(
      `UPDATE experiences SET reuse_count = ?, success_count = ?, fail_count = ?, score = ?, last_used = ?, updated_at = ? WHERE id = ?`,
      [newReuse, newSuccess, newFail, newScore, now, now, id],
    );
    logger.debug(`[ExperienceStore] 经验 #${id} 使用记录: reuse=${newReuse} success=${newSuccess} score=${newScore.toFixed(3)}`);
    this.persist();
  }

  deprecate(id: number, reason: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE experiences SET status = 'deprecated', deprecated_reason = ?, updated_at = ? WHERE id = ?`,
      [reason, now, id],
    );
    logger.info(`[ExperienceStore] 经验 #${id} 已废弃: ${reason}`);
    this.persist();
  }

  /** 硬删除一条经验（含 MD 文件） */
  delete(id: number): boolean {
    const rec = this.getById(id);
    if (!rec) return false;

    this.db.run('DELETE FROM experiences WHERE id = ?', [id]);

    // 清理 MD 文件
    const filename = `exp_${String(id).padStart(3, '0')}.md`;
    const filepath = path.join(this.mdDir, filename);
    try {
      if (existsSync(filepath)) {
        unlinkSync(filepath);
      }
    } catch (err) {
      logger.warn(`[ExperienceStore] 删除 MD 文件失败: ${filepath}`, err);
    }

    logger.info(`[ExperienceStore] 经验 #${id} 已删除: ${rec.scenario}`);
    this.persist();
    return true;
  }

  /** 更新已有经验内容（保留统计字段 reuseCount/score 等） */
  update(id: number, input: ExperienceInput): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    const now = new Date().toISOString();
    // outcome 变了要重算 baseScore，但保留 reuseCount/successCount/failCount
    const baseScore = input.outcome === 'success' ? 1.0 : 0.8;
    const newScore = this.computeScore(input.outcome, existing.reuseCount, existing.successCount, existing.lastUsed || now);

    this.db.run(
      `UPDATE experiences SET
        scenario = ?, tags = ?, project = ?, model_used = ?,
        problem = ?, solution = ?, reasoning = ?, code_snippet = ?,
        outcome = ?, type = ?, score = ?, updated_at = ?, source = ?
       WHERE id = ?`,
      [
        input.scenario,
        JSON.stringify(input.tags || []),
        input.project || existing.project,
        input.modelUsed || existing.modelUsed,
        input.problem,
        input.solution,
        input.reasoning || '',
        input.codeSnippet || '',
        input.outcome,
        input.type,
        newScore,
        now,
        input.source || existing.source,
        id,
      ],
    );

    // 重写 MD 文件
    this.writeMdFile(id, input, existing.createdAt);
    logger.info(`[ExperienceStore] 经验 #${id} 已更新: ${input.scenario}`);
    this.persist();
    return true;
  }

  // ─── 评分 ──────────────────────────────────────────────────────────────────

  computeScore(outcome: ExperienceOutcome, reuseCount: number, successCount: number, lastUsed: string): number {
    const baseScore = outcome === 'success' ? 1.0 : 0.8;
    const successRate = reuseCount === 0 ? 1.0 : successCount / reuseCount;

    // 时间衰减
    let decay = 0.4;
    if (lastUsed) {
      const daysSince = (Date.now() - new Date(lastUsed).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince <= 30) decay = 1.0;
      else if (daysSince <= 90) decay = 0.7;
    }

    const score = baseScore * decay * (0.3 + 0.7 * successRate);
    return Math.max(0, Math.min(1, score));
  }

  /** 批量重新计算评分（定时维护用） */
  recomputeAllScores(): void {
    const all = this.getAll(10000);
    const now = new Date().toISOString();
    let updated = 0;
    for (const rec of all) {
      if (!rec.id) continue;
      const newScore = this.computeScore(rec.outcome, rec.reuseCount, rec.successCount, rec.lastUsed);
      if (Math.abs(newScore - rec.score) > 0.01) {
        this.db.run(
          'UPDATE experiences SET score = ?, updated_at = ? WHERE id = ?',
          [newScore, now, rec.id],
        );
        updated++;
      }
    }
    if (updated > 0) {
      logger.info(`[ExperienceStore] 评分维护: 更新了 ${updated} 条经验的评分`);
      this.persist();
    }
  }

  // ─── 统计 ──────────────────────────────────────────────────────────────────

  getStats(): { total: number; active: number; deprecated: number; patterns: number; pitfalls: number; tips: number } {
    const total = this.db.exec('SELECT COUNT(*) FROM experiences');
    const active = this.db.exec("SELECT COUNT(*) FROM experiences WHERE status = 'active'");
    const deprecated = this.db.exec("SELECT COUNT(*) FROM experiences WHERE status = 'deprecated'");
    const patterns = this.db.exec("SELECT COUNT(*) FROM experiences WHERE type = 'pattern'");
    const pitfalls = this.db.exec("SELECT COUNT(*) FROM experiences WHERE type = 'pitfall'");
    const tips = this.db.exec("SELECT COUNT(*) FROM experiences WHERE type = 'tip'");

    const val = (r: ReturnType<Database['exec']>) => r.length > 0 ? Number(r[0].values[0][0]) : 0;

    return {
      total: val(total),
      active: val(active),
      deprecated: val(deprecated),
      patterns: val(patterns),
      pitfalls: val(pitfalls),
      tips: val(tips),
    };
  }

  // ─── 内部方法 ──────────────────────────────────────────────────────────────

  private writeMdFile(id: number, input: ExperienceInput, createdAt: string): void {
    const filename = `exp_${String(id).padStart(3, '0')}.md`;
    const filepath = path.join(this.mdDir, filename);
    const tags = (input.tags || []).map(t => `"${t}"`).join(', ');

    const content = `---
id: ${id}
created_at: ${createdAt}
source: ${input.source || 'auto'}
outcome: ${input.outcome}
type: ${input.type}
tags: [${tags}]
project: ${input.project || ''}
model_used: ${input.modelUsed || ''}
---

# ${input.scenario}

## Problem
${input.problem}

## Solution
${input.solution}

## Reasoning
${input.reasoning || 'N/A'}

${input.codeSnippet ? `## Code\n\`\`\`\n${input.codeSnippet}\n\`\`\`\n` : ''}
`;
    writeFileSync(filepath, content, 'utf-8');
  }

  private rowsToObjects(rows: { columns: string[]; values: any[][] }[]): ExperienceRecord[] {
    if (rows.length === 0) return [];
    return rows[0].values.map(row => this.rowToObject(rows[0].columns, row)!);
  }

  private rowToObject(columns: string[], vals: any[]): ExperienceRecord {
    const o: Record<string, any> = {};
    columns.forEach((c, i) => { o[c] = vals[i]; });

    let tags: string[] = [];
    try { tags = JSON.parse(o.tags || '[]'); } catch { tags = []; }

    return {
      id: o.id,
      createdAt: o.created_at,
      sessionId: o.session_id,
      source: o.source,
      scenario: o.scenario,
      tags,
      project: o.project,
      modelUsed: o.model_used,
      problem: o.problem,
      solution: o.solution,
      reasoning: o.reasoning,
      codeSnippet: o.code_snippet,
      outcome: o.outcome,
      type: o.type,
      reuseCount: o.reuse_count,
      successCount: o.success_count,
      failCount: o.fail_count,
      score: o.score,
      lastUsed: o.last_used,
      updatedAt: o.updated_at,
      status: o.status,
      deprecatedReason: o.deprecated_reason,
    };
  }

  private startAutoSave(): void {
    this.autoSaveTimer = setInterval(() => this.persist(), 60000);
  }

  /** 将数据库持久化到磁盘文件 */
  persist(): void {
    try {
      writeFileSync(this.dbPath, Buffer.from(this.db.export()));
    } catch (err) {
      logger.error('[ExperienceStore] 保存失败', err);
    }
  }

  close(): void {
    if (this.autoSaveTimer) clearInterval(this.autoSaveTimer);
    this.persist();
    this.db.close();
    logger.info('[ExperienceStore] 数据库已关闭');
  }
}

// ─── 单例 ────────────────────────────────────────────────────────────────────

let _instance: ExperienceStore | null = null;

export function getExperienceStore(): ExperienceStore {
  if (!_instance) {
    _instance = new ExperienceStore();
  }
  return _instance;
}

export async function initExperienceStore(): Promise<ExperienceStore> {
  const store = getExperienceStore();
  await store.init();
  return store;
}
