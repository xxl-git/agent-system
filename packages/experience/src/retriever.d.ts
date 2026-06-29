import type { RetrieveOptions, RetrieveResult } from './types';
export declare class ExperienceRetriever {
    private store;
    /**
     * 检索与用户输入最相关的经验
     *
     * @param userInput 用户当前输入
     * @param opts 检索选项
     * @returns Top-K 相关经验（按相关度+评分排序）
     */
    retrieve(userInput: string, opts?: RetrieveOptions): RetrieveResult[];
    /**
     * 将检索结果格式化为可注入的文本块
     */
    formatBlock(results: RetrieveResult[]): string;
    private matchScore;
    private tagMatch;
    private keywordMatch;
    private tokenize;
}
export declare function getExperienceRetriever(): ExperienceRetriever;
//# sourceMappingURL=retriever.d.ts.map