"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
// Local logger for llm package
const log = (level, msg, ...args) => {
    const prefix = `[llm:${level}]`;
    const formatted = args.length ? `${msg} ${JSON.stringify(args)}` : msg;
    if (typeof console !== 'undefined') {
        console[level === 'debug' ? 'log' : level]?.(`${prefix} ${formatted}`);
    }
};
exports.logger = {
    debug: (msg, ...a) => log('debug', msg, ...a),
    info: (msg, ...a) => log('info', msg, ...a),
    warn: (msg, ...a) => log('warn', msg, ...a),
    error: (msg, ...a) => log('error', msg, ...a),
};
//# sourceMappingURL=logger.js.map