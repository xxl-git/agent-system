import type { ExperienceOutcome, ExtractedExperience, ExperienceType, RetrieveResult } from './types';
export declare class ExperienceExtractor {
    /**
     * 从任务执行中提取经验
     *
     * @param userInput 用户输入
     * @param agentReply Agent 回复
     * @param outcome 结果（成功/失败）
     * @param sessionId 会话 ID
     * @param context 可选上下文（如执行的命令、报错信息等）
     * @returns 经验 ID，提取失败返回 null
     */
    extract(userInput: string, agentReply: string, outcome: ExperienceOutcome, sessionId: string, context?: {
        commands?: string[];
        errors?: string[];
        modelUsed?: string;
        project?: string;
    }): Promise<number | null>;
    /**
     * 用户手动保存经验
     */
    manualSave(scenario: string, problem: string, solution: string, opts?: {
        reasoning?: string;
        tags?: string[];
        type?: ExperienceType;
        outcome?: ExperienceOutcome;
        sessionId?: string;
        project?: string;
    }): Promise<number>;
    /**
     * 精炼用户原始描述 → 结构化经验草稿
     *
     * 用于 /exp add 流程：用户输入原始文字 → LLM 加工为泛化草稿 → 展示给用户确认
     *
     * @param rawText 用户原始描述
     * @param existing 已有经验（编辑模式下传入，作为加工参考）
     * @returns 精炼后的草稿 + 相似经验列表
     */
    refine(rawText: string, existing?: {
        scenario: string;
        problem: string;
        solution: string;
        reasoning: string;
        tags: string[];
        type: string;
        outcome: string;
    }): Promise<{
        draft: ExtractedExperience;
        similar: RetrieveResult[];
    }>;
    private llmRefine;
    private ruleEngineRefine;
    private llmExtract;
    private ruleEngineExtract;
    private extractTags;
    private guessScenario;
}
export declare function getExperienceExtractor(): ExperienceExtractor;
//# sourceMappingURL=extractor.d.ts.map