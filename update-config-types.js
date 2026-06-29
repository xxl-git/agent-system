// 更新 agent-system-config.ts 添加 skipIntentParsing 字段
const fs = require('fs');
const p = 'D:/QClaw_Workspace/agent-system/src/config/agent-system-config.ts';
let c = fs.readFileSync(p, 'utf8');

// 1. 在 agent 接口中添加 skipIntentParsing: boolean
const oldInterface = '  agent: {\n    callTimeoutMs: number;\n    maxRetries: number;\n    emptyLoopThreshold: number;\n  };';
const newInterface = '  agent: {\n    loopIntervalMs: number;\n    heartbeatIntervalMs: number;\n    maxSubTasks: number;\n    defaultTimeoutMs: number;\n    callTimeoutMs: number;\n    maxRetries: number;\n    emptyLoopThreshold: number;\n    debugLogging: boolean;\n    skipIntentParsing: boolean;\n  };';
c = c.replace(oldInterface, newInterface);

// 2. 在 DEFAULT_CONFIG 中添加默认值
const oldDefault = '    agent: {\n      callTimeoutMs: 60000,\n      maxRetries: 1,\n      emptyLoopThreshold: 3,\n    },';
const newDefault = '    agent: {\n      loopIntervalMs: 1000,\n      heartbeatIntervalMs: 300000,\n      maxSubTasks: 10,\n      defaultTimeoutMs: 600000,\n      callTimeoutMs: 300000,\n      maxRetries: 5,\n      emptyLoopThreshold: 3,\n      debugLogging: false,\n      skipIntentParsing: false,\n    },';
c = c.replace(oldDefault, newDefault);

fs.writeFileSync(p, c, 'utf8');
console.log('✅ agent-system-config.ts 已更新 (skipIntentParsing 字段已添加)');
