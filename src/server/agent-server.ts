// Agent HTTP Server — REST + WebSocket 对外服务
// 端口 19701
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AgentCore } from '@agent-system/core';
import { agentEventBus } from '@agent-system/events';
import { initConfig, getConfig } from '@agent-system/core';
import { logger, logContext } from '@agent-system/core';
import { getFullDashboard, getProjectsSummary, getSkillsSummary, getAuditSummary, getModelSummary, getHealthSummary, getMemorySummary, getContextSummary, getFileListing, getLogStatus, getResilienceSummary } from './dashboard-api';
import { sessionStore } from './session-store';
import { createRouter, RouteDeps } from './routes';
import { createRouteContext, parseUrl } from './routes/router';

const PORT = parseInt(process.env.PORT || String(getConfig().server?.port || 19701), 10);
const STATIC_DIR = path.resolve(__dirname, '..', '..');

// ─── MIME ───
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

async function serveStatic(res: http.ServerResponse, filePath: string) {
  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || stat.isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const content = await fs.promises.readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(content);
  } catch {
    res.writeHead(500);
    res.end('Server error');
  }
}

// ─── 全局 agent 实例 ───
let agent: AgentCore | null = null;
let agentInitPromise: Promise<AgentCore> | null = null;
let agentReady = false;

// ─── 聊天请求互斥锁（LM Studio 串行推理，避免并发请求互相阻塞） ───
let chatMutex: Promise<void> = Promise.resolve();
let streamChatInProgress = false;

async function withChatMutex<T>(fn: () => Promise<T>): Promise<T> {
  // 等待前一个请求完成
  const previous = chatMutex;
  let resolve!: () => void;
  chatMutex = new Promise<void>((r) => { resolve = r; });
  await previous;
  try {
    return await fn();
  } finally {
    resolve();
  }
}

// ─── SSE 心跳保活（防止代理/浏览器超时断连） ───
// 每 25 秒发送一个注释行，保持连接活跃
const SSE_HEARTBEAT_INTERVAL_MS = 25000;
let sseHeartbeatTimer: NodeJS.Timeout | null = null;
function startSseHeartbeat() {
  if (sseHeartbeatTimer) return;
  sseHeartbeatTimer = setInterval(() => {
    for (const c of sseClients) {
      try {
        // SSE 协议：以冒号开头的行是注释，客户端会忽略
        c.write(': heartbeat\n\n');
      } catch {
        sseClients.delete(c);
      }
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);
  // 不阻止进程退出
  sseHeartbeatTimer.unref();
}
function stopSseHeartbeat() {
  if (sseHeartbeatTimer) {
    clearInterval(sseHeartbeatTimer);
    sseHeartbeatTimer = null;
  }
}

async function ensureAgent(): Promise<AgentCore> {
  if (agent && agentReady) return agent;
  // 防止并发初始化
  if (agentInitPromise) return agentInitPromise;

  agentInitPromise = (async () => {
    const cfg = getConfig().logging;
    const logLevel = (cfg?.level as 'debug' | 'info' | 'warn' | 'error') || 'info';
    logger.setLevel(logLevel);
    logger.setMaxFileSize(cfg?.maxFileSizeMB ?? 10);
    logger.setMaxRotatedFiles(cfg?.maxRotatedFiles ?? 5);
    logger.info(`[AgentServer] 日志级别: ${logLevel}, 轮转阈值: ${cfg?.maxFileSizeMB ?? 10}MB, 保留: ${cfg?.maxRotatedFiles ?? 5}个`);
    agent = new AgentCore();
    // 初始化会话存储
    await sessionStore.init(path.resolve(__dirname, '..', '..', 'data'));
    const initMsg = await agent.init();
    if (initMsg) logger.info('[AgentServer] ' + initMsg.replace(/\n/g, ' '));
    agentReady = true;
    logger.info('[AgentServer] Agent 就绪');
    broadcastSSE({ type: 'ready' });
    // 监听 Agent 事件总线，转发为 SSE
    agentEventBus.on('status', (data) => {
      broadcastSSE({ type: 'agent_status', ...data });
    });
    // 监听 model_payload 事件（模型请求调试用）
    agentEventBus.on('model_payload', (data) => {
      broadcastSSE({ type: 'model_payload', ...data });
    });
    return agent;
  })();

  return agentInitPromise;
}

// ─── SSE 事件推送 ───
const sseClients = new Set<http.ServerResponse>();

function broadcastSSE(data: any) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(msg); } catch { sseClients.delete(c); }
  }
}

// ─── 路由表（渐进式迁移：简单 GET 路由由路由表处理，复杂路由保留 if-else） ───
const routeDeps: RouteDeps = {
  get agentReady() { return agentReady; },
  get agent() { return agent; },
  ensureAgent,
  broadcastSSE,
  getFullDashboard,
  getProjectsSummary,
  getSkillsSummary,
  getModelSummary,
  getHealthSummary,
  getMemorySummary,
  getContextSummary,
  getLogStatus,
  getLogErrors: (limit: number) => {
    // 从 dashboard-api 获取错误日志
    try {
      const logDir = path.join(process.cwd(), 'logs');
      const files = fs.readdirSync(logDir).filter(f => f.includes('error') && f.endsWith('.log'));
      const errors: any[] = [];
      for (const f of files.slice(-3)) {
        const content = fs.readFileSync(path.join(logDir, f), 'utf8');
        const lines = content.split('\n').filter(Boolean).slice(-limit);
        errors.push(...lines.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }));
      }
      return { errors, count: errors.length };
    } catch { return { errors: [], count: 0 }; }
  },
  getLogContent: (filename: string) => {
    try {
      const logDir = path.join(process.cwd(), 'logs');
      const today = new Date().toISOString().split('T')[0];
      const target = filename || `${today}.log`;
      return fs.readFileSync(path.join(logDir, target), 'utf8');
    } catch { return ''; }
  },
  getLogModules: () => {
    // 从 logger 获取模块级日志配置
    return { modules: {}, note: 'use POST /api/logs/modules to configure' };
  },
  getResilienceStatus: (agent: any) => getResilienceSummary(agent),
  getTraceList: async (agent: any) => {
    try {
      const { getRecentTraces } = await import('@agent-system/resilience');
      return getRecentTraces(50);
    } catch { return { traces: [], note: 'tracer not available' }; }
  },
  getTrace: (traceId: string) => ({ traceId, note: 'not implemented' }),
  getAssemblyList: () => ({ assemblies: [], note: 'not implemented' }),
  getAssembly: (id: string) => ({ id, note: 'not implemented' }),
  getModels: async (agent: any) => {
    if (!agent) return { models: [], current: null, providers: [] };
    const cfg = getConfig();
    const providerUrl = cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1';
    let models: any[] = [];
    let connected = false;
    try {
      models = await agent.adapter.listAllModels();
      connected = models.length > 0;
    } catch { /* fall through */ }
    if (models.length === 0) {
      try {
        const lmRes = await fetch(`${providerUrl}/models`, { signal: AbortSignal.timeout(5000) });
        const lmData: any = await lmRes.json();
        const loadedIds = new Set((lmData.data || []).map((m: any) => m.id));
        connected = lmData.data?.length > 0;
        try {
          const restRes = await fetch(`${providerUrl.replace('/v1', '/api/v1')}/models`, { signal: AbortSignal.timeout(8000) });
          const restData: any = await restRes.json();
          const restModels = restData.models || [];
          models = restModels.map((m: any) => ({
            id: m.key, object: 'model', type: m.type || 'llm', publisher: m.publisher || 'unknown',
            arch: m.architecture || 'unknown', context_length: m.max_context_length || 0,
            display_name: m.display_name, quantization: m.quantization?.name,
            params_string: m.params_string || undefined, size_bytes: m.size_bytes,
            loaded: (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0) || loadedIds.has(m.key),
            capabilities: { vision: m.capabilities?.vision || false, trained_for_tool_use: m.capabilities?.trained_for_tool_use || false, reasoning: !!m.capabilities?.reasoning },
          }));
          for (const lm of (lmData.data || [])) {
            if (!models.some(m => m.id === lm.id)) {
              models.push({ id: lm.id, object: 'model', type: 'llm', publisher: lm.owned_by || 'unknown', arch: 'unknown', context_length: 0, loaded: true });
            }
          }
        } catch {
          models = (lmData.data || []).map((m: any) => ({ id: m.id, object: 'model', type: 'llm', publisher: m.owned_by || 'unknown', arch: 'unknown', context_length: 0, loaded: true }));
        }
      } catch { /* connected stays false */ }
    }
    let currentModel = cfg.models?.providers?.lmstudio?.model || 'unknown';
    try { currentModel = agent.adapter.model; } catch { /* ignore */ }
    const currentModelOnline = models.some((m: any) => m.id === currentModel && m.loaded);
    const loadedCount = models.filter((m: any) => m.loaded).length;
    return { models, current: currentModel, currentModelOnline, timeout: cfg.agent?.callTimeoutMs || 60000, lmStudioUrl: providerUrl, connected, loadedCount, totalCount: models.length };
  },
  getConfig: () => getConfig(),
  getSessions: () => sessionStore.listSessions(),
  getSession: (id: string) => sessionStore.getSession(id),
  createSession: (title?: string) => sessionStore.createSession(title),
  renameSession: (id: string, title: string) => sessionStore.renameSession(id, title),
  updateMessages: (id: string, messages: any[]) => sessionStore.updateMessages(id, messages),
  deleteSession: (id: string) => sessionStore.deleteSession(id),
  getDashboardModels: getModelSummary,
  sseClients,
  // config 写入（routes/index.ts POST /api/config 需要）
  updateConfig: async (updates: any): Promise<{ changes: Record<string, unknown> }> => {
    const { model, callTimeoutMs, maxRetries, maxTokens, chatTimeoutMs } = updates;
    const validatedTimeout = (v: unknown, name: string, min: number, max: number): number | null => {
      if (v === undefined || v === null) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${name}: ${v} (must be ${min}-${max})`);
      return Math.floor(n);
    };
    const yamlPath = path.resolve(__dirname, '..', '..', 'config', 'agent-system.yaml');
    const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
    const yamlConfig: any = yaml.load(yamlContent) || {};
    const changes: Record<string, unknown> = {};
    const setNested = (obj: any, keys: string[], value: any) => {
      let cur = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = value;
    };
    if (model !== undefined) { yamlConfig.models = yamlConfig.models || {}; yamlConfig.models.provider = model; changes['model'] = model; }
    const tOut = validatedTimeout(callTimeoutMs, 'callTimeoutMs', 5000, 600000);
    if (tOut !== null) { setNested(yamlConfig, ['agent', 'callTimeoutMs'], tOut); changes['callTimeoutMs'] = tOut; }
    const mRetries = validatedTimeout(maxRetries, 'maxRetries', 0, 10);
    if (mRetries !== null) { setNested(yamlConfig, ['agent', 'maxRetries'], mRetries); changes['maxRetries'] = mRetries; }
    const mTokens = validatedTimeout(maxTokens, 'maxTokens', 128, 128000);
    if (mTokens !== null) { setNested(yamlConfig, ['agent', 'maxOutputTokens'], mTokens); changes['maxTokens'] = mTokens; }
    const cTimeout = validatedTimeout(chatTimeoutMs, 'chatTimeoutMs', 10000, 3600000);
    if (cTimeout !== null) { setNested(yamlConfig, ['server', 'chatTimeoutMs'], cTimeout); changes['chatTimeoutMs'] = cTimeout; }
    if (Object.keys(changes).length > 0) {
      fs.writeFileSync(yamlPath, yaml.dump(yamlConfig), 'utf-8');
    }
    return { changes };
  },
  logger: {
    setLevel: (level: string) => logger.setLevel(level as any),
    getLevel: () => logger.getLevel(),
    cleanupOldLogs: () => logger.cleanupOldLogs(),
    setModuleLevel: (module: string, level: string | null) => logger.setModuleLevel(module, level as any),
    getModuleLevels: () => logger.getModuleLevels(),
    setBufferSize: (size: number) => logger.setBufferSize(size),
    flush: () => logger.flush(),
    setJsonFormat: (enabled: boolean) => logger.setJsonFormat(enabled),
    getJsonFormat: () => logger.getJsonFormat(),
  },
  // 模型管理
  switchModel: async (modelId: string) => {
    if (!agent) throw new Error('Agent 尚未初始化');
    const cfg = getConfig();
    const providerUrl = cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1';
    let modelInfo: any = null;
    try {
      const lmRes = await fetch(`${providerUrl}/models`, { signal: AbortSignal.timeout(5000) });
      const lmData: any = await lmRes.json();
      const found = (lmData.data || []).find((m: any) => m.id === modelId);
      if (!found) throw new Error(`模型 "${modelId}" 未在 LM Studio 中加载`);
      modelInfo = found;
    } catch (err: any) {
      if (err.message?.includes('未在 LM Studio')) throw err;
      throw new Error(`无法连接 LM Studio: ${err.message}`);
    }
    const oldModel = agent.adapter.model;
    agent.adapter.setModel(modelId);
    if (modelInfo.context_length) {
      try { (agent.adapter as any).raw.contextLength = modelInfo.context_length; } catch { /* ignore */ }
    }
    try {
      const yamlPath = path.resolve(__dirname, '..', '..', 'config', 'agent-system.yaml');
      const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
      const updated = yamlContent.replace(/(\s+model:\s*")[^"]+(")/, `$1${modelId}$2`);
      if (updated !== yamlContent) {
        fs.writeFileSync(yamlPath, updated, 'utf-8');
        logger.info(`[AgentServer] 模型切换已持久化到 YAML: ${oldModel} → ${modelId}`);
      }
    } catch (yamlErr: any) {
      logger.warn('[AgentServer] 更新 YAML 模型配置失败', yamlErr);
    }
    try { initConfig(); } catch { /* ignore */ }
    logger.info(`[AgentServer] 模型热切换: ${oldModel} → ${modelId} (context=${modelInfo.context_length || '?'})`);
    return {
      previousModel: oldModel,
      currentModel: modelId,
      contextLength: modelInfo.context_length || 0,
      arch: modelInfo.arch || 'unknown',
      publisher: modelInfo.publisher || 'unknown',
    };
  },
  scanModels: async () => {
    let models: any[] = [];
    let currentModel = 'unknown';
    let connected = false;
    if (agent && agentReady) {
      try {
        models = await agent.adapter.listAllModels();
        connected = models.length > 0;
        currentModel = agent.adapter.model;
      } catch { /* fall through */ }
    }
    if (models.length === 0) {
      const cfg = getConfig();
      const providerUrl = cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1';
      try {
        const lmRes = await fetch(`${providerUrl}/models`, { signal: AbortSignal.timeout(5000) });
        const lmData: any = await lmRes.json();
        const loadedIds = new Set((lmData.data || []).map((m: any) => m.id));
        connected = !!lmData.data?.length;
        const restRes = await fetch(`${providerUrl.replace('/v1', '/api/v1')}/models`, { signal: AbortSignal.timeout(8000) });
        const restData: any = await restRes.json();
        const restModels = restData.models || [];
        models = restModels.map((m: any) => ({
          id: m.key, object: 'model', type: m.type || 'llm', publisher: m.publisher || 'unknown',
          arch: m.architecture || 'unknown', context_length: m.max_context_length || 0,
          display_name: m.display_name, quantization: m.quantization?.name,
          params_string: m.params_string || undefined, size_bytes: m.size_bytes,
          loaded: (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0) || loadedIds.has(m.key),
          capabilities: {
            vision: m.capabilities?.vision || false,
            trained_for_tool_use: m.capabilities?.trained_for_tool_use || false,
            reasoning: !!m.capabilities?.reasoning,
          },
        }));
        for (const lm of (lmData.data || [])) {
          if (!models.some(m => m.id === lm.id)) {
            models.push({ id: lm.id, object: 'model', type: 'llm', publisher: lm.owned_by || 'unknown', arch: 'unknown', context_length: 0, loaded: true });
          }
        }
      } catch { /* models stays empty */ }
      currentModel = cfg.models?.providers?.lmstudio?.model || 'unknown';
      if (agent && agentReady) {
        try { currentModel = agent.adapter.model; } catch { /* ignore */ }
      }
    }
    const currentModelOnline = models.some((m: any) => m.id === currentModel);
    const loadedCount = models.filter((m: any) => m.loaded).length;
    return {
      ok: true, models, current: currentModel, currentModelOnline,
      count: models.length, loadedCount, totalCount: models.length, connected,
    };
  },
  loadModel: async (model: string, options: any) => {
    if (agent && agentReady) {
      return await agent.adapter.loadModel(model, options);
    }
    const cfg = getConfig();
    const restUrl = (cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1').replace(/\/v1\/?$/, '/api/v1');
    const loadRes = await fetch(`${restUrl}/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...options }),
      signal: AbortSignal.timeout(120000),
    });
    if (!loadRes.ok) {
      const errText = await loadRes.text().catch(() => '');
      throw new Error(`Load failed (${loadRes.status}): ${errText}`);
    }
    return await loadRes.json();
  },
  unloadModel: async (instanceId: string) => {
    if (agent && agentReady) {
      return await agent.adapter.unloadModel(instanceId);
    }
    const cfg = getConfig();
    const restUrl = (cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1').replace(/\/v1\/?$/, '/api/v1');
    const unloadRes = await fetch(`${restUrl}/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: instanceId }),
      signal: AbortSignal.timeout(30000),
    });
    if (!unloadRes.ok) {
      const errText = await unloadRes.text().catch(() => '');
      throw new Error(`Unload failed (${unloadRes.status}): ${errText}`);
    }
    return await unloadRes.json();
  },
  // 聊天
  sendChat: async (message: string) => {
    const ag = await ensureAgent();
    return withChatMutex(() => ag.sendMessage(message));
  },
  sendChatStream: async (message: string, writers: any) => {
    const ag = await ensureAgent();
    agentEventBus.on('chat_chunk', writers.onChunk);
    agentEventBus.on('chat_done', writers.onDone);
    agentEventBus.on('chat_error', writers.onError);
    try {
      const fullReply = await ag.sendMessageStream(message);
      agentEventBus.off('chat_chunk', writers.onChunk);
      agentEventBus.off('chat_done', writers.onDone);
      agentEventBus.off('chat_error', writers.onError);
      return fullReply;
    } catch (err: any) {
      agentEventBus.off('chat_chunk', writers.onChunk);
      agentEventBus.off('chat_done', writers.onDone);
      agentEventBus.off('chat_error', writers.onError);
      throw err;
    }
  },
  // 文件上传
  saveUpload: async (rawBody: Buffer, contentType: string) => {
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) throw new Error('缺少 boundary');
    const parsed = parseMultipart(rawBody, boundary);
    if (!parsed || !parsed.filename) throw new Error('未找到文件');
    const uploadsDir = path.resolve(STATIC_DIR, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const ext = path.extname(parsed.filename);
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const filePath = path.join(uploadsDir, uniqueName);
    fs.writeFileSync(filePath, parsed.data);
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext.toLowerCase());
    return {
      ok: true,
      url: `/uploads/${uniqueName}`,
      filename: parsed.filename,
      isImage,
      size: parsed.data.length,
    };
  },
  // trace 报告
  getTraceReport: (sessionId?: string) => {
    try {
      const tracerModule = require('@agent-system/resilience');
      return sessionId ? tracerModule.getTraceReport(sessionId) : tracerModule.getTraceReport();
    } catch { return null; }
  },
  getAssemblyReport: (sessionId?: string) => {
    try {
      const inspector = require('@agent-system/resilience');
      return sessionId ? inspector.getAssemblyReport(sessionId) : inspector.getAssemblyReport();
    } catch { return null; }
  },
  // 流式聊天并发标志
  streamChatInProgress: { get value() { return streamChatInProgress; }, set value(v: boolean) { streamChatInProgress = v; } },
};
const router = createRouter(routeDeps);

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url || '/';

  // 注入 traceId 到 AsyncLocalStorage 上下文
  const traceId = req.headers['x-trace-id'] as string ||
    req.url?.match(/[?&]trace=([^&]+)/)?.[1] ||
    'req_' + Date.now().toString(36);

  return logContext.run({ traceId }, async () => {

  // ─── 路由表查找（渐进式迁移：先查路由表，未命中则 fall through 到原有 if-else） ───
  const { pathname } = parseUrl(url);
  const method = (req.method || 'GET') as any;
  try {
    const match = await router.lookup(method, pathname);
    if (match) {
      // 更新 agent 状态到 routeDeps
      const ctx = await createRouteContext(req, res, match.params);
      await router.execute(match.entry, ctx);
      return;
    }
  } catch (err: any) {
    logger.warn(`[Router] 路由处理错误: ${err?.message || err}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err?.message || 'router error' }));
    return;
  }

  // 只允许 GET 的 API 路由
  function isGet(): boolean { return req.method === 'GET'; }
  function isPost(): boolean { return req.method === 'POST'; }

  // 路径安全检查：禁止 .. 目录穿越和绝对路径
  function safePath(input: string): string | null {
    // URL 解码（防御 %2e%2e 等编码绕过）
    const decoded = decodeURIComponent(input);
    // 全方位检测目录穿越
    if (decoded.includes('..') || decoded.includes('~') || /^[A-Za-z]:/.test(decoded)) return null;
    const resolved = path.resolve(STATIC_DIR, '.' + decoded);
    if (!resolved.startsWith(STATIC_DIR)) return null;
    // 再次检查 resolved 中是否有相对路径残留（Windows 需处理 \ 分隔符）
    const normalizedResolved = resolved.replace(/\\/g, '/');
    const normalizedStatic = STATIC_DIR.replace(/\\/g, '/');
    if (!normalizedResolved.startsWith(normalizedStatic)) return null;
    return decoded;
  }

  // 静态文件服务：/uploads/
  if (url.startsWith('/uploads/')) {
    const sanitized = safePath(url);
    if (!sanitized) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    const staticPath = path.resolve(STATIC_DIR, '.' + sanitized);
    if (!staticPath.startsWith(STATIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    await serveStatic(res, staticPath);
    return;
  }

    // API: GET /api/files?dir=xxx — 文件浏览
  if (url.startsWith('/api/files') && isGet()) {
    const parsedUrl = new URL(url, 'http://localhost');
    const dir = parsedUrl.searchParams.get('dir') || '';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getFileListing(dir)));
    return;
  }

  // 静态页面 — 带路径穿越防护
  const cleanUrl = url === '/' ? '/agent-ui.html' : url === '/admin' || url === '/admin/' ? '/admin-panel.html' : url === '/chat' ? '/agent-ui.html' : url === '/audit' ? '/audit-dashboard.html' : url;
  const sanitized = safePath(cleanUrl.replace(/\?.*$/, ''));
  if (!sanitized) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: path contains directory traversal');
    return;
  }
  const staticPath = path.resolve(STATIC_DIR, '.' + sanitized);
  // resolve 后校验是否仍在 STATIC_DIR 下
  if (!staticPath.startsWith(STATIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: path escape detected');
    return;
  }
  // 禁止直接访问敏感目录（config/, dist/, src/, node_modules/, .git/ 等）
  const RELATIVE = path.relative(STATIC_DIR, staticPath).toLowerCase();
  if (RELATIVE.startsWith('config') || RELATIVE.startsWith('dist') || RELATIVE.startsWith('src') || RELATIVE.startsWith('node_modules') || RELATIVE.startsWith('.git') || RELATIVE.startsWith('.qclaw') || RELATIVE.startsWith('.claw')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: accessing restricted directory');
    return;
  }
  await serveStatic(res, staticPath);

  }); // end logContext.run
});

// 快捷函数：获取当前请求的 traceId（供 tracer 等模块使用）
export function getCurrentTraceId(): string | null {
  return logger.getTraceId();
}

function readBody(req: http.IncomingMessage, maxBytes: number = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > maxBytes) reject(new Error(`body too large (limit: ${maxBytes} bytes)`)); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** 解析 multipart/form-data — 提取第一个文件 */
function parseMultipart(buffer: Buffer, boundary: string): { filename: string; data: Buffer } | null {
  const boundaryBuffer = Buffer.from('--' + boundary);
  const parts: Buffer[] = [];
  let start = 0;

  // 按 boundary 分割
  while (true) {
    const idx = buffer.indexOf(boundaryBuffer, start);
    if (idx === -1) break;
    if (start > 0) {
      parts.push(buffer.slice(start, idx - 2)); // -2 for \r\n before boundary
    }
    start = idx + boundaryBuffer.length + 2; // +2 for \r\n after boundary
  }

  // 处理每个 part，找到包含文件的 part
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerStr = part.slice(0, headerEnd).toString('utf-8');
    const fileData = part.slice(headerEnd + 4, part.length - 2); // -2 for trailing \r\n

    // 解析 Content-Disposition
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    if (!filenameMatch) continue;

    const filename = filenameMatch[1];
    if (!filename) continue;

    return { filename, data: fileData };
  }

  return null;
}

// ─── 启动 ───
// 先加载配置（必须在 listen 之前执行，否则 getConfig() 会因竞态抛出「未加载」）
initConfig();

logger.info(`[Startup] 准备监听端口 ${PORT}...`);

server.listen(PORT, '127.0.0.1', () => {
  logger.info(`[Startup] ✓ 端口 ${PORT} 监听成功`);
  logger.info(`Agent HTTP Server: http://127.0.0.1:${PORT}`);
  startSseHeartbeat();
  ensureAgent().catch(err => logger.error('[AgentServer] 初始化失败:', err.message));
});

server.on('error', (err) => {
  logger.error(`[Startup] ✗ 监听失败:`, err);
});

// ─── 优雅关闭 ───
let shuttingDown = false;
function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Shutdown] 收到 ${signal}，开始优雅关闭...`);

  // 1. 停止接受新连接
  server.close(() => {
    logger.info('[Shutdown] ✓ HTTP 服务器已关闭');
  });

  // 2. 停止 Agent（保存会话/审计/摘要）
  try {
    agent?.stop();
    logger.info('[Shutdown] ✓ Agent 已停止');
  } catch (err: any) {
    logger.error('[Shutdown] Agent 停止失败:', err?.message);
  }

  // 3. 关闭所有 SSE 客户端连接
  stopSseHeartbeat();
  for (const c of sseClients) {
    try { c.end(); } catch { /* ignore */ }
  }
  sseClients.clear();

  // 4. 等待 1 秒让清理完成，然后强制退出
  setTimeout(() => {
    logger.info('[Shutdown] 完成，退出进程');
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─── 全局未捕获异常兜底（防止进程崩溃） ───
process.on('unhandledRejection', (reason, promise) => {
  logger.error('[UnhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('[UncaughtException]', err);
  // 不立即退出，记录后继续运行（避免单次错误导致服务中断）
  // 但如果是致命错误（如 EADDRINUSE），仍会触发 gracefulShutdown
});
