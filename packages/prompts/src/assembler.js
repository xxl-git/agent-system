"use strict";
// PromptAssembler — 提示词组装器
// Phase 3: 按语义层次组装最终发给 LLM 的 messages
//
// 组装顺序（固定）：
//   1. System Identity  — Agent 身份和全局约束（只放在 system 角色）
//   2. Memory Block     — 跨会话记忆，以 user 角色注入（不污染 system）
//   3. Experience Block — 相关经验，以 user 角色注入（条件性，有匹配才注入）
//   4. Conversation Context / Summary — 对话历史（含压缩摘要标记）
//   5. Task Instruction — 任务指令（可选，放在用户输入之前）
//   6. User Input       — 当前用户输入（永远最后一条 user 消息）
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptAssembler = void 0;
exports.getPromptAssembler = getPromptAssembler;
const registry_1 = require("./registry");
const logger_1 = require("./logger");
// ─── PromptAssembler ─────────────────────────────────────────────────────────
class PromptAssembler {
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
    assemble(options) {
        const { identityTemplateId = 'agent.identity', identityVars, memoryBlock, experienceBlock, context, taskInstruction, userInput, } = options;
        const messages = [];
        const meta = {
            systemIdentityLen: 0,
            memoryBlockLen: 0,
            experienceBlockLen: 0,
            contextMsgCount: 0,
            taskInstructionLen: 0,
            userInputLen: 0,
            totalMessages: 0,
            hasMemory: false,
            hasExperience: false,
            hasSummary: false,
        };
        // ── Step 1: System Identity ───────────────────────────────────────────────
        const registry = (0, registry_1.getPromptRegistry)();
        const identityTpl = registry.get(identityTemplateId, identityVars);
        const identityContent = identityTpl.system || 'You are an intelligent Agent assistant.';
        messages.push({ role: 'system', content: identityContent });
        meta.systemIdentityLen = identityContent.length;
        // ── Step 2: Memory Block（以 user 角色，不污染 system）────────────────────
        if (memoryBlock && memoryBlock.trim()) {
            const memTpl = registry.get('agent.memory', { memoryBlock: memoryBlock.trim() });
            const memContent = memTpl.user || `[历史背景]\n${memoryBlock.trim()}`;
            messages.push({ role: 'user', content: memContent });
            // 配对一个简短 assistant 确认（保持对话结构）
            messages.push({ role: 'assistant', content: '好的，我已了解历史背景。' });
            meta.memoryBlockLen = memoryBlock.length;
            meta.hasMemory = true;
        }
        // ── Step 2.5: Experience Block（以 user 角色，条件性注入）─────────────────
        if (experienceBlock && experienceBlock.trim()) {
            messages.push({ role: 'user', content: experienceBlock.trim() });
            messages.push({ role: 'assistant', content: '好的，我已了解相关经验。' });
            meta.experienceBlockLen = experienceBlock.length;
            meta.hasExperience = true;
        }
        // ── Step 3: Conversation Context ─────────────────────────────────────────
        // context 中可能含有压缩摘要标记（来自 ContextManager）
        // 过滤掉 context 里已有的 system 消息（避免重复 identity）
        // 识别摘要块：检查 content 是否含有摘要标记
        const filteredContext = context.filter(m => {
            // 跳过 system 消息（identity 已在 Step 1 添加）
            if (m.role === 'system')
                return false;
            return true;
        });
        for (const msg of filteredContext) {
            // 检查是否是压缩摘要消息（ContextManager 输出的摘要格式）
            if (msg.role === 'user' && isSummaryMessage(msg.content)) {
                meta.hasSummary = true;
                // 用 summary-block 模板包装（如果还没被包装过）
                if (!msg.content.includes('[此前对话摘要]')) {
                    const summaryContent = registry.get('context.summary-block', {
                        summary: msg.content,
                    }).user || msg.content;
                    messages.push({ role: msg.role, content: summaryContent });
                }
                else {
                    messages.push(msg);
                }
            }
            else {
                messages.push(msg);
            }
        }
        meta.contextMsgCount = filteredContext.length;
        // ── Step 4: Task Instruction（可选）──────────────────────────────────────
        if (taskInstruction && taskInstruction.trim()) {
            messages.push({ role: 'user', content: taskInstruction.trim() });
            messages.push({ role: 'assistant', content: '明白，我会按照上述要求执行。' });
            meta.taskInstructionLen = taskInstruction.length;
        }
        // ── Step 5: User Input（如果不在 context 末尾则追加）─────────────────────
        if (userInput && userInput.trim()) {
            // 检查 context 最后一条是否已经是这个 userInput
            const lastMsg = messages[messages.length - 1];
            if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== userInput.trim()) {
                messages.push({ role: 'user', content: userInput.trim() });
            }
            meta.userInputLen = userInput.length;
        }
        meta.totalMessages = messages.length;
        logger_1.logger.debug(`[PromptAssembler] 组装完成: ${meta.totalMessages} 条消息` +
            ` (identity=${meta.systemIdentityLen}c, memory=${meta.memoryBlockLen}c` +
            `, experience=${meta.experienceBlockLen}c` +
            `, ctx=${meta.contextMsgCount}, hasMemory=${meta.hasMemory}` +
            `, hasExperience=${meta.hasExperience}, hasSummary=${meta.hasSummary})`);
        return { messages, metadata: meta };
    }
    /**
     * 从 context 中提取 system identity 内容
     * 用于向后兼容（旧代码直接传含 system 的 messages）
     */
    extractIdentityFromContext(context) {
        const systemMsg = context.find(m => m.role === 'system');
        return systemMsg?.content;
    }
}
exports.PromptAssembler = PromptAssembler;
// ─── 工具函数 ────────────────────────────────────────────────────────────────
/**
 * 判断是否是压缩摘要消息（ContextManager 输出的格式）
 */
function isSummaryMessage(content) {
    return (content.includes('[SUMMARY]') ||
        content.includes('[此前对话摘要]') ||
        content.includes('[Conversation Summary]') ||
        content.includes('===压缩摘要===') ||
        // ContextManager 生成的摘要通常以特定前缀开头
        /^\s*\[.*摘要.*\]/.test(content));
}
// ─── 单例 ────────────────────────────────────────────────────────────────────
let _instance = null;
function getPromptAssembler() {
    if (!_instance) {
        _instance = new PromptAssembler();
    }
    return _instance;
}
//# sourceMappingURL=assembler.js.map