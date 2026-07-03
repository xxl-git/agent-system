// ExperienceExtractor — 经验提取器
// 从任务执行结果中提取结构化经验
// 三种触发：任务成功 / 任务失败 / 用户反馈
// LLM 辅助提取 + 规则引擎兜底

import type { ChatMessage } from '../models/adapters/lmstudio';
import { getLLMRouter } from '@agent-system/llm';
import { getPromptRegistry } from '@agent-system/prompts';
import { getExperienceStore } from '@agent-system/experience';
import { getExperienceRetriever } from '@agent-system/experience';
import { logger } from '@agent-system/experience';
import type { ExperienceInput, ExperienceOutcome, ExtractedExperience, ExperienceType, RetrieveResult } from '@agent-system/experience';

// ─── ExperienceExtractor ──────────────────────────────────────────────────────

export class ExperienceExtractor {
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
  async extract(
    userInput: string,
    agentReply: string,
    outcome: ExperienceOutcome,
    sessionId: string,
    context?: { commands?: string[]; errors?: string[]; modelUsed?: string; project?: string },
  ): Promise<number | null> {
    // 尝试 LLM 提取
    let extracted = await this.llmExtract(userInput, agentReply, outcome, context?.errors);

    // LLM 失败时规则引擎兜底
    if (!extracted) {
      extracted = this.ruleEngineExtract(userInput, agentReply, outcome, context?.errors);
    }

    if (!extracted || extracted.scenario === 'N/A') {
      logger.debug('[ExperienceExtractor] 无有价值的经验可提取');
      return null;
    }

    // 确定经验类型
    const type: ExperienceType = extracted.type || (outcome === 'success' ? 'pattern' : 'pitfall');

    // 构造 ExperienceInput
    const input: ExperienceInput = {
      scenario: extracted.scenario,
      problem: extracted.problem,
      solution: extracted.solution,
      reasoning: extracted.reasoning || '',
      tags: extracted.tags || [],
      outcome,
      type,
      source: 'auto',
      sessionId,
      project: context?.project || '',
      modelUsed: context?.modelUsed || '',
    };

    // 如果有代码片段或命令信息，追加到 codeSnippet
    if (context?.commands && context.commands.length > 0) {
      input.codeSnippet = context.commands.join('\n');
    }

    const store = getExperienceStore();
    const id = store.save(input);
    return id;
  }

  /**
   * 用户手动保存经验
   */
  async manualSave(
    scenario: string,
    problem: string,
    solution: string,
    opts?: {
      reasoning?: string;
      tags?: string[];
      type?: ExperienceType;
      outcome?: ExperienceOutcome;
      sessionId?: string;
      project?: string;
    },
  ): Promise<number> {
    const input: ExperienceInput = {
      scenario,
      problem,
      solution,
      reasoning: opts?.reasoning || '',
      tags: opts?.tags || [],
      outcome: opts?.outcome || 'success',
      type: opts?.type || 'pattern',
      source: 'user',
      sessionId: opts?.sessionId || '',
      project: opts?.project || '',
    };

    const store = getExperienceStore();
    return store.save(input);
  }

  /**
   * 精炼用户原始描述 → 结构化经验草稿
   *
   * 用于 /exp add 流程：用户输入原始文字 → LLM 加工为泛化草稿 → 展示给用户确认
   *
   * @param rawText 用户原始描述
   * @param existing 已有经验（编辑模式下传入，作为加工参考）
   * @returns 精炼后的草稿 + 相似经验列表
   */
  async refine(
    rawText: string,
    existing?: { scenario: string; problem: string; solution: string; reasoning: string; tags: string[]; type: string; outcome: string },
  ): Promise<{ draft: ExtractedExperience; similar: RetrieveResult[] }> {
    // 尝试 LLM 精炼
    let draft = await this.llmRefine(rawText, existing);

    // LLM 失败时规则兜底
    if (!draft) {
      draft = this.ruleEngineRefine(rawText, existing);
    }

    // 检索相似经验（用于去重提示）
    const retriever = getExperienceRetriever();
    const similar = retriever.retrieve(
      `${draft.scenario} ${draft.problem} ${draft.solution}`,
      { topK: 3 },
    );

    return { draft, similar };
  }

  // ─── LLM 精炼 ──────────────────────────────────────────────────────────────

  private async llmRefine(
    rawText: string,
    existing?: { scenario: string; problem: string; solution: string; reasoning: string; tags: string[]; type: string; outcome: string },
  ): Promise<ExtractedExperience | null> {
    try {
      const registry = getPromptRegistry();
      const tpl = registry.get('experience.refine');

      const parts: string[] = [`用户描述: ${rawText}`];
      if (existing) {
        parts.push(`\n当前经验内容（供参考修改）:\n场景: ${existing.scenario}\n问题: ${existing.problem}\n解法: ${existing.solution}\n推理: ${existing.reasoning}\n标签: ${existing.tags.join(', ')}\n类型: ${existing.type}\n结果: ${existing.outcome}`);
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: tpl.system || '' },
        { role: 'user', content: parts.join('\n') },
      ];

      const router = getLLMRouter();
      const response = await router.call({
        taskType: 'summarize',
        messages,
        params: { temperature: 0, max_tokens: 1024, reasoning: 'off' },
      });

      const content = response.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('[ExperienceExtractor] refine: LLM 返回无 JSON');
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.scenario || !parsed.problem || !parsed.solution) {
        logger.warn('[ExperienceExtractor] refine: LLM 结果不完整');
        return null;
      }

      return {
        scenario: String(parsed.scenario),
        problem: String(parsed.problem),
        solution: String(parsed.solution),
        reasoning: String(parsed.reasoning || ''),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        type: (parsed.type as ExperienceType) || 'tip',
      };
    } catch (err) {
      logger.warn('[ExperienceExtractor] refine: LLM 失败，降级规则引擎', err);
      return null;
    }
  }

  // ─── 规则引擎精炼兜底 ──────────────────────────────────────────────────────

  private ruleEngineRefine(
    rawText: string,
    existing?: { scenario: string; problem: string; solution: string; reasoning: string; tags: string[]; type: string; outcome: string },
  ): ExtractedExperience {
    if (existing) {
      // 编辑模式：保留原有结构，只更新内容
      return {
        scenario: existing.scenario,
        problem: rawText.slice(0, 200),
        solution: existing.solution,
        reasoning: existing.reasoning,
        tags: existing.tags,
        type: (existing.type as ExperienceType) || 'tip',
      };
    }

    // 新建模式：简单提取
    const tags = this.extractTags(rawText);
    return {
      scenario: this.guessScenario(rawText),
      problem: rawText.slice(0, 200),
      solution: '(用户未提供解法，请编辑补充)',
      reasoning: '用户手动录入（规则引擎兜底，未经 LLM 加工）',
      tags: tags.length > 0 ? tags : ['manual'],
      type: 'tip',
    };
  }

  private async llmExtract(
    userInput: string,
    agentReply: string,
    outcome: ExperienceOutcome,
    errors?: string[],
  ): Promise<ExtractedExperience | null> {
    try {
      const registry = getPromptRegistry();
      const tpl = registry.get('experience.extract');

      const contextParts: string[] = [
        `用户输入: ${userInput.slice(0, 500)}`,
        `Agent回复: ${agentReply.slice(0, 500)}`,
        `结果: ${outcome === 'success' ? '成功' : '失败'}`,
      ];
      if (errors && errors.length > 0) {
        contextParts.push(`错误信息: ${errors.join('; ').slice(0, 300)}`);
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: tpl.system || '' },
        { role: 'user', content: contextParts.join('\n\n') },
      ];

      const router = getLLMRouter();
      const response = await router.call({
        taskType: 'summarize',
        messages,
        params: { temperature: 0, max_tokens: 512, reasoning: 'off' },
      });

      const content = response.choices?.[0]?.message?.content || '';

      // 提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('[ExperienceExtractor] LLM 返回无 JSON');
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // 基本校验
      if (!parsed.scenario || !parsed.problem || !parsed.solution) {
        logger.warn('[ExperienceExtractor] LLM 提取结果不完整');
        return null;
      }

      return {
        scenario: String(parsed.scenario),
        problem: String(parsed.problem),
        solution: String(parsed.solution),
        reasoning: String(parsed.reasoning || ''),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        type: (parsed.type as ExperienceType) || (outcome === 'success' ? 'pattern' : 'pitfall'),
      };
    } catch (err) {
      logger.warn('[ExperienceExtractor] LLM 提取失败，降级规则引擎', err);
      return null;
    }
  }

  // ─── 规则引擎兜底 ──────────────────────────────────────────────────────────

  private ruleEngineExtract(
    userInput: string,
    agentReply: string,
    outcome: ExperienceOutcome,
    errors?: string[],
  ): ExtractedExperience | null {
    // 如果回复太短或无实质内容，跳过
    if (agentReply.length < 20) return null;
    if (agentReply.startsWith('ERR:') || agentReply.startsWith('WARN:')) {
      // 错误场景
      const errorMsg = errors?.[0] || agentReply;
      return {
        scenario: 'Agent 执行出错',
        problem: userInput.slice(0, 100),
        solution: errorMsg.slice(0, 200),
        reasoning: '错误信息已记录，供后续排查',
        tags: ['error', 'failure'],
        type: 'pitfall',
      };
    }

    // 成功场景的简单提取
    const tags = this.extractTags(userInput + ' ' + agentReply);
    if (tags.length === 0) return null;

    return {
      scenario: this.guessScenario(userInput),
      problem: userInput.slice(0, 150),
      solution: agentReply.slice(0, 200),
      reasoning: '规则引擎提取，未经 LLM 分析',
      tags,
      type: outcome === 'success' ? 'pattern' : 'pitfall',
    };
  }

  private extractTags(text: string): string[] {
    const tagMap: Record<string, string[]> = {
      'typescript|ts|tsc': ['typescript', 'compile'],
      'npm|pnpm|yarn': ['npm', 'dependency'],
      'git|commit|push': ['git'],
      'compile|build': ['compile', 'build'],
      'timeout|超时': ['timeout'],
      'error|错误|err': ['error'],
      'file|文件|write|read': ['file'],
      'memory|记忆': ['memory'],
      'prompt|提示词': ['prompt'],
      'model|模型|llm': ['model'],
      'test|测试': ['test'],
      'config|配置': ['config'],
    };

    const lower = text.toLowerCase();
    const tags: string[] = [];
    for (const [pattern, tagList] of Object.entries(tagMap)) {
      if (pattern.split('|').some(p => lower.includes(p))) {
        tags.push(...tagList);
      }
    }
    return [...new Set(tags)];
  }

  private guessScenario(userInput: string): string {
    const lower = userInput.toLowerCase();
    if (lower.includes('编译') || lower.includes('compile') || lower.includes('build')) return '代码编译';
    if (lower.includes('测试') || lower.includes('test')) return '运行测试';
    if (lower.includes('文件') || lower.includes('file') || lower.includes('读写')) return '文件操作';
    if (lower.includes('配置') || lower.includes('config')) return '配置管理';
    if (lower.includes('模型') || lower.includes('model') || lower.includes('llm')) return '模型调用';
    if (lower.includes('超时') || lower.includes('timeout')) return '请求超时';
    return '通用任务';
  }
}

// ─── 单例 ────────────────────────────────────────────────────────────────────

let _instance: ExperienceExtractor | null = null;

export function getExperienceExtractor(): ExperienceExtractor {
  if (!_instance) {
    _instance = new ExperienceExtractor();
  }
  return _instance;
}
