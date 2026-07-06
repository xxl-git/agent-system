# Bug 修复：/api/models/scan 仅返回已加载模型

**日期**：2026-07-06
**提交**：`2c6a3c6`（已推送 main）
**状态**：✅ 已修复并验证

## 现象
用户在 Agent UI 中点击「刷新模型列表」后，模型下拉列表只剩 1 个已加载模型，
之前正常显示的 23 个本地模型全部消失。

## 排查过程
1. 对比两个端点：
   - `GET /api/models` → 返回 23 个（正确）
   - `POST /api/models/scan` → 返回 1 个（错误）
2. 在 scan 路由注入诊断字段 `_debug`，发现：`_debug.reason = "agent/agentReady not ready"`
   → 说明请求到达时 `agent && agentReady` 为 false，scan 走了**回退逻辑**。
3. 对比两个路由的回退逻辑：
   - GET 路由回退：调用 REST `/api/v1/models`（返回全部模型 + 加载状态）→ 23 个 ✅
   - scan 路由回退：调用 OpenAI `/v1/models`（**仅返回已加载模型**）→ 1 个 ❌
4. 根因确认：scan 路由回退端点选错，导致 agent 未就绪时只返回已加载模型。

## 根因
`agent && agentReady` 在服务器启动初期为 false（Agent 初始化含 7 个能力探针探测，
每个探针需等待 35b 模型响应，耗时数分钟）。
此时 GET 路由走正确回退（REST，23 个），scan 路由走错误回退（OpenAI，1 个），
两者行为不一致 → 刷新后模型列表"丢模型"。

## 修复
重写 scan 路由（`packages/server/src/agent-server.ts`）：
- 当 `agent && agentReady` 为真 → 优先用 `agent.adapter.listAllModels()`（合并双端点，最佳）
- 当未就绪或 `listAllModels()` 失败 → 回退逻辑改为与 GET 路由一致：
  调用 REST `/api/v1/models` 获取全部模型，并用 OpenAI `/v1/models` 的 loadedIds 双源校验标记 `loaded`
- 移除调试用 `_debug` 字段

## 验证
服务器启动后（agent 仍在初始化、agentReady=false 时）：
- `GET /api/models`：total=23, loaded=1 ✅
- `POST /api/models/scan`：total=23, loaded=1 ✅
- 已加载模型 `qwen/qwen3.6-35b-a3b` 在两个端点均标记 `loaded: true` ✅

两端点行为现已完全一致。

## 涉及文件
- `packages/server/src/agent-server.ts`（scan 路由重写）
- `src/server/agent-server.ts`（同步）
