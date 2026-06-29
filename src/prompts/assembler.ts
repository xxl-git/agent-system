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

import type { ChatMessage } from '../models/adapters/lmstudio';
import { getPromptRegistry } from './registry';
import logger from '../logger';

// ─── 类型定义 ───────────────────────────────────────────────────────────────

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

// ─── PromptAssembler ─────────────────────────────────────────────────────────

export class PromptAssembler {
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
  assemble(options: AssembleOptions): AssembledPrompt {
    const {
      identityTemplateId = 'agent.identity',
      identityVars,
      memoryBlock,
      experienceBlock,
      context,
      taskInstruction,
      userInput,
    } = options;

    const messages: ChatMessage[] = [];
    const meta: AssembledPromptMetadata = {
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
    const registry = getPromptRegistry();
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
      if (m.role === 'system') return false;
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
        } else {
          messages.push(msg);
        }
      } else {
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

    logger.debug(
      `[PromptAssembler] 组装完成: ${meta.totalMessages} 条消息` +
      ` (identity=${meta.systemIdentityLen}c, memory=${meta.memoryBlockLen}c` +
      `, experience=${meta.experienceBlockLen}c` +
      `, ctx=${meta.contextMsgCount}, hasMemory=${meta.hasMemory}` +
      `, hasExperience=${meta.hasExperience}, hasSummary=${meta.hasSummary})`,
    );

    return { messages, metadata: meta };
  }

  /**
   * 从 context 中提取 system identity 内容
   * 用于向后兼容（旧代码直接传含 system 的 messages）
   */
  extractIdentityFromContext(context: ChatMessage[]): string | undefined {
    const systemMsg = context.find(m => m.role === 'system');
    return systemMsg?.content;
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 判断是否是压缩摘要消息（ContextManager 输出的格式）
 */
function isSummaryMessage(content: string): boolean {
  return (
    content.includes('[SUMMARY]') ||
    content.includes('[此前对话摘要]') ||
    content.includes('[Conversation Summary]') ||
    content.includes('===压缩摘要===') ||
    // ContextManager 生成的摘要通常以特定前缀开头
    /^\s*\[.*摘要.*\]/.test(content)
  );
}

// ─── 单例 ────────────────────────────────────────────────────────────────────

let _instance: PromptAssembler | null = null;

export function getPromptAssembler(): PromptAssembler {
  if (!_instance) {
    _instance = new PromptAssembler();
  }
  return _instance;
}
