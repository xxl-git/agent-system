# 模型加载/卸载功能实现完成

**日期**: 2026-07-05
**任务**: 在 agent-system 中支持通过 UI 直接加载/卸载 LM Studio 中的模型

## 目标

用户希望在前端 UI 中点击未加载的模型时，能够直接通过 LM Studio REST API 加载该模型到内存，而不需要手动切换到 LM Studio 应用操作。加载完成后自动切换到该模型。

## 实现方案

### LM Studio REST API 调研

通过查阅 LM Studio 官方文档，确认两个关键端点：

- **加载**: `POST /api/v1/models/load`
  - 请求体: `{ model, context_length?, flash_attention?, eval_batch_size?, num_experts?, offload_kv_cache_to_gpu? }`
  - 响应: `{ type, instance_id, load_time_seconds, status }`
  - 超时设置: 120秒（大模型加载可能需要较长时间）

- **卸载**: `POST /api/v1/models/unload`
  - 请求体: `{ instance_id }`
  - 响应: `{ instance_id }`
  - 超时设置: 30秒

### 代码变更

1. **`packages/core/src/models/adapters/lmstudio.ts`** (+60 行)
   - 新增 `loadModel(modelKey, options)` 方法
   - 新增 `unloadModel(instanceId)` 方法
   - 使用 `this.v1BaseUrl` (即 `/api/v1`) 作为 REST API 端点

2. **`packages/core/src/core/smart-adapter.ts`** (+12 行)
   - 新增 `loadModel()` 和 `unloadModel()` 代理方法
   - 检测底层适配器是否支持，不支持时抛出明确错误

3. **`packages/llm/src/smart-adapter.ts`** (+12 行)
   - 同步添加相同的代理方法

4. **`packages/server/src/agent-server.ts`** (+95 行)
   - 新增 `POST /api/models/load` 端点
     - 支持参数: `model` (必填), `context_length`, `flash_attention`, `eval_batch_size`, `num_experts`
     - 优先使用 agent 实例的 `adapter.loadModel()`，回退到直接 fetch
   - 新增 `POST /api/models/unload` 端点
     - 支持参数: `instance_id` (必填)
     - 同样支持 agent 实例和回退两种模式

5. **`src/server/agent-server.ts`**
   - 从 packages/server 同步

6. **`agent-ui.html`** (+70 行)
   - 新增 `confirmLoadModel(modelId, contextLength, displayName)` 函数
     - 弹出确认对话框，显示模型信息和加载提示
   - 新增 `loadModelToMemory(modelId, contextLength)` 函数
     - 调用 `/api/models/load` API
     - 默认启用 `flash_attention: true`
     - 加载完成后自动调用 `selectModel()` 切换到该模型
     - 1秒后刷新模型列表
   - 新增 `unloadModelFromMemory(modelId)` 函数
     - 确认后调用 `/api/models/unload` API
     - 卸载后刷新模型列表
   - 修改 `renderModelDropdown()`:
     - 未加载模型从"不可点击 + toast 提示"改为"点击触发 `confirmLoadModel()`"
     - 移除 `opacity: 0.5` 样式（现在可交互）

## 验证结果

### API 测试

```
GET /api/models → totalCount: 23, loadedCount: 1 ✅

POST /api/models/load { model: "qwen/qwen3-1.7b", context_length: 8192, flash_attention: true }
→ Status: 200, { ok: true, instance_id: "qwen/qwen3-1.7b", load_time_seconds: 9.702, status: "loaded" } ✅

POST /api/models/unload { instance_id: "qwen/qwen3-1.7b" }
→ Status: 200, { ok: true, instance_id: "qwen/qwen3-1.7b" } ✅
```

### 编译验证

```
=== Building packages ===
events... OK    models-core... OK    tools... OK    prompts... OK
llm... OK       memory... OK         resilience... OK    skills... OK
experience... OK    core... OK       server... OK

=== Building root ===
root... OK

=== Verify ===
[OK] dist\server\agent-server.js (72747 bytes)
[OK] listModels() fix VERIFIED
=== DONE ===
```

## 用户交互流程

1. 用户点击模型下拉列表
2. 看到 23 个可用模型，其中 1 个已加载（绿色圆点）
3. 点击任意未加载模型
4. 弹出确认对话框：
   - 显示模型名称和上下文长度
   - 提示加载可能需要 10-60 秒
   - 加载完成后将自动切换
5. 确认后显示"⏳ 正在加载..."toast
6. 加载完成显示"✅ 模型已加载 (9.7s)"
7. 自动切换到新加载的模型
8. 刷新模型列表，显示 2 个已加载

## 关键决策

- **默认启用 `flash_attention: true`**：减少内存使用，提升生成速度
- **加载超时 120 秒**：大模型（如 35B）可能需要较长时间
- **卸载超时 30 秒**：卸载通常很快
- **自动切换**：加载完成后自动切换到该模型，提供无缝体验
- **回退机制**：API 端点支持 agent 未就绪时直接调用 LM Studio REST API
