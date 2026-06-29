# P0 Bug 修复验证报告 (2026-06-24)

## Bug 描述
`ContextManager` 压缩上下文后，将摘要注入为 `role: 'system'`。但 `PromptAssembler.assemble()` Step 3 会过滤掉所有 `role === 'system'` 的消息（因为 Step 1 已加 System Identity）。**结果：压缩摘要被静默丢弃，上下文压缩等于白做。**

## 修复内容
**文件**：`src/core/context-manager.ts`（3 处）

| 位置 | 原 role | 修复后 role | 说明 |
|--------|----------|--------------|------|
| 第 486 行 | `system` | `user` | `[对话历史摘要]` 块（超预算情况） |
| 第 509 行 | `system` | `user` | `summaryBlock` 定义（`[此前对话摘要]`，正常情况） |
| 第 556 行 | `system` | `user` | `[部分历史已截断]` 块（简单截断，加了提示语） |

## 代码验证
✅ 所有 3 处修复已通过 `Select-String` 确认，编译后 `dist/core/context-manager.js` 中包含正确的 `role: 'user'`。

## 运行时验证状态
⚠️ **未能完成完整的运行时验证**，原因：
- LM Studio 模型 `qwen3.6-35b-a3b-mtp` 不响应推理请求（超时）
- 无法触发完整的聊天流程来观察压缩摘要是否传递到 LLM

## 逻辑验证
修复逻辑正确：
1. `role: 'user'` 的消息不会被 `PromptAssembler.assemble()` Step 3 过滤
2. 与 `memoryBlock`、`experienceBlock` 的注入模式一致（也是 `role: 'user'`）
3. 摘要本质上是"历史背景信息"，作为 user 消息注入比 system 更合适

## 下一步
1. **修复 LM Studio 连接**：让模型正常响应，然后触发压缩测试
2. **添加单元测试**：直接调用 `ContextManager.process()` 验证输出 role
3. **端到端测试**：触发压缩，检查 LLM 收到的 prompt 中包含 `[此前对话摘要]`

## 临时文件
- `test_p0_fix.ts` — 验证脚本（可删除）
- `add_debug_log.py` — 调试日志注入脚本（可删除）
