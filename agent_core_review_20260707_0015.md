# agent-core.ts 完整代码审查 — 2295 行核心模块

> 时间：2026-07-07 00:15
> 范围：packages/core/src/core/agent/agent-core.ts (2295行)
> 关联：core_module_review_20260706_2350.md（orchestrator + smart-adapter 审查）

## 审查范围
精读以下关键区域：
- 构造函数 (L103-186)：40+ 模块初始化
- init() (L197-331)：7 步初始化流水线
- sendMessage (L394-500)：消息路由主入口
- handleChat (L501-690)：非流式聊天 + 消息装配追踪
- handleChatStream (L780-930)：流式聊天 + 错误回退
- handleTask (L931-1015)：任务执行 + 检查点
- onHeartbeat (L2055-2085)：心跳巡检
- registerProactiveTasks (L2112+)：3 个空闲任务
- stop() (L2327+)：资源清理

## 审查发现

### ✅ 澄清：Bug G（绝对路径硬编码）已被之前修复
- 文件已使用 `getConfigSection('memory')` + `path.isAbsolute` 动态推导 MEMORY_DIR
- 之前 read 看到的是缓存内容，实际代码已正确

### 🔴 Bug E：_assemblyReport 跨消息污染（已修复）
- **位置**：handleChat L543
- **原代码**：`if (!this._assemblyReport) { this._assemblyReport = createAssemblyReport(...) }`
- **问题**：report 一旦创建后永不重置，每次新消息都追加 stage 到旧 report，导致 `raw_input` 只反映第一条消息，后续消息的装配追踪完全错乱
- **修复**：去掉 `if (!this._assemblyReport)` 守卫，每次 handleChat 都创建新 report（每条消息独立追踪）
- **影响**：消息装配追踪 UI 显示正确的每条消息流水线

### 🔴 Bug F：流式中断后前端状态条卡住（已修复）
- **位置**：handleChatStream L876
- **原代码**：流式中断且 `fullReply.length > 0` 时只 `emitChatError(...)`，没 emit `emitChatDone`
- **问题**：前端收到 chunks 后等不到 done 事件，状态条永远卡在"响应中"
- **修复**：改为 `emitChatDone(fullReply, partialDuration)`，前端正常切换状态。错误信息通过 logger 记录
- **影响**：流式中断场景前端 UI 正常恢复

### 🔴 Bug H：stop() 资源清理不完整（已修复）
- **位置**：stop() L2329
- **原代码**：只 `orchestrator.stopHeartbeat()` + summarizer + auditLog + dbStore
- **问题**：未停止 `nonsenseDetector.stopMonitor()`（10s 监控定时器）和 `healthMon.reset()`（token 流监控），进程残留时定时器继续空转
- **修复**：在 `stopHeartbeat()` 之后补充 `nonsenseDetector.stopMonitor()` + `healthMon.reset()`（try/catch 保护）
- **影响**：进程关闭时所有后台定时器正确停止

## 未修复但已记录的问题（非紧急）
1. **handleCommand 的 / 命令快速通道不走 recordInteraction** —— 设计使然（简单查询不需要写入记忆系统），但可能导致 `/help` 等命令的交互历史丢失。已在注释中明确标注。
2. **handleMultiAgentTask 硬编码 3 个 agent** —— `frontend/backend/reviewer` 固定。可改为根据任务类型动态选择 agent 组合，但当前覆盖大多数场景。
3. **extractEntities 用正则匹配** —— 对复杂实体（如中文公司名、人名）识别率有限。可后续接入 NER 模型。

## 验证
- ✅ `tsc -b packages/core --force` 编译通过（exit 0）
- ✅ 全套测试 29/29 通过（ALL PASS，8 套测试文件）
- ✅ commit `9d82f63`，push 成功 `d3bb06a..9d82f63 main -> main`

## 修复文件
- packages/core/src/core/agent/agent-core.ts（3 处修改，15 行新增 / 9 行删除）

## 总结
agent-core.ts 作为 2295 行的核心模块，整体架构清晰、错误处理完善（熔断器/health/审计/胡话检测齐全）。本次审查发现 3 个真实 bug（装配追踪污染、流式中断状态卡住、资源清理不完整），均已修复。审查中曾怀疑的第 4 个问题（绝对路径硬编码）经核实已被之前提交修复。
