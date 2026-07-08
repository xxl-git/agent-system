# 记忆系统审查报告 2026-06-20

## 审查范围
`src/memory/` 下 4 个模块 + `agent-core.ts` 中记忆相关代码

## 发现 9 个问题，全部修复 ✅

### 🔴 Bug 1: `endSession()` 每次 +1 而非设最终值
**位置**: `src/memory/db-store.ts` endSession()  
**问题**: `message_count = message_count + 1` 每次调用 +1，而非存真实消息数  
**修复**: 改为接受可选 `messageCount` 参数，设最终值。`stop()` 中传入 `this.messages.length`

### 🔴 Bug 2: `recordInteraction()` 只存前 200 字
**位置**: `src/core/agent/agent-core.ts` recordInteraction()  
**问题**: `input.slice(0, 200) + output.slice(0, 200)` 丢失 90% 上下文  
**修复**: 改为输入 500 字 + 输出 1000 字（加省略号标记截断）

### 🟡 Bug 3: `session-recovery.ts` 绕过 FileMemoryStore API
**位置**: `src/memory/session-recovery.ts` loadRecentFileMemory()  
**问题**: 直接 `readdirSync`/`readFileSync` 绕过 FileMemoryStore，重复实现逻辑  
**修复**: 调用 `memStore.readToday()` 读取当天内容 + 减去已经读过的今天再读历史文件

### 🟡 Bug 4: `queryDecisions` sessionId 匹配到 `project` 字段
**位置**: `src/memory/db-store.ts` queryDecisions()  
**问题**: 传 `sessionId` 却查 `WHERE project = ?`，语义完全错误  
**修复**:
- 建表时新增 `session_id TEXT DEFAULT ''` 列
- 新增 `idx_decisions_session` 索引
- 查询时把 `sessionId` 同时匹配 `session_id` 和 `project`（向后兼容旧库）
- 新增 `try { ALTER TABLE DECISIONS ADD COLUMN session_id }` 兼容旧库迁移

### 🟡 Bug 5: 文件记忆无限增长无旋转
**位置**: `src/memory/file-store.ts`  
**问题**: 文件记忆追加永不清理，磁盘无限膨胀  
**修复**: 新增 `prune(maxAgeDays)` 方法，默认保留 30 天。agent-core init Step 1a 自动裁剪

### 🟢 Bug 6: `retrieval/` 空目录
**位置**: `src/memory/retrieval/`  
**问题**: 空目录无内容但路径存在  
**修复**: 已删除空目录

### 🟢 Bug 7: `summarizer.ts` LLM 失败无限递归
**位置**: `src/memory/summarizer.ts` llmSummarize()  
**问题**: LLM 失败时 `return this.summarizeSession()` → 再次调用 `llmSummarize()` → 无限递归  
**修复**:
- 添加 `attempt` 参数（默认 0，重试 +1）
- 达到 2 次后调用 `ruleEngineSummarize()`（纯规则引擎，不走 summarizeSession 避免 LLM）
- 从 `summarizeSession()` 中提取 `ruleEngineSummarize()` 为独立方法

### 🟢 Bug 8: `storeSummary` 冗余别名
**位置**: `src/memory/db-store.ts`  
**问题**: `storeSummary()` 与 `addSummary()` 完全相同的功能  
**修复**: 删除 `storeSummary()`，summarizer 改为直接调用 `addSummary()`

### 🟢 Bug 9: `file-store.ts search()` 只返回文件名无匹配内容
**位置**: `src/memory/file-store.ts` search()  
**问题**: 返回 `string[]`（仅文件名），对下游几乎无用  
**修复**: 返回 `Array<{file: string; lines: string[]}>` — 含文件名 + 匹配行片段（前后各 1 行上下文）

## 新功能/增强
1. `FileMemoryStore.getStats()` — 统计文件数/总大小/最旧文件
2. `FileMemoryStore.prune()` — 裁剪过期文件记忆（默认保留 30 天）
3. Agent init Step 1a — 启动时自动裁剪旧文件记忆
4. `/memory status` 增强 — 显示文件存储统计（文件数/大小）+ DB 各表条目数

## 受影响的文件
| 文件 | 变更 |
|------|------|
| `src/memory/db-store.ts` | endSession 参数、queryDecisions 支持 session_id、建表加列、删 storeSummary |
| `src/memory/file-store.ts` | search 返回结构体、新增 getStats/prune |
| `src/memory/session-recovery.ts` | loadRecentFileMemory 用 FileMemoryStore API、导入 FileMemoryStore 类型 |
| `src/memory/summarizer.ts` | 防递归 attempt 机制、抽 ruleEngineSummarize 方法、storeSummary→addSummary |
| `src/core/agent/agent-core.ts` | recordInteraction 保存更多、stop 传 messageCount、init 加 prune、memory status 加统计 |
