// send-message-core.ts
// 从 agent-core.ts 提取的 sendMessage / sendMessageStream 公共逻辑
// 两个方法唯一区别：聊天路径调用 handleChat vs handleChatStream

import { agentEventBus } from '@agent-system/events';
import { getTracer, finishTrace } from '@agent-system/resilience';
import logger from '../../logger';

/** 错误信息提取 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** AgentCore 的最小接口（避免循环依赖） */
interface SendMessageAgent {
  messages: Array<{ role: string; content: string }>;
  sessionId: string;
  config: {
    agent: {
      skipIntentParsing?: boolean;
    };
  };
  intentParser: {
    parse(input: string): Promise<any>;
  };
  handleCommand(input: string): Promise<string>;
  handleTask(intent: any, input: string): Promise<string>;
  handleChat(input: string): Promise<string>;
  handleChatStream(input: string): Promise<string>;
  recordInteraction(input: string, reply: string): void;
  breakIn: {
    evaluateInteraction(opts: any): void;
  };
  checkPendingApplies(): void;
  auditLog: {
    logDecision(type: string, summary: string, result: string, meta: any): void;
  };
  recordDecision(intent: any, input: string, reply: string, isError: boolean): void;
  recordEntities(input: string): void;
  experienceInitialized: boolean;
  experienceExtractor: {
    extract(input: string, reply: string, outcome: string, sessionId: string, meta: any): Promise<number | null>;
  };
  adapter: {
    model: string;
  };
  _tracer: any;
}

/**
 * sendMessage / sendMessageStream 的公共逻辑
 * @param agent AgentCore 实例
 * @param userInput 用户输入
 * @param stream 是否使用流式聊天路径
 * @returns 回复字符串
 */
export async function sendMessageCore(agent: SendMessageAgent, userInput: string, stream: boolean): Promise<string> {
    const t0 = Date.now();
    const method = stream ? 'sendMessageStream()' : 'sendMessage()';
    agent.messages.push({ role: 'user', content: userInput });
    logger.info(`[Agent] ┌─ ${method} 输入(${userInput.length}字): ${userInput.slice(0, 100)}`);

    // 全链路追踪（仅非流式版本启用）
    let sendSpanId: string | undefined;
    if (!stream) {
        agent._tracer = getTracer(agent.sessionId);
        sendSpanId = agent._tracer.start('sendMessage', 'Agent', { input: userInput.slice(0, 80) });
        agent._tracer.start('pushMessage', 'Agent', { role: 'user', len: userInput.length });
        agent._tracer.end('pushMessage');
    }

    // 事件总线：开始 pipeline
    agentEventBus.startSession(3);

    // 快速通道：/ 开头的命令跳过 LLM 意图解析
    if (userInput.startsWith('/')) {
        logger.info('[Agent] │ └─ 路由: /命令 → handleCommand()');
        if (!stream && sendSpanId) {
            agent._tracer.start('handleCommand', 'Agent', { cmd: userInput.slice(0, 60) });
        }
        const reply = await agent.handleCommand(userInput);
        if (!stream && sendSpanId) {
            agent._tracer.end('handleCommand', { reply_len: reply.length });
        }
        const dur = Date.now() - t0;
        agent.messages.push({ role: 'assistant', content: reply });
        if (!stream && sendSpanId) {
            agent._tracer.end(sendSpanId, { reply_len: reply.length, dur });
            finishTrace(agent.sessionId);
        }
        logger.info(`[Agent] └─ ${method} 完成 (${dur}ms) 回复${reply.length}字`);
        agentEventBus.endSession(true, '命令完成');
        return reply;
    }

    // 意图解析
    let intent;
    const intentT0 = Date.now();
    if (agent.config.agent.skipIntentParsing) {
        intent = { type: 'unknown', summary: userInput.slice(0, 50), entities: [], confidence: 0.5, needsClarification: false, missingInfo: [] };
        logger.debug(`[Agent] │ └─ 意图解析已跳过 (skipIntentParsing=true)`);
    } else {
        try {
            intent = await agent.intentParser.parse(userInput);
            const entities = (intent.entities || []).map((e: any) => e.name || e).join(', ');
            logger.info(`[Agent] │ ├─ 意图解析完成 (${Date.now() - intentT0}ms): type=${intent.type} confidence=${intent.confidence} entities=[${entities}]`);
        }
        catch (err: unknown) {
            intent = { type: 'unknown', summary: userInput.slice(0, 50), entities: [], confidence: 0.3, needsClarification: false, missingInfo: [] };
            logger.warn(`[Agent] │ ├─ 意图解析失败: ${errorMessage(err)}，降级为 unknown`);
        }
    }

    agentEventBus.stepDone(1, 'intent_ready', '意图: ' + (intent.type || 'unknown'));

    // 需要澄清
    if (intent.needsClarification && intent.missingInfo.length > 0) {
        const msg = 'Not enough info:\n' + intent.missingInfo.map((i: string) => '  - ' + i).join('\n');
        agent.messages.push({ role: 'assistant', content: msg });
        agent.recordInteraction(userInput, msg);
        logger.info(`[Agent] └─ ${method} 完成 (${Date.now() - t0}ms) [需要澄清]`);
        agentEventBus.endSession(true, '需要澄清');
        return msg;
    }

    // 路由到对应 handler
    let reply;
    const routeStart = Date.now();
    const chatHandler = stream ? agent.handleChatStream.bind(agent) : agent.handleChat.bind(agent);
    const routeLabel = intent.type === 'command' ? 'handleCommand()' : intent.type === 'task' ? `handleTask() intent.confidence=${intent.confidence}` : (stream ? 'handleChatStream()' : 'handleChat()');
    logger.info(`[Agent] │ └─ 路由: ${routeLabel}`);
    switch (intent.type) {
        case 'command':
            // 防御: 只有以 / 开头的才走命令路径，LLM 误判回退到 chat
            if (!userInput.trim().startsWith('/')) {
                logger.info(`[Agent] │ ├─ 意图判为 command 但输入不以 / 开头，回退到 ${stream ? 'handleChatStream()' : 'handleChat()'}`);
                reply = await chatHandler(userInput);
            } else {
                reply = await agent.handleCommand(userInput);
            }
            break;
        case 'task':
            reply = await agent.handleTask(intent, userInput);
            break;
        default:
            reply = await chatHandler(userInput);
            break;
    }
    const duration = Date.now() - routeStart;
    agent.messages.push({ role: 'assistant', content: reply });
    logger.info(`[Agent] │ ├─ handler 完成 (${duration}ms) 回复${reply.length}字`);

    // 后处理
    agent.recordInteraction(userInput, reply);
    const isError = reply.startsWith('ERR') || reply.startsWith('WARN');
    agent.breakIn.evaluateInteraction({
        taskType: intent.type, success: !isError, durationMs: duration, toolCalls: intent.type === 'task' ? 2 : 0, toolErrors: isError ? 1 : 0,
    });
    agent.checkPendingApplies();
    agent.auditLog.logDecision(intent.type, reply.slice(0, 200), isError ? 'failure' : 'success', { durationMs: duration, inputLength: userInput.length });
    // P0: 跨会话记忆 — 每次交互后记录决策和实体到数据库
    agent.recordDecision(intent, userInput, reply, isError);
    agent.recordEntities(userInput);
    agentEventBus.endSession(!isError, isError ? '处理出错' : undefined);

    // Experience module: 异步提取经验（不阻塞响应）
    if (agent.experienceInitialized && intent.type !== 'command') {
        const outcome = isError ? 'failure' : 'success';
        agent.experienceExtractor.extract(userInput, reply, outcome, agent.sessionId, {
            modelUsed: agent.adapter.model,
        }).then(id => {
            if (id !== null) {
                logger.debug(`[Agent] 经验已提取: #${id}`);
            }
        }).catch((err: unknown) => {
            logger.debug('[Agent] 经验提取失败（非阻塞）', err);
        });
    }

    const totalDur = Date.now() - t0;
    if (!stream && sendSpanId) {
        agent._tracer.end(sendSpanId, { intent_type: intent.type, reply_len: reply.length, dur: totalDur, isError });
        finishTrace(agent.sessionId);
    }
    logger.info(`[Agent] └─ ${method} 完成 (${totalDur}ms) [${intent.type}] ${isError ? '❌' : '✅'} 回复${reply.length}字`);
    return reply;
}
