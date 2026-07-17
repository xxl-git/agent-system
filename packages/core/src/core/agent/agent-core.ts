// Agent 核心循环 — Phase 5 升级版
// 集成: 意图解析 + 任务编排 + 工具 + 记忆 + 项目 + 智能路由 + 磨合 + 技能生态 + 多Agent + 韧性保障
import { agentEventBus } from '@agent-system/events';
import * as lmstudio_1 from '../../models/adapters/lmstudio';
import * as smart_adapter_1 from '@agent-system/llm';
import * as llm_router_1 from '@agent-system/llm';
import * as file_store_1 from '@agent-system/memory';
import * as db_store_1 from '@agent-system/memory';
import * as intent_parser_1 from '../intent-parser';
import * as orchestrator_1 from '../orchestrator';
import * as project_manager_1 from '../projects/project-manager';
import * as smart_router_1 from '../../models/router/smart-router';
import * as break_in_machine_1 from '../../models/adaptation/break-in-machine';
import * as model_profile_1 from '@agent-system/models-core';
import * as registry_1 from '@agent-system/skills';
import * as gap_detector_1 from '@agent-system/skills';
import * as pipeline_1 from '@agent-system/skills';
import * as sub_agent_1 from '../../agents/sub-agent';
import * as collaboration_1 from '../../agents/collaboration';
import * as orchestrator_2 from '@agent-system/resilience';
import * as health_monitor_1 from '@agent-system/resilience';
import * as circuit_breaker_1 from '@agent-system/resilience';
import * as checkpoint_1 from '@agent-system/resilience';
import * as session_recovery_1 from '@agent-system/memory';
import * as summarizer_1 from '@agent-system/memory';
import * as audit_log_1 from '../../audit/audit-log';
import * as context_manager_1 from '../context-manager';
import * as idle_task_manager_1 from '@agent-system/resilience';
import * as nonsense_detector_1 from '@agent-system/resilience';
import * as session_diagnostics_1 from '@agent-system/resilience';
import * as agent_system_config_1 from '../../config/agent-system-config';
import * as prompts_1 from '@agent-system/prompts';
import * as experience_1 from '@agent-system/experience';
import { toolRegistry } from '@agent-system/tools';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../../logger';
import { getTracer, finishTrace, createAssemblyReport, addAssemblyStage, formatAssemblyReport, getAssemblyReport } from '@agent-system/resilience';
import { ChatHandler, createChatHandlerFromAgentCore } from './chat-handler';
import { AgentCommandHandler, createCommandHandlerFromAgentCore } from './command-handler';
import { TaskHandler, createTaskHandlerFromAgentCo

/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

re } from './task-handler';

class AgentCore {
    adapter;
    llmRouter;
    intentParser;
    orchestrator;
    projectManager;
    router;
    breakIn;
    // Phase 3: 技能生态
    registry;
    gapDetector;
    auditor;
    developer;
    tester;
    equipper;
    pendingApplies = [];
    // Phase 4: 多Agent
    bus;
    scheduler;
    merger;
    subAgents = new Map();
    // Phase 5: 韧性保障
    recovery;
    healthMon;
    circuitBreaker;
    checkpointMgr;
    pendingTaskIds = [];  // 待恢复的长任务检查点 ID 列表
    // Phase 5 P1: 跨会话记忆恢复 + 审计日志
    sessionRecoverer;
    auditLog;
    // P2: 记忆摘要引擎
    summarizer;
    lastMemoryInjection = null;
    // P7: 上下文管理（无上限上下文）
    ctxManager;
    // Phase 2-3: 提示词注册表 + 组装器
    promptRegistry;
    promptAssembler;
    _cachedMemoryBlock = '';  // 缓存记忆块供 handleChat 使用
    // Experience module: 经验模块
    experienceStore;
    experienceExtractor;
    experienceRetriever;
    experienceCommandHandler;
    experienceInitialized = false;
    // 空闲任务 + 会话诊断 + 胡话检测
    idleTaskMgr;
    sessionDiag;
    nonsenseDetector;
    // 全链路追踪器
    _tracer;
    // 消息装配流水线记录
    _assemblyReport;
    // Phase 1-3 重构：Handler 模块实例（真正集成）
    chatHandler!: ChatHandler;
    commandHandler!: AgentCommandHandler;
    taskHandler!: TaskHandler;
    messages = [];
    running = false;
    sessionId;
    dbInitialized = false;
    modelOnboarded = false;
    // LM Studio 已加载的模型列表（启动时探测 + /models scan 刷新）
    _availableModels = [];
    // 当前配置缓存（避免每次读取 YAML）
    config: any;
    constructor() {
        // Phase 0: 初始化配置（必须在所有模块创建之前，确保 YAML 值生效）
        try { agent_system_config_1.initConfig(); } catch { }
        const cfg = agent_system_config_1.getConfig();
        this.config = cfg;
        const callTimeout = cfg?.agent?.callTimeoutMs || 60000;
        const maxRetries = cfg?.agent?.maxRetries ?? 1;
        const emptyThreshold = cfg?.agent?.emptyLoopThreshold || 3;
        this.adapter = new smart_adapter_1.SmartAdapter(new lmstudio_1.LMStudioAdapter(), {
            callTimeoutMs: callTimeout,
            maxRetries: maxRetries,
            emptyLoopThreshold: emptyThreshold,
        });
        this.llmRouter = llm_router_1.initLLMRouter(this.adapter);
        // Phase 2-3: 初始化提示词系统
        const promptsDir = path.join(process.cwd(), 'config', 'prompts');
        this.promptRegistry = prompts_1.initPromptRegistry(promptsDir);
        this.promptAssembler = prompts_1.getPromptAssembler();
        // Experience module: 延迟初始化（需要 async init）
        this.experienceStore = experience_1.getExperienceStore();
        this.experienceExtractor = experience_1.getExperienceExtractor();
        this.experienceRetriever = experience_1.getExperienceRetriever();
        this.experienceCommandHandler = experience_1.getExperienceCommandHandler();
        this.intentParser = new intent_parser_1.IntentParser(this.adapter);
        this.orchestrator = new orchestrator_1.Orchestrator();
        this.projectManager = project_manager_1.getProjectManager();
        this.router = smart_router_1.getRouter();
        this.breakIn = new break_in_machine_1.BreakInMachine(this.adapter.model);
        // Phase 3
        this.registry = registry_1.getRegistry();
        this.gapDetector = gap_detector_1.getGapDetector();
        this.auditor = new pipeline_1.SkillAuditor();
        this.developer = new pipeline_1.SkillDeveloper();
        this.tester = new pipeline_1.SkillTester();
        this.equipper = new pipeline_1.SkillEquipper();
        // Phase 4
        this.bus = new collaboration_1.AgentBus();
        this.scheduler = new collaboration_1.ParallelScheduler();
        this.merger = new collaboration_1.ResultMerger();
        // Phase 5
        this.recovery = orchestrator_2.getRecoveryOrchestrator();
        this.healthMon = health_monitor_1.getHealthMonitor();
        this.circuitBreaker = circuit_breaker_1.getCircuitBreaker();
        this.checkpointMgr = checkpoint_1.getCheckpointManager();
        // Phase 5 P1
        this.sessionRecoverer = session_recovery_1.getSessionRecoverer();
        this.auditLog = audit_log_1.getAuditLog();
        // 空闲任务调度 + 会话诊断 + 胡话检测
        this.idleTaskMgr = idle_task_manager_1.getIdleTaskManager();
        this.sessionDiag = session_diagnostics_1.getSessionDiagnostics(this.idleTaskMgr);
        this.nonsenseDetector = nonsense_detector_1.getNonsenseDetector(this.idleTaskMgr);
        this.sessionId = 'session-' + Date.now();
        this.auditLog.startSession(this.sessionId);
        // P7: 初始化上下文管理器
        const ctxCfg = cfg?.context;
        this.ctxManager = context_manager_1.getContextManager(ctxCfg);
        this.ctxManager.updateConfig(ctxCfg || {});
        // Phase 5: A 型心跳（空闲时主动巡检）
        this.orchestrator.on('heartbeat', () => {
            this.onHeartbeat();
        });
        // 恢复事件监听 (加审计)
        this.recovery.on('model_switch_needed', (data) => {
            logger.warn('[Agent] model switch: ' + data.reason);
            this.circuitBreaker.modelFailure(data.currentModel, data.reason);
            this.auditLog.logModelSwitch(data.currentModel, 'fallback', data.reason);
        });
        this.recovery.on('context_truncate_needed', () => {
            // P7: 交给 ContextManager 处理（注意力+压缩+摘要）
            logger.info('[Agent] context_truncate_needed — 由ContextManager处理');
        });
        this.recovery.on('adapter_reset_needed', () => {
            this.healthMon.reset();
            this.auditLog.logRecovery('adapter_reset', this.adapter.model, 'success', 0);
        });
        this.recovery.on('session_reset_needed', () => {
            const systemMsg = this.messages[0];
            this.messages = [systemMsg];
            this.auditLog.logRecovery('session_reset', this.sessionId, 'success', 0);
        });
        this.orchestrator.on('task:done', (task, result) => {
            logger.info('[Agent] OK: ' + task.title);
        });
        this.orchestrator.on('task:failed', (task, result) => {
            if (result.error) {
                this.gapDetector.detect({
                    action: 'execute "' + task.title + '"',
                    needed: this.extractNeededCap(result.error),
                    error: result.error,
                });
            }
            logger.warn('[Agent] FAIL: ' + task.title);
        });
    }
    async init() {
        logger.info('[Agent] ====== 初始化开始 ======');
        const initStart = Date.now();
        // Step 0: 配置已在构造函数中加载，跳过
        // Step 1: 初始化文件记忆存储（必须早于 recordInteraction）
        try {
            file_store_1.initMemoryStore(path.join(process.cwd(), 'memory'));
            logger.debug('[Agent] 文件记忆存储已初始化');
        }
        catch (err) {
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
        catch (err) {
            logger.warn('[Agent] 文件记忆裁剪失败', err);
        }
        // Step 1b: 清理过期日志 + 归档大日志文件
        try {
            const cleaned = logger.cleanupOldLogs();
            if (cleaned > 0) {
                logger.info(`[Agent] 清理/归档了 ${cleaned} 个旧日志文件`);
            }
        }
        catch (err) {
            logger.warn('[Agent] 日志清理失败', err);
        }
        // Step 2: 检测待恢复的长任务检查点（不再清除，支持跨会话恢复）
        try {
            const pendingTasks = this.checkpointMgr.listPendingTasks();
            if (pendingTasks.length > 0) {
                logger.info(`[Agent] 检测到 ${pendingTasks.length} 个待恢复的长任务检查点`);
                logger.info('[Agent] ' + this.checkpointMgr.recoverySummary());
                this.pendingTaskIds = pendingTasks;
            } else {
                this.pendingTaskIds = [];
            }
        }
        catch (err) {
            logger.warn('[Agent] 检查点检测失败', err);
            this.pendingTaskIds = [];
        }
        // Step 3: 初始化数据库（记忆恢复依赖 DB）
        logger.info('[Agent] Step 3/7: 初始化数据库...');
        try {
            const t0 = Date.now();
            const db = db_store_1.getDBStore();
            await db.init();
            db.startSession(this.sessionId);
            this.dbInitialized = true;
            logger.info(`[Agent] 数据库已初始化 (${Date.now() - t0}ms): ${this.sessionId}`);
        }
        catch (err) {
            logger.warn('[Agent] DB init failed', err);
        }
        // Step 4: 恢复跨会话记忆（DB + 文件层，此时均已就绪）
        logger.info('[Agent] Step 4/7: 恢复跨会话记忆...');
        let memoryBlock = '';
        let memRecoveryTime = 0;
        try {
            const t0 = Date.now();
            this.lastMemoryInjection = this.sessionRecoverer.recover();
            memRecoveryTime = Date.now() - t0;
            logger.info(`[Agent] 记忆恢复完成 (${memRecoveryTime}ms): ${this.lastMemoryInjection.recentDecisions.length} 条决策, ${this.lastMemoryInjection.trackedEntities.length} 个实体, ${this.lastMemoryInjection.recentSummaries.length} 条摘要`);
        }
        catch (err) {
            logger.warn('[Agent] memory recovery failed', err);
        }
        // Step 5: 初始化摘要引擎
        logger.info('[Agent] Step 5/7: 初始化摘要引擎...');
        try {
            this.summarizer = summarizer_1.getSummarizer({
                useLLM: true,
                chatFn: async (prompt) => {
                    const resp = await llm_router_1.getLLMRouter().call({
                        taskType: 'summarize',
                        messages: [{ role: 'user', content: prompt }],
                    });
                    return resp.choices?.[0]?.message?.content || '';
                },
            });
            logger.info('[Agent] 摘要引擎已初始化 (LLM模式)');
            if (this.lastMemoryInjection && this.lastMemoryInjection.systemPromptBlock) {
                memoryBlock = '\n\n[CONTEXT FROM PAST SESSIONS]\n' + this.lastMemoryInjection.systemPromptBlock;
                logger.info(`[Agent] 注入 memory block: ${this.lastMemoryInjection.systemPromptBlock.length} 字`);
            }
        }
        catch (err) {
            logger.warn('[Agent] 摘要引擎初始化失败', err);
        }
        // Step 5.5: 初始化经验模块
        try {
            await this.experienceStore.init();
            this.experienceInitialized = true;
            const expStats = this.experienceStore.getStats();
            logger.info(`[Agent] 经验模块已初始化: ${expStats.total} 条经验 (active=${expStats.active}, patterns=${expStats.patterns}, pitfalls=${expStats.pitfalls})`);
        }
        catch (err) {
            logger.warn('[Agent] 经验模块初始化失败（非阻塞）', err);
        }
        // Step 6: 初始化 system message（Phase 2-3: 使用 PromptRegistry + 动态变量插值）
        const identityVars = this.getIdentityVars();
        const identityTpl = this.promptRegistry.get('agent.identity', identityVars);
        const identityContent = identityTpl.system || 'You are an intelligent Agent assistant. Reply concisely and directly.';
        this.messages = [{ role: 'system', content: identityContent }];
        // 缓存 memoryBlock 供 handleChat 的 assembler 使用（不再塞进 system）
        if (this.lastMemoryInjection && this.lastMemoryInjection.systemPromptBlock) {
            this._cachedMemoryBlock = this.lastMemoryInjection.systemPromptBlock;
            logger.info(`[Agent] 记忆块已缓存（将由 PromptAssembler 以 user 角色注入）: ${this._cachedMemoryBlock.length} 字`);
        }
        logger.info('[Agent] Step 6/7: System message 已设置（via PromptRegistry）');
        // Step 7: 模型上线探测
        logger.info('[Agent] Step 7/7: 模型上线探测...');
        const modelT0 = Date.now();
        const onboardResult = await this.onboardModel();
        logger.info(`[Agent] 模型探测完成 (${Date.now() - modelT0}ms): ${onboardResult.replace(/\n/g, ' | ')}`);
        // 初始化完成汇总
        const recovery = this.projectManager.recoverySummary();
        const ckptRecovery = this.checkpointMgr.recoverySummary();
        const skillsMsg = '\nSKILL: ' + this.registry.size + ' loaded';
        let base = recovery ? onboardResult + skillsMsg + '\n\n' + recovery : onboardResult + skillsMsg;
        if (ckptRecovery !== 'No pending recovery tasks')
            base += '\n\n' + ckptRecovery;
        // 会话诊断 + 胡话检测：同步模型名 + 启动 10s 全程监控（必须在心跳之前）
        this.sessionDiag.setModelName(this.adapter.model);
        this.nonsenseDetector.setModelName(this.adapter.model);
        this.nonsenseDetector.startMonitor();
        // 注册诊断探活定时任务
        this.registerDiagnosticPingTask();
        // 注册模型列表心跳任务（定期检测 LM Studio 加载/卸载）
        this.registerModelListHeartbeat();
        // 注册 A 型主动性空闲任务（记忆整理 + 任务监控检查 + 会话摘要 GC）
        this.registerProactiveTasks();
        // Phase 5: 启动韧性心跳（必须在 nonsenseDetector 和诊断任务注册之后）
        this.orchestrator.startHeartbeat();
        
        // Phase 1-3 重构：实例化 Handler 模块（真正集成）
        this.chatHandler = createChatHandlerFromAgentCore(this);
        this.commandHandler = createCommandHandlerFromAgentCore(this);
        this.taskHandler = createTaskHandlerFromAgentCore(this);
        logger.info('[Agent] Handler 模块已集成: ChatHandler + CommandHandler + TaskHandler');
        
        const totalTime = Date.now() - initStart;
        logger.info(`[Agent] ====== 初始化完成 (${totalTime}ms) ======`);
        logger.info(`Agent core (Phase 5: router+skills+multi-agent+resilience+heartbeat)`);
        return base;
    }
    /** 构造 agent.identity 模板的动态变量字典 */
    getIdentityVars(): Record<string, string> {
        const activeProject = this.projectManager?.getActiveProject();
        return {
            cwd: process.cwd(),
            activeProject: activeProject ? activeProject.project : '(none)',
            modelName: this.adapter?.model || 'unknown',
        };
    }
    onboardModel = async () => {
        logger.info('[Agent] → 查询 LM Studio 当前加载模型...');
        // 列出所有已加载的模型
        let availableModels = [];
        try {
            availableModels = await this.adapter.listModels();
        } catch (err) {
            logger.warn('[Agent] → 获取模型列表失败', err);
        }
        if (availableModels.length > 0) {
            logger.info(`[Agent] → LM Studio 已加载 ${availableModels.length} 个模型:`);
            for (const m of availableModels) {
                const ctx = m.context_length ? `${m.context_length} ctx` : '? ctx';
                const arch = m.arch || '?';
                logger.info(`[Agent]   • ${m.id} (${arch}, ${ctx})`);
            }
        } else {
            logger.warn('[Agent] → LM Studio 无已加载模型或连接失败');
        }
        const modelName = await this.adapter.getCurrentModel();
        logger.info(`[Agent] → 当前使用模型: ${modelName} (context=${this.adapter.contextLength || '?'})`);
        // 存储可用模型列表供后续查询
        this._availableModels = availableModels;
        const profileStore = model_profile_1.getProfileStore();
        const profile = profileStore.get(modelName);
        if (profile && profile.capability && profile.stage === 'stable') {
            this.modelOnboarded = true;
            const msg = `MODEL: ${modelName} (stable, ${(profile.capability.overallScore * 100).toFixed(0)}%)`;
            logger.info(`[Agent] → ${msg}，跳过探测`);
            return msg;
        }
        logger.info(`[Agent] → 开始能力探测 (profile=${profile ? 'exist:' + profile.stage : 'none'})`);
        this.adapter.setProbeMode(true); // 探针模式：禁用重复检测
        // 探测前先同步 BreakIn 模型名为实际加载模型
        this.breakIn.setModelName(modelName);
        try {
            const t0 = Date.now();
            const capability = await this.breakIn.onboard(this.adapter.asChatFn());
            this.modelOnboarded = true;
            const elapsed = Date.now() - t0;
            const warnings = capability.warnings.length ? '\nWARN: ' + capability.warnings.join('; ') : '';
            const msg = `PROBED: ${modelName} (${elapsed}ms)\n  Score: ${(capability.overallScore * 100).toFixed(0)}%` + warnings;
            logger.info(`[Agent] → 探测完成: ${(capability.overallScore * 100).toFixed(0)}% (${elapsed}ms)`);
            return msg;
        }
        catch (err) {
            logger.error(`[Agent] → 探测失败: ${err}`);
            return 'PROBE FAILED: ' + modelName;
        }
        finally {
            // 无论成功/失败，确保退出探针模式
            this.adapter.setProbeMode(false);
        }
    };
    async sendMessage(userInput) {
        const t0 = Date.now();
        this.messages.push({ role: 'user', content: userInput });
        logger.info(`[Agent] ┌─ sendMessage() 输入(${userInput.length}字): ${userInput.slice(0, 100)}`);
        // 全链路追踪：开始
        this._tracer = getTracer(this.sessionId);
        const sendSpanId = this._tracer.start('sendMessage', 'Agent', { input: userInput.slice(0, 80) });
        this._tracer.start('pushMessage', 'Agent', { role: 'user', len: userInput.length });
        this._tracer.end('pushMessage');
        // 事件总线：开始 pipeline
        agentEventBus.startSession(3);

        // 快速通道：/ 开头的命令跳过 LLM 意图解析
        if (userInput.startsWith('/')) {
            logger.info('[Agent] │ └─ 路由: /命令 → handleCommand()');
            this._tracer.start('handleCommand', 'Agent', { cmd: userInput.slice(0, 60) });
            const reply = await this.handleCommand(userInput);
            this._tracer.end('handleCommand', { reply_len: reply.length });
            const dur = Date.now() - t0;
            this.messages.push({ role: 'assistant', content: reply });
            this._tracer.end(sendSpanId, { reply_len: reply.length, dur });
            finishTrace(this.sessionId);
            logger.info(`[Agent] └─ sendMessage() 完成 (${dur}ms) 回复${reply.length}字`);
            agentEventBus.endSession(true, '命令完成');
            return reply;
        }

        // 注意：/ 命令快速通道不走 recordInteraction / audit / breakIn 评估
        // 这是设计使然 — 简单查询不需要写入记忆系统。
        let intent;
        const intentT0 = Date.now();
        if (this.config.agent.skipIntentParsing) {
            // 跳过意图解析（减少一次 LLM 调用，直接路由到聊天）
            intent = { type: 'unknown', summary: userInput.slice(0, 50), entities: [], confidence: 0.5, needsClarification: false, missingInfo: [] };
            logger.debug(`[Agent] │ └─ 意图解析已跳过 (skipIntentParsing=true)`);
        } else {
            try {
                intent = await this.intentParser.parse(userInput);
                logger.info(`[Agent] │ ├─ 意图解析完成 (${Date.now() - intentT0}ms): type=${intent.type} confidence=${intent.confidence} entities=[${(intent.entities || []).map((e: any) => e.name || e).join(', ')}]`);
            }
            catch (err: unknown) {
                intent = { type: 'unknown', summary: userInput.slice(0, 50), entities: [], confidence: 0.3, needsClarification: false, missingInfo: [] };
                logger.warn(`[Agent] │ ├─ 意图解析失败: ${errorMessage(err)}，降级为 unknown`);
            }
        }

        // 事件总线：意图已确定
        agentEventBus.stepDone(1, 'intent_ready', '意图: ' + (intent.type || 'unknown'));
        if (intent.needsClarification && intent.missingInfo.length > 0) {
            const msg = 'Not enough info:\n' + intent.missingInfo.map((i: string) => '  - ' + i).join('\n');
            this.messages.push({ role: 'assistant', content: msg });
            this.recordInteraction(userInput, msg);
            logger.info(`[Agent] └─ sendMessage() 完成 (${Date.now() - t0}ms) [需要澄清]`);
            agentEventBus.endSession(true, '需要澄清');
            return msg;
        }

        let reply;
        const start = Date.now();
        const routeLabel = intent.type === 'command' ? 'handleCommand()' : intent.type === 'task' ? `handleTask() intent.confidence=${intent.confidence}` : 'handleChat()';
        logger.info(`[Agent] │ └─ 路由: ${routeLabel}`);
        switch (intent.type) {
            case 'command':
                // 防御: 只有以 / 开头的才走命令路径，LLM 误判回退到 chat
                if (!userInput.trim().startsWith('/')) {
                    logger.info(`[Agent] │ ├─ 意图判为 command 但输入不以 / 开头，回退到 handleChat()`);
                    reply = await this.handleChat(userInput);
                } else {
                    reply = await this.handleCommand(userInput);
                }
                break;
            case 'task':
                reply = await this.handleTask(intent, userInput);
                break;
            default:
                reply = await this.handleChat(userInput);
                break;
        }
        const duration = Date.now() - start;
        this.messages.push({ role: 'assistant', content: reply });
        logger.info(`[Agent] │ ├─ handler 完成 (${duration}ms) 回复${reply.length}字`);
        this.recordInteraction(userInput, reply);
        const isError = reply.startsWith('ERR') || reply.startsWith('WARN');
        this.breakIn.evaluateInteraction({
            taskType: intent.type, success: !isError, durationMs: duration, toolCalls: intent.type === 'task' ? 2 : 0, toolErrors: isError ? 1 : 0,
        });
        this.checkPendingApplies();
        // 审计: 记录交互
        this.auditLog.logDecision(intent.type, reply.slice(0, 200), isError ? 'failure' : 'success', { durationMs: duration, inputLength: userInput.length });
        // P0: 跨会话记忆 — 每次交互后记录决策和实体到数据库
        this.recordDecision(intent, userInput, reply, isError);
        this.recordEntities(userInput);
        // 事件总线：完成
        agentEventBus.endSession(!isError, isError ? '处理出错' : undefined);
        // Experience module: 异步提取经验（不阻塞响应）
        if (this.experienceInitialized && intent.type !== 'command') {
            const outcome = isError ? 'failure' : 'success';
            this.experienceExtractor.extract(userInput, reply, outcome, this.sessionId, {
                modelUsed: this.adapter.model,
            }).then(id => {
                if (id !== null) {
                    logger.debug(`[Agent] 经验已提取: #${id}`);
                }
            }).catch(err => {
                logger.debug('[Agent] 经验提取失败（非阻塞）', err);
            });
        }
        const totalDur = Date.now() - t0;
        this._tracer.end(sendSpanId, { intent_type: intent.type, reply_len: reply.length, dur: totalDur, isError });
        finishTrace(this.sessionId);
        logger.info(`[Agent] └─ sendMessage() 完成 (${totalDur}ms) [${intent.type}] ${isError ? '❌' : '✅'} 回复${reply.length}字`);
        return reply;
    }
    async handleChat(userInput) {
        // Phase 2 重构：委托给 ChatHandler（已集成）
        if (this.chatHandler) return this.chatHandler.handle(userInput);
        // 以下为原始内联实现（fallback，handler 未初始化时使用）
        const t0 = Date.now();
        const chatSpanId = this._tracer?.start('handleChat', 'Agent', { input: userInput.slice(0, 80) });
        logger.info(`[Agent] ┌─ handleChat() 输入(${userInput.length}字)`);
        this.nonsenseDetector.markConversationStart(userInput);
        let chatOutput = '';
        let chatError = null;
        try {
            // 熔断器预检：避免向已知故障模型发送请求
            if (!this.circuitBreaker.canUseModel(this.adapter.model)) {
                logger.warn(`[Agent] ⛔ 模型 ${this.adapter.model} 已熔断，尝试恢复...`);
                const cbResult = await this.recovery.executeProtected(async () => {
                    const alive = await this.adapter.ping();
                    if (!alive) throw new Error('model_unreachable (circuit breaker)');
                    this.circuitBreaker.modelSuccess(this.adapter.model);
                    return '模型已恢复';
                }, { taskId: 'cb-recovery-' + Date.now() });
                if (!cbResult.success) {
                    return '模型服务当前不可用（已熔断）。请稍后重试或输入 /status 查看系统状态。';
                }
            }

            const result = await this.recovery.executeProtected(async () => {
                const aliveT0 = Date.now();
                const alive = await this.adapter.ping();
                logger.debug(`[Agent] │ ├─ ping() ${alive ? '✅' : '❌'} (${Date.now() - aliveT0}ms)`);
                this.sessionDiag.recordPing(alive);
                if (!alive) {
                    this.healthMon.recordPing(false);
                    this.circuitBreaker.modelFailure(this.adapter.model, 'ping failed');
                    throw new Error('model_unreachable');
                }
                this.healthMon.recordPing(true);
                this.healthMon.watchTokenStream();
                // P7: 动态上下文窗口 — 从模型实际 context_length 算有效预算
                try {
                    const effectiveWindow = this.adapter.getEffectiveContextWindow();
                    this.ctxManager.updateConfig({ maxTokens: effectiveWindow });
                }
                catch { /* adapter 不支持时忽略 */ }

                // ══ 消息装配追踪：Stage 0 - 原始上下文（每次 handleChat 都重建，确保每条消息独立追踪） ══
                this._assemblyReport = createAssemblyReport(this.sessionId, userInput);
                addAssemblyStage(this._assemblyReport, 'raw_input', '原始用户输入', '用户输入+历史消息', this.messages);

                // P7: 上下文管理 — 压缩后发送
                const ctxResult = await this.ctxManager.process(this.messages, userInput, async (prompt) => {
                    // 事件总线：模型开始响应
                    agentEventBus.modelResponding(this.adapter.model);
                    // LLM Router 统一调用：自动广播 payload
                    const summarizeMsgs = [{ role: 'user' as const, content: prompt }];
                    const resp = await llm_router_1.getLLMRouter().call({
                        taskType: 'summarize',
                        messages: summarizeMsgs,
                    });
                    return resp.choices?.[0]?.message?.content || '';
                });
                if (ctxResult.compressed) {
                    logger.info(`[Agent] 上下文压缩: ${ctxResult.originalTokens} → ${ctxResult.finalTokens} tokens` +
                        `, ${ctxResult.hotCount} 条热点, 层级 ${ctxResult.compressionLevel}` +
                        (ctxResult.sessionReset ? ', ⚠️ 会话边界 — 开启新会话' : ''));
                    this.auditLog.logDegradation(ctxResult.compressionLevel, `context compressed: ${ctxResult.originalTokens}→${ctxResult.finalTokens}` +
                        (ctxResult.sessionReset ? ' [new session]' : ''), 'compressed', 'attention');
                    // 会话边界：通知适配器下次请求开启新会话
                    if (ctxResult.sessionReset) {
                        try {
                            this.adapter.markSessionReset();
                        }
                        catch {
                            // stateless API 忽略
                        }
                    }
                }
                try {
                    // 事件总线：模型开始响应
                    agentEventBus.modelResponding(this.adapter.model);

                    // ══ 消息装配追踪：Stage 2 - 压缩后上下文 ══
                    if (this._assemblyReport) {
                        addAssemblyStage(this._assemblyReport, 'context_compressed', '上下文压缩后', ctxResult.compressed ? 'ContextManager 已压缩上下文' : '上下文未压缩', ctxResult.messages);
                    }

                    // Phase 3: 使用 PromptAssembler 组装最终 messages
                    // ContextManager 已处理压缩，ctxResult.messages 包含处理后的上下文
                    // Experience module: 检索相关经验（条件性注入）
                    let experienceBlock: string | undefined;
                    if (this.experienceInitialized) {
                        try {
                            const expResults = this.experienceRetriever.retrieve(userInput, { topK: 3 });
                            if (expResults.length > 0) {
                                experienceBlock = this.experienceRetriever.formatBlock(expResults);
                            }
                        }
                        catch (err) {
                            logger.debug('[Agent] 经验检索失败（非阻塞）', err);
                        }
                    }

                    // ══ 消息装配追踪：Stage 3 - 记忆+经验注入前 ══
                    if (this._assemblyReport && (this._cachedMemoryBlock || experienceBlock)) {
                        const preInjectMsgs = [...ctxResult.messages];
                        if (this._cachedMemoryBlock) {
                            preInjectMsgs.push({ role: 'user', content: `[MEMORY BLOCK即将注入: ${this._cachedMemoryBlock.length}字]` });
                        }
                        if (experienceBlock) {
                            preInjectMsgs.push({ role: 'user', content: `[EXPERIENCE BLOCK即将注入: ${experienceBlock.length}字]` });
                        }
                        addAssemblyStage(this._assemblyReport, 'injection_prepare', '记忆/经验准备', `memory=${this._cachedMemoryBlock?.length ?? 0}字, experience=${experienceBlock?.length ?? 0}字`, preInjectMsgs);
                    }

                    const assembled = this.promptAssembler.assemble({
                        identityTemplateId: 'agent.identity',
                        identityVars: this.getIdentityVars(),
                        memoryBlock: this._cachedMemoryBlock || undefined,
                        experienceBlock: experienceBlock,
                        context: ctxResult.messages,
                        userInput: undefined, // userInput 已在 ctxResult.messages 末尾
                    });
                    logger.debug(
                        `[Agent] PromptAssembler: ${assembled.metadata.totalMessages} 条消息` +
                        ` hasMemory=${assembled.metadata.hasMemory}` +
                        ` hasExperience=${assembled.metadata.hasExperience}` +
                        ` hasSummary=${assembled.metadata.hasSummary}`,
                    );

                    // ══ 消息装配追踪：Stage 4 - 完整组装后 ══
                    if (this._assemblyReport) {
                        addAssemblyStage(this._assemblyReport, 'assembled', 'PromptAssembler 组装后', `memory=${assembled.metadata.hasMemory}, experience=${assembled.metadata.hasExperience}, summary=${assembled.metadata.hasSummary}`, assembled.messages);
                    }

                    // LLM Router 统一调用：自动广播 payload（附加组装元数据）
                    const llmT0 = Date.now();
                    const response = await llm_router_1.getLLMRouter().call({
                        taskType: 'chat',
                        messages: assembled.messages,
                        metadata: { assembler: assembled.metadata },
                    });
                    const llmDur = Date.now() - llmT0;
                    const content = response.choices?.[0]?.message?.content;
                    const llmPayload = {
                        taskType: 'chat',
                        messageCount: assembled.messages.length,
                        role: (assembled.messages[assembled.messages.length - 1]?.role || '?'),
                        contentLen: content?.length || 0,
                        model: this.adapter.model,
                    };
                    logger.info(`[Agent] │ ├─ LLM chat() 响应 ${content ? content.length : 0}字 (${llmDur}ms)`);

                    // ══ 消息装配追踪：Stage 5 - 最终发送给模型的 payload ══
                    if (this._assemblyReport) {
                        addAssemblyStage(this._assemblyReport, 'llm_payload', 'LLM发送载荷', `模型: ${this.adapter.model}, 温度参数: 默认`, assembled.messages);
                        logger.info(`[Agent] │ └─ 消息装配流水线:\n${formatAssemblyReport(this._assemblyReport)}`);
                    }

                    return content ?? '(empty)';
                }
                finally {
                    this.healthMon.endTokenStream();
                }
            }, { taskId: 'chat-' + Date.now(), context: { model: this.adapter.model } });
            // 熔断器反馈：记录成功
            this.circuitBreaker.modelSuccess(this.adapter.model);
            chatOutput = this.formatRecoveryResult(result);
        }
        catch (err) {
            logger.error('[Agent] handleChat() 执行失败', err);
            this.circuitBreaker.modelFailure(this.adapter.model, err.message || 'unknown');
            this.healthMon.recordPing(false);
            chatOutput = `ERR: ${err.message || 'unknown error'}`;
            chatError = err.message || 'unknown error';
        }
        // 胡话检测
        const reason = nonsense_detector_1.NonsenseDetector.detectGibberish(chatOutput);
        const normal = !reason && !chatError;
        this.nonsenseDetector.markConversationEnd(normal, userInput, chatOutput, reason || chatError || undefined);
        if (!normal) {
            logger.warn(`[Nonsense] handleChat 检测到异常: ${reason || chatError}`);
        }
        if (this._tracer && chatSpanId) {
            if (chatError) this._tracer.error(chatSpanId, chatError);
            else this._tracer.end(chatSpanId, { reply_len: chatOutput.length, dur: Date.now() - t0 });
        }
        logger.info(`[Agent] └─ handleChat() 完成 (${Date.now() - t0}ms) 回复${chatOutput.length}字${chatError ? ' ❌' : ''}`);
        return chatOutput;
    }
    /**
     * 流式发送消息 — 与 sendMessage() 相同的 pipeline，但聊天路径使用流式输出
     * 逐 chunk 通过 agentEventBus.emitChatChunk() 广播
     * 返回完整回复字符串
     */
    async sendMessageStream(userInput) {
        const t0 = Date.now();
        this.messages.push({ role: 'user', content: userInput });
        logger.info(`[Agent] ┌─ sendMessageStream() 输入(${userInput.length}字): ${userInput.slice(0, 100)}`);
        // 事件总线：开始 pipeline
        agentEventBus.startSession(3);
        // 快速通道：/ 开头的命令跳过 LLM 意图解析（非流式）
        if (userInput.startsWith('/')) {
            logger.info('[Agent] │ └─ 路由: /命令 → handleCommand()');
            const reply = await this.handleCommand(userInput);
            this.messages.push({ role: 'assistant', content: reply });
            logger.info(`[Agent] └─ sendMessageStream() 完成 (${Date.now() - t0}ms) 回复${reply.length}字`);
            agentEventBus.endSession(true, '命令完成');
            return reply;
        }
        let intent;
        const intentT0 = Date.now();
        if (this.config.agent.skipIntentParsing) {
            // 跳过意图解析（减少一次 LLM 调用，直接路由到聊天）
            intent = { type: 'unknown', summary: userInput.slice(0, 50), entities: [], confidence: 0.5, needsClarification: false, missingInfo: [] };
            logger.debug(`[Agent] │ └─ 意图解析已跳过 (skipIntentParsing=true)`);
        } else {
            try {
                intent = await this.intentParser.parse(userInput);
                logger.info(`[Agent] │ ├─ 意图解析完成 (${Date.now() - intentT0}ms): type=${intent.type} confidence=${intent.confidence}`);
            } catch (err: unknown) {
                intent = { type: 'unknown', summary: userInput.slice(0, 50), entities: [], confidence: 0.3, needsClarification: false, missingInfo: [] };
                logger.warn(`[Agent] │ ├─ 意图解析失败: ${errorMessage(err)}，降级为 unknown`);
            }
        }
        agentEventBus.stepDone(1, 'intent_ready', '意图: ' + (intent.type || 'unknown'));
        if (intent.needsClarification && intent.missingInfo.length > 0) {
            const msg = 'Not enough info:\n' + intent.missingInfo.map((i) => '  - ' + i).join('\n');
            this.messages.push({ role: 'assistant', content: msg });
            this.recordInteraction(userInput, msg);
            agentEventBus.endSession(true, '需要澄清');
            return msg;
        }
        let reply;
        const t0Stream = Date.now();
        const routeLabel = intent.type === 'command' ? 'handleCommand()' : intent.type === 'task' ? `handleTask() intent.confidence=${intent.confidence}` : 'handleChatStream()';
        logger.info(`[Agent] │ └─ 路由: ${routeLabel}`);
        switch (intent.type) {
            case 'command':
                // 防御: 只有以 / 开头的才走命令路径，LLM 误判回退到 chat
                if (!userInput.trim().startsWith('/')) {
                    logger.info(`[Agent] │ ├─ 意图判为 command 但输入不以 / 开头，回退到 handleChatStream()`);
                    reply = await this.handleChatStream(userInput);
                } else {
                    reply = await this.handleCommand(userInput);
                }
                break;
            case 'task':
                reply = await this.handleTask(intent, userInput);
                break;
            default:
                reply = await this.handleChatStream(userInput);
                break;
        }
        const duration = Date.now() - t0;
        this.messages.push({ role: 'assistant', content: reply });
        this.recordInteraction(userInput, reply);
        const isError = reply.startsWith('ERR') || reply.startsWith('WARN');
        this.breakIn.evaluateInteraction({
            taskType: intent.type, success: !isError, durationMs: duration, toolCalls: intent.type === 'task' ? 2 : 0, toolErrors: isError ? 1 : 0,
        });
        this.checkPendingApplies();
        this.auditLog.logDecision(intent.type, reply.slice(0, 200), isError ? 'failure' : 'success', { durationMs: duration, inputLength: userInput.length });
        // P0: 跨会话记忆 — 每次交互后记录决策和实体到数据库
        this.recordDecision(intent, userInput, reply, isError);
        this.recordEntities(userInput);
        agentEventBus.endSession(!isError, isError ? '处理出错' : undefined);
        // Experience module: 异步提取经验
        if (this.experienceInitialized && intent.type !== 'command') {
            const outcome = isError ? 'failure' : 'success';
            this.experienceExtractor.extract(userInput, reply, outcome, this.sessionId, {
                modelUsed: this.adapter.model,
            }).then(id => {
                if (id !== null)
                    logger.debug(`[Agent] 经验已提取: #${id}`);
            }).catch(err => {
                logger.debug('[Agent] 经验提取失败（非阻塞）', err);
            });
        }
        const totalDur = Date.now() - t0;
        const streamIsError = reply.startsWith('ERR') || reply.startsWith('WARN');
        logger.info(`[Agent] └─ sendMessageStream() 完成 (${totalDur}ms) [${intent.type}] ${streamIsError ? '❌' : '✅'} 回复${reply.length}字`);
        return reply;
    }
    /**
     * 流式聊天处理 — 与 handleChat() 相同逻辑，但使用 llmRouter.callStream()
     * 逐 chunk 通过 agentEventBus.emitChatChunk() 广播
     */
    async handleChatStream(userInput) {
        // Phase 2 重构：委托给 ChatHandler（已集成）
        if (this.chatHandler) return this.chatHandler.handleStream(userInput);
        // 以下为原始内联实现（fallback）
        const t0 = Date.now();
        logger.info(`[Agent] ┌─ handleChatStream() 输入(${userInput.length}字)`);
        this.nonsenseDetector.markConversationStart(userInput);
        let chatOutput = '';
        let chatError = null;
        const streamStartTime = Date.now();
        try {
            // 熔断器预检
            if (!this.circuitBreaker.canUseModel(this.adapter.model)) {
                logger.warn(`[Agent][stream] ⛔ 模型 ${this.adapter.model} 已熔断`);
                const cbResult = await this.recovery.executeProtected(async () => {
                    const alive = await this.adapter.ping();
                    if (!alive) throw new Error('model_unreachable (circuit breaker)');
                    this.circuitBreaker.modelSuccess(this.adapter.model);
                    return 'ok';
                }, { taskId: 'cb-stream-recovery-' + Date.now() });
                if (!cbResult.success) {
                    return '模型服务当前不可用（已熔断）。请稍后重试。';
                }
            }

            chatOutput = await this.recovery.executeProtected(async () => {
                const aliveT0 = Date.now();
                const alive = await this.adapter.ping();
                logger.debug(`[Agent] │ ├─ ping() ${alive ? '✅' : '❌'} (${Date.now() - aliveT0}ms)`);
                this.sessionDiag.recordPing(alive);
                if (!alive) {
                    this.healthMon.recordPing(false);
                    this.circuitBreaker.modelFailure(this.adapter.model, 'ping failed');
                    throw new Error('model_unreachable');
                }
                this.healthMon.recordPing(true);
                this.healthMon.watchTokenStream();
                try {
                    const effectiveWindow = this.adapter.getEffectiveContextWindow();
                    this.ctxManager.updateConfig({ maxTokens: effectiveWindow });
                }
                catch { }
                const ctxResult = await this.ctxManager.process(this.messages, userInput, async (prompt) => {
                    agentEventBus.modelResponding(this.adapter.model);
                    const summarizeMsgs = [{ role: 'user', content: prompt }];
                    const resp = await llm_router_1.getLLMRouter().call({
                        taskType: 'summarize',
                        messages: summarizeMsgs,
                    });
                    return resp.choices?.[0]?.message?.content || '';
                });
                if (ctxResult.compressed) {
                    logger.info(`[Agent] 上下文压缩: ${ctxResult.originalTokens} → ${ctxResult.finalTokens} tokens`);
                    if (ctxResult.sessionReset) {
                        try {
                            this.adapter.markSessionReset();
                        }
                        catch { }
                    }
                }
                try {
                    agentEventBus.modelResponding(this.adapter.model);
                    // Phase 3: 使用 PromptAssembler 组装最终 messages
                    let experienceBlock;
                    if (this.experienceInitialized) {
                        try {
                            const expResults = this.experienceRetriever.retrieve(userInput, { topK: 3 });
                            if (expResults.length > 0) {
                                experienceBlock = this.experienceRetriever.formatBlock(expResults);
                            }
                        }
                        catch (err) {
                            logger.debug('[Agent] 经验检索失败（非阻塞）', err);
                        }
                    }
                    const assembled = this.promptAssembler.assemble({
                        identityTemplateId: 'agent.identity',
                        identityVars: this.getIdentityVars(),
                        memoryBlock: this._cachedMemoryBlock || undefined,
                        experienceBlock: experienceBlock,
                        context: ctxResult.messages,
                        userInput: undefined,
                    });
                    logger.debug(`[Agent][stream] PromptAssembler: ${assembled.metadata.totalMessages} 条消息`);
                    // 流式调用 LLM Router
                    let fullReply = '';
                    try {
                        for await (const chunk of llm_router_1.getLLMRouter().callStream({
                            taskType: 'chat',
                            messages: assembled.messages,
                            metadata: { assembler: assembled.metadata },
                        })) {
                            fullReply += chunk;
                            this.healthMon.beat();
                            agentEventBus.emitChatChunk(chunk);
                        }
                    }
                    catch (streamErr) {
                        // 流式中断：如果有部分内容，保留并标记 done（前端才能正常切换状态）
                        if (fullReply.length > 0) {
                            logger.warn(`[Agent][stream] 流式中断，保留已有内容 (${fullReply.length}字): ${streamErr}`);
                            const partialDuration = Date.now() - streamStartTime;
                            agentEventBus.emitChatDone(fullReply, partialDuration);  // 通知前端完成
                            return fullReply;
                        } else {
                            // 无内容：尝试网络错重试 → 非流式回退
                            const isNetwork = /ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(streamErr.message || '');
                            if (isNetwork) {
                                logger.warn(`[Agent][stream] 网络错误，3s 后尝试非流式回退`);
                                await new Promise(r => setTimeout(r, 3000));
                            }
                            try {
                                const fallbackResp = await llm_router_1.getLLMRouter().call({
                                    taskType: 'chat',
                                    messages: assembled.messages,
                                });
                                fullReply = fallbackResp.choices?.[0]?.message?.content || '';
                                if (fullReply) {
                                    logger.info(`[Agent][stream] 非流式回退成功 (${fullReply.length}字)`);
                                } else {
                                    throw streamErr;
                                }
                            } catch (fallbackErr) {
                                throw streamErr;
                            }
                        }
                    }
                    const duration = Date.now() - streamStartTime;
                    agentEventBus.emitChatDone(fullReply, duration);
                    return fullReply || '(empty)';
                }
                finally {
                    this.healthMon.endTokenStream();
                }
            }, { taskId: 'chat-stream-' + Date.now(), context: { model: this.adapter.model } });
            // 熔断器反馈：流式成功
            this.circuitBreaker.modelSuccess(this.adapter.model);
            chatOutput = this.formatRecoveryResult(chatOutput);
        }
        catch (err) {
            logger.error('[Agent] handleChatStream() 执行失败', err);
            this.circuitBreaker.modelFailure(this.adapter.model, err.message || 'unknown');
            this.healthMon.recordPing(false);
            chatOutput = `ERR: ${err.message || 'unknown error'}`;
            chatError = err.message || 'unknown error';
            agentEventBus.emitChatError(chatError);
        }
        const reason = nonsense_detector_1.NonsenseDetector.detectGibberish(chatOutput);
        const normal = !reason && !chatError;
        this.nonsenseDetector.markConversationEnd(normal, userInput, chatOutput, reason || chatError || undefined);
        if (!normal) {
            logger.warn(`[Nonsense] handleChatStream 检测到异常: ${reason || chatError}`);
        }
        logger.info(`[Agent] └─ handleChatStream() 完成 (${Date.now() - t0}ms) 回复${chatOutput.length}字${chatError ? ' ❌' : ''}`);
        return chatOutput;
    }
    async handleTask(intent, rawMessage) {
        // Phase 3 重构：委托给 TaskHandler（已集成）
        if (this.taskHandler) return this.taskHandler.handle(intent, rawMessage);
        // 以下为原始内联实现（fallback）
        const t0 = Date.now();
        const taskSpanId = this._tracer?.start('handleTask', 'Agent', { intent_type: intent.type, confidence: intent.confidence, summary: intent.summary?.slice(0, 60) });
        logger.info(`[Agent] ┌─ handleTask() intent.confidence=${intent.confidence} summary=${intent.summary}`);
        this.nonsenseDetector.markConversationStart(rawMessage);
        let taskOutput = '';
        let taskError = null;
        try {
            const aliveT0 = Date.now();
            const alive = await this.adapter.ping();
            logger.debug(`[Agent] │ ├─ ping() ${alive ? '✅' : '❌'} (${Date.now() - aliveT0}ms)`);
            this.sessionDiag.recordPing(alive);
            if (!alive) {
                this.healthMon.recordPing(false);
                this.circuitBreaker.modelFailure(this.adapter.model, 'ping failed (handleTask)');
                this.sessionDiag.recordCircuitBreaker(this.adapter.model, 'LM Studio 不可达 (handleTask)');
                taskOutput = 'WARN: LM Studio not connected.';
                taskError = 'model_unreachable';
                this.nonsenseDetector.markConversationEnd(false, rawMessage, taskOutput, taskError);
                return taskOutput;
            }
            this.circuitBreaker.modelSuccess(this.adapter.model);
            if (this.isMultiAgentTask(rawMessage)) {
                logger.info('[Agent] │ └─ 检测为多Agent任务 → handleMultiAgentTask()');
                taskOutput = await this.handleMultiAgentTask(intent, rawMessage);
                this.nonsenseDetector.markConversationEnd(true, rawMessage, taskOutput);
                return taskOutput;
            }
            const active = this.projectManager.getActiveProject();
            const summary = intent.summary || rawMessage.slice(0, 50);
            if (!active) {
                const name = this.sanitizeProjectName(summary || 'new-project');
                this.projectManager.createProject(name, { description: rawMessage.slice(0, 200), priority: 'P1' });
                this.projectManager.addTodo(name, { title: summary, status: 'in_progress', priority: 'P1' });
            }
            else {
                this.projectManager.addTodo(active.project, { title: summary, status: 'in_progress', priority: intent.confidence > 0.8 ? 'P0' : 'P1' });
            }
            // Phase 5: 韧性保护执行 + 步骤级检查点
            const taskId = 'task-' + Date.now();
            // 事件总线：执行工具中
            agentEventBus.toolsExecuting(['orchestrator']);
            // 注入 LLM 调用函数供重规划使用
            this.orchestrator.setLLMCall(async (messages) => {
                const result = await this.llmRouter.call({
                    taskType: 'task_decompose',
                    messages: messages as any,
                    params: { temperature: 0.3, maxTokens: 1024 },
                });
                return result.content;
            });
            const result = await this.recovery.executeProtected(async () => {
                this.healthMon.watchTokenStream();
                try {
                    const orchT0 = Date.now();
                    const output = await this.orchestrator.execute(intent, rawMessage, taskId);
                    logger.info(`[Agent] │ ├─ orchestrator.execute() 完成 (${Date.now() - orchT0}ms)`);
                    const proj = this.projectManager.getActiveProject();
                    if (proj)
                        this.projectManager.recalculateProgress(proj.project);
                    return output;
                }
                finally {
                    this.healthMon.endTokenStream();
                }
            }, { taskId, context: { model: this.adapter.model } });
            taskOutput = this.formatRecoveryResult(result);
        }
        catch (err) {
            taskOutput = `ERR: ${err.message || 'unknown error'}`;
            taskError = err.message || 'unknown error';
        }
        // 胡话检测
        const reason = nonsense_detector_1.NonsenseDetector.detectGibberish(taskOutput);
        const normal = !reason && !taskError;
        this.nonsenseDetector.markConversationEnd(normal, rawMessage, taskOutput, reason || taskError || undefined);
        if (!normal) {
            logger.warn(`[Nonsense] handleTask 检测到异常: ${reason || taskError}`);
        }
        if (this._tracer && taskSpanId) {
            if (taskError) this._tracer.error(taskSpanId, taskError);
            else this._tracer.end(taskSpanId, { reply_len: taskOutput.length, dur: Date.now() - t0 });
        }
        logger.info(`[Agent] └─ handleTask() 完成 (${Date.now() - t0}ms) 回复${taskOutput.length}字${taskError ? ' ❌' : ''}`);
        return taskOutput;
    }
    isMultiAgentTask(input) {
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
    async handleMultiAgentTask(intent, rawMessage) {
        logger.info('[Agent] multi-agent: ' + rawMessage.slice(0, 60));
        const agents = new Map();
        agents.set('frontend', new sub_agent_1.SubAgent({ name: 'Frontend', systemPrompt: 'Frontend engineer. HTML/CSS/JS/React. Reply with code.' }));
        agents.set('backend', new sub_agent_1.SubAgent({ name: 'Backend', systemPrompt: 'Backend engineer. API/DB/server. Reply with code.' }));
        agents.set('reviewer', new sub_agent_1.SubAgent({ name: 'Reviewer', systemPrompt: 'Code reviewer. Check quality and security.' }));
        const tasks = [
            { id: 'fe', description: 'Frontend: ' + rawMessage, agentName: 'frontend', priority: 1 },
            { id: 'be', description: 'Backend: ' + rawMessage, agentName: 'backend', priority: 1 },
            { id: 'review', description: 'Review both, suggest improvements', agentName: 'reviewer', priority: 2, dependsOn: ['fe', 'be'] },
        ];
        const result = await this.scheduler.parallel(tasks, agents);
        return 'multi-agent done (' + result.mode + ', ' + result.totalDurationMs + 'ms)\n' + result.merged.summary;
    }
    async handleCommand(input) {
        // Phase 1 重构：委托给 CommandHandler（已集成）
        if (this.commandHandler) return this.commandHandler.handle(input);
        // 以下为原始内联实现（fallback）
        const t0 = Date.now();
        const cmd = input.slice(1).toLowerCase().trim();
        const args = cmd.split(/\s+/);
        const action = args[0];
        logger.info(`[Agent] ┌─ handleCommand() action=${action} args=${JSON.stringify(args.slice(1))}`);
        switch (action) {
            case 'exit':
            case 'quit':
                this.stop();
                return 'Goodbye!';
            case 'history':
                if (this.messages.length <= 1)
                    return 'No history';
                return 'History:\n' + this.messages.filter(m => m.role !== 'system').map(m => '[' + m.role + '] ' + m.content.slice(0, 100)).join('\n');
            case 'status': return this.buildStatus();
            case 'project': return this.handleProjectCommand(args.slice(1));
            case 'models': return this.handleModelsCommand(args.slice(1));
            case 'router': return this.router.status();
            case 'skills': return this.handleSkillsCommand(args.slice(1));
            case 'agents': return await this.handleAgentsCommand(args.slice(1));
            case 'resilience': return this.recovery.status();
            case 'audit': return this.handleAuditCommand(args.slice(1));
            case 'summarize': return await this.handleSummarizeCommand(args.slice(1));
            case 'memory': return this.handleMemoryCommand(args.slice(1));
            case 'context': return this.handleContextCommand(args.slice(1));
            case 'idle': return this.handleIdleCommand(args.slice(1));
            case 'diag': return this.handleDiagCommand(args.slice(1));
            case 'nonsense':
                const sub = args.slice(1).join(' ');
                if (!sub) {
                    const last = this.nonsenseDetector.getLastConversation();
                    const active = this.nonsenseDetector.isConversationActive();
                    const elapsed = this.nonsenseDetector.getConversationElapsedMs();
                    const elapsedStr = elapsed > 0 ? ` (${(elapsed / 1000).toFixed(0)}s)` : '';
                    const lines = [
                        active ? `📞 通话中${elapsedStr}` : '💤 空闲',
                    ];
                    if (last) {
                        lines.push(`上次会话: ${last.endedNormally ? '✅ 正常' : '⚠️ 异常 (' + (last.reason || '?') + ')'}`);
                        lines.push(`输入: ${last.input.slice(0, 80)}`);
                        lines.push(`输出: ${last.output.slice(0, 80)}`);
                    }
                    else {
                        lines.push('暂无会话记录');
                    }
                    return lines.join('\n');
                }
                if (sub === 'force') {
                    const input = '(手动强制触发) ' + args.slice(2).join(' ') || '手动诊断';
                    this.nonsenseDetector.markConversationEnd(false, input, '(空)');
                    this.nonsenseDetector.forceCheck();
                    return '✅ 已强制触发胡话检测检查';
                }
                return '用法: /nonsense 或 /nonsense force [原因]';
            case 'config':
                const cfgSub = args.slice(1).join(' ');
                if (!cfgSub || cfgSub === 'show')
                    return agent_system_config_1.formatConfig();
                if (cfgSub === 'reload') {
                    const result = agent_system_config_1.reloadConfig();
                    if (result.success) {
                        this.nonsenseDetector.restartMonitor();
                        return '✅ 配置已热重载';
                    }
                    return `❌ 热重载失败: ${result.errors}`;
                }
                if (cfgSub === 'path')
                    return `📁 ${agent_system_config_1.getConfigFilePath()}`;
                return '用法: /config [show|reload|path]';
            case 'exp':
            case 'experience':
                if (!this.experienceInitialized) {
                    return '⚠️ 经验模块未初始化';
                }
                return await this.experienceCommandHandler.handle(args.slice(1));
            case 'resume':
                return await this.handleResumeCommand(args.slice(1));
            case 'ckpt':
            case 'checkpoint':
                return this.handleCkptCommand(args.slice(1));
            case 'pause':
                return this.handlePauseCommand(args.slice(1));
            case 'help':
                logger.info(`[Agent] └─ handleCommand() 完成 (${Date.now() - t0}ms) [help]`);
                return 'Commands:\n  /exit /history /status /project\n  /models [list|scan|switch|detail] — 模型探测与切换\n  /router /skills /agents\n  /resilience /audit /summarize\n  /memory /context /idle /diag /nonsense /config\n  /exp [add|list|view|search|edit|delete|stats|help]\n  /resume [index|taskId] — 恢复长任务\n  /ckpt [list|show|clear] — 检查点管理\n  /pause — 暂停当前任务\n  /help';
            default:
                logger.info(`[Agent] └─ handleCommand() 完成 (${Date.now() - t0}ms) [unknown: ${action}]`);
                return 'Unknown: ' + action;
        }
    }
    // ====== 长任务恢复命令 ======

    /** /resume — 恢复未完成的长任务 */
    async handleResumeCommand(args) {
        return resumeCommand.handleResumeCommand(this, args);
    }

    /** /ckpt — 检查点管理 */
    handleCkptCommand(args) {
        return checkpointCommands.handleCkptCommand(this, args);
    }

    /** /pause — 暂停当前任务 */
    handlePauseCommand(args) {
        return checkpointCommands.handlePauseCommand(this, args);
    }

    // ====== Phase 3: 技能命令 ======
    handleSkillsCommand(args) {
        return infoCommands.handleSkillsCommand(this, args);
    }
    // ====== Phase 4: 多Agent命令 ======
    async handleAgentsCommand(args: string[]): Promise<string> {
        return agentsCommand.handleAgentsCommand(this, args);
    }
    // ====== Phase 5 P1: 审计命令 ======
    handleAuditCommand(args) {
        return infoCommands.handleAuditCommand(this, args);
    }
    // ====== P2: 记忆摘要命令 ======
    async handleSummarizeCommand(args) {
        return summarizeCommand.handleSummarizeCommand(this, args);
    }
    // ====== Phase 5 P1: 跨会话记忆命令 ======
    handleMemoryCommand(args) {
        return infoCommands.handleMemoryCommand(this, args);
    }
    // ====== P7: 上下文管理命令 ======
    handleContextCommand(args) {
        return infoCommands.handleContextCommand(this, args);
    }
    handleIdleCommand(args) {
        return infoCommands.handleIdleCommand(this, args);
    }
    handleDiagCommand(args) {
        return infoCommands.handleDiagCommand(this, args);
    }
    handleModelsCommand(args) {
        return infoCommands.handleModelsCommand(this, args);
    }
    /** 扫描 LM Studio 已加载的模型 */
    async scanModels() {
        return modelCommands.scanModels(this);
    }
    /** 热切换模型 */
    switchModel(targetModel) {
        return modelCommands.switchModel(this, targetModel);
    }
    // ====== Project commands ======
    handleProjectCommand(args) {
        return infoCommands.handleProjectCommand(this, args);
    }
    // ====== 自动技能管线 ======
    checkPendingApplies() {
        if (this.pendingApplies.length === 0)
            return;
        for (const apply of this.pendingApplies) {
            if (apply.status !== 'pending')
                continue;
            const result = this.auditor.audit(apply);
            if (result.approved) {
                apply.status = 'approved';
                logger.info('[Skill] approved: ' + apply.name);
            }
            else if (!result.needsHumanReview) {
                apply.status = 'rejected';
                apply.rejectReason = result.reason;
            }
        }
    }
    processPending() {
        const lines = [];
        const approved = this.pendingApplies.filter(a => a.status === 'approved');
        if (approved.length === 0 && !this.pendingApplies.some(a => a.status === 'pending'))
            return null;
        for (const apply of approved) {
            apply.status = 'developing';
            this.developer.develop(apply).then(result => {
                if (result.success && result.skillMeta) {
                    const testResult = this.tester.test(result.skillMeta);
                    if (testResult.passed) {
                        this.equipper.equip(result.skillMeta);
                        apply.status = 'complete';
                        apply.resolvedAt = new Date().toISOString();
                        lines.push('OK ' + apply.name + ': dev->test->equip');
                    }
                    else {
                        lines.push('FAIL ' + apply.name + ': test - ' + testResult.summary);
                    }
                }
                else {
                    lines.push('FAIL ' + apply.name + ': dev');
                }
            });
        }
        return lines.length > 0 ? 'Pipeline:\n' + lines.join('\n') : null;
    }

    // ─── Public Stats API（供 Dashboard 使用） ─────────────────
    /** 返回 DB 统计（decisions/entities/sessions/summaries 条数） */
    getDbStats() {
        try {
            const db = db_store_1.getDBStore();
            return db.getStatsObject();
        } catch { return null; }
    }

    /** 返回工具注册表信息 */
    getToolRegistryInfo() {
        try {
            return {
                total: toolRegistry.size,
                enabled: toolRegistry.getEnabledTools().length,
                tools: toolRegistry.getEnabledTools().map(t => ({
                    name: t.name,
                    description: t.description || '',
                    dangerLevel: t.dangerLevel || 'safe',
                })),
            };
        } catch { return null; }
    }

    // ─── P0: 跨会话记忆 — 决策记录 ──────────────────────────────
    /** 每次交互后将决策写入 DB（用于跨会话恢复） */
    private recordDecision(intent: any, userInput: string, reply: string, isError: boolean) {
        if (!this.dbInitialized) return;
        try {
            const decision = {
                timestamp: new Date().toISOString(),
                category: intent?.type ?? 'unknown',
                summary: reply.slice(0, 200) || intent?.summary?.slice(0, 200) || userInput.slice(0, 200),
                detail: `input=${userInput.slice(0, 100)} output=${reply.slice(0, 100)} success=${!isError}`,
                project: this.projectManager?.getActiveProject()?.project ?? '',
                session_id: this.sessionId,
            };
            const db = db_store_1.getDBStore();
            const id = db.addDecision(decision);
            logger.debug(`[Memory] 决策已记录: #${id} [${decision.category}]`);
        } catch (err) {
            logger.debug('[Memory] 决策记录失败（非阻塞）', err);
        }
    }

    // ─── P0: 跨会话记忆 — 实体提取与记录 ───────────────────────
    /** 从用户输入中提取命名实体并写入 DB */
    private recordEntities(userInput: string) {
        if (!this.dbInitialized) return;
        try {
            const entities = this.extractEntities(userInput);
            if (entities.length === 0) return;
            const db = db_store_1.getDBStore();
            const now = new Date().toISOString();
            for (const e of entities) {
                db.upsertEntity({
                    name: e.name,
                    type: e.type,
                    first_seen: now,
                    last_seen: now,
                    notes: '',
                });
            }
            logger.debug(`[Memory] 实体已记录: ${entities.map(e => e.name).join(', ')}`);
        } catch (err) {
            logger.debug('[Memory] 实体记录失败（非阻塞）', err);
        }
    }

    /** 从文本中提取命名实体（简单正则，无 LLM 依赖） */
    private extractEntities(text: string): Array<{ name: string; type: string }> {
        return extractEntitiesFn(text);
    }

    // ====== Phase 5: 恢复结果格式化 ======
    formatRecoveryResult(result) {
        if (result.success) {
            let output = result.output ?? '';
            if (result.recovered) {
                const summary = result.recoveryLog.length > 0 ? result.recoveryLog[result.recoveryLog.length - 1] : 'recovered';
                output = '[RECOVERED: ' + summary + ']\n\n' + output;
            }
            if (result.degraded) {
                output = '[DEGRADED L' + (result.degradationLevel ?? '?') + ']\n\n' + output;
            }
            return output;
        }
        if (result.degraded) {
            return result.output ?? 'Task degraded but failed. Check /resilience.';
        }
        return 'ERR: ' + (result.error ?? 'unknown');
    }
    // ====== Phase 5: A 型心跳处理 ======
    onHeartbeat() {
        const t0 = Date.now();
        // 1. 处理空闲任务队列（P0 优先，执行日志自动记录）
        this.idleTaskMgr.processAll().catch((err) => {
            logger.warn(`[Heartbeat] 空闲任务处理异常: ${err}`);
        });
        // 2. 自动审核待处理技能申请
        this.checkPendingApplies();
        // 3. 检查活跃项目进度
        const active = this.projectManager.getActiveProject();
        if (active) {
            this.projectManager.recalculateProgress(active.project);
            if (active.progress > 0 && active.progress < 100) {
                logger.debug('[Heartbeat] Project ' + active.project + ': ' + this.progressBar(active.progress));
            }
        }
        // 4. 检查熔断器恢复状态
        const model = this.adapter.model;
        if (!this.circuitBreaker.canUseModel(model)) {
            logger.info('[Heartbeat] Circuit breaker OPEN for ' + model);
        }
        // 5. 检查待恢复任务
        const pending = this.checkpointMgr.listPendingTasks();
        if (pending.length > 0) {
            logger.info('[Heartbeat] ' + pending.length + ' pending checkpoint tasks');
        }
        const elapsed = Date.now() - t0;
        if (elapsed > 1000) {
            logger.warn(`[Heartbeat] 处理耗时 ${elapsed}ms (可能影响响应)`);
        }
    }
    /** 注册 P2 级别的周期性诊断探活任务 */
    registerDiagnosticPingTask() {
        const idleCfg = agent_system_config_1.getConfigSection('idleTasks');
        this.idleTaskMgr.register({
            id: 'periodic-ping-diagnostic',
            name: '定期探活诊断',
            description: '周期性检查 LM Studio 连接状态和 Agent 健康状况',
            priority: 'P2',
            cooldownMs: idleCfg.defaultCooldownMs,
            lastRun: 0,
            running: false,
            createdAt: Date.now(),
            failCount: 0,
            maxFails: idleCfg.defaultMaxFails,
            execute: async () => {
                const alive = await this.adapter.ping();
                this.sessionDiag.recordPing(alive);
                if (alive) {
                    const stats = this.idleTaskMgr.getStats();
                    logger.debug(`[HealthPing] LM Studio OK | 空闲任务: ${stats.pending}待处理, ${stats.executed}已执行`);
                }
                return false; // 保留在队列中持续执行
            },
        });
    }
    /** 注册模型列表心跳任务 — 定期检查 LM Studio 加载/卸载的模型 */
    registerModelListHeartbeat() {
        const idleCfg = agent_system_config_1.getConfigSection('idleTasks');
        this.idleTaskMgr.register({
            id: 'model-list-heartbeat',
            name: '模型列表心跳',
            description: '定期检查 LM Studio 加载/卸载的模型列表变化，自动同步',
            priority: 'P2',
            cooldownMs: 5 * 60 * 1000, // 5 分钟检查一次
            lastRun: 0,
            running: false,
            createdAt: Date.now(),
            failCount: 0,
            maxFails: idleCfg?.defaultMaxFails ?? 3,
            execute: async () => {
                try {
                    const currentModels = await this.adapter.listModels();
                    const currentIds = new Set(currentModels.map((m: any) => m.id));
                    const previousIds = new Set(this._availableModels.map((m: any) => m.id));
                    // 检测变化
                    const added = currentModels.filter((m: any) => !previousIds.has(m.id));
                    const removed = this._availableModels.filter((m: any) => !currentIds.has(m.id));
                    if (added.length > 0 || removed.length > 0) {
                        this._availableModels = currentModels;
                        if (added.length > 0) {
                            logger.info(`[ModelHeartbeat] 检测到新加载模型: ${added.map((m: any) => m.id).join(', ')}`);
                        }
                        if (removed.length > 0) {
                            logger.warn(`[ModelHeartbeat] 检测到模型已卸载: ${removed.map((m: any) => m.id).join(', ')}`);
                            // 如果当前使用的模型被卸载，发出告警
                            if (removed.some((m: any) => m.id === this.adapter.model)) {
                                logger.error(`[ModelHeartbeat] ⚠️ 当前使用模型 ${this.adapter.model} 已被卸载！请切换到其他模型`);
                            }
                        }
                        // 广播模型列表变化事件
                        try {
                            agentEventBus.emit('status', {
                                type: 'model_list_changed',
                                added: added.map((m: any) => m.id),
                                removed: removed.map((m: any) => m.id),
                                total: currentModels.length,
                            });
                        } catch { /* ignore */ }
                    }
                    return false; // 保留在队列中持续执行
                } catch (err) {
                    logger.debug(`[ModelHeartbeat] 检查失败（非阻塞）: ${err}`);
                    return false;
                }
            },
        });
    }
    /** 注册 A 型主动性空闲任务：记忆整理 + 任务监控检查 */
    registerProactiveTasks() {
        return proactiveTasks.registerProactiveTasks(this);
    }
    // ====== 状态/工具方法 ======
    buildStatus() {
        const modelStatus = this.circuitBreaker.canUseModel(this.adapter.model) ? 'OK' : 'BREAKER';
        const pending = this.checkpointMgr.listPendingTasks();
        const lines = [
            'Agent v0.3.0 (Phase 5)', 'Session: ' + this.sessionId.slice(-8),
            'DB: ' + (this.dbInitialized ? 'OK' : 'file'), 'Model: ' + modelStatus + ' ' + this.adapter.model,
            'Skills: ' + this.registry.size, 'Agents: ' + this.subAgents.size,
            'Recovery: ' + (pending.length > 0 ? pending.length + ' pending' : 'OK'),
            this.orchestrator.getStatus(),
        ];
        const active = this.projectManager.getActiveProject();
        if (active)
            lines.push('Project: ' + active.project + ' ' + this.progressBar(active.progress));
        return lines.join('\n');
    }
    progressBar(pct) {
        const filled = Math.round(pct / 10);
        return '[' + '='.repeat(filled) + ' '.repeat(10 - filled) + '] ' + pct + '%';
    }
    sanitizeProjectName(input) {
        return input.slice(0, 30).replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project';
    }
    extractNeededCap(error) {
        const map = {
            'command not found': 'shell',
            'permission denied': 'file access',
            'no such file': 'file system',
            'network': 'network',
            'timeout': 'long task',
        };
        for (const [k, v] of Object.entries(map)) {
            if (error.toLowerCase().includes(k))
                return v;
        }
        return error.slice(0, 40);
    }
    recordInteraction(input, output) {
        try {
            const store = file_store_1.getMemoryStore();
            // 保存更多上下文：输入前 500 字 + 输出前 1000 字
            const inputBrief = input.length > 500 ? input.slice(0, 500) + '...' : input;
            const outputBrief = output.length > 1000 ? output.slice(0, 1000) + '...' : output;
            store.append(inputBrief + '\n' + outputBrief);
            logger.debug(`[Memory] recordInteraction: 写入 ${inputBrief.length}+${outputBrief.length} 字到记忆文件`);
        }
        catch (err) {
            logger.warn('[Memory] recordInteraction 失败: ' + (err as Error).message);
        }
    }
    stop() {
        const active = this.projectManager.getActiveProject();
        if (active && active.status === 'in_progress') {
            this.projectManager.updateProjectMeta(active.project, { status: 'paused' });
            this.projectManager.writeJournal(active.project, { timestamp: new Date().toISOString(), sessionId: this.sessionId, action: 'paused', result: 'partial', next: 'resume' });
        }
        this.running = false;
        this.orchestrator.stopHeartbeat();
        // 停止后台监控定时器（胡话检测/健康监控），防止进程残留后定时器空转
        try { this.nonsenseDetector.stopMonitor(); } catch { /* ignore */ }
        try { this.healthMon.reset(); } catch { /* ignore */ }
        // P2: 自动会话摘要
        try {
            this.summarizer.summarizeSession(this.sessionId, this.messages.filter(m => m.role !== 'system'), []).catch(() => { });
        }
        catch { /* ignore */ }
        // 关闭审计日志
        try {
            const summary = this.auditLog.getSessionSummary();
            this.auditLog.endSession(summary);
        }
        catch { /* ignore */ }
        if (this.dbInitialized) {
            try {
                db_store_1.getDBStore().endSession(this.sessionId, undefined, this.messages.length);
            }
            catch { /* ignore */ }
        }
        logger.info('Agent stopped');
    }
}
export { AgentCore };
