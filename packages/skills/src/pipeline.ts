import type { SkillMeta, SkillApply, SkillAuditResult, SkillTestResult } from './types';
import { getRegistry } from './registry';
import { logger } from './logger';

export class SkillAuditor {
  audit(application: SkillApply): SkillAuditResult {
    const registry = getRegistry();
    if (registry.has(application.name)) return { approved: false, reason: `技能 "${application.name}" 已存在`, rule: 'duplicate', needsHumanReview: false, riskScore: 0 };
    const dummyMeta: SkillMeta = { name: application.name, version: '0.1.0', description: application.expectedFunction, author: 'agent', dangerLevel: application.dangerLevel, capabilities: [{ name: application.expectedFunction, description: application.reason, inputType: 'any', outputType: 'any' }], dependencies: [], triggers: [], createdAt: application.createdAt, updatedAt: application.createdAt, stats: { totalCalls: 0, successCalls: 0, failCalls: 0, avgDurationMs: 0 }, status: 'draft' };
    const overlap = registry.overlap(dummyMeta);
    if (overlap && overlap.overlap > 0.8) return { approved: false, reason: `与已有技能 "${overlap.name}" 重叠 ${(overlap.overlap * 100).toFixed(0)}%`, rule: 'overlap', needsHumanReview: false, riskScore: 50 };
    let riskScore = 0, needsHumanReview = false;
    if (application.dangerLevel === 'dangerous') { riskScore += 80; needsHumanReview = true; }
    else if (application.dangerLevel === 'caution') riskScore += 30;
    if (['api', 'http', '网络', '联网', 'fetch', 'request'].some(k => application.expectedFunction.toLowerCase().includes(k))) { riskScore += 20; needsHumanReview = true; }
    if (application.priority === 'P2' && !application.gapContext) return { approved: false, reason: 'P2 优先级且无明确使用场景', rule: 'low_priority', needsHumanReview: false, riskScore };
    if (needsHumanReview) return { approved: false, reason: `风险评分 ${riskScore}，需人工审核`, rule: 'human_review', needsHumanReview: true, riskScore };
    return { approved: true, reason: `通过自动审核（风险${riskScore}，P${application.priority.slice(1)}）`, rule: 'auto_approve', needsHumanReview: false, riskScore };
  }
}

export interface SkillDevResult { success: boolean; skillMeta?: SkillMeta; error?: string; }

export class SkillDeveloper {
  async develop(application: SkillApply): Promise<SkillDevResult> {
    const registry = getRegistry();
    logger.info(`[Skill] 开始开发: ${application.name}`);
    const skillMeta: SkillMeta = { name: application.name, version: '0.1.0', description: application.expectedFunction, author: 'agent', dangerLevel: application.dangerLevel, capabilities: [{ name: application.expectedFunction, description: application.reason, inputType: 'string', outputType: 'any' }], dependencies: [], triggers: this.generateTriggers(application), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stats: { totalCalls: 0, successCalls: 0, failCalls: 0, avgDurationMs: 0 }, status: 'testing' };
    try { registry.register(skillMeta); logger.info(`[Skill] ${application.name} 已进入测试阶段`); return { success: true, skillMeta }; }
    catch (err: any) { return { success: false, error: err.message }; }
  }
  private generateTriggers(app: SkillApply): string[] {
    const words = app.expectedFunction.split(/[\s,，、]+/).filter(Boolean);
    return [...new Set(words.slice(0, 5).map(w => w.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '')).filter(Boolean))];
  }
}

export class SkillTester {
  test(skill: SkillMeta): SkillTestResult {
    logger.info(`[Skill] 测试: ${skill.name}`);
    const tests: SkillTestResult['tests'] = [];
    tests.push({ caseName: '基础注册检查', passed: skill.name.length > 0 && skill.capabilities.length > 0, output: `技能已注册: ${skill.name}`, expected: `技能已注册: ${skill.name}`, durationMs: 1 });
    if (skill.triggers.length > 0) {
      tests.push({ caseName: '触发词验证', passed: skill.triggers.some(t => t.length > 0), output: `触发词: ${skill.triggers.join(', ')}`, expected: '至少1个非空触发词', durationMs: 1 });
    }
    if (skill.dependencies.length > 0) {
      tests.push({ caseName: '依赖声明检查', passed: skill.dependencies.every(d => d.name.length > 0), output: `依赖: ${skill.dependencies.map(d => d.name).join(', ')}`, expected: '所有依赖声明完整', durationMs: 1 });
    }
    const allPassed = tests.every(t => t.passed);
    return { skillName: skill.name, passed: allPassed, tests, summary: allPassed ? `✅ ${skill.name}: ${tests.length}/${tests.length} 测试通过` : `❌ ${skill.name}: ${tests.filter(t => t.passed).length}/${tests.length} 测试通过` };
  }
}

export class SkillEquipper {
  equip(skill: SkillMeta): boolean {
    if (skill.status !== 'testing') { logger.warn(`[Skill] ${skill.name}: 状态为 ${skill.status}，不可装备`); return false; }
    skill.status = 'active'; skill.updatedAt = new Date().toISOString();
    getRegistry().register(skill);
    logger.info(`[Skill] ${skill.name} v${skill.version} 已装备上线`); return true;
  }
  disable(skillName: string): boolean { getRegistry().disable(skillName); return true; }
}