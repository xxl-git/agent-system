/**
 * =============================================================================
 * AgentCommandHandler — 命令处理模块（从 AgentCore 提取）
 * =============================================================================
 *
 * ## 功能定位
 * 处理所有以 `/` 开头的用户命令，将命令处理逻辑从 AgentCore 中分离出来，
 * 使 AgentCore 更专注于核心对话逻辑。
 *
 * ## 设计模式
 * - 依赖注入：通过构造函数接收所有需要的依赖
 * - 单一职责：只负责命令解析和分发
 * - 可测试性：可以独立测试每个命令处理逻辑
 *
 * ## 使用示例
 * ```typescript
 * const handler = new AgentCommandHandler({
 *   messages: this.messages,
 *   adapter: this.adapter,
 *   sessionId: this.sessionId,
 *   projectManager: this.projectManager,
 *   // ... 其他依赖
 * });
 *
 * const result = await handler.handle('/status');
 * ```
 */

import type { ChatMessage } from '../../models/adapters/lmstudio';
import { getProjectManager } from '../projects/project-manager';
import { getRouter } from '../../models/router/smart-router';
import { getRegistry } from '@agent-system/skills';
import { getGapDetector } from '@agent-system/skills';
import { SkillAuditor, SkillDeveloper, SkillTester, SkillEquipper } from '@agent-system/skills';
import { getRecoveryOrchestrator } from '@agent-system/resilience';
import { getAuditLog } from '../../audit/audit-log';
import { getSummarizer } from '@agent-system/memory';
import { getSessionRecoverer } from '@agent-system/memory';
import { getDBStore } from '@agent-system/memory';
import { getMemoryStore } from '@agent-system/memory';
import { getCheckpointManager } from '@agent-system/resilience';
import { getHealthMonitor } from '@agent-system/resilience';
import { getCircuitBreaker } from '@agent-system/resilience';
import { getExperienceStore, getExperienceExtractor, getExperienceRetriever, getExperienceCommandHandler } from '@agent-system/experience';
import { getNonsenseDetector } from '@agent-system/resilience';
import { getSessionDiagnostics } from '@agent-system/resilience';
import { getIdleTaskManager } from '@agent-system/resilience';
import { getContextManager } from '../context-manager';
import { getProfileStore } from '@agent-system/models-core';
import { getPromptRegistry, getPromptAssembler } from '@agent-system/prompts';
import { getConfig, reloadConfig, getConfigFilePath, formatConfig } from '../../config/agent-system-config';
import { AgentBus } from '../../agents/collaboration';
import { getLLMRouter } from '@agent-system/llm';
import logger from '../../logger';

// ===== 类型定义 =====

export interface CommandHandlerDependencies {
  // 核心状态
  messages: ChatMessage[];
  adapter: any; // IModelAdapter
  sessionId: string;
  
  // 子模块引用（用于更新状态）
  setMessages: (messages: ChatMessage[]) => void;
  setLastMemoryInjection: (injection: any) => void;
  
  // 项目管理
  projectManager: ReturnType<typeof getProjectManager>;
  sanitizeProjectName: (name: string) => string;
  progressBar: (percent: number) => string;
  
  // 模型和路由
  router: ReturnType<typeof getRouter>;
  llmRouter: ReturnType<typeof getLLMRouter>;
  
  // 技能系统
  registry: ReturnType<typeof getRegistry>;
  gapDetector: ReturnType<typeof getGapDetector>;
  auditor: SkillAuditor;
  developer: SkillDeveloper;
  tester: SkillTester;
  equipper: SkillEquipper;
  pendingApplies: any[];
  checkPendingApplies: () => void;
  processPending: () => string | null;
  
  // 多Agent (未使用，保留以便未来扩展)
  subAgents: Map<string, any>;
  bus: AgentBus;
  scheduler: any;
  merger: any;
  
  // 恢复和弹性
  recovery: ReturnType<typeof getRecoveryOrchestrator>;
  healthMon: ReturnType<typeof getHealthMonitor>;
  circuitBreaker: ReturnType<typeof getCircuitBreaker>;
  checkpointMgr: ReturnType<typeof getCheckpointManager>;
  
  // 审计和日志
  auditLog: ReturnType<typeof getAuditLog>;
  
  // 摘要和记忆
  summarizer: ReturnType<typeof getSummarizer>;
  sessionRecoverer: ReturnType<typeof getSessionRecoverer>;
  lastMemoryInjection: any;
  dbStore: ReturnType<typeof getDBStore>;
  memoryStore: ReturnType<typeof getMemoryStore>;
  
  // 上下文管理
  ctxManager: ReturnType<typeof getContextManager>;
  
  // 诊断和监控
  sessionDiag: ReturnType<typeof getSessionDiagnostics>;
  nonsenseDetector: ReturnType<typeof getNonsenseDetector>;
  idleTaskMgr: ReturnType<typeof getIdleTaskManager>;
  
  // 经验模块
  experienceInitialized: boolean;
  experienceCommandHandler: ReturnType<typeof getExperienceCommandHandler>;
  
  // 配置
  config: ReturnType<typeof getConfig>;
  
  // 状态构建
  buildStatus: () => string;
}

export class AgentCommandHandler {
  private deps: CommandHandlerDependencies;
  
  constructor(deps: CommandHandlerDependencies) {
    this.deps = deps;
  }
  
  /**
   * 处理用户命令（主入口）
   */
  async handle(input: string): Promise<string> {
    const cmd = input.slice(1).toLowerCase().trim();
    const args = cmd.split(/\s+/);
    const action = args[0];
    
    switch (action) {
      case 'exit':
      case 'quit':
        // 注意：退出逻辑需要在 AgentCore 中处理，因为需要调用 this.stop()
        return 'EXIT_REQUESTED';
        
      case 'history':
        return this.handleHistoryCommand();
        
      case 'status':
        return this.deps.buildStatus();
        
      case 'project':
        return this.handleProjectCommand(args.slice(1));
        
      case 'models':
        return this.handleModelsCommand(args.slice(1));
        
      case 'router':
        return this.deps.router.status();
        
      case 'skills':
        return this.handleSkillsCommand(args.slice(1));
        
      case 'agents':
        return this.handleAgentsCommand(args.slice(1));
        
      case 'resilience':
        return this.deps.recovery.status();
        
      case 'audit':
        return this.handleAuditCommand(args.slice(1));
        
      case 'summarize':
        return await this.handleSummarizeCommand(args.slice(1));
        
      case 'memory':
        return this.handleMemoryCommand(args.slice(1));
        
      case 'context':
        return this.handleContextCommand(args.slice(1));
        
      case 'idle':
        return this.handleIdleCommand(args.slice(1));
        
      case 'diag':
        return this.handleDiagCommand(args.slice(1));
        
      case 'nonsense':
        return this.handleNonsenseCommand(args.slice(1));
        
      case 'config':
        return this.handleConfigCommand(args.slice(1));
        
      case 'exp':
      case 'experience':
        return await this.handleExperienceCommand(args.slice(1));
        
      case 'help':
        return this.handleHelpCommand();
        
      default:
        return 'Unknown command: ' + action + '. Type /help for available commands.';
    }
  }
  
  // ===== 基础命令 =====
  
  private handleHistoryCommand(): string {
    if (this.deps.messages.length <= 1) return 'No history';
    return 'History:\n' + 
      this.deps.messages
        .filter(m => m.role !== 'system')
        .map(m => '[' + m.role + '] ' + m.content.slice(0, 100))
        .join('\n');
  }
  
  private handleHelpCommand(): string {
    return `Available commands:
  /exit, /quit - Exit the agent
  /history - Show conversation history
  /status - Show agent status
  /project - Project management (list|create|switch|status)
  /models - Model management (list|detail)
  /router - Show router status
  /skills - Skill management (list|gaps|apply|audit|process)
  /agents - Multi-agent management (status|new)
  /resilience - Show resilience status
  /audit - Audit log (summary|recent|errors|search)
  /summarize - Summarize conversation (now|list|recent|patrol)
  /memory - Memory management (status|decisions|entities|reload)
  /context - Context management (show|reset)
  /idle - Idle task management (status|pending|log|run)
  /diag - Diagnostics (status|list|reports|force)
  /nonsense - Nonsense detection status
  /config - Configuration (show|reload|path)
  /exp, /experience - Experience management
  /help - Show this help message`;
  }
  
  // ===== Project 命令 =====
  
  private handleProjectCommand(args: string[]): string {
    const sub = args[0] || 'list';
    const projectManager = this.deps.projectManager;
    
    switch (sub) {
      case 'list': {
        const metas = projectManager.listProjects();
        return metas.length
          ? 'Projects:\n' + 
            metas.map(m => 
              '  ' + (m.active ? '*' : ' ') + ' ' + m.project + 
              ' [' + m.status + '] ' + this.deps.progressBar(m.progress)
            ).join('\n')
          : 'No projects';
      }
      
      case 'create': {
        const name = this.deps.sanitizeProjectName(args.slice(1).join(' ')) || 
                     'project-' + Date.now();
        projectManager.createProject(name, { description: '', priority: 'P1' });
        return 'Created: ' + name;
      }
      
      case 'switch': {
        const name = args[1];
        if (!name) return 'Usage: /project switch <name>';
        projectManager.setActive(name, false);
        return 'Switched: ' + name;
      }
      
      case 'status': {
        const active = projectManager.getActiveProject();
        if (!active) return 'No active project';
        return 'Project: ' + active.project + 
               '\n  Status: ' + active.status + 
               '\n  Progress: ' + this.deps.progressBar(active.progress);
      }
      
      default:
        return 'Project: /project list|create|switch|status';
    }
  }
  
  // ===== Models 命令 =====
  
  private handleModelsCommand(args: string[]): string {
    const sub = args[0] || 'list';
    const profileStore = getProfileStore();
    
    switch (sub) {
      case 'list': {
        const names = profileStore.listModels();
        return 'Models:\n' + names.map((n: string) => '  ' + n).join('\n');
      }
      
      case 'detail': {
        const name = args[1] || this.deps.adapter.model;
        const profile = profileStore.get(name);
        if (!profile) return 'No profile: ' + name;
        return 'Model: ' + name + 
               '\n  Stage: ' + profile.stage + 
               '\n  Score: ' + ((profile.capability?.overallScore ?? 0) * 100).toFixed(0) + '%';
      }
      
      default:
        return 'Models: /models list|detail';
    }
  }
  
  // ===== Skills 命令 =====
  
  private handleSkillsCommand(args: string[]): string {
    const sub = args[0] || 'list';
    const registry = this.deps.registry;
    const gapDetector = this.deps.gapDetector;
    
    switch (sub) {
      case 'list': {
        const skills = registry.list();
        return skills.length ? 'Skills:\n' + skills.join('\n') : 'No skills';
      }
      
      case 'gaps': {
        const gaps = gapDetector.listGaps();
        if (gaps.length === 0) return 'No gaps';
        return 'Gaps:\n' + 
          gaps.map(g => '  - ' + g.ctx.needed + ' (' + g.count + 'x)').join('\n');
      }
      
      case 'apply': {
        const needed = args[1];
        if (!needed) return 'Usage: /skills apply <name>';
        const apply = gapDetector.generateApplication(needed);
        if (!apply) return 'Need 2+ triggers';
        this.deps.pendingApplies.push(apply);
        return 'Apply: ' + apply.name + ' (' + apply.status + ')';
      }
      
      case 'audit': {
        if (this.deps.pendingApplies.length === 0) return 'No pending';
        const results = this.deps.pendingApplies.map(a => {
          const r = this.deps.auditor.audit(a);
          return '  ' + (r.approved ? 'OK' : r.needsHumanReview ? 'REVIEW' : 'NO') + ' ' + a.name;
        });
        return 'Audit:\n' + results.join('\n');
      }
      
      case 'process': {
        const r = this.deps.processPending();
        return r || 'Nothing to process';
      }
      
      default:
        return 'Skills: /skills list|gaps|apply|audit|process';
    }
  }
  
  // ===== Agents 命令 =====
  
  private handleAgentsCommand(args: string[]): string {
    const sub = args[0] || 'status';
    
    switch (sub) {
      case 'status':
        return 'Agents: ' + this.deps.subAgents.size + ' registered';
        
      case 'new': {
        const name = args[1] || 'worker';
        // 延迟导入，避免循环依赖
        const { SubAgent } = require('../sub-agent');
        this.deps.subAgents.set(name, new SubAgent({ 
          name, 
          systemPrompt: 'Assistant ' + name 
        }));
        return 'Created: ' + name;
      }
      
      default:
        return 'Agents: /agents status|new';
    }
  }
  
  // ===== Audit 命令 =====
  
  private handleAuditCommand(args: string[]): string {
    const sub = args[0] || 'summary';
    const auditLog = this.deps.auditLog;
    
    switch (sub) {
      case 'summary':
        return auditLog.getSessionSummary();
        
      case 'recent': {
        const events = auditLog.query({ limit: 20 });
        if (events.length === 0) return 'No audit events';
        return 'Recent (' + events.length + '):\n' + 
          events.map(e => 
            '  [' + e.timestamp.slice(11, 19) + '] ' + 
            e.category + '/' + e.action + ' → ' + e.result
          ).join('\n');
      }
      
      case 'errors': {
        const errors = auditLog.query({ category: 'error', limit: 10 });
        if (errors.length === 0) return 'No errors';
        return 'Errors (' + errors.length + '):\n' + 
          errors.map(e => 
            '  [' + e.timestamp.slice(11, 19) + '] ' + 
            e.target + ': ' + (e.meta.errorMessage ?? '?')
          ).join('\n');
      }
      
      case 'search': {
        const kw = args[1];
        if (!kw) return 'Usage: /audit search <keyword>';
        const found = auditLog.query({ keyword: kw, limit: 10 });
        if (found.length === 0) return 'No matches for: ' + kw;
        return 'Matches (' + found.length + '):\n' + 
          found.map(e => 
            '  [' + e.timestamp.slice(11, 19) + '] ' + 
            e.category + ': ' + e.action
          ).join('\n');
      }
      
      default:
        return 'Audit: /audit summary|recent|errors|search';
    }
  }
  
  // ===== Summarize 命令 =====
  
  private async handleSummarizeCommand(args: string[]): Promise<string> {
    const sub = args[0] || 'now';
    const summarizer = this.deps.summarizer;
    
    switch (sub) {
      case 'now': {
        const userMsgs = this.deps.messages.filter(m => m.role === 'user');
        if (userMsgs.length < 3) 
          return 'Not enough messages to summarize (need >= 3)';
        
        try {
          const output = await summarizer.summarizeSession(
            this.deps.sessionId,
            this.deps.messages.filter((m: ChatMessage) => m.role !== 'system'),
            []
          );
          
          let report = '📋 Summary for ' + this.deps.sessionId.slice(0, 12) + ':\n';
          report += '  ' + output.sessionSummary + '\n';
          
          if (output.keyDecisions.length > 0) {
            report += 'Key decisions (' + output.keyDecisions.length + '):\n';
            output.keyDecisions.forEach(d => 
              report += '  [' + d.category + '] ' + d.summary + '\n'
            );
          }
          
          if (output.learnedFacts.length > 0) {
            report += 'Facts learned (' + output.learnedFacts.length + '):\n';
            output.learnedFacts.forEach(f => report += '  ✅ ' + f + '\n');
          }
          
          if (output.tags.length > 0) 
            report += 'Tags: ' + output.tags.join(', ') + '\n';
          
          if (output.nextSteps.length > 0) 
            report += 'Next: ' + output.nextSteps.join('; ');
          
          return report;
        } catch (err: any) {
          return 'Summarization failed: ' + err.message;
        }
      }
      
      case 'list': {
        const summaries = summarizer.getSummaries(this.deps.sessionId);
        if (summaries.length === 0) return 'No summaries yet';
        return 'Summaries (' + summaries.length + '):\n' + 
          summaries.map(s => 
            '  [' + s.timestamp.slice(0, 16) + '] ' + s.content.slice(0, 100)
          ).join('\n');
      }
      
      case 'recent': {
        const recent = summarizer.getRecentSummaries(5);
        if (recent.length === 0) return 'No recent summaries';
        return 'Recent (' + recent.length + '):\n' + 
          recent.map(r => 
            '  [' + r.timestamp.slice(0, 16) + '] ' + r.content.slice(0, 100)
          ).join('\n');
      }
      
      case 'patrol': {
        const patrol = await summarizer.patrolSummary(this.deps.sessionId, this.deps.messages);
        return patrol || 'Below patrol threshold (' + this.deps.messages.length + ' msgs)';
      }
      
      default:
        return 'Summarize: /summarize now|list|recent|patrol';
    }
  }
  
  // ===== Memory 命令 =====
  
  private handleMemoryCommand(args: string[]): string {
    const sub = args[0] || 'status';
    
    switch (sub) {
      case 'status': {
        if (!this.deps.lastMemoryInjection) return 'No memory loaded';
        const mi = this.deps.lastMemoryInjection;
        let s = 'Memory status:\n';
        s += '  Decisions: ' + mi.recentDecisions.length + '\n';
        s += '  Entities: ' + mi.trackedEntities.length + '\n';
        s += '  Summaries: ' + mi.recentSummaries.length + '\n';
        s += '  File mem: ' + (mi.recentFileMemory.length > 0 ? 
             mi.recentFileMemory.length + ' chars' : 'none') + '\n';
        
        // 文件记忆存储统计
        try {
          const store = getMemoryStore();
          const stats = store.getStats();
          s += '  File store: ' + stats.fileCount + ' files, ' + 
               (stats.totalBytes / 1024).toFixed(1) + ' KB';
          if (stats.oldestFile) s += ' (oldest: ' + stats.oldestFile + ')';
        } catch {}
        
        // DB 统计
        try {
          const dbStats = getDBStore().getStats();
          s += '\n  DB: ' + dbStats.replace(/\n/g, ', ');
        } catch {}
        
        return s;
      }
      
      case 'decisions': {
        if (!this.deps.lastMemoryInjection || 
            this.deps.lastMemoryInjection.recentDecisions.length === 0) 
          return 'No recent decisions';
        
        return 'Recent decisions:\n' + 
          this.deps.lastMemoryInjection.recentDecisions.map((d: any) => 
            '  [' + d.timestamp.slice(0, 16) + '] ' + 
            d.category + ': ' + d.summary
          ).join('\n');
      }
      
      case 'entities': {
        if (!this.deps.lastMemoryInjection || 
            this.deps.lastMemoryInjection.trackedEntities.length === 0) 
          return 'No tracked entities';
        
        return 'Tracked entities:\n' + 
          this.deps.lastMemoryInjection.trackedEntities.map((e: any) => 
            '  ' + e.type + ': ' + e.name + ' (' + e.mention_count + 'x)'
          ).join('\n');
      }
      
      case 'reload': {
        try {
          const injection = this.deps.sessionRecoverer.recover();
          this.deps.setLastMemoryInjection(injection);
          
          if (injection.systemPromptBlock) {
            const sysMsg = this.deps.messages[0];
            const base = 'You are an intelligent Agent assistant. Reply concisely and directly.';
            this.deps.setMessages([
              { role: 'system', content: base + '\n\n[CONTEXT FROM PAST SESSIONS]\n' + 
                injection.systemPromptBlock },
              ...this.deps.messages.slice(1)
            ]);
          }
          
          return 'Memory reloaded: ' + 
                 injection.recentDecisions.length + ' decisions, ' + 
                 injection.trackedEntities.length + ' entities';
        } catch (err: any) {
          return 'Memory reload failed: ' + err.message;
        }
      }
      
      default:
        return 'Memory: /memory status|decisions|entities|reload';
    }
  }
  
  // ===== Context 命令 =====
  
  private handleContextCommand(args: string[]): string {
    const stats = this.deps.ctxManager.getStats();
    const lines = [
      '=== Context Manager ===',
      `压缩层级: ${stats.compressionLevel}`,
      `触发次数: ${stats.compressionCount}`,
      `压缩块数: ${stats.compressedBlocks}`,
      `累积摘要: ~${stats.accumulatedSummary} tokens`,
      `当前消息数: ${this.deps.messages.length}`,
      `配置: maxTokens=${stats.config.maxTokens}, hotWindow=${stats.config.hotWindowSize}`,
      `注意力评分: ${stats.config.attentionEnabled ? '开启' : '关闭'}`,
      `触发阈值: ${(stats.config.compressionThreshold * 100)}%`,
      `摘要预算: ${stats.config.summaryTokenBudget} tokens`,
    ];
    
    // 从适配器获取模型实际上下文窗口
    try {
      const effectiveWindow = this.deps.adapter.getEffectiveContextWindow();
      const sessionReset = this.deps.adapter.isSessionReset();
      lines.push(`模型有效窗口: ${effectiveWindow} tokens`);
      lines.push(`会话边界: ${sessionReset ? '⚠️ 待开启新会话' : '正常续聊'}`);
    } catch {}
    
    if (args[0] === 'reset') {
      this.deps.ctxManager.reset();
      lines.push('');
      lines.push('[✅ 上下文状态已重置]');
    }
    
    return lines.join('\n');
  }
  
  // ===== Idle 命令 =====
  
  private handleIdleCommand(args: string[]): string {
    const sub = args[0] || 'status';
    const idleTaskMgr = this.deps.idleTaskMgr;
    
    switch (sub) {
      case 'status': {
        const stats = idleTaskMgr.getStats();
        const pending = idleTaskMgr.getPendingTasks();
        const lines = [
          '=== Idle Task Manager ===',
          `已执行: ${stats.executed} (成功 ${stats.succeeded} / 失败 ${stats.failed} / 跳过 ${stats.skipped})`,
          `待处理: ${stats.pending}`
        ];
        
        if (pending.length > 0) {
          lines.push('', '队列:');
          pending.forEach(t => 
            lines.push(`  [${t.priority}] ${t.name}: ${t.description}`)
          );
        }
        
        return lines.join('\n');
      }
      
      case 'pending': {
        const pending = idleTaskMgr.getPendingTasks();
        if (pending.length === 0) return '暂无待处理空闲任务';
        return '空闲任务队列:\n' + 
          pending.map(t => 
            `  [${t.priority}] ${t.name} — ${t.description}`
          ).join('\n');
      }
      
      case 'log': {
        const count = parseInt(args[1], 10) || 10;
        const logs = idleTaskMgr.getRecentLogs(count);
        if (logs.length === 0) return '暂无空闲任务日志';
        return '最近 ' + logs.length + ' 条空闲任务日志:\n' + 
          logs.map(l => 
            `  [${l.priority}] ${l.taskName}: ${l.success ? '✅' : '❌'} ` + 
            `${l.durationMs}ms — ${l.result}`
          ).join('\n');
      }
      
      case 'run': {
        idleTaskMgr.processAll().catch(() => {});
        return '🔄 空闲任务已触发执行';
      }
      
      default:
        return 'Idle: /idle status|pending|log|run';
    }
  }
  
  // ===== Diag 命令 =====
  
  private handleDiagCommand(args: string[]): string {
    const sub = args[0] || 'status';
    const sessionDiag = this.deps.sessionDiag;
    
    switch (sub) {
      case 'status': {
        const stats = sessionDiag.getStats();
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
        const undiagnosed = sessionDiag.getUndiagnosedSnapshots();
        if (undiagnosed.length === 0) return '暂无待诊断快照';
        return '待诊断:\n' + 
          undiagnosed.map(s => 
            `  #${s.id.slice(-8)} [${s.trigger}] ${s.error.slice(0, 60)} at ` + 
            s.timestamp.slice(11, 19)
          ).join('\n');
      }
      
      case 'reports': {
        const reports = sessionDiag.getReportPaths();
        if (reports.length === 0) return '暂无诊断报告';
        return '诊断报告:\n' + reports.join('\n');
      }
      
      case 'force': {
        sessionDiag.recordManual(
          '手动触发: ' + (args.slice(1).join(' ') || '诊断测试'),
          this.deps.messages.slice(-3).map(m => ({
            role: m.role,
            content: m.content.slice(0, 200),
            length: m.content.length
          }))
        );
        return '🩺 诊断任务已注册 (P0)，下次心跳时自动处理';
      }
      
      default:
        return 'Diag: /diag status|list|reports|force <reason>';
    }
  }
  
  // ===== Nonsense 命令 =====
  
  private handleNonsenseCommand(args: string[]): string {
    const sub = args.join(' ');
    
    if (!sub) {
      const last = this.deps.nonsenseDetector.getLastConversation();
      const active = this.deps.nonsenseDetector.isConversationActive();
      const elapsed = this.deps.nonsenseDetector.getConversationElapsedMs();
      const elapsedStr = elapsed > 0 ? ` (${(elapsed / 1000).toFixed(0)}s)` : '';
      
      const lines = [
        active ? `📞 通话中${elapsedStr}` : '💤 空闲',
      ];
      
      if (last) {
        lines.push(
          `上次会话: ${last.endedNormally ? '✅ 正常' : '⚠️ 异常 (' + (last.reason || '?') + ')'}`,
          `输入: ${last.input.slice(0, 80)}`,
          `输出: ${last.output.slice(0, 80)}`
        );
      } else {
        lines.push('暂无会话记录');
      }
      
      return lines.join('\n');
    }
    
    if (sub === 'force') {
      const input = '(手动强制触发) ' + args.slice(1).join(' ') || '手动诊断';
      this.deps.nonsenseDetector.markConversationEnd(false, input, '(空)');
      this.deps.nonsenseDetector.forceCheck();
      return '✅ 已强制触发胡话检测检查';
    }
    
    return '用法: /nonsense 或 /nonsense force [原因]';
  }
  
  // ===== Config 命令 =====
  
  private handleConfigCommand(args: string[]): string {
    const sub = args.join(' ');
    
    if (!sub || sub === 'show') 
      return formatConfig();
    
    if (sub === 'reload') {
      const result = reloadConfig();
      if (result.success) {
        this.deps.nonsenseDetector.restartMonitor();
        return '✅ 配置已热重载';
      }
      return `❌ 热重载失败: ${result.errors}`;
    }
    
    if (sub === 'path') 
      return `📁 ${getConfigFilePath()}`;
    
    return '用法: /config [show|reload|path]';
  }
  
  // ===== Experience 命令 =====
  
  private async handleExperienceCommand(args: string[]): Promise<string> {
    if (!this.deps.experienceInitialized) {
      return '⚠️ 经验模块未初始化';
    }
    
    return await this.deps.experienceCommandHandler.handle(args);
  }
}

/**
 * 工厂函数：从 AgentCore 实例创建 AgentCommandHandler
 * 
 * 这比手动传递所有依赖项更简洁，降低了 AgentCore 和 AgentCommandHandler 之间的耦合。
 * 
 * 使用示例：
 * ```typescript
 * // 在 AgentCore.init() 末尾
 * this.commandHandler = createCommandHandlerFromAgentCore(this);
 * ```
 */
export function createCommandHandlerFromAgentCore(agent: any): AgentCommandHandler {
  const deps: CommandHandlerDependencies = {
    // 核心状态
    messages: agent.messages,
    adapter: agent.adapter,
    sessionId: agent.sessionId,
    
    // 状态更新方法
    setMessages: (msgs: any[]) => { agent.messages = msgs; },
    setLastMemoryInjection: (inj: any) => { agent.lastMemoryInjection = inj; },
    
    // 项目管理
    projectManager: agent.projectManager,
    sanitizeProjectName: agent.sanitizeProjectName.bind(agent),
    progressBar: agent.progressBar.bind(agent),
    
    // 模型和路由
    router: agent.router,
    llmRouter: agent.llmRouter,
    
    // 技能系统
    registry: agent.registry,
    gapDetector: agent.gapDetector,
    auditor: agent.auditor,
    developer: agent.developer,
    tester: agent.tester,
    equipper: agent.equipper,
    pendingApplies: agent.pendingApplies,
    checkPendingApplies: agent.checkPendingApplies.bind(agent),
    processPending: agent.processPending.bind(agent),
    
    // 多Agent
    subAgents: agent.subAgents,
    bus: agent.bus,
    scheduler: agent.scheduler,
    merger: agent.merger,
    
    // 恢复和弹性
    recovery: agent.recovery,
    healthMon: agent.healthMon,
    circuitBreaker: agent.circuitBreaker,
    checkpointMgr: agent.checkpointMgr,
    
    // 审计和日志
    auditLog: agent.auditLog,
    
    // 摘要和记忆
    summarizer: agent.summarizer,
    sessionRecoverer: agent.sessionRecoverer,
    lastMemoryInjection: agent.lastMemoryInjection,
    dbStore: agent.dbStore,
    memoryStore: agent.memoryStore,
    
    // 上下文管理
    ctxManager: agent.ctxManager,
    
    // 诊断和监控
    sessionDiag: agent.sessionDiag,
    nonsenseDetector: agent.nonsenseDetector,
    idleTaskMgr: agent.idleTaskMgr,
    
    // 经验模块
    experienceInitialized: agent.experienceInitialized,
    experienceCommandHandler: agent.experienceCommandHandler,
    
    // 配置
    config: agent.config,
    
    // 状态构建
    buildStatus: agent.buildStatus.bind(agent),
  };
  
  return new AgentCommandHandler(deps);
}
