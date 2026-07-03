"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.getConfig = getConfig;
exports.reloadConfigCompat = reloadConfigCompat;
const agent_system_config_1 = require("./config/agent-system-config");
function mapToAppConfig(y) {
    const agentAny = y.agent || {};
    const saAny = y.smartAdapter || {};
    return {
        system: y.system,
        models: y.models,
        agent: {
            loopIntervalMs: agentAny.loopIntervalMs ?? 1000,
            heartbeatIntervalMs: agentAny.heartbeatIntervalMs ?? 300000,
            maxSubTasks: agentAny.maxSubTasks ?? 10,
            defaultTimeoutMs: agentAny.defaultTimeoutMs ?? 600000,
            callTimeoutMs: saAny.callTimeoutMs ?? agentAny.callTimeoutMs ?? 120000,
            maxRetries: saAny.maxRetries ?? agentAny.maxRetries ?? 5,
            emptyLoopThreshold: saAny.emptyLoopThreshold ?? agentAny.emptyLoopThreshold ?? 3,
        },
        context: y.context ? {
            maxTokens: y.context.maxTokens,
            hotWindowSize: y.context.hotWindowSize,
            summaryTokenBudget: y.context?.summaryTokenBudget ?? 512,
            compressionThreshold: y.context?.compressionThreshold ?? 0.75,
            preserveToolResults: y.context?.preserveToolResults ?? true,
            preserveSystem: y.context?.preserveSystem ?? true,
            attentionEnabled: y.context.attentionEnabled,
        } : undefined,
        memory: y.memory,
        logging: { ...y.logging, dir: y.logging.dir ?? './logs' },
        server: y.server || { port: 19701, chatTimeoutMs: 120000, maxUploadSizeMB: 20 },
    };
}
let cached;
function loadConfig(configPath) {
    const yamlPath = configPath || 'config/agent-system.yaml';
    (0, agent_system_config_1.initConfig)(yamlPath);
    cached = mapToAppConfig((0, agent_system_config_1.getConfig)());
    return cached;
}
function getConfig() {
    if (!cached)
        return loadConfig();
    return cached;
}
function reloadConfigCompat() {
    const result = (0, agent_system_config_1.reloadConfig)();
    if (result.success)
        cached = mapToAppConfig((0, agent_system_config_1.getConfig)());
    return result;
}
//# sourceMappingURL=config.js.map