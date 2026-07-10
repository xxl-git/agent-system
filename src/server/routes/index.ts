// 路由注册 — 将分散在 agent-server.ts 中的 if-else 路由提取为集中式路由表
// 渐进式迁移：先迁移简单 GET 路由，复杂路由保留在 agent-server.ts 中

import { Router, RouteContext, sendJson, sendError } from './router.js';

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
  getDashboardModels: (agent: any) => Promise<any>;
  sseClients: Set<any>;
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
    sendJson(ctx.res, deps.getConfig());
  });

  // ═══════════════════════════════════════════════════
  // Sessions
  // ═══════════════════════════════════════════════════

  router.get('/api/sessions', (ctx) => {
    sendJson(ctx.res, deps.getSessions());
  });

  return router;
}
