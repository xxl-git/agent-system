"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
// packages/prompts/src/logger.ts — 本地日志模块（不依赖根项目）
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir))
    fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `prompts-${new Date().toISOString().slice(0, 10)}.log`);
class SimpleLogger {
    level = 'info';
    setLevel(level) {
        this.level = level;
    }
    shouldLog(level) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        return levels[level] >= levels[this.level];
    }
    write(level, msg) {
        if (!this.shouldLog(level))
            return;
        const timestamp = new Date().toISOString();
        const logMsg = `[${timestamp}] [${level.toUpperCase()}] ${msg}\n`;
        fs.appendFileSync(logFile, logMsg);
        if (level === 'error' || level === 'warn')
            console[level](msg);
    }
    info(msg) { this.write('info', msg); }
    warn(msg) { this.write('warn', msg); }
    error(msg) { this.write('error', msg); }
    debug(msg) { this.write('debug', msg); }
}
exports.logger = new SimpleLogger();
//# sourceMappingURL=logger.js.map