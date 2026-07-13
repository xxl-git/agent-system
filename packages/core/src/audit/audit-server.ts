// 审计仪表盘 v2 — API + SSE 实时推送
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const PORT = 19700;
const AUDIT_DIR = path.resolve(__dirname, '..', '..', 'audit');
const DASHBOARD = path.resolve(__dirname, '..', '..', 'audit-dashboard.html');
const SSE_CLIENTS = new Set<http.ServerResponse>();

function loadAuditEvents(): any[] {
  const events: any[] = [];
  if (!fs.existsSync(AUDIT_DIR)) return events;
  const files = fs.readdirSync(AUDIT_DIR)
    .filter(f => f.endsWith('.log'))
    .sort();
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(AUDIT_DIR, f), 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try { events.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return events;
}

function computeStats(events: any[]) {
  const byCategory: Record<string, number> = {};
  const byResult: Record<string, number> = {};
  let totalMs = 0;
  let successMs = 0, successCount = 0;
  const hourly: Record<string, { total: number; success: number }> = {};

  for (const e of events) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    byResult[e.result] = (byResult[e.result] || 0) + 1;
    const ms = e.meta?.durationMs || 0;
    totalMs += ms;
    if (e.result === 'success') { successMs += ms; successCount++; }

    // 每小时聚合
    try {
      const h = new Date(e.timestamp).toISOString().slice(0, 13) + ':00';
      if (!hourly[h]) hourly[h] = { total: 0, success: 0 };
      hourly[h].total++;
      if (e.result === 'success') hourly[h].success++;
    } catch {}
  }

  return {
    total: events.length,
    byCategory,
    byResult,
    avgDurationMs: events.length ? Math.round(totalMs / events.length) : 0,
    avgSuccessMs: successCount ? Math.round(successMs / successCount) : 0,
    successRate: events.length ? Math.round(byResult['success'] / events.length * 100) : 0,
    lastEvent: events[events.length - 1] || null,
    hourlyTrend: Object.entries(hourly)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-24)
      .map(([h, v]) => ({ hour: h, ...v, rate: v.total ? Math.round(v.success / v.total * 100) : 0 })),
  };
}

// SSE 广播
function broadcastSSE(data: any) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of SSE_CLIENTS) {
    try { client.write(msg); } catch { SSE_CLIENTS.delete(client); }
  }
}

// 文件监听（简易轮询）
let lastSize = 0;
function watchAuditDir() {
  const stats = loadAuditEvents();
  if (stats.length !== lastSize) {
    lastSize = stats.length;
    broadcastSSE({ type: 'update', stats: computeStats(stats), count: stats.length });
  }
}
setInterval(watchAuditDir, 3000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url || '/';

  // SSE 实时推送
  if (url === '/api/audit/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    SSE_CLIENTS.add(res);
    req.on('close', () => SSE_CLIENTS.delete(res));
    return;
  }

  // API: /api/audit/stats
  if (url === '/api/audit/stats') {
    try {
      const events = loadAuditEvents();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(computeStats(events)));
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: /api/audit (全量)
  if (url === '/api/audit') {
    try {
      const events = loadAuditEvents();
      // 支持 ?limit=N&offset=N
      const params = new URLSearchParams(url.split('?')[1] || '');
      const limit = parseInt(params.get('limit') || '') || events.length;
      const offset = parseInt(params.get('offset') || '') || 0;
      const slice = events.slice(offset, offset + limit);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ events: slice, total: events.length, offset, limit }));
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 静态页面
  if (url === '/' || url === '/audit') {
    try {
      const html = fs.readFileSync(DASHBOARD, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('Dashboard not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Audit dashboard v2: http://127.0.0.1:${PORT}`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
