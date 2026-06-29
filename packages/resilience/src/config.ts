// Resilience package — config interface (decoupled from root project)

/** 获取配置段（需要在根项目集成时注入） */
export function getConfigSection(section: string): any {
  return {};
}

/** 获取完整配置 */
export function getConfig(): any {
  return {};
}

export interface CompiledNonsenseConfig {
  enabled: boolean;
  maxRepeats: number;
  minUniqueTokens: number;
  patterns: RegExp[];
  checkIntervalMs: number;
  thresholds: {
    repeatCount: number;
    shortResponseRatio: number;
    stuckTimeoutMs: number;
    minEffectiveChars: number;
    highRepeatRatio: number;
    highRepeatMinLength: number;
    loopDetectMinLength: number;
    loopDetectMinStrippedLength: number;
    lowDiversityRatio: number;
    lowDiversityMinLength: number;
  };
  crashPatterns: RegExp[];
  customRules: Array<{
    pattern: string;
    regex?: RegExp;
    name?: string;
    level: string;
    active: boolean;
  }>;
  maxConversationDurationMs: number;
}

/** 获取 nonsense 配置 */
export function getNonsenseConfig(): CompiledNonsenseConfig {
  return {
    enabled: true,
    maxRepeats: 3,
    minUniqueTokens: 5,
    patterns: [],
    checkIntervalMs: 30000,
    thresholds: {
      repeatCount: 5,
      shortResponseRatio: 0.7,
      stuckTimeoutMs: 120000,
      minEffectiveChars: 3,
      highRepeatRatio: 0.5,
      highRepeatMinLength: 10,
      loopDetectMinLength: 8,
      loopDetectMinStrippedLength: 4,
      lowDiversityRatio: 0.2,
      lowDiversityMinLength: 10,
    },
    crashPatterns: [],
    customRules: [],
    maxConversationDurationMs: 600000,
  };
}
