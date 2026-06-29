// Dashboard API — 为 Web UI 面板提供数据
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config';
import { logger } from '../logger';
import { getContextManager } from '../core/context-manager';

// 动态读取 package.json 版本
let _cachedVersion: string | null = null;
function getAgentVersion(): string {
  if (_cachedVersion) return _cachedVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    _cachedVersion = pkg.version || '0.9.2';
  } catch {
    _cachedVersion = '0.9.2';
  }
  return _cachedVersion;
}

// ─── 项目管理摘要 ───
export function getProjectsSummary(): any {
  try {
    const projectsDir = path.resolve(__dirname, '..', '..', 'projects');
    if (!fs.existsSync(projectsDir)) return { projects: [], total: 0, active: null };

    const projects: any[] = [];
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of dirs) {
      const projPath = path.join(projectsDir, d.name);
      const metaPath = path.join(projPath, 'checkpoint.json');
      const todoPath = path.join(projPath, 'TODO.md');
      const progressPath = path.join(projPath, 'PROGRESS.md');

      let meta: any = {};
      let progress = 0;
      let status = 'unknown';

      if (fs.existsSync(metaPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          status = meta.status || 'unknown';
        } catch {}
      }

      // 从 PROGRESS.md 读取进度
      if (fs.existsSync(progressPath)) {
        try {
          const content = fs.readFileSync(progressPath, 'utf-8');
          const done = (content.match(/✅/g) || []).length;
          const total = (content.match(/- \[[ x]\]/g) || []).length;
          progress = total > 0 ? Math.round((done / total) * 100) : 0;
        } catch {}
      }

      // 从 TODO.md 读取待办
      let todos: string[] = [];
      if (fs.existsSync(todoPath)) {
        try {
          const content = fs.readFileSync(todoPath, 'utf-8');
          todos = content.split('\n').filter(l => l.match(/^- \[ \]/)).map(l => l.replace(/^- \[ \] /, '').trim()).slice(0, 5);
        } catch {}
      }

      projects.push({
        name: d.name,
        priority: meta.priority || 'P2',
        status,
        progress,
        description: meta.description || '',
        todos,
        lastUpdated: meta.lastUpdated || null,
        isActive: meta.active || false,
      });
    }

    const active = projects.find(p => p.isActive) || null;
    return { projects, total: projects.length, active };
  } catch (err: any) {
    return { projects: [], total: 0, active: null, error: err.message };
  }
}

// ─── 技能注册摘要 ───
export function getSkillsSummary(): any {
  try {
    const skillsDir = path.resolve(__dirname, '..', '..', 'skills');
    const registryPath = path.join(skillsDir, 'registry.json');

    let registered: any[] = [];
    let pendingApplies: any[] = [];

    if (fs.existsSync(registryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        if (Array.isArray(data)) {
          registered = data.map((s: any) => ({
            name: s.name || s.skillName || 'unknown',
            version: s.version || '0.0.1',
            status: s.status || 'active',
            enabled: s.enabled !== false,
            dangerLevel: s.dangerLevel || 'safe',
            installedAt: s.installedAt || null,
          }));
        }
      } catch {}
    }

    // 检查 pending applies
    const appliesPath = path.join(skillsDir, 'pending-applies.json');
    if (fs.existsSync(appliesPath)) {
      try {
        pendingApplies = JSON.parse(fs.readFileSync(appliesPath, 'utf-8'));
        if (!Array.isArray(pendingApplies)) pendingApplies = [];
      } catch {}
    }

    // 扫描技能目录
    const installedSkills: string[] = [];
    if (fs.existsSync(skillsDir)) {
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const d of skillDirs) {
        const skillMd = path.join(skillsDir, d.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) installedSkills.push(d.name);
      }
    }

    return {
      registered: registered.length > 0 ? registered : installedSkills.map(s => ({ name: s, status: 'active', enabled: true })),
      pendingApplies,
      totalInstalled: installedSkills.length,
      gaps: []
    };
  } catch (err: any) {
    return { registered: [], pendingApplies: [], totalInstalled: 0, gaps: [], error: err.message };
  }
}

// ─── 审计摘要 ───
export function getAuditSummary(): any {
  try {
    const auditDir = path.resolve(__dirname, '..', '..', 'audit');
    const today = new Date().toISOString().slice(0, 10);
    const auditPath = path.join(auditDir, `audit-${today}.log`);

    if (!fs.existsSync(auditPath)) {
      return { totalEvents: 0, successRate: 0, recentEvents: [], today };
    }

    const content = fs.readFileSync(auditPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    let successCount = 0;
    let failCount = 0;
    const recentEvents: any[] = [];

    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.result === 'success') successCount++;
        else if (event.result === 'error' || event.result === 'failure') failCount++;
        if (recentEvents.length < 20) recentEvents.unshift(event);
      } catch {}
    }

    const total = successCount + failCount;
    const successRate = total > 0 ? Math.round((successCount / total) * 100) : 100;

    return {
      totalEvents: lines.length,
      successRate,
      today,
      recentEvents: recentEvents.slice(-10),
    };
  } catch (err: any) {
    return { totalEvents: 0, successRate: 0, recentEvents: [], error: err.message };
  }
}

// ─── 模型状态摘要 ───
export function getModelSummary(agent?: any): any {
  try {
    const model = agent?.adapter?.model || 'unknown';
    const stage = agent?.breakIn?.stage || 'unknown';
    const routerDecisions = agent?.router?.lastDecision || null;
    const profile = agent?.getModelProfile ? agent.getModelProfile() : null;

    return {
      currentModel: model,
      breakInStage: stage,
      lastRouterDecision: routerDecisions,
      profile,
      strategy: agent?.getCapStrategy ? agent.getCapStrategy() : 'auto',
    };
  } catch (err: any) {
    return { currentModel: 'unknown', error: err.message };
  }
}

// ─── 健康/韧性状态 ───
export function getHealthSummary(agent?: any): any {
  try {
    const health = agent?.healthMon?.getSummary ? agent.healthMon.getSummary() : null;
    const circuit = agent?.circuitBreaker?.getStatus ? agent.circuitBreaker.getStatus() : null;
    const degradation = agent?.degradation?.getLevel ? agent.degradation.getLevel() : 0;

    return {
      circuitBreakerState: circuit?.state || 'unknown',
      degradationLevel: degradation || 0,
      healthEvents: health?.recentEvents || [],
      failureCount: health?.failureCount || 0,
      lastFailure: health?.lastFailure || null,
    };
  } catch (err: any) {
    return { circuitBreakerState: 'unknown', error: err.message };
  }
}

// ─── 记忆统计 ───
export function getMemorySummary(agent?: any): any {
  try {
    const dbStats = agent?.getDbStats ? agent.getDbStats() : null;
    const memoryDir = path.resolve(__dirname, '..', '..', 'memory');
    let fileCount = 0;

    if (fs.existsSync(memoryDir)) {
      fileCount = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') || f.endsWith('.json')).length;
    }

    return {
      dbStats,
      memoryFileCount: fileCount,
      sessionId: agent?.sessionId || '-',
    };
  } catch (err: any) {
    return { memoryFileCount: 0, sessionId: '-', error: err.message };
  }
}

// ─── 工具统计 ───
export function getToolsSummary(agent?: any): any {
  try {
    if (agent?.getToolRegistryInfo) {
      return agent.getToolRegistryInfo();
    }
    return null;
  } catch (err: any) {
    return { error: err.message };
  }
}

// ─── 上下文管理摘要 ───
export function getContextSummary(): any {
  try {
    const cm = getContextManager();
    const stats = cm.getStats();
    // 尝试获取模型实际上下文窗口（dashboard 可能没有 adapter 实例）
    let effectiveWindow: number | null = null;
    let sessionReset = false;
    try {
      const cfg = getConfig();
      const rawContext = cfg.models?.providers?.lmstudio?.maxTokens || 4096;
      effectiveWindow = Math.floor(rawContext * 0.80 * 0.85);
    } catch {}
    return {
      enabled: true,
      ...stats,
      sessionReset,
      effectiveWindow,
      compressionTrigger: `超过 ${(stats.config?.compressionThreshold || 0.75) * 100}% 预算时触发，预算=${stats.config?.maxTokens || 4000}`,
    };
  } catch (err: any) {
    return { enabled: false, error: err.message };
  }
}

// ─── 文件浏览 API ───
const WATCHED_DIRS = ['memory', 'config', 'audit', 'projects', '.'] as const;

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function getEntryType(entry: fs.Dirent, fullPath: string): string {
  if (entry.isDirectory()) return 'dir';
  const ext = path.extname(entry.name).toLowerCase();
  const typeMap: Record<string, string> = {
    '.md': 'markdown', '.json': 'json', '.js': 'javascript',
    '.ts': 'typescript', '.html': 'html', '.css': 'css',
    '.log': 'log', '.yaml': 'yaml', '.yml': 'yaml',
    '.txt': 'text', '.ps1': 'powershell',
  };
  return typeMap[ext] || 'file';
}

export function getFileListing(dir: string = ''): any {
  try {
    const root = path.resolve(__dirname, '..', '..');
    // 安全校验：只允许访问白名单目录及子目录
    const normalizedDir = dir.replace(/\//g, '\\').replace(/\\/g, '\\');
    if (normalizedDir.includes('..') || normalizedDir.includes('~') || /^[A-Za-z]:/.test(normalizedDir)) {
      return { error: 'Invalid directory', entries: [], directories: WATCHED_DIRS.map(d => ({ name: d, path: d })) };
    }
    
    const targetDir = dir ? path.resolve(root, dir) : root;
    if (!targetDir.startsWith(root)) {
      return { error: 'Directory outside root', entries: [], directories: WATCHED_DIRS.map(d => ({ name: d, path: d })) };
    }
    if (!fs.existsSync(targetDir)) {
      return { error: 'Directory not found', entries: [], directories: [] };
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const files = entries
      .filter(e => {
        // 忽略隐藏文件和 node_modules
        if (e.name.startsWith('.')) return false;
        if (e.name === 'node_modules' || e.name === 'dist' && !dir) return false;
        return true;
      })
      .map(e => {
        const fullPath = path.join(targetDir, e.name);
        let stat: fs.Stats | null = null;
        try { stat = fs.statSync(fullPath); } catch {}
        const relPath = dir ? `${dir}/${e.name}` : e.name;
        return {
          name: e.name,
          path: relPath,
          type: getEntryType(e, fullPath),
          size: stat ? stat.size : 0,
          sizeFormatted: stat ? formatSize(stat.size) : '0 B',
          mtime: stat ? stat.mtime.toISOString() : null,
          mtimeFormatted: stat ? stat.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-',
          isDirectory: e.isDirectory(),
        };
      })
      .sort((a, b) => {
        // 目录优先，再按名称排序
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    // 父目录导航
    let parent: string | null = null;
    if (dir) {
      const parentDir = path.dirname(dir);
      parent = parentDir === '.' ? null : parentDir.replace(/\\/g, '/');
    }

    // 顶层目录快捷入口
    let quickDirs: { name: string; path: string; count: number }[] = [];
    if (!dir) {
      quickDirs = WATCHED_DIRS
        .filter(d => d !== '.')
        .map(d => {
          const dPath = path.resolve(root, d);
          let count = 0;
          if (fs.existsSync(dPath)) {
            try { count = fs.readdirSync(dPath).length; } catch {}
          }
          return { name: d, path: d, count };
        });
    }

    return {
      currentDir: dir || '/',
      parent,
      quickDirs,
      entries: files,
      total: files.length,
    };
  } catch (err: any) {
    return { error: err.message, entries: [] };
  }
}

// ─── 韧性/重试状态 ──────────────────────────────────────────────────────────
export function getResilienceSummary(agent?: any): any {
  try {
    const cb = agent?.circuitBreaker?.getStatus?.() ?? null;
    const hm = agent?.healthMon?.getSummary?.() ?? null;
    const diag = agent?.sessionDiag?.getSummary?.() ?? null;

    return {
      // 熔断器状态
      circuitBreaker: cb ? {
        state: cb.state ?? 'unknown',
        modelState: cb.modelState ?? {},
        toolState: cb.toolState ?? {},
        pathState: cb.pathState ?? {},
        failureCount: cb.failureCount ?? 0,
        lastFailure: cb.lastFailure ?? null,
      } : null,

      // 健康监控
      healthMonitor: hm ?? null,

      // 会话诊断
      diagnostics: diag?.getStats?.() ?? null,

      // 重试引擎状态（如果有）
      retry: agent?.recovery?.getStats?.() ?? null,

      // 待恢复任务
      pendingTasks: agent?.checkpointMgr?.listPendingTasks?.() ?? [],
      pendingTaskCount: agent?.pendingTaskIds?.length ?? 0,
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

// ─── 完整仪表盘摘要 ───
export function getFullDashboard(agent?: any): any {
  return {
    timestamp: new Date().toISOString(),
    agentVersion: getAgentVersion(),
    uptime: process.uptime(),
    projects: getProjectsSummary(),
    skills: getSkillsSummary(),
    models: getModelSummary(agent),
    health: getHealthSummary(agent),
    memory: getMemorySummary(agent),
    audit: getAuditSummary(),
    context: getContextSummary(),
    logs: getLogStatus(),
    resilience: getResilienceSummary(agent),
  };
}

// ─── 日志轮转状态 ───
export function getLogStatus(): any {
  const config = getConfig();
  const logDir = (config.logging as any).dir || './logs';
  const fullPath = path.resolve(process.cwd(), logDir);
  
  if (!fs.existsSync(fullPath)) {
    return { enabled: true, dir: fullPath, files: [], totalSize: 0 };
  }

  const files = fs.readdirSync(fullPath)
    .filter((f: string) => f.endsWith('.log') || f.endsWith('.gz'))
    .map((f: string) => {
      const fp = path.join(fullPath, f);
      const stat = fs.statSync(fp);
      return {
        name: f,
        size: stat.size,
        mtime: stat.mtime,
        isGz: f.endsWith('.gz'),
      };
    })
    .sort((a: any, b: any) => b.mtime.getTime() - a.mtime.getTime());

  const totalSize = files.reduce((sum: number, f: any) => sum + f.size, 0);
  return {
    enabled: true,
    dir: fullPath,
    maxFileSizeMB: (config.logging as any).maxFileSizeMB || 10,
    maxRotatedFiles: (config.logging as any).maxRotatedFiles || 5,
    files: files.slice(0, 10),
    totalSize,
  };
}

// ─── 注册日志状态端点（由 server.ts 调用）───
export function registerLogStatusEndpoint(server: any) {
  server.get('/api/logs/status', (_req: any, res: any) => {
    res.json(getLogStatus());
  });
}
