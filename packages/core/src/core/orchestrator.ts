// 任务编排器 — Agent 主循环 Plan→Execute→Observe→Replan
import { EventEmitter } from 'events';
import type { SubTask, TaskDAG } from '@agent-system/resilience';
import { TaskDecomposer } from './task-decomposer';
import type { ParsedIntent } from './intent-parser';
import { toolRegistry } from './tools/registry';
import type { ToolResult } from './tools/types';
import { registerBaseTools } from './tools/base-tools';
import { getProjectManager } from './projects/project-manager';
import type { ProjectManager } from './projects/project-manager';
import { getCheckpointManager } from '@agent-system/resilience';
import type { CheckpointManager, CompletedStep } from '@agent-system/resilience';
import logger from '../logger';

export interface OrchestratorConfig {
  maxRetries: number;
  heartbeatIntervalMs: number;
  sandboxRoot: string;
  /** 是否启用动态重规划（Observe→Replan） */
  enableReplan: boolean;
  /** 单次任务最大重规划次数 */
  maxReplans: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxRetries: 2,
  heartbeatIntervalMs: 300000, // 5 分钟
  sandboxRoot: process.cwd(),
  enableReplan: true,
  maxReplans: 2,
};

export class Orchestrator extends EventEmitter {
  public config: OrchestratorConfig;
  public taskHistory: TaskDAG[] = [];
  public completedTasks: SubTask[] = [];
  public sessionId: string;
  private decomposer: TaskDecomposer;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isBusy = false;
  private pm: ProjectManager;
  private ckm: CheckpointManager;
  /** 当前任务的 LLM 调用函数（由 agent-core 注入，用于重规划） */
  private llmCall: ((messages: Array<{role: string; content: string}>) => Promise<string>) | null = null;
  /** 当前活跃的 taskId（用于检查点） */
  private currentTaskId: string | null = null;

  constructor(config?: Partial<OrchestratorConfig>) {
    super();
    this.sessionId = `orch-${Date.now()}`;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.decomposer = new TaskDecomposer();
    this.pm = getProjectManager();
    this.ckm = getCheckpointManager();

    // 注册内置工具
    if (toolRegistry.list().length === 0) {
      registerBaseTools(toolRegistry);
    }
  }

  /** 当前是否正在执行任务 */
  get busy(): boolean {
    return this.isBusy;
  }

  /** A 型主动性：心跳定时器 */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.isBusy) return;
      this.emit('heartbeat');

      // 检查活跃项目的待办
      const active = this.pm.getActiveProject();
      if (active) {
        logger.debug(`[Orchestrator] 💓 心跳: 项目 ${active.project} (${active.progress}%)`);
      }
      this.checkIdleTasks();
    }, this.config.heartbeatIntervalMs);
    logger.info(`[Orchestrator] 心跳已启动 (间隔=${this.config.heartbeatIntervalMs / 1000}s)`);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 注入 LLM 调用函数（用于动态重规划） */
  setLLMCall(fn: (messages: Array<{role: string; content: string}>) => Promise<string>): void {
    this.llmCall = fn;
  }

  /** 执行用户请求 — 含步骤级检查点 + 动态重规划 */
  async execute(intent: ParsedIntent, rawMessage: string, taskId?: string): Promise<string> {
    this.isBusy = true;
    this.emit('execution:start', intent);
    this.currentTaskId = taskId || 'task-' + Date.now();

    try {
      // 如果有活跃项目，尝试恢复检查点
      const activeProject = this.pm.getActiveProject();
      if (activeProject && activeProject.checkpoint) {
        logger.info(`[Orchestrator] 📂 项目 ${activeProject.project} 有检查点，从步骤 ${activeProject.checkpoint.lastSubtask} 继续`);
      }

      const dagT0 = Date.now();
      const dag = await this.decomposer.decompose(
        rawMessage,
        toolRegistry.listNames()
      );
      logger.info(`[Orchestrator] ├─ decompose() 完成 (${Date.now() - dagT0}ms): ${dag.tasks.length} 个子任务, ${(dag.parallelGroups ?? []).length} 个并行组`);

      this.taskHistory.push(dag);
      this.emit('tasks:planned', dag);

      // 注册检查点
      this.ckm.registerTask(this.currentTaskId, rawMessage, dag.tasks);

      const results: string[] = [];
      let completedIds: number[] = [];
      let replanCount = 0;

      // 按并行组依次执行
      const groups = dag.parallelGroups ?? [['1']];
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const groupResults = await Promise.all(
          group.map(taskId => this.executeTask(dag.tasks.find(t => t.id === taskId)!))
        );

        for (const { task, result } of groupResults) {
          task.status = result.success ? 'done' : 'failed';
          task.result = result;
          this.completedTasks.push(task);

          if (result.success) {
            this.emit('task:done', task, result);
            completedIds.push(this.completedTasks.length - 1);
          } else {
            this.emit('task:failed', task, result);
          }

          results.push(`[${task.status === 'done' ? '✅' : '❌'}] ${task.title}: ${result.output?.slice(0, 200) || result.error}`);

          // 步骤级检查点保存
          const remainingSteps = dag.tasks.filter(t => t.status === 'pending');
          const completed: CompletedStep = {
            step: task,
            result: { success: result.success, output: result.output || '', error: result.error },
            completedAt: new Date().toISOString(),
          };
          this.ckm.save(this.currentTaskId, completed, remainingSteps, [], gi + 1);
        }

        // 每组完成后保存项目检查点
        if (activeProject && gi < groups.length - 1) {
          this.pm.saveCheckpoint(
            activeProject.project,
            this.sessionId,
            { taskHistory: this.taskHistory.length, completedCount: this.completedTasks.length },
            completedIds,
            gi + 1
          );
        }

        // ═══ 动态重规划 (Observe→Replan) ═══
        if (this.config.enableReplan && replanCount < this.config.maxReplans && gi < groups.length - 1) {
          const failedInGroup = groupResults.filter(r => !r.result.success);
          if (failedInGroup.length > 0) {
            logger.info(`[Orchestrator] 🔄 检测到 ${failedInGroup.length} 个失败步骤，评估是否需要重规划...`);
            this.emit('replan:evaluating', { groupIndex: gi, failedCount: failedInGroup.length });

            const replanDecision = await this.shouldReplan(dag, failedInGroup, results, rawMessage);
            if (replanDecision.needReplan) {
              replanCount++;
              logger.info(`[Orchestrator] 🔄 重规划 #${replanCount}: ${replanDecision.reason}`);
              this.emit('replan:needed', { reason: replanDecision.reason, newSteps: replanDecision.adjustedSteps });

              // 调整剩余步骤
              if (replanDecision.adjustedSteps && replanDecision.adjustedSteps.length > 0) {
                // 替换剩余步骤
                for (const newStep of replanDecision.adjustedSteps) {
                  const existingIdx = dag.tasks.findIndex(t => t.id === newStep.id);
                  if (existingIdx >= 0) {
                    dag.tasks[existingIdx] = { ...newStep, status: 'pending' };
                  } else {
                    // 新增步骤：追加到最后一个待执行组
                    dag.tasks.push({ ...newStep, status: 'pending' });
                    groups[groups.length - 1].push(newStep.id);
                  }
                }
                this.emit('replan:done', { replanCount, adjustedStepCount: replanDecision.adjustedSteps.length });
              }
            }
          }
        }
      }

      // 全部完成 → 更新项目进度 + 清理检查点
      if (activeProject) {
        this.pm.updateProjectMeta(activeProject.project, { checkpoint: null, status: 'in_progress' });
        this.pm.recalculateProgress(activeProject.project);
        this.pm.writeJournal(activeProject.project, {
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          action: `执行任务: ${rawMessage.slice(0, 80)}`,
          result: dag.tasks.every(t => t.status === 'done') ? 'success' : 'partial',
          next: '等待用户指令',
        });
      }

      // 任务完成，清理检查点
      this.ckm.complete(this.currentTaskId);
      this.currentTaskId = null;

      const summary = this.buildSummary(dag, results);
      this.isBusy = false;
      this.emit('execution:done', summary);
      return summary;

    } catch (err: any) {
      this.isBusy = false;
      this.emit('execution:error', err);
      // 失败时保留检查点，供 /resume 恢复
      logger.warn(`[Orchestrator] 任务失败，检查点已保留: ${this.currentTaskId}`);
      return `❌ 执行出错: ${err.message}\n💡 可使用 /resume 恢复任务`;
    }
  }

  /**
   * 评估是否需要重规划（Observe 阶段）
   * 分析失败原因，决定是否调整后续计划
   */
  private async shouldReplan(
    dag: TaskDAG,
    failedTasks: Array<{ task: SubTask; result: ToolResult }>,
    results: string[],
    originalRequest: string,
  ): Promise<{ needReplan: boolean; reason: string; adjustedSteps?: SubTask[] }> {
    // 如果没有 LLM 调用函数，使用规则判断
    if (!this.llmCall) {
      // 规则：如果超过半数步骤失败，需要重规划
      const totalTasks = dag.tasks.length;
      const failedCount = dag.tasks.filter(t => t.status === 'failed').length;
      if (failedCount > totalTasks / 2) {
        return {
          needReplan: true,
          reason: `失败率过高 (${failedCount}/${totalTasks})，自动触发重规划`,
        };
      }
      return { needReplan: false, reason: '失败率可接受' };
    }

    // LLM 辅助重规划决策
    try {
      const failedSummary = failedTasks.map(f => `- 步骤"${f.task.title}": ${f.result.error || '未知错误'}`).join('\n');
      const remainingSteps = dag.tasks.filter(t => t.status === 'pending').map(t => `- ${t.id}: ${t.title} (${t.description})`).join('\n');

      const prompt = `你是任务重规划助手。分析以下失败情况，决定是否需要调整后续计划。

原始请求: ${originalRequest.slice(0, 200)}

已失败步骤:
${failedSummary}

剩余步骤:
${remainingSteps || '(无)'}

请用 JSON 格式回答：
{"needReplan": true/false, "reason": "简短说明", "adjustedSteps": []}

如果需要重规划，在 adjustedSteps 中提供调整后的步骤（每个步骤包含 id, title, description, tool, toolArgs 字段）。
如果不需要重规划，adjustedSteps 留空。`;

      const response = await this.llmCall([
        { role: 'system', content: '你是任务重规划助手，只输出 JSON。' },
        { role: 'user', content: prompt },
      ]);

      // 提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const decision = JSON.parse(jsonMatch[0]);
        return {
          needReplan: decision.needReplan ?? false,
          reason: decision.reason || 'LLM 评估',
          adjustedSteps: decision.adjustedSteps || [],
        };
      }
    } catch (err) {
      logger.warn('[Orchestrator] 重规划 LLM 调用失败: ' + (err as Error).message);
    }

    return { needReplan: false, reason: '重规划评估失败，继续原计划' };
  }

  private async executeTask(task: SubTask): Promise<{ task: SubTask; result: ToolResult }> {
    const t0 = Date.now();
    task.status = 'running';
    logger.info(`[Orchestrator] ▶ executeTask() id=${task.id} title="${task.title}" tool=${task.tool || 'none'} status=running`);

    if (task.tool && task.toolArgs) {
      logger.debug(`[Orchestrator]   └─ 工具参数: ${JSON.stringify(task.toolArgs).slice(0, 200)}`);
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        const toolT0 = Date.now();
        const result = await toolRegistry.call(task.tool, task.toolArgs as Record<string, string>);
        const toolDur = Date.now() - toolT0;
        if (result.success) {
          logger.info(`[Orchestrator] ✓ executeTask() id=${task.id} ✅ 成功 (${toolDur}ms) output=${result.output?.toString().slice(0, 100) || ''}`);
        } else {
          logger.warn(`[Orchestrator] ✗ executeTask() id=${task.id} ❌ 失败 (${toolDur}ms): ${result.error?.slice(0, 100)}`);
        }
        if (result.success || attempt === this.config.maxRetries) {
          return { task, result };
        }
        logger.warn(`[Orchestrator]   └─ 重试 ${attempt + 1}/${this.config.maxRetries}: ${task.title}`);
      }
    }

    return {
      task,
      result: {
        success: true,
        output: `任务已记录: ${task.description}`,
        durationMs: 0,
      },
    };
  }

  private buildSummary(dag: TaskDAG, results: string[]): string {
    const done = dag.tasks.filter(t => t.status === 'done').length;
    const failed = dag.tasks.filter(t => t.status === 'failed').length;
    const total = dag.tasks.length;

    const header = `📋 任务完成: ${done}/${total}` +
      (failed > 0 ? ` (${failed} 失败)` : '');
    const details = results.map(r => `  ${r}`).join('\n');

    return `${header}\n${details}`;
  }

  private checkIdleTasks(): void {
    this.emit('idle', 'heartbeat');
  }

  getStatus(): string {
    return [
      `工具: ${toolRegistry.listNames().length} 个已注册`,
      `历史会话: ${this.taskHistory.length} 次`,
      `完成子任务: ${this.completedTasks.length} 个`,
      `心跳: ${this.heartbeatTimer ? '运行中' : '已停止'}`,
    ].join('\n');
  }
}
