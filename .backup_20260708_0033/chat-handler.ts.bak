// @ts-nocheck
// ChatHandler - Phase 2 重构：聊天处理模块
// 从 agent-core.ts 提取的聊天处理逻辑（handleChat 和 handleChatStream）

import * as llm_router_1 from '@agent-system/llm';
import * as context_manager_1 from '../context-manager';
import * as session_recovery_1 from '@agent-system/memory';
import * as experience_1 from '@agent-system/experience';
import * as nonsense_detector_1 from '@agent-system/resilience';
import * as health_monitor_1 from '@agent-system/resilience';
import { agentEventBus } from '@agent-system/events';
import logger from '../../logger';

// 依赖接口定义
export interface ChatHandlerDeps {
    adapter: any; // LLM adapter
    messages: any[]; // 消息历史
    ctxManager: any; // 上下文管理器
    sessionRecoverer: any; // 会话恢复器
    promptAssembler: any; // 提示词组装器
    experienceRetriever: any; // 经验检索器
    experienceInitialized: boolean; // 经验模块是否已初始化
    nonsenseDetector: any; // 胡话检测器
    healthMon: any; // 健康监控器
    llmRouter: any; // LLM 路由器
    agentEventBus: any; // 事件总线
    recovery: any; // 恢复管理器
    auditLog: any; // 审计日志
    sessionDiag: any; // 会话诊断器
    formatRecoveryResult: (result: string) => string; // 格式化恢复结果
    getIdentityVars: () => Record<string, string>; // 获取身份变量
    _cachedMemoryBlock: string | null; // 缓存的记忆块
    sanitizeProjectName: (name: string) => string; // 清理项目名称
    projectManager: any; // 项目管理器
    isMultiAgentTask: (message: string) => boolean; // 是否多Agent任务
    handleMultiAgentTask: (intent: any, rawMessage: string) => Promise<string>; // 处理多Agent任务
    circuitBreaker?: any; // 熔断器（可选，兼容旧代码）
}

export class ChatHandler {
    private deps: ChatHandlerDeps;

    constructor(deps: ChatHandlerDeps) {
        this.deps = deps;
    }

    /**
     * 非流式聊天处理
     * @param userInput 用户输入
     * @returns 回复内容
     */
    async handle(userInput: string): Promise<string> {
        logger.info('[ChatHandler] handle() 开始');
        this.deps.nonsenseDetector.markConversationStart(userInput);
        let chatOutput = '';
        let chatError = null;
        // 熔断器预检
        const cb = (this.deps as any).circuitBreaker;
        if (cb && !cb.canUseModel(this.deps.adapter.model)) {
            logger.warn(`[ChatHandler] ⛔ 模型 ${this.deps.adapter.model} 已熔断`);
            return '模型服务当前不可用（已熔断）。请稍后重试或输入 /status 查看系统状态。';
        }

        try {
            const result = await this.deps.recovery.executeProtected(async () => {
                logger.info('[ChatHandler] handle() 开始执行 protected 逻辑');
                const alive = await this.deps.adapter.ping();
                this.deps.sessionDiag.recordPing(alive);
                if (!alive) {
                    this.deps.healthMon.recordPing(false);
                    if (cb) cb.modelFailure(this.deps.adapter.model, 'ping failed');
                    throw new Error('model_unreachable');
                }
                this.deps.healthMon.recordPing(true);
                this.deps.healthMon.watchTokenStream();
                // P7: 动态上下文窗口 — 从模型实际 context_length 算有效预算
                try {
                    const effectiveWindow = this.deps.adapter.getEffectiveContextWindow();
                    this.deps.ctxManager.updateConfig({ maxTokens: effectiveWindow });
                } catch { /* adapter 不支持时忽略 */ }
                // P7: 上下文管理 — 压缩后发送
                const ctxResult = await this.deps.ctxManager.process(
                    this.deps.messages,
                    userInput,
                    async (prompt) => {
                        // 事件总线：模型开始响应
                        this.deps.agentEventBus.modelResponding(this.deps.adapter.model);
                        // LLM Router 统一调用：自动广播 payload
                        const summarizeMsgs = [{ role: 'user' as const, content: prompt }];
                        const resp = await llm_router_1.getLLMRouter().call({
                            taskType: 'summarize',
                            messages: summarizeMsgs,
                        });
                        return resp.choices?.[0]?.message?.content || '';
                    }
                );
                if (ctxResult.compressed) {
                    logger.info(`[ChatHandler] 上下文压缩: ${ctxResult.originalTokens} → ${ctxResult.finalTokens} tokens` +
                        `, ${ctxResult.hotCount} 条热点, 层级 ${ctxResult.compressionLevel}` +
                        (ctxResult.sessionReset ? ', ⚠️ 会话边界 — 开启新会话' : ''));
                    this.deps.auditLog.logDegradation(
                        ctxResult.compressionLevel,
                        `context compressed: ${ctxResult.originalTokens}→${ctxResult.finalTokens}` +
                        (ctxResult.sessionReset ? ' [new session]' : ''),
                        'compressed',
                        'attention'
                    );
                    // 会话边界：通知适配器下次请求开启新会话
                    if (ctxResult.sessionReset) {
                        try {
                            this.deps.adapter.markSessionReset();
                        } catch {
                            // stateless API 忽略
                        }
                    }
                }
                try {
                    // 事件总线：模型开始响应
                    this.deps.agentEventBus.modelResponding(this.deps.adapter.model);
                    // Phase 3: 使用 PromptAssembler 组装最终 messages
                    // ContextManager 已处理压缩，ctxResult.messages 包含处理后的上下文
                    // Experience module: 检索相关经验（条件性注入）
                    let experienceBlock: string | undefined;
                    if (this.deps.experienceInitialized) {
                        try {
                            const expResults = this.deps.experienceRetriever.retrieve(userInput, { topK: 3 });
                            if (expResults.length > 0) {
                                experienceBlock = this.deps.experienceRetriever.formatBlock(expResults);
                            }
                        } catch (err) {
                            logger.debug('[ChatHandler] 经验检索失败（非阻塞）', err);
                        }
                    }
                    const assembled = this.deps.promptAssembler.assemble({
                        identityTemplateId: 'agent.identity',
                        identityVars: this.deps.getIdentityVars(),
                        memoryBlock: this.deps._cachedMemoryBlock || undefined,
                        experienceBlock: experienceBlock,
                        context: ctxResult.messages,
                        userInput: undefined, // userInput 已在 ctxResult.messages 末尾
                    });
                    logger.debug(
                        `[ChatHandler] PromptAssembler: ${assembled.metadata.totalMessages} 条消息` +
                        ` hasMemory=${assembled.metadata.hasMemory}` +
                        ` hasExperience=${assembled.metadata.hasExperience}` +
                        ` hasSummary=${assembled.metadata.hasSummary}`,
                    );
                    // LLM Router 统一调用：自动广播 payload（附加组装元数据）
                    const response = await llm_router_1.getLLMRouter().call({
                        taskType: 'chat',
                        messages: assembled.messages,
                        metadata: { assembler: assembled.metadata },
                    });
                    return response.choices?.[0]?.message?.content ?? '(empty)';
                } finally {
                    this.deps.healthMon.endTokenStream();
                }
            }, { taskId: 'chat-' + Date.now() });
            if (cb) cb.modelSuccess(this.deps.adapter.model);
            chatOutput = this.deps.formatRecoveryResult(result);
        } catch (err) {
            if (cb) cb.modelFailure(this.deps.adapter.model, err.message || 'unknown');
            this.deps.healthMon.recordPing(false);
            chatOutput = `ERR: ${err.message || 'unknown error'}`;
            chatError = err.message || 'unknown error';
        }
        // 胡话检测
        const reason = nonsense_detector_1.NonsenseDetector.detectGibberish(chatOutput);
        const normal = !reason && !chatError;
        this.deps.nonsenseDetector.markConversationEnd(normal, userInput, chatOutput, reason || chatError || undefined);
        if (!normal) {
            logger.warn(`[Nonsense][ChatHandler] handleChat 检测到异常: ${reason || chatError}`);
        }
        return chatOutput;
    }

    /**
     * 流式聊天处理
     * @param userInput 用户输入
     * @returns 完整回复字符串
     */
    async handleStream(userInput: string): Promise<string> {
        this.deps.nonsenseDetector.markConversationStart(userInput);
        let chatOutput = '';
        let chatError = null;
        const streamStartTime = Date.now();
        // 熔断器预检
        const cb2 = (this.deps as any).circuitBreaker;
        if (cb2 && !cb2.canUseModel(this.deps.adapter.model)) {
            logger.warn(`[ChatHandler][stream] ⛔ 模型 ${this.deps.adapter.model} 已熔断`);
            return '模型服务当前不可用（已熔断）。请稍后重试。';
        }

        try {
            chatOutput = await this.deps.recovery.executeProtected(async () => {
                const alive = await this.deps.adapter.ping();
                this.deps.sessionDiag.recordPing(alive);
                if (!alive) {
                    this.deps.healthMon.recordPing(false);
                    if (cb2) cb2.modelFailure(this.deps.adapter.model, 'ping failed');
                    throw new Error('model_unreachable');
                }
                this.deps.healthMon.recordPing(true);
                this.deps.healthMon.watchTokenStream();
                try {
                    const effectiveWindow = this.deps.adapter.getEffectiveContextWindow();
                    this.deps.ctxManager.updateConfig({ maxTokens: effectiveWindow });
                } catch { }
                const ctxResult = await this.deps.ctxManager.process(
                    this.deps.messages,
                    userInput,
                    async (prompt) => {
                        this.deps.agentEventBus.modelResponding(this.deps.adapter.model);
                        const summarizeMsgs = [{ role: 'user', content: prompt }];
                        const resp = await llm_router_1.getLLMRouter().call({
                            taskType: 'summarize',
                            messages: summarizeMsgs,
                        });
                        return resp.choices?.[0]?.message?.content || '';
                    }
                );
                if (ctxResult.compressed) {
                    logger.info(`[ChatHandler] 上下文压缩: ${ctxResult.originalTokens} → ${ctxResult.finalTokens} tokens`);
                    if (ctxResult.sessionReset) {
                        try {
                            this.deps.adapter.markSessionReset();
                        } catch { }
                    }
                }
                try {
                    this.deps.agentEventBus.modelResponding(this.deps.adapter.model);
                    // Phase 3: 使用 PromptAssembler 组装最终 messages
                    let experienceBlock: string | undefined;
                    if (this.deps.experienceInitialized) {
                        try {
                            const expResults = this.deps.experienceRetriever.retrieve(userInput, { topK: 3 });
                            if (expResults.length > 0) {
                                experienceBlock = this.deps.experienceRetriever.formatBlock(expResults);
                            }
                        } catch (err) {
                            logger.debug('[ChatHandler] 经验检索失败（非阻塞）', err);
                        }
                    }
                    const assembled = this.deps.promptAssembler.assemble({
                        identityTemplateId: 'agent.identity',
                        identityVars: this.deps.getIdentityVars(),
                        memoryBlock: this.deps._cachedMemoryBlock || undefined,
                        experienceBlock: experienceBlock,
                        context: ctxResult.messages,
                        userInput: undefined,
                    });
                    logger.debug(`[ChatHandler][stream] PromptAssembler: ${assembled.metadata.totalMessages} 条消息`);
                    // 流式调用 LLM Router
                    let fullReply = '';
                    try {
                        for await (const chunk of llm_router_1.getLLMRouter().callStream({
                            taskType: 'chat',
                            messages: assembled.messages,
                            metadata: { assembler: assembled.metadata },
                        })) {
                            fullReply += chunk;
                            this.deps.healthMon.beat();
                            this.deps.agentEventBus.emitChatChunk(chunk);
                        }
                    } catch (streamErr) {
                        if (fullReply.length > 0) {
                            logger.warn(`[ChatHandler][stream] 流式中断，保留已有内容 (${fullReply.length}字)`);
                            this.deps.agentEventBus.emitChatError(streamErr.message || 'stream interrupted');
                        } else {
                            // 无内容：尝试非流式回退
                            const isNetwork = /ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(streamErr.message || '');
                            if (isNetwork) {
                                await new Promise(r => setTimeout(r, 3000));
                            }
                            try {
                                const fallbackResp = await llm_router_1.getLLMRouter().call({
                                    taskType: 'chat',
                                    messages: assembled.messages,
                                });
                                fullReply = fallbackResp.choices?.[0]?.message?.content || '';
                                if (!fullReply) throw streamErr;
                                logger.info(`[ChatHandler][stream] 非流式回退成功 (${fullReply.length}字)`);
                            } catch { throw streamErr; }
                        }
                    }
                    const duration = Date.now() - streamStartTime;
                    this.deps.agentEventBus.emitChatDone(fullReply, duration);
                    return fullReply || '(empty)';
                } finally {
                    this.deps.healthMon.endTokenStream();
                }
            }, { taskId: 'chat-stream-' + Date.now(), context: { model: this.deps.adapter.model } });
            if (cb2) cb2.modelSuccess(this.deps.adapter.model);
            chatOutput = this.deps.formatRecoveryResult(chatOutput);
        } catch (err) {
            if (cb2) cb2.modelFailure(this.deps.adapter.model, err.message || 'unknown');
            this.deps.healthMon.recordPing(false);
            chatOutput = `ERR: ${err.message || 'unknown error'}`;
            chatError = err.message || 'unknown error';
            this.deps.agentEventBus.emitChatError(chatError);
        }
        const reason = nonsense_detector_1.NonsenseDetector.detectGibberish(chatOutput);
        const normal = !reason && !chatError;
        this.deps.nonsenseDetector.markConversationEnd(normal, userInput, chatOutput, reason || chatError || undefined);
        if (!normal) {
            logger.warn(`[Nonsense][ChatHandler] handleChatStream 检测到异常: ${reason || chatError}`);
        }
        return chatOutput;
    }
}

/**
 * 工厂函数：从 AgentCore 实例创建 ChatHandler
 * @param agent AgentCore 实例
 * @returns ChatHandler 实例
 */
export function createChatHandlerFromAgentCore(agent: any): ChatHandler {
    const deps: ChatHandlerDeps = {
        adapter: agent.adapter,
        messages: agent.messages,
        ctxManager: agent.ctxManager,
        sessionRecoverer: agent.sessionRecoverer,
        promptAssembler: agent.promptAssembler,
        experienceRetriever: agent.experienceRetriever,
        experienceInitialized: agent.experienceInitialized,
        nonsenseDetector: agent.nonsenseDetector,
        healthMon: agent.healthMon,
        llmRouter: llm_router_1.getLLMRouter(),
        agentEventBus: agentEventBus, // 单例实例
        recovery: agent.recovery,
        auditLog: agent.auditLog,
        sessionDiag: agent.sessionDiag,
        circuitBreaker: agent.circuitBreaker,
        formatRecoveryResult: agent.formatRecoveryResult.bind(agent),
        getIdentityVars: agent.getIdentityVars.bind(agent),
        _cachedMemoryBlock: agent._cachedMemoryBlock,
        sanitizeProjectName: agent.sanitizeProjectName.bind(agent),
        projectManager: agent.projectManager,
        isMultiAgentTask: agent.isMultiAgentTask.bind(agent),
        handleMultiAgentTask: agent.handleMultiAgentTask.bind(agent),
        circuitBreaker: agent.circuitBreaker,
    };
    return new ChatHandler(deps);
}
