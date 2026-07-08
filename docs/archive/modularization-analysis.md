# Agent System 模块化拆分分析

> 分析时间：2026-06-22
> 当前版本：v0.9.0
> 源文件：65 个 TypeScript 文件

---

## 一、当前架构状态

### 1.1 文件分布（按目录）

| 目录 | 文件数 | 职责 | 耦合度 |
|------|--------|------|--------|
| `core/` | 12 | Agent 核心、意图、任务编排、工具 | 🔴 极高 |
| `server/` | 3 | HTTP 服务、Dashboard API、Session 存储 | 🟡 中 |
| `models/` | 7 | LM Studio 适配、探针、画像、路由 | 🟢 低 |
| `memory/` | 4 | 文件存储、DB 存储、摘要、恢复 | 🟢 低 |
| `resilience/` | 9 | 韧性层（熔断、重试、降级、诊断） | 🟡 中 |
| `experience/` | 5 | 经验提取、存储、检索、命令 | 🟢 低 |
| `prompts/` | 3 | 提示词注册、组装 | 🟢 低 |
| `skills/` | 5 | 技能注册、缺口检测、管道 | 🟡 中 |
| `agents/` | 2 | 多 Agent 协作、子 Agent | 🟡 中 |
| `audit/` | 2 | 审计日志、审计服务 | 🟢 低 |
| `llm/` | 1 | 统一 LLM Router | 🟢 低 |
| `config/` | 2 | 配置加载 | 🟢 低 |

### 1.2 核心问题：AgentCore 巨型类

`agent-core.ts` 有 **1400+ 行**，直接依赖 **25+ 个模块**：

```typescript
// agent-core.ts 的 import 列表
import { LMStudioAdapter, SmartAdapter }
import { getMemoryStore, getDBStore }
import { IntentParser, Orchestrator, ProjectManager }
import { SmartRouter, BreakInMachine, getProfileStore }
import { getRegistry, GapDetector, SkillAuditor, SkillDeveloper, SkillTester, SkillEquipper }
import { SubAgent, AgentBus, ResultMerger, ParallelScheduler }
import { RecoveryOrchestrator, HealthMonitor, CircuitBreaker, CheckpointManager }
import { SessionRecoverer, MemorySummarizer, AuditLog }
import { ContextManager, IdleTaskManager, NonsenseDetector, SessionDiagnostics }
import { PromptRegistry, PromptAssembler }
import { ExperienceStore, ExperienceExtractor, ExperienceRetriever, ExperienceCommandHandler }
```

**问题**：
- 单一职责原则违反 — AgentCore 承担了太多职责
- 依赖注入困难 — 构造函数直接 `new` 所有依赖
- 测试困难 — 无法 mock 单个模块
- 难以复用 — 无法单独使用某个功能模块

---

## 二、模块化拆分方案

### 2.1 核心模块划分

```
┌─────────────────────────────────────────────────────────────┐
│                      @agent-system/core                      │
│  (AgentRuntime, EventBus, Types)                            │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│@agent-system  │   │@agent-system  │   │@agent-system  │
│   /memory     │   │   /llm        │   │ /resilience   │
└───────────────┘   └───────────────┘   └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│@agent-system  │   │@agent-system  │   │@agent-system  │
│  /prompts     │   │   /tools      │   │  /experience  │
└───────────────┘   └───────────────┘   └───────────────┘
```

### 2.2 模块详情

#### 模块 A：`@agent-system/memory`

**包含文件**：
```
memory/
├── db-store.ts      → DBStore
├── file-store.ts    → FileStore  
├── summarizer.ts    → MemorySummarizer
└── session-recovery.ts → SessionRecoverer
```

**暴露接口**：
```typescript
export interface MemoryModule {
  dbStore: DBStore;
  fileStore: FileStore;
  summarizer: MemorySummarizer;
  sessionRecoverer: SessionRecoverer;
  
  // 便捷方法
  saveMessage(msg: ChatMessage): Promise<void>;
  getSessionHistory(sessionId: string): Promise<ChatMessage[]>;
  summarizeSession(sessionId: string): Promise<string>;
}
```

**依赖**：`sql.js`, `winston`, `js-yaml`（已有）

**收益**：
- ✅ 可独立发布为 npm 包
- ✅ 可被其他 Agent 项目复用
- ✅ 测试隔离，无需启动整个 Agent

---

#### 模块 B：`@agent-system/llm`

**包含文件**：
```
llm/
├── llm-router.ts           → LLMRouter
models/
├── adapters/lmstudio.ts    → LMStudioAdapter
├── probe/probes.ts         → Probe definitions
├── probe/capability-probe.ts → CapabilityProbe
├── profile/model-profile.ts  → ModelProfile
├── router/smart-router.ts    → SmartRouter
├── router/difficulty-assessor.ts
└── adaptation/break-in-machine.ts
```

**暴露接口**：
```typescript
export interface LLMModule {
  router: LLMRouter;
  adapter: LMStudioAdapter;
  
  // 能力探测
  probeCapabilities(): Promise<CapabilityProfile>;
  
  // 模型切换
  setModel(modelId: string): void;
  getCurrentModel(): string;
}
```

**收益**：
- ✅ 支持多后端（目前只有 LM Studio，未来可加 Ollama、OpenAI）
- ✅ 探针系统可独立测试
- ✅ 路由策略可插拔

---

#### 模块 C：`@agent-system/resilience`

**包含文件**：
```
resilience/
├── orchestrator.ts      → RecoveryOrchestrator
├── circuit-breaker.ts   → CircuitBreaker
├── health-monitor.ts    → HealthMonitor
├── retry-engine.ts      → RetryEngine
├── checkpoint.ts        → CheckpointManager
├── degradation.ts       → DegradationPath
├── idle-task-manager.ts
├── nonsense-detector.ts
└── session-diagnostics.ts
```

**暴露接口**：
```typescript
export interface ResilienceModule {
  recovery: RecoveryOrchestrator;
  circuitBreaker: CircuitBreaker;
  healthMonitor: HealthMonitor;
  
  // 包装执行
  executeProtected<T>(fn: () => Promise<T>): Promise<T>;
}
```

**收益**：
- ✅ 韧性模式可独立演进
- ✅ 可配置不同策略（重试次数、熔断阈值等）
- ✅ 适用于任何异步操作，不限于 Agent

---

#### 模块 D：`@agent-system/experience`

**包含文件**：
```
experience/
├── types.ts      → ExperienceRecord 等
├── store.ts      → ExperienceStore
├── extractor.ts  → ExperienceExtractor
├── retriever.ts  → ExperienceRetriever
└── commands.ts   → ExperienceCommandHandler
```

**暴露接口**：
```typescript
export interface ExperienceModule {
  store: ExperienceStore;
  extractor: ExperienceExtractor;
  retriever: ExperienceRetriever;
  
  // 便捷方法
  learn(input: ExperienceInput): Promise<void>;
  recall(context: string, topK?: number): Promise<ExperienceRecord[]>;
}
```

**收益**：
- ✅ 经验系统完全独立
- ✅ 可接入其他 LLM 后端
- ✅ 评分衰减策略可配置

---

#### 模块 E：`@agent-system/prompts`

**包含文件**：
```
prompts/
├── registry.ts   → PromptRegistry
├── assembler.ts  → PromptAssembler
└── index.ts
```

**依赖**：仅 `js-yaml`

**收益**：
- ✅ 提示词管理完全解耦
- ✅ 支持热重载、A/B 测试

---

#### 模块 F：`@agent-system/tools`

**包含文件**：
```
core/tools/
├── base-tools.ts → registerBaseTools()
├── registry.ts   → ToolRegistry
└── types.ts      → ToolResult 等
```

**暴露接口**：
```typescript
export interface ToolsModule {
  registry: ToolRegistry;
  register(tool: Tool): void;
  execute(name: string, params: any): Promise<ToolResult>;
}
```

---

#### 模块 G：`@agent-system/skills`

**包含文件**：
```
skills/
├── types.ts
├── registry.ts
├── skill-registry.ts
├── gap-detector.ts
└── pipeline.ts
```

**依赖**：`@agent-system/llm`（提取技能需要 LLM）

---

#### 模块 H：`@agent-system/server`

**包含文件**：
```
server/
├── agent-server.ts
├── dashboard-api.ts
└── session-store.ts
```

**依赖**：所有模块

---

### 2.3 核心层重构

**原 AgentCore 拆分为**：

```typescript
// 1. AgentRuntime — 状态机 + 事件驱动
class AgentRuntime {
  constructor(
    private memory: MemoryModule,
    private llm: LLMModule,
    private resilience: ResilienceModule,
    private tools: ToolsModule,
    private eventBus: AgentEventBus
  ) {}
  
  async process(input: string): AsyncGenerator<AgentEvent>;
}

// 2. AgentOrchestrator — 任务编排
class AgentOrchestrator {
  async plan(intent: ParsedIntent): Promise<TaskDAG>;
  async execute(dag: TaskDAG): Promise<ExecutionResult>;
}

// 3. AgentCoordinator — 多模块协调
class AgentCoordinator {
  constructor(private runtime: AgentRuntime) {}
  
  // 对外暴露的高级 API
  async chat(message: string): Promise<string>;
  async executeTask(task: string): Promise<TaskResult>;
}
```

---

## 三、收益评估

### 3.1 量化收益

| 维度 | 当前状态 | 模块化后 | 提升 |
|------|----------|----------|------|
| **单元测试覆盖** | ~30%（依赖难 mock） | ~80%（模块隔离） | +150% |
| **编译速度** | ~8s（全量） | ~2s（增量） | +300% |
| **可复用模块** | 0 | 6-8 个 npm 包 | ∞ |
| **依赖清晰度** | 25+ 依赖在 1 文件 | 平均 3-5 依赖/模块 | +400% |
| **新功能开发** | 需理解 1400 行核心 | 只需理解相关模块 | +200% |

### 3.2 定性收益

#### ✅ 高收益项

1. **测试性飞跃**
   - 当前：要测试 `ExperienceExtractor`，必须启动整个 AgentCore
   - 模块化后：只需 `import { ExperienceExtractor } from '@agent-system/experience'`

2. **复用性**
   - `@agent-system/memory` 可被任何聊天机器人项目使用
   - `@agent-system/resilience` 可用于任何需要容错的服务
   - `@agent-system/prompts` 可用于任何 LLM 应用

3. **并行开发**
   - 不同开发者可独立开发不同模块
   - 接口定义后，前端/后端可并行

4. **渐进式重构**
   - 不需要一次性重写
   - 可以逐模块拆出，边拆边验证

#### ⚠️ 中等收益项

1. **包管理开销**
   - 需要 lerna/yarn workspaces 管理 monorepo
   - 版本同步需要自动化

2. **发布复杂度**
   - 每个模块独立发布，需要 CI/CD
   - 变更日志需要聚合

#### ❌ 低收益项

1. **性能**
   - 模块边界会增加少量 import 开销
   - 但 Node.js 模块缓存基本抵消

---

## 四、迁移路线图

### Phase 1：接口定义（1 天）

1. 定义每个模块的公共接口（TypeScript `.d.ts`）
2. 设计模块间通信协议（事件 vs 直接调用）

### Phase 2：先拆低耦合模块（2-3 天）

**优先级**：
```
experience/ → prompts/ → tools/ → skills/
```
这些模块依赖少，拆分风险低，立即可发布。

### Phase 3：拆中等耦合模块（3-4 天）

```
memory/ → resilience/ → models/
```
需要梳理与 core 的依赖，逐步解耦。

### Phase 4：核心重构（5-7 天）

1. 将 AgentCore 拆分为 Runtime + Orchestrator + Coordinator
2. 使用依赖注入模式
3. 引入 InversifyJS 或手写 DI

### Phase 5：服务层整合（1-2 天）

1. `@agent-system/server` 组装所有模块
2. 提供统一配置入口

---

## 五、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 拆分后接口不兼容 | 中 | 高 | 先定义接口，再拆分，保持向后兼容 |
| 循环依赖 | 中 | 中 | 使用事件总线解耦，避免直接 import |
| 测试覆盖不足 | 高 | 高 | 拆分前先补充单元测试 |
| 性能回归 | 低 | 低 | Benchmark 对比 |

---

## 六、结论

### 收益评级：⭐⭐⭐⭐ (4/5)

**强烈推荐模块化拆分**，原因：

1. **当前技术债严重** — 1400 行的 God Class 是可维护性杀手
2. **项目已有模块雏形** — 目录结构清晰，只是缺少接口边界
3. **复用价值高** — memory、resilience、prompts 都有独立价值
4. **可渐进式迁移** — 不需要一次性重写，风险可控

### 建议行动

**短期（本周）**：
- 拆出 `@agent-system/experience` 和 `@agent-system/prompts`
- 这两个模块依赖最少，立即可发布

**中期（本月）**：
- 拆出 `@agent-system/memory` 和 `@agent-system/resilience`
- 开始重构 AgentCore

**长期（下季度）**：
- 完成全部模块化
- 发布 1.0.0，每个子包独立版本号

---

## 附录：Monorepo 结构示例

```
agent-system/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   ├── package.json    → @agent-system/core
│   │   └── tsconfig.json
│   ├── memory/
│   │   ├── src/
│   │   ├── package.json    → @agent-system/memory
│   │   └── tsconfig.json
│   ├── llm/
│   │   ├── src/
│   │   ├── package.json    → @agent-system/llm
│   │   └── tsconfig.json
│   ├── resilience/
│   │   ├── src/
│   │   ├── package.json    → @agent-system/resilience
│   │   └── tsconfig.json
│   ├── experience/
│   │   ├── src/
│   │   ├── package.json    → @agent-system/experience
│   │   └── tsconfig.json
│   ├── prompts/
│   │   ├── src/
│   │   ├── package.json    → @agent-system/prompts
│   │   └── tsconfig.json
│   ├── tools/
│   │   ├── src/
│   │   ├── package.json    → @agent-system/tools
│   │   └── tsconfig.json
│   ├── skills/
│   │   ├── src/
│   │   ├── package.json    → @agent-system/skills
│   │   └── tsconfig.json
│   └── server/
│       ├── src/
│       ├── package.json    → @agent-system/server
│       └── tsconfig.json
├── package.json            → workspace 根配置
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── lerna.json              (可选)
```
