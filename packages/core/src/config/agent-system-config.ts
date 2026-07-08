// ═══════════════════════════════════════════════════════════════
// Agent System Config — 用户可编辑全局配置加载器
// ═══════════════════════════════════════════════════════════════
// 从 config/agent-system.yaml 读取配置，合并默认值，提供类型安全接口。
// 支持热重载（/config reload 命令）。
// ═══════════════════════════════════════════════════════════════
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import logger from '../logger';

/** 动态读取项目版本（避免硬编码版本号过时） */
function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.version || '0.9.2';
  } catch {
    return '0.9.2';
  }
}

// ── 完整配置接口 ──

export interface AgentSystemConfig {
  system: { name: string; version: string };
  models: {
    defaultProvider: string;
    providers: Record<string, {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
      maxOutputTokens?: number;
      reasoning?: 'off' | 'low' | 'medium' | 'high' | 'on';
    }>;
    customProviders?: Array<{
      id: string;
      name: string;
      baseUrl: string;
      apiKey: string;
      type: string;
      model: string;
    }>;
  };
  memory: {
    filePath: string;
    dbPath: string;
    strictRecording: boolean;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    maxFileSizeMB: number;
    maxRotatedFiles: number;
  };
  server?: {
    port?: number;
    chatTimeoutMs?: number;
    maxUploadSizeMB?: number;
  };
  agent: {
    loopIntervalMs: number;
    heartbeatIntervalMs: number;
    maxSubTasks: number;
    defaultTimeoutMs: number;
    callTimeoutMs: number;
    maxRetries: number;
    emptyLoopThreshold: number;
    debugLogging: boolean;
    skipIntentParsing: boolean;
  };
  context: {
    maxTokens: number;
    hotWindowSize: number;
    attentionEnabled: boolean;
  };
  nonsense: {
    checkIntervalMs: number;
    maxConversationDurationMs: number;
    thresholds: {
      minEffectiveChars: number;
      highRepeatRatio: number;
      highRepeatMinLength: number;
      loopDetectMinLength: number;
      loopDetectMinStrippedLength: number;
      lowDiversityRatio: number;
      lowDiversityMinLength: number;
    };
    customCrashPatterns: string[];
    customRules: Array<{
      name: string;
      pattern: string;
      active: boolean;
    }>;
  };
  diagnostics: {
    maxPingFailures: number;
    includeProbeSnapshot: boolean;
  };
  idleTasks: {
    defaultCooldownMs: number;
    defaultMaxFails: number;
  };
  circuitBreaker: {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenMaxRequests: number;
    halfOpenSuccessThreshold: number;
  };
  checkpoint: {
    contextWindow: number;
    maxRecoveryAttempts: number;
    dataDir: string;
  };
  probes: {
    concurrency: number;
    timeoutMs: number;
  };
  profiles: {
    dataDir: string;
  };
}

// ── 默认配置 ──

export const DEFAULT_CONFIG: AgentSystemConfig = {
  system: { name: 'agent-system', version: getVersion() },
  models: {
    defaultProvider: 'lmstudio',
    providers: {
      lmstudio: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'not-needed',
        model: 'qwen/qwen3.5-9b',
        timeoutMs: 300000,
        maxOutputTokens: 4096,
        reasoning: 'off',
      },
    },
    customProviders: [],
  },
  memory: {
    filePath: './memory',
    dbPath: './data/memory.db',
    strictRecording: true,
  },
  logging: {
    level: 'info',
    maxFileSizeMB: 10,
    maxRotatedFiles: 5,
  },
  agent: {
    loopIntervalMs: 1000,
    heartbeatIntervalMs: 300000,
    maxSubTasks: 10,
    defaultTimeoutMs: 600000,
    callTimeoutMs: 300000,
    maxRetries: 5,
    emptyLoopThreshold: 3,
    debugLogging: false,
    skipIntentParsing: false,
  },
  context: {
    maxTokens: 4000,
    hotWindowSize: 12,
    attentionEnabled: true,
  },
  nonsense: {
    checkIntervalMs: 10_000,
    maxConversationDurationMs: 0,
    thresholds: {
      minEffectiveChars: 2,
      highRepeatRatio: 0.6,
      highRepeatMinLength: 4,
      loopDetectMinLength: 10,
      loopDetectMinStrippedLength: 6,
      lowDiversityRatio: 0.4,
      lowDiversityMinLength: 9,
    },
    customCrashPatterns: [],
    customRules: [],
  },
  diagnostics: {
    maxPingFailures: 3,
    includeProbeSnapshot: true,
  },
  idleTasks: {
    defaultCooldownMs: 120_000,
    defaultMaxFails: 3,
  },
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    halfOpenMaxRequests: 3,
    halfOpenSuccessThreshold: 0.5,
  },
  checkpoint: {
    contextWindow: 20,
    maxRecoveryAttempts: 3,
    dataDir: 'data/checkpoints',
  },
  probes: {
    concurrency: 1,
    timeoutMs: 60_000,
  },
  profiles: {
    dataDir: 'data/profiles',
  },
};

// ── 内部状态 ──

let currentConfig: AgentSystemConfig = { ...DEFAULT_CONFIG };
let configFilePath: string = '';
let lastLoadTime = 0;

// 编译自定义正则（创建时预编译）
let compiledCrashPatterns: RegExp[] = [];
let compiledCustomRules: Array<{ name: string; regex: RegExp; active: boolean }> = [];

// ── YAML 值校验 / 类型安全合并 ──

function deepMergeDefaults(user: any, defaults: any): any {
  if (typeof defaults !== 'object' || defaults === null) return user ?? defaults;
  if (typeof user !== 'object' || user === null) return defaults;
  const result: any = {};
  for (const key of Object.keys(defaults)) {
    if (key in user) {
      if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
        result[key] = deepMergeDefaults(user[key], defaults[key]);
      } else {
        // 类型检查：跳过明显类型不匹配的值，回退到默认
        const expectedType = typeof defaults[key];
        const actualType = typeof user[key];
        if (expectedType === actualType || Array.isArray(defaults[key]) === Array.isArray(user[key])) {
          result[key] = user[key];
        } else {
          logger.warn(`[Config] 字段 "${key}" 类型不匹配（期望 ${expectedType}，实际 ${actualType}），使用默认值`);
          result[key] = defaults[key];
        }
      }
    } else {
      result[key] = defaults[key];
    }
  }
  return result;
}

// ── 重新编译自定义规则 ──

function recompileCustomPatterns(): void {
  const nonsense = currentConfig.nonsense;
  compiledCrashPatterns = (nonsense.customCrashPatterns || []).map((p: string) => {
    try {
      return new RegExp(p, 'i');
    } catch (e) {
      logger.warn(`[Config] 自定义崩溃模式正则无效: "${p}" — ${(e as Error).message}，已跳过`);
      return null;
    }
  }).filter(Boolean) as RegExp[];

  compiledCustomRules = (nonsense.customRules || []).map((rule: any) => {
    if (!rule.active) return null;
    try {
      return { name: rule.name, regex: new RegExp(rule.pattern), active: rule.active !== false };
    } catch (e) {
      logger.warn(`[Config] 自定义规则正则无效: "${rule.pattern}" — ${(e as Error).message}，已跳过`);
      return null;
    }
  }).filter(Boolean) as Array<{ name: string; regex: RegExp; active: boolean }>;
}

// ── 加载 YAML ──

function loadYamlFile(filePath: string): AgentSystemConfig {
  if (!fs.existsSync(filePath)) {
    logger.warn(`[Config] 配置文件不存在: ${filePath}，使用默认配置`);
    return { ...DEFAULT_CONFIG };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: any;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    logger.error(`[Config] YAML 解析失败: ${(e as Error).message}，使用默认配置`);
    return { ...DEFAULT_CONFIG };
  }

  if (!parsed || typeof parsed !== 'object') {
    logger.warn('[Config] 配置文件为空，使用默认配置');
    return { ...DEFAULT_CONFIG };
  }

  return deepMergeDefaults(parsed, DEFAULT_CONFIG) as AgentSystemConfig;
}

// ── 公开 API ──

/**
 * 获取配置文件路径（用户编辑用）
 */
export function getConfigFilePath(): string {
  return configFilePath;
}

/**
 * 初始化配置加载器
 * @param yamlPath 配置文件路径，默认 config/agent-system.yaml
 */
export function initConfig(yamlPath?: string): AgentSystemConfig {
  configFilePath = yamlPath || path.join(process.cwd(), 'config', 'agent-system.yaml');
  currentConfig = loadYamlFile(configFilePath);
  lastLoadTime = Date.now();
  recompileCustomPatterns();
  logger.info(`[Config] ✅ 配置已加载 (${Object.keys(currentConfig).length} 个模块)`);
  return currentConfig;
}

/**
 * 获取当前完整配置（不可变快照）
 */
export function getConfig(): AgentSystemConfig {
  return { ...currentConfig };
}

/**
 * 获取某模块配置
 */
export function getConfigSection<K extends keyof AgentSystemConfig>(key: K): AgentSystemConfig[K] {
  return { ...currentConfig[key] };
}

/**
 * 热重载配置文件
 * @returns { success, errors? }
 */
export function reloadConfig(): { success: boolean; errors?: string } {
  if (!configFilePath) {
    initConfig();
    return { success: true };
  }
  try {
    const newConfig = loadYamlFile(configFilePath);
    currentConfig = newConfig;
    lastLoadTime = Date.now();
    recompileCustomPatterns();
    logger.info('[Config] 🔄 配置已热重载');
    return { success: true };
  } catch (e) {
    const msg = (e as Error).message;
    logger.error(`[Config] 热重载失败: ${msg}`);
    return { success: false, errors: msg };
  }
}

/**
 * 获取上次加载时间
 */
export function getConfigLastLoadTime(): number {
  return lastLoadTime;
}

// ── NonsenseDetector 专用便捷访问器 ──

export interface CompiledNonsenseConfig {
  checkIntervalMs: number;
  maxConversationDurationMs: number;
  thresholds: AgentSystemConfig['nonsense']['thresholds'];
  crashPatterns: RegExp[];
  customRules: Array<{ name: string; regex: RegExp; active: boolean }>;
}

/**
 * 获取 NonsenseDetector 的编译后配置（含预编译正则）
 */
export function getNonsenseConfig(): CompiledNonsenseConfig {
  const cfg = currentConfig.nonsense;
  return {
    checkIntervalMs: cfg.checkIntervalMs,
    maxConversationDurationMs: cfg.maxConversationDurationMs,
    thresholds: { ...cfg.thresholds },
    crashPatterns: [...compiledCrashPatterns],
    customRules: [...compiledCustomRules],
  };
}

/**
 * 将当前配置格式化为可读字符串（用于 /config show 命令）
 */
export function formatConfig(): string {
  return [
    '📋 Agent System 配置',
    `  配置文件: ${configFilePath || '(未加载)'}`,
    `  最后加载: ${lastLoadTime ? new Date(lastLoadTime).toLocaleString('zh-CN') : '从未'}`,
    '',
    '  [agent]',
    `    调用超时: ${currentConfig.agent.callTimeoutMs}ms`,
    `    最大重试: ${currentConfig.agent.maxRetries} 次`,
    `    空循环阈值: ${currentConfig.agent.emptyLoopThreshold} 次`,
    '',
    '  [context]',
    `    最大 Token: ${currentConfig.context.maxTokens}`,
    `    热点窗口: ${currentConfig.context.hotWindowSize} 条`,
    `    注意力评分: ${currentConfig.context.attentionEnabled ? '开启' : '关闭'}`,
    '',
    '  [nonsense]',
    `    轮询间隔: ${currentConfig.nonsense.checkIntervalMs}ms`,
    `    挂起超时: ${currentConfig.nonsense.maxConversationDurationMs}ms ${currentConfig.nonsense.maxConversationDurationMs === 0 ? '(关闭)' : ''}`,
    `    高重复阈值: >${(currentConfig.nonsense.thresholds.highRepeatRatio * 100).toFixed(0)}%`,
    `    自定义规则: ${currentConfig.nonsense.customRules.length} 条`,
    `    自定义崩溃模式: ${currentConfig.nonsense.customCrashPatterns.length} 条`,
    '',
    '  [diagnostics]',
    `    最大 Ping 失败: ${currentConfig.diagnostics.maxPingFailures} 次`,
    `    探针快照: ${currentConfig.diagnostics.includeProbeSnapshot ? '开启' : '关闭'}`,
    '',
    '  [idleTasks]',
    `    默认冷却: ${(currentConfig.idleTasks.defaultCooldownMs / 1000).toFixed(0)}s`,
    `    默认最大失败: ${currentConfig.idleTasks.defaultMaxFails} 次`,
    '',
    '  [circuitBreaker]',
    `    失败阈值: ${currentConfig.circuitBreaker.failureThreshold} 次`,
    `    复位超时: ${(currentConfig.circuitBreaker.resetTimeoutMs / 1000).toFixed(0)}s`,
    `    半开请求数: ${currentConfig.circuitBreaker.halfOpenMaxRequests} 次`,
    `    半开成功率: ${(currentConfig.circuitBreaker.halfOpenSuccessThreshold * 100).toFixed(0)}%`,
    '',
    '  [checkpoint]',
    `    上下文窗口: ${currentConfig.checkpoint.contextWindow} 条`,
    `    最大恢复次数: ${currentConfig.checkpoint.maxRecoveryAttempts} 次`,
    '',
    '  [probes]',
    `    并发度: ${currentConfig.probes.concurrency}`,
    `    超时: ${(currentConfig.probes.timeoutMs / 1000).toFixed(0)}s`,
    '',
    `  💡 编辑 ${configFilePath} 后执行 /config reload 生效`,
  ].join('\n');
}
