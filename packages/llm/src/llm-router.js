"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMRouter = void 0;
exports.initLLMRouter = initLLMRouter;
exports.getLLMRouter = getLLMRouter;
const events_1 = require("@agent-system/events");
const logger_1 = require("./logger");
const TASK_PARAMS = {
    intent: { temperature: 0, max_tokens: 512, reasoning: 'off' },
    decompose: { temperature: 0, max_tokens: 1024, reasoning: 'off' },
    chat: { temperature: 0.7, max_tokens: 2048 },
    summarize: { temperature: 0, max_tokens: 1024, reasoning: 'off' },
    probe: { temperature: 0, max_tokens: 256, reasoning: 'off' },
    breakin: { temperature: 0.7, max_tokens: 1024 },
    subagent: { temperature: 0.7, max_tokens: 2048 },
};
class LLMRouter {
    adapter;
    constructor(adapter) {
        this.adapter = adapter;
    }
    async call(req) {
        const { taskType, messages, params, emitPayload = true } = req;
        if (emitPayload)
            this.broadcastPayload(taskType, messages, params);
        return this.adapter.chat(messages);
    }
    async callWithDefaults(req) {
        const defaults = TASK_PARAMS[req.taskType] || {};
        const merged = { ...defaults, ...req.params };
        return this.call({ ...req, params: merged });
    }
    async *callStream(req) {
        const { taskType, messages, emitPayload = true } = req;
        if (emitPayload)
            this.broadcastPayload(taskType, messages, req.params);
        yield* this.adapter.chatStream(messages);
    }
    getDefaults(taskType) {
        return { ...(TASK_PARAMS[taskType] || {}) };
    }
    get rawAdapter() { return this.adapter; }
    broadcastPayload(taskType, messages, overrideParams) {
        try {
            const msgs = messages;
            const systemLen = msgs.filter(m => m.role === 'system').reduce((a, m) => a + (m.content?.length || 0), 0);
            const userLen = msgs.filter(m => m.role === 'user').reduce((a, m) => a + (m.content?.length || 0), 0);
            const assistantLen = msgs.filter(m => m.role === 'assistant').reduce((a, m) => a + (m.content?.length || 0), 0);
            const defaults = TASK_PARAMS[taskType] || {};
            const merged = { ...defaults, ...overrideParams };
            const payload = {
                taskType,
                messages: msgs,
                systemPromptLen: systemLen,
                userPromptLen: userLen,
                assistantPromptLen: assistantLen,
                messageCount: msgs.length,
                model: this.adapter.model,
                params: {
                    temperature: merged.temperature ?? 0.7,
                    max_tokens: merged.max_tokens ?? 2048,
                    reasoning: merged.reasoning,
                },
                ts: new Date().toISOString(),
            };
            events_1.agentEventBus.emitModelPayload(payload);
            logger_1.logger.info(`[LLMRouter] 📤 payload: taskType=${taskType}, msgs=${msgs.length}, model=${payload.model}`);
        }
        catch (err) {
            logger_1.logger.warn('[LLMRouter] payload broadcast failed:', err);
        }
    }
}
exports.LLMRouter = LLMRouter;
// ── Singleton ──
let _instance = null;
function initLLMRouter(adapter) {
    _instance = new LLMRouter(adapter);
    return _instance;
}
function getLLMRouter() {
    if (!_instance)
        throw new Error('[LLMRouter] 未初始化 — 请先调用 initLLMRouter(adapter)');
    return _instance;
}
//# sourceMappingURL=llm-router.js.map