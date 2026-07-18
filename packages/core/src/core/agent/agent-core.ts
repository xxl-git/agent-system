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

        // Step 1: 文件记忆 + 裁剪 + 日志清理
        initSteps.initMemoryStore();

        // Step 2: 检测待恢复的长任务检查点
        initSteps.initCheckpoints(this);

        // Step 3: 初始化数据库
        await initSteps.initDatabase(this);

        // Step 4: 恢复跨会话记忆
        initSteps.initMemoryRecovery(this);

        // Step 5: 初始化摘要引擎
        const memoryBlock = initSteps.initSummarizer(this);

        // Step 5.5: 初始化经验模块
        await initSteps.initExperience(this);

        // Step 6: 初始化 system message
        initSteps.initSystemMessage(this, memoryBlock);

        // Step 7: 模型上线探测
        const onboardResult = await initSteps.initModel(this);

        // 初始化完成汇总
        const recovery = this.projectManager.recoverySummary();
        const ckptRecovery = this.checkpointMgr.recoverySummary();
        const skillsMsg = '\nSKILL: ' + this.registry.size + ' loaded';
        let base = recovery ? onboardResult + skillsMsg + '\n\n' + recovery : onboardResult + skillsMsg;
        if (ckptRecovery !== 'No pending recovery tasks')
            base += '\n\n' + ckptRecovery;

        // 会话诊断 + 胡话检测：同步模型名 + 启动监控
        this.sessionDiag.setModelName(this.adapter.model);
        this.nonsenseDetector.setModelName(this.adapter.model);
        this.nonsenseDetector.startMonitor();

        // 注册定时任务
        this.registerDiagnosticPingTask();
        this.registerModelListHeartbeat();
        this.registerProactiveTasks();

        // Phase 5: 启动韧性心跳
        this.orchestrator.startHeartbeat();

        // Phase 1-3 重构：实例化 Handler 模块
        this.chatHandler = createChatHandlerFromAgentCore(this);
        this.commandHandler = createCommandHandlerFromAgentCore(this);
        this.taskHandler = createTaskHandlerFromAgentCore(this);
        logger.info('[Agent] Handler 模块已集成: ChatHandler + CommandHandler + TaskHandler');

        const totalTime = Date.now() - initStart;
        logger.info([Agent] ====== 初始化完成 (ms) ======);
        logger.info(Agent core (Phase 5: router+skills+multi-agent+resilience+heartbeat));
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
        return sendMessageCore(this, userInput, false);
    }
    async handleChat(userInput) {
        // Phase 2 重构：委托给 ChatHandler（已集成）
        if (this.chatHandler) return this.chatHandler.handle(userInput);
        // fallback 已移除（chatHandler 在 init() 中始终初始化）
        // 如需恢复，参见 git history commit 3268ef9 之前的版本
        throw new Error('chatHandler not initialized');
    }
    /**
     * 流式发送消息 — 与 sendMessage() 相同的 pipeline，但聊天路径使用流式输出
     * 逐 chunk 通过 agentEventBus.emitChatChunk() 广播
     * 返回完整回复字符串
     */
    async sendMessageStream(userInput) {
        return sendMessageCore(this, userInput, true);
    }
    /**
     * 流式聊天处理 — 与 handleChat() 相同逻辑，但使用 llmRouter.callStream()
     * 逐 chunk 通过 agentEventBus.emitChatChunk() 广播
     */
    async handleChatStream(userInput) {
        // Phase 2 重构：委托给 ChatHandler（已集成）
        if (this.chatHandler) return this.chatHandler.handleStream(userInput);
        // fallback 已移除（chatHandler 在 init() 中始终初始化）
        return this.handleChat(userInput);
    }
    async handleTask(intent, rawMessage) {
        // Phase 3 重构：委托给 TaskHandler（已集成）
        if (this.taskHandler) return this.taskHandler.handle(intent, rawMessage);
        // fallback 已移除（taskHandler 在 init() 中始终初始化）
        throw new Error('taskHandler not initialized');
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
        // fallback 已移除（commandHandler 在 init() 中始终初始化）
        throw new Error('commandHandler not initialized');
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
