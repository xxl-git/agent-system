// TaskHandler — Phase 3 重构：任务处理模块
// 从 agent-core.ts 提取，集成 tracer/circuitBreaker/projectManager 等完整依赖
// 依赖注入模式，便于测试和后续维护

import { agentEventBus } from '@agent-system/events';
import * as nonsense_detector_1 from '@agent-system/resilience';
import * as orchestrator_1 from '../orchestrator';
import * as project_manager_1 from '../projects/project-manager';
import * as collaboration_1 from '../../agents/collaboration';
import * as sub_agent_1 from '../../agents/sub-agent';
import * as orchestrator_2 from '@agent-system/resilience';
import * as health_monitor_1 from '@agent-system/resilience';
import * as session_diagnostics_1 from '@agent-system/resilience';
import * as circuit_breaker_1 from '@agent-system/resilience';
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
    // 熔断器
    circuitBreaker: circuit_breaker_1.CircuitBreaker;
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
    // LLM 路由器（用于 setLLMCall 注入）
    llmRouter: any;
    // 全链路追踪器（可选）
    tracer?: any;
    // 格式化恢复结果
    formatRecoveryResult: (result: any) => string;
    // 项目名称清理
    sanitizeProjectName: (input: string) => string;
}

// ====== TaskHandler 类 ======
export class TaskHandler {
    private deps: ITaskHandlerDeps;

    constructor(deps: ITaskHandlerDeps) {
        this.deps = deps;
    }

    // ====== 主任务处理入口 ======
    async handle(intent: any, rawMessage: string): Promise<string> {
        const { nonsenseDetector, adapter, sessionDiag, healthMon, circuitBreaker,
                projectManager, recovery, orchestrator, llmRouter, tracer } = this.deps;

        const t0 = Date.now();
        const taskSpanId = tracer?.start('handleTask', 'Agent', {
            intent_type: intent.type,
            confidence: intent.confidence,
            summary: intent.summary?.slice(0, 60),
        });
        logger.info(`[Agent] ┌─ handleTask() intent.confidence=${intent.confidence} summary=${intent.summary}`);
        nonsenseDetector.markConversationStart(rawMessage);
        let taskOutput = '';
        let taskError = null;

        try {
            const aliveT0 = Date.now();
            const alive = await adapter.ping();
            logger.debug(`[Agent] │ ├─ ping() ${alive ? '✅' : '❌'} (${Date.now() - aliveT0}ms)`);
            sessionDiag.recordPing(alive);

            if (!alive) {
                healthMon.recordPing(false);
                circuitBreaker.modelFailure(adapter.model, 'ping failed (handleTask)');
                sessionDiag.recordCircuitBreaker(adapter.model, 'LM Studio 不可达 (handleTask)');
                taskOutput = 'WARN: LM Studio not connected.';
                taskError = 'model_unreachable';
                nonsenseDetector.markConversationEnd(false, rawMessage, taskOutput, taskError);
                if (tracer && taskSpanId) tracer.error(taskSpanId, taskError);
                return taskOutput;
            }
            circuitBreaker.modelSuccess(adapter.model);

            // 多Agent任务检测
            if (this.isMultiAgentTask(rawMessage)) {
                logger.info('[Agent] │ └─ 检测为多Agent任务 → handleMultiAgentTask()');
                taskOutput = await this.handleMultiAgentTask(intent, rawMessage);
                nonsenseDetector.markConversationEnd(true, rawMessage, taskOutput);
                if (tracer && taskSpanId) {
                    tracer.end(taskSpanId, { reply_len: taskOutput.length, dur: Date.now() - t0 });
                }
                return taskOutput;
            }

            // 项目管理：自动创建/更新项目
            const active = projectManager.getActiveProject();
            const summary = intent.summary || rawMessage.slice(0, 50);
            if (!active) {
                const name = this.deps.sanitizeProjectName(summary || 'new-project');
                projectManager.createProject(name, { description: rawMessage.slice(0, 200), priority: 'P1' });
                projectManager.addTodo(name, { title: summary, status: 'in_progress', priority: 'P1' });
            } else {
                projectManager.addTodo(active.project, {
                    title: summary,
                    status: 'in_progress',
                    priority: intent.confidence > 0.8 ? 'P0' : 'P1',
                });
            }

            // Phase 5: 韧性保护执行 + 步骤级检查点
            const taskId = 'task-' + Date.now();
            // 事件总线：执行工具中
            agentEventBus.toolsExecuting(['orchestrator']);
            // 注入 LLM 调用函数供重规划使用
            orchestrator.setLLMCall(async (messages: any[]) => {
                const result = await llmRouter.call({
                    taskType: 'task_decompose',
                    messages: messages,
                    params: { temperature: 0.3, maxTokens: 1024 },
                });
                return result.content;
            });

            const result = await recovery.executeProtected(async () => {
                healthMon.watchTokenStream();
                try {
                    const orchT0 = Date.now();
                    const output = await orchestrator.execute(intent, rawMessage, taskId);
                    logger.info(`[Agent] │ ├─ orchestrator.execute() 完成 (${Date.now() - orchT0}ms)`);
                    const proj = projectManager.getActiveProject();
                    if (proj) projectManager.recalculateProgress(proj.project);
                    return output;
                } finally {
                    healthMon.endTokenStream();
                }
            }, { taskId, context: { model: adapter.model } });

            taskOutput = this.deps.formatRecoveryResult(result);
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

        // 全链路追踪收尾
        if (tracer && taskSpanId) {
            if (taskError) tracer.error(taskSpanId, taskError);
            else tracer.end(taskSpanId, { reply_len: taskOutput.length, dur: Date.now() - t0 });
        }

        logger.info(`[Agent] └─ handleTask() 完成 (${Date.now() - t0}ms) 回复${taskOutput.length}字${taskError ? ' ❌' : ''}`);
        return taskOutput;
    }

    // ====== 判断是否为多Agent任务（正则模式，与 agent-core 原实现一致）======
    isMultiAgentTask(input: string): boolean {
        const patterns = [
            /同时(?:执行|处理|完成|做)/,
            /并行(?:执行|处理|运行|计算)/,
            /分别(?:执行|处理|完成|负责|做)/,
            /(?:需要|让我)(?:多个|几个)(?:agent|智能体|助手)(?:协同|合作|一起|分别)/,
            /(?:团队|协作|分工)(?:完成|执行|处理|模式)/,
            /分配(?:给|到)(?:不同|多个)/,
        ];
        return patterns.some(p => p.test(input));
    }

    // ====== 处理多Agent任务（与 agent-core 原实现一致）======
    async handleMultiAgentTask(intent: any, rawMessage: string): Promise<string> {
        const { scheduler, subAgents } = this.deps;
        logger.info('[Agent] multi-agent: ' + rawMessage.slice(0, 60));

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
}

// ====== 工厂函数：从 AgentCore 实例创建 TaskHandler ======
export function createTaskHandlerFromAgentCore(core: any): TaskHandler {
    const deps: ITaskHandlerDeps = {
        adapter: core.adapter,
        sessionDiag: core.sessionDiag,
        healthMon: core.healthMon,
        circuitBreaker: core.circuitBreaker,
        projectManager: core.projectManager,
        recovery: core.recovery,
        orchestrator: core.orchestrator,
        scheduler: core.scheduler,
        merger: core.merger,
        subAgents: core.subAgents,
        nonsenseDetector: core.nonsenseDetector,
        llmRouter: core.llmRouter,
        tracer: core._tracer,
        formatRecoveryResult: core.formatRecoveryResult.bind(core),
        sanitizeProjectName: core.sanitizeProjectName.bind(core),
    };
    return new TaskHandler(deps);
}
