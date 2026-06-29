export type SkillDangerLevel = 'safe' | 'caution' | 'dangerous';

export interface SkillCapability { name: string; description: string; inputType: string; outputType: string; }
export interface SkillDependency { name: string; version?: string; reason: string; }
export interface SkillMeta {
  name: string; version: string; description: string; author: string;
  dangerLevel: SkillDangerLevel; capabilities: SkillCapability[]; dependencies: SkillDependency[];
  triggers: string[]; createdAt: string; updatedAt: string;
  stats: { totalCalls: number; successCalls: number; failCalls: number; avgDurationMs: number };
  status: 'draft' | 'testing' | 'active' | 'disabled' | 'deprecated';
}
export interface SkillApply {
  id: string; name: string; reason: string; expectedFunction: string; gapContext: string;
  priority: 'P0' | 'P1' | 'P2'; dangerLevel: SkillDangerLevel;
  status: 'pending' | 'approved' | 'rejected' | 'developing' | 'testing' | 'complete';
  createdAt: string; resolvedAt?: string; rejectReason?: string; skillMeta?: SkillMeta;
}
export interface SkillAuditResult {
  approved: boolean; reason: string; rule: string; needsHumanReview: boolean; riskScore: number;
}
export interface SkillTestResult {
  skillName: string; passed: boolean;
  tests: { caseName: string; passed: boolean; output: string; expected: string; durationMs: number }[];
  summary: string;
}
