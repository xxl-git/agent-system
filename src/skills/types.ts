// 技能生态 — 类型定义 (Phase 3)
// 技能注册、申请、审核、开发全流程

export type SkillDangerLevel = 'safe' | 'caution' | 'dangerous';

export interface SkillCapability {
  name: string;
  description: string;
  /** 输入/输出类型 */
  inputType: string;
  outputType: string;
}

export interface SkillDependency {
  name: string;
  version?: string;
  reason: string;
}

export interface SkillMeta {
  name: string;          // 技能唯一标识
  version: string;
  description: string;
  author: string;        // 'system' | 'agent' | 'user'
  dangerLevel: SkillDangerLevel;
  capabilities: SkillCapability[];
  dependencies: SkillDependency[];
  /** 触发关键词 */
  triggers: string[];
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
  /** 成功/失败/调用次数 */
  stats: {
    totalCalls: number;
    successCalls: number;
    failCalls: number;
    avgDurationMs: number;
  };
  /** 状态 */
  status: 'draft' | 'testing' | 'active' | 'disabled' | 'deprecated';
}

export interface SkillApply {
  id: string;
  name: string;
  reason: string;        // 为什么需要这个技能
  expectedFunction: string; // 预期功能描述
  gapContext: string;    // 什么场景下发现缺失的
  priority: 'P0' | 'P1' | 'P2';
  dangerLevel: SkillDangerLevel;
  status: 'pending' | 'approved' | 'rejected' | 'developing' | 'testing' | 'complete';
  createdAt: string;
  resolvedAt?: string;
  rejectReason?: string;
  skillMeta?: SkillMeta; // 开发完成后的元数据
}

export interface SkillAuditResult {
  approved: boolean;
  reason: string;
  rule: string;          // 匹配的规则
  needsHumanReview: boolean;
  riskScore: number;     // 0-100
}

export interface SkillTestResult {
  skillName: string;
  passed: boolean;
  tests: {
    caseName: string;
    passed: boolean;
    output: string;
    expected: string;
    durationMs: number;
  }[];
  summary: string;
}
