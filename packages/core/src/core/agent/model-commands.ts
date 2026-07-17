// model-commands.ts
// 从 agent-core.ts 提取的模型扫描和切换命令
// 这些函数接受 AgentCore 实例，避免 this 依赖

import logger from '../../logger';

/** AgentCore 的最小接口（避免循环依赖） */
interface ModelCommandAgent {
  adapter: {
    model: string;
    listModels(): Promise<Array<{ id: string; context_length?: number; arch?: string }>>;
    setModel(model: string): void;
  };
  _availableModels: Array<{ id: string; context_length?: number; arch?: string }>;
  sessionDiag: { setModelName(name: string): void };
  nonsenseDetector: { setModelName(name: string): void };
  breakIn: { setModelName(name: string): void };
}

/**
 * 扫描 LM Studio 已加载的模型列表
 * @param agent AgentCore 实例
 * @returns 用户可见的扫描结果字符串
 */
export async function scanModels(agent: ModelCommandAgent): Promise<string> {
    try {
        const models = await agent.adapter.listModels();
        agent._availableModels = models;
        if (models.length === 0) {
            return '⚠️ LM Studio 无已加载模型，或连接失败。\n💡 请确认 LM Studio 已启动并加载了模型。';
        }
        const lines = [`✅ 扫描完成，发现 ${models.length} 个已加载模型:`];
        for (const m of models) {
            const isCurrent = m.id === agent.adapter.model;
            const ctx = m.context_length ? `${m.context_length} ctx` : '? ctx';
            const arch = m.arch || '?';
            const mark = isCurrent ? ' ← 当前' : '';
            lines.push(`  ${isCurrent ? '✅' : '  '} ${m.id} (${arch}, ${ctx})${mark}`);
        }
        lines.push('\n💡 使用 /models switch <模型名> 切换');
        return lines.join('\n');
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return '❌ 扫描失败: ' + msg;
    }
}

/**
 * 热切换当前模型
 * @param agent AgentCore 实例
 * @param targetModel 目标模型 ID
 * @returns 用户可见的切换结果字符串
 */
export function switchModel(agent: ModelCommandAgent, targetModel: string): string {
    const models = agent._availableModels || [];
    const found = models.find(m => m.id === targetModel);
    if (!found) {
        return `❌ 模型 "${targetModel}" 未在 LM Studio 中加载\n💡 使用 /models list 查看可用模型\n💡 或使用 /models scan 重新扫描`;
    }
    const oldModel = agent.adapter.model;
    if (oldModel === targetModel) {
        return `ℹ️ 当前已使用模型: ${targetModel}`;
    }
    // 执行热切换
    agent.adapter.setModel(targetModel);
    // 更新上下文长度
    if (found.context_length) {
        try {
            // SmartAdapter 代理了 contextLength (getter from raw)
            // 直接设置 raw 的 contextLength
            (agent.adapter as unknown as { raw: { contextLength: number } }).raw.contextLength = found.context_length;
        } catch { /* ignore */ }
    }
    // 更新诊断器中的模型名
    agent.sessionDiag.setModelName(targetModel);
    agent.nonsenseDetector.setModelName(targetModel);
    // 更新 BreakInMachine 模型名
    agent.breakIn.setModelName(targetModel);
    logger.info(`[Agent] 模型热切换: ${oldModel} → ${targetModel} (context=${found.context_length || '?'})`);
    return `✅ 模型已切换: ${oldModel} → ${targetModel}\n  架构: ${found.arch || '?'}\n  上下文: ${found.context_length || '?'} tokens`;
}
