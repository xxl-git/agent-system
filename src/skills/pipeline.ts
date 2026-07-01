// 技能生态 — 审核器 + 开发器 + 测试器 + 装备器 (Phase 3)
import type { SkillMeta, SkillApply, SkillAuditResult, SkillTestResult, SkillDangerLevel } from './types';
import { getRegistry } from './registry';
import { getLLMRouter } from '@agent-system/llm';
import type { ChatMessage } from '../models/adapters/lmstudio';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../logger';

// ====== 自动审核器 ======

export class SkillAuditor {
  /** 审核技能申请 */
  audit(application: SkillApply): SkillAuditResult {
    const registry = getRegistry();

    // 规则1：是否已存在
    if (registry.has(application.name)) {
      return {
        approved: false,
        reason: `技能 "${application.name}" 已存在`,
        rule: 'duplicate',
        needsHumanReview: false,
        riskScore: 0,
      };
    }

    // 规则2：重叠检查
    const dummyMeta: SkillMeta = {
      name: application.name,
      version: '0.1.0',
      description: application.expectedFunction,
      author: 'agent',
      dangerLevel: application.dangerLevel,
      capabilities: [{ name: application.expectedFunction, description: application.reason, inputType: 'any', outputType: 'any' }],
      dependencies: [],
      triggers: [],
      createdAt: application.createdAt,
      updatedAt: application.createdAt,
      stats: { totalCalls: 0, successCalls: 0, failCalls: 0, avgDurationMs: 0 },
      status: 'draft' as const,
    };
    const overlap = registry.overlap(dummyMeta);
    if (overlap && overlap.overlap > 0.8) {
      return {
        approved: false,
        reason: `与已有技能 "${overlap.name}" 重叠 ${(overlap.overlap * 100).toFixed(0)}%`,
        rule: 'overlap',
        needsHumanReview: false,
        riskScore: 50,
      };
    }

    // 规则3：危险操作
    let riskScore = 0;
    let needsHumanReview = false;

    if (application.dangerLevel === 'dangerous') {
      riskScore += 80;
      needsHumanReview = true;
    } else if (application.dangerLevel === 'caution') {
      riskScore += 30;
    }

    // 规则4：涉及外部 API / 网络 → 需人工
    const externalKeywords = ['api', 'http', '网络', '联网', 'fetch', 'request'];
    if (externalKeywords.some(k => application.expectedFunction.toLowerCase().includes(k))) {
      riskScore += 20;
      needsHumanReview = true;
    }

    // 规则5：P2 低优先级且无明确场景 → 拒绝
    if (application.priority === 'P2' && !application.gapContext) {
      return {
        approved: false,
        reason: 'P2 优先级且无明确使用场景',
        rule: 'low_priority',
        needsHumanReview: false,
        riskScore,
      };
    }

    if (needsHumanReview) {
      return {
        approved: false, // 暂不自动批准，需人工
        reason: `风险评分 ${riskScore}，需人工审核`,
        rule: 'human_review',
        needsHumanReview: true,
        riskScore,
      };
    }

    return {
      approved: true,
      reason: `通过自动审核（风险${riskScore}，P${application.priority.slice(1)}）`,
      rule: 'auto_approve',
      needsHumanReview: false,
      riskScore,
    };
  }
}

// ====== 技能开发器 ======

export interface SkillDevResult {
  success: boolean;
  skillMeta?: SkillMeta;
  skillDescription?: string;  // SKILL.md 内容
  error?: string;
}

/** LLM 生成的技能结构 */
interface LLMGeneratedSkill {
  name: string;
  version: string;
  description: string;
  dangerLevel: 'safe' | 'caution' | 'dangerous';
  capabilities: Array<{
    name: string;
    description: string;
    inputType: string;
    outputType: string;
  }>;
  triggers: string[];
  skillDescription: string;  // 详细的 SKILL.md 正文
  notes?: string;
}

export class SkillDeveloper {
  /** 根据申请开发技能（优先使用 LLM 生成真实技能） */
  async develop(application: SkillApply): Promise<SkillDevResult> {
    const registry = getRegistry();
    logger.info(`[Skill] 🔨 开始开发: ${application.name}`);

    // 尝试 LLM 驱动开发
    const llmResult = await this.developWithLLM(application);
    if (llmResult.success && llmResult.skillMeta) {
      // 保存 SKILL.md 到技能目录
      if (llmResult.skillDescription) {
        this.saveSkillDocs(llmResult.skillMeta.name, llmResult.skillDescription);
      }
      // 注册到技能注册表
      registry.register(llmResult.skillMeta);
      logger.info(`[Skill] ✅ ${application.name} (LLM) 已进入测试阶段`);
      return llmResult;
    }

    // LLM 失败时回退到结构化生成
    logger.warn(`[Skill] LLM 开发失败，回退到结构化生成: ${llmResult.error}`);
    return this.developStructured(application);
  }

  /** LLM 驱动的技能开发 */
  private async developWithLLM(app: SkillApply): Promise<SkillDevResult> {
    try {
      const prompt = this.buildSkillGenPrompt(app);
      const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

      const router = getLLMRouter();
      const resp = await router.call({
        taskType: 'chat',
        messages,
        params: { temperature: 0.3, max_tokens: 2048 },
        emitPayload: false,
      });

      const raw = resp.choices?.[0]?.message?.content ?? '';
      const generated = this.parseGeneratedSkill(raw);

      if (!generated) {
        return { success: false, error: 'LLM 输出格式解析失败' };
      }

      const skillMeta: SkillMeta = {
        name: generated.name,
        version: generated.version || '0.1.0',
        description: generated.description,
        author: 'agent',
        dangerLevel: generated.dangerLevel || app.dangerLevel,
        capabilities: generated.capabilities.length > 0 ? generated.capabilities : [{
          name: app.expectedFunction,
          description: app.reason,
          inputType: 'string',
          outputType: 'any',
        }],
        dependencies: [],
        triggers: generated.triggers.length > 0 ? generated.triggers : this.generateTriggers(app),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stats: { totalCalls: 0, successCalls: 0, failCalls: 0, avgDurationMs: 0 },
        status: 'testing',
      };

      return { success: true, skillMeta, skillDescription: generated.skillDescription };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 构建技能生成提示词 */
  private buildSkillGenPrompt(app: SkillApply): string {
    return `你是技能工程师。请根据以下技能申请，生成技能元数据（JSON格式）。

## 技能申请
- 名称: ${app.name}
- 申请原因: ${app.reason}
- 预期功能: ${app.expectedFunction}
- 使用场景: ${app.gapContext || '通用场景'}
- 优先级: ${app.priority}
- 危险等级: ${app.dangerLevel}

## 输出要求
请严格按以下JSON格式输出（只输出JSON，不要其他内容）：

\`\`\`json
{
  "name": "技能英文名称（下划线连接）",
  "version": "0.1.0",
  "description": "一句话功能描述（20字以内）",
  "dangerLevel": "safe|caution|dangerous",
  "capabilities": [{
    "name": "能力名称",
    "description": "能力详细描述",
    "inputType": "输入类型",
    "outputType": "输出类型"
  }],
  "triggers": ["触发词1", "触发词2"],
  "skillDescription": "## 技能详细描述\n\n### 功能说明\n[详细说明]\n\n### 使用方法\n[说明]\n\n### 示例\n[示例]"
}
\`\`\`

注意：
1. name 必须是小写英文+下划线，不超过30字符
2. triggers 要包含中英文触发词
3. skillDescription 用 Markdown 格式
4. 只输出JSON，不要解释`;
  }

  /** 解析 LLM 生成的技能 JSON */
  private parseGeneratedSkill(raw: string): LLMGeneratedSkill | null {
    try {
      // 尝试提取 JSON（处理 ```json 包裹的情况）
      const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) ||
                        raw.match(/```\s*([\s\S]*?)\s*```/) ||
                        raw.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) {
        logger.warn('[Skill] LLM 输出无 JSON，找到的内容: ' + raw.slice(0, 200));
        return null;
      }
      const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      // 验证必要字段
      if (!json.name || !json.description) {
        logger.warn('[Skill] LLM 输出 JSON 缺少必要字段');
        return null;
      }

      // 规范化字段
      if (!Array.isArray(json.capabilities)) json.capabilities = [];
      if (!Array.isArray(json.triggers)) json.triggers = [];
      if (typeof json.skillDescription !== 'string') {
        json.skillDescription = `## ${json.name}\n\n${json.description}`;
      }

      return json as LLMGeneratedSkill;
    } catch (err: any) {
      logger.warn(`[Skill] 解析 LLM 输出失败: ${err.message}`);
      return null;
    }
  }

  /** 保存技能文档到 skills 目录 */
  private saveSkillDocs(name: string, description: string): void {
    try {
      const skillsDir = path.resolve(process.cwd(), 'data', 'skills');
      if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
      }
      const docPath = path.join(skillsDir, `${name}.md`);
      fs.writeFileSync(docPath, `# ${name}\n\n${description}`, 'utf-8');
      logger.info(`[Skill] 文档已保存: ${docPath}`);
    } catch (err: any) {
      logger.warn(`[Skill] 文档保存失败: ${err.message}`);
    }
  }

  /** 结构化技能开发（LLM 失败时的回退方案） */
  private developStructured(application: SkillApply): SkillDevResult {
    const registry = getRegistry();
    logger.info(`[Skill] 🔨 结构化开发: ${application.name}`);

    const skillMeta: SkillMeta = {
      name: application.name,
      version: '0.1.0',
      description: application.expectedFunction,
      author: 'agent',
      dangerLevel: application.dangerLevel,
      capabilities: [{
        name: application.expectedFunction,
        description: application.reason,
        inputType: 'string',
        outputType: 'any',
      }],
      dependencies: [],
      triggers: this.generateTriggers(application),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: { totalCalls: 0, successCalls: 0, failCalls: 0, avgDurationMs: 0 },
      status: 'testing',
    };

    try {
      registry.register(skillMeta);
      logger.info(`[Skill] ✅ ${application.name} (结构化) 已进入测试阶段`);
      return { success: true, skillMeta };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private generateTriggers(app: SkillApply): string[] {
    const words = app.expectedFunction.split(/[\s,，、]+/).filter(Boolean);
    // 生成中文+英文触发词
    const triggers = words.slice(0, 5).flatMap(w => {
      const clean = w.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
      return [clean].filter(Boolean);
    });
    return [...new Set(triggers)];
  }
}

// ====== 技能测试器 ======

export class SkillTester {
  /** 测试技能（简单样本验证） */
  test(skill: SkillMeta): SkillTestResult {
    logger.info(`[Skill] 测试: ${skill.name}`);
    const tests: SkillTestResult['tests'] = [];

    // 测试1：基础可用
    tests.push({
      caseName: '基础注册检查',
      passed: skill.name.length > 0 && skill.capabilities.length > 0,
      output: `技能已注册: ${skill.name}`,
      expected: `技能已注册: ${skill.name}`,
      durationMs: 1,
    });

    // 测试2：触发词匹配
    if (skill.triggers.length > 0) {
      const triggerTest = skill.triggers.some(t => t.length > 0);
      tests.push({
        caseName: '触发词验证',
        passed: triggerTest,
        output: `触发词: ${skill.triggers.join(', ')}`,
        expected: `至少1个非空触发词`,
        durationMs: 1,
      });
    }

    // 测试3：依赖检查
    if (skill.dependencies.length > 0) {
      const depsOk = skill.dependencies.every(d => d.name.length > 0);
      tests.push({
        caseName: '依赖声明检查',
        passed: depsOk,
        output: `依赖: ${skill.dependencies.map(d => d.name).join(', ')}`,
        expected: '所有依赖声明完整',
        durationMs: 1,
      });
    }

    const allPassed = tests.every(t => t.passed);

    return {
      skillName: skill.name,
      passed: allPassed,
      tests,
      summary: allPassed
        ? `✅ ${skill.name}: ${tests.length}/${tests.length} 测试通过`
        : `❌ ${skill.name}: ${tests.filter(t => t.passed).length}/${tests.length} 测试通过`,
    };
  }
}

// ====== 技能装备器 ======

export class SkillEquipper {
  /** 测试通过后装备技能 */
  equip(skill: SkillMeta): boolean {
    if (skill.status !== 'testing') {
      logger.warn(`[Skill] ${skill.name}: 状态为 ${skill.status}，不可装备（需 testing）`);
      return false;
    }

    skill.status = 'active';
    skill.updatedAt = new Date().toISOString();
    getRegistry().register(skill);
    logger.info(`[Skill] 🚀 ${skill.name} v${skill.version} 已装备上线`);
    return true;
  }

  /** 停用技能 */
  disable(skillName: string): boolean {
    getRegistry().disable(skillName);
    return true;
  }
}
