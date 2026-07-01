"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentEventBus = exports.AgentEventBus = void 0;
// Agent Event Bus — extracted as independent package
const events_1 = require("events");
// ── Event Bus ──
class AgentEventBus extends events_1.EventEmitter {
    _status = 'idle';
    _startTime = 0;
    _step = 0;
    _totalSteps = 0;
    get status() { return this._status; }
    startSession(totalSteps = 3) {
        this._startTime = Date.now();
        this._step = 0;
        this._totalSteps = totalSteps;
        this._status = 'thinking';
        this._emit({ status: 'thinking', detail: '理解输入中...', progress: 0, step: 0, totalSteps });
    }
    stepDone(step, status, detail, extra) {
        this._step = step;
        this._status = status;
        const progress = this._totalSteps > 0 ? Math.round((step / this._totalSteps) * 100) : 0;
        this._emit({ status, detail, progress, step, totalSteps: this._totalSteps, elapsedMs: Date.now() - this._startTime, ...extra });
    }
    toolsExecuting(tools) {
        this._status = 'executing_tools';
        this._emit({ status: 'executing_tools', detail: `调用 ${tools.join(', ')}...`, toolCalls: tools, elapsedMs: Date.now() - this._startTime });
    }
    modelResponding(model) {
        this._status = 'model_responding';
        this._emit({ status: 'model_responding', detail: '模型思考中...', model, elapsedMs: Date.now() - this._startTime });
    }
    endSession(success, detail) {
        this._status = success ? 'done' : 'error';
        this._emit({ status: this._status, detail: detail || (success ? '完成' : '出错'), progress: 100, step: this._totalSteps, totalSteps: this._totalSteps, elapsedMs: Date.now() - this._startTime });
        setTimeout(() => {
            if (this._status === 'done' || this._status === 'error') {
                this._status = 'idle';
                this._emit({ status: 'idle', progress: 0, step: 0, totalSteps: 0 });
            }
        }, 2000);
    }
    _emit(data) {
        this.emit('status', data);
    }
    emitModelPayload(payload) {
        this.emit('model_payload', payload);
    }
    emitChatChunk(chunk) {
        this.emit('chat_chunk', chunk);
    }
    emitChatDone(fullReply, durationMs) {
        this.emit('chat_done', { fullReply, durationMs });
    }
    emitChatError(error) {
        this.emit('chat_error', error);
    }
}
exports.AgentEventBus = AgentEventBus;
// ── Singleton ──
exports.agentEventBus = new AgentEventBus();
//# sourceMappingURL=index.js.map