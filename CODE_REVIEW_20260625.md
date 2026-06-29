# 代码审查报告：记忆组件 & 提示词注入
**审查时间**: 2026-06-25
**审查范围**: 记忆组件(memory/*)、提示词注入(prompts/*)、上下文管理(context-manager.ts)、AgentCore 调用链

---

## 一、核心调用链架构

```
用户输入
    ↓
sendMessage(userInput)
    ├── / 命令 → handleCommand() [跳过记忆/审计]
    ├── intentParser.parse() → 意图分类
    └── intent.type === 'chat' → ChatHandler.handle()
                                    ↓
                            ctxManager.process()
                            ├── 未超限 → 直接返回 messages
                            └── 超限 → 注意力评分 → 热点提取 → 摘要 → reassembled
                                    ↓
                            experienceRetriever.retrieve() [条件性]
                                    ↓
                            promptAssembler.assemble({
                                memoryBlock: _cachedMemoryBlock,  ← initMemoryRecovery()
                                experienceBlock,
                                context: ctxResult.messages,
                            })
                                    ↓
                            llm_router.call({ messages: assembled.messages })
```

---

## 二、记忆组件分析

### 2.1 SessionRecoverer (session-recovery.ts)

**职责**: 启动时恢复跨会话记忆，生成 `systemPromptBlock`

**数据来源**:
1. **数据库** (db-store):
   - `decisions` 表：最近 10 条决策
   - `entities` 表：提及次数最多的 10 个实体
   - `summaries` 表：最近 3 条会话摘要

2. **文件层** (file-store):
   - `memory/*.md`：最近 7 天的日志文件摘要

**输出**: `MemoryInjection` 接口
```typescript
interface MemoryInjection {
  recentDecisions: DecisionRecord[];
  trackedEntities: EntityRecord[];
  recentSummaries: SummaryRecord[];
  recentFileMemory: string;
  systemPromptBlock: string;  // 拼接后的注入文本
}
```

**数据流**:
```
initMemoryRecovery()
  → sessionRecoverer.recover()
    → buildPromptBlock() [拼接格式化的历史信息]
  → this._cachedMemoryBlock = systemPromptBlock  ✓ 正确设置
```

**✅ 评估**: SessionRecoverer 实现正确，记忆恢复链路完整。

---

### 2.2 DBStore (db-store.ts)

**问题发现**: ⚠️ **严重 - 决策未被记录**

| 方法 | 定义 | 被调用 |
|------|------|--------|
| `addDecision()` | ✅ 定义在第 185 行 | ❌ **从未被调用** |
| `upsertEntity()` | ✅ 定义在第 210 行 | ❌ **从未被调用** |
| `addSummary()` | ✅ 定义 | ❌ **未确认调用** |

**影响**:
- 用户的交互决策 **不会被记录到数据库**
- 下次启动时 `sessionRecoverer.recover()` 无法恢复历史决策
- 实体（人/公司/项目）提及次数为 0，无法被跟踪

**根因**: `auditLog.logDecision()` 只写入日志文件，不写入数据库

---

### 2.3 FileStore (file-store.ts)

**✅ 正常**: `append()` 方法被 `recordInteraction()` 调用

```typescript
recordInteraction(input, output) {
    const store = getMemoryStore();
    store.append(inputBrief + '\n' + outputBrief);
}
```

**数据流**:
```
sendMessage() [非命令路径]
  → recordInteraction(userInput, reply)
    → file_store.append() ✓ 正常工作
```

---

### 2.4 Summarizer (summarizer.ts)

**✅ 正常**: `summarizeSession()` 在 `stop()` 时被调用

```typescript
stop() {
    this.summarizer.summarizeSession(this.sessionId, messages, []);
}
```

---

## 三、提示词注入分析

### 3.1 PromptAssembler (assembler.ts)

**组装顺序**:
```
1. System Identity     → system 角色 [唯一]
2. Memory Block        → user 角色 [条件性]
3. Experience Block     → user 角色 [条件性]
4. Conversation Context → 过滤 system，保留 user/assistant
5. Task Instruction     → user 角色 [可选]
6. User Input           → user 角色 [最后]
```

**✅ 评估**: 组装顺序合理，符合"身份 → 背景 → 上下文 → 输入"的认知层次。

---

### 3.2 潜在问题

#### 问题 1: `context.summary-block` 模板格式冲突

**位置**: `assembler.ts` 第 137-144 行

```typescript
// 检查是否是压缩摘要消息（ContextManager 输出的格式）
if (msg.role === 'user' && isSummaryMessage(msg.content)) {
    meta.hasSummary = true;
    // 用 summary-block 模板包装（如果还没被包装过）
    if (!msg.content.includes('[此前对话摘要]')) {
        const summaryContent = registry.get('context.summary-block', {
            summary: msg.content,
        }).user || msg.content;
```

**问题**:
- ContextManager 输出的摘要格式: `[此前对话摘要] ...`
- `isSummaryMessage()` 检查: `content.includes('[此前对话摘要]')` 或 `content.includes('[SUMMARY]')`
- `context.summary-block` 模板: `[此前对话摘要]\n{{summary}}\n[摘要结束]`

**结果**: 如果摘要已包含 `[此前对话摘要]` 标记，`if (!msg.content.includes(...))` 为 false，直接 push 原始消息（可能缺少 `[摘要结束]` 标记）

**✅ 影响评估**: 低 - 摘要内容完整，只是缺少 `[摘要结束]` 标记

---

#### 问题 2: Memory Block 可能为空

**场景**: 首次启动时（无历史记忆）

```typescript
if (memoryBlock && memoryBlock.trim()) {
    // 注入记忆
}
```

**✅ 评估**: 正确处理了空值情况

---

## 四、上下文管理分析

### 4.1 ContextManager (context-manager.ts)

**压缩算法**:
1. **注意力评分**: TF-IDF + 时效性 + 角色权重 + 实体价值
2. **热点提取**: 保留 Top N 高分消息
3. **摘要生成**: 调用 LLM 将非热点消息压缩为摘要

**Token 估算**:
```typescript
export function estimateTokens(text: string): number {
  // 中文约 1 字 ≈ 1.5 tokens
  return Math.ceil(text.length * 1.35);
}
```

**⚠️ 潜在问题**: Token 估算公式可能不准确
- 英文: 1 token ≈ 4 字符 (GPT 系列)
- 中文: 1 token ≈ 1-2 字符
- 当前公式: `text.length * 1.35` 对英文偏大，对中文偏小

**✅ 影响评估**: 中 - 可能导致压缩阈值判断不准确，但有 `compressionThreshold` (0.75) 作为缓冲

---

## 五、组件协作问题汇总

### 🔴 严重问题（已修复）

| # | 问题 | 位置 | 影响 | 状态 |
|---|------|------|------|------|
| 1 | `dbStore.addDecision()` 从未被调用 | `agent-core.ts` | 决策不记录 → 无法恢复历史决策 | ✅ 已修复 |
| 2 | `dbStore.upsertEntity()` 从未被调用 | `agent-core.ts` | 实体不跟踪 → 无法记录人/公司/项目 | ✅ 已修复 |

### 🟡 中等问题（已修复）

| # | 问题 | 位置 | 影响 | 状态 |
|---|------|------|------|------|
| 3 | Token 估算公式不够精确 | `context-manager.ts` | 压缩阈值判断可能不准确 | ✅ 已修复 |
| 4 | `context.summary-block` 包装逻辑有边界情况 | `assembler.ts` | 摘要可能缺少结束标记 | ✅ 已修复 |

### ✅ 正常组件

- `SessionRecoverer` - 记忆恢复逻辑正确
- `FileStore` + `recordInteraction()` - 文件记忆正常工作
- `Summarizer` - 会话摘要在 stop() 时调用
- `PromptAssembler` - 组装顺序合理
- `ContextManager` - 压缩算法设计合理
- `PromptRegistry` - 模板注册机制完整
- `AgentCore` - ✅ 决策记录功能已添加
- `AgentCore` - ✅ 实体跟踪功能已添加

---

## 六、修复记录

### ✅ 已修复 (2026-06-25 07:40)

**P0: 决策和实体未被记录到数据库**
- 提交: `9043ff2`
- 修复内容:
  - 添加 `recordDecision()` 方法
  - 添加 `recordEntities()` 方法
  - 添加 `lastIntent` 属性
  - 在 `sendMessage()` 和 `sendMessageStream()` 中调用这两个方法
- 验证: 106 个单元测试全部通过

### ✅ 已修复 (2026-06-25 12:15)

**P2: Token 估算和摘要包装逻辑**
- 提交: `937eb43`
- 修复内容:
  - Token 估算改进：分别计算中文字符（1 token ≈ 1.5 字符）和非中文字符（1 token ≈ 4 字符）
  - 摘要包装逻辑：有 `[此前对话摘要]` 但缺少 `[摘要结束]` 时，追加结束标记
- 验证: 106 个单元测试全部通过

### 待修复 (P2)

## 七、总结

### 核心功能状态

| 模块 | 状态 | 说明 |
|------|------|------|
| 记忆恢复 | ⚠️ 部分工作 | SessionRecoverer 正常，但数据库写入缺失 |
| 上下文管理 | ✅ 正常 | ContextManager 压缩算法设计合理 |
| 提示词组装 | ✅ 正常 | PromptAssembler 组装顺序正确 |
| 文件记忆 | ✅ 正常 | FileStore 正常记录交互 |
| 会话摘要 | ✅ 正常 | Summarizer 在 stop() 时调用 |

### 关键发现

1. **记忆写入链路断裂**: `auditLog.logDecision()` 只写日志文件，不写数据库
2. **决策/实体跟踪缺失**: 两个核心功能从未被调用
3. **整体架构设计良好**: 模块化程度高，组件职责清晰
4. **数据流正确**: `initMemoryRecovery()` → `_cachedMemoryBlock` → `promptAssembler.assemble()` 链路完整
