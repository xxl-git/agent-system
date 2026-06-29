# Checkpoint 自动恢复修复方案

## 问题描述

根据 HANDOVER.md 遗留问题：**14 个 pending checkpoint 任务未消费**（P1 优先级）。

根据代码分析（`src/core/agent/agent-core.ts` 的 `init()` 方法）：

1. **Step 2** 调用 `this.checkpointMgr.clearAll()` **清空所有旧检查点**
2. **但是**，根据 `src/resilience/checkpoint.ts` 的设计文档，系统应该支持自动恢复
3. **所以**，Step 2 的逻辑可能导致 pending tasks 永远无法恢复

## 根因分析

`init()` 方法当前的逻辑：
```typescript
// Step 2: 清理旧会话检查点（上一轮会话的检查点已过期）
try {
    this.checkpointMgr.clearAll();
}
catch (err) {
    logger.warn('[Agent] 检查点清理失败', err);
}
```

**问题**：
1. `clearAll()` 会删除所有检查点文件（不管是否 pending）
2. 系统在心跳时只是记录日志（`logger.info('[Heartbeat] ' + pending.length + ' pending checkpoint tasks')`），没有自动恢复
3. **所以**，pending checkpoint 永远不会被消费

## 修复方案

**目标**：在清空检查点之前，先尝试恢复 pending tasks。

**修改内容**（`src/core/agent/agent-core.ts` 的 `init()` 方法）：

### Step 2 (修改后的逻辑):

```typescript
// Step 2: 恢复未完成的任务（从上次检查点），然后清理过期检查点
try {
    // 2.1: 列出所有 pending tasks
    const pendingTasks = this.checkpointMgr.listPendingTasks();
    if (pendingTasks.length > 0) {
        logger.info(`[Agent] 发现 ${pendingTasks.length} 个 pending 任务，尝试恢复...`);
        
        // 2.2: 对每个 pending task，尝试恢复
        for (const taskId of pendingTasks) {
            const result = this.checkpointMgr.resume(taskId);
            if (!result) {
                logger.warn(`[Agent] 无法加载检查点: ${taskId}`);
                continue;
            }
            
            if (!result.canResume) {
                logger.warn(`[Agent] 无法恢复任务: ${taskId} — ${result.reason}`);
                // 可以选择删除无法恢复的检查点，或者保留供手动处理
                continue;
            }
            
            // 2.3: 恢复任务（重建状态并继续执行）
            logger.info(`[Agent] 恢复任务: ${taskId} (步骤 ${result.checkpoint.stepIndex}/${result.checkpoint.completedSteps.length + result.checkpoint.pendingSteps.length})`);
            
            // 重建上下文
            this.messages = result.checkpoint.context || this.messages;
            
            // 重建任务状态（这里需要调用任务执行逻辑，从 pendingSteps[0] 开始）
            // 注意：这里只是示例，实际恢复逻辑可能更复杂
            this.recoverTask(result.checkpoint);
        }
    }
    
    // 2.4: 恢复完成后，清理过期的检查点（保留最近 N 天的）
    // 注意：这里不能调用 clearAll()，因为会删除所有检查点（包括刚刚恢复的）
    // 应该实现一个 clearExpired() 方法，只清理过期的
    this.checkpointMgr.clearExpired(7); // 保留最近 7 天的检查点
}
catch (err) {
    logger.warn('[Agent] 检查点恢复失败', err);
}
```

### 新增方法: `recoverTask(checkpoint: TaskCheckpoint)`

```typescript
/**
 * 恢复一个未完成的任务（从检查点）
 */
private async recoverTask(checkpoint: TaskCheckpoint): Promise<void> {
    const { taskId, originalRequest, completedSteps, pendingSteps, context, stepIndex } = checkpoint;
    
    logger.info(`[Agent] 恢复任务 ${taskId}: ${originalRequest}`);
    logger.info(`  已完成: ${completedSteps.length} 步骤, 待执行: ${pendingSteps.length} 步骤`);
    
    // 重建任务（这里需要调用任务执行逻辑）
    // 注意：这里只是示例，实际实现可能需要调用 this.handleTask() 或类似方法
    try {
        // 从 pendingSteps[0] 开始继续执行
        const result = await this.handleTask(originalRequest, pendingSteps);
        
        // 任务完成后，删除检查点
        this.checkpointMgr.complete(taskId);
        logger.info(`[Agent] 任务 ${taskId} 恢复完成`);
    }
    catch (err) {
        // 恢复失败，记录故障
        this.checkpointMgr.recordFailure(taskId, {
            type: 'recovery_failed',
            message: err.message,
            stepIndex,
        });
        logger.error(`[Agent] 任务 ${taskId} 恢复失败: ${err.message}`);
    }
}
```

### 新增方法: `CheckpointManager.clearExpired(retainDays: number)`

修改 `src/resilience/checkpoint.ts`，添加 `clearExpired()` 方法：

```typescript
/** 清空过期检查点（保留最近 N 天的） */
clearExpired(retainDays: number): void {
    this.ensureDir();
    const files = fs.readdirSync(this.config.dataDir).filter(f => f.endsWith('.json'));
    const now = Date.now();
    const retainMs = retainDays * 24 * 60 * 60 * 1000;
    
    for (const f of files) {
        try {
            const filePath = path.join(this.config.dataDir, f);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const cp: TaskCheckpoint = JSON.parse(raw);
            
            // 检查是否过期
            const checkpointTime = new Date(cp.timestamp).getTime();
            if (now - checkpointTime > retainMs) {
                fs.unlinkSync(filePath);
                logger.debug('[Ckpt] 过期检查点已删除: ' + f);
            }
        }
        catch (err) {
            logger.warn('[Ckpt] 无法处理检查点: ' + f + ' — ' + err);
        }
    }
    
    logger.info('[Ckpt] 过期检查点清理完成 (保留最近 ' + retainDays + ' 天)');
}
```

## 测试计划

### 单元测试

1. **测试 `clearExpired()` 方法**：
   - 创建过期的检查点文件（修改 timestamp）
   - 调用 `clearExpired(7)`
   - 验证过期的检查点被删除，未过期的保留

2. **测试 `resume()` 方法**：
   - 创建 pending checkpoint
   - 调用 `resume(taskId)`
   - 验证返回正确的结果（`canResume`, `checkpoint`）

3. **测试 `recoverTask()` 方法**（需要 mock）：
   - Mock `handleTask()` 方法
   - 调用 `recoverTask(checkpoint)`
   - 验证 `handleTask()` 被调用，并且检查点被删除（如果成功）

### 集成测试

1. **启动 agent-server，检查 pending tasks 是否被恢复**：
   - 创建一个检查点文件（手动）
   - 启动 agent-server
   - 检查日志，确认 pending task 被恢复

2. **恢复失败后，检查是否记录故障**：
   - 创建一个损坏的检查点文件
   - 启动 agent-server
   - 检查日志，确认故障被记录

## 风险分析

1. **恢复逻辑可能很复杂**：
   - 需要重建任务状态（从检查点加载 completedSteps、pendingSteps、context）
   - 需要重新开始执行任务（从 pendingSteps[0] 开始）
   - 需要确保恢复后的任务执行不会与正在运行的任务冲突

2. **可能引入新错误**：
   - 恢复逻辑可能有 bug，导致任务执行失败
   - 可能重复执行已完成的步骤

3. **性能影响**：
   - 如果 pending tasks 很多，恢复可能耗时
   - 可能在系统启动时阻塞

## 缓解措施

1. **添加配置开关**：允许用户禁用自动恢复（默认启用）
2. **添加监控**：如果 pending tasks 数量过多（如 > 5），通知用户
3. **添加手动管理命令**：允许用户通过 `/checkpoint list`、`/checkpoint recover <taskId>` 管理
4. **仔细测试**：编写单元测试和集成测试，确保恢复逻辑正确

## 下一步

1. **请用户审查此方案**
2. **如果同意，开始实施**：
   - 修改 `agent-core.ts`，添加恢复逻辑
   - 修改 `checkpoint.ts`，添加 `clearExpired()` 方法
   - 编译并测试
3. **更新文档**：更新 HANDOVER.md，标记此问题为“已修复”

## 替代方案

**如果恢复逻辑太复杂，可以暂时采用简单方案**：

1. **禁用自动恢复**，但添加手动管理命令
2. **修改 `clearAll()`，只清理过期的检查点**
3. **添加监控**，如果 pending tasks 数量过多，通知用户

这样，用户可以手动恢复 pending tasks，而不需要自动恢复逻辑。
