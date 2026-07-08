# Phase 4 重构：简化 agent-core.ts init() 方法

**文件**: `src/core/agent/agent-core.ts`
**日期**: 2026-06-25
**结果**: ✅ 完成

## 重构内容

将 `init()` 方法（约 155 行，7 个步骤）拆分为 10 个独立私有方法 + 简化后的主方法。

### 新增方法一览

| 方法名 | 行号 | 职责 |
|---|---|---|
| `initMemoryStore()` | 204 | Step 1 + 1a：初始化文件记忆存储 + 裁剪过期文件 |
| `initCheckpoint()` | 223 | Step 2：检查 pending 任务 + 清理过期检查点 |
| `initDatabase()` | 241 | Step 3：初始化数据库 |
| `initMemoryRecovery()` | 259 | Step 4：恢复跨会话记忆（返回 memoryBlock） |
| `initSummarizer()` | 274 | Step 5：初始化摘要引擎 |
| `initExperience()` | 294 | Step 5.5：初始化经验模块 |
| `initSystemMessage()` | 309 | Step 6：初始化 system message（接收 memoryBlock 参数） |
| `initModel()` | 323 | Step 7：模型上线探测 |
| `initHandlers()` | 332 | 初始化三个 handler（Phase 1/2/3） |
| `initDiagnostics()` | 342 | 启动会话诊断 + 胡话检测 + 韧性心跳 |

### 简化后的 init() 方法（约 40 行）

```typescript
async init() {
    logger.info('[Agent] ====== 初始化开始 ======');
    const initStart = Date.now();

    await this.initMemoryStore();      // Step 1
    await this.initCheckpoint();        // Step 2
    await this.initDatabase();          // Step 3
    const memoryBlock = await this.initMemoryRecovery();  // Step 4
    await this.initSummarizer();       // Step 5
    await this.initExperience();       // Step 5.5
    await this.initSystemMessage(memoryBlock);  // Step 6
    const onboardResult = await this.initModel();  // Step 7

    // 汇总 + 启动诊断/心跳 + 初始化 handler
    await this.initDiagnostics();
    await this.initHandlers();

    const totalTime = Date.now() - initStart;
    logger.info(`[Agent] ====== 初始化完成 (${totalTime}ms) ======`);
    return base;
}
```

### 关键设计决策

1. **数据流**：`initMemoryRecovery()` 返回 `memoryBlock` 字符串，通过参数传递给 `initSystemMessage()`，避免直接从 `lastMemoryInjection` 重复读取
2. **返回值类型**：`initMemoryRecovery()` 和 `initModel()` 返回具体值供调用方使用
3. **原有逻辑保持不变**：所有 try/catch、错误处理、日志输出与重构前完全一致
4. **顺序依赖**：`initDatabase()` → `initMemoryRecovery()` 严格保序（DB 必须在记忆恢复之前）

### 验证

- ✅ TypeScript `tsc --noEmit` 编译通过（无错误输出）
- ✅ 文件行数：1081 → 1127 行（+46 行，含方法注释和结构）
- ✅ 原有所有功能代码保留（注释化删除，待后续清理）
