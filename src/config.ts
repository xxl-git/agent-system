// config.ts — 向后兼容层，实际配置统一由 agent-system-config.ts 加载
// 所有新代码请直接 import { getConfig } from './config/agent-system-config'
import type { AgentSystemConfig } from './config/agent-system-config';
import {
  initConfig as initYamlConfig,
  getConfig as getYamlConfig,
  reloadConfig as reloadYamlConfig,
} from './config/agent-system-config';

export interface AppConfig {
  system: { name: string; version: string };
  models: {
    defaultProvider: string;
    providers: Record<string, {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
      maxTokens?: number;
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
  agent: {
    loopIntervalMs: number;
    heartbeatIntervalMs: number;
    maxSubTasks: number;
    defaultTimeoutMs: number;
    callTimeoutMs: number;
    maxRetries: number;
    emptyLoopThreshold: number;
  };
  context?: {
    maxTokens: number;
    hotWindowSize: number;
    summaryTokenBudget: number;
    compressionThreshold: number;
    preserveToolResults: boolean;
    preserveSystem: boolean;
    attentionEnabled: boolean;
  };
  memory: {
    filePath: string;
    dbPath: string;
    strictRecording: boolean;
  };
  logging: { level: string; dir: string; maxFileSizeMB?: number; maxRotatedFiles?: number };
  server?: {
    port: number;
    chatTimeoutMs: number;
    maxUploadSizeMB: number;
  };
}

function mapToAppConfig(y: AgentSystemConfig): AppConfig {
  const agentAny = (y as any).agent || {};
  const saAny = (y as any).smartAdapter || {};
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
      summaryTokenBudget: (y as any).context?.summaryTokenBudget ?? 512,
      compressionThreshold: (y as any).context?.compressionThreshold ?? 0.75,
      preserveToolResults: (y as any).context?.preserveToolResults ?? true,
      preserveSystem: (y as any).context?.preserveSystem ?? true,
      attentionEnabled: y.context.attentionEnabled,
    } : undefined,
    memory: y.memory,
    logging: { ...y.logging, dir: (y.logging as any).dir ?? './logs' },
    server: (y as any).server || { port: 19701, chatTimeoutMs: 120000, maxUploadSizeMB: 20 },
  };
}

let cached: AppConfig;

export function loadConfig(configPath?: string): AppConfig {
  const yamlPath = configPath || 'config/agent-system.yaml';
  initYamlConfig(yamlPath);
  cached = mapToAppConfig(getYamlConfig());
  return cached;
}

export function getConfig(): AppConfig {
  if (!cached) return loadConfig();
  return cached;
}

export function reloadConfigCompat(): { success: boolean; errors?: string } {
  const result = reloadYamlConfig();
  if (result.success) cached = mapToAppConfig(getYamlConfig());
  return result;
}
