"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = void 0;
exports.getConfigFilePath = getConfigFilePath;
exports.initConfig = initConfig;
exports.getConfig = getConfig;
exports.getConfigSection = getConfigSection;
exports.reloadConfig = reloadConfig;
exports.getConfigLastLoadTime = getConfigLastLoadTime;
exports.getNonsenseConfig = getNonsenseConfig;
exports.formatConfig = formatConfig;
// ═══════════════════════════════════════════════════════════════
// Agent System Config — 用户可编辑全局配置加载器
// ═══════════════════════════════════════════════════════════════
// 从 config/agent-system.yaml 读取配置，合并默认值，提供类型安全接口。
// 支持热重载（/config reload 命令）。
// ═══════════════════════════════════════════════════════════════
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml = __importStar(require("js-yaml"));
const logger_1 = __importDefault(require("../logger"));
// ── 默认配置 ──
exports.DEFAULT_CONFIG = {
    system: { name: 'agent-system', version: '0.6.4' },
    models: {
        defaultProvider: 'lmstudio',
        providers: {
            lmstudio: {
                baseUrl: 'http://127.0.0.1:1234/v1',
                apiKey: 'not-needed',
                model: 'qwen/qwen3.5-9b',
                timeoutMs: 120000,
                maxTokens: 512,
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
let currentConfig = { ...exports.DEFAULT_CONFIG };
let configFilePath = '';
let lastLoadTime = 0;
// 编译自定义正则（创建时预编译）
let compiledCrashPatterns = [];
let compiledCustomRules = [];
// ── YAML 值校验 / 类型安全合并 ──
function deepMergeDefaults(user, defaults) {
    if (typeof defaults !== 'object' || defaults === null)
        return user ?? defaults;
    if (typeof user !== 'object' || user === null)
        return defaults;
    const result = {};
    for (const key of Object.keys(defaults)) {
        if (key in user) {
            if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
                result[key] = deepMergeDefaults(user[key], defaults[key]);
            }
            else {
                // 类型检查：跳过明显类型不匹配的值，回退到默认
                const expectedType = typeof defaults[key];
                const actualType = typeof user[key];
                if (expectedType === actualType || Array.isArray(defaults[key]) === Array.isArray(user[key])) {
                    result[key] = user[key];
                }
                else {
                    logger_1.default.warn(`[Config] 字段 "${key}" 类型不匹配（期望 ${expectedType}，实际 ${actualType}），使用默认值`);
                    result[key] = defaults[key];
                }
            }
        }
        else {
            result[key] = defaults[key];
        }
    }
    return result;
}
// ── 重新编译自定义规则 ──
function recompileCustomPatterns() {
    const nonsense = currentConfig.nonsense;
    compiledCrashPatterns = (nonsense.customCrashPatterns || []).map((p) => {
        try {
            return new RegExp(p, 'i');
        }
        catch (e) {
            logger_1.default.warn(`[Config] 自定义崩溃模式正则无效: "${p}" — ${e.message}，已跳过`);
            return null;
        }
    }).filter(Boolean);
    compiledCustomRules = (nonsense.customRules || []).map((rule) => {
        if (!rule.active)
            return null;
        try {
            return { name: rule.name, regex: new RegExp(rule.pattern), active: rule.active !== false };
        }
        catch (e) {
            logger_1.default.warn(`[Config] 自定义规则正则无效: "${rule.pattern}" — ${e.message}，已跳过`);
            return null;
        }
    }).filter(Boolean);
}
// ── 加载 YAML ──
function loadYamlFile(filePath) {
    if (!fs.existsSync(filePath)) {
        logger_1.default.warn(`[Config] 配置文件不存在: ${filePath}，使用默认配置`);
        return { ...exports.DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    let parsed;
    try {
        parsed = yaml.load(raw);
    }
    catch (e) {
        logger_1.default.error(`[Config] YAML 解析失败: ${e.message}，使用默认配置`);
        return { ...exports.DEFAULT_CONFIG };
    }
    if (!parsed || typeof parsed !== 'object') {
        logger_1.default.warn('[Config] 配置文件为空，使用默认配置');
        return { ...exports.DEFAULT_CONFIG };
    }
    return deepMergeDefaults(parsed, exports.DEFAULT_CONFIG);
}
// ── 公开 API ──
/**
 * 获取配置文件路径（用户编辑用）
 */
function getConfigFilePath() {
    return configFilePath;
}
/**
 * 初始化配置加载器
 * @param yamlPath 配置文件路径，默认 config/agent-system.yaml
 */
function initConfig(yamlPath) {
    configFilePath = yamlPath || path.join(process.cwd(), 'config', 'agent-system.yaml');
    currentConfig = loadYamlFile(configFilePath);
    lastLoadTime = Date.now();
    recompileCustomPatterns();
    logger_1.default.info(`[Config] ✅ 配置已加载 (${Object.keys(currentConfig).length} 个模块)`);
    return currentConfig;
}
/**
 * 获取当前完整配置（不可变快照）
 */
function getConfig() {
    return { ...currentConfig };
}
/**
 * 获取某模块配置
 */
function getConfigSection(key) {
    return { ...currentConfig[key] };
}
/**
 * 热重载配置文件
 * @returns { success, errors? }
 */
function reloadConfig() {
    if (!configFilePath) {
        initConfig();
        return { success: true };
    }
    try {
        const newConfig = loadYamlFile(configFilePath);
        currentConfig = newConfig;
        lastLoadTime = Date.now();
        recompileCustomPatterns();
        logger_1.default.info('[Config] 🔄 配置已热重载');
        return { success: true };
    }
    catch (e) {
        const msg = e.message;
        logger_1.default.error(`[Config] 热重载失败: ${msg}`);
        return { success: false, errors: msg };
    }
}
/**
 * 获取上次加载时间
 */
function getConfigLastLoadTime() {
    return lastLoadTime;
}
/**
 * 获取 NonsenseDetector 的编译后配置（含预编译正则）
 */
function getNonsenseConfig() {
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
function formatConfig() {
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
//# sourceMappingURL=agent-system-config.js.map