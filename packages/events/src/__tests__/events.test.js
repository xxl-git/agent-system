"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const logger_1 = require("../src/logger");
(0, node_test_1.test)('events: logger export exists', () => {
    strict_1.default.ok(logger_1.logger, 'logger should be exported');
});
(0, node_test_1.test)('events: logger has info method', () => {
    strict_1.default.equal(typeof logger_1.logger.info, 'function');
});
(0, node_test_1.test)('events: logger has warn method', () => {
    strict_1.default.equal(typeof logger_1.logger.warn, 'function');
});
//# sourceMappingURL=events.test.js.map