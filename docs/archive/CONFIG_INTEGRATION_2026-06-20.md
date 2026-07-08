# Agent System v0.6.3 模块配置接入总结

> 时间：2026-06-20 15:04~15:17
> 目标：将剩余模块接入 v0.6.3 全局配置体系（agent-system.yaml）

## 接入的模块

| # | 模块 | 文件 | 接入字段 |
|---|------|------|---------|
| 1 | **init 顺序修复** | `agent-core.ts` | `initConfig()` 从 `init()` 移到 `constructor()` 最前面 |
| 2 | **CircuitBreaker** | `circuit-breaker.ts` | `failureThreshold`, `cooldownMs`(←`resetTimeoutMs`), `halfOpenMaxAttempts`(←`halfOpenMaxRequests`) |
| 3 | **CheckpointManager** | `checkpoint.ts` | `dataDir`, `contextWindow`, `maxRecoveryAttempts` |
| 4 | **BreakInMachine** | `break-in-machine.ts` | `probeConcurrency`(←`probes.concurrency`) |
| 5 | **ModelProfileStore** | `model-profile.ts` | `storeDir`(←`profiles.dataDir`) |
| 6 | **SessionDiagnostics** | `session-diagnostics.ts` | `maxPingFailures`(←`diagnostics.maxPingFailures`), 诊断任务 `cooldownMs` 和 `maxFails`(←`idleTasks`) |
| 7 | **agent-core Ping** | `agent-core.ts` | `cooldownMs`(←`idleTasks.defaultCooldownMs`), `maxFails`(←`idleTasks.defaultMaxFails`) |

## 配置展示增强

- `formatConfig()` 新增 circuitBreaker 的 `半开请求数` 和 `半开成功率` 字段

## Bug 修复

### 🔴 AgentCore 未导出
- **问题**：`dist/core/agent/agent-core.js` 末尾缺少 `exports.AgentCore = AgentCore`
- **影响**：服务器启动时报 `AgentCore is not a constructor`
- **修复**：`dist/agent-core.js` + `dist/agent-core.d.ts` + `src/agent-core.ts` 添加 export

### 🔴 Logger 导入方式错误
- **问题**：`dist/core/agent/agent-core.js` 使用 `__importStar(require("../../logger"))` 得到模块命名空间，但调用 `logger_1.info(...)` 时 `.info` 在命名空间上不存在
- **修复**：改为 `require("../../logger").logger` 直接获取 Logger 实例

## 验证结果

- ✅ 服务器启动成功 (79ms)
- ✅ `/config show` 显示所有 9 个模块配置
- ✅ 配置文件路径正确：`D:\QClaw_Workspace\agent-system\config\agent-system.yaml`
- ✅ 聊天链路正常工作

## 修改的文件

### src/ (6 files)
- `src/core/agent/agent-core.ts` — init 顺序 + idleTasks 配置 + AgentCore export
- `src/resilience/circuit-breaker.ts` — 从 config 读取
- `src/resilience/checkpoint.ts` — 从 config 读取
- `src/resilience/session-diagnostics.ts` — 从 config 读取
- `src/models/adaptation/break-in-machine.ts` — 从 config 读取
- `src/models/profile/model-profile.ts` — 从 config 读取

### dist/ (7 files)
- 同上 6 个 .js + `dist/core/agent/agent-core.d.ts`
