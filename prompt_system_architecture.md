# 提示词系统拆解与架构设计

## 一、当前系统拆解

### 1.1 提示词生产链路（按请求类型）

```
用户输入
    │
    ├─→ / 命令 → 直接处理，不走 LLM
    │
    ├─→ 普通输入 → intent-parser.ts
    │                    │
    │                    ▼
    │              [system: 意图分析器提示词]
    │              [user: 用户原始输入]
    │                    │
    │                    ▼
    │              输出结构化意图 JSON
    │
    ├─→ task 类型 → orchestrator.ts → task-decomposer.ts
    │                                    │
    │                                    ▼
    │                          [system: 任务分解器提示词]
    │                          [user: 用户请求]
    │                                    │
    │                                    ▼
    │                          输出任务 DAG JSON
    │
    └─→ chat 类型 → agent-core.ts → handleChat()
                                        │
                                        ▼
                              context-manager.ts 处理上下文
                                        │
                              ├─ 未超限 → 原始 messages
                              ├─ 超限 → 压缩 + 摘要系统消息
                              └─ _simpleTruncate → 截断标记
                                        │
                                        ▼
                              SmartAdapter.chat() → LMStudioAdapter.chat()
```

### 1.2 各模块提示词现状

| 模块 | 调用位置 | 消息数 | 系统提示词 | 参数 | 是否被调试面板捕获 |
|------|----------|--------|------------|------|-------------------|
| 意图解析 | `intent-parser.ts:modelParse()` | 2 | 硬编码（意图分析器） | 默认 | ❌ 否 |
| 任务分解 | `task-decomposer.ts:modelDecompose()` | 2 | 硬编码（任务分解器） | 默认 | ❌ 否 |
| 上下文摘要 | `context-manager.ts` 回调 | 1 | 用户传入的压缩提示 | 默认 | ✅ 是（但误显示） |
| 主聊天 | `agent-core.ts:handleChat()` | N | 硬编码（You are...） + 记忆注入 | temp=0.7, max_tokens=2048 | ✅ 是 |
| 会话摘要 | `summarizer.ts:llmSummarize()` | 1 | 硬编码（摘要提取器） | 默认 | ❌ 否 |
| 能力探测 | `capability-probe.ts:runProbe()` | 1 | 探针 prompt | 默认 | ❌ 否 |

### 1.3 当前痛点

1. **提示词分散**：5+ 模块各自硬编码系统提示词，没有统一入口。
2. **调试面板失明**：只有 `agent-core.ts` 主聊天路径会广播 `model_payload`，意图解析、任务分解、摘要、探针等调用不可见。
3. **重复发射干扰**：`handleChat()` 里 `emitModelPayload` 被调用两次（上下文压缩回调内 + 正式聊天前），导致调试面板可能先显示压缩回调的临时 payload，用户误以为那是真正发送的内容。
4. **参数硬编码**：temperature=0.7、max_tokens 取默认值等在各个模块写死，没有按任务类型配置。
5. **记忆注入污染系统提示词**：跨会话记忆直接拼接到 `system.content` 里，容易超出模型对 system 的注意力分配，且不可追踪。
6. **角色语义混乱**：上下文压缩后把摘要塞进 `system` 角色，把历史对话和系统指令混在一起，模型可能降低对真正 system 指令的遵循度。
7. **没有版本/模板管理**：修改提示词需要改代码，无法 A/B 测试、热更新或按模型切换。

---

## 二、目标架构设计

### 2.1 核心原则

1. **Single Source of Truth（SSOT）**：所有提示词模板集中在 `PromptRegistry`。
2. **关注点分离**：
   - 系统身份（System Identity）
   - 跨会话记忆（Memory Block）
   - 当前会话上下文（Conversation Context）
   - 任务指令（Task Instruction）
   - 用户输入（User Input）
3. **全链路可观测**：所有 LLM 调用都经过统一入口，自动广播 payload。
4. **模型感知**：不同模型/阶段使用不同提示词包装策略（`promptWrapper: minimal | structured | verbose`）。
5. **配置驱动**：关键提示词可外置到 YAML/JSON，支持热重载和版本追踪。

### 2.2 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      Prompt Registry                          │
│  (模板库：身份/意图/分解/摘要/探测/任务包装/模型特化)          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Prompt Assembler                          │
│  组装顺序：                                                    │
│  1. System Identity                                            │
│  2. Memory Block (as user context, not system)                │
│  3. Conversation Context / Compressed Summary                 │
│  4. Task Instruction (if any)                                 │
│  5. User Input                                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   LLM Call Router                             │
│  统一入口：chat({taskType, messages, params, metadata})        │
│  自动：广播 model_payload、记录审计、超控参数                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   SmartAdapter → LMStudioAdapter              │
│  超时/重试/空响应/重复检测/降级                               │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 关键组件设计

#### 2.3.1 PromptRegistry（提示词模板注册表）

```typescript
// src/prompts/registry.ts
export interface PromptTemplate {
  id: string;
  version: string;
  system?: string;           // 系统提示词模板
  user?: string;            // 用户提示词模板（可插值）
  wrapper?: 'minimal' | 'structured' | 'verbose';
  params?: Partial<ModelParams>; // 该任务默认参数
}

export class PromptRegistry {
  private templates = new Map<string, PromptTemplate>();

  register(template: PromptTemplate): void;
  get(id: string, variables?: Record<string, string>): PromptTemplate;
  loadFromConfig(cfg: any): void; // 从 YAML/JSON 热加载
}
```

预置模板：
- `agent.identity` — 助手身份
- `agent.memory` — 记忆块包装
- `intent.parse` — 意图解析
- `task.decompose` — 任务分解
- `context.summarize` — 上下文摘要
- `session.summarize` — 会话摘要
- `probe.<name>` — 各能力探针

#### 2.3.2 PromptAssembler（提示词组装器）

```typescript
// src/prompts/assembler.ts
export interface AssembledPrompt {
  messages: ChatMessage[];
  metadata: {
    taskType: string;
    systemIdentityLen: number;
    memoryBlockLen: number;
    contextLen: number;
    taskInstructionLen: number;
    userInputLen: number;
  };
}

export class PromptAssembler {
  assemble(options: {
    identity: string;
    memoryBlock?: string;
    context: ChatMessage[];
    taskInstruction?: string;
    userInput: string;
    wrapper?: 'minimal' | 'structured' | 'verbose';
  }): AssembledPrompt;
}
```

**组装规则**：
1. System Identity 永远只放 `You are an intelligent Agent assistant...` 和不可变的全局约束。
2. Memory Block 以 **user 角色**或独立 `context` 消息插入，而不是塞进 system。例如：
   ```
   [user] "以下是你需要了解的背景信息（来自历史会话）：\n..."
   ```
3. Compressed Summary 也以 user/context 消息呈现，标记为 `[此前对话摘要]`，避免污染 system。
4. Task Instruction 作为一条 system 或 user 消息放在用户输入之前。
5. User Input 永远是最后一条 user 消息。

#### 2.3.3 LLM Call Router（统一调用路由）

所有 LLM 调用都走这个入口：

```typescript
// src/llm/router.ts
export interface LLMCallRequest {
  taskType: 'intent' | 'decompose' | 'chat' | 'summarize' | 'probe' | 'breakin';
  messages: ChatMessage[];
  params?: Partial<ModelParams>;
  metadata?: Record<string, any>;
  emitPayload?: boolean; // 默认 true
}

export class LLMCallRouter {
  async call(req: LLMCallRequest): Promise<ChatCompletionResponse> {
    // 1. 参数合并（全局默认 < 任务默认 < 调用传入）
    const params = this.mergeParams(req.taskType, req.params);

    // 2. 自动广播 model_payload（带 taskType 标记）
    if (req.emitPayload !== false) {
      agentEventBus.emitModelPayload({
        taskType: req.taskType,
        messages: req.messages,
        params,
        ...
      });
    }

    // 3. 调用 SmartAdapter
    return this.adapter.chat(req.messages, params);
  }
}
```

这样所有 LLM 调用（意图、分解、摘要、聊天、探测）都会自动进入调试面板，并用 `taskType` 区分。

#### 2.3.4 模型参数策略（Parameter Strategy）

| 任务类型 | temperature | max_tokens | reasoning | 说明 |
|----------|-------------|------------|-----------|------|
| intent | 0.0 | 512 | off | 结构化输出，越低越稳定 |
| decompose | 0.0 | 1024 | off | 结构化输出 |
| chat | 0.7 | 2048 | auto | 默认对话 |
| summarize | 0.0 | 1024 | off | 摘要需稳定 |
| probe | 0.0 | 256 | off | 探测标准化 |
| breakin | 0.7 | 1024 | off | 磨合期可稍高 |

### 2.4 调试面板增强

前端 `model_payload` 面板增加 `taskType` 标签和过滤：

```javascript
function handleModelPayload(d) {
  if (d.type !== 'model_payload') return;
  // 按任务类型着色
  const color = TASK_COLORS[d.taskType] || '#888';
  // 显示 taskType 徽章
  // 支持多标签页：全部 / intent / chat / summarize / probe
}
```

---

## 三、迁移路径（Phase 1 → Phase 2 → Phase 3）

> **全部完成 ✅ (v0.7.0, 2026-06-21)**

### Phase 1：统一 LLM 调用入口（最小改动，解决当前调试失明问题）✅

1. 新建 `src/llm/llm-router.ts`，封装 `SmartAdapter.chat()`。
2. 在 `LLMCallRouter.call()` 中统一调用 `agentEventBus.emitModelPayload()`，并带上 `taskType`。
3. 修改 `intent-parser.ts`、`task-decomposer.ts`、`summarizer.ts`、`capability-probe.ts` 以及 `agent-core.ts` 里的 `adapter.chat()` 调用，全部改为 `llmRouter.call(...)`。
4. 前端调试面板增加 `taskType` 显示和过滤。

**效果**：所有 LLM 调用都能被调试面板看到，立刻解决用户说的“发送内容有问题但不知道是哪里的问题”。

### Phase 2：提示词模板化（解决硬编码和 A/B 测试问题）✅

1. 新建 `src/prompts/registry.ts` 和 `config/prompts/` 目录。
2. 把当前硬编码的提示词迁移到模板文件：
   - `config/prompts/agent.identity.md`
   - `config/prompts/intent.parse.md`
   - `config/prompts/task.decompose.md`
   - `config/prompts/context.summarize.md`
   - `config/prompts/session.summarize.md`
3. 各模块通过 `promptRegistry.get('intent.parse')` 获取模板，支持变量插值（`{{userMessage}}`）。
4. 启动时从 `config/prompts/` 加载，支持热重载（`/config reload`）。

### Phase 3：提示词组装器（解决角色污染和记忆注入问题）✅

1. 新建 `src/prompts/assembler.ts`。
2. 改造 `agent-core.ts` 的 `handleChat()`：
   - 用 `PromptAssembler` 组装最终 messages
   - Memory Block 不再塞进 `system.content`，而是作为独立 context 消息
   - 压缩摘要也作为独立 context 消息
3. 调整 `context-manager.ts` 输出结构：返回的 `messages` 保留原始角色，不自动把摘要变成 `system`。
4. 按任务类型配置默认参数。

---

## 四、代码示例（Phase 1 改造后）

### 4.1 统一调用入口

```typescript
// src/llm/llm-router.ts
export class LLMCallRouter {
  async call(req: LLMCallRequest): Promise<ChatCompletionResponse> {
    const params = mergeParams(req.taskType, req.params);

    agentEventBus.emitModelPayload({
      taskType: req.taskType,
      messages: req.messages,
      systemPromptLen: req.messages.filter(m => m.role === 'system').reduce((a, m) => a + m.content.length, 0),
      userPromptLen: req.messages.filter(m => m.role === 'user').reduce((a, m) => a + m.content.length, 0),
      assistantPromptLen: req.messages.filter(m => m.role === 'assistant').reduce((a, m) => a + m.content.length, 0),
      messageCount: req.messages.length,
      model: this.adapter.model,
      params,
      ts: new Date().toISOString(),
    });

    return this.adapter.chat(req.messages, params);
  }
}
```

### 4.2 intent-parser.ts 改造

```typescript
// 改造前
const res = await this.adapter.chat([sysPrompt, userMsg]);

// 改造后
const res = await llmRouter.call({
  taskType: 'intent',
  messages: [sysPrompt, userMsg],
  params: { temperature: 0, max_tokens: 512, reasoning: 'off' },
});
```

### 4.3 前端调试面板过滤

```javascript
const TASK_LABELS = {
  intent: '意图解析',
  decompose: '任务分解',
  chat: '主聊天',
  summarize: '摘要',
  probe: '探针',
};

function handleModelPayload(d) {
  if (d.type !== 'model_payload') return;
  _pendingPayload = d;
  const label = TASK_LABELS[d.taskType] || d.taskType;
  if (title) title.textContent = `📨 [${label}] ${esc(d.model, 30)}`;
  // ...
}
```

---

## 五、预期收益

| 问题 | 解决方案 | 收益 |
|------|----------|------|
| 调试面板看不到意图/分解/摘要 | 统一 LLM Router + 广播 taskType | 全链路可观测 |
| 调试面板显示两次 payload 混淆 | Router 只在实际调用时广播一次；上下文压缩回调不再广播 | 显示的是真实 payload |
| 提示词硬编码分散 | PromptRegistry + 模板文件 | 可维护、可热更新 |
| 记忆污染 system | PromptAssembler 把 memory/context 作为独立 user/context 消息 | 角色语义清晰 |
| 参数无策略 | 任务类型默认参数 | 按任务优化模型行为 |
| 无法按模型切换提示词 | 模板支持 `wrapper` 和模型特化 | 提升模型兼容性 |

---

## 六、实施记录

- **Phase 1** ✅ (v0.6.6, 2026-06-21) — 统一 LLM Router 全链路可观测
- **Phase 2** ✅ (v0.7.0, 2026-06-21) — PromptRegistry 模板化，6 个外部模板文件
- **Phase 3** ✅ (v0.7.0, 2026-06-21) — PromptAssembler 组装器，Memory Block 角色修正

### 实际实现与设计的差异

| 设计文档 | 实际实现 | 原因 |
|----------|----------|------|
| `LLMCallRouter` 类名 | `LLMRouter` 类名 | 命名更简洁 |
| 模板文件用 YAML/JSON | 模板文件用 .md + YAML frontmatter | Markdown 更适合提示词编辑，frontmatter 携带元数据 |
| `context.summarize` 模板 | 已创建但 context-manager 尚未接入 | context-manager 的压缩回调签名需后续适配 |
| `probe.<name>` 探针模板 | 未创建 | 探针提示词结构特殊，暂保留在代码中 |
