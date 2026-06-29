# SkillForge 融入 Agent-System 可执行设计文档

> **版本**: V1.0 | **日期**: 2026-06-18
> **目标读者**: 另一个会话中执行开发的 Agent
> **前提**: 已阅读 `skillforge-architecture-v4.md`（设计原理）
> **本文档定位**: 不是再讲一遍设计，而是给出行号级的具体改动清单

---

## 0. 前置背景

### 0.1 SkillForge V4 是什么

一个 11 层技能学习系统，让 Agent 能：
1. **录制**用户操作 → 序列化为 OpTrace
2. **抽象**为可参数化的 SkillTemplate（DAG + 参数 + 前置/后置条件）
3. **存储**到 MCP 风格的记忆库（remember/recall/search/rollback）
4. **匹配**新任务到已有技能（关键词 + 语义 + 工具模式）
5. **重放**执行（确定性 + LLM 生成 双模）
6. **优化**基于执行反馈（置信度衰减 + 错误驱动优化）

### 0.2 现有 agent-system 的技能系统状态

```
Phase 3 已有：
  ✅ src/skills/types.ts        — SkillMeta, SkillApply, SkillAuditResult 类型
  ✅ src/skills/registry.ts     — SkillRegistry (加载/注册/触发词匹配/去重)
  ✅ src/skills/gap-detector.ts — GapDetector (能力缺口感知)
  ✅ src/skills/pipeline.ts     — 审核→开发→测试→装备 流水线
  ✅ data/skills/*.json         — 3 个示例技能

Phase 3 缺失（SkillForge 要补的）：
  ❌ OpTrace 录制
  ❌ 技能模板（DAG + 参数化）
  ❌ 技能执行引擎
  ❌ MCP 记忆接口
  ❌ 语义匹配
  ❌ 前置/后置条件校验
  ❌ 双模执行（确定性 + LLM 生成）
  ❌ 任务分解→技能匹配
```

---

## 1. 文件变更清单

### 1.1 新增文件

| 文件 | 行数估算 | 作用 |
|------|---------|------|
| `src/skillforge/types.ts` | ~250 | 全部新类型定义 |
| `src/skillforge/recorder.ts` | ~150 | OpTrace 录制器 |
| `src/skillforge/abstractor.ts` | ~200 | Trace → SkillTemplate 转换 |
| `src/skillforge/library.ts` | ~180 | MCP 记忆接口 (remember/recall/search/rollback) |
| `src/skillforge/matcher.ts` | ~180 | 混合匹配器 (关键词+语义+工具模式) |
| `src/skillforge/engine.ts` | ~300 | 双模执行引擎 |
| `src/skillforge/parameterizer.ts` | ~120 | 参数化引擎 (5条判定规则) |
| `src/skillforge/conditions.ts` | ~100 | 前置/后置条件校验 |
| `src/skillforge/template-engine.ts` | ~80 | 安全模板引擎 |
| `src/skillforge/decomposer.ts` | ~120 | 任务分解→技能编排 |
| `src/skillforge/merger.ts` | ~150 | 跨 trace DAG 合并 |
| `src/skillforge/trigger-hub.ts` | ~120 | 调度触发器 |
| `src/skillforge/index.ts` | ~40 | 统一导出 |

**总计新增**: ~1,990 行 TypeScript

### 1.2 修改文件

| 文件 | 修改点 | 行数 |
|------|-------|------|
| `src/skills/types.ts` | 追加 import skillforge/types 并重新导出 | +3 |
| `src/core/orchestrator.ts` | 注入 SkillMatcher + SkillEngine | +30 |
| `src/core/task-decomposer.ts` | 调用 SkillForge Decomposer | +15 |
| `src/server/dashboard-api.ts` | 新增 /api/skills/* 端点 | +40 |
| `src/config.ts` | 新增 skillforge 配置节 | +20 |
| `package.json` | 无需新增依赖（sql.js 已有） | 0 |
| `tsconfig.json` | 无需修改 | 0 |

**总计修改**: ~108 行

---

## 2. 集成架构图

```
agent-system/
├── src/
│   ├── core/
│   │   ├── orchestrator.ts     ← [改] 注入 SkillMatcher + SkillEngine
│   │   ├── task-decomposer.ts  ← [改] 调用 skillforge/decomposer
│   │   └── ...
│   ├── skills/
│   │   ├── types.ts            ← [改] 追加导出
│   │   ├── registry.ts         ← (不变)
│   │   ├── gap-detector.ts     ← (不变)
│   │   └── pipeline.ts         ← (不变)
│   ├── skillforge/             ← [新] 全部在此
│   │   ├── types.ts
│   │   ├── recorder.ts
│   │   ├── abstractor.ts
│   │   ├── library.ts
│   │   ├── matcher.ts
│   │   ├── engine.ts
│   │   ├── parameterizer.ts
│   │   ├── conditions.ts
│   │   ├── template-engine.ts
│   │   ├── decomposer.ts
│   │   ├── merger.ts
│   │   ├── trigger-hub.ts
│   │   └── index.ts
│   ├── memory/
│   │   └── db-store.ts         ← (不变，新表由 library.ts 创建)
│   └── server/
│       └── dashboard-api.ts    ← [改] 新增 API 端点
├── data/
│   ├── skills/                 ← (现有，不变)
│   └── skillforge/             ← [新] SkillForge 数据目录
│       ├── traces/             ← OpTrace JSON 文件
│       ├── templates/          ← SkillTemplate JSON 文件
│       └── instances/          ← SkillInstance 运行时快照
```

---

## 3. 核心类型定义

### 3.1 `src/skillforge/types.ts` — 完整类型

```typescript
// ============================================================
// SkillForge 类型定义
// 融入 agent-system 项目，与现有 skills/types.ts 互补
// ============================================================

// ──── OpTrace (录制) ────

export interface OpStep {
  seq: number;                    // 步骤序号
  timestamp: number;              // Unix ms
  toolName: string;               // 调用的工具名
  input: Record<string, any>;     // 原始输入
  output: any;                    // 原始输出 (可截断)
  outputSummary?: string;         // 输出摘要 (LLM 生成)
  durationMs: number;             // 耗时
  success: boolean;               // 是否成功
  error?: string;                 // 错误信息
  context?: string;               // LLM 当时的思考/理由
}

export interface OpTrace {
  id: string;                     // trace_20260618_001
  sessionId: string;
  taskDescription: string;        // 用户原始请求
  steps: OpStep[];
  createdAt: number;
  metadata: {
    model: string;
    totalDurationMs: number;
    toolCallCount: number;
  };
}

// ──── SkillTemplate (技能模板) ────

export type ParamType = 'string' | 'number' | 'boolean' | 'path' | 'url' | 'enum' | 'json';

export interface ParameterDef {
  name: string;                   // 变量名
  type: ParamType;
  description: string;
  required: boolean;
  default?: any;
  enumValues?: string[];          // type=enum 时的候选值
  constraints?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;             // regex (用于 path/url)
  };
  // 参数来源提示
  deriveFrom?: 'user_input' | 'previous_output' | 'context' | 'config' | 'constant';
}

export interface Condition {
  type: 'field_exists' | 'field_not_null' | 'field_type' | 'field_in_range' | 'custom';
  field?: string;
  expectedType?: string;
  min?: number;
  max?: number;
  expression?: string;            // 安全模板表达式
  description: string;
}

export interface SkillStep {
  id: string;                     // 步骤唯一 ID
  name: string;                   // 人类可读名称
  description: string;
  toolName: string;               // 绑定的工具 (deterministic 模式)
  paramTemplate: Record<string, TemplateValue>;  // 参数模板
  dependencies: string[];         // 依赖的步骤 ID
  preconditions: Condition[];     // 前置条件
  postconditions: Condition[];    // 后置条件
  executionMode: 'deterministic' | 'generative';
  // generative 模式专用
  codeGenPrompt?: string;         // LLM 代码生成 prompt
  sandboxConfig?: {
    allowedModules: string[];
    maxRuntimeMs: number;
    networkAccess: boolean;
  };
  // 异常处理
  onPreconditionFail: 'abort' | 'skip' | 'retry_with_fix';
  onPostconditionFail: 'abort' | 'warn';
  onError: 'retry' | 'skip' | 'abort' | 'fallback_llm';
  retryCount: number;
  retryBackoffMs: number;
  isOptional: boolean;
}

export type TemplateValue =
  | { type: 'literal'; value: any }
  | { type: 'variable'; variableName: string; deriveFn?: string }
  | { type: 'template'; expression: string };   // 安全模板 ${varName}

export interface TriggerPattern {
  type: 'keyword' | 'semantic' | 'cron' | 'webhook' | 'event';
  value: string;                  // 关键词 / cron表达式 / webhook路径 / 事件类型
  weight: number;                 // 匹配权重
}

export interface SkillQuality {
  confidence: number;             // 0-1，衰减
  successRate: number;            // 0-1
  totalRuns: number;
  lastRunAt?: number;
  lastErrorAt?: number;
  lastErrorType?: string;
}

export interface SkillProvenance {
  source: 'recorded' | 'nl_generated' | 'capability_gap' | 'api_import' | 'manual';
  sourceTraceIds?: string[];      // 录制来源的 trace ID
  createdBy: string;              // 'agent' | 'user'
  createdAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
}

export interface SkillTemplate {
  id: string;                     // skill_xxx_v3
  name: string;
  version: string;                // semver
  description: string;
  category: string;               // file | search | data | media | system | ...
  triggers: TriggerPattern[];
  parameters: ParameterDef[];
  steps: SkillStep[];
  errorHandlers: ErrorHandler[];
  quality: SkillQuality;
  provenance: SkillProvenance;
  defaultRetryCount: number;
  timeoutMs: number;
  isReversible: boolean;
  status: 'draft' | 'review' | 'active' | 'disabled' | 'deprecated';
  tags: string[];
}

export interface ErrorHandler {
  onStep: string;                 // 监听步骤 ID
  onError: string;                // 错误类型 (支持 * 通配符)
  action: 'retry' | 'skip' | 'abort' | 'fallback_llm' | 'call';
  retryConfig?: {
    maxRetries: number;
    backoffMs: number;
    backoffMultiplier: number;
  };
  fallbackStepId?: string;        // call 动作的目标步骤
}

// ──── SkillInstance (运行时) ────

export interface SkillInstance {
  id: string;                     // instance_uuid
  templateId: string;
  templateVersion: string;
  boundParams: Record<string, any>;
  state: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  currentNodeId?: string;
  results: Record<string, any>;   // 步骤输出缓存
  errors: InstanceError[];
  startedAt: number;
  completedAt?: number;
}

export interface InstanceError {
  stepId: string;
  errorType: string;
  message: string;
  timestamp: number;
  handled: boolean;
  handlerAction?: string;
}

// ──── MCP 记忆接口 ────

export interface McpMemory {
  remember(skill: SkillTemplate): Promise<string>;
  recall(id: string): Promise<SkillTemplate | null>;
  forget(id: string): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  versions(name: string): Promise<VersionInfo[]>;
  rollback(id: string, version: string): Promise<SkillTemplate>;
  stats(): Promise<LibraryStats>;
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  tags?: string[];
  mode?: 'semantic' | 'keyword' | 'hybrid';
  excludeIds?: string[];
}

export interface SearchResult {
  template: SkillTemplate;
  score: number;
  matchType: 'semantic' | 'keyword' | 'tool_pattern' | 'trigger';
}

export interface VersionInfo {
  version: string;
  createdAt: number;
  description: string;
  confidence: number;
}

export interface LibraryStats {
  totalSkills: number;
  activeSkills: number;
  totalRuns: number;
  avgConfidence: number;
  byCategory: Record<string, number>;
}

// ──── 任务分解 ────

export interface SkillPlan {
  steps: PlanStep[];
  edges: { from: number; to: number; dataPass?: string[] }[];
}

export interface PlanStep {
  subtask: string;
  skillId: string | null;
  skillName?: string;
  matchScore?: number;
  boundParams: Record<string, any>;
  fallback?: string;              // 备选方案描述
}

// ──── 引擎配置 ────

export interface SkillForgeConfig {
  recorder: {
    enabled: boolean;
    maxTraceSteps: number;
    traceDir: string;
    redactSensitive: boolean;
    outputSummaryLimit: number;
  };
  abstractor: {
    autoTriggerConfidence: number;
    minTracesForMerge: number;
  };
  matcher: {
    topK: number;
    thresholds: { auto: number; suggest: number; min: number };
    weights: { semantic: number; keyword: number; toolPattern: number; recency: number };
  };
  engine: {
    maxRetries: number;
    timeoutPerStepMs: number;
    fallbackToLLM: boolean;
    cycleDetectionMaxVisits: number;
    maxParallelSteps: number;
  };
  library: {
    confidenceHalfLifeMs: number;
    minConfidenceToKeep: number;
    archiveAfterDays: number;
  };
}

export const DEFAULT_SKILLFORGE_CONFIG: SkillForgeConfig = {
  recorder: {
    enabled: true,
    maxTraceSteps: 200,
    traceDir: './data/skillforge/traces',
    redactSensitive: true,
    outputSummaryLimit: 500,
  },
  abstractor: {
    autoTriggerConfidence: 0.85,
    minTracesForMerge: 2,
  },
  matcher: {
    topK: 20,
    thresholds: { auto: 0.80, suggest: 0.60, min: 0.40 },
    weights: { semantic: 0.50, keyword: 0.25, toolPattern: 0.15, recency: 0.10 },
  },
  engine: {
    maxRetries: 2,
    timeoutPerStepMs: 30000,
    fallbackToLLM: true,
    cycleDetectionMaxVisits: 3,
    maxParallelSteps: 4,
  },
  library: {
    confidenceHalfLifeMs: 30 * 24 * 60 * 60 * 1000, // 30天
    minConfidenceToKeep: 0.1,
    archiveAfterDays: 60,
  },
};
```

---

## 4. 模块实现规范

### 4.1 `recorder.ts` — OpTrace 录制器

**职责**: 非侵入式包装 agent 的 tool call，记录输入/输出/上下文

```typescript
// 核心 API
export class SkillRecorder {
  constructor(config: SkillForgeConfig['recorder']);
  
  /** 开始一个录制会话 */
  startSession(taskDescription: string): string;  // 返回 sessionId
  
  /** 记录一次 tool call */
  recordStep(toolName: string, input: Record<string, any>, 
             output: any, durationMs: number, 
             success: boolean, context?: string): void;
  
  /** 结束会话，返回完整 OpTrace */
  endSession(): OpTrace;
  
  /** 保存 trace 到磁盘 */
  save(trace: OpTrace): string;  // 返回文件路径
  
  /** 列出所有 trace */
  list(): OpTrace[];
  
  /** 加载指定 trace */
  load(traceId: string): OpTrace | null;
  
  /** 脱敏敏感信息 (API key, token, password) */
  private redact(input: Record<string, any>): Record<string, any>;
}
```

**集成点 — `orchestrator.ts`** (在 executeStep 中插入):

```typescript
// orchestrator.ts 中 tool 执行循环：
// 在 toolRegistry.execute(name, args) 之前：
if (this.skillRecorder?.active) {
  startTime = Date.now();
}
const result = await toolRegistry.execute(name, args);
if (this.skillRecorder?.active) {
  this.skillRecorder.recordStep(name, args, result, 
    Date.now() - startTime, result.success, llmContext);
}
```

### 4.2 `abstractor.ts` — Trace → Template

**职责**: 将 OpTrace 转换为 SkillTemplate

```typescript
export class SkillAbstractor {
  constructor(config: SkillForgeConfig['abstractor']);
  
  /** 单条 trace → 线性模板 */
  abstract(trace: OpTrace): SkillTemplate;
  
  /** 多条 trace → 合并 DAG (有分支) */
  merge(traces: OpTrace[]): SkillTemplate;
  
  /** 参数化：将 literal 值转换为 ParameterDef + TemplateValue */
  private parameterize(steps: OpStep[], hints: ParamHints): {
    parameters: ParameterDef[];
    paramSteps: SkillStep[];
  };
}
```

**参数化五条规则** (parameterizer.ts):

```typescript
// 规则 1: 出现在用户原始 query 中 → 参数化 (置信度最高)
// 规则 2: 匹配文件路径模式 → inputPath/outputPath
// 规则 3: 匹配 URL 模式 → url/apiEndpoint
// 规则 4: 跨 trace 一致性 > 0.7 → 保留 literal
// 规则 5: 长度启发式 (< 20 非枚举 → 参数化; > 200 → 必参数化)

export function parameterizeValue(
  value: any, 
  hints: ParamHints
): TemplateValue {
  if (typeof value === 'string') {
    if (hints.appearsInQuery) 
      return { type: 'variable', variableName: hints.paramName };
    if (looksLikePath(value)) 
      return { type: 'variable', variableName: classifyPath(value) };
    if (looksLikeURL(value)) 
      return { type: 'variable', variableName: classifyURL(value) };
    if ((hints.crossTraceConsistency ?? 0) > 0.7) 
      return { type: 'literal', value };
    if (value.length > 200 || (value.length < 20 && !isKnownEnum(value)))
      return { type: 'variable', variableName: hints.paramName };
    return { type: 'literal', value };
  }
  if (typeof value === 'number') {
    if (hints.appearsInQuery && !isKnownConstant(value))
      return { type: 'variable', variableName: hints.paramName };
    return { type: 'literal', value };
  }
  return { type: 'literal', value };
}
```

### 4.3 `library.ts` — MCP 记忆接口

**职责**: 实现 MCP 四元接口，底层用 JSON 文件 + SQLite 索引

```typescript
export class SkillLibrary implements McpMemory {
  constructor(templatesDir: string, dbPath?: string);
  
  // MCP 接口
  async remember(skill: SkillTemplate): Promise<string>;
  async recall(id: string): Promise<SkillTemplate | null>;
  async forget(id: string): Promise<void>;
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  async versions(name: string): Promise<VersionInfo[]>;
  async rollback(id: string, version: string): Promise<SkillTemplate>;
  async stats(): Promise<LibraryStats>;
  
  // 内部方法
  private saveToFile(skill: SkillTemplate): void;
  private loadFromFile(id: string): SkillTemplate | null;
  private buildIndex(): void;          // 加载时构建内存索引
  private updateConfidence(skill: SkillTemplate): void;  // 衰减
}
```

**SQLite 表设计** (在 db-store 中新增):

```sql
CREATE TABLE IF NOT EXISTS skillforge_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  category TEXT,
  status TEXT DEFAULT 'draft',
  confidence REAL DEFAULT 1.0,
  success_rate REAL DEFAULT 0,
  total_runs INTEGER DEFAULT 0,
  triggers_json TEXT,           -- JSON array
  parameters_json TEXT,         -- JSON array
  tags_json TEXT,               -- JSON array
  source TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  archived INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sf_name ON skillforge_skills(name);
CREATE INDEX IF NOT EXISTS idx_sf_status ON skillforge_skills(status);
CREATE INDEX IF NOT EXISTS idx_sf_confidence ON skillforge_skills(confidence);

CREATE TABLE IF NOT EXISTS skillforge_runs (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  success INTEGER,
  duration_ms INTEGER,
  error_type TEXT,
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sfr_skill ON skillforge_runs(skill_id);
CREATE INDEX IF NOT EXISTS idx_sfr_time ON skillforge_runs(started_at);
```

### 4.4 `matcher.ts` — 混合匹配器

**职责**: 给定用户请求，找到最匹配的技能

```typescript
export class SkillMatcher {
  constructor(
    private library: SkillLibrary,
    private config: SkillForgeConfig['matcher']
  );
  
  /** 匹配用户意图到技能 */
  async match(
    userRequest: string, 
    availableTools: string[]
  ): Promise<MatchResult>;
  
  /** 混合评分: 语义 + 关键词 + 工具模式 + 时间衰减 */
  private score(
    template: SkillTemplate, 
    request: string, 
    tools: string[]
  ): number;
  
  /** 决策：auto(自动执行) / suggest(建议) / none(不匹配) */
  private decide(score: number): 'auto' | 'suggest' | 'none';
}

interface MatchResult {
  direct: SkillTemplate | null;      // auto 匹配 (score > 0.80)
  suggestions: SkillTemplate[];      // suggest 匹配 (0.60-0.80)
  allScores: { template: SkillTemplate; score: number }[];
}
```

**评分公式**:
```
score = 0.50 × semanticSimilarity(request, template.description)
      + 0.25 × keywordOverlap(request, template.triggers)
      + 0.15 × toolPatternMatch(availableTools, template.steps)
      + 0.10 × recencyBoost(template.quality.lastRunAt)
```

### 4.5 `engine.ts` — 双模执行引擎

**职责**: 按 DAG 拓扑序执行技能步骤，支持暂停/恢复/异常处理

```typescript
export class SkillEngine {
  constructor(
    private library: SkillLibrary,
    private config: SkillForgeConfig['engine']
  );
  
  /** 执行技能模板 */
  async execute(
    template: SkillTemplate,
    params: Record<string, any>
  ): Promise<ExecutionResult>;
  
  /** 恢复暂停的实例 */
  async resume(instanceId: string): Promise<ExecutionResult>;
  
  /** 暂停运行中的实例 */
  async pause(instanceId: string): Promise<void>;
  
  /** 获取实例状态 */
  getInstance(instanceId: string): SkillInstance | null;
  
  // 内部
  private async executeStep(
    step: SkillStep, 
    instance: SkillInstance
  ): Promise<StepResult>;
  
  private async executeDeterministic(
    step: SkillStep, 
    context: Record<string, any>
  ): Promise<any>;
  
  private async executeGenerative(
    step: SkillStep, 
    context: Record<string, any>
  ): Promise<any>;
  
  private checkPreconditions(step: SkillStep, context: Record<string, any>): boolean;
  private checkPostconditions(step: SkillStep, result: any): boolean;
  private handleStepError(error: Error, step: SkillStep, instance: SkillInstance): ErrorAction;
  private resolveTemplate(template: string, context: Record<string, any>): string;
}

type ExecutionResult = {
  success: boolean;
  instance: SkillInstance;
  outputs: Record<string, any>;
  errors: InstanceError[];
  durationMs: number;
};

type ErrorAction = 'retry' | 'skip' | 'abort' | 'fallback_llm' | 'call';
```

**DAG 执行算法** (Kahn 拓扑排序):

```typescript
private topologicalOrder(steps: SkillStep[]): string[][] {
  // 返回层级数组，同层可并行
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  
  for (const step of steps) {
    inDegree.set(step.id, step.dependencies.length);
    for (const dep of step.dependencies) {
      if (!adj.has(dep)) adj.set(dep, []);
      adj.get(dep)!.push(step.id);
    }
  }
  
  const levels: string[][] = [];
  let queue = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id);
  
  while (queue.length > 0) {
    levels.push([...queue]);
    const next: string[] = [];
    for (const id of queue) {
      for (const neighbor of (adj.get(id) || [])) {
        const d = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, d);
        if (d === 0) next.push(neighbor);
      }
    }
    queue = next;
  }
  
  return levels;
}
```

### 4.6 `merger.ts` — 跨 Trace 合并

**职责**: 使用 Needleman-Wunsch 序列比对，将多条 trace 合并为一个含分支的 DAG

```typescript
export class SkillMerger {
  constructor(private minTraces: number);
  
  /** 合并多条 trace */
  merge(traces: OpTrace[]): SkillTemplate;
  
  /** 序列比对 */
  private align(
    seqA: OpStep[], 
    seqB: OpStep[]
  ): AlignmentResult;
  
  /** 从比对结果构建 DAG */
  private buildDAG(
    alignment: AlignmentResult
  ): SkillStep[];
}

interface AlignmentResult {
  matches: [number, number][];       // [indexA, indexB] 匹配对
  divergentA: number[];              // 仅在 A 中的 index
  divergentB: number[];              // 仅在 B 中的 index
  divergentVariables: string[];      // 导致分叉的变量
}
```

### 4.7 `decomposer.ts` — 任务分解

**职责**: 将复杂用户请求分解为子任务，每个子任务匹配一个技能

```typescript
export class SkillDecomposer {
  constructor(
    private matcher: SkillMatcher,
    private library: SkillLibrary
  );
  
  /** 分解任务并匹配技能 */
  async decompose(request: string): Promise<SkillPlan>;
  
  /** 判断是否需要分解 (vs 直接匹配单个技能) */
  needsDecomposition(request: string): boolean;
}
```

**分解逻辑**:
```
输入: "分析这个CSV数据，生成可视化图表，然后发邮件给团队"

输出 SkillPlan:
  steps[0]: { subtask: "分析CSV数据", skillId: "data_analysis_v1", matchScore: 0.82 }
  steps[1]: { subtask: "生成可视化图表", skillId: "chart_generation_v2", matchScore: 0.75,
              boundParams: { data: "${steps[0].cleaned_data}" } }
  steps[2]: { subtask: "发送邮件", skillId: "send_email_v1", matchScore: 0.90,
              boundParams: { attachment: "${steps[1].report_path}" } }
  edges: [0→1, 1→2]
```

### 4.8 `trigger-hub.ts` — 调度触发器

**职责**: 管理技能的定时/事件触发

```typescript
export class TriggerHub {
  /** 注册触发器 */
  register(skillId: string, trigger: TriggerPattern, handler: () => Promise<void>): void;
  
  /** 取消注册 */
  unregister(skillId: string): void;
  
  /** 启动调度器 */
  start(): void;
  
  /** 停止调度器 */
  stop(): void;
  
  /** 手动触发 */
  async trigger(skillId: string, params?: Record<string, any>): Promise<void>;
  
  // 内部
  private cronJobs: Map<string, NodeJS.Timeout>;
  private lastRun: Map<string, number>;
  private isDuplicate(skillId: string, windowMs: number): boolean;
}
```

### 4.9 `conditions.ts` — 条件校验

```typescript
export class ConditionChecker {
  /** 校验前置条件 */
  static checkPreconditions(
    conditions: Condition[], 
    context: Record<string, any>
  ): { passed: boolean; failures: string[] };
  
  /** 校验后置条件 */
  static checkPostconditions(
    conditions: Condition[], 
    result: any
  ): { passed: boolean; failures: string[] };
  
  /** 评估单个条件 */
  private static evaluate(
    condition: Condition, 
    context: Record<string, any>
  ): boolean;
}
```

---

## 5. 集成点具体代码

### 5.1 `orchestrator.ts` 修改

```typescript
// === 在文件顶部新增导入 ===
import { SkillRecorder } from '../skillforge/recorder';
import { SkillMatcher } from '../skillforge/matcher';
import { SkillEngine } from '../skillforge/engine';
import { SkillLibrary } from '../skillforge/library';
import { SkillDecomposer } from '../skillforge/decomposer';
import { DEFAULT_SKILLFORGE_CONFIG } from '../skillforge/types';
import type { SkillForgeConfig } from '../skillforge/types';

// === 在 OrchestratorConfig 中新增 ===
export interface OrchestratorConfig {
  // ... 现有字段 ...
  skillforge?: SkillForgeConfig;  // 新增
}

// === 在 Orchestrator 类中新增字段 ===
export class Orchestrator extends EventEmitter {
  // ... 现有字段 ...
  
  // SkillForge 组件
  private skillRecorder: SkillRecorder | null = null;
  private skillMatcher: SkillMatcher | null = null;
  private skillEngine: SkillEngine | null = null;
  private skillLibrary: SkillLibrary | null = null;
  private skillDecomposer: SkillDecomposer | null = null;
  private skillforgeEnabled: boolean;
  
  // === 在 constructor 中初始化 ===
  constructor(config?: Partial<OrchestratorConfig>) {
    // ... 现有初始化 ...
    
    // SkillForge 初始化
    const sfConfig = config?.skillforge ?? DEFAULT_SKILLFORGE_CONFIG;
    this.skillforgeEnabled = sfConfig.recorder.enabled;
    
    if (this.skillforgeEnabled) {
      this.skillLibrary = new SkillLibrary('./data/skillforge/templates');
      this.skillRecorder = new SkillRecorder(sfConfig.recorder);
      this.skillMatcher = new SkillMatcher(this.skillLibrary, sfConfig.matcher);
      this.skillEngine = new SkillEngine(this.skillLibrary, sfConfig.engine);
      this.skillDecomposer = new SkillDecomposer(this.skillMatcher, this.skillLibrary);
      logger.info('[SkillForge] 已启用');
    }
  }
  
  // === 新增方法: 处理用户请求时先尝试技能匹配 ===
  async trySkillMatch(userRequest: string): Promise<{
    matched: boolean;
    result?: ExecutionResult;
    suggestions?: SkillTemplate[];
  }> {
    if (!this.skillforgeEnabled || !this.skillMatcher) {
      return { matched: false };
    }
    
    const matchResult = await this.skillMatcher.match(
      userRequest, 
      this.getAvailableTools()
    );
    
    // auto: 自动执行
    if (matchResult.direct) {
      logger.info(`[SkillForge] 🎯 自动匹配: ${matchResult.direct.name}`);
      const result = await this.skillEngine!.execute(
        matchResult.direct,
        {}  // params 由 engine 从上下文推断
      );
      return { matched: true, result };
    }
    
    // suggest: 返回建议
    if (matchResult.suggestions.length > 0) {
      logger.info(`[SkillForge] 💡 建议 ${matchResult.suggestions.length} 个技能`);
      return { matched: true, suggestions: matchResult.suggestions };
    }
    
    return { matched: false };
  }
  
  // 在 tool 执行循环中插入录制
  private getAvailableTools(): string[] {
    return toolRegistry.list().map(t => t.name);
  }
}
```

### 5.2 `dashboard-api.ts` 新增端点

```typescript
// 新增以下 API 路由:

// GET  /api/skills           — 列出所有技能模板
// GET  /api/skills/:id       — 获取技能详情
// POST /api/skills/review    — 审核技能 (approve/reject)
// GET  /api/skills/search?q= — 搜索技能
// GET  /api/skills/traces    — 列出所有录制 trace
// GET  /api/skills/traces/:id— 获取 trace 详情
// POST /api/skills/abstract  — 从 trace 生成技能模板
// POST /api/skills/execute   — 手动执行技能
// GET  /api/skills/instances — 列出运行中的实例
// GET  /api/skills/stats     — 技能统计
```

### 5.3 `config.ts` 新增配置节

```typescript
// 在 config/default.json 中新增:
{
  "skillforge": {
    "recorder": {
      "enabled": true,
      "maxTraceSteps": 200,
      "traceDir": "./data/skillforge/traces",
      "redactSensitive": true,
      "outputSummaryLimit": 500
    },
    "matcher": {
      "topK": 20,
      "thresholds": { "auto": 0.80, "suggest": 0.60, "min": 0.40 },
      "weights": { "semantic": 0.50, "keyword": 0.25, "toolPattern": 0.15, "recency": 0.10 }
    },
    "engine": {
      "maxRetries": 2,
      "timeoutPerStepMs": 30000,
      "fallbackToLLM": true,
      "cycleDetectionMaxVisits": 3,
      "maxParallelSteps": 4
    },
    "library": {
      "confidenceHalfLifeMs": 2592000000,
      "minConfidenceToKeep": 0.1,
      "archiveAfterDays": 60
    }
  }
}
```

---

## 6. 构建顺序（严格）

### Phase 1 — 核心数据层 (先跑通存储和类型)
```
1. src/skillforge/types.ts        ← 所有类型定义
2. src/skillforge/template-engine.ts ← 安全模板解析
3. src/skillforge/library.ts      ← MCP 记忆接口 (依赖 types)
4. src/skillforge/conditions.ts   ← 前置/后置条件校验
5. src/skillforge/index.ts        ← 统一导出
```
**验证**: `library.remember(template)` → `library.recall(id)` → `library.search(query)` 能跑通

### Phase 2 — 录制与抽象
```
6. src/skillforge/recorder.ts     ← 录制 tool call
7. src/skillforge/parameterizer.ts ← 参数化引擎
8. src/skillforge/abstractor.ts   ← Trace → Template
```
**验证**: 模拟一条 trace → abstractor 生成模板 → 存入 library

### Phase 3 — 执行引擎
```
9. src/skillforge/engine.ts       ← 双模执行 (依赖 conditions + template-engine)
```
**验证**: 手动创建一个简单模板 → engine.execute() → 步骤按序执行

### Phase 4 — 匹配与编排
```
10. src/skillforge/matcher.ts     ← 匹配器
11. src/skillforge/decomposer.ts  ← 任务分解
12. src/skillforge/merger.ts      ← 跨 trace 合并
```
**验证**: `decomposer.decompose("分析CSV并生成图表")` → 输出 SkillPlan

### Phase 5 — 集成与调度
```
13. src/skillforge/trigger-hub.ts ← 触发器
14. src/core/orchestrator.ts      ← [修改] 注入 SkillForge
15. src/server/dashboard-api.ts   ← [修改] 新增 API
16. src/config.ts                 ← [修改] 新增配置
```
**验证**: 端到端 — 用户请求 → 匹配 → 执行 → 录制 → 优化

---

## 7. 验证清单

每个 Phase 完成后的验收测试：

### Phase 1 验收
```bash
npx ts-node -e "
const lib = new SkillLibrary('./data/skillforge/templates');
await lib.remember({ id: 'test_skill_v1', name: 'Test', ... });
const result = await lib.recall('test_skill_v1');
console.assert(result.name === 'Test', 'remember/recall 失败');
const stats = await lib.stats();
console.assert(stats.totalSkills === 1, 'stats 失败');
console.log('✅ Phase 1 通过');
"
```

### Phase 2 验收
```bash
npx ts-node -e "
// 模拟 trace → 生成模板
const trace = { id: 'trace_001', steps: [
  { toolName: 'web_search', input: { keyword: '北京天气' }, output: {...} },
  { toolName: 'write', input: { path: 'report.txt', content: '...' }, output: {...} }
]};
const abstractor = new SkillAbstractor({...});
const template = abstractor.abstract(trace);
console.assert(template.steps.length === 2, '步骤数不对');
console.assert(template.parameters.some(p => p.name === 'keyword'), '参数化失败');
console.log('✅ Phase 2 通过');
"
```

### Phase 3 验收
```bash
npx ts-node -e "
const engine = new SkillEngine(lib, config);
const result = await engine.execute(template, { keyword: '上海天气' });
console.assert(result.success, '执行失败');
console.log('✅ Phase 3 通过');
"
```

### Phase 4 验收
```bash
npx ts-node -e "
const matcher = new SkillMatcher(lib, config.matcher);
const result = await matcher.match('帮我查一下深圳天气', ['web_search', 'write']);
console.assert(result.direct !== null || result.suggestions.length > 0, '无匹配');
console.log('✅ Phase 4 通过');
"
```

---

## 8. 与现有代码的关系

| 现有模块 | SkillForge 替代/增强 | 策略 |
|---------|---------------------|------|
| `SkillMeta` | `SkillTemplate` | **共存** — SkillMeta 用于现有简单技能，SkillTemplate 用于 SkillForge 管理的复杂技能 |
| `SkillRegistry` | `SkillLibrary` | **互补** — Registry 管理"已装备"的技能实例，Library 管理"模板+版本"的知识库 |
| `GapDetector` | 无变化 | **增强** — GapDetector 检测到的缺口，由 SkillForge 的 CapabilityGap 路径生成技能 |
| `SkillPipeline` | Human Review Gate | **替换审计环节** — 现有 pipeline 的 audit→develop→test→equip 流程，其中的 develop 步骤改为走 SkillForge 的 SkillFactory |
| `TaskDecomposer` | `SkillDecomposer` | **增强** — 现有分解为子任务 DAG，增强为可匹配技能的子任务 DAG |

---

## 9. 数据流全链路

```
用户请求
  │
  ├─→ SkillMatcher.match(request)           // 查技能库
  │   ├─ auto → SkillEngine.execute()       // 直接执行
  │   ├─ suggest → 返回建议                 // 展示给用户
  │   └─ none → 现有流程                    // 走 orchestator 正常处理
  │
  ├─→ SkillDecomposer.decompose(request)    // 复杂请求
  │   └─→ SkillPlan → SkillEngine.execute(plan)
  │
  └─→ 执行过程中：
      ├─ SkillRecorder.recordStep()         // 记录每一步
      ├─ ConditionChecker.checkPre()        // 前置校验
      ├─ ConditionChecker.checkPost()       // 后置校验
      └─ SkillEngine.handleError()          // 异常处理
      
  执行完成后：
      ├─ SkillRecorder.save(trace)          // 保存原始录制
      ├─ SkillLibrary.remember(template)    // 更新执行统计
      └─ GapDetector.detect()              // 检测新缺口
```

---

## 10. 开发注意事项

1. **编码**：所有 `.ts` 文件 UTF-8，与项目现有保持一致
2. **导入路径**：使用相对路径 `../skillforge/xxx` 而非别名
3. **日志**：使用项目已有的 `logger` (winston)，tag 用 `[SkillForge]`
4. **错误处理**：不抛未捕获异常，所有 async 函数返回 `{ success, data?, error? }` 结构
5. **依赖**：不新增 npm 包（sql.js 已有用于向量计算，TS 标准库足够）
6. **测试**：每个模块写独立验证脚本（不需要 jest，直接用 `npx ts-node` 跑）
7. **数据目录**：`data/skillforge/` 需要在首次运行时自动创建
8. **向后兼容**：SkillForge 通过 config 开关控制，`enabled: false` 时完全不加载
