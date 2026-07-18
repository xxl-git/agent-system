// init-steps.ts
// 从 agent-core.ts 提取的 init() 各步骤子方法
// 将 153 行的 init() 拆分为 7 个独立步骤，提高可测试性

import * as path from 'path';
import * as file_store_1 from '../../memory/file-store';
import * as db_store_1 from '../../memory/db-store';
import * as llm_router_1 from '../../llm/llm-router';
import * as summarizer_1 from '../../memory/summarizer';
import logger from '../../logger';

/** 错误信息提取 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** AgentCore 的最小接口（避免循环依赖） */
interface InitAgent {
  sessionId: string;
  checkpointMgr: {
    listPendingTasks(): any[];
    recoverySummary(): string;
  };
  pendingTaskIds: any[];
  dbInitialized: boolean;
  lastMemoryInjection: any;
  summarizer: any;
  experienceStore: {
    init(): Promise<void>;
    getStats(): { total: number; active: number; patterns: number; pitfalls: number };
  };
  experienceInitialized: boolean;
  promptRegistry: {
    get(id: string, vars: any): { system?: string };
  };
  messages: Array<{ role: string; content: string }>;
  _cachedMemoryBlock: string;
  getIdentityVars(): Record<string, string>;
  onboardModel(): Promise<string>;
  projectManager: {
    recoverySummary(): string;
  };
  registry: {
    size: number;
  };
  adapter: {
    model: string;
  };
  sessionDiag: { setModelName(name: string): void };
  nonsenseDetector: {
    setModelName(name: string): void;
    startMonitor(): void;
  };
  registerDiagnosticPingTask(): void;
  registerModelListHeartbeat(): void;
  registerProactiveTasks(): void;
  orchestrator: { startHeartbeat(): void };
  chatHandler: any;
  commandHandler: any;
  taskHandler: any;
}

/** Step 1: 初始化文件记忆存储 + 裁剪过期记忆 */
export function initMemoryStore(): void {
    try {
        file_store_1.initMemoryStore(path.join(process.cwd(), 'memory'));
        logger.debug('[Agent] 文件记忆存储已初始化');
    }
    catch (err: unknown) {
        logger.warn('[Agent] 文件记忆初始化失败', err);
    }
    // Step 1a: 裁剪过期文件记忆
    try {
        const memStore = file_store_1.getMemoryStore();
        const pruned = memStore.prune(30);
        if (pruned > 0) {
            logger.info(`[Agent] 裁剪了 ${pruned} 个过期记忆文件`);
        }
    }
    catch (err: unknown) {
        logger.warn('[Agent] 文件记忆裁剪失败', err);
    }
    // Step 1b: 清理过期日志 + 归档大日志文件
    try {
        const cleaned = logger.cleanupOldLogs();
        if (cleaned > 0) {
            logger.info(`[Agent] 清理/归档了 ${cleaned} 个旧日志文件`);
        }
    }
    catch (err: unknown) {
        logger.warn('[Agent] 日志清理失败', err);
    }
}

/** Step 2: 检测待恢复的长任务检查点 */
export function initCheckpoints(agent: InitAgent): void {
    try {
        const pendingTasks = agent.checkpointMgr.listPendingTasks();
        if (pendingTasks.length > 0) {
            logger.info(`[Agent] 检测到 ${pendingTasks.length} 个待恢复的长任务检查点`);
            logger.info('[Agent] ' + agent.checkpointMgr.recoverySummary());
            agent.pendingTaskIds = pendingTasks;
        } else {
            agent.pendingTaskIds = [];
        }
    }
    catch (err: unknown) {
        logger.warn('[Agent] 检查点检测失败', err);
        agent.pendingTaskIds = [];
    }
}

/** Step 3: 初始化数据库 */
export async function initDatabase(agent: InitAgent): Promise<void> {
    logger.info('[Agent] Step 3/7: 初始化数据库...');
    try {
        const t0 = Date.now();
        const db = db_store_1.getDBStore();
        await db.init();
        db.startSession(agent.sessionId);
        agent.dbInitialized = true;
        logger.info(`[Agent] 数据库已初始化 (${Date.now() - t0}ms): ${agent.sessionId}`);
    }
    catch (err: unknown) {
        logger.warn('[Agent] DB init failed', err);
    }
}

/** Step 4: 恢复跨会话记忆 */
export function initMemoryRecovery(agent: InitAgentWithRecovery): { memRecoveryTime: number } {
    logger.info('[Agent] Step 4/7: 恢复跨会话记忆...');
    let memRecoveryTime = 0;
    try {
        const t0 = Date.now();
        agent.lastMemoryInjection = agent.sessionRecoverer.recover();
        memRecoveryTime = Date.now() - t0;
        logger.info(`[Agent] 记忆恢复完成 (${memRecoveryTime}ms): ${agent.lastMemoryInjection.recentDecisions.length} 条决策, ${agent.lastMemoryInjection.trackedEntities.length} 个实体, ${agent.lastMemoryInjection.recentSummaries.length} 条摘要`);
    }
    catch (err: unknown) {
        logger.warn('[Agent] memory recovery failed', err);
    }
    return { memRecoveryTime };
}

/** Step 5: 初始化摘要引擎 + 返回 memoryBlock */
export function initSummarizer(agent: InitAgent): string {
    logger.info('[Agent] Step 5/7: 初始化摘要引擎...');
    let memoryBlock = '';
    try {
        agent.summarizer = summarizer_1.getSummarizer({
            useLLM: true,
            chatFn: async (prompt: string) => {
                const resp = await llm_router_1.getLLMRouter().call({
                    taskType: 'summarize',
                    messages: [{ role: 'user', content: prompt }],
                });
                return resp.choices?.[0]?.message?.content || '';
            },
        });
        logger.info('[Agent] 摘要引擎已初始化 (LLM模式)');
        if (agent.lastMemoryInjection && agent.lastMemoryInjection.systemPromptBlock) {
            memoryBlock = '\n\n[CONTEXT FROM PAST SESSIONS]\n' + agent.lastMemoryInjection.systemPromptBlock;
            logger.info(`[Agent] 注入 memory block: ${agent.lastMemoryInjection.systemPromptBlock.length} 字`);
        }
    }
    catch (err: unknown) {
        logger.warn('[Agent] 摘要引擎初始化失败', err);
    }
    return memoryBlock;
}

/** Step 5.5: 初始化经验模块 */
export async function initExperience(agent: InitAgent): Promise<void> {
    try {
        await agent.experienceStore.init();
        agent.experienceInitialized = true;
        const expStats = agent.experienceStore.getStats();
        logger.info(`[Agent] 经验模块已初始化: ${expStats.total} 条经验 (active=${expStats.active}, patterns=${expStats.patterns}, pitfalls=${expStats.pitfalls})`);
    }
    catch (err: unknown) {
        logger.warn('[Agent] 经验模块初始化失败（非阻塞）', err);
    }
}

/** Step 6: 初始化 system message */
export function initSystemMessage(agent: InitAgent, memoryBlock: string): void {
    const identityVars = agent.getIdentityVars();
    const identityTpl = agent.promptRegistry.get('agent.identity', identityVars);
    const identityContent = identityTpl?.system || 'You are an intelligent Agent assistant. Reply concisely and directly.';
    agent.messages = [{ role: 'system', content: identityContent }];
    // 缓存 memoryBlock 供 handleChat 的 assembler 使用（不再塞进 system）
    if (agent.lastMemoryInjection && agent.lastMemoryInjection.systemPromptBlock) {
        agent._cachedMemoryBlock = agent.lastMemoryInjection.systemPromptBlock;
        logger.info(`[Agent] 记忆块已缓存（将由 PromptAssembler 以 user 角色注入）: ${agent._cachedMemoryBlock.length} 字`);
    }
    logger.info('[Agent] Step 6/7: System message 已设置（via PromptRegistry）');
}

/** Step 7: 模型上线探测 */
export async function initModel(agent: InitAgent): Promise<string> {
    logger.info('[Agent] Step 7/7: 模型上线探测...');
    const modelT0 = Date.now();
    const onboardResult = await agent.onboardModel();
    logger.info(`[Agent] 模型探测完成 (${Date.now() - modelT0}ms): ${onboardResult.replace(/\n/g, ' | ')}`);
    return onboardResult;
}

/** InitAgent 需要 sessionRecoverer 属性 */
export interface InitAgentWithRecovery extends InitAgent {
  sessionRecoverer: { recover(): any };
}
