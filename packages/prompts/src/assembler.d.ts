import { ChatMessage } from './types';
export interface AssembleOptions {
    /** 用于身份的提示词模板 ID（默认 'agent.identity'） */
    identityTemplateId?: string;
    /** 身份模板的插值变量（如 cwd, activeProject, modelName） */
    identityVars?: Record<string, string>;
    /** 跨会话记忆文本（如果有，以 user 角色注入） */
    memoryBlock?: string;
    /** 相关经验文本块（如果有，以 user 角色注入，位于 memory block 之后） */
    experienceBlock?: string;
    /** 当前对话上下文消息（已由 ContextManager 处理过的 messages） */
    context: ChatMessage[];
    /** 可选任务指令（以独立 user 消息放在用户输入之前） */
    taskInstruction?: string;
    /** 当前用户输入（如果 context 末尾已包含则可以省略） */
    userInput?: string;
    /** 提示词包装策略（默认用模板自带的 wrapper） */
    wrapper?: 'minimal' | 'structured' | 'verbose';
}
export interface AssembledPrompt {
    /** 最终消息列表，直接传给 LLM */
    messages: ChatMessage[];
    /** 组装元数据（用于调试面板展示） */
    metadata: AssembledPromptMetadata;
}
export interface AssembledPromptMetadata {
    /** 系统身份提示词长度（字符数） */
    systemIdentityLen: number;
    /** 注入的记忆块长度 */
    memoryBlockLen: number;
    /** 注入的经验块长度 */
    experienceBlockLen: number;
    /** 对话上下文消息数 */
    contextMsgCount: number;
    /** 任务指令长度 */
    taskInstructionLen: number;
    /** 用户输入长度 */
    userInputLen: number;
    /** 总消息数 */
    totalMessages: number;
    /** 是否注入了记忆块 */
    hasMemory: boolean;
    /** 是否注入了经验块 */
    hasExperience: boolean;
    /** 是否含有压缩摘要 */
    hasSummary: boolean;
}
export declare class PromptAssembler {
    /**
     * 组装最终 messages
     *
     * 规则：
     * - System Identity 永远是第一条 system 消息，且只有一条
     * - Memory Block 以 user 角色插入（[历史背景] 标记），不塞进 system
     * - Compressed Summary 以 user 角色插入（[此前对话摘要] 标记）
     * - Task Instruction 放在 user input 之前
     * - User Input 永远是最后一条消息
     */
    assemble(options: AssembleOptions): AssembledPrompt;
    /**
     * 从 context 中提取 system identity 内容
     * 用于向后兼容（旧代码直接传含 system 的 messages）
     */
    extractIdentityFromContext(context: ChatMessage[]): string | undefined;
}
export declare function getPromptAssembler(): PromptAssembler;
//# sourceMappingURL=assembler.d.ts.map