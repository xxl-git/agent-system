// agents-command.ts
// 从 agent-core.ts 提取的多 Agent 管理命令

import { SubAgent } from '../../agents/sub-agent';
import logger from '../../logger';

/** AgentCore 的最小接口（避免循环依赖） */
interface AgentsCommandAgent {
  subAgents: Map<string, SubAgent>;
  bus: {
    getHistory(): Array<{ type: string; from: string; to: string; content: string }>;
  };
  scheduler: {
    parallel(tasks: any, subAgents: Map<string, SubAgent>): Promise<{
      merged: {
        successCount: number;
        outputs: Array<{ success: boolean; agentName: string; durationMs: number; output: string }>;
      };
      totalDurationMs: number;
    }>;
  };
}

/**
 * /agents — 多 Agent 管理命令
 * @param agent AgentCore 实例
 * @param args 命令参数
 * @returns 用户可见的结果字符串
 */
export async function handleAgentsCommand(agent: AgentsCommandAgent, args: string[]): Promise<string> {
    const sub = args[0] || 'status';
    switch (sub) {
        case 'status': {
            const lines = [
                `Agents: ${agent.subAgents.size} registered`,
                `Bus messages: ${agent.bus.getHistory().length}`,
                '',
                'Sub-agents:'
            ];
            if (agent.subAgents.size === 0) {
                lines.push('  (none — use /agents new <name>)');
            } else {
                for (const [name, subAgent] of agent.subAgents) {
                    lines.push(`  ${name}: system=${subAgent.config.systemPrompt.slice(0, 40)}...`);
                }
            }
            return lines.join('\n');
        }
        case 'new': {
            const name = args[1] || 'worker';
            if (agent.subAgents.has(name)) {
                return `Agent "${name}" already exists`;
            }
            agent.subAgents.set(name, new SubAgent({ name, systemPrompt: 'Assistant ' + name }));
            return `Created: ${name}`;
        }
        case 'list': {
            const lines = ['Registered agents:'];
            for (const [name] of agent.subAgents) {
                lines.push(`  ${name}`);
            }
            return lines.join('\n') || 'No agents';
        }
        case 'run': {
            const name = args[1];
            const task = args.slice(2).join(' ');
            if (!name) return 'Usage: /agents run <name> <task>';
            if (!task) return 'Usage: /agents run <name> <task>';
            const subAgent = agent.subAgents.get(name);
            if (!subAgent) return `Agent "${name}" not found (use /agents new ${name} first)`;
            logger.info(`[Agent] 多Agent: 派发任务到 ${name}: "${task.slice(0, 60)}"`);
            const result = await subAgent.run(task);
            if (result.success) {
                return `✅ ${name} (${result.durationMs}ms):\n${result.output.slice(0, 500)}${result.output.length > 500 ? '\n... (截断)' : ''}`;
            }
            return `❌ ${name}: ${result.error || 'failed'}`;
        }
        case 'parallel': {
            const tasksRaw = args.slice(1).join(' ');
            if (!tasksRaw) return 'Usage: /agents parallel <task1>|<task2>|... (pipe-separated)';
            const taskParts = tasksRaw.split('|').map(s => s.trim()).filter(Boolean);
            if (taskParts.length < 2) return '需要至少2个任务，用 | 分隔';
            // 确保有足够的子Agent
            const agentNames: string[] = [];
            for (let i = 0; i < taskParts.length; i++) {
                const name = args[i + 1] || `worker-${i}`;
                agentNames.push(name);
                if (!agent.subAgents.has(name)) {
                    agent.subAgents.set(name, new SubAgent({ name, systemPrompt: 'Assistant ' + name }));
                }
            }
            logger.info(`[Agent] 多Agent: 并行执行 ${taskParts.length} 个任务`);
            const tasks = taskParts.map((desc, i) => ({
                id: `parallel-${i}-${Date.now()}`,
                description: desc,
                agentName: agentNames[i],
                priority: i,
            }));
            const result = await agent.scheduler.parallel(tasks, agent.subAgents);
            const merged = result.merged;
            const lines = [
                `⚡ 并行执行完成: ${merged.successCount}/${taskParts.length} 成功`,
                `⏱ 总耗时: ${result.totalDurationMs}ms`,
                '',
                '━━ 详情 ━━',
            ];
            for (const r of merged.outputs) {
                const icon = r.success ? '✅' : '❌';
                lines.push(`${icon} [${r.agentName}] (${r.durationMs}ms): ${r.output.slice(0, 200)}${r.output.length > 200 ? '...' : ''}`);
            }
            return lines.join('\n');
        }
        case 'bus': {
            const msgs = agent.bus.getHistory();
            if (msgs.length === 0) return 'Bus: 无消息';
            return `Bus (${msgs.length} 条):\n` +
                msgs.slice(-5).map(m =>
                    `  [${m.type}] ${m.from} → ${m.to}: ${m.content.slice(0, 60)}...`
                ).join('\n');
        }
        case 'kill': {
            const name = args[1];
            if (!name) return 'Usage: /agents kill <name>';
            if (!agent.subAgents.has(name)) return `Agent "${name}" not found`;
            agent.subAgents.delete(name);
            return `Killed: ${name}`;
        }
        default: return 'Agents: /agents status|list|new|run|parallel|bus|kill';
    }
}
