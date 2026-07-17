// checkpoint-commands.ts
// 从 agent-core.ts 提取的检查点管理命令 (/ckpt, /pause)

/** AgentCore 的最小接口（避免循环依赖） */
interface CheckpointCommandAgent {
  checkpointMgr: {
    listPendingTasks(): string[];
    load(taskId: string): any;
    clearAll(): void;
  };
  pendingTaskIds: string[];
  orchestrator: {
    busy: boolean;
  };
}

/**
 * /ckpt — 检查点管理命令
 * @param agent AgentCore 实例
 * @param args 命令参数
 * @returns 用户可见的结果字符串
 */
export function handleCkptCommand(agent: CheckpointCommandAgent, args: string[]): string {
    const sub = args[0] || 'list';
    switch (sub) {
        case 'list': {
            const pending = agent.checkpointMgr.listPendingTasks();
            if (pending.length === 0) {
                return '✅ 无检查点。';
            }
            const lines = ['📁 检查点列表 (' + pending.length + '):'];
            for (let i = 0; i < pending.length; i++) {
                const cp = agent.checkpointMgr.load(pending[i]);
                if (!cp) continue;
                const done = cp.completedSteps.length;
                const total = done + cp.pendingSteps.length;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                const age = Math.round((Date.now() - new Date(cp.timestamp).getTime()) / 60000);
                lines.push(`  [${i}] ${cp.originalRequest.slice(0, 50)}`);
                lines.push(`      ${done}/${total} (${pct}%) | 重试${cp.retryCount} | ${age}分钟前 | ${cp.taskId}`);
            }
            lines.push('\n用法: /ckpt show <序号> | /ckpt clear');
            return lines.join('\n');
        }
        case 'show': {
            const pending = agent.checkpointMgr.listPendingTasks();
            const idx = parseInt(args[1]);
            if (isNaN(idx) || idx < 0 || idx >= pending.length) {
                return '用法: /ckpt show <序号>';
            }
            const cp = agent.checkpointMgr.load(pending[idx]);
            if (!cp) return '❌ 检查点不存在';
            const lines = [
                `📋 检查点详情: ${cp.taskId}`,
                `原始请求: ${cp.originalRequest}`,
                `进度: ${cp.completedSteps.length}/${cp.completedSteps.length + cp.pendingSteps.length}`,
                `重试次数: ${cp.retryCount}`,
                `创建时间: ${cp.timestamp}`,
                `版本: v${cp.version}`,
                '',
                '已完成步骤:',
            ];
            for (const cs of cp.completedSteps) {
                lines.push(`  ✅ ${cs.step.title}: ${(cs.result.output || '').slice(0, 80)}`);
            }
            if (cp.pendingSteps.length > 0) {
                lines.push('', '待执行步骤:');
                for (const ps of cp.pendingSteps) {
                    lines.push(`  ⏳ ${ps.title}: ${ps.description.slice(0, 80)}`);
                }
            }
            if (cp.failures.length > 0) {
                lines.push('', `故障历史 (${cp.failures.length}):`);
                for (const f of cp.failures.slice(-3)) {
                    lines.push(`  ⚠️ ${f.type}: ${f.message.slice(0, 60)}`);
                }
            }
            return lines.join('\n');
        }
        case 'clear':
        case 'clearall': {
            agent.checkpointMgr.clearAll();
            agent.pendingTaskIds = [];
            return '✅ 已清除所有检查点。';
        }
        default:
            return '用法: /ckpt [list|show <序号>|clear]';
    }
}

/**
 * /pause — 暂停当前任务
 * @param agent AgentCore 实例
 * @param args 命令参数（未使用）
 * @returns 用户可见的结果字符串
 */
export function handlePauseCommand(agent: CheckpointCommandAgent, _args: string[]): string {
    if (!agent.orchestrator.busy) {
        return 'ℹ️ 当前无正在执行的任务。';
    }
    // 检查点已由 orchestrator 自动保存
    const pending = agent.checkpointMgr.listPendingTasks();
    if (pending.length > 0) {
        return `⏸️ 任务已暂停。检查点已保存。\n💡 使用 /resume 恢复任务\n📋 待恢复: ${pending.length} 个任务`;
    }
    return '⏸️ 任务已暂停，但未找到检查点。';
}
