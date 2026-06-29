// 记忆摘要引擎 — 自动将对话蒸馏为结构化知识
// 触发: 会话结束自动 / /summarize 命令 / 心跳巡检长会话
// v2: 使用 PromptRegistry 获取提示词模板
import { getDBStore, type DecisionRecord } from './db-store';
import logger from '../logger';

export interface SummaryOutput {
  /** 会话摘要 (1-3句) */
  sessionSummary: string;
  /** 关键决策 (分类+内容) */
  keyDecisions: Array<{ category: string; summary: string; detail: string }>;
  /** 学到的新事实 */
  learnedFacts: string[];
  /** 实体更新建议 */
  entityUpdates: Array<{ name: string; type: string; notes: string }>;
  /** 标记/tags */
  tags: string[];
  /** 下一步建议 */
  nextSteps: string[];
  /** 知识要点 (用于注入未来 session) */
  knowledgePoints: string[];
}

export interface SummarizerConfig {
  /** 自动摘要的最小消息数 */
  minMessagesForAuto: number;
  /** 长会话触发巡逻摘要的消息数 */
  patroThreshold: number;
  /** 摘要存储上限 */
  maxStoredSummaries: number;
  /** 是否使用 LLM 生成 (false=规则引擎) */
  useLLM: boolean;
  /** LLM chat 函数 */
  chatFn?: (prompt: string) => Promise<string>;
}

const DEFAULT_CONFIG: SummarizerConfig = {
  minMessagesForAuto: 4,
  patroThreshold: 20,
  maxStoredSummaries: 50,
  useLLM: false,
};

/**
 * 记忆摘要引擎
 *
 * 职责:
 * 1. 会话结束时自动生成摘要 → 写入 summaries 表
 * 2. 知识蒸馏: 从消息流中提取决策/事实/偏好
 * 3. 长会话中途巡逻摘要 (心跳触发)
 * 4. 生成知识要点注入后续 session
 */
export class MemorySummarizer {
  private config: SummarizerConfig;

  constructor(config: Partial<SummarizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('[Summarizer] 记忆摘要引擎初始化 (LLM=' + this.config.useLLM + ')');
  }

  /**
   * 摘要单个会话 (完整分析)
   * @param sessionId 会话ID
   * @param messages 消息列表 [{role, content}]
   * @param decisions 期间做出的决策
   */
  async summarizeSession(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
    decisions: DecisionRecord[],
  ): Promise<SummaryOutput> {
    const db = getDBStore();
    const userMessages = messages.filter((m) => m.role === 'user');
    const assisMessages = messages.filter((m) => m.role === 'assistant');

    if (this.config.useLLM && this.config.chatFn) {
      return this.llmSummarize(sessionId, messages, decisions, 0);
    }

    return this.ruleEngineSummarize(sessionId, messages, decisions);
  }

  /**
   * 规则引擎快速摘要（不含 LLM 调用）
   */
  private ruleEngineSummarize(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
    decisions: DecisionRecord[],
  ): SummaryOutput {
    const userMessages = messages.filter((m) => m.role === 'user');
    const assisMessages = messages.filter((m) => m.role === 'assistant');

    const output: SummaryOutput = {
      sessionSummary: '',
      keyDecisions: [],
      learnedFacts: [],
      entityUpdates: [],
      tags: [],
      nextSteps: [],
      knowledgePoints: [],
    };

    // 1. 生成会话摘要
    const topics = this.extractTopics(userMessages);
    const actionCount = decisions.length + messages.filter((m) => m.role === 'tool' || m.content.includes('执行')).length;
    output.sessionSummary = this.buildSummary(sessionId, messages.length, topics, actionCount);

    // 2. 关键决策
    output.keyDecisions = decisions.slice(0, 5).map((d) => ({
      category: d.category,
      summary: d.summary,
      detail: d.detail || '',
    }));

    // 3. 学到的新事实
    output.learnedFacts = this.extractFacts(assisMessages);

    // 4. 实体检测
    output.entityUpdates = this.detectEntities(userMessages.concat(assisMessages));

    // 5. 标签生成
    output.tags = this.generateTags(topics, output.keyDecisions);

    // 6. 下一步
    output.nextSteps = this.inferNextSteps(messages.slice(-6), output.keyDecisions);

    // 7. 知识要点
    output.knowledgePoints = this.buildKnowledgePoints(output);

    // 持久化
    this.persist(sessionId, output, messages.length);

    return output;
  }

  /**
   * 巡逻摘要 — 对长会话做中途快照
   * 只做轻量摘要，不持久化到 DB
   */
  async patrolSummary(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<string | null> {
    if (messages.length < this.config.patroThreshold) return null;

    const userTopics = this.extractTopics(messages.filter((m) => m.role === 'user'));
    const decisions = getDBStore().queryDecisions({ sessionId, limit: 10 });

    const parts: string[] = [
      `[Patrol @ ${new Date().toISOString().slice(11, 19)}]`,
      `Session: ${sessionId}, Messages: ${messages.length}`,
    ];

    if (userTopics.length > 0) parts.push(`Topics: ${userTopics.slice(0, 5).join(', ')}`);
    if (decisions.length > 0) {
      parts.push(`Recent decisions (${decisions.length}):`);
      decisions.slice(0, 3).forEach((d) => parts.push(`  - ${d.summary}`));
    }

    const partial = parts.join('\n');
    logger.debug('[Summarizer] Patrol: ' + partial.slice(0, 120));
    return partial;
  }

  /**
   * 批量补摘要 — 给历史会话生成缺失的摘要
   */
  async backfill(sessionIds: string[]): Promise<number> {
    const db = getDBStore();
    let done = 0;

    for (const sid of sessionIds) {
      const decisions = db.queryDecisions({ sessionId: sid, limit: 50 });
      if (decisions.length === 0) continue;

      // 用现有决策生成轻量摘要
      const output = this.buildFromDecisions(sid, decisions);
      this.persist(sid, output, 0);
      done++;
      logger.info('[Summarizer] Backfilled: ' + sid);
    }

    return done;
  }

  /**
   * 加载会话的所有摘要
   */
  getSummaries(sessionId: string): Array<{ timestamp: string; content: string; key_points: string }> {
    const db = getDBStore();
    const rows = db.querySummaries(sessionId, { limit: this.config.maxStoredSummaries });
    return rows.map((r: any) => ({
      timestamp: r.timestamp,
      content: r.content,
      key_points: r.key_points || '',
    }));
  }

  /** 获取最近摘要 (跨会话) */
  getRecentSummaries(limit: number = 5): Array<{ sessionId: string; content: string; timestamp: string }> {
    const db = getDBStore();
    return db.queryRecentSummaries(limit).map((r: any) => ({
      sessionId: r.session_id,
      content: r.content,
      timestamp: r.timestamp,
    }));
  }

  // ====== 私有方法: 规则引擎 ======

  private extractTopics(messages: Array<{ role: string; content: string }>): string[] {
    const topicMap = new Map<string, number>();
    const stopwords = new Set([
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也',
      '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '他', '她',
      '它', '们', '那', '什么', '怎么', '哪个', '为什么', '可以', '这个', '那个', '如果', '因为',
      '所以', '但是', '而且', '然后', '还是', '不过', '虽然', '已经', '应该', '需要', '可能',
    ]);

    for (const msg of messages) {
      // 简单中英文分词
      const words = this.tokenize(msg.content);
      for (const w of words) {
        if (w.length < 2 || stopwords.has(w)) continue;
        topicMap.set(w, (topicMap.get(w) || 0) + 1);
      }
    }

    return Array.from(topicMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([w]) => w);
  }

  private tokenize(text: string): string[] {
    // 中英文混合分词：英文按单词切，中文保留单字+2-gram
    const tokens: string[] = [];
    let buf = '';
    let isCJK = false;

    const flush = () => {
      if (buf.length > 0) {
        tokens.push(isCJK ? buf : buf.toLowerCase());
        buf = '';
      }
    };

    for (const ch of text) {
      const cjk = /[\u4e00-\u9fff]/.test(ch);
      if (cjk !== isCJK) { flush(); isCJK = cjk; }

      if (cjk) {
        buf += ch;
        // 每遇到中文标点或下一个英文时 flush
      } else if (/[a-zA-Z0-9_]/.test(ch)) {
        buf += ch;
      } else {
        flush();
      }
    }
    flush();

    // 对中文词组做 2-gram 扩充
    const result: string[] = [];
    for (const t of tokens) {
      result.push(t); // 保留原始词
      if (/[\u4e00-\u9fff]/.test(t) && t.length >= 3) {
        // 在中文词组上滑动窗口生成 2-gram
        for (let i = 0; i < t.length - 1; i++) {
          result.push(t[i] + t[i + 1]);
        }
      }
    }

    return result.filter(t => {
      if (/[\u4e00-\u9fff]/.test(t)) return t.length >= 1; // CJK: 单字也可以
      return t.length >= 2; // 英文: 至少2字符
    });
  }

  private buildSummary(
    sessionId: string,
    msgCount: number,
    topics: string[],
    actionCount: number,
  ): string {
    const topicStr = topics.length > 0 ? topics.slice(0, 5).join('、') : '未分类对话';
    const actionStr = actionCount > 0 ? `，完成${actionCount}项操作` : '';
    return `会话 ${sessionId.slice(0, 12)}：共${msgCount}条消息${actionStr}，主题：${topicStr}`;
  }

  private extractFacts(assisMessages: Array<{ role: string; content: string }>): string[] {
    const facts: string[] = [];
    const patterns = [
      /✅\s*(.+)/g,
      /已完成[:：]\s*(.+)/g,
      /创建了\s*(.+)/g,
      /修复了\s*(.+)/g,
      /通过[:：]\s*(.+)/g,
    ];

    for (const msg of assisMessages) {
      for (const pattern of patterns) {
        const matches = msg.content.matchAll(pattern);
        for (const m of matches) {
          const fact = m[1].trim().slice(0, 100);
          if (fact && !facts.includes(fact)) facts.push(fact);
        }
      }
    }

    return facts.slice(0, 10);
  }

  private detectEntities(
    messages: Array<{ role: string; content: string }>,
  ): Array<{ name: string; type: string; notes: string }> {
    const entities: Array<{ name: string; type: string; notes: string }> = [];
    const seen = new Set<string>();

    // 检测模型名
    const modelRe = /(?:qwen|ollama|llama|mistral|claude|gpt|deepseek)[\w.\-]*/gi;
    // 检测文件路径
    const pathRe = /src\/[\w\/\-]+\.ts/g;
    // 检测工具名
    const toolRe = /(?:health[\-_]?mon|circuit[\-_]?break|checkpoint|retry|degrad|orchestrat|summar|audit|session[\-_]?recover)[\w]*/gi;

    for (const msg of messages) {
      for (const re of [modelRe, pathRe, toolRe]) {
        const matches = msg.content.matchAll(re);
        for (const m of matches) {
          const name = m[0].toLowerCase();
          if (!seen.has(name)) {
            seen.add(name);
            entities.push({
              name,
              type: re === modelRe ? 'model' : re === pathRe ? 'file' : 'module',
              notes: `Detected in conversation`,
            });
          }
        }
      }
    }

    return entities.slice(0, 10);
  }

  private generateTags(
    topics: string[],
    decisions: Array<{ category: string; summary: string }>,
  ): string[] {
    const tags = new Set<string>();

    // 主题 → tag
    const topicTagMap: Record<string, string> = {
      记忆: 'memory', 审计: 'audit', 测试: 'testing', 编译: 'build',
      模型: 'model', 路由: 'routing', 错误: 'error', 修复: 'bugfix',
      心跳: 'heartbeat', 数据库: 'database', 文件: 'files', 配置: 'config',
      编码: 'encoding', agent: 'agent', 项目: 'project', 摘要: 'summarization',
      引擎: 'engine', 英文: 'i18n', 中文: 'i18n', 创建: 'creation',
    };

    for (const t of topics) {
      const mapped = topicTagMap[t];
      if (mapped) tags.add(mapped);
    }

    for (const d of decisions) {
      if (d.category) tags.add(d.category);
    }

    return Array.from(tags).slice(0, 8);
  }

  private inferNextSteps(
    recentMessages: Array<{ role: string; content: string }>,
    decisions: Array<{ category: string; summary: string }>,
  ): string[] {
    const steps: string[] = [];

    // 从决策推断下一步
    const categoryNext: Record<string, string> = {
      routing: '监控路由准确率',
      model: '观察模型稳定性',
      memory: '检查记忆注入质量',
      audit: '验证审计查询性能',
      testing: '回归测试',
      error: '修复后验证',
    };

    for (const d of decisions.slice(0, 3)) {
      const next = categoryNext[d.category];
      if (next && !steps.includes(next)) steps.push(next);
    }

    // 从最近消息推断
    const lastUser = recentMessages.filter((m) => m.role === 'user').slice(-3);
    for (const msg of lastUser) {
      if (msg.content.includes('下一步') || msg.content.includes('接下来')) {
        steps.push('用户询问了下一步计划');
      }
    }

    return steps.length > 0 ? steps : ['继续观察系统运行状态'];
  }

  private buildKnowledgePoints(output: SummaryOutput): string[] {
    const points: string[] = [];

    if (output.sessionSummary) points.push(`Session: ${output.sessionSummary}`);
    for (const d of output.keyDecisions) {
      points.push(`Decision: [${d.category}] ${d.summary}`);
    }
    for (const f of output.learnedFacts.slice(0, 3)) {
      points.push(`Fact: ${f}`);
    }
    if (output.tags.length > 0) points.push(`Tags: ${output.tags.join(', ')}`);

    return points;
  }

  private buildFromDecisions(sessionId: string, decisions: DecisionRecord[]): SummaryOutput {
    return {
      sessionSummary: `Historical session ${sessionId.slice(0, 12)} with ${decisions.length} decisions`,
      keyDecisions: decisions.slice(0, 5).map((d) => ({
        category: d.category,
        summary: d.summary,
        detail: d.detail || '',
      })),
      learnedFacts: [],
      entityUpdates: [],
      tags: Array.from(new Set(decisions.map((d) => d.category))),
      nextSteps: [],
      knowledgePoints: decisions.map((d) => `[${d.category}] ${d.summary}`),
    };
  }

  private persist(sessionId: string, output: SummaryOutput, messageCount: number): void {
    const db = getDBStore();
    db.addSummary({
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      content: output.sessionSummary,
      key_points: JSON.stringify({
        decisions: output.keyDecisions.length,
        facts: output.learnedFacts.length,
        entities: output.entityUpdates.length,
        tags: output.tags,
        nextSteps: output.nextSteps,
        knowledgePoints: output.knowledgePoints,
      }),
    });

    // 清理旧摘要
    db.pruneSummaries(this.config.maxStoredSummaries);

    logger.info(
      `[Summarizer] 已保存摘要: ${sessionId.slice(0, 12)} ` +
        `(${output.keyDecisions.length} decisions, ${output.learnedFacts.length} facts, ${output.tags.length} tags)`,
    );
  }

  // ====== LLM 模式 ======

  private async llmSummarize(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
    decisions: DecisionRecord[],
    attempt: number = 0,  // 防无限递归
  ): Promise<SummaryOutput> {
    if (attempt >= 2) {
      logger.warn('[Summarizer] LLM 摘要第 2 次失败，回退规则引擎');
      // 直接执行规则引擎逻辑，不走 summarizeSession 避免再尝试 LLM
      return this.ruleEngineSummarize(sessionId, messages, decisions);
    }
    const chatFn = this.config.chatFn!;

    // Phase 2: 从 PromptRegistry 获取会话摘要提示词
    let systemPrompt = 'You are a memory summarizer. Summarize the conversation below in JSON.';
    try {
      const { getPromptRegistry } = await import('../prompts/registry');
      const tpl = getPromptRegistry().get('session.summarize');
      if (tpl.system) systemPrompt = tpl.system;
    } catch { /* 模块加载失败则使用默认提示词 */ }

    // 构造摘要 prompt（系统提示词 + 对话内容）
    const convText = messages
      .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
      .slice(-20)
      .join('\n');

    const prompt = [
      systemPrompt,
      '',
      '对话内容：',
      convText,
    ].join('\n');

    try {
      const resp = await chatFn(prompt);
      // 清理可能的 markdown 包裹
      const json = resp.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(json);

      const output: SummaryOutput = {
        sessionSummary: parsed.sessionSummary || '',
        keyDecisions: parsed.keyDecisions || [],
        learnedFacts: parsed.learnedFacts || [],
        entityUpdates: parsed.entityUpdates || [],
        tags: parsed.tags || [],
        nextSteps: parsed.nextSteps || [],
        knowledgePoints: parsed.knowledgePoints || [],
      };

      this.persist(sessionId, output, messages.length);
      return output;
    } catch (err) {
      logger.warn('[Summarizer] LLM 摘要失败，回退规则引擎: ' + (err as Error).message);
      return this.llmSummarize(sessionId, messages, decisions, attempt + 1);
    }
  }
}

// 单例
let _summarizer: MemorySummarizer | null = null;
export function getSummarizer(config?: Partial<SummarizerConfig>): MemorySummarizer {
  if (!_summarizer) {
    _summarizer = new MemorySummarizer(config);
  } else if (config) {
    _summarizer = new MemorySummarizer({ ..._summarizer['config'], ...config });
  }
  return _summarizer;
}
