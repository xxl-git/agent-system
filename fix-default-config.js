// 修复 DEFAULT_CONFIG.agent 字段（补全缺失字段）
const fs = require('fs');
const p = 'D:/QClaw_Workspace/agent-system/src/config/agent-system-config.ts';
let c = fs.readFileSync(p, 'utf8');

// 找到 DEFAULT_CONFIG 中的 agent 字段并替换
const oldDefault = `    agent: {
      callTimeoutMs: 60000,
      maxRetries: 1,
      emptyLoopThreshold: 3,
    },`;
const newDefault = `    agent: {
      loopIntervalMs: 1000,
      heartbeatIntervalMs: 300000,
      maxSubTasks: 10,
      defaultTimeoutMs: 600000,
      callTimeoutMs: 300000,
      maxRetries: 5,
      emptyLoopThreshold: 3,
      debugLogging: false,
      skipIntentParsing: false,
    },`;

if (c.includes(oldDefault)) {
  c = c.replace(oldDefault, newDefault);
  fs.writeFileSync(p, c, 'utf8');
  console.log('✅ DEFAULT_CONFIG.agent 已更新（补全 9 个字段）');
} else {
  console.log('⚠️ 未找到旧 DEFAULT_CONFIG.agent，请手动检查');
}
