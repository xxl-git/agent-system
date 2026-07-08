# Handler 模块审查报告

**日期**: 2026-07-07 00:30  
**范围**: 三个 handler 模块（chat-handler.ts / command-handler.ts / task-handler.ts）  
**前提**: 这些文件目前是死代码（agent-core.ts 直接内联实现，未委托给 handlers）

## 关键发现：handlers 全部未集成

`ChatHandler`、`CommandHandler`、`TaskHandler` 三个类（318+861+187 行）从未被 agent-core.ts 引用。MEMORY.md 中记载的 "Phase 1/2/3 重构完成并集成" 实际上**集成步骤未执行**——handlers 只是创建了文件，agent-core 仍保留所有内联实现。

### 证据
- agent-core.ts 没有任何 `import { ChatHandler }` / `import { CommandHandler }` / `import { TaskHandler }` 语句
- agent-core.ts 仍直接内联 `handleChat()` / `handleChatStream()` / `handleCommand()` / `handleTask()` 方法（约 1200 行）
- 三个 handler 类的 `handle()` 方法从未被任何代码调用

### 后续决策点
- **方案 A**：真正集成 handlers（用 handler 类替换 agent-core 内联实现）—— 风险大，影响生产代码
- **方案 B**：删除 handler 文件，承认重构未完成，更新 MEMORY.md —— 风险小，但浪费已有工作

## 修复的 Bug

### Bug I (task-handler.ts L107) — 🔴 高
**问题**: `orchestrator.execute(intent, rawMessage)` 缺第三个参数 `taskId`  
**影响**: 检查点无法关联到任务 ID，`/resume` 命令不能恢复该任务  
**修复**: 补全 `taskId` 参数

### Bug L (command-handler.ts /memory reload) — 🟡 中
**问题**: `system` 消息的 base 文本硬编码为 `'You are an intelligent Agent assistant...'`，与 PromptRegistry 的 `agent.identity` 模板不一致  
**影响**: 如果用户修改了 identity 模板，`/memory reload` 后会丢失自定义内容  
**修复**: 
- 从 `this.deps.promptRegistry.get('agent.identity', ...)` 获取模板
- `CommandHandlerDependencies` 接口新增 `promptRegistry` 和 `getIdentityVars` 字段
- `createCommandHandlerFromAgentCore` 工厂函数补充对应赋值

### Bug M (command-handler.ts + agent-core.ts /context reset) — 🟡 中
**问题**: `/context reset` 只重置 `ctxManager`，未清理 `messages` 中的压缩摘要块  
**影响**: 重置后 `messages` 中仍残留 `[此前对话摘要]` / `[对话历史摘要]` / `[部分历史已截断]` / `[CONTEXT FROM PAST SESSIONS]` 块，下次压缩会基于错误状态工作  
**修复**: 同步过滤 `messages`，删除包含上述标记的 `role=user` 消息（保留 system 消息）

### Bug N (command-handler.ts /nonsense force) — 🔴 高
**问题**: `const sub = args.join(' ')` 后 `if (sub === 'force')` 永远不匹配（因为 sub 是 `'force 原因'`）  
**影响**: `/nonsense force` 命令完全失效  
**修复**: 改为 `args[0] === 'force'`，用 `args.slice(1).join(' ')` 作为原因

## 未修复的设计问题

### Bug J (task-handler.ts isMultiAgentTask) — 🟢 低
`task-handler.ts` 中的 `isMultiAgentTask` 用简单关键词匹配（`['同时', '并行', '分别', '多个', '团队', '协作', '分工']`），而 agent-core 中的版本用更精确的正则模式。死代码问题但版本不一致。**未修复**——如果将来集成 handlers，需要从 agent-core 同步实现。

### Bug K (command-handler.ts /exit) — 🟢 低
`/exit` 返回字符串 `'EXIT_REQUESTED'`，但 agent-core 内联版直接调用 `this.stop()` 然后返回 `'Goodbye!'`。设计不一致。**未修复**——如果将来集成 handlers，需要在 handler 中调用 stop 或在 agent 层检查返回值。

### agent-core 内联版 /nonsense force 同样有 Bug N
agent-core.ts 的内联 `/nonsense` 处理逻辑是：
```ts
const sub = args.slice(1).join(' ');
if (!sub) { /* 显示状态 */ }
if (sub === 'force') { ... }  // 同样的 bug
```
**未修复**——因为 agent-core.ts 的 /nonsense 内联实现已经存在此 bug，且本次审查重点是 handlers。如果用户希望修复生产代码中的这个 bug，需要单独处理 agent-core.ts 内联版。

## 验证结果
- ✅ `tsc -b packages/core --force` 编译通过
- ✅ 全套测试 29/29 ALL PASS
- ✅ Commit `a85064c` push 到 main

## 本次会话累计成果

### 两轮审查共修复 10 个 Bug
| # | Bug | 文件 | 严重性 |
|---|-----|------|--------|
| 1 | smart-adapter 版本号硬编码 v0.5.0 | smart-adapter.ts | 🟡 中 |
| 2 | agent-system-config 默认版本号硬编码 0.6.4 | agent-system-config.ts | 🟡 中 |
| 3 | orchestrator 重规划 findIndex 逻辑错误 | orchestrator.ts | 🔴 高 |
| 4 | assemblyReport 跨消息污染 | agent-core.ts | 🔴 高 |
| 5 | 流式中断未 emit ChatDone | agent-core.ts | 🔴 高 |
| 6 | stop() 未停 nonsenseDetector + healthMon | agent-core.ts | 🔴 高 |
| 7 | task-handler 缺 taskId 参数 | task-handler.ts | 🔴 高 |
| 8 | /memory reload 硬编码 system base | command-handler.ts | 🟡 中 |
| 9 | /context reset 未清理摘要块 | command-handler.ts + agent-core.ts | 🟡 中 |
| 10 | /nonsense force 永远不匹配 | command-handler.ts | 🔴 高 |

### 重要架构发现
- **handlers 全部是死代码**：MEMORY.md 声称的 "Phase 1/2/3 重构完成并集成" 实际未集成
- **测试文件数量纠错**：MEMORY.md 声称 106 个测试用例，实际是 29 个（8 个测试文件）
