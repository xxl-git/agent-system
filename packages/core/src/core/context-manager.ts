/**
 * ContextManager — 无上限上下文
 * 
 * 当消息超过 token 预算时，自动执行：
 * 1. 热点评分（注意力机制）：对每条消息按相关性/时效性/重要性打分
 * 2. 保留热点消息 + 压缩旧内容为摘要
 * 3. 发送给模型的是：「摘要 + 热点消息 + 当前问题」
 * 4. 新会话无缝衔接，真正无上下文长度限制
 */

import type { ChatMessage } from '../models/adapters/lmstudio';
import logger from '../logger';
import { getPromptRegistry } from '@agent-system/prompts';

// ═════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════

export interface ContextConfig {
  /** 每次调用模型的 token 预算（超限触发压缩），默认 4000 */
  maxTokens: number;
  /** 保留的热点消息数（最近的 + 高相关的），默认 12 */
  hotWindowSize: number;
  /** 摘要文本的 token 预算，默认 512 */
  summaryTokenBudget: number;
  /** 触发压缩的阈值百分比 (0~1)，默认 0.75 */
  compressionThreshold: number;
  /** 是否始终保留工具调用结果 */
  preserveToolResults: boolean;
  /** 是否始终保留系统消息 */
  preserveSystem: boolean;
  /** 是否启用注意力评分（热点内容提取） */
  attentionEnabled: boolean;
}

export interface CompressedBlock {
  id: string;
  /** 压缩后的摘要文本 */
  summary: string;
  /** 讨论的主题标签 */
  topics: string[];
  /** 做出的决策/结论 */
  decisions: string[];
  /** 涉及的实体/人/工具 */
  entities: string[];
  /** 摘要本身的 token 估算 */
  tokenCount: number;
  /** 压缩前的原始 token 数 */
  originalTokenCount: number;
  /** 包含的消息数 */
  messageCount: number;
  /** 创建时间戳 */
  timestamp: number;
  /** 压缩块的类型标记 */
  blockType: 'summary' | 'decisions' | 'tools';
}

export interface HotMessage {
  message: ChatMessage;
  score: number;
  reasons: string[];
}

export interface ProcessedContext {
  /** 最终发送给模型的消息列表 */
  messages: ChatMessage[];
  /** 是否发生了压缩 */
  compressed: boolean;
  /** 最新摘要文本 */
  summary: string | null;
  /** 保留的热点消息数 */
  hotCount: number;
  /** 所有压缩块的历史 */
  compressedBlocks: CompressedBlock[];
  /** 原始 token 估算 */
  originalTokens: number;
  /** 最终 token 估算 */
  finalTokens: number;
  /** 压缩率 */
  compressionRatio: number;
  /** 当前上下文层级（第几轮压缩） */
  compressionLevel: number;
  /** ⚠️ 会话边界标记：压缩后应开启新会话 */
  sessionReset: boolean;
}

// ═════════════════════════════════════════════════
// Default Config
// ═════════════════════════════════════════════════

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxTokens: 4000,
  hotWindowSize: 12,
  summaryTokenBudget: 512,
  compressionThreshold: 0.75,
  preserveToolResults: true,
  preserveSystem: true,
  attentionEnabled: true,
};

// ═════════════════════════════════════════════════
// Token Estimator (rough but fast)
// ═════════════════════════════════════════════════

export function estimateTokens(text: string): number {
    if (!text) return 0;
    let cjk = 0, ascii = 0, other = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0x4E00 && code <= 0x9FFF) cjk++;
        else if (code <= 0x7F) ascii++;
        else other++;
    }
    return Math.ceil(cjk * 1.5 + ascii * 0.25 + other * 0.5);
}

function estimateMessagesTokens(msgs: ChatMessage[]): number {
  return msgs.reduce((sum, m) => {
    const roleCost = 4; // role overhead tokens
    const content = m.content || '';
    return sum + estimateTokens(content) + roleCost;
  }, 0);
}

// ═════════════════════════════════════════════════
// Attention-based Hot Content Scoring
// ═════════════════════════════════════════════════

/**
 * 提取关键词（简单 TF 过滤停用词）
 */
export function extractKeywords(text: string): Set<string> {
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
    '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去',
    '你', '会', '着', '没有', '看', '好', '自己', '这', '他', '她',
    '它', '们', '那', '些', '能', '为', '吗', '吧', '啊', '呢',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'shall',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'this', 'that', 'these', 'those', 'it', 'its', 'and', 'or',
    'but', 'not', 'no', 'yes', 'if', 'then', 'else', 'so',
  ]);

  // 只保留中英文词/数字
  const tokens = text.toLowerCase().match(/[\w\u4e00-\u9fff]+/g) || [];
  const freq = new Map<string, number>();
  
  for (const t of tokens) {
    if (t.length < 2 && !/[\u4e00-\u9fff]/.test(t)) continue;
    if (stopWords.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }

  // 按频率取 Top 20
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(e => e[0]);

  return new Set(sorted);
}

/**
 * 计算关键词匹配得分
 */
export function keywordMatchScore(text: string, keywords: Set<string>): number {
  if (keywords.size === 0) return 0;
  const lower = text.toLowerCase();
  let matches = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) matches++;
  }
  return matches / keywords.size;
}

/**
 * 注意力评分：对消息按相关性打分
 * 
 * 评分因子：
 *   - 时效性 (recencyWeight)：最新的消息权重最高，指数衰减
 *   - 语义相关 (keywordWeight)：与当前问题关键词匹配度
 *   - 角色权重 (roleWeight)：工具结果 > agent 重要回复 > 用户 > 系统
 *   - 实体价值 (entityWeight)：包含决策/结果的消息权重更高
 */
function scoreMessage(
  msg: ChatMessage,
  index: number,
  totalMessages: number,
  keywords: Set<string>,
  preserveTool: boolean,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const content = msg.content || '';

  // 1. 时效性 — 指数衰减，最新的 6 条权重最高
  const recencyPos = totalMessages - index; // 1 = oldest, total = newest
  // 相对位置: 从后往前，最后一条 = 1.0
  const relativePos = (recencyPos) / Math.max(totalMessages, 1);
  // 指数衰减: 最近的 30% 消息得高分
  const recencyScore = Math.pow(relativePos, 0.4);
  score += recencyScore * 0.35;
  if (recencyScore > 0.8) reasons.push('时效性高');
  if (recencyScore > 0.95) reasons.push('最新消息');

  // 2. 角色权重
  switch (msg.role) {
    case 'assistant': {
      // Agent 回复 — 包含决策/代码/结构化内容更值钱
      const hasCode = /```[\s\S]*```/.test(content);
      const hasDecision = /决定|选择|使用|采用|方案|方案|建议|推荐/i.test(content);
      const hasList = /^[-*\d]/.test(content.trim());
      const assistantScore = hasCode ? 0.9 : hasDecision ? 0.8 : hasList ? 0.6 : 0.4;
      score += assistantScore * 0.20;
      if (hasCode) reasons.push('含代码');
      if (hasDecision) reasons.push('含决策');
      break;
    }
    case 'user': {
      // 用户消息 — 长的/带具体信息的更重要
      const detailScore = content.length > 100 ? 0.7 : content.length > 30 ? 0.5 : 0.3;
      score += detailScore * 0.20;
      break;
    }
    case 'system':
      score += 0.10 * 0.20;
      break;
  }

  // 3. 关键词相关性匹配（注意力机制核心）
  const kwScore = keywordMatchScore(content, keywords);
  score += kwScore * 0.30;
  if (kwScore > 0.3) reasons.push('关键词命中');
  if (kwScore > 0.6) reasons.push('高度相关');

  // 4. 内容密度得分 — 信息量大的消息更有价值
  const densityScore = Math.min(content.length / 200, 1.0) * 0.15;
  score += densityScore;

  return { score: Math.min(score, 1.0), reasons };
}

/**
 * 生成压缩提示语
 */
export function buildCompressionPrompt(msgs: ChatMessage[]): string {
  const lines = msgs.map((m, i) => {
    const roleTag = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统';
    return `[${roleTag}] ${m.content}`;
  });
  const conversationHistory = lines.join('\n');

  // 使用 PromptRegistry 模板（如果可用），否则回退到硬编码
  try {
    const registry = getPromptRegistry();
    const tpl = registry.get('context.summarize', { conversationHistory });
    if (tpl.system && tpl.system.includes('对话历史')) {
      return tpl.system;
    }
  } catch {
    // registry 不可用时回退
  }

  // 兜底：直接拼接
  return `请压缩以下对话历史为精炼摘要（中文，200字以内），并提取关键信息。

对话历史：
${conversationHistory}

输出格式（不要加多余内容）：
摘要：<精炼摘要>
主题：<主题1>, <主题2>
决策：<决策1> | <决策2>
实体：<实体1>, <实体2>`;
}

/**
 * 解析压缩结果
 */
export function parseCompressionOutput(text: string): { summary: string; topics: string[]; decisions: string[]; entities: string[] } {
  let summary = '';
  const topics: string[] = [];
  const decisions: string[] = [];
  const entities: string[] = [];

  // 尝试按格式解析
  const sumMatch = text.match(/摘要[：:]\s*(.+?)(?:\n|$)/);
  if (sumMatch) summary = sumMatch[1].trim();

  const topicMatch = text.match(/主题[：:]\s*(.+?)(?:\n|$)/);
  if (topicMatch) {
    topics.push(...topicMatch[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean));
  }

  const decisionMatch = text.match(/决策[：:]\s*(.+?)(?:\n|$)/);
  if (decisionMatch) {
    decisions.push(...decisionMatch[1].split(/[|│]\s*/).map(s => s.trim()).filter(Boolean));
  }

  const entityMatch = text.match(/实体[：:]\s*(.+?)$/);
  if (entityMatch) {
    entities.push(...entityMatch[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean));
  }

  // 如果格式解析失败，全文当摘要
  if (!summary) {
    summary = text.replace(/^(主题|决策|实体)[：:].+$/gm, '').trim() || text.slice(0, 500);
  }

  return { summary, topics, decisions, entities };
}

// ═════════════════════════════════════════════════
// ContextManager
// ═════════════════════════════════════════════════

export class ContextManager {
  private config: ContextConfig;
  /** 累积的压缩块历史 */
  private compressedBlocks: CompressedBlock[] = [];
  /** 当前压缩层级 */
  private compressionLevel = 0;
  /** 所有压缩生成的摘要串联 */
  private accumulatedSummary = '';
  /** 压缩计数器 */
  private compressionCount = 0;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };
  }

  /** 更新配置 */
  updateConfig(config: Partial<ContextConfig>) {
    this.config = { ...this.config, ...config };
  }

  /** 获取当前配置 */
  getConfig(): ContextConfig {
    return { ...this.config };
  }

  /** 获取统计 */
  getStats() {
    return {
      compressionLevel: this.compressionLevel,
      compressionCount: this.compressionCount,
      compressedBlocks: this.compressedBlocks.length,
      accumulatedSummary: estimateTokens(this.accumulatedSummary),
      attentionEnabled: this.config.attentionEnabled,
      lastHotCount: 0,
      config: this.config,
    };
  }

  /** 重置（开始全新会话时调用） */
  reset() {
    this.compressedBlocks = [];
    this.compressionLevel = 0;
    this.accumulatedSummary = '';
    this.compressionCount = 0;
  }

  /**
   * 处理上下文 — 核心入口
   * 
   * @param messages 当前全部消息
   * @param currentQuery 用户当前问题（用于热点匹配）
   * @param summarizer 摘要函数（调用模型进行压缩）
   * @returns 处理后待发送的上下文
   */
  async process(
    messages: ChatMessage[],
    currentQuery: string,
    summarizer: (prompt: string) => Promise<string>,
  ): Promise<ProcessedContext> {
    if (!messages.length) {
      return {
        messages: [],
        compressed: false,
        summary: null,
        hotCount: 0,
        compressedBlocks: [],
        originalTokens: 0,
        finalTokens: 0,
        compressionRatio: 1,
        compressionLevel: this.compressionLevel,
        sessionReset: false,
      };
    }

    const originalTokens = estimateMessagesTokens(messages);
    const maxTokens = this.config.maxTokens;
    const threshold = maxTokens * this.config.compressionThreshold;

    // 未超限 — 直接返回原始消息
    if (originalTokens <= threshold) {
      return {
        messages: [...messages],
        compressed: false,
        summary: this.accumulatedSummary || null,
        hotCount: 0,
        compressedBlocks: [...this.compressedBlocks],
        originalTokens,
        finalTokens: originalTokens,
        compressionRatio: 1,
        compressionLevel: this.compressionLevel,
        sessionReset: false,
      };
    }

    // ═══ 超限 — 执行压缩 ═══
    this.compressionCount++;
    logger.info(`[Context] 压缩触发 #${this.compressionCount}: ${originalTokens} tokens > ${maxTokens} (阈值: ${threshold}) — 会话边界`);

    // 提取系统消息（始终保留）
    const systemMsgs = this.config.preserveSystem
      ? messages.filter(m => m.role === 'system')
      : [];

    // 非系统消息
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    // 如果 attention 关闭：简单保留最后 N 条 + 压缩前面的
    if (!this.config.attentionEnabled) {
      return this._simpleTruncate(messages, systemMsgs, maxTokens, originalTokens);
    }

    // ═══ 注意力评分：热点内容提取 ═══
    const keywords = extractKeywords(currentQuery);
    const scored: { msg: ChatMessage; score: number; reasons: string[]; index: number }[] =
      nonSystemMsgs.map((msg, idx) => {
        const result = scoreMessage(msg, idx, nonSystemMsgs.length, keywords, this.config.preserveToolResults);
        return { msg, ...result, index: idx };
      });

    // 按得分降序排列
    scored.sort((a, b) => b.score - a.score);

    // 取 Top N 作为热点消息（按原始顺序）
    const hotSelected = new Set(
      scored.slice(0, this.config.hotWindowSize).map(s => s.index),
    );
    const hotMessages = nonSystemMsgs.filter((_, idx) => hotSelected.has(idx));

    // 需要压缩的消息 = 非热点
    const compressables = nonSystemMsgs.filter((_, idx) => !hotSelected.has(idx));

    // 生成摘要
    let block: CompressedBlock;
    try {
      const compressedText = await summarizer(buildCompressionPrompt(compressables));
      const parsed = parseCompressionOutput(compressedText);
      block = {
        id: `block_${Date.now()}_${this.compressionCount}`,
        summary: parsed.summary,
        topics: parsed.topics,
        decisions: parsed.decisions,
        entities: parsed.entities,
        tokenCount: estimateTokens(parsed.summary),
        originalTokenCount: estimateMessagesTokens(compressables),
        messageCount: compressables.length,
        timestamp: Date.now(),
        blockType: 'summary',
      };
    } catch (err) {
      // 摘要失败时，用简单摘要兜底
      const fallbackSummary = this._fallbackSummary(compressables);
      block = {
        id: `block_${Date.now()}_${this.compressionCount}`,
        summary: fallbackSummary,
        topics: [],
        decisions: [],
        entities: [],
        tokenCount: estimateTokens(fallbackSummary),
        originalTokenCount: estimateMessagesTokens(compressables),
        messageCount: compressables.length,
        timestamp: Date.now(),
        blockType: 'summary',
      };
      logger.warn('[Context] 压缩失败，使用兜底摘要: ' + err);
    }

    // 记录压缩块
    this.compressedBlocks.push(block);
    this.compressionLevel++;

    // 累积摘要
    const newSummary = `[此前对话摘要 #${this.compressionCount}] ${block.summary}`;
    this.accumulatedSummary = this.accumulatedSummary
      ? this.accumulatedSummary + '\n' + newSummary
      : newSummary;

    // 如果累积摘要也超预算了，只保留最近的热点消息
    const summaryTokens = estimateTokens(this.accumulatedSummary);
    if (summaryTokens > this.config.summaryTokenBudget) {
      // 只保留最近的几条
      const recentMsgs = nonSystemMsgs.slice(-Math.min(this.config.hotWindowSize, 6));
      const reassembled = [
        ...systemMsgs,
        { role: 'user', content: `[对话历史摘要]\n${this.accumulatedSummary}` } as ChatMessage,
        ...recentMsgs,
      ];
      const finalTokens = estimateMessagesTokens(reassembled);

      logger.info(`[Context] 摘要也超预算(${summaryTokens}), 只保留最近 ${recentMsgs.length} 条`);
      return {
        messages: reassembled,
        compressed: true,
        summary: this.accumulatedSummary,
        hotCount: recentMsgs.length,
        compressedBlocks: [...this.compressedBlocks],
        originalTokens,
        finalTokens,
        compressionRatio: finalTokens / Math.max(originalTokens, 1),
        compressionLevel: this.compressionLevel,
        sessionReset: true,
      };
    }

    // 正常情况：系统消息 + 摘要块 + 热点消息
    const summaryBlock: ChatMessage = {
      role: 'user',
      content: `[此前对话摘要] ${this.accumulatedSummary}`,
    };
    const reassembled = [...systemMsgs, summaryBlock, ...hotMessages];
    const finalTokens = estimateMessagesTokens(reassembled);

    logger.info(
      `[Context] 完成: ${originalTokens} → ${finalTokens} tokens` +
      ` (${hotMessages.length} 条热点 + ${this.compressionLevel} 层摘要)`
    );

    return {
      messages: reassembled,
      compressed: true,
      summary: this.accumulatedSummary,
      hotCount: hotMessages.length,
      compressedBlocks: [...this.compressedBlocks],
      originalTokens,
      finalTokens,
      compressionRatio: finalTokens / Math.max(originalTokens, 1),
      compressionLevel: this.compressionLevel,
      sessionReset: true,
    };
  }

  /**
   * 简单截断（attention 关闭时的降级方案）
   */
  private _simpleTruncate(
    messages: ChatMessage[],
    systemMsgs: ChatMessage[],
    maxTokens: number,
    originalTokens: number,
  ): ProcessedContext {
    const nonSystem = messages.filter(m => m.role !== 'system');
    // 从后往前计算能保留多少条
    let keepCount = 0;
    let tokens = 0;
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const t = estimateTokens(nonSystem[i].content || '') + 4;
      if (tokens + t > maxTokens) break;
      tokens += t;
      keepCount++;
    }
    const kept = nonSystem.slice(-Math.max(keepCount, 1));
    const truncated: ChatMessage[] = [
      ...systemMsgs,
      { role: 'user', content: '[部分历史已截断]' } as ChatMessage,
      ...kept,
    ];
    const finalTokens = estimateMessagesTokens(truncated);

    return {
      messages: truncated,
      compressed: true,
      summary: '[使用简单截断模式]',
      hotCount: kept.length,
      compressedBlocks: [...this.compressedBlocks],
      originalTokens,
      finalTokens,
      compressionRatio: finalTokens / Math.max(originalTokens, 1),
      compressionLevel: this.compressionLevel,
      sessionReset: true,
    };
  }

  /**
   * 兜底摘要（模型压缩失败时使用）
   */
  private _fallbackSummary(msgs: ChatMessage[]): string {
    const userMsgs = msgs.filter(m => m.role === 'user');
    const agentMsgs = msgs.filter(m => m.role === 'assistant');

    const parts: string[] = [];
    if (userMsgs.length) parts.push(`用户发了 ${userMsgs.length} 条消息`);
    if (agentMsgs.length) parts.push(`助手回复了 ${agentMsgs.length} 次`);

    // 从最后几条取关键信息
    const lastContent = msgs.slice(-3).map(m => m.content?.slice(0, 100)).filter(Boolean);
    if (lastContent.length) parts.push('最后讨论: ' + lastContent.join(' | '));

    return parts.join('；');
  }
}

/** 单例 */
let instance: ContextManager | null = null;

export function getContextManager(config?: Partial<ContextConfig>): ContextManager {
  if (!instance) instance = new ContextManager(config);
  return instance;
}
