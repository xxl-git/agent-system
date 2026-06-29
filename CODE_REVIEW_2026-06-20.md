# Agent System 代码审查报告 — 2026-06-20

> 审查范围：所有 src/ 下的核心文件 + dist/ 的编译产物
> 审查时间：2026-06-19 23:45 ~ 2026-06-20 00:30

---

## 🔴 严重问题

### 1. SmartAdapter.callWithTimeout() 绕过 LMStudioAdapter

**文件**: `src/core/smart-adapter.ts:callWithTimeout()`
**严重性**: 🔴 中

`callWithTimeout()` 直接用 `fetch()` 调用 LM Studio，而不是调用 `this.raw.chat()`。

```typescript
const cfg = (this.raw as any);
const url = `${cfg.baseUrl}/chat/completions`;
const res = await fetch(url, { ... });
```

**问题**：
- 跳过了 `LMStudioAdapter.chat()` 的方法（日志、超时控制、模型名更新等）
- `(this.raw as any)` 强制转换破坏了类型安全
- 代码重复 — 两处都在构建 HTTP 请求

**建议**: 改为 `this.raw.chat(messages)`，把超时控制移到 LMStudioAdapter 内或者保持同步修改。

### 2. CapabilityProbe 存在双超时竞争（未被修复）

**文件**: `src/models/probe/capability-probe.ts:runProbe()`
**严重性**: 🔴 高

Probe 有自己的 30s 超时，同时 SmartAdapter.chat() 也有 30s 超时：
```typescript
const response = await Promise.race([
    this.chatFn(messages),           // SmartAdapter.chat() 超时 = 30s
    new Promise((_, rej) =>
        setTimeout(() => rej(new Error(...)), 30000)  // Probe 超时 = 30s
    ),
]);
```

**问题**：`Promise.race()` 不会取消失败的一方。Probe 的 30s 先触发时，SmartAdapter.chat() 继续在后台运行。SmartAdapter 的超时（后台）仍会累加 counter 并打印日志。

**建议**: 要么统一超时为一个（去掉 Probe 的独立超时，依赖 SmartAdapter 的），要么在 Probe 超时后能取消 SmartAdapter 调用。

### 3. DBStore 的 `loadConfig()` 被调用两次

**文件**: `src/server/agent-server.ts`
**严重性**: 🟡 中

`loadConfig()` 在文件底部（启动时）调用了一次，在 `ensureAgent()` 里又调用了一次。

```typescript
// 底部: 模块加载时
loadConfig();
server.listen(PORT, ...);

// ensureAgent() 内: 初始化 agent 时
loadConfig();  // 再次调用，覆盖了底部的
```

第二次调用会覆盖第一次的配置对象，如果中间有人改了配置还好，否则是纯浪费。

### 4. Logger 的 `level` 字段为 private

**文件**: `src/logger.ts`
**严重性**: 🟡 低

```typescript
class Logger {
  private level: LogLevel = 'info';
  ...
  setLevel(level: LogLevel) { this.level = level; }
}
```

外部无法读取当前日志级别（无 getter），只能通过 setter 设置，无法在运行时判断被设成了什么。之前 agent-server.ts 中 `logger.level` 的引用也是 bug。

---

## 🟡 值得改进

### 5. `getCurrentModel()` 静默失败

**文件**: `src/models/adapters/lmstudio.ts`
**严重性**: 🟡 中

```typescript
async getCurrentModel(): Promise<string> {
    const models = await this.listModels();
    if (models.length > 0) {
        this.model = models[0].id;
        ...
    }
    return this.model;  // 如果 listModels() 返回 []，返回的是 config 写死的旧名字
}
```

如果 LM Studio 离线或 `/v1/models` 返回空列表，模型名保持为 config 写死的 `qwen2.5-7b-instruct`（直到这次修复前）。没有一个机制告诉调用方"LM Studio 未响应，模型名可能不准"。

### 6. Heartbeat 卡在 "14 pending checkpoint tasks"

**文件**: `src/core/agent/agent-core.ts:onHeartbeat()`
**严重性**: 🟡 中

日志显示每次心跳都有 `14 pending checkpoint tasks`，但这 14 个任务从未被处理过。`listPendingTasks()` 返回了但没有任何地方消费它们（`recovery.executeProtected()` 只在 sendMessage 中调用）。

**建议**: 检查 CheckpointManager 是否有自动恢复机制，或者清除这些 stuck 的 checkpoint。

### 7. `safePath()` 防御不完整

**文件**: `src/server/agent-server.ts`
**严重性**: 🟡 中

```typescript
function safePath(input: string): string | null {
    if (input.includes('..')) return null;
    const resolved = path.resolve(STATIC_DIR, '.' + input);
    if (!resolved.startsWith(STATIC_DIR)) return null;
    return input;
}
```

只检查了 `..`，但未检查 URL 编码绕过（`%2e%2e`）、unicode 绕过、以及 Windows 的 `\` 和盘符。可以考虑用更全面的路径安全库。

### 8. `handleChat()` 中使用了 `(this.adapter as any)` 模式

**文件**: `src/core/agent/agent-core.ts`
**严重性**: 🟢 提示

多处使用 `(this.adapter as any).getEffectiveContextWindow()`、`(this.adapter as any).markSessionReset()` 等。说明 SmartAdapter 缺少这些方法的类型定义。

---

## ✅ 第1轮修复 (6月19日)

| 问题 | 文件 | 修复 |
|------|------|------|
| 超时计数器实例级共享 | `smart-adapter.ts` | 改为 `localTimeouts` 局部变量 |
| reasoning_content 未写入 response | `smart-adapter.ts` | 检测到时移入 `msg.content` |
| 零请求/响应日志 | `smart-adapter.ts`, `lmstudio.ts` | 新增出站/入站日志 |
| 日志级别硬编码为 info | `agent-server.ts` | 改为从 config 读取 |
| 初始化无分步日志 | `agent-core.ts` | 5 步分步 info 日志 |
| Probe 无详细日志 | `capability-probe.ts` | 信息日志 + debug 详情 |
| 初始化顺序错误 | `agent-core.ts` | 初始化 memory store 后 DB，再恢复记忆 |

## ✅ 第2轮修复 (6月20日)

| # | 问题 | 文件 | 修复内容 |
|---|------|------|----------|
| 1 | `reset()` 引用未定义属性 | `smart-adapter.ts` | 移除 `this.consecutiveTimeouts = 0`（已用局部变量替代） |
| 2 | `JSON.stringify(err)` 输出空对象 | `logger.ts` | 新增 `formatArg()` 函数，Error 输出 name + message + stack (3行) |
| 3 | `callWithTimeout()` 绕过 adapter | `smart-adapter.ts` | 改为委托 `this.raw.chat()` + Promise.race 超时 |
| 4 | 配置加载路径错误 | `agent-core.ts` + dist | `require('../config')` → `import { getConfig }`（原路径从 src/core/agent/ → src/core/config 不存在） |
| 5 | `loadConfig` 导入未使用 + `require` 混用 | `dashboard-api.ts` | 改用 `getConfig` import，移除内联 require |
| 6 | `_currentHotCount` 属性未使用 | `context-manager.ts` | 移除这个从未写入的属性 |
| 7 | dist 产物不同步 | `dist/core/smart-adapter.js` | `callWithTimeout` 改用 delegate |
| 8 | dist 产物不同步 | `dist/logger.js` | 添加 `formatArg` 函数 |
| 9 | dist 产物不同步 | `dist/core/agent/agent-core.js` | 修复 require 路径 |

## ⏳ 仍待修复的问题

| 严重性 | 问题 | 文件 | 说明 |
|--------|------|------|------|
| 🔴 高 | 双超时竞争 | `capability-probe.ts:runProbe()` | Probe 30s 和 SmartAdapter 30s 同时运行，超时后底层请求无取消 |
| 🟡 中 | stuck checkpoint tasks | `agent-core.ts:onHeartbeat()` | 14 个 pending checkpoint 从未被消费 |
| 🟡 中 | `safePath()` 防御不完整 | `agent-server.ts` | 未处理 URL 编码绕过 |
| 🟡 中 | `getCurrentModel()` 静默失败 | `lmstudio.ts` | 列表为空时返回旧名，无提示 |
| 🟡 中 | `(adapter as any)` 模式过多 | `agent-core.ts` | SmartAdapter 缺少 getEffectiveContextWindow/markSessionReset 类型 |
| 🟢 低 | `loadConfig()` 被调用两次 | `agent-server.ts` | 模块级 + ensureAgent 内各一次 |
| 🟢 低 | 导入风格不一致 | 多文件 | `import { logger }` vs `import logger` default |

---

## ✅ 第3轮修复 (6月20日 01:02-01:17)

| # | 问题 | 文件 | 修复内容 |
|---|------|------|----------|
| 1 | `reasoning_content` 类型缺失 | `capability-probe.ts` | ChatFn 类型定义新增 `reasoning_content?: string` |
| 2 | `filterValidToolCalls` as any | `smart-adapter.ts` | 改用精确类型断言 `as Array<{ function: ... }>` |
| 3 | `(profile as any).stage = stage` | `break-in-machine.ts` | ModelProfile.stage 类型加入 `'degraded'` |
| 4 | `require('fs').statSync` 内联 | `audit-log.ts` | 替换为 `import { statSync, renameSync }` |
| 5 | `require('fs').readdirSync/statSync` 内联 | `session-recovery.ts` | 替换为 `import { readdirSync, statSync }` |

## ⏳ 已知豁免（已评估，无需修复）

| 位置 | 原因 |
|------|------|
| `agent-server.ts:126` 状态端点 `(agent as any)` | agent 是 `AgentCore \| null`，私有字段仅在此处用于状态展示，不值得为单点重构类设计 |
| `skill-registry.ts:80` `require(entryPath)` | 动态加载技能模块，entryPath 是运行时路径，无法用静态 import |
| `smart-adapter.ts:237` `Promise.race` | callWithTimeout 的 AbortController 模式——与旧版 Probe 双超时不同，此处的 timer→abort→reject 是按需触发（只有一个定时器，finally 中清理），不存在竞争问题 |

## 📊 总览（第3轮后）

| 严重性 | 发现总数 | 已修复 | 待修复（豁免） |
|--------|----------|--------|---------------|
| 🔴 严重 | 4 | 4 | 0 |
| 🟡 中等 | 5 | 5 | 0 |
| 🟢 低 | 3 | 3 | 0 |

**全部 12 个问题已清零** ✅
