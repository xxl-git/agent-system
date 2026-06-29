/** 经验来源 */
export type ExperienceSource = 'auto' | 'user' | 'feedback';
/** 经验结果 */
export type ExperienceOutcome = 'success' | 'failure';
/** 经验类型 */
export type ExperienceType = 'pattern' | 'pitfall' | 'tip';
/** 经验状态 */
export type ExperienceStatus = 'active' | 'deprecated';
/** 一条经验记录 */
export interface ExperienceRecord {
    id?: number;
    createdAt: string;
    sessionId: string;
    source: ExperienceSource;
    scenario: string;
    tags: string[];
    project: string;
    modelUsed: string;
    problem: string;
    solution: string;
    reasoning: string;
    codeSnippet: string;
    outcome: ExperienceOutcome;
    type: ExperienceType;
    reuseCount: number;
    successCount: number;
    failCount: number;
    score: number;
    lastUsed: string;
    updatedAt: string;
    status: ExperienceStatus;
    deprecatedReason: string;
}
/** 创建经验的输入（不含自动生成的字段） */
export interface ExperienceInput {
    scenario: string;
    problem: string;
    solution: string;
    reasoning?: string;
    codeSnippet?: string;
    tags?: string[];
    outcome: ExperienceOutcome;
    type: ExperienceType;
    source?: ExperienceSource;
    sessionId?: string;
    project?: string;
    modelUsed?: string;
}
/** 检索选项 */
export interface RetrieveOptions {
    /** 返回的最大条数 */
    topK?: number;
    /** 只返回这些标签匹配的经验 */
    filterTags?: string[];
    /** 只返回活跃状态的经验 */
    activeOnly?: boolean;
}
/** 检索结果 */
export interface RetrieveResult {
    record: ExperienceRecord;
    /** 匹配原因（用于调试） */
    matchReason: string;
    /** 匹配分数（0-1） */
    matchScore: number;
}
/** LLM 提取的原始结构 */
export interface ExtractedExperience {
    scenario: string;
    problem: string;
    solution: string;
    reasoning: string;
    tags: string[];
    type: ExperienceType;
}
//# sourceMappingURL=types.d.ts.map