// info-commands.ts
// 从 agent-core.ts 提取的信息查询命令（audit, memory, context, idle, diag, models）

import * as file_store_1 from '../../memory/file-store';
import * as db_store_1 from '../../memory/db-store';
import * as model_profile_1 from '../../models/profile/model-profile';
import * as modelCommands from './model-commands';

/** AgentCore 的最小接口（避免循环依赖） */
interface InfoCommandAgent {
  auditLog: {
    getSessionSummary(): string;
    query(opts: any): any[];
  };
  lastMemoryInjection: any;
  sessionRecoverer: {
    recover(): any;
  };
  messages: Array<{ role: string; content: string }>;
  ctxManager: {
    getStats(): any;
    reset(): void;
  };
  adapter: {
    model: string;
    getEffectiveContextWindow(): number;
    isSessionReset(): boolean;
  };
  idleTaskMgr: {
    getStats(): any;
    getPendingTasks(): any[];
    getRecentLogs(n: number): any[];
    processAll(): Promise<void>;
  };
  sessionDiag: {
    getStats(): any;
    getUndiagnosedSnapshots(): any[];
    getReportPaths(): string[];
    recordManual(reason: string, msgs: any[]): void;
  };
  _availableModels: Array<{ id: string; context_length?: number; arch?: string }>;
}

/** 错误信息提取 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * /audit — 审计日志查询
 */
export function handleAuditCommand(agent: InfoCommandAgent, args: string[]): string {
    const sub = args[0] || 'summary';
    switch (sub) {
        case 'summary': return agent.auditLog.getSessionSummary();
        case 'recent': {
            const events = agent.auditLog.query({ limit: 20 });
            if (events.length === 0)
                return 'No audit events';
            return 'Recent (' + events.length + '):\n' + events.map(e => '  [' + e.timestamp.slice(11, 19) + '] ' + e.category + '/' + e.action + ' → ' + e.result).join('\n');
        }
        case 'errors': {
            const errors = agent.auditLog.query({ category: 'error', limit: 10 });
            if (errors.length === 0)
                return 'No errors';
            return 'Errors (' + errors.length + '):\n' + errors.map(e => '  [' + e.timestamp.slice(11, 19) + '] ' + e.target + ': ' + (e.meta.errorMessage ?? '?')).join('\n');
        }
        case 'search': {
            const kw = args[1];
            if (!kw)
                return 'Usage: /audit search <keyword>';
            const found = agent.auditLog.query({ keyword: kw, limit: 10 });
            if (found.length === 0)
                return 'No matches for: ' + kw;
            return 'Matches (' + found.length + '):\n' + found.map(e => '  [' + e.timestamp.slice(11, 19) + '] ' + e.category + ': ' + e.action).join('\n');
        }
        default: return 'Audit: /audit summary|recent|errors|search';
    }
}

/**
 * /memory — 记忆状态查询
 */
export function handleMemoryCommand(agent: InfoCommandAgent, args: string[]): string {
    const sub = args[0] || 'status';
    switch (sub) {
        case 'status': {
            if (!agent.lastMemoryInjection)
                return 'No memory loaded';
            const mi = agent.lastMemoryInjection;
            let s = 'Memory status:\n';
            s += '  Decisions: ' + mi.recentDecisions.length + '\n';
            s += '  Entities: ' + mi.trackedEntities.length + '\n';
            s += '  Summaries: ' + mi.recentSummaries.length + '\n';
            s += '  File mem: ' + (mi.recentFileMemory.length > 0 ? mi.recentFileMemory.length + ' chars' : 'none') + '\n';
            // 文件记忆存储统计
            try {
                const store = file_store_1.getMemoryStore();
                const stats = store.getStats();
                s += '  File store: ' + stats.fileCount + ' files, ' + (stats.totalBytes / 1024).toFixed(1) + ' KB';
                if (stats.oldestFile)
                    s += ' (oldest: ' + stats.oldestFile + ')';
            }
            catch { }
            // DB 统计
            try {
                const dbStats = db_store_1.getDBStore().getStats();
                s += '\n  DB: ' + dbStats.replace(/\n/g, ', ');
            }
            catch { }
            return s;
        }
        case 'decisions': {
            if (!agent.lastMemoryInjection || agent.lastMemoryInjection.recentDecisions.length === 0)
                return 'No recent decisions';
            return 'Recent decisions:\n' + agent.lastMemoryInjection.recentDecisions.map(d => '  [' + d.timestamp.slice(0, 16) + '] ' + d.category + ': ' + d.summary).join('\n');
        }
        case 'entities': {
            if (!agent.lastMemoryInjection || agent.lastMemoryInjection.trackedEntities.length === 0)
                return 'No tracked entities';
            return 'Tracked entities:\n' + agent.lastMemoryInjection.trackedEntities.map(e => '  ' + e.type + ': ' + e.name + ' (' + e.mention_count + 'x)').join('\n');
        }
        case 'reload': {
            try {
                agent.lastMemoryInjection = agent.sessionRecoverer.recover();
                if (agent.lastMemoryInjection.systemPromptBlock) {
                    const sysMsg = agent.messages[0];
                    const base = 'You are an intelligent Agent assistant. Reply concisely and directly.';
                    agent.messages[0] = {
                        role: 'system',
                        content: base + '\n\n[CONTEXT FROM PAST SESSIONS]\n' + agent.lastMemoryInjection.systemPromptBlock,
                    };
                }
                return 'Memory reloaded: ' + agent.lastMemoryInjection.recentDecisions.length + ' decisions, ' + agent.lastMemoryInjection.trackedEntities.length + ' entities';
            }
            catch {
                return 'Memory reload failed';
            }
        }
        default: return 'Memory: /memory status|decisions|entities|reload';
    }
}

/**
 * /context — 上下文管理器状态
 */
export function handleContextCommand(agent: InfoCommandAgent, args: string[]): string {
    const stats = agent.ctxManager.getStats();
    const lines = [
        '=== Context Manager ===',
        `压缩层级: ${stats.compressionLevel}`,
        `触发次数: ${stats.compressionCount}`,
        `压缩块数: ${stats.compressedBlocks}`,
        `累积摘要: ~${stats.accumulatedSummary} tokens`,
        `当前消息数: ${agent.messages.length}`,
        `配置: maxTokens=${stats.config.maxTokens}, hotWindow=${stats.config.hotWindowSize}`,
        `注意力评分: ${stats.config.attentionEnabled ? '开启' : '关闭'}`,
        `触发阈值: ${(stats.config.compressionThreshold * 100)}%`,
        `摘要预算: ${stats.config.summaryTokenBudget} tokens`,
    ];
    // 从适配器获取模型实际上下文窗口
    try {
        const effectiveWindow = agent.adapter.getEffectiveContextWindow();
        const sessionReset = agent.adapter.isSessionReset();
        lines.push(`模型有效窗口: ${effectiveWindow} tokens`);
        lines.push(`会话边界: ${sessionReset ? '⚠️ 待开启新会话' : '正常续聊'}`);
    }
    catch {
        // ignore
    }
    if (args[0] === 'reset') {
        agent.ctxManager.reset();
        // 清理 messages 中的压缩摘要块
        const summaryMarkers = ['[此前对话摘要', '[对话历史摘要', '[部分历史已截断', '[CONTEXT FROM PAST SESSIONS]'];
        const before = agent.messages.length;
        // 注意：直接过滤会修改引用，这里返回新数组
        const newMessages = agent.messages.filter(m => {
            if (m.role === 'system') return true;
            if (m.role === 'user' && typeof m.content === 'string') {
                return !summaryMarkers.some(marker => m.content.includes(marker));
            }
            return true;
        });
        const removed = before - newMessages.length;
        // 替换数组内容（保持引用）
        agent.messages.length = 0;
        for (const m of newMessages) agent.messages.push(m);
        lines.push('');
        lines.push(`[✅ 上下文状态已重置，消息历史中清理了 ${removed} 个摘要块]`);
    }
    if (args[0] === 'blocks') {
        const blocks = agent.ctxManager.getStats().compressedBlocks;
        if (!blocks) {
            lines.push('暂无压缩块');
        }
    }
    return lines.join('\n');
}

/**
 * /idle — 空闲任务管理
 */
export function handleIdleCommand(agent: InfoCommandAgent, args: string[]): string {
    const sub = args[0] || 'status';
    switch (sub) {
        case 'status': {
            const stats = agent.idleTaskMgr.getStats();
            const pending = agent.idleTaskMgr.getPendingTasks();
            const lines = [
                '=== Idle Task Manager ===',
                `已执行: ${stats.executed} (成功 ${stats.succeeded} / 失败 ${stats.failed} / 跳过 ${stats.skipped})`,
                `待处理: ${stats.pending}`
            ];
            if (pending.length > 0) {
                lines.push('', '队列:');
                pending.forEach((t) => lines.push(`  [${t.priority}] ${t.name}: ${t.description}`));
            }
            return lines.join('\n');
        }
        case 'pending': {
            const pending = agent.idleTaskMgr.getPendingTasks();
            if (pending.length === 0)
                return '暂无待处理空闲任务';
            return '空闲任务队列:\n' + pending.map((t) => `  [${t.priority}] ${t.name} — ${t.description}`).join('\n');
        }
        case 'log': {
            const count = parseInt(args[1], 10) || 10;
            const logs = agent.idleTaskMgr.getRecentLogs(count);
            if (logs.length === 0)
                return '暂无空闲任务日志';
            return '最近 ' + logs.length + ' 条空闲任务日志:\n' + logs.map((l) => `  [${l.priority}] ${l.taskName}: ${l.success ? '✅' : '❌'} ${l.durationMs}ms — ${l.result}`).join('\n');
        }
        case 'run': {
            // 立即执行一次空闲任务处理
            agent.idleTaskMgr.processAll().catch(() => { });
            return '🔄 空闲任务已触发执行';
        }
        default: return 'Idle: /idle status|pending|log|run';
    }
}

/**
 * /diag — 会话诊断
 */
export function handleDiagCommand(agent: InfoCommandAgent, args: string[]): string {
    const sub = args[0] || 'status';
    switch (sub) {
        case 'status': {
            const stats = agent.sessionDiag.getStats();
            return [
                '=== Session Diagnostics ===',
                `快照总数: ${stats.totalSnapshots}`,
                `未诊断: ${stats.undiagnosed}`,
                `已诊断: ${stats.diagnosed}`,
                `诊断报告: ${stats.reports}`,
                '存储目录: data/pending-diagnostics/',
            ].join('\n');
        }
        case 'list': {
            const undiagnosed = agent.sessionDiag.getUndiagnosedSnapshots();
            if (undiagnosed.length === 0)
                return '暂无待诊断快照';
            return '待诊断:\n' + undiagnosed.map((s) => `  #${s.id.slice(-8)} [${s.trigger}] ${s.error.slice(0, 60)} at ${s.timestamp.slice(11, 19)}`).join('\n');
        }
        case 'reports': {
            const reports = agent.sessionDiag.getReportPaths();
            if (reports.length === 0)
                return '暂无诊断报告';
            return '诊断报告:\n' + reports.join('\n');
        }
        case 'force': {
            // 手动触发诊断
            agent.sessionDiag.recordManual('手动触发: ' + (args.slice(1).join(' ') || '诊断测试'), agent.messages.slice(-3).map(m => ({ role: m.role, content: m.content.slice(0, 200), length: m.content.length })));
            return '🩺 诊断任务已注册 (P0)，下次心跳时自动处理';
        }
        default: return 'Diag: /diag status|list|reports|force <reason>';
    }
}

/**
 * /skills — 技能生态查询
 */
export function handleSkillsCommand(agent: SkillsCommandAgent, args: string[]): string {
    const sub = args[0] || 'list';
    switch (sub) {
        case 'list': {
            const skills = agent.registry.list();
            return skills.length ? 'Skills:\n' + skills.join('\n') : 'No skills';
        }
        case 'gaps': {
            const gaps = agent.gapDetector.listGaps();
            if (gaps.length === 0)
                return 'No gaps';
            return 'Gaps:\n' + gaps.map(g => '  - ' + g.ctx.needed + ' (' + g.count + 'x)').join('\n');
        }
        case 'apply': {
            const needed = args[1];
            if (!needed)
                return 'Usage: /skills apply <name>';
            const apply = agent.gapDetector.generateApplication(needed);
            if (!apply)
                return 'Need 2+ triggers';
            agent.pendingApplies.push(apply);
            return 'Apply: ' + apply.name + ' (' + apply.status + ')';
        }
        case 'audit': {
            if (agent.pendingApplies.length === 0)
                return 'No pending';
            const results = agent.pendingApplies.map(a => {
                const r = agent.auditor.audit(a);
                return '  ' + (r.approved ? 'OK' : r.needsHumanReview ? 'REVIEW' : 'NO') + ' ' + a.name;
            });
            return 'Audit:\n' + results.join('\n');
        }
        case 'process': {
            // 委托回 AgentCore 处理（依赖 developer/tester/equipper 异步流程）
            if (!agent.processPending) return 'Nothing to process';
            const r = agent.processPending();
            return r || 'Nothing to process';
        }
        default: return 'Skills: /skills list|gaps|apply|audit|process';
    }
}

/**
 * /project — 项目管理
 */
export function handleProjectCommand(agent: ProjectCommandAgent, args: string[]): string {
    const sub = args[0] || 'list';
    switch (sub) {
        case 'list': {
            const metas = agent.projectManager.listProjects();
            return metas.length
                ? 'Projects:\n' + metas.map(m => '  ' + (m.active ? '*' : ' ') + ' ' + m.project + ' [' + m.status + '] ' + progressBar(m.progress)).join('\n')
                : 'No projects';
        }
        case 'create': {
            const name = agent.sanitizeProjectName(args.slice(1).join(' ')) || 'project-' + Date.now();
            agent.projectManager.createProject(name, { description: '', priority: 'P1' });
            return 'Created: ' + name;
        }
        case 'switch': {
            const name = args[1];
            if (!name)
                return 'Usage: /project switch <name>';
            agent.projectManager.setActive(name, false);
            return 'Switched: ' + name;
        }
        case 'status': {
            const active = agent.projectManager.getActiveProject();
            if (!active)
                return 'No active project';
            return 'Project: ' + active.project + '\n  Status: ' + active.status + '\n  Progress: ' + progressBar(active.progress);
        }
        default: return 'Project: /project list|create|switch|status';
    }
}

/** 进度条工具函数 */
function progressBar(pct: number): string {
    const filled = Math.round(pct / 10);
    return '[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + '] ' + pct + '%';
}

/** SkillsCommandAgent 接口 */
interface SkillsCommandAgent {
  registry: { list(): string[] };
  gapDetector: { listGaps(): any[]; generateApplication(name: string): any };
  auditor: { audit(apply: any): any };
  pendingApplies: any[];
  processPending?: () => string | null;
}

/** ProjectCommandAgent 接口 */
interface ProjectCommandAgent {
  projectManager: {
    listProjects(): any[];
    createProject(name: string, opts: any): void;
    setActive(name: string, flag: boolean): void;
    getActiveProject(): any;
  };
  sanitizeProjectName(name: string): string;
}
export function handleModelsCommand(agent: InfoCommandAgent, args: string[]): string | Promise<string> {
    const sub = args[0] || 'list';
    const profileStore = model_profile_1.getProfileStore();
    switch (sub) {
        case 'list': {
            // 查询 LM Studio 实时模型列表
            const lines = ['=== LM Studio 已加载模型 ==='];
            const models = agent._availableModels || [];
            if (models.length === 0) {
                lines.push('  ⚠️ 无已加载模型（LM Studio 可能未运行或未加载模型）');
                lines.push('  💡 使用 /models scan 重新扫描');
            } else {
                for (const m of models) {
                    const isCurrent = m.id === agent.adapter.model;
                    const ctx = m.context_length ? `${m.context_length} ctx` : '? ctx';
                    const arch = m.arch || '?';
                    const mark = isCurrent ? ' ← 当前' : '';
                    lines.push(`  ${isCurrent ? '✅' : '  '} ${m.id} (${arch}, ${ctx})${mark}`);
                }
                lines.push(`\n共 ${models.length} 个模型 | 当前: ${agent.adapter.model}`);
                lines.push('💡 使用 /models switch <模型名> 切换');
            }
            return lines.join('\n');
        }
        case 'scan': {
            // 异步扫描，返回提示信息
            return modelCommands.scanModels(agent).catch((err: unknown) => '❌ 扫描失败: ' + errorMessage(err));
        }
        case 'switch': {
            const targetModel = args[1];
            if (!targetModel) {
                return '用法: /models switch <模型名>\n💡 使用 /models list 查看可用模型';
            }
            return modelCommands.switchModel(agent, targetModel);
        }
        case 'detail': {
            const name = args[1] || agent.adapter.model;
            const profile = profileStore.get(name);
            if (!profile)
                return 'No profile: ' + name;
            return 'Model: ' + name + '\n  Stage: ' + profile.stage + '\n  Score: ' + ((profile.capability?.overallScore ?? 0) * 100).toFixed(0) + '%';
        }
        default: return 'Models:\n  /models list — 列出已加载模型\n  /models scan — 重新扫描 LM Studio\n  /models switch <name> — 切换模型\n  /models detail [name] — 查看模型画像';
    }
}
