# agent-core.ts 拆分重构报告

**日期**: 2026-07-17 ~ 2026-07-18
**Commits**: `3268ef9`, `6056fe1`
**目标**: 拆分 agent-core.ts（2476 行）以提高可维护性

## 重构成果

### 行数变化
- **原始**: 2476 行
- **最终**: 793 行
- **减少**: 1683 行（**-68.0%**）

### 提取的模块

| 模块文件 | 提取内容 | 节省行数 |
|---------|---------|---------|
| `entity-extractor.ts` | 实体提取纯函数 | 48 |
| `model-commands.ts` | scanModels + switchModel | 47 |
| `resume-command.ts` | handleResumeCommand | 127 |
| `agents-command.ts` | handleAgentsCommand | 101 |
| `summarize-command.ts` | handleSummarizeCommand | 48 |
| `checkpoint-commands.ts` | handleCkptCommand + handlePauseCommand | 78 |
| `info-commands.ts` | 8个查询命令 | 252 |
| `proactive-tasks.ts` | registerProactiveTasks | 169 |
| `send-message-core.ts` | sendMessage + sendMessageStream 公共逻辑 | 196 |
| `init-steps.ts` | init() 7 个步骤拆分 | 93 |
| **fallback 移除** | handleChat/handleChatStream/handleTask/handleCommand | 504 |

### 设计原则
1. **避免循环依赖**: 每个提取的模块定义最小接口（如 `ModelCommandAgent`、`InitAgent`），而非导入 `AgentCore` 类型
2. **委托模式**: agent-core.ts 中的方法保留为薄包装，委托给外部模块
3. **依赖注入**: 通过参数传递 `agent` 实例，而非使用 `this`
4. **类型安全**: 使用 `catch (err: unknown)` + `errorMessage()` 辅助函数
5. **Fallback 移除**: ChatHandler/CommandHandler/TaskHandler 在 init() 中始终初始化，fallback 代码永不执行

### 验证
- ✅ TypeScript 编译通过（`tsc -b` exit 0）
- ✅ 7/7 核心单元测试通过

### 剩余大方法（agent-core.ts 793行）
- `init` (60行) — 已精简
- `registerModelListHeartbeat` (51行) — 心跳任务
- `onHeartbeat` (31行) — 心跳处理
- 其他方法均 <30 行

### 后续待办
- 🟡 清理未使用的 import 语句
- 🟡 推送到 GitHub（当前凭证问题）
- 🟡 减少 288 处 `:any` 类型（P3）
- 🟡 提升测试覆盖率到 20%+（当前 17%）
