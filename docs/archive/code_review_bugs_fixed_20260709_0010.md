# 代码审查与 Bug 修复报告 — 2026-07-09 00:00

## 本轮审查范围

延续前几轮的代码审查工作，本轮重点审查 **agent-server.ts** 中尚未覆盖的路由和配置写入逻辑。

## 发现并修复的 Bug

### Bug T（P0 严重）— POST /api/config 写入 JSON 但 initConfig 加载 YAML

**位置**：`src/server/agent-server.ts` L1044-1160

**问题**：
- POST /api/config 原本写入 `config/default.json`
- 但 `initConfig()` 只加载 `config/agent-system.yaml`（YAML 优先级高于 JSON）
- POST 修改后调用 `initConfig()` 会重新加载 YAML，**覆盖 JSON 中的所有修改**
- 导致通过 POST /api/config 修改的 `model`、`callTimeoutMs`、`maxRetries`、`maxTokens` 等配置**不会生效**

**附加问题**：
- YAML 文件中 `calltimeoutMs`（小写 t）与代码类型定义 `callTimeoutMs`（大写 T）不匹配
- YAML 大小写敏感，`calltimeoutMs` 键被忽略，使用默认值
- 原有的正则替换方式无法区分 `smartAdapter.callTimeoutMs` 和 `agent.callTimeoutMs`（两个同名键在不同 section）

**修复方案**：
1. 改为使用 `js-yaml` 的 `load`/`dump` 进行 YAML 读写（替代正则替换）
2. 添加 `setNested()` 辅助函数，精确设置嵌套路径的值
3. 修复 YAML 文件中 `calltimeoutMs` → `callTimeoutMs` 拼写
4. 所有配置修改（model、callTimeoutMs、maxRetries、maxTokens、debugLogging、logging、chatTimeoutMs）统一写入 YAML

**验证**：
- POST callTimeoutMs=999999 → GET 返回 999999 ✅
- POST model=qwen/qwen3.5-9b → GET 返回 qwen/qwen3.5-9b ✅
- 恢复配置后 YAML 文件内容正确 ✅
- 29/29 单元测试全部通过 ✅

**提交**：`1b86b68`（已推送 main）

## 发现但未修复的问题

### Bug U（P1 健壮性）— /api/chat 和 /api/chat/stream 缺少超时保护

**位置**：`src/server/agent-server.ts` L1179+ (chat)、L1219+ (chat/stream)

**问题**：
- `chatTimeoutMs` 配置存在但未在 /api/chat 和 /api/chat/stream 中使用
- 如果 LLM 长时间不响应（LM Studio 推理慢时常见），HTTP 请求会一直挂起
- 客户端无法主动中断，服务器资源被占用

**建议修复方案**：
- /api/chat：用 `Promise.race` 或 `AbortController` + `setTimeout(chatTimeoutMs)` 包装 `ag.sendMessage()`
- /api/chat/stream：在 SSE 循环中检查超时，超时后发送 `chat_error` 事件并关闭连接

**影响**：仅影响健壮性，正常情况下不影响功能（HTTP 客户端通常有自己的超时）

## 本轮测试结果

- TypeScript 编译：✅ 通过（`tsc -b --force`）
- 单元测试：✅ 29/29 ALL PASS
- API 验证：✅ POST /api/config 读写一致

## 累计修复统计

截至本轮，handler 集成 + 系列代码审查共修复 **9 个 Bug**：

| Bug | 位置 | 严重性 | 状态 |
|-----|------|--------|------|
| Bug E | chat-handler.ts _assemblyReport | P1 | ✅ 已修复 |
| Bug F | chat-handler.ts emitChatDone 双发 | P1 | ✅ 已修复 |
| Bug H | agent-core.ts stop() 资源泄漏 | P1 | ✅ 已修复 |
| Bug I | task-handler.ts orchestrator.execute 缺 taskId | P2 | ✅ 已修复 |
| Bug L | command-handler.ts /memory reload 硬编码 | P2 | ✅ 已修复 |
| Bug M | command-handler.ts /context reset 残留 | P2 | ✅ 已修复 |
| Bug N | command-handler.ts /nonsense force 匹配 | P2 | ✅ 已修复 |
| Bug O | chat-handler.ts _cachedMemoryBlock 快照 | P1 | ✅ 已修复 |
| Bug P | chat-handler.ts emitChatDone 双发（流式） | P1 | ✅ 已修复 |
| **Bug T** | **agent-server.ts POST /api/config 写错文件** | **P0** | **✅ 本轮修复** |

## 文件修改清单（本轮）

- `src/server/agent-server.ts`：POST /api/config 改为 YAML 读写，添加 js-yaml 导入
- `config/agent-system.yaml`：修复 `calltimeoutMs` → `callTimeoutMs` 拼写

## 下一步建议

1. **修复 Bug U**：为 /api/chat 和 /api/chat/stream 添加 chatTimeoutMs 超时保护
2. **继续审查**：剩余未审查的 server 路由（/api/sessions、/api/upload、/api/models/switch 等）
3. **前端审查**：agent-ui.html 中的 SSE 处理、状态管理、错误恢复逻辑
4. **集成测试**：启动完整服务进行端到端功能测试
