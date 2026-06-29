"use strict";
// ExperienceStore — 经验存储层
// SQLite (data/experiences.db) + MD 文件 (data/experiences/) 双层存储
// 复用 sql.js 技术栈，与 db-store.ts 模式一致
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExperienceStore = void 0;
exports.getExperienceStore = getExperienceStore;
exports.initExperienceStore = initExperienceStore;
const sql_js_1 = __importDefault(require("sql.js"));
const fs_1 = require("fs");
const path = __importStar(require("path"));
const logger_1 = __importDefault(require("../logger"));
// ─── ExperienceStore ──────────────────────────────────────────────────────────
class ExperienceStore {
    db;
    SQL;
    dbPath;
    mdDir;
    autoSaveTimer = null;
    initialized = false;
    constructor(dbPath, mdDir) {
        this.dbPath = dbPath || path.join(process.cwd(), 'data', 'experiences.db');
        this.mdDir = mdDir || path.join(process.cwd(), 'data', 'experiences');
    }
    async init() {
        if (this.initialized)
            return;
        this.SQL = await (0, sql_js_1.default)();
        const dir = path.dirname(this.dbPath);
        if (!(0, fs_1.existsSync)(dir))
            (0, fs_1.mkdirSync)(dir, { recursive: true });
        if (!(0, fs_1.existsSync)(this.mdDir))
            (0, fs_1.mkdirSync)(this.mdDir, { recursive: true });
        if ((0, fs_1.existsSync)(this.dbPath)) {
            this.db = new this.SQL.Database((0, fs_1.readFileSync)(this.dbPath));
            logger_1.default.info(`[ExperienceStore] 已加载数据库: ${this.dbPath}`);
        }
        else {
            this.db = new this.SQL.Database();
            logger_1.default.info('[ExperienceStore] 已创建新数据库');
        }
        this.createTables();
        this.startAutoSave();
        this.initialized = true;
    }
    createTables() {
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
    save(input) {
        const now = new Date().toISOString();
        const outcome = input.outcome;
        const baseScore = outcome === 'success' ? 1.0 : 0.8;
        this.db.run(`INSERT INTO experiences
        (created_at, session_id, source, scenario, tags, project, model_used,
         problem, solution, reasoning, code_snippet, outcome, type,
         reuse_count, success_count, fail_count, score,
         last_used, updated_at, status, deprecated_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, '', ?, 'active', '')`, [
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
        ]);
        const id = Number(this.db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
        // 写 MD 文件（人类可读）
        this.writeMdFile(id, input, now);
        logger_1.default.info(`[ExperienceStore] 保存经验 #${id}: ${input.scenario} (${input.type}/${outcome})`);
        this.persist();
        return id;
    }
    // ─── 查询 ──────────────────────────────────────────────────────────────────
    getById(id) {
        const rows = this.db.exec('SELECT * FROM experiences WHERE id = ?', [id]);
        if (rows.length === 0 || rows[0].values.length === 0)
            return null;
        return this.rowToObject(rows[0].columns, rows[0].values[0]);
    }
    getAll(limit = 100) {
        const rows = this.db.exec('SELECT * FROM experiences ORDER BY score DESC, created_at DESC LIMIT ?', [limit]);
        return this.rowsToObjects(rows);
    }
    getByTags(tags, limit = 10) {
        const conditions = tags.map(() => 'tags LIKE ?').join(' OR ');
        const params = tags.map(t => `%"${t}"%`);
        const rows = this.db.exec(`SELECT * FROM experiences WHERE (${conditions}) AND status = 'active' ORDER BY score DESC LIMIT ?`, [...params, limit]);
        return this.rowsToObjects(rows);
    }
    search(keyword, limit = 10) {
        const pattern = `%${keyword}%`;
        const rows = this.db.exec(`SELECT * FROM experiences
       WHERE (scenario LIKE ? OR problem LIKE ? OR solution LIKE ? OR tags LIKE ?)
       AND status = 'active'
       ORDER BY score DESC LIMIT ?`, [pattern, pattern, pattern, pattern, limit]);
        return this.rowsToObjects(rows);
    }
    /** 获取所有活跃经验（用于检索器全量扫描） */
    getActive() {
        const rows = this.db.exec(`SELECT * FROM experiences WHERE status = 'active' ORDER BY score DESC`);
        return this.rowsToObjects(rows);
    }
    // ─── 更新 ──────────────────────────────────────────────────────────────────
    recordUsage(id, success) {
        const now = new Date().toISOString();
        const rec = this.getById(id);
        if (!rec)
            return;
        const newReuse = rec.reuseCount + 1;
        const newSuccess = rec.successCount + (success ? 1 : 0);
        const newFail = rec.failCount + (success ? 0 : 1);
        const newScore = this.computeScore(rec.outcome, newReuse, newSuccess, now);
        this.db.run(`UPDATE experiences SET reuse_count = ?, success_count = ?, fail_count = ?, score = ?, last_used = ?, updated_at = ? WHERE id = ?`, [newReuse, newSuccess, newFail, newScore, now, now, id]);
        logger_1.default.debug(`[ExperienceStore] 经验 #${id} 使用记录: reuse=${newReuse} success=${newSuccess} score=${newScore.toFixed(3)}`);
        this.persist();
    }
    deprecate(id, reason) {
        const now = new Date().toISOString();
        this.db.run(`UPDATE experiences SET status = 'deprecated', deprecated_reason = ?, updated_at = ? WHERE id = ?`, [reason, now, id]);
        logger_1.default.info(`[ExperienceStore] 经验 #${id} 已废弃: ${reason}`);
        this.persist();
    }
    /** 硬删除一条经验（含 MD 文件） */
    delete(id) {
        const rec = this.getById(id);
        if (!rec)
            return false;
        this.db.run('DELETE FROM experiences WHERE id = ?', [id]);
        // 清理 MD 文件
        const filename = `exp_${String(id).padStart(3, '0')}.md`;
        const filepath = path.join(this.mdDir, filename);
        try {
            if ((0, fs_1.existsSync)(filepath)) {
                (0, fs_1.unlinkSync)(filepath);
            }
        }
        catch (err) {
            logger_1.default.warn(`[ExperienceStore] 删除 MD 文件失败: ${filepath}`, err);
        }
        logger_1.default.info(`[ExperienceStore] 经验 #${id} 已删除: ${rec.scenario}`);
        this.persist();
        return true;
    }
    /** 更新已有经验内容（保留统计字段 reuseCount/score 等） */
    update(id, input) {
        const existing = this.getById(id);
        if (!existing)
            return false;
        const now = new Date().toISOString();
        // outcome 变了要重算 baseScore，但保留 reuseCount/successCount/failCount
        const baseScore = input.outcome === 'success' ? 1.0 : 0.8;
        const newScore = this.computeScore(input.outcome, existing.reuseCount, existing.successCount, existing.lastUsed || now);
        this.db.run(`UPDATE experiences SET
        scenario = ?, tags = ?, project = ?, model_used = ?,
        problem = ?, solution = ?, reasoning = ?, code_snippet = ?,
        outcome = ?, type = ?, score = ?, updated_at = ?, source = ?
       WHERE id = ?`, [
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
        ]);
        // 重写 MD 文件
        this.writeMdFile(id, input, existing.createdAt);
        logger_1.default.info(`[ExperienceStore] 经验 #${id} 已更新: ${input.scenario}`);
        this.persist();
        return true;
    }
    // ─── 评分 ──────────────────────────────────────────────────────────────────
    computeScore(outcome, reuseCount, successCount, lastUsed) {
        const baseScore = outcome === 'success' ? 1.0 : 0.8;
        const successRate = reuseCount === 0 ? 1.0 : successCount / reuseCount;
        // 时间衰减
        let decay = 0.4;
        if (lastUsed) {
            const daysSince = (Date.now() - new Date(lastUsed).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince <= 30)
                decay = 1.0;
            else if (daysSince <= 90)
                decay = 0.7;
        }
        const score = baseScore * decay * (0.3 + 0.7 * successRate);
        return Math.max(0, Math.min(1, score));
    }
    /** 批量重新计算评分（定时维护用） */
    recomputeAllScores() {
        const all = this.getAll(10000);
        const now = new Date().toISOString();
        let updated = 0;
        for (const rec of all) {
            if (!rec.id)
                continue;
            const newScore = this.computeScore(rec.outcome, rec.reuseCount, rec.successCount, rec.lastUsed);
            if (Math.abs(newScore - rec.score) > 0.01) {
                this.db.run('UPDATE experiences SET score = ?, updated_at = ? WHERE id = ?', [newScore, now, rec.id]);
                updated++;
            }
        }
        if (updated > 0) {
            logger_1.default.info(`[ExperienceStore] 评分维护: 更新了 ${updated} 条经验的评分`);
            this.persist();
        }
    }
    // ─── 统计 ──────────────────────────────────────────────────────────────────
    getStats() {
        const total = this.db.exec('SELECT COUNT(*) FROM experiences');
        const active = this.db.exec("SELECT COUNT(*) FROM experiences WHERE status = 'active'");
        const deprecated = this.db.exec("SELECT COUNT(*) FROM experiences WHERE status = 'deprecated'");
        const patterns = this.db.exec("SELECT COUNT(*) FROM experiences WHERE type = 'pattern'");
        const pitfalls = this.db.exec("SELECT COUNT(*) FROM experiences WHERE type = 'pitfall'");
        const tips = this.db.exec("SELECT COUNT(*) FROM experiences WHERE type = 'tip'");
        const val = (r) => r.length > 0 ? Number(r[0].values[0][0]) : 0;
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
    writeMdFile(id, input, createdAt) {
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
        (0, fs_1.writeFileSync)(filepath, content, 'utf-8');
    }
    rowsToObjects(rows) {
        if (rows.length === 0)
            return [];
        return rows[0].values.map(row => this.rowToObject(rows[0].columns, row));
    }
    rowToObject(columns, vals) {
        const o = {};
        columns.forEach((c, i) => { o[c] = vals[i]; });
        let tags = [];
        try {
            tags = JSON.parse(o.tags || '[]');
        }
        catch {
            tags = [];
        }
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
    startAutoSave() {
        this.autoSaveTimer = setInterval(() => this.persist(), 60000);
    }
    /** 将数据库持久化到磁盘文件 */
    persist() {
        try {
            (0, fs_1.writeFileSync)(this.dbPath, Buffer.from(this.db.export()));
        }
        catch (err) {
            logger_1.default.error('[ExperienceStore] 保存失败', err);
        }
    }
    close() {
        if (this.autoSaveTimer)
            clearInterval(this.autoSaveTimer);
        this.persist();
        this.db.close();
        logger_1.default.info('[ExperienceStore] 数据库已关闭');
    }
}
exports.ExperienceStore = ExperienceStore;
// ─── 单例 ────────────────────────────────────────────────────────────────────
let _instance = null;
function getExperienceStore() {
    if (!_instance) {
        _instance = new ExperienceStore();
    }
    return _instance;
}
async function initExperienceStore() {
    const store = getExperienceStore();
    await store.init();
    return store;
}
//# sourceMappingURL=store.js.map