# Handler 模块激活集成 - 20260708

## 任务目标

将三个 Handler 模块（ChatHandler/CommandHandler/TaskHandler）从"死代码"状态激活为真正被调用的模块。MEMORY.md 记载的"Phase 1/2/3 重构完成"实际上 handler 类从未被实例化，agent-core.ts 直接内联实现 `handleChat`/`handleChatStream`/`handleTask`/`handleCommand`。

## 执行方案

采用**渐进式委托**策略：
1. Handler 类**完整实现**自己的 handle() 方法（从 agent-core 内联代码搬运 + 补全缺失依赖）
2. agent-core 的方法**最前面**添加 `if (this.xxxHandler) return this.xxxHandler.handle(...)`
3. 原有内联实现保留作为 fallback（handler 未初始化时使用）
4. 在 agent-core `init()` 末尾实例化三个 Handler

这样保证：
- ✅ Handler 被真正激活（不再是死代码）
- ✅ 所有现有功能保留（fallback 兜底）
- ✅ 风险最小
- ✅ 后续可逐步删除内联代码

## 关键修改

### ChatHandler (packages/core/src/core/agent/chat-handler.ts)
- 完整实现 `handle()` 和 `handleStream()` 方法
- 集成 assemblyReport 装配追踪（5 个 Stage：raw_input / context_compressed / injection_prepare / assembled / llm_payload）
- 集成 circuitBreaker 熔断器预检（避免向已知故障模型发请求）
- 集成 tracer 全链路追踪（chatSpanId）
- **修复 Bug F**：流式中断且已有部分内容时，补充 `emitChatDone(fullReply, partialDuration)`，前端才能正常切换状态
- 工厂函数 `createChatHandlerFromAgentCore(agent)` 从 agent-core 实例创建 ChatHandler

### TaskHandler (packages/core/src/core/agent/task-handler.ts)
- 完整实现 `handle(intent, rawMessage)` 方法
- 集成 tracer（taskSpanId）/ circuitBreaker（预检 + 成功/失败反馈）
- 集成 `isMultiAgentTask` 正则版（与 agent-core 内联版一致）
- 集成 `handleMultiAgentTask`（默认创建 frontend/backend/reviewer 三个 SubAgent）
- **修复 Bug I**：`orchestrator.execute(intent, rawMessage, taskId)` 补 taskId 参数
- 工厂函数 `createTaskHandlerFromAgentCore(agent)`

### CommandHandler (packages/core/src/core/agent/command-handler.ts)
- 添加 `/resume`、`/ckpt`、`/pause` 命令分发（委托给 agent-core 现有方法）
- 接口新增 `handleResume`、`handleCkpt`、`handlePause`、`stop` 四个委托方法
- 修改 `/exit` 直接调用 `stop()`（之前返回 'EXIT_REQUESTED' 由 agent-core 处理）
- 更新 `/help` 输出，包含全部命令
- 工厂函数 `createCommandHandlerFromAgentCore(agent)` 添加新 deps

### agent-core.ts
- 导入三个 Handler 类和工厂函数
- 添加 `chatHandler`/`commandHandler`/`taskHandler` 属性声明（使用 `!` definite assignment assertion）
- 在 `init()` 末尾（`return base;` 之前）实例化三个 Handler
- 在 `handleChat`/`handleChatStream`/`handleTask`/`handleCommand` 方法最前面添加委托调用：
  ```ts
  if (this.chatHandler) return this.chatHandler.handle(userInput);
  ```
- 原有内联实现保留作为 fallback

## 验证

- ✅ TypeScript 编译通过（`tsc -b packages/core --force` exit 0）
- ✅ 全套测试 29/29 ALL PASS
- ✅ Git commit `fb4989f`，已 push 到 main

## 文件变更

- modified: `packages/core/src/core/agent/agent-core.ts`（+18 行，添加导入/属性/实例化/委托）
- modified: `packages/core/src/core/agent/chat-handler.ts`（重写，20KB，完整实现）
- modified: `packages/core/src/core/agent/command-handler.ts`（+30 行，添加新命令和接口）
- modified: `packages/core/src/core/agent/task-handler.ts`（重写，10KB，完整实现）

提交统计：4 files changed, 372 insertions(+), 244 deletions(-)

## 后续工作

1. **清理 fallback 内联代码**：当前 agent-core 保留了约 540 行内联实现作为 fallback。验证 handler 稳定运行后，可以逐步删除这些内联代码，agent-core.ts 将大幅瘦身。
2. **将子命令方法搬到 CommandHandler**：当前 `/project`、`/models`、`/skills` 等子命令仍在 agent-core 内联实现，CommandHandler 通过 deps 委托调用。后续可搬到 CommandHandler。
3. **补充测试**：ChatHandler/TaskHandler 测试用的是 mock 的 handler 类（未覆盖新实现）。需要补充针对新 Handler 实现的集成测试。
