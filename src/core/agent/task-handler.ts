// @ts-nocheck
// TaskHandler — Phase 3 重构：从 agent-core.ts 提取任务处理逻辑
// 依赖注入模式，便于测试和后续维护

import { agentEventBus } from '../agent-event-bus';
import * as nonsense_detector_1 from '@agent-system/resilience';
import * as orchestrator_1 from '../orchestrator';
import * as project_manager_1 from '../projects/project-manager';
import * as collaboration_1 from '../../agents/collaboration';
import * as sub_agent_1 from '../../agents/sub-agent';
import * as orchestrator_2 from '@agent-system/resilience';
import * as health_monitor_1 from '@agent-system/resilience';
import * as session_diagnostics_1 from '@agent-system/resilience';
import { SmartAdapter } from '@agent-system/llm';
import logger from '../../logger';

// ====== 依赖接口定义 ======
export interface ITaskHandlerDeps {
    // 模型适配器
    adapter: SmartAdapter;
    // 会话诊断
    sessionDiag: session_diagnostics_1.SessionDiagnostics;
    // 健康监控
    healthMon: health_monitor_1.HealthMonitor;
    // 项目管理系统
    projectManager: project_manager_1.ProjectManager;
    // 韧性保障：恢复编排器
    recovery: orchestrator_2.RecoveryOrchestrator;
    // 任务编排器
    orchestrator: orchestrator_1.Orchestrator;
    // 多Agent协作：调度器
    scheduler: collaboration_1.ParallelScheduler;
    // 多Agent协作：结果合并器
    merger: collaboration_1.ResultMerger;
    // 多Agent协作：子Agent集合
    subAgents: Map<string, collaboration_1.SubAgent>;
    // 胡话检测器
    nonsenseDetector: nonsense_detector_1.NonsenseDetector;
}

// ====== TaskHandler 类 ======
export class TaskHandler {
    private deps: ITaskHandlerDeps;

    constructor(deps: ITaskHandlerDeps) {
        this.deps = deps;
    }

    // ====== 主任务处理入口 ======
    async handle(intent: any, rawMessage: string): Promise<string> {
        const { nonsenseDetector, adapter, sessionDiag, healthMon, projectManager, recovery, orchestrator } = this.deps;

        nonsenseDetector.markConversationStart(rawMessage);
        let taskOutput = '';
        let taskError = null;

        try {
            const alive = await adapter.ping();
            sessionDiag.recordPing(alive);

            if (!alive) {
                healthMon.recordPing(false);
                sessionDiag.recordCircuitBreaker(adapter.model, 'LM Studio 不可达 (handleTask)');
                taskOutput = 'WARN: LM Studio not connected.';
                taskError = 'model_unreachable';
                nonsenseDetector.markConversationEnd(false, rawMessage, taskOutput, taskError);
                return taskOutput;
            }

            // 多Agent任务处理
            if (this.isMultiAgentTask(rawMessage)) {
                taskOutput = await this.handleMultiAgentTask(intent, rawMessage);
                nonsenseDetector.markConversationEnd(true, rawMessage, taskOutput);
                return taskOutput;
            }

            // 单任务处理
            const active = projectManager.getActiveProject();
            const summary = intent.summary || rawMessage.slice(0, 50);

            if (!active) {
                const name = this.sanitizeProjectName(summary || 'new-project');
                projectManager.createProject(name, { description: rawMessage.slice(0, 200), priority: 'P1' });
                projectManager.addTodo(name, { title: summary, status: 'in_progress', priority: 'P1' });
            } else {
                projectManager.addTodo(active.project, {
                    title: summary,
                    status: 'in_progress',
                    priority: intent.confidence > 0.8 ? 'P0' : 'P1',
                });
            }

            // Phase 5: 韧性保护执行
            const taskId = 'task-' + Date.now();

            // 事件总线：执行工具中
            agentEventBus.toolsExecuting(['orchestrator']);

            const result = await recovery.executeProtected(async () => {
                healthMon.watchTokenStream();
                try {
                    const output = await orchestrator.execute(intent, rawMessage);
                    const proj = projectManager.getActiveProject();
                    if (proj) {
                        projectManager.recalculateProgress(proj.project);
                    }
                    return output;
                } finally {
                    healthMon.endTokenStream();
                }
            }, { taskId, context: { model: adapter.model } });

            taskOutput = this.formatRecoveryResult(result);
        } catch (err) {
            taskOutput = `ERR: ${err.message || 'unknown error'}`;
            taskError = err.message || 'unknown error';
        }

        // 胡话检测
        const reason = nonsense_detector_1.NonsenseDetector.detectGibberish(taskOutput);
        const normal = !reason && !taskError;
        nonsenseDetector.markConversationEnd(normal, rawMessage, taskOutput, reason || taskError || undefined);

        if (!normal) {
            logger.warn(`[Nonsense] handleTask 检测到异常: ${reason || taskError}`);
        }

        return taskOutput;
    }

    // ====== 判断是否为多Agent任务 ======
    isMultiAgentTask(input: string): boolean {
        const keywords = ['同时', '并行', '分别', '多个', '团队', '协作', '分工'];
        return keywords.some(k => input.includes(k));
    }

    // ====== 处理多Agent任务 ======
    async handleMultiAgentTask(intent: any, rawMessage: string): Promise<string> {
        const { subAgents, scheduler, merger } = this.deps;
        logger.info('[TaskHandler] multi-agent: ' + rawMessage.slice(0, 60));

        // 确保有默认的子Agent
        if (!subAgents.has('frontend')) {
            subAgents.set('frontend', new sub_agent_1.SubAgent({
                name: 'Frontend',
                systemPrompt: 'Frontend engineer. HTML/CSS/JS/React. Reply with code.',
            }));
        }
        if (!subAgents.has('backend')) {
            subAgents.set('backend', new sub_agent_1.SubAgent({
                name: 'Backend',
                systemPrompt: 'Backend engineer. API/DB/server. Reply with code.',
            }));
        }
        if (!subAgents.has('reviewer')) {
            subAgents.set('reviewer', new sub_agent_1.SubAgent({
                name: 'Reviewer',
                systemPrompt: 'Code reviewer. Check quality and security.',
            }));
        }

        const tasks = [
            { id: 'fe', description: 'Frontend: ' + rawMessage, agentName: 'frontend', priority: 1 },
            { id: 'be', description: 'Backend: ' + rawMessage, agentName: 'backend', priority: 1 },
            { id: 'review', description: 'Review both, suggest improvements', agentName: 'reviewer', priority: 2, dependsOn: ['fe', 'be'] },
        ];

        const result = await scheduler.parallel(tasks, subAgents);
        return 'multi-agent done (' + result.mode + ', ' + result.totalDurationMs + 'ms)\n' + result.merged.summary;
    }

    // ====== 项目名称清理 ======
    sanitizeProjectName(input: string): string {
        return input.slice(0, 30)
            .replace(/[^a-zA-Z0-9\-_]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '') || 'project';
    }

    // ====== 格式化恢复结果 ======
    formatRecoveryResult(result: any): string {
        if (result.success) {
            let output = result.output ?? '';
            if (result.recovered) {
                const summary = result.recoveryLog.length > 0
                    ? result.recoveryLog[result.recoveryLog.length - 1]
                    : 'recovered';
                output = '[RECOVERED: ' + summary + ']\n\n' + output;
            }
            if (result.degraded) {
                output = '[DEGRADED L' + (result.degradationLevel ?? '?') + ']\n\n' + output;
            }
            return output;
        } else {
            let output = 'ERR: ' + (result.error || 'unknown error');
            if (result.fallbackUsed) {
                output += '\n[FALLBACK: ' + (result.fallbackReason || 'unknown') + ']';
            }
            return output;
        }
    }
}

// ====== 工厂函数：从 AgentCore 实例创建 TaskHandler ======
export function createTaskHandlerFromAgentCore(core: any): TaskHandler {
    const deps: ITaskHandlerDeps = {
        adapter: core.adapter,
        sessionDiag: core.sessionDiag,
        healthMon: core.healthMon,
        projectManager: core.projectManager,
        recovery: core.recovery,
        orchestrator: core.orchestrator,
        scheduler: core.scheduler,
        merger: core.merger,
        subAgents: core.subAgents,
        nonsenseDetector: core.nonsenseDetector,
    };

    return new TaskHandler(deps);
}
