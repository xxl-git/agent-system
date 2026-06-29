// 多 Agent 协作 — 通信总线 + 结果汇聚 + 并行调度 + 资源管理 (Phase 4)
import { SubAgent, type SubAgentConfig, type SubAgentResult } from './sub-agent';
import logger from '../logger';

// ====== Agent 通信总线 ======

export interface AgentTask {
  id: string;
  description: string;
  agentName: string;       // 分配给哪个 Agent
  dependsOn?: string[];    // 依赖的任务ID（DAG 边）
  priority: number;        // 数字越小越优先
}

export interface AgentMessage {
  from: string;
  to: string;
  type: 'task' | 'result' | 'query' | 'reply';
  content: string;
  timestamp: string;
}

export class AgentBus {
  private messages: AgentMessage[] = [];
  private listeners: Map<string, Array<(msg: AgentMessage) => void>> = new Map();

  subscribe(agentName: string, handler: (msg: AgentMessage) => void): void {
    if (!this.listeners.has(agentName)) {
      this.listeners.set(agentName, []);
    }
    this.listeners.get(agentName)!.push(handler);
  }

  send(from: string, to: string, type: AgentMessage['type'], content: string): void {
    const msg: AgentMessage = {
      from, to, type, content,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(msg);

    // 通知目标
    const handlers = this.listeners.get(to);
    if (handlers) {
      for (const h of handlers) handlers.forEach(h => { try { h(msg); } catch {} });
    }
  }

  getHistory(): AgentMessage[] { return this.messages; }
}

// ====== 结果汇聚引擎 ======

export interface MergedResult {
  success: boolean;
  outputs: SubAgentResult[];
  summary: string;
  /** 成功/失败统计 */
  successCount: number;
  failCount: number;
  totalDurationMs: number;
}

export class ResultMerger {
  /** 汇聚多个子 Agent 的结果 */
  merge(results: SubAgentResult[]): MergedResult {
    const successResults = results.filter(r => r.success);
    const failResults = results.filter(r => !r.success);

    const summary = [
      `📊 共 ${results.length} 个子任务`,
      `✅ 成功 ${successResults.length}`,
      failResults.length > 0 ? `❌ 失败 ${failResults.length}` : '',
      '',
      '━━ 结果详情 ━━',
    ].filter(Boolean).join('\n');

    const details = results.map(r =>
      `[${r.success ? '✅' : '❌'}] ${r.agentName}: ${r.output.slice(0, 150)} (${r.durationMs}ms)${r.error ? ` ❗${r.error}` : ''}`
    ).join('\n');

    return {
      success: failResults.length === 0,
      outputs: results,
      summary: `${summary}\n${details}`,
      successCount: successResults.length,
      failCount: failResults.length,
      totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
    };
  }
}

// ====== 并行调度器 ======

export interface ScheduleResult {
  results: SubAgentResult[];
  merged: MergedResult;
  mode: 'sequential' | 'parallel' | 'debate';
  totalDurationMs: number;
}

export class ParallelScheduler {
  private maxParallel = 4;
  private resourceManager: ResourceManager;
  private merger: ResultMerger;

  constructor(maxParallel = 4) {
    this.maxParallel = maxParallel;
    this.resourceManager = new ResourceManager();
    this.merger = new ResultMerger();
  }

  /** 顺序执行 */
  async sequential(
    tasks: AgentTask[],
    agents: Map<string, SubAgent>,
  ): Promise<ScheduleResult> {
    const start = Date.now();
    const results: SubAgentResult[] = [];

    for (const task of tasks) {
      const agent = agents.get(task.agentName);
      if (!agent) {
        results.push({
          agentName: task.agentName,
          success: false,
          output: '',
          durationMs: 0,
          error: `Agent ${task.agentName} 不存在`,
        });
        continue;
      }
      const result = await agent.run(task.description);
      results.push(result);
    }

    return {
      results,
      merged: this.merger.merge(results),
      mode: 'sequential',
      totalDurationMs: Date.now() - start,
    };
  }

  /** 并行执行 */
  async parallel(
    tasks: AgentTask[],
    agents: Map<string, SubAgent>,
  ): Promise<ScheduleResult> {
    const start = Date.now();

    // 按 DAG 依赖拓扑排序分批执行
    const batches = this.topologicalBatches(tasks);
    const allResults: SubAgentResult[] = [];

    for (const batch of batches) {
      // 资源检查
      const available = this.resourceManager.availableSlots();
      const canRun = Math.min(batch.length, available, this.maxParallel);

      // 并行执行同批次
      const promises = batch.slice(0, canRun).map(async task => {
        const agent = agents.get(task.agentName);
        if (!agent) {
          return {
            agentName: task.agentName,
            success: false, output: '', durationMs: 0,
            error: `Agent ${task.agentName} 不存在`,
          } as SubAgentResult;
        }
        this.resourceManager.acquire(task.agentName);
        try {
          return await agent.run(task.description);
        } finally {
          this.resourceManager.release(task.agentName);
        }
      });

      const results = await Promise.all(promises);
      allResults.push(...results);
    }

    return {
      results: allResults,
      merged: this.merger.merge(allResults),
      mode: 'parallel',
      totalDurationMs: Date.now() - start,
    };
  }

  /** 辩论模式：多个 Agent 讨论同一个问题 */
  async debate(
    topic: string,
    agents: SubAgent[],
    rounds: number = 2,
  ): Promise<ScheduleResult> {
    const start = Date.now();
    const results: SubAgentResult[] = [];
    let currentRound = '';

    for (let round = 0; round < rounds; round++) {
      logger.info(`[Debate] 📢 第 ${round + 1} 轮辩论: "${topic.slice(0, 50)}"`);

      const roundTasks = agents.map((agent, i) => {
        const prevContext = round > 0
          ? `\n\n上一轮讨论摘要:\n${results.slice(0, agents.length * round).map(r => `[${r.agentName}]: ${r.output.slice(0, 200)}`).join('\n')}`
          : '';
        return agent.run(`${topic}${prevContext}`);
      });

      const roundResults = await Promise.all(roundTasks);
      results.push(...roundResults);

      // 综合本轮观点
      currentRound = roundResults
        .map(r => `[${r.agentName}]: ${r.output.slice(0, 300)}`)
        .join('\n');
    }

    return {
      results,
      merged: this.merger.merge(results),
      mode: 'debate',
      totalDurationMs: Date.now() - start,
    };
  }

  /** 拓扑排序分批（DAG 并行度控制） */
  private topologicalBatches(tasks: AgentTask[]): AgentTask[][] {
    const batches: AgentTask[][] = [];
    const completed = new Set<string>();
    const remaining = [...tasks];

    while (remaining.length > 0) {
      const batch = remaining.filter(t =>
        !t.dependsOn || t.dependsOn.every(d => completed.has(d))
      );
      if (batch.length === 0) {
        // 环形依赖兜底：剩余全部一起执行
        batches.push([...remaining]);
        break;
      }

      batches.push(batch);
      for (const t of batch) {
        completed.add(t.id);
        remaining.splice(remaining.indexOf(t), 1);
      }
    }

    return batches;
  }

  setMaxParallel(n: number): void { this.maxParallel = n; }
}

// ====== 资源管理器 ======

export class ResourceManager {
  private activeAgents = new Set<string>();
  private maxConcurrent = 4;
  private stats = {
    totalRuns: 0,
    peakConcurrency: 0,
    totalWaitMs: 0,
  };

  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
  }

  acquire(agentName: string): boolean {
    if (this.activeAgents.size >= this.maxConcurrent) return false;
    this.activeAgents.add(agentName);
    this.stats.totalRuns++;
    this.stats.peakConcurrency = Math.max(
      this.stats.peakConcurrency,
      this.activeAgents.size,
    );
    return true;
  }

  release(agentName: string): void {
    this.activeAgents.delete(agentName);
  }

  availableSlots(): number {
    return this.maxConcurrent - this.activeAgents.size;
  }

  status(): string {
    return `🔧 资源: ${this.activeAgents.size}/${this.maxConcurrent} 活跃 | 峰值 ${this.stats.peakConcurrency} | 总执行 ${this.stats.totalRuns} 次`;
  }
}
