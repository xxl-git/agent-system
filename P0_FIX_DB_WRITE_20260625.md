# P0 修复：决策和实体未被记录到数据库

**修复时间**: 2026-06-25 07:40
**提交**: `9043ff2`
**状态**: ✅ 已完成并推送

---

## 问题描述

代码审查发现 `dbStore.addDecision()` 和 `dbStore.upsertEntity()` 方法虽然已定义，但**从未被调用**。

**影响**:
- 用户的交互决策**不会记录到数据库**
- 下次启动时 `SessionRecoverer.recover()` 无法恢复历史决策
- 实体（人/公司/项目）提及次数为 0，无法被跟踪

---

## 修复内容

### 1. 添加 `recordDecision()` 方法

```typescript
recordDecision(intent, userInput, reply) {
    if (!this.dbInitialized) return;
    if (!intent || intent.type === 'command') return;
    try {
        const db = db_store_1.getDBStore();
        const activeProject = this.projectManager?.getActiveProject();
        db.addDecision({
            timestamp: new Date().toISOString(),
            category: intent.type || 'chat',
            summary: (intent.summary || '').slice(0, 200),
            detail: userInput.slice(0, 500),
            project: activeProject?.project || 'default',
        });
    } catch (err) {
        logger.debug('[Agent] 决策记录失败（非阻塞）', err);
    }
}
```

### 2. 添加 `recordEntities()` 方法

```typescript
recordEntities(entities) {
    if (!this.dbInitialized) return;
    if (!entities || !Array.isArray(entities) || entities.length === 0) return;
    try {
        const db = db_store_1.getDBStore();
        const now = new Date().toISOString();
        for (const entity of entities) {
            if (!entity || typeof entity !== 'string' || entity.length < 2) continue;
            // 简单实体类型推断
            let type = 'concept';
            if (/^[A-Z]/.test(entity) && entity.length > 1) type = 'project';
            if (/\.(js|ts|py|md|json|yml|yaml)$/i.test(entity)) type = 'file';
            db.upsertEntity({
                name: entity.slice(0, 100),
                type,
                first_seen: now,
                notes: `Mentioned in intent: ${(this.lastIntent?.summary || '').slice(0, 100)}`,
            });
        }
    } catch (err) {
        logger.debug('[Agent] 实体记录失败（非阻塞）', err);
    }
}
```

### 3. 添加 `lastIntent` 属性

保存最后解析的意图，供 `recordEntities()` 使用。

### 4. 修改 `sendMessage()` 和 `sendMessageStream()`

在 `recordInteraction()` 之后调用：
```typescript
// 【P0 修复】记录决策到数据库（跨会话恢复）
this.recordDecision(intent, userInput, reply);
// 【P0 修复】记录实体到数据库（实体跟踪）
this.recordEntities(intent.entities);
```

---

## 验证

- ✅ `tsc --noEmit` 编译通过
- ✅ 106 个单元测试全部通过
- ✅ 已推送到 GitHub

---

## 数据流

```
用户输入
    ↓
intentParser.parse()
    ↓ [intent.entities 包含提取的实体]
this.lastIntent = intent
    ↓
handleCommand/handleTask/handleChat()
    ↓
recordInteraction() [文件写入]
recordDecision() [数据库写入] ← 新增
recordEntities() [数据库写入] ← 新增
    ↓
auditLog.logDecision() [日志写入]
```

下次启动时：
```
initMemoryRecovery()
  → sessionRecoverer.recover()
    → dbStore.getDecisions() [读取历史决策] ← 现在有数据了
```
