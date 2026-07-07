// @ts-nocheck
// ChatHandler — Phase 2 重构：聊天处理模块
// 从 agent-core.ts 提取，集成完整的装配追踪、熔断器、tracer 等依赖
// 包含 handleChat (非流式) 和 handleStream (流式) 两个入口

import * as llm_router_1 from '@agent-system/llm';
import * as nonsense_detector_1 from '@agent-system/resilience';
import { agentEventBus } from '@agent-system/events';
import { createAssemblyReport, addAssemblyStage, formatAssemblyReport } from '@agent-system/resilience';
import logger from '../../logger';

// 依赖接口定义
export interface ChatHandlerDeps {
    adapter: any;                       // LLM 适配器
    messages: any[];                    // 消息历史（引用传递，handler 会修改）
    ctxManager: any;                    // 上下文管理器
    sessionRecoverer: any;              // 会话恢复器（保留接口，当前未使用）
    promptAssembler: any;               // 提示词组装器
    experienceRetriever: any;           // 经验检索器
    experienceInitialized: boolean;     // 经验模块是否已初始化
    nonsenseDetector: any;              // 胡话检测器
    healthMon: any;                     // 健康监控器
    llmRouter: any;                     // LLM 路由器
    recovery: any;                      // 恢复管理器
    auditLog: any;                      // 审计日志
    sessionDiag: any;                   // 会话诊断器
    circuitBreaker: any;                // 熔断器
    tracer?: any;                       // 全链路追踪器（可选）
    formatRecoveryResult: (result: any) => string;   // 格式化恢复结果
    getIdentityVars: () => Record<string, string>;   // 获取身份变量
    _cachedMemoryBlock: string | null;               // 缓存的记忆块
    _assemblyReport: any | null;                     // 装配追踪报告（外部持有，handler 会重置）
    sessionId: string;                               // 会话 ID
    setMessages: (msgs: any[]) => void;              // 更新消息历史
    setAssemblyReport: (report: any) => void;        // 更新装配报告
}

export class ChatHandler {
    private deps: ChatHandlerDeps;

    constructor(deps: ChatHandlerDeps) {
        this.deps = deps;
    }

    /**
     * 非流式聊天处理
     */
    async handle(userInput: string): Promise<string> {
        const { adapter, ctxManager, healthMon, sessionDiag, circuitBreaker, recovery,
                promptAssembler, experienceRetriever, experienceInitialized,
                nonsenseDetector, auditLog, tracer, sessionId, messages } = this.deps;

        const t0 = Date.now();
        const chatSpanId = tracer?.start('handleChat', 'Agent', { input: userInput.slice(0, 80) });
        logger.info(`[Agent] ┌─ handleChat() 输入(${userInput.length}字)`);
        nonsenseDetector.markConversationStart(userInput);
        let chatOutput = '';
        let chatError = null;

        try {
            // 熔断器预检
            if (!circuitBreaker.canUseModel(adapter.model)) {
                logger.warn(`[Agent] ⛔ 模型 ${adapter.model} 已熔断，尝试恢复...`);
                const cbResult = await recovery.executeProtected(async () => {
                    const alive = await adapter.ping();
                    if (!alive) throw new Error('model_unreachable (circuit breaker)');
                    circuitBreaker.modelSuccess(adapter.model);
                    return '模型已恢复';
                }, { taskId: 'cb-recovery-' + Date.now() });
                if (!cbResult.success) {
                    return '模型服务当前不可用（已熔断）。请稍后重试或输入 /status 查看系统状态。';
                }
            }

            const result = await recovery.executeProtected(async () => {
                const aliveT0 = Date.now();
                const alive = await adapter.ping();
                logger.debug(`[Agent] │ ├─ ping() ${alive ? '✅' : '❌'} (${Date.now() - aliveT0}ms)`);
                sessionDiag.recordPing(alive);
                if (!alive) {
                    healthMon.recordPing(false);
                    circuitBreaker.modelFailure(adapter.model, 'ping failed');
                    throw new Error('model_unreachable');
                }
                healthMon.recordPing(true);
                healthMon.watchTokenStream();

                // 动态上下文窗口
                try {
                    const effectiveWindow = adapter.getEffectiveContextWindow();
                    ctxManager.updateConfig({ maxTokens: effectiveWindow });
                } catch { /* adapter 不支持时忽略 */ }

                // ══ 装配追踪 Stage 0 - 原始上下文（每次 handleChat 都重建） ══
                const assemblyReport = createAssemblyReport(sessionId, userInput);
                this.deps.setAssemblyReport(assemblyReport);
                addAssemblyStage(assemblyReport, 'raw_input', '原始用户输入', '用户输入+历史消息', messages);

                // P7: 上下文压缩
                const ctxResult = await ctxManager.process(messages, userInput, async (prompt) => {
                    agentEventBus.modelResponding(adapter.model);
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
                    auditLog.logDegradation(ctxResult.compressionLevel,
                        `context compressed: ${ctxResult.originalTokens}→${ctxResult.finalTokens}` +
                        (ctxResult.sessionReset ? ' [new session]' : ''), 'compressed', 'attention');
                    if (ctxResult.sessionReset) {
                        try { adapter.markSessionReset(); } catch { /* stateless API 忽略 */ }
                    }
                }

                try {
                    agentEventBus.modelResponding(adapter.model);

                    // ══ 装配追踪 Stage 2 - 压缩后 ══
                    addAssemblyStage(assemblyReport, 'context_compressed', '上下文压缩后',
                        ctxResult.compressed ? 'ContextManager 已压缩上下文' : '上下文未压缩', ctxResult.messages);

                    // 经验检索（条件性注入）
                    let experienceBlock: string | undefined;
                    if (experienceInitialized) {
                        try {
                            const expResults = experienceRetriever.retrieve(userInput, { topK: 3 });
                            if (expResults.length > 0) {
                                experienceBlock = experienceRetriever.formatBlock(expResults);
                            }
                        } catch (err) {
                            logger.debug('[Agent] 经验检索失败（非阻塞）', err);
                        }
                    }

                    // ══ 装配追踪 Stage 3 - 注入前 ══
                    if (this.deps._cachedMemoryBlock || experienceBlock) {
                        const preInjectMsgs = [...ctxResult.messages];
                        if (this.deps._cachedMemoryBlock) {
                            preInjectMsgs.push({ role: 'user', content: `[MEMORY BLOCK即将注入: ${this.deps._cachedMemoryBlock.length}字]` });
                        }
                        if (experienceBlock) {
                            preInjectMsgs.push({ role: 'user', content: `[EXPERIENCE BLOCK即将注入: ${experienceBlock.length}字]` });
                        }
                        addAssemblyStage(assemblyReport, 'injection_prepare', '记忆/经验准备',
                            `memory=${this.deps._cachedMemoryBlock?.length ?? 0}字, experience=${experienceBlock?.length ?? 0}字`, preInjectMsgs);
                    }

                    const assembled = promptAssembler.assemble({
                        identityTemplateId: 'agent.identity',
                        identityVars: this.deps.getIdentityVars(),
                        memoryBlock: this.deps._cachedMemoryBlock || undefined,
                        experienceBlock: experienceBlock,
                        context: ctxResult.messages,
                        userInput: undefined,
                    });
                    logger.debug(
                        `[Agent] PromptAssembler: ${assembled.metadata.totalMessages} 条消息` +
                        ` hasMemory=${assembled.metadata.hasMemory}` +
                        ` hasExperience=${assembled.metadata.hasExperience}` +
                        ` hasSummary=${assembled.metadata.hasSummary}`,
                    );

                    // ══ 装配追踪 Stage 4 - 组装后 ══
                    addAssemblyStage(assemblyReport, 'assembled', 'PromptAssembler 组装后',
                        `memory=${assembled.metadata.hasMemory}, experience=${assembled.metadata.hasExperience}, summary=${assembled.metadata.hasSummary}`, assembled.messages);

                    // LLM 调用
                    const llmT0 = Date.now();
                    const response = await llm_router_1.getLLMRouter().call({
                        taskType: 'chat',
                        messages: assembled.messages,
                        metadata: { assembler: assembled.metadata },
                    });
                    const llmDur = Date.now() - llmT0;
                    const content = response.choices?.[0]?.message?.content;
                    logger.info(`[Agent] │ ├─ LLM chat() 响应 ${content ? content.length : 0}字 (${llmDur}ms)`);

                    // ══ 装配追踪 Stage 5 - 最终 payload ══
                    addAssemblyStage(assemblyReport, 'llm_payload', 'LLM发送载荷',
                        `模型: ${adapter.model}, 温度参数: 默认`, assembled.messages);
                    logger.info(`[Agent] │ └─ 消息装配流水线:\n${formatAssemblyReport(assemblyReport)}`);

                    return content ?? '(empty)';
                } finally {
                    healthMon.endTokenStream();
                }
            }, { taskId: 'chat-' + Date.now(), context: { model: adapter.model } });

            circuitBreaker.modelSuccess(adapter.model);
            chatOutput = this.deps.formatRecoveryResult(result);
        } catch (err) {
            logger.error('[Agent] handleChat() 执行失败', err);
            circuitBreaker.modelFailure(adapter.model, err.message || 'unknown');
            healthMon.recordPing(false);
            chatOutput = `ERR: ${err.message || 'unknown error'}`;
            chatError = err.message || 'unknown error';
        }

        // 胡话检测
        const reason = nonsense_detector_1.NonsenseDetector.detectGibberish(chatOutput);
        const normal = !reason && !chatError;
        nonsenseDetector.markConversationEnd(normal, userInput, chatOutput, reason || chatError || undefined);
        if (!normal) {
            logger.warn(`[Nonsense] handleChat 检测到异常: ${reason || chatError}`);
        }

        if (tracer && chatSpanId) {
            if (chatError) tracer.error(chatSpanId, chatError);
            else tracer.end(chatSpanId, { reply_len: chatOutput.length, dur: Date.now() - t0 });
        }
        logger.info(`[Agent] └─ handleChat() 完成 (${Date.now() - t0}ms) 回复${chatOutput.length}字${chatError ? ' ❌' : ''}`);
        return chatOutput;
    }

    /**
     * 流式聊天处理
     */
    async handleStream(userInput: string): Promise<string> {
        const { adapter, ctxManager, healthMon, sessionDiag, circuitBreaker, recovery,
                promptAssembler, experienceRetriever, experienceInitialized,
                nonsenseDetector, tracer } = this.deps;

        const t0 = Date.now();
        logger.info(`[Agent] ┌─ handleChatStream() 输入(${userInput.length}字)`);
        nonsenseDetector.markConversationStart(userInput);
        let chatOutput = '';
        let chatError = null;
        const streamStartTime = Date.now();

        try {
            // 熔断器预检
            if (!circuitBreaker.canUseModel(adapter.model)) {
                logger.warn(`[Agent][stream] ⛔ 模型 ${adapter.model} 已熔断`);
                const cbResult = await recovery.executeProtected(async () => {
                    const alive = await adapter.ping();
                    if (!alive) throw new Error('model_unreachable (circuit breaker)');
                    circuitBreaker.modelSuccess(adapter.model);
                    return 'ok';
                }, { taskId: 'cb-stream-recovery-' + Date.now() });
                if (!cbResult.success) {
                    return '模型服务当前不可用（已熔断）。请稍后重试。';
                }
            }

            chatOutput = await recovery.executeProtected(async () => {
                const aliveT0 = Date.now();
                const alive = await adapter.ping();
                logger.debug(`[Agent] │ ├─ ping() ${alive ? '✅' : '❌'} (${Date.now() - aliveT0}ms)`);
                sessionDiag.recordPing(alive);
                if (!alive) {
                    healthMon.recordPing(false);
                    circuitBreaker.modelFailure(adapter.model, 'ping failed');
                    throw new Error('model_unreachable');
                }
                healthMon.recordPing(true);
                healthMon.watchTokenStream();

                try {
                    const effectiveWindow = adapter.getEffectiveContextWindow();
                    ctxManager.updateConfig({ maxTokens: effectiveWindow });
                } catch { }

                const ctxResult = await ctxManager.process(this.deps.messages, userInput, async (prompt) => {
                    agentEventBus.modelResponding(adapter.model);
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
                        try { adapter.markSessionReset(); } catch { }
                    }
                }

                try {
                    agentEventBus.modelResponding(adapter.model);
                    // PromptAssembler 组装
                    let experienceBlock;
                    if (experienceInitialized) {
                        try {
                            const expResults = experienceRetriever.retrieve(userInput, { topK: 3 });
                            if (expResults.length > 0) {
                                experienceBlock = experienceRetriever.formatBlock(expResults);
                            }
                        } catch (err) {
                            logger.debug('[Agent] 经验检索失败（非阻塞）', err);
                        }
                    }
                    const assembled = promptAssembler.assemble({
                        identityTemplateId: 'agent.identity',
                        identityVars: this.deps.getIdentityVars(),
                        memoryBlock: this.deps._cachedMemoryBlock || undefined,
                        experienceBlock: experienceBlock,
                        context: ctxResult.messages,
                        userInput: undefined,
                    });
                    logger.debug(`[Agent][stream] PromptAssembler: ${assembled.metadata.totalMessages} 条消息`);

                    // 流式调用
                    let fullReply = '';
                    try {
                        for await (const chunk of llm_router_1.getLLMRouter().callStream({
                            taskType: 'chat',
                            messages: assembled.messages,
                            metadata: { assembler: assembled.metadata },
                        })) {
                            fullReply += chunk;
                            healthMon.beat();
                            agentEventBus.emitChatChunk(chunk);
                        }
                    } catch (streamErr) {
                        // Bug F 修复：流式中断且已有内容时，必须 emit emitChatDone（前端才能切换状态）
                        if (fullReply.length > 0) {
                            logger.warn(`[Agent][stream] 流式中断，保留已有内容 (${fullReply.length}字): ${streamErr}`);
                            const partialDuration = Date.now() - streamStartTime;
                            agentEventBus.emitChatDone(fullReply, partialDuration);
                        } else {
                            // 无内容：网络错重试 → 非流式回退
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
                } finally {
                    healthMon.endTokenStream();
                }
            }, { taskId: 'chat-stream-' + Date.now(), context: { model: adapter.model } });

            circuitBreaker.modelSuccess(adapter.model);
            chatOutput = this.deps.formatRecoveryResult(chatOutput);
        } catch (err) {
            logger.error('[Agent] handleChatStream() 执行失败', err);
            circuitBreaker.modelFailure(adapter.model, err.message || 'unknown');
            healthMon.recordPing(false);
            chatOutput = `ERR: ${err.message || 'unknown error'}`;
            chatError = err.message || 'unknown error';
            agentEventBus.emitChatError(chatError);
        }

        const reason = nonsense_detector_1.NonsenseDetector.detectGibberish(chatOutput);
        const normal = !reason && !chatError;
        nonsenseDetector.markConversationEnd(normal, userInput, chatOutput, reason || chatError || undefined);
        if (!normal) {
            logger.warn(`[Nonsense] handleChatStream 检测到异常: ${reason || chatError}`);
        }
        logger.info(`[Agent] └─ handleChatStream() 完成 (${Date.now() - t0}ms) 回复${chatOutput.length}字${chatError ? ' ❌' : ''}`);
        return chatOutput;
    }
}

/**
 * 工厂函数：从 AgentCore 实例创建 ChatHandler
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
        agentEventBus: agentEventBus,
        recovery: agent.recovery,
        auditLog: agent.auditLog,
        sessionDiag: agent.sessionDiag,
        circuitBreaker: agent.circuitBreaker,
        tracer: agent._tracer,
        formatRecoveryResult: agent.formatRecoveryResult.bind(agent),
        getIdentityVars: agent.getIdentityVars.bind(agent),
        _cachedMemoryBlock: agent._cachedMemoryBlock,
        _assemblyReport: agent._assemblyReport,
        sessionId: agent.sessionId,
        setMessages: (msgs: any[]) => { agent.messages = msgs; },
        setAssemblyReport: (report: any) => { agent._assemblyReport = report; },
    };
    return new ChatHandler(deps);
}
