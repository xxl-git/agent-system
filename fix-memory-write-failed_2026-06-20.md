# Fix: memory write failed 根因分析与修复

## 目标
修复 agent-core.ts 每次 `recordInteraction()` 报 `[WARN] [Agent] memory write failed {}` 的问题。

## 根因分析

**FileMemoryStore 从未被初始化。** 追溯链路：

1. `file-store.ts` 定义了两个函数：
   - `initMemoryStore(dir)` — 创建并赋值全局 `store`
   - `getMemoryStore()` — 断言 `store` 非 null，否则 throw `'Memory store 未初始化'`

2. **没有任何代码调用过 `initMemoryStore()`**。`getMemoryStore()` 在 `file-store.ts` 中只能搜索到 `export function getMemoryStore` 这一处定义，`initMemoryStore` 同样只有定义没有调用。

3. 调用链路：
   - `agent-core.ts` → `recordInteraction()` → `getMemoryStore().append(...)` → throw → caught → `logger.warn('[Agent] memory write failed', err)`
   - `session-recovery.ts` → `recover()` → `getMemoryStore()` → throw → caught → `logger.warn('[Recovery] File memory load failed', err)`

4. **初始化顺序问题**：旧 init() 顺序是：
   ```
   恢复记忆 → 摘要引擎 → system message → 数据库 → 模型探测
   ```
   恢复记忆在数据库之前执行，此时的 DB 也未初始化，`SessionRecoverer` 从 DB 读取决策/实体也全部失败。

## 修复内容

### 1. `agent-core.ts` init() 重构

**导入**：增加 `import { initMemoryStore } from ...` 和 `import * as path from 'path'`

**新初始化顺序（6步）**：
```
Step 1: initMemoryStore(path.join(process.cwd(), 'memory'))  ← 新增，确保 recordInteraction 可用
Step 2: 初始化数据库（DB init + startSession）               ← 从 Step 4 提前
Step 3: 恢复跨会话记忆（此时 DB 和文件层均已就绪）           ← 从 Step 1 推迟
Step 4: 初始化摘要引擎（含 LLM chatFn）                       ← 整合原 Step 2
Step 5: 初始化 system message（含 memory block 注入）
Step 6: 模型上线探测
```

### 2. `dist/core/agent/agent-core.js` 同步修改

- 添加 `const path_1 = require("path");`
- 完整替换 init() 方法

### 3. 文档更新
- `HANDOVER.md`：追加修复记录章节
- `LESSONS_LEARNED.md`：追加「5.1 singleton 模式的隐式依赖」教训

## 验证方法

1. 杀掉旧服务器（Ctrl+C）
2. 重启：`node dist\server\agent-server.js`
3. 发一条消息：`curl -X POST http://127.0.0.1:19701/api/chat ...`
4. 检查日志，确认不再有 `memory write failed` 警告
5. 检查 `memory/2026-06-20.md` 文件，确认有新写入内容

## 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/core/agent/agent-core.ts` | 重构 | import + init 顺序重排 + initMemoryStore 调用 |
| `dist/core/agent/agent-core.js` | 同步 | dist 编译产物对应修改 |
| `HANDOVER.md` | 追加 | 修复记录章节 |
| `LESSONS_LEARNED.md` | 追加 | singleton 初始化教训 |
