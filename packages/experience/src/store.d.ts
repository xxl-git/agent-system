import type { ExperienceRecord, ExperienceInput, ExperienceOutcome } from './types';
export declare class ExperienceStore {
    private db;
    private SQL;
    private dbPath;
    private mdDir;
    private autoSaveTimer;
    private initialized;
    constructor(dbPath?: string, mdDir?: string);
    init(): Promise<void>;
    private createTables;
    /** 创建一条新经验 */
    save(input: ExperienceInput): number;
    getById(id: number): ExperienceRecord | null;
    getAll(limit?: number): ExperienceRecord[];
    getByTags(tags: string[], limit?: number): ExperienceRecord[];
    search(keyword: string, limit?: number): ExperienceRecord[];
    /** 获取所有活跃经验（用于检索器全量扫描） */
    getActive(): ExperienceRecord[];
    recordUsage(id: number, success: boolean): void;
    deprecate(id: number, reason: string): void;
    /** 硬删除一条经验（含 MD 文件） */
    delete(id: number): boolean;
    /** 更新已有经验内容（保留统计字段 reuseCount/score 等） */
    update(id: number, input: ExperienceInput): boolean;
    computeScore(outcome: ExperienceOutcome, reuseCount: number, successCount: number, lastUsed: string): number;
    /** 批量重新计算评分（定时维护用） */
    recomputeAllScores(): void;
    getStats(): {
        total: number;
        active: number;
        deprecated: number;
        patterns: number;
        pitfalls: number;
        tips: number;
    };
    private writeMdFile;
    private rowsToObjects;
    private rowToObject;
    private startAutoSave;
    /** 将数据库持久化到磁盘文件 */
    persist(): void;
    close(): void;
}
export declare function getExperienceStore(): ExperienceStore;
export declare function initExperienceStore(): Promise<ExperienceStore>;
//# sourceMappingURL=store.d.ts.map