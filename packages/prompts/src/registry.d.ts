import { LLMTaskType, LLMParams } from './types';
/** 提示词模板 */
export interface PromptTemplate {
    /** 唯一标识，如 'intent.parse'、'agent.identity' */
    id: string;
    /** 语义版本 */
    version: string;
    /** 系统提示词（可含 {{变量}} 占位符） */
    system?: string;
    /** 用户提示词模板（可含 {{变量}} 占位符） */
    user?: string;
    /** 提示词包装策略（模型感知） */
    wrapper?: 'minimal' | 'structured' | 'verbose';
    /** 该模板的默认 LLM 参数（覆盖全局默认） */
    params?: Partial<LLMParams>;
    /** 关联的任务类型（用于自动绑定） */
    taskType?: LLMTaskType;
}
export declare class PromptRegistry {
    private templates;
    constructor();
    /**
     * 注册一个模板（覆盖已有同 id 的模板）
     */
    register(template: PromptTemplate): void;
    /**
     * 获取模板，支持变量插值
     * @param id 模板 ID
     * @param variables 插值变量 { key: value }
     */
    get(id: string, variables?: Record<string, string>): PromptTemplate;
    /**
     * 检查模板是否存在
     */
    has(id: string): boolean;
    /**
     * 列出所有模板 ID
     */
    list(): string[];
    /**
     * 从 config/prompts/ 目录加载 .md 文件（热重载）
     * 文件名即 id（如 intent.parse.md → id='intent.parse'）
     * 文件格式：
     *   ---
     *   version: "1.0.0"
     *   params: { temperature: 0 }
     *   ---
     *   <system prompt 内容>
     */
    loadFromDir(promptsDir: string): void;
    private registerBuiltins;
}
export declare function getPromptRegistry(): PromptRegistry;
/** 从目录初始化（会自动加载内置模板 + 外部文件，外部文件覆盖内置） */
export declare function initPromptRegistry(promptsDir?: string): PromptRegistry;
//# sourceMappingURL=registry.d.ts.map