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
    if (initMsg) console.log('[AgentServer] ' + initMsg.replace(/\n/g, ' '));
    agentReady = true;
    console.log('[AgentServer] Agent 就绪');
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

  // SSE 事件流
  if (url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
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

  // API: GET /api/status
  if (url === '/api/status' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: agentReady ? 'Agent v0.9.2' : 'initializing',
      model: agentReady ? (agent as any)?.adapter?.model || 'unknown' : 'loading...',
      sessionId: agentReady ? (agent as any)?.sessionId || '-' : '-',
      uptime: process.uptime(),
      ready: agentReady,
    }));
    return;
  }

  // API: GET /api/dashboard — 完整仪表盘数据
  if (url === '/api/dashboard' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const dash = await getFullDashboard(agentReady ? agent : null);
    res.end(JSON.stringify(dash));
    return;
  }

  // API: GET /api/dashboard/projects — 项目管理
  if (url === '/api/dashboard/projects' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getProjectsSummary()));
    return;
  }

  // API: GET /api/dashboard/skills — 技能注册
  if (url === '/api/dashboard/skills' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getSkillsSummary()));
    return;
  }

  // API: GET /api/dashboard/models — 模型状态
  if (url === '/api/dashboard/models' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(await getModelSummary(agentReady ? agent : null)));
    return;
  }

  // API: GET /api/dashboard/health — 韧性状态
  if (url === '/api/dashboard/health' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getHealthSummary(agentReady ? agent : null)));
    return;
  }

  // API: GET /api/resilience/status — 弹性状态详情（熔断器 + 健康 + 重试）
  if (url === '/api/resilience/status' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getResilienceSummary(agentReady ? agent : null)));
    return;
  }

  // API: GET /api/logs/status — 日志轮转状态
  if (url === '/api/logs/status' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getLogStatus()));
    return;
  }

  // API: GET /api/logs — 列出日志文件
  if (url === '/api/logs' && isGet()) {
    try {
      const config = getConfig();
      const logDir = (config.logging as any)?.dir || './logs';
      const fullPath = path.resolve(process.cwd(), logDir);
      if (!fs.existsSync(fullPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ files: [] }));
        return;
      }
      const files = fs.readdirSync(fullPath)
        .filter(f => f.endsWith('.log') || f.endsWith('.log.gz'))
        .map(f => {
          const filePath = path.join(fullPath, f);
          const stat = fs.statSync(filePath);
          // Extract date using regex (matches YYYY-MM-DD)
            const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
            return {
            date: dateMatch ? dateMatch[1] : null,
            size: stat.size,
            compressed: f.endsWith('.gz'),
            mtime: stat.mtime,
          };
        })
        .filter(f => f.date !== null)  // Only return date-named files
        .sort((a: any, b: any) => b.date.localeCompare(a.date));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ files }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/logs/errors — 列出错误日志文件
  if (url === '/api/logs/errors' && isGet()) {
    try {
      const config = getConfig();
      const logDir = (config.logging as any)?.dir || './logs';
      const fullPath = path.resolve(process.cwd(), logDir);
      if (!fs.existsSync(fullPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ files: [] }));
        return;
      }
      const files = fs.readdirSync(fullPath)
        .filter((f: string) => f.endsWith('-errors.log') || f.endsWith('-errors.log.gz'))
        .map((f: string) => {
          const filePath = path.join(fullPath, f);
          const stat = fs.statSync(filePath);
          const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
          return {
            date: dateMatch ? dateMatch[1] : null,
            size: stat.size,
            compressed: f.endsWith('.gz'),
            mtime: stat.mtime,
          };
        })
        .filter((f: any) => f.date !== null)
        .sort((a: any, b: any) => b.date.localeCompare(a.date));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ files }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/logs/errors/:date — 读取指定日期的错误日志
  if (url.startsWith('/api/logs/errors/') && isGet()) {
    try {
      const date = url.split('/')[4];
      const config = getConfig();
      const logDir = (config.logging as any)?.dir || './logs';
      const fullPath = path.resolve(process.cwd(), logDir);
      // 路径安全验证
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid date format. Expected YYYY-MM-DD.' }));
        return;
      }
      const resolved = path.resolve(fullPath, `${date}-errors.log`);
      if (!resolved.startsWith(fullPath)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Path traversal detected.' }));
        return;
      }
      let content = '';
      if (fs.existsSync(resolved)) {
        content = fs.readFileSync(resolved, 'utf-8');
      } else {
        const gzPath = resolved + '.gz';
        if (fs.existsSync(gzPath)) {
          const zlib = require('zlib');
          content = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf-8');
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'ErrorLogFileNotFound' }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: POST /api/logs/level — 动态修改日志级别
  if (url === '/api/logs/level' && isPost()) {
    try {
      const body = await readBody(req);
      const { level } = JSON.parse(body);
      const validLevels = ['debug', 'info', 'warn', 'error'];
      if (!validLevels.includes(level)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `无效日志级别: ${level}，可选: ${validLevels.join(', ')}` }));
        return;
      }
      logger.setLevel(level);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, level: logger.getLevel() }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: POST /api/logs/cleanup — 清理过期旧日志
  if (url === '/api/logs/cleanup' && isPost()) {
    try {
      const deleted = logger.cleanupOldLogs();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, deletedFiles: deleted }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: POST /api/logs/modules — 设置模块级日志级别
  if (url === '/api/logs/modules' && isPost()) {
    try {
      const body = await readBody(req);
      const { module, level } = JSON.parse(body);
      if (!module || typeof module !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '缺少 module 参数' }));
        return;
      }
      const validLevels = ['debug', 'info', 'warn', 'error'];
      if (level !== null && !validLevels.includes(level)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `无效日志级别: ${level}，可选: ${validLevels.join(', ')}，null 恢复全局` }));
        return;
      }
      logger.setModuleLevel(module, level || null);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, module, level: level || '(global)', all: logger.getModuleLevels() }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/logs/modules — 查看所有模块级日志级别
  if (url === '/api/logs/modules' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      global: logger.getLevel(),
      modules: logger.getModuleLevels(),
    }));
    return;
  }

  // API: POST /api/logs/buffer — 配置日志缓冲区
  if (url === '/api/logs/buffer' && isPost()) {
    try {
      const body = await readBody(req);
      const { bufferSize } = JSON.parse(body);
      if (bufferSize !== undefined) {
        if (typeof bufferSize !== 'number' || bufferSize < 1 || bufferSize > 10000) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'bufferSize 必须是 1-10000 的整数（1=禁用缓冲）' }));
          return;
        }
        logger.setBufferSize(bufferSize);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, bufferSize: bufferSize }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: POST /api/logs/flush — 强制刷盘
  if (url === '/api/logs/flush' && isPost()) {
    logger.flush();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API: POST /api/logs/json — 切换 JSON 格式
  if (url === '/api/logs/json' && isPost()) {
    try {
      const body = await readBody(req);
      const { enabled } = JSON.parse(body);
      if (typeof enabled !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'enabled 必须是 boolean' }));
        return;
      }
      logger.setJsonFormat(enabled);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, jsonFormat: logger.getJsonFormat() }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/logs/json — 查看当前 JSON 格式状态
  if (url === '/api/logs/json' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonFormat: logger.getJsonFormat() }));
    return;
  }

  // API: POST /api/logs/trace — 设置 traceId
  if (url === '/api/logs/trace' && isPost()) {
    try {
      const body = await readBody(req);
      const { traceId } = JSON.parse(body);
      logger.setTraceId(traceId || null);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, traceId: logger.getTraceId() }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/logs/:date — 读取指定日期的日志
  if (url.startsWith('/api/logs/') && isGet()) {
    // 守卫：跳过错误日志路由（已在上面处理）
    if (url.includes('/errors')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'NotFound' }));
      return;
    }
    try {
      const date = url.split('/')[3];
      const config = getConfig();
      const logDir = (config.logging as any)?.dir || './logs';
      const fullPath = path.resolve(process.cwd(), logDir);
      // 路径安全验证：防止路径穿越攻击
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid date format. Expected YYYY-MM-DD.' }));
        return;
      }
      const resolved = path.resolve(fullPath, `${date}.log`);
      if (!resolved.startsWith(fullPath)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Path traversal detected.' }));
        return;
      }
      let filePath = resolved;
      let content = '';
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf-8');
      } else {
        filePath = path.join(fullPath, `${date}.log.gz`);
        if (fs.existsSync(filePath)) {
          const zlib = require('zlib');
          content = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf-8');
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'LogFileNotFound' }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/trace — 获取最新 trace 报告
  if (url === '/api/trace' && isGet()) {
    try {
      const tracerModule = require('@agent-system/resilience');
      const report = tracerModule.getTraceReport();
      if (!report) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ trace: null, message: 'No trace data available' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        sessionId: report.sessionId,
        hasError: report.hasError,
        totalDurationMs: report.totalDurationMs,
        chainText: report.chainText,
        startedAt: report.startedAt,
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/trace/list — 最近 trace 列表
  if (url === '/api/trace/list' && isGet()) {
    try {
      // getRecentTraces not available; return empty list for now
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ traces: [], note: 'getRecentTraces not implemented in @agent-system/resilience' }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/trace/:sessionId — 按会话 ID 查 trace
  if (url.startsWith('/api/trace/') && isGet()) {
    try {
      const sessionId = url.split('/')[3];
      const tracerModule = require('@agent-system/resilience');
      const report = tracerModule.getTraceReport(sessionId);
      if (!report) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'TraceNotFound' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        sessionId: report.sessionId,
        hasError: report.hasError,
        totalDurationMs: report.totalDurationMs,
        chainText: report.chainText,
        startedAt: report.startedAt,
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/assembly — 最新消息装配流水线
  if (url === '/api/assembly' && isGet()) {
    try {
      const inspector = require('@agent-system/resilience');
      const report = inspector.getAssemblyReport();
      if (!report) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ report: null, message: 'No assembly data' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(report));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/assembly/:sessionId — 按会话查装配流水线
  if (url.startsWith('/api/assembly/') && isGet()) {
    try {
      const sessionId = url.split('/')[3];
      const inspector = require('@agent-system/resilience');
      const report = inspector.getAssemblyReport(sessionId);
      if (!report) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'AssemblyReportNotFound' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(report));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/dashboard/memory — 记忆统计
  if (url === '/api/dashboard/memory' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getMemorySummary(agentReady ? agent : null)));
    return;
  }

  // API: GET /api/dashboard/context — 上下文管理统计
  if (url === '/api/dashboard/context' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getContextSummary()));
    return;
  }

  // API: GET /api/models — 列出 LM Studio 中所有可用模型（含加载状态）
  if (url === '/api/models' && isGet()) {
    try {
      const cfg = getConfig();
      const providerUrl = cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1';

      // 优先使用 agent 实例的 listAllModels()，回退到直接 fetch
      let models: any[] = [];
      let connected = false;
      if (agent && agentReady) {
        try {
          models = await agent.adapter.listAllModels();
          connected = models.length > 0;
        } catch {
          // agent 未就绪时回退到直接 fetch
        }
      }

      // 回退方案：直接调用 LM Studio API
      if (models.length === 0) {
        try {
          // 1. 获取已加载模型 (/v1/models)
          const lmRes = await fetch(`${providerUrl}/models`, { signal: AbortSignal.timeout(5000) });
          const lmData: any = await lmRes.json();
          const loadedIds = new Set((lmData.data || []).map((m: any) => m.id));
          connected = lmData.data?.length > 0;

          // 2. 获取所有可用模型 (/api/v1/models)
          try {
            const restRes = await fetch(`${providerUrl.replace('/v1', '/api/v1')}/models`, { signal: AbortSignal.timeout(8000) });
            const restData: any = await restRes.json();
            const restModels = restData.models || [];
            models = restModels.map((m: any) => ({
              id: m.key,
              object: 'model',
              type: m.type || 'llm',
              publisher: m.publisher || 'unknown',
              arch: m.architecture || 'unknown',
              context_length: m.max_context_length || 0,
              display_name: m.display_name,
              quantization: m.quantization?.name,
              params_string: m.params_string || undefined,
              size_bytes: m.size_bytes,
              loaded: (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0) || loadedIds.has(m.key),
              capabilities: {
                vision: m.capabilities?.vision || false,
                trained_for_tool_use: m.capabilities?.trained_for_tool_use || false,
                reasoning: !!m.capabilities?.reasoning,
              },
            }));
            // 确保已加载但不在 REST 列表的模型也包含
            for (const lm of (lmData.data || [])) {
              if (!models.some(m => m.id === lm.id)) {
                models.push({
                  id: lm.id, object: 'model', type: 'llm',
                  publisher: lm.owned_by || 'unknown', arch: 'unknown',
                  context_length: 0, loaded: true,
                });
              }
            }
          } catch {
            // REST API 不可用，只返回已加载模型
            models = (lmData.data || []).map((m: any) => ({
              id: m.id, object: 'model', type: 'llm',
              publisher: m.owned_by || 'unknown', arch: 'unknown',
              context_length: 0, loaded: true,
            }));
          }
        } catch (err: any) {
          const errMsg = err.message || '';
          const isConnectionRefused = errMsg.includes('ECONNREFUSED') || errMsg.includes('fetch failed');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            models: [],
            current: 'unknown',
            currentModelOnline: false,
            error: isConnectionRefused ? 'LM Studio 服务未启动 (ECONNREFUSED)' : errMsg,
            connected: false,
            hint: isConnectionRefused ? '请启动 LM Studio 并加载模型' : undefined,
          }));
          return;
        }
      }

      // 同时获取 agent 当前使用的模型名
      let currentModel = cfg.models?.providers?.lmstudio?.model || 'unknown';
      if (agent && agentReady) {
        try { currentModel = agent.adapter.model; } catch { /* ignore */ }
      }

      const currentModelOnline = models.some((m: any) => m.id === currentModel && m.loaded);
      const loadedCount = models.filter((m: any) => m.loaded).length;

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        models,
        current: currentModel,
        currentModelOnline,
        timeout: cfg.agent?.callTimeoutMs || 60000,
        lmStudioUrl: providerUrl,
        connected,
        loadedCount,
        totalCount: models.length,
      }));
    } catch (err: any) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        models: [],
        current: 'unknown',
        currentModelOnline: false,
        error: err.message || 'unknown error',
        connected: false,
      }));
    }
    return;
  }

  // API: POST /api/models/switch — 热切换运行中的模型（无需重启）
  // 注意：热切换不依赖 agentReady，初始化探针期间也可以切换
  if (url === '/api/models/switch' && isPost()) {
    if (!agent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent 尚未初始化' }));
      return;
    }
    try {
      const body = await readBody(req);
      const { model: modelId } = JSON.parse(body);
      if (!modelId || typeof modelId !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 model 字段' }));
        return;
      }

      // 1. 验证模型在 LM Studio 中已加载
      const cfg = getConfig();
      const providerUrl = cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1';
      let modelInfo: any = null;
      try {
        const lmRes = await fetch(`${providerUrl}/models`, { signal: AbortSignal.timeout(5000) });
        const lmData: any = await lmRes.json();
        const found = (lmData.data || []).find((m: any) => m.id === modelId);
        if (!found) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `模型 "${modelId}" 未在 LM Studio 中加载` }));
          return;
        }
        modelInfo = found;
      } catch (lmErr: any) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `无法连接 LM Studio: ${lmErr.message}` }));
        return;
      }

      // 2. 热切换运行实例的模型
      const oldModel = agent.adapter.model;
      agent.adapter.setModel(modelId);

      // 3. 更新上下文长度（从模型元数据获取）
      if (modelInfo.context_length) {
        try {
          // SmartAdapter 代理了 contextLength，但它是 getter 从 raw 读取
          // LMStudioAdapter.contextLength 是 public 可写属性
          (agent.adapter as any).raw.contextLength = modelInfo.context_length;
        } catch { /* ignore */ }
      }

      // 4. 持久化到 YAML 配置
      try {
        const yamlPath = path.resolve(__dirname, '..', '..', 'config', 'agent-system.yaml');
        const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
        // 替换 model 行
        const updated = yamlContent.replace(
          /(\s+model:\s*")[^"]+(")/,
          `$1${modelId}$2`
        );
        if (updated !== yamlContent) {
          fs.writeFileSync(yamlPath, updated, 'utf-8');
          logger.info(`[AgentServer] 模型切换已持久化到 YAML: ${oldModel} → ${modelId}`);
        }
      } catch (yamlErr: any) {
        logger.warn('[AgentServer] 更新 YAML 模型配置失败', yamlErr);
      }

      // 5. 重载内存配置使 getConfig() 反映新模型
      initConfig();

      logger.info(`[AgentServer] 模型热切换: ${oldModel} → ${modelId} (context=${modelInfo.context_length || '?'})`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        previousModel: oldModel,
        currentModel: modelId,
        contextLength: modelInfo.context_length || 0,
        arch: modelInfo.arch || 'unknown',
        publisher: modelInfo.publisher || 'unknown',
        message: `模型已切换: ${oldModel} → ${modelId}`,
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: POST /api/models/scan — 重新扫描 LM Studio 可用模型（含未加载）
  if (url === '/api/models/scan' && isPost()) {
    try {
      let models: any[] = [];
      let currentModel = 'unknown';
      let connected = false;
      if (agent && agentReady) {
        // 优先使用 agent 实例的 listAllModels()（合并两个端点）
        try {
          models = await agent.adapter.listAllModels();
          connected = models.length > 0;
          currentModel = agent.adapter.model;
        } catch {
          // listAllModels 失败，走下方回退
        }
      }
      if (models.length === 0) {
        // 回退：直接调用 LM Studio REST API（含未加载模型）+ OpenAI 端点标记加载状态
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
            id: m.key,
            object: 'model',
            type: m.type || 'llm',
            publisher: m.publisher || 'unknown',
            arch: m.architecture || 'unknown',
            context_length: m.max_context_length || 0,
            display_name: m.display_name,
            quantization: m.quantization?.name,
            params_string: m.params_string || undefined,
            size_bytes: m.size_bytes,
            loaded: (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0) || loadedIds.has(m.key),
            capabilities: {
              vision: m.capabilities?.vision || false,
              trained_for_tool_use: m.capabilities?.trained_for_tool_use || false,
              reasoning: !!m.capabilities?.reasoning,
            },
          }));
          // 确保已加载但不在 REST 列表的模型也包含
          for (const lm of (lmData.data || [])) {
            if (!models.some((m: any) => m.id === lm.id)) {
              models.push({ id: lm.id, object: 'model', type: 'llm', publisher: lm.owned_by || 'unknown', arch: 'unknown', context_length: 0, loaded: true });
            }
          }
        } catch {
          // REST 不可用，models 为空
        }
        currentModel = cfg.models?.providers?.lmstudio?.model || 'unknown';
        if (agent && agentReady) {
          try { currentModel = agent.adapter.model; } catch { /* ignore */ }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      const currentModelOnline = models.some((m: any) => m.id === currentModel);
      const loadedCount = models.filter((m: any) => m.loaded).length;
      res.end(JSON.stringify({
        ok: true,
        models,
        current: currentModel,
        currentModelOnline,
        count: models.length,
        loadedCount,
        totalCount: models.length,
        connected,
      }));
    } catch (err: any) {
      // 区分错误类型：连接拒绝（LM Studio 未启动）vs 其他错误
      const errMsg = err.message || '';
      const isConnectionRefused = errMsg.includes('ECONNREFUSED') || errMsg.includes('fetch failed') || errMsg.includes('aggregateError');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        models: [],
        currentModelOnline: false,
        error: isConnectionRefused
          ? 'LM Studio 服务未启动 (ECONNREFUSED)'
          : errMsg,
        connected: false,
        hint: isConnectionRefused
          ? '请启动 LM Studio 并加载模型'
          : undefined,
      }));
    }
    return;
  }

  // API: POST /api/models/load — 加载模型到内存（LM Studio REST API）
  if (url === '/api/models/load' && isPost()) {
    try {
      const body = await readBody(req);
      const { model, context_length, flash_attention, eval_batch_size, num_experts } = JSON.parse(body);
      if (!model) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '参数 model 为必填' }));
        return;
      }
      const options: any = {};
      if (context_length) options.context_length = context_length;
      if (typeof flash_attention === 'boolean') options.flash_attention = flash_attention;
      if (eval_batch_size) options.eval_batch_size = eval_batch_size;
      if (num_experts) options.num_experts = num_experts;
      // 优先使用 agent 实例，回退到直接 fetch
      let result: any;
      if (agent && agentReady) {
        try {
          result = await agent.adapter.loadModel(model, options);
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message || '加载失败' }));
          return;
        }
      } else {
        // 回退：直接调用 LM Studio REST API
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
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: `Load failed (${loadRes.status}): ${errText}` }));
          return;
        }
        result = await loadRes.json();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        model,
        instance_id: result.instance_id,
        load_time_seconds: result.load_time_seconds,
        status: result.status,
        type: result.type,
      }));
    } catch (err: any) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message || '加载失败' }));
    }
    return;
  }

  // API: POST /api/models/unload — 从内存卸载模型
  if (url === '/api/models/unload' && isPost()) {
    try {
      const body = await readBody(req);
      const { instance_id } = JSON.parse(body);
      if (!instance_id) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '参数 instance_id 为必填' }));
        return;
      }
      // 优先使用 agent 实例，回退到直接 fetch
      let result: any;
      if (agent && agentReady) {
        try {
          result = await agent.adapter.unloadModel(instance_id);
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message || '卸载失败' }));
          return;
        }
      } else {
        const cfg = getConfig();
        const restUrl = (cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1').replace(/\/v1\/?$/, '/api/v1');
        const unloadRes = await fetch(`${restUrl}/models/unload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instance_id }),
          signal: AbortSignal.timeout(30000),
        });
        if (!unloadRes.ok) {
          const errText = await unloadRes.text().catch(() => '');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: `Unload failed (${unloadRes.status}): ${errText}` }));
          return;
        }
        result = await unloadRes.json();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, instance_id: result.instance_id }));
    } catch (err: any) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message || '卸载失败' }));
    }
    return;
  }

  // API: POST /api/config — 更新配置
  if (url === '/api/config' && isPost()) {
    try {
      const body = await readBody(req);
      const updates = JSON.parse(body);
      const { model, callTimeoutMs, maxRetries, maxTokens, chatTimeoutMs } = updates;

      // 参数校验：拒绝负数和 NaN
      const validatedTimeout = (v: unknown, name: string, min: number, max: number): number | null => {
        if (v === undefined || v === null) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < min || n > max) {
          throw new Error(`Invalid ${name}: ${v} (must be ${min}-${max})`);
        }
        return Math.floor(n);
      };

      const yamlPath = path.resolve(__dirname, '..', '..', 'config', 'agent-system.yaml');
      const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
      let yamlConfig: any;
      try {
        yamlConfig = yaml.load(yamlContent) || {};
      } catch (e: any) {
        logger.warn('[AgentServer] YAML 解析失败，无法更新配置', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'YAML 解析失败: ' + e.message }));
        return;
      }
      const changes: Record<string, unknown> = {};

      // 辅助函数：确保嵌套路径存在并设置值
      const setNested = (obj: any, keys: string[], value: any) => {
        let cur = obj;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
          cur = cur[keys[i]];
        }
        cur[keys[keys.length - 1]] = value;
      };

      if (model) {
        setNested(yamlConfig, ['models', 'providers', 'lmstudio', 'model'], model);
        changes.model = model;
      }
      const vTimeout = validatedTimeout(callTimeoutMs, 'callTimeoutMs', 1000, 3600000);
      if (vTimeout !== null) {
        setNested(yamlConfig, ['agent', 'callTimeoutMs'], vTimeout);
        changes.callTimeoutMs = vTimeout;
      }
      const vRetries = validatedTimeout(maxRetries, 'maxRetries', 0, 100);
      if (vRetries !== null) {
        setNested(yamlConfig, ['agent', 'maxRetries'], vRetries);
        changes.maxRetries = vRetries;
      }
      const vTokens = validatedTimeout(maxTokens, 'maxTokens', 1, 100000);
      if (vTokens !== null) {
        setNested(yamlConfig, ['models', 'providers', 'lmstudio', 'maxTokens'], vTokens);
        changes.maxTokens = vTokens;
      }

      // === 新增：支持 agent.debugLogging ===
      if (updates.agent?.debugLogging !== undefined) {
        const dbg = !!updates.agent.debugLogging;
        setNested(yamlConfig, ['agent', 'debugLogging'], dbg);
        changes.debugLogging = dbg;
        // 即时生效：调整 logger 级别
        try {
          logger.setLevel(dbg ? 'debug' : 'info');
          logger.info('[AgentServer] 详细日志已' + (dbg ? '开启' : '关闭'));
        } catch (e) {
          logger.warn('[AgentServer] 调整 logger 级别失败', e);
        }
      }

      // === 新增：支持 logging.level / logging.maxFileSizeMB / logging.maxRotatedFiles ===
      if (updates.logging) {
        const validLevels = ['debug', 'info', 'warn', 'error'];
        if (updates.logging.level && validLevels.includes(updates.logging.level)) {
          setNested(yamlConfig, ['logging', 'level'], updates.logging.level);
          changes.logLevel = updates.logging.level;
          try { logger.setLevel(updates.logging.level as any); } catch (e) { logger.warn('[AgentServer] setLevel 失败', e); }
        }
        if (updates.logging.maxFileSizeMB !== undefined) {
          const sz = Number(updates.logging.maxFileSizeMB);
          if (Number.isFinite(sz) && sz > 0) {
            setNested(yamlConfig, ['logging', 'maxFileSizeMB'], sz);
            changes.maxFileSizeMB = sz;
          }
        }
        if (updates.logging.maxRotatedFiles !== undefined) {
          const nf = Number(updates.logging.maxRotatedFiles);
          if (Number.isFinite(nf) && nf > 0) {
            setNested(yamlConfig, ['logging', 'maxRotatedFiles'], nf);
            changes.maxRotatedFiles = nf;
          }
        }
      }

      // === 新增：支持 models.providers.lmstudio.baseUrl 等 ===
      if (updates.models?.providers?.lmstudio) {
        const ls = updates.models.providers.lmstudio;
        if (ls.model) {
          setNested(yamlConfig, ['models', 'providers', 'lmstudio', 'model'], ls.model);
          changes.model = ls.model;
        }
        if (ls.baseUrl) {
          setNested(yamlConfig, ['models', 'providers', 'lmstudio', 'baseUrl'], ls.baseUrl);
          changes.baseUrl = ls.baseUrl;
        }
      }

      if (chatTimeoutMs !== undefined) {
        const vChatTimeout = validatedTimeout(chatTimeoutMs, 'chatTimeoutMs', 5000, 3600000);
        if (vChatTimeout !== null) {
          setNested(yamlConfig, ['server', 'chatTimeoutMs'], vChatTimeout);
          changes.chatTimeoutMs = vChatTimeout;
        }
      }

      // 写入 YAML 文件
      try {
        const newYamlContent = yaml.dump(yamlConfig, { lineWidth: -1, quotingType: '"' });
        fs.writeFileSync(yamlPath, newYamlContent, 'utf-8');
      } catch (e: any) {
        logger.warn('[AgentServer] 写入 YAML 配置失败', e);
      }

      // 同步更新内存中的配置，使 GET /api/config 立即反映更改
      initConfig();
      
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: '配置已更新，重启后生效', changes }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/config — 查看当前配置
  if (url === '/api/config' && isGet()) {
    try {
      const cfg = getConfig();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        model: cfg.models?.providers?.lmstudio?.model || 'unknown',
        baseUrl: cfg.models?.providers?.lmstudio?.baseUrl || 'http://127.0.0.1:1234/v1',
        callTimeoutMs: cfg.agent?.callTimeoutMs || 60000,
        maxRetries: cfg.agent?.maxRetries ?? 1,
        maxTokens: cfg.models?.providers?.lmstudio?.maxTokens || 2048,
        heartbeatIntervalMs: cfg.agent?.heartbeatIntervalMs || 300000,
        chatTimeoutMs: cfg.server?.chatTimeoutMs || 120000,
        agent: { debugLogging: cfg.agent?.debugLogging ?? false },
        logging: {
          level: cfg.logging?.level || 'info',
          maxFileSizeMB: cfg.logging?.maxFileSizeMB || 10,
          maxRotatedFiles: cfg.logging?.maxRotatedFiles || 5,
        },
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: POST /api/chat
  if (url === '/api/chat' && isPost()) {
    if (!agentReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply: 'Agent 正在初始化，请稍候...', duration: 0 }));
      return;
    }
    try {
      const body = await readBody(req);
      const { message } = JSON.parse(body);
      if (!message || typeof message !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 message 字段' }));
        return;
      }

      const ag = await ensureAgent();
      const t0 = Date.now();
      const reply = await ag.sendMessage(message);
      const duration = Date.now() - t0;

      broadcastSSE({ type: 'chat', input: message.slice(0, 100), output: reply.slice(0, 200), duration });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ reply, duration }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: POST /api/chat/stream — SSE 流式聊天
  if (url === '/api/chat/stream' && isPost()) {
    if (!agentReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent 正在初始化' }));
      return;
    }
    try {
      const body = await readBody(req);
      const { message } = JSON.parse(body);
      if (!message || typeof message !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 message 字段' }));
        return;
      }

      // 设置 SSE 头
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('data: {"type":"start"}\n\n');

      const ag = await ensureAgent();
      const t0 = Date.now();

      // 使用一次性监听器转发 chunk 事件到当前 response
      const chunkWriter = (chunk: string) => {
        try {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
        } catch { /* connection closed */ }
      };
      const doneWriter = (data: { fullReply: string; durationMs: number }) => {
        try {
          res.write(`data: ${JSON.stringify({ type: 'done', fullReply: data.fullReply, duration: data.durationMs })}\n\n`);
          res.end();
        } catch { /* connection closed */ }
      };
      const errorWriter = (error: string) => {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
          res.end();
        } catch { /* connection closed */ }
      };

      agentEventBus.on('chat_chunk', chunkWriter);
      agentEventBus.on('chat_done', doneWriter);
      agentEventBus.on('chat_error', errorWriter);

      // 请求关闭时清理监听器
      req.on('close', () => {
        agentEventBus.off('chat_chunk', chunkWriter);
        agentEventBus.off('chat_done', doneWriter);
        agentEventBus.off('chat_error', errorWriter);
      });

      // 调用流式发送
      ag.sendMessageStream(message).then((fullReply) => {
        const duration = Date.now() - t0;
        // 如果 done 事件已经发送了，这里确保 response 已结束
        agentEventBus.off('chat_chunk', chunkWriter);
        agentEventBus.off('chat_done', doneWriter);
        agentEventBus.off('chat_error', errorWriter);
        // 广播到全局 SSE（供调试面板）
        broadcastSSE({ type: 'chat', input: message.slice(0, 100), output: fullReply.slice(0, 200), duration });
        // 如果 response 还没结束，手动结束
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'done', fullReply, duration })}\n\n`);
          res.end();
        }
      }).catch((err) => {
        agentEventBus.off('chat_chunk', chunkWriter);
        agentEventBus.off('chat_done', doneWriter);
        agentEventBus.off('chat_error', errorWriter);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
          res.end();
        }
      });
    } catch (err: any) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.end();
      }
    }
    return;
  }

  // API: GET /api/sessions — 列出所有会话
  if (url === '/api/sessions' && isGet()) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(sessionStore.listSessions()));
    return;
  }

  // API: POST /api/sessions — 创建新会话
  if (url === '/api/sessions' && isPost()) {
    try {
      const body = await readBody(req);
      const { title } = JSON.parse(body || '{}');
      const session = sessionStore.createSession(title);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(session));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: GET /api/sessions/:id — 获取会话详情
  if (url.startsWith('/api/sessions/') && isGet()) {
    const sessionId = url.split('/').pop() || '';
    const session = sessionStore.getSession(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '会话不存在' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(session));
    return;
  }

  // API: PUT /api/sessions/:id — 更新会话（重命名或更新消息）
  if (url.startsWith('/api/sessions/') && req.method === 'PUT') {
    try {
      const sessionId = url.split('/').pop() || '';
      const body = await readBody(req);
      const { title, messages } = JSON.parse(body);
      if (title) sessionStore.renameSession(sessionId, title);
      if (messages) sessionStore.updateMessages(sessionId, messages);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: DELETE /api/sessions/:id — 删除会话
  if (url.startsWith('/api/sessions/') && req.method === 'DELETE') {
    try {
      const sessionId = url.split('/').pop() || '';
      sessionStore.deleteSession(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: POST /api/upload — 文件上传
  if (url === '/api/upload' && isPost()) {
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '需要 multipart/form-data' }));
        return;
      }

      // 读取完整 body
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 boundary' }));
        return;
      }

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (c: Buffer) => {
          chunks.push(c);
          const totalSize = chunks.reduce((a, c) => a + c.length, 0);
          const maxBytes = (getConfig().server?.maxUploadSizeMB || 20) * 1024 * 1024;
          if (totalSize > maxBytes) {
            reject(new Error(`文件大小超过限制 (${maxBytes / 1024 / 1024}MB)`));
          }
        });
        req.on('end', () => resolve());
        req.on('error', reject);
      });

      const fullBuffer = Buffer.concat(chunks);
      const parsed = parseMultipart(fullBuffer, boundary);

      if (!parsed || !parsed.filename) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未找到文件' }));
        return;
      }

      // 确保上传目录存在
      const uploadsDir = path.resolve(STATIC_DIR, 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      // 生成唯一文件名
      const ext = path.extname(parsed.filename);
      const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filePath = path.join(uploadsDir, uniqueName);
      fs.writeFileSync(filePath, parsed.data);

      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext.toLowerCase());
      const fileUrl = `/uploads/${uniqueName}`;

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        url: fileUrl,
        filename: parsed.filename,
        isImage,
        size: parsed.data.length,
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1_000_000) reject(new Error('body too large')); });
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

console.log(`[Startup] 准备监听端口 ${PORT}...`);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Startup] ✓ 端口 ${PORT} 监听成功`);
  console.log(`Agent HTTP Server: http://127.0.0.1:${PORT}`);
  ensureAgent().catch(err => console.error('[AgentServer] 初始化失败:', err.message));
});

server.on('error', (err) => {
  console.error(`[Startup] ✗ 监听失败:`, err);
});

process.on('SIGINT', () => { agent?.stop(); server.close(); process.exit(0); });
