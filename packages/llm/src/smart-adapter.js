"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SmartAdapter = void 0;
const logger_1 = require("./logger");
const DEFAULT_CONFIG = {
    callTimeoutMs: 120000,
    maxRetries: 5,
    retryBaseMs: 2000,
    minContentLength: 1,
    emptyLoopThreshold: 3,
    maxToolCallsPerResponse: 0,
    repetitionThreshold: 0.3,
    maxSimilarConsecutive: 3,
    ngramSize: 4,
};
class SmartAdapter {
    raw;
    config;
    consecutiveEmpties = 0;
    recentResponses = [];
    consecutiveSimilar = 0;
    probeMode = false;
    setProbeMode(enabled) {
        this.probeMode = enabled;
        logger_1.logger.debug(`[SmartAdapter] 探针模式: ${enabled ? 'ON' : 'OFF'}`);
    }
    get model() { return this.raw.model; }
    constructor(rawAdapter, config) {
        this.raw = rawAdapter;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    async chat(messages) {
        const startTime = Date.now();
        let lastError = null;
        let localTimeouts = 0;
        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                const result = await this.callWithTimeout(messages);
                const msg = result.choices?.[0]?.message;
                if (msg && (!msg.content || msg.content.trim().length === 0) && msg.reasoning_content) {
                    msg.content = msg.reasoning_content;
                    delete msg.reasoning_content;
                    logger_1.logger.debug(`[SmartAdapter] ✓ reasoning_content → content`);
                }
                const content = msg?.content || msg?.reasoning_content || '';
                const toolCalls = msg?.tool_calls;
                const validToolCalls = this.filterValidToolCalls(toolCalls);
                if (validToolCalls.length > this.config.maxToolCallsPerResponse) {
                    logger_1.logger.warn(`[SmartAdapter] ⚠ tool_calls 超限，剥离`);
                    result.choices[0].message.tool_calls = undefined;
                }
                if (!content || content.trim().length < this.config.minContentLength) {
                    this.consecutiveEmpties++;
                    if (this.consecutiveEmpties >= this.config.emptyLoopThreshold) {
                        logger_1.logger.error(`[SmartAdapter] 🔴 连续 ${this.consecutiveEmpties} 次空响应 → 降级`);
                        return { choices: [{ message: { role: 'assistant', content: this.degradedFallback(messages[messages.length - 1]?.content || '') }, finish_reason: 'degraded' }] };
                    }
                    if (attempt < this.config.maxRetries) {
                        await this.sleep(this.config.retryBaseMs * Math.pow(2, attempt));
                        continue;
                    }
                    return { choices: [{ message: { role: 'assistant', content: this.degradedFallback(messages[messages.length - 1]?.content || '') }, finish_reason: 'degraded' }] };
                }
                if (this.probeMode) {
                    this.consecutiveEmpties = 0;
                    return result;
                }
                const repeatResult = this.checkRepetition(content);
                if (repeatResult.isRepeat) {
                    this.consecutiveSimilar++;
                    if (this.consecutiveSimilar >= this.config.maxSimilarConsecutive) {
                        logger_1.logger.error(`[SmartAdapter] 🔴 连续 ${this.consecutiveSimilar} 次重复 → 降级`);
                        this.consecutiveSimilar = 0;
                        return { choices: [{ message: { role: 'assistant', content: this.degradedFallback(messages[messages.length - 1]?.content || '') }, finish_reason: 'degraded' }] };
                    }
                    if (attempt < this.config.maxRetries) {
                        await this.sleep(this.config.retryBaseMs * Math.pow(2, attempt));
                        continue;
                    }
                    const deduped = repeatResult.deduped || content.slice(0, Math.floor(content.length / 2));
                    result.choices[0].message.content = deduped;
                }
                else {
                    this.consecutiveSimilar = 0;
                }
                this.consecutiveEmpties = 0;
                return result;
            }
            catch (err) {
                lastError = err;
                const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout') || err.message?.includes('abort');
                if (isTimeout) {
                    localTimeouts++;
                    if (localTimeouts >= this.config.emptyLoopThreshold) {
                        return { choices: [{ message: { role: 'assistant', content: '[系统] 模型服务暂时不可用，已自动降级。' }, finish_reason: 'degraded' }] };
                    }
                    if (attempt < this.config.maxRetries) {
                        await this.sleep(this.config.retryBaseMs * Math.pow(2, attempt));
                        continue;
                    }
                }
                else {
                    if (attempt < this.config.maxRetries) {
                        await this.sleep(this.config.retryBaseMs * Math.pow(2, attempt));
                        continue;
                    }
                }
            }
        }
        return { choices: [{ message: { role: 'assistant', content: `[系统] 模型调用失败 (${this.config.maxRetries + 1}次): ${lastError?.message?.slice(0, 80)}` }, finish_reason: 'error' }] };
    }
    async callWithTimeout(messages) {
        return new Promise(async (resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('TimeoutError')), this.config.callTimeoutMs);
            try {
                const result = await this.raw.chat(messages);
                clearTimeout(timer);
                resolve(result);
            }
            catch (err) {
                clearTimeout(timer);
                reject(err);
            }
        });
    }
    filterValidToolCalls(toolCalls) {
        if (!toolCalls || !Array.isArray(toolCalls))
            return [];
        return toolCalls.filter(tc => tc.function?.name && tc.function.name.length > 0);
    }
    degradedFallback(userInput) {
        const input = userInput.toLowerCase();
        if (input.startsWith('/'))
            return '';
        if (input.includes('天气') || input.includes('weather'))
            return '抱歉，当前无法获取实时天气数据。';
        if (input.includes('你好') || input.includes('hi') || input.includes('hello'))
            return '你好！当前 LLM 服务暂不可用。';
        if (input.length < 10)
            return '收到。当前模型服务正在恢复中，请稍候。';
        return `[降级响应] 已收到您的消息（${userInput.length}字）。当前模型服务暂不可用。`;
    }
    async ping() { return this.raw.ping(); }
    async listModels() { return this.raw.listModels(); }
    async getCurrentModel() { return this.raw.getCurrentModel(); }
    setModel(name) { this.raw.setModel(name); }
    setReasoning(level) { this.raw.setReasoning(level); }
    clearReasoning() { this.raw.clearReasoning(); }
    getReasoning() { return this.raw.getReasoning(); }
    get contextLength() { return this.raw.contextLength || 4096; }
    getEffectiveContextWindow() { return this.raw.getEffectiveContextWindow(); }
    markSessionReset() { this.raw.markSessionReset(); }
    isSessionReset() { return this.raw.isSessionReset(); }
    clearSessionReset() { this.raw.clearSessionReset(); }
    asChatFn() { return (messages) => this.chat(messages); }
    reset() { this.consecutiveEmpties = 0; this.consecutiveSimilar = 0; this.recentResponses = []; }
    async *chatStream(messages) {
        yield* this.raw.chatStream(messages);
    }
    checkRepetition(content) {
        if (!content || content.length < 20)
            return { isRepeat: false, reason: 'too short' };
        const ngrams = new Map();
        const text = content.toLowerCase().replace(/\s+/g, ' ');
        const n = this.config.ngramSize;
        for (let i = 0; i <= text.length - n; i++) {
            const gram = text.slice(i, i + n);
            ngrams.set(gram, (ngrams.get(gram) || 0) + 1);
        }
        const totalNgrams = ngrams.size;
        const possibleNgrams = Math.max(1, text.length - n + 1);
        const uniqueness = totalNgrams / possibleNgrams;
        if (uniqueness < this.config.repetitionThreshold && possibleNgrams > 10) {
            const seen = new Set();
            let deduped = '';
            for (let i = 0; i <= text.length - n; i++) {
                const gram = text.slice(i, i + n);
                if (!seen.has(gram)) {
                    deduped += text[i];
                    seen.add(gram);
                }
            }
            deduped += text.slice(text.length - n + 1);
            return { isRepeat: true, reason: `N-gram 唯一率 ${(uniqueness * 100).toFixed(0)}% < ${(this.config.repetitionThreshold * 100).toFixed(0)}%`, deduped: deduped.slice(0, Math.max(content.length / 2, 50)) };
        }
        const normalized = text.slice(0, 200).replace(/\s+/g, '');
        for (const prev of this.recentResponses) {
            const prevNorm = prev.slice(0, 200).replace(/\s+/g, '');
            if (normalized === prevNorm)
                return { isRepeat: true, reason: '与上次回复完全相同' };
            if (prevNorm.length > 20 && normalized.length > 20) {
                const overlap = [...normalized].filter(c => prevNorm.includes(c)).length;
                const similarity = overlap / Math.max(normalized.length, prevNorm.length);
                if (similarity > 0.85)
                    return { isRepeat: true, reason: `与上次回复相似度 ${(similarity * 100).toFixed(0)}%` };
            }
        }
        this.recentResponses.push(text.slice(0, 300));
        if (this.recentResponses.length > 10)
            this.recentResponses.shift();
        return { isRepeat: false, reason: 'ok' };
    }
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
exports.SmartAdapter = SmartAdapter;
//# sourceMappingURL=smart-adapter.js.map