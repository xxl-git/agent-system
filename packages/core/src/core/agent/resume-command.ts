// resume-command.ts
// 从 agent-core.ts 提取的长任务恢复命令
// 接受 AgentCore 实例，避免 this 依赖

import { agentEventBus } from '@agent-system/events';
import { toolRegistry } from '../tools/registry';
import logger from '../../logger';

/** AgentCore 的最小接口（避免循环依赖） */
interface ResumeCommandAgent {
  checkpointMgr: {
    listPendingTasks(): string[];
    load(taskId: string): any;
    resume(taskId: string): any;
    save(taskId: string, completed: any, remaining: any[], messages: any[]): void;
    recordFailure(taskId: string, failure: any): void;
    complete(taskId: string): void;
  };
  messages: Array<{ role: string; content: string }>;
  adapter: {
    ping(): Promise<boolean>;
  };
  pendingTaskIds: string[];
}

/** 错误信息提取 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * /resume — 恢复未完成的长任务
 * @param agent AgentCore 实例
 * @param args 命令参数（序号或 taskId）
 * @returns 用户可见的结果字符串
 */
export async function handleResumeCommand(agent: ResumeCommandAgent, args: string[]): Promise<string> {
    const pending = agent.checkpointMgr.listPendingTasks();
    if (pending.length === 0) {
        return '✅ 无待恢复任务。所有长任务均已完成。';
    }

    // /resume 无参数 → 列出待恢复任务
    if (args.length === 0 || args[0] === 'list') {
        const lines = ['📋 待恢复任务 (' + pending.length + '):'];
        for (let i = 0; i < pending.length; i++) {
            const cp = agent.checkpointMgr.load(pending[i]);
            if (!cp) continue;
            const done = cp.completedSteps.length;
            const total = done + cp.pendingSteps.length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            lines.push(`  [${i}] ${cp.originalRequest.slice(0, 60)}`);
            lines.push(`      进度: ${done}/${total} (${pct}%) | 重试: ${cp.retryCount}次 | ID: ${cp.taskId}`);
            if (cp.failures.length > 0) {
                lines.push(`      故障: ${cp.failures.length}次 (最近: ${cp.failures[cp.failures.length - 1].type})`);
            }
        }
        lines.push('\n用法: /resume <序号|taskId> 恢复指定任务');
        return lines.join('\n');
    }

    // 解析参数：序号或 taskId
    let targetTaskId = '';
    const idx = parseInt(args[0]);
    if (!isNaN(idx) && idx >= 0 && idx < pending.length) {
        targetTaskId = pending[idx];
    } else {
        targetTaskId = args[0];
    }

    // 加载检查点
    const resumeResult = agent.checkpointMgr.resume(targetTaskId);
    if (!resumeResult) {
        return `❌ 未找到任务: ${targetTaskId}`;
    }
    if (!resumeResult.canResume) {
        return `❌ 无法恢复: ${resumeResult.reason}\n💡 可使用 /ckpt clear 清除该检查点`;
    }

    const cp = resumeResult.checkpoint;
    logger.info(`[Agent] 恢复任务: ${cp.taskId} (步骤 ${cp.completedSteps.length}/${cp.completedSteps.length + cp.pendingSteps.length})`);

    // 重建上下文
    if (cp.context && cp.context.length > 0) {
        for (const msg of cp.context) {
            if (!agent.messages.some(m => m.content === msg.content && m.role === msg.role)) {
                agent.messages.push(msg);
            }
        }
        logger.info(`[Agent] 恢复了 ${cp.context.length} 条上下文消息`);
    }

    // 执行剩余步骤
    const remainingSteps = cp.pendingSteps;
    const results: string[] = [];
    let allSuccess = true;

    agentEventBus.toolsExecuting(['orchestrator-resume']);

    try {
        const alive = await agent.adapter.ping();
        if (!alive) {
            return '❌ LM Studio 不可达，无法恢复任务。请先启动模型。';
        }

        for (const step of remainingSteps) {
            logger.info(`[Resume] 执行步骤: ${step.title}`);
            try {
                let output = '';
                if (step.tool && step.toolArgs) {
                    const toolResult = await toolRegistry.call(step.tool, step.toolArgs);
                    output = toolResult.success ? toolResult.output : toolResult.error || '失败';
                    if (!toolResult.success) allSuccess = false;
                } else {
                    output = `步骤完成: ${step.description}`;
                }

                results.push(`[${step.tool ? '🔧' : '✅'}] ${step.title}: ${output.slice(0, 200)}`);

                // 保存检查点
                const completed = {
                    step,
                    result: { success: true, output },
                    completedAt: new Date().toISOString(),
                };
                const stillRemaining = remainingSteps.filter((s: any) => s.id !== step.id && s.status === 'pending');
                agent.checkpointMgr.save(cp.taskId, completed, stillRemaining, agent.messages);
            }
            catch (stepErr) {
                logger.error('[Agent] orchestrator.execute() 失败', stepErr);
                allSuccess = false;
                results.push(`[❌] ${step.title}: ${errorMessage(stepErr)}`);
                agent.checkpointMgr.recordFailure(cp.taskId, {
                    type: 'step_execution',
                    message: errorMessage(stepErr),
                    stepIndex: cp.completedSteps.length + results.length - 1,
                    recovered: false,
                });
                break;
            }
        }

        // 如果全部成功，清理检查点
        if (allSuccess) {
            agent.checkpointMgr.complete(cp.taskId);
            // 从 pendingTaskIds 中移除
            agent.pendingTaskIds = agent.pendingTaskIds.filter(id => id !== cp.taskId);
        }

        const summary = `📋 任务恢复完成: ${cp.originalRequest.slice(0, 50)}\n` +
            `已完成步骤: ${cp.completedSteps.length}\n` +
            `本次执行: ${results.length} 步 (${allSuccess ? '全部成功' : '部分失败'})\n` +
            results.map(r => '  ' + r).join('\n');

        agentEventBus.toolsExecuting([]);
        return summary;
    }
    catch (err) {
        agentEventBus.toolsExecuting([]);
        return `❌ 恢复失败: ${errorMessage(err)}\n💡 检查点已保留，可稍后重试 /resume`;
    }
}
