// 路由注册 — 将分散在 agent-server.ts 中的 if-else 路由提取为集中式路由表
// 渐进式迁移：先迁移简单 GET 路由，复杂路由保留在 agent-server.ts 中

import { Router, RouteContext, sendJson, sendError, readBodyStream } from './router.js';

// 外部依赖接口（由 agent-server.ts 注入）
export interface RouteDeps {
  agentReady: boolean;
  agent: any;
  ensureAgent: () => Promise<any>;
  broadcastSSE: (data: any) => void;
  // dashboard 模块
  getFullDashboard: (agent: any) => Promise<any>;
  getProjectsSummary: () => any;
  getSkillsSummary: () => any;
  getModelSummary: (agent: any) => Promise<any>;
  getHealthSummary: (agent: any) => any;
  getMemorySummary: (agent: any) => any;
  getContextSummary: (agent: any) => any;
  getLogStatus: () => any;
  getLogErrors: (limit: number) => any;
  getLogContent: (filename: string) => any;
  getLogModules: () => any;
  getResilienceStatus: (agent: any) => any;
  getTraceList: (agent: any) => Promise<any>;
  getTrace: (traceId: string) => any;
  getAssemblyList: () => any;
  getAssembly: (id: string) => any;
  getModels: (agent: any) => Promise<any>;
  getConfig: () => any;
  getSessions: () => any;
  getSession: (id: string) => any;
  createSession: (title?: string) => any;
  renameSession: (id: string, title: string) => void;
  updateMessages: (id: string, messages: any[]) => void;
  deleteSession: (id: string) => void;
  getDashboardModels: (agent: any) => Promise<any>;
  sseClients: Set<any>;
  // logger 模块（POST /api/logs/* 需要）
  logger: {
    setLevel: (level: string) => void;
    getLevel: () => string;
    cleanupOldLogs: () => number;
    setModuleLevel: (module: string, level: string | null) => void;
    getModuleLevels: () => any;
    setBufferSize: (size: number) => void;
    flush: () => void;
    setJsonFormat: (enabled: boolean) => void;
    getJsonFormat: () => boolean;
  };
  // config 写入（POST /api/config 需要）
  updateConfig: (updates: any) => Promise<{ changes: Record<string, unknown> }>;
  // 模型管理（POST /api/models/* 需要）
  switchModel: (modelId: string) => Promise<any>;
  scanModels: () => Promise<any>;
  loadModel: (model: string, options: any) => Promise<any>;
  unloadModel: (instanceId: string) => Promise<any>;
  // 聊天（POST /api/chat[/stream] 需要）
  sendChat: (message: string) => Promise<string>;
  sendChatStream: (message: string, writers: StreamWriters) => Promise<string>;
  // 文件上传（POST /api/upload 需要）
  saveUpload: (rawBody: Buffer, contentType: string) => Promise<any>;
  // trace 报告（GET /api/trace 需要）
  getTraceReport: (sessionId?: string) => any;
  getAssemblyReport: (sessionId?: string) => any;
  // 流式聊天并发标志（POST /api/chat/stream 需要）
  streamChatInProgress: { value: boolean };
}

export interface StreamWriters {
  onChunk: (chunk: string) => void;
  onDone: (data: { fullReply: string; durationMs: number }) => void;
  onError: (error: string) => void;
  onClose: () => void;
}

/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 创建并注册所有路由 */
export function createRouter(deps: RouteDeps): Router {
  const router = new Router();

  // ═══════════════════════════════════════════════════
  // 状态 & 健康
  // ═══════════════════════════════════════════════════

  router.get('/api/status', (ctx) => {
    sendJson(ctx.res, {
      status: deps.agentReady ? 'Agent v0.9.2' : 'initializing',
      model: deps.agentReady ? (deps.agent)?.adapter?.model || 'unknown' : 'loading...',
      sessionId: deps.agentReady ? (deps.agent)?.sessionId || '-' : '-',
      uptime: process.uptime(),
      ready: deps.agentReady,
    });
  });

  router.get('/api/health', (ctx) => {
    const healthy = deps.agentReady;
    sendJson(ctx.res, {
      status: healthy ? 'ok' : 'initializing',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }, healthy ? 200 : 503);
  });

  // ═══════════════════════════════════════════════════
  // Dashboard
  // ═══════════════════════════════════════════════════

  router.get('/api/dashboard', async (ctx) => {
    const dash = await deps.getFullDashboard(deps.agentReady ? deps.agent : null);
    sendJson(ctx.res, dash);
  });

  router.get('/api/dashboard/projects', (ctx) => {
    sendJson(ctx.res, deps.getProjectsSummary());
  });

  router.get('/api/dashboard/skills', (ctx) => {
    sendJson(ctx.res, deps.getSkillsSummary());
  });

  router.get('/api/dashboard/models', async (ctx) => {
    const summary = await deps.getModelSummary(deps.agentReady ? deps.agent : null);
    sendJson(ctx.res, summary);
  });

  router.get('/api/dashboard/health', (ctx) => {
    sendJson(ctx.res, deps.getHealthSummary(deps.agentReady ? deps.agent : null));
  });

  router.get('/api/dashboard/memory', (ctx) => {
    sendJson(ctx.res, deps.getMemorySummary(deps.agentReady ? deps.agent : null));
  });

  router.get('/api/dashboard/context', (ctx) => {
    sendJson(ctx.res, deps.getContextSummary(deps.agentReady ? deps.agent : null));
  });

  // ═══════════════════════════════════════════════════
  // Resilience
  // ═══════════════════════════════════════════════════

  router.get('/api/resilience/status', (ctx) => {
    sendJson(ctx.res, deps.getResilienceStatus(deps.agentReady ? deps.agent : null));
  });

  // ═══════════════════════════════════════════════════
  // Logs
  // ═══════════════════════════════════════════════════

  router.get('/api/logs/status', (ctx) => {
    sendJson(ctx.res, deps.getLogStatus());
  });

  router.get('/api/logs', (ctx) => {
    const limit = parseInt(ctx.query.get('limit') || '100', 10);
    sendJson(ctx.res, deps.getLogContent('')?.slice(-limit * 1024));
  });

  router.get('/api/logs/errors', (ctx) => {
    const limit = parseInt(ctx.query.get('limit') || '50', 10);
    sendJson(ctx.res, deps.getLogErrors(limit));
  });

  router.get('/api/logs/modules', (ctx) => {
    sendJson(ctx.res, deps.getLogModules());
  });

  router.get('/api/logs/json', (ctx) => {
    // JSON 格式日志查看
    const limit = parseInt(ctx.query.get('limit') || '100', 10);
    const level = ctx.query.get('level') || 'info';
    sendJson(ctx.res, { limit, level, note: 'use POST /api/logs/json for filtering' });
  });

  // ═══════════════════════════════════════════════════
  // Trace
  // ═══════════════════════════════════════════════════

  router.get('/api/trace/list', async (ctx) => {
    const traces = await deps.getTraceList(deps.agentReady ? deps.agent : null);
    sendJson(ctx.res, traces);
  });

  // ═══════════════════════════════════════════════════
  // Models
  // ═══════════════════════════════════════════════════

  router.get('/api/models', async (ctx) => {
    const models = await deps.getModels(deps.agentReady ? deps.agent : null);
    sendJson(ctx.res, models);
  });

  // ═══════════════════════════════════════════════════
  // Config
  // ═══════════════════════════════════════════════════

  router.get('/api/config', (ctx) => {
    const cfg = deps.getConfig();
    sendJson(ctx.res, {
      model: cfg.models?.providers?.lmstudio?.model || 'unknown',
      baseUrl: cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1',
      callTimeoutMs: cfg.agent?.callTimeoutMs || 60000,
      maxRetries: cfg.agent?.maxRetries ?? 1,
      maxOutputTokens: cfg.models?.providers?.lmstudio?.maxOutputTokens || 2048,
      heartbeatIntervalMs: cfg.agent?.heartbeatIntervalMs || 300000,
      chatTimeoutMs: cfg.server?.chatTimeoutMs || 120000,
      agent: { debugLogging: cfg.agent?.debugLogging ?? false },
      logging: {
        level: cfg.logging?.level || 'info',
        maxFileSizeMB: cfg.logging?.maxFileSizeMB || 10,
        maxRotatedFiles: cfg.logging?.maxRotatedFiles || 5,
      },
    });
  });

  // ═══════════════════════════════════════════════════
  // Sessions
  // ═══════════════════════════════════════════════════

  router.get('/api/sessions', (ctx) => {
    sendJson(ctx.res, deps.getSessions());
  });

  // ═══════════════════════════════════════════════════
  // POST Routes — Logs
  // ═══════════════════════════════════════════════════

  const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

  router.post('/api/logs/level', (ctx) => {
    const { level } = ctx.body || {};
    if (!VALID_LOG_LEVELS.includes(level)) {
      sendError(ctx.res, `无效日志级别: ${level}，可选: ${VALID_LOG_LEVELS.join(', ')}`, 400);
      return;
    }
    deps.logger.setLevel(level);
    sendJson(ctx.res, { ok: true, level: deps.logger.getLevel() });
  });

  router.post('/api/logs/cleanup', (ctx) => {
    const deleted = deps.logger.cleanupOldLogs();
    sendJson(ctx.res, { ok: true, deletedFiles: deleted });
  });

  router.post('/api/logs/modules', (ctx) => {
    const { module, level } = ctx.body || {};
    if (!module || typeof module !== 'string') {
      sendError(ctx.res, '缺少 module 参数', 400);
      return;
    }
    if (level !== null && !VALID_LOG_LEVELS.includes(level)) {
      sendError(ctx.res, `无效日志级别: ${level}，可选: ${VALID_LOG_LEVELS.join(', ')}，null 恢复全局`, 400);
      return;
    }
    deps.logger.setModuleLevel(module, level || null);
    sendJson(ctx.res, { ok: true, module, level: level || '(global)', all: deps.logger.getModuleLevels() });
  });

  router.post('/api/logs/buffer', (ctx) => {
    const { bufferSize } = ctx.body || {};
    if (bufferSize !== undefined) {
      if (typeof bufferSize !== 'number' || bufferSize < 1 || bufferSize > 10000) {
        sendError(ctx.res, 'bufferSize 必须是 1-10000 的整数（1=禁用缓冲）', 400);
        return;
      }
      deps.logger.setBufferSize(bufferSize);
    }
    sendJson(ctx.res, { ok: true, bufferSize });
  });

  router.post('/api/logs/flush', (ctx) => {
    deps.logger.flush();
    sendJson(ctx.res, { ok: true });
  });

  router.post('/api/logs/json', (ctx) => {
    const { enabled } = ctx.body || {};
    if (typeof enabled !== 'boolean') {
      sendError(ctx.res, 'enabled 必须是 boolean', 400);
      return;
    }
    deps.logger.setJsonFormat(enabled);
    sendJson(ctx.res, { ok: true, jsonFormat: deps.logger.getJsonFormat() });
  });

  router.post('/api/logs/trace', (ctx) => {
    // traceId 设置 — 纯粹委托给 logger（保留在 agent-server.ts 中复杂逻辑）
    // 这里简单返回，实际处理由 fall-through 完成
    sendJson(ctx.res, { ok: true, note: 'use agent-server fallthrough' });
  });

  // ═══════════════════════════════════════════════════
  // POST Routes — Sessions
  // ═══════════════════════════════════════════════════

  router.post('/api/sessions', (ctx) => {
    try {
      const { title } = ctx.body || {};
      // sessionStore.createSession 已由 deps 提供
      const session = deps.createSession(title);
      sendJson(ctx.res, session);
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  // ═══════════════════════════════════════════════════
  // Param Routes — :id patterns
  // ═══════════════════════════════════════════════════

  router.get('/api/sessions/:id', (ctx) => {
    const session = deps.getSession(ctx.params.id);
    if (!session) {
      sendError(ctx.res, '会话不存在', 404);
      return;
    }
    sendJson(ctx.res, session);
  });

  router.put('/api/sessions/:id', (ctx) => {
    try {
      const { title, messages } = ctx.body || {};
      if (title) deps.renameSession(ctx.params.id, title);
      if (messages) deps.updateMessages(ctx.params.id, messages);
      sendJson(ctx.res, { ok: true });
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  router.delete('/api/sessions/:id', (ctx) => {
    try {
      deps.deleteSession(ctx.params.id);
      sendJson(ctx.res, { ok: true });
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  // ═══════════════════════════════════════════════════
  // POST Routes — Config
  // ═══════════════════════════════════════════════════

  router.post('/api/config', async (ctx) => {
    try {
      const result = await deps.updateConfig(ctx.body || {});
      sendJson(ctx.res, { ok: true, message: '配置已更新，重启后生效', changes: result.changes });
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  // ═══════════════════════════════════════════════════
  // SSE Events
  // ═══════════════════════════════════════════════════

  router.get('/api/events', (ctx) => {
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    ctx.res.write('data: {"type":"connected"}\n\n');
    deps.sseClients.add(ctx.res);
    ctx.req.on('close', () => deps.sseClients.delete(ctx.res));
  });

  // ═══════════════════════════════════════════════════
  // Trace & Assembly
  // ═══════════════════════════════════════════════════

  router.get('/api/trace', (ctx) => {
    try {
      const report = deps.getTraceReport();
      if (!report) {
        sendJson(ctx.res, { trace: null, message: 'No trace data available' });
        return;
      }
      sendJson(ctx.res, {
        sessionId: report.sessionId,
        hasError: report.hasError,
        totalDurationMs: report.totalDurationMs,
        chainText: report.chainText,
        startedAt: report.startedAt,
      });
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  router.get('/api/trace/:sessionId', (ctx) => {
    try {
      const report = deps.getTraceReport(ctx.params.sessionId);
      if (!report) {
        sendError(ctx.res, 'TraceNotFound', 404);
        return;
      }
      sendJson(ctx.res, {
        sessionId: report.sessionId,
        hasError: report.hasError,
        totalDurationMs: report.totalDurationMs,
        chainText: report.chainText,
        startedAt: report.startedAt,
      });
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  router.get('/api/assembly', (ctx) => {
    try {
      const report = deps.getAssemblyReport();
      if (!report) {
        sendJson(ctx.res, { report: null, message: 'No assembly data' });
        return;
      }
      sendJson(ctx.res, report);
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  router.get('/api/assembly/:sessionId', (ctx) => {
    try {
      const report = deps.getAssemblyReport(ctx.params.sessionId);
      if (!report) {
        sendError(ctx.res, 'AssemblyReportNotFound', 404);
        return;
      }
      sendJson(ctx.res, report);
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  // ═══════════════════════════════════════════════════
  // Models — POST routes
  // ═══════════════════════════════════════════════════

  router.post('/api/models/switch', async (ctx) => {
    if (!deps.agentReady) {
      sendError(ctx.res, 'Agent 尚未初始化', 503);
      return;
    }
    try {
      const { model: modelId } = ctx.body || {};
      if (!modelId || typeof modelId !== 'string') {
        sendError(ctx.res, '缺少 model 字段', 400);
        return;
      }
      const result = await deps.switchModel(modelId);
      sendJson(ctx.res, {
        ok: true,
        previousModel: result.previousModel,
        currentModel: result.currentModel,
        contextLength: result.contextLength || 0,
        arch: result.arch || 'unknown',
        publisher: result.publisher || 'unknown',
        message: `模型已切换: ${result.previousModel} → ${result.currentModel}`,
      });
    } catch (err: unknown) {
      const msg = errorMessage(err);
      const status = msg.includes('未在 LM Studio') ? 404 : msg.includes('无法连接') ? 502 : 500;
      sendError(ctx.res, msg, status);
    }
  });

  router.post('/api/models/scan', async (ctx) => {
    try {
      const result = await deps.scanModels();
      sendJson(ctx.res, result);
    } catch (err: unknown) {
      const errMsg = errorMessage(err);
      const isConnectionRefused = errMsg.includes('ECONNREFUSED') || errMsg.includes('fetch failed') || errMsg.includes('aggregateError');
      sendJson(ctx.res, {
        ok: false,
        models: [],
        currentModelOnline: false,
        error: isConnectionRefused ? 'LM Studio 服务未启动 (ECONNREFUSED)' : errMsg,
        connected: false,
        hint: isConnectionRefused ? '请启动 LM Studio 并加载模型' : undefined,
      });
    }
  });

  router.post('/api/models/load', async (ctx) => {
    try {
      const { model, context_length, flash_attention, eval_batch_size, num_experts } = ctx.body || {};
      if (!model) {
        sendJson(ctx.res, { ok: false, error: '参数 model 为必填' });
        return;
      }
      const options: any = {};
      if (context_length) options.context_length = context_length;
      if (typeof flash_attention === 'boolean') options.flash_attention = flash_attention;
      if (eval_batch_size) options.eval_batch_size = eval_batch_size;
      if (num_experts) options.num_experts = num_experts;
      const result = await deps.loadModel(model, options);
      sendJson(ctx.res, {
        ok: true,
        model,
        instance_id: result.instance_id,
        load_time_seconds: result.load_time_seconds,
        status: result.status,
        type: result.type,
      });
    } catch (err: unknown) { sendJson(ctx.res, { ok: false, error: errorMessage(err) || '加载失败' });
    }
  });

  router.post('/api/models/unload', async (ctx) => {
    try {
      const { instance_id } = ctx.body || {};
      if (!instance_id) {
        sendJson(ctx.res, { ok: false, error: '参数 instance_id 为必填' });
        return;
      }
      const result = await deps.unloadModel(instance_id);
      sendJson(ctx.res, { ok: true, instance_id: result.instance_id });
    } catch (err: unknown) { sendJson(ctx.res, { ok: false, error: errorMessage(err) || '卸载失败' });
    }
  });

  // ═══════════════════════════════════════════════════
  // Chat
  // ═══════════════════════════════════════════════════

  router.post('/api/chat', async (ctx) => {
    if (!deps.agentReady) {
      sendJson(ctx.res, { reply: 'Agent 正在初始化，请稍候...', duration: 0 }, 503);
      return;
    }
    try {
      const { message } = ctx.body || {};
      if (!message || typeof message !== 'string') {
        sendError(ctx.res, '缺少 message 字段', 400);
        return;
      }
      const t0 = Date.now();
      const reply = await deps.sendChat(message);
      const duration = Date.now() - t0;
      deps.broadcastSSE({ type: 'chat', input: message.slice(0, 100), output: reply.slice(0, 200), duration });
      sendJson(ctx.res, { reply, duration });
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  router.post('/api/chat/stream', async (ctx) => {
    if (!deps.agentReady) {
      sendError(ctx.res, 'Agent 正在初始化', 503);
      return;
    }
    if (deps.streamChatInProgress.value) {
      ctx.res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '10',
      });
      ctx.res.end(JSON.stringify({ error: '已有流式聊天正在进行，请稍后再试', retryAfter: 10 }));
      return;
    }
    try {
      const { message } = ctx.body || {};
      if (!message || typeof message !== 'string') {
        sendError(ctx.res, '缺少 message 字段', 400);
        return;
      }
      // 设置 SSE 头
      ctx.res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      ctx.res.write('data: {"type":"start"}\n\n');

      deps.streamChatInProgress.value = true;
      const t0 = Date.now();

      const writers: StreamWriters = {
        onChunk: (chunk: string) => {
          try { ctx.res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`); } catch { /* closed */ }
        },
        onDone: (data) => {
          try {
            ctx.res.write(`data: ${JSON.stringify({ type: 'done', fullReply: data.fullReply, duration: data.durationMs })}\n\n`);
            ctx.res.end();
          } catch { /* closed */ }
        },
        onError: (error) => {
          try {
            ctx.res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
            ctx.res.end();
          } catch { /* closed */ }
        },
        onClose: () => {
          deps.streamChatInProgress.value = false;
        },
      };

      ctx.req.on('close', () => {
        deps.streamChatInProgress.value = false;
        writers.onClose();
      });

      const fullReply = await deps.sendChatStream(message, writers);
      const duration = Date.now() - t0;
      deps.broadcastSSE({ type: 'chat', input: message.slice(0, 100), output: fullReply.slice(0, 200), duration });
      if (!ctx.res.writableEnded) {
        ctx.res.write(`data: ${JSON.stringify({ type: 'done', fullReply, duration })}\n\n`);
        ctx.res.end();
      }
    } catch (err: unknown) {
      deps.streamChatInProgress.value = false;
      if (!ctx.res.writableEnded) {
        ctx.res.write(`data: ${JSON.stringify({ type: 'error', error: errorMessage(err) })}\n\n`);
        ctx.res.end();
      }
    }
  });

  // ═══════════════════════════════════════════════════
  // File Upload
  // ═══════════════════════════════════════════════════

  router.post('/api/upload', async (ctx) => {
    try {
      const contentType = ctx.req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        sendError(ctx.res, '需要 multipart/form-data', 400);
        return;
      }
      // 重新读取原始 body（multipart 不走 JSON 解析）
      const rawBody = Buffer.from(ctx.rawBody, 'utf8');
      const result = await deps.saveUpload(rawBody, contentType);
      sendJson(ctx.res, result);
    } catch (err: unknown) { sendError(ctx.res, errorMessage(err), 500);
    }
  });

  return router;
}
