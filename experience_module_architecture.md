# Experience Module — 经验模块架构设计

> 版本: v1.0 | 创建: 2026-06-21 | 状态: 设计完成，待实施

## 一、为什么需要经验模块

### 现状问题

项目已有四层知识子系统，但各自独立，缺少跨层的经验提取和复用：

| 子系统 | 回答的问题 | 局限 |
|--------|-----------|------|
| 记忆层 (db-store / file-store) | 发生了什么？ | 原始日志，不可复用 |
| 技能层 (skills/registry) | 怎么做？ | 静态能力封装，不自动改进 |
| 模型画像 (break-in-machine) | 模型表现如何？ | 针对模型，不针对任务 |
| 摘要层 (summarizer) | 聊了什么？ | 会话级摘要，非可复用经验 |

**核心缺失**：没有"什么场景下，怎么做更好"的经验积累。同样的坑会踩两次，同样的解法不会自动复用。

### 经验 vs 现有子系统的区别

| 维度 | 记忆 | 技能 | 经验 |
|------|------|------|------|
| 本质 | 事件日志 | 程序性知识 | 情境性知识 |
| 内容 | 发生了什么 | 怎么调用工具 | 什么场景怎么做更好 |
| 来源 | 自动记录 | 手动定义 | 从成功/失败中提取 |
| 复用 | 不复用 | 主动调用 | 自动推荐/注入 |
| 改进 | 不改进 | 手动更新 | 自动评分衰减 |

---

## 二、架构设计

### 数据流

```
[任务成功] ──┐
[任务失败] ──┼──→ ExperienceExtractor ──→ ExperienceStore ──→ ExperienceRetriever ──→ PromptAssembler
[用户反馈] ──┘     (LLM辅助提取)           (SQLite+MD)         (标签+关键词匹配)       (experienceBlock注入)
```

### 四个核心组件

#### 1. ExperienceExtractor（经验提取器）

**职责**：从任务执行结果中提取结构化经验

**触发时机**：
- 任务成功完成时（outcome=success）
- 任务失败/重试后（outcome=failure）
- 用户显式反馈时（source=feedback，如"这样更好"、"不对"）

**提取方式**：
- LLM 辅助提取：将任务上下文（用户输入 + 执行过程 + 结果）发给 LLM，要求输出结构化 JSON
- 规则引擎兜底：LLM 不可用时，从 `summarizer` 的 `keyDecisions` 和 `learnedFacts` 中转换

**输出**：ExperienceRecord

#### 2. ExperienceStore（经验存储）

**职责**：持久化经验，支持高效检索

**存储双层**：
- **结构化层**：`data/experiences.db`（SQLite）
  - experiences 表：完整结构化字段
  - experience_tags 表：标签倒排索引
  - 支持按 tags / scenario / outcome / score 查询
- **可读层**：`data/experiences/*.md`（人类可读）
  - 每条经验一个 .md 文件，带 YAML frontmatter
  - 便于人工审查和编辑

#### 3. ExperienceRetriever（经验检索器）

**职责**：根据当前用户输入，找到 Top-K 最相关的经验

**检索策略**（三层，逐层降级）：
1. **标签匹配**：用户输入命中经验的 tags → 精确匹配
2. **关键词匹配**：用户输入分词后与 scenario + problem 匹配 → 模糊匹配
3. **语义匹配**（可选，需要 embedding）：余弦相似度 > 阈值

**排序**：按 score 降序（score = baseScore × decay × successRate）

**返回**：Top-K（默认 K=3）条经验，格式化为可注入的文本块

#### 4. ExperienceInjector（经验注入器）

**职责**：将检索到的经验注入到 PromptAssembler 的消息流中

**注入位置**（在 PromptAssembler 中新增）：
```
[0] system     ← agent.identity
[1] user       ← memory block（跨会话记忆）
[2] assistant  ← "好的，我已了解历史背景。"
[3] user       ← [相关经验] block（新增）       ← 经验注入在这里
[4] assistant  ← "好的，我已了解相关经验。"
[5+] user/asst ← 历史对话
[N] user       ← 当前用户输入
```

**注入格式**：
```
[相关经验]
1. [pattern] 场景：LM Studio 超时
   问题：模型响应超过 60 秒
   解法：SmartAdapter 自动重试，最多 5 次
   原因：本地推理慢，重试可覆盖偶发卡顿
   评分：0.85 (复用 3 次，成功 3 次)

2. [pitfall] 场景：TypeScript 编译报错
   问题：import 路径大小写不一致
   解法：统一用小写路径
   原因：Windows 文件系统不区分大小写，Linux 区分
   评分：0.72 (复用 2 次，成功 2 次)
```

---

## 三、数据模型

### ExperienceRecord

```typescript
interface ExperienceRecord {
  // 标识
  id: number;                    // 自增主键
  createdAt: string;             // 创建时间 (ISO)
  sessionId: string;             // 来源会话
  source: 'auto' | 'user' | 'feedback';  // 经验来源

  // 场景上下文
  scenario: string;              // 什么场景（如"LM Studio 超时"）
  tags: string[];                // 检索标签（如["timeout", "lmstudio", "retry"]）
  project?: string;              // 关联项目
  modelUsed?: string;            // 使用的模型

  // 问题 + 解法
  problem: string;               // 遇到什么问题
  solution: string;              // 怎么解决的
  reasoning: string;             // 为什么有效
  codeSnippet?: string;          // 关键代码片段（可选）

  // 结果 + 类型
  outcome: 'success' | 'failure';
  type: 'pattern' | 'pitfall' | 'tip';
  // pattern: 成功模式（这么做有效）
  // pitfall: 踩坑教训（这么做会出问题）
  // tip: 通用建议

  // 有效性追踪
  reuseCount: number;            // 被推荐次数
  successCount: number;          // 推荐后任务成功
  failCount: number;             // 推荐后任务失败
  score: number;                 // 综合评分 (0-1)

  // 生命周期
  lastUsed: string;              // 上次被推荐时间
  updatedAt: string;             // 最后更新时间
  status: 'active' | 'deprecated';
  deprecatedReason?: string;     // 废弃原因
}
```

### 评分公式

```
score = baseScore × decay(lastUsed) × successRate

baseScore:
  success → 1.0
  failure → 0.8  (教训也有价值)

decay(lastUsed):
  30 天内  → 1.0
  90 天内  → 0.7
  之后     → 0.4  (过时经验降权但不删除)

successRate:
  = successCount / max(reuseCount, 1)
  首次创建时 reuseCount=0, successRate=1.0 (给予初始信任)
```

---

## 四、数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  session_id TEXT DEFAULT '',
  source TEXT DEFAULT 'auto',

  scenario TEXT NOT NULL,
  tags TEXT DEFAULT '[]',        -- JSON array
  project TEXT DEFAULT '',
  model_used TEXT DEFAULT '',

  problem TEXT NOT NULL,
  solution TEXT NOT NULL,
  reasoning TEXT DEFAULT '',
  code_snippet TEXT DEFAULT '',

  outcome TEXT NOT NULL,         -- 'success' | 'failure'
  type TEXT NOT NULL,            -- 'pattern' | 'pitfall' | 'tip'

  reuse_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  score REAL DEFAULT 1.0,

  last_used TEXT DEFAULT '',
  updated_at TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  deprecated_reason TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_exp_tags ON experiences(tags);
CREATE INDEX IF NOT EXISTS idx_exp_score ON experiences(score DESC);
CREATE INDEX IF NOT EXISTS idx_exp_scenario ON experiences(scenario);
CREATE INDEX IF NOT EXISTS idx_exp_status ON experiences(status);
```

---

## 五、文件结构

```
src/
  experience/
    types.ts              # ExperienceRecord 接口定义
    extractor.ts          # ExperienceExtractor — 经验提取器
    store.ts              # ExperienceStore — SQLite + MD 存储
    retriever.ts          # ExperienceRetriever — 检索器
    index.ts              # barrel export

config/
  prompts/
    experience.extract.md # 经验提取的 LLM 提示词模板

data/
  experiences.db          # SQLite 数据库
  experiences/            # 人类可读的 MD 文件
    exp_001.md
    exp_002.md
    ...
```

---

## 六、与现有系统的集成点

### 1. agent-core.ts

**init()**：
- 初始化 ExperienceStore（加载数据库）
- 初始化 ExperienceRetriever

**handleChat()**：
- 在 PromptAssembler.assemble() 之前，调用 `retriever.retrieve(userInput)` 获取 Top-K 经验
- 将经验文本作为 `experienceBlock` 传给 assembler

**任务完成后**：
- 调用 `extractor.extract(taskContext, outcome)` 提取经验
- 调用 `store.save(record)` 持久化

### 2. PromptAssembler

**AssembleOptions 新增**：
```typescript
interface AssembleOptions {
  // ... 已有字段
  experienceBlock?: string;  // 相关经验文本块
}
```

**组装顺序更新**：
```
system → memoryBlock(user) → experienceBlock(user) → context → userInput
```

### 3. PromptRegistry

新增模板 `experience.extract`：
```markdown
---
version: "1.0.0"
taskType: experience_extract
---
You are an experience extractor. Analyze the task execution below and extract a structured experience record.

Return ONLY a JSON object:
{
  "scenario": "简短场景描述",
  "problem": "遇到了什么问题",
  "solution": "怎么解决的",
  "reasoning": "为什么有效",
  "tags": ["tag1", "tag2"],
  "type": "pattern | pitfall | tip"
}
```

### 4. agent.identity.md 更新

在 Section 2（能力清单）中新增：
```
- Experience store (cross-session, auto-extracted patterns and pitfalls)
```

在 Section 3（记忆检索指引）中新增：
```
- Relevant experiences: injected automatically as [相关经验] block
  (no need to search manually — top matches are provided each turn)
```

---

## 七、实施计划

### Phase 1: 基础设施（核心存储 + 数据模型）
- [ ] 创建 `src/experience/types.ts`（ExperienceRecord 接口）
- [ ] 创建 `src/experience/store.ts`（SQLite 存储层）
- [ ] 创建 `data/experiences/` 目录
- [ ] 在 agent-core init() 中初始化

### Phase 2: 经验提取
- [ ] 创建 `config/prompts/experience.extract.md`
- [ ] 创建 `src/experience/extractor.ts`
- [ ] 在 agent-core 任务完成后接入提取
- [ ] 支持手动提取命令 `/experience save`

### Phase 3: 经验检索 + 注入
- [ ] 创建 `src/experience/retriever.ts`
- [ ] 改造 PromptAssembler 支持 experienceBlock
- [ ] 在 agent-core handleChat() 中接入检索
- [ ] 更新 agent.identity.md

### Phase 4: 经验管理
- [ ] 命令 `/experience list` — 列出经验
- [ ] 命令 `/experience search <keyword>` — 搜索经验
- [ ] 命令 `/experience deprecate <id>` — 废弃经验
- [ ] 经验评分衰减定时任务

---

## 八、Token 开销评估

| 场景 | 注入条数 | 每条长度 | 总增量 |
|------|---------|---------|--------|
| 常规对话 | 0-1 条 | ~150 chars | 0-50 tokens |
| 相似问题 | 2-3 条 | ~150 chars | 100-150 tokens |
| 无匹配 | 0 条 | 0 | 0 |

经验注入是**条件性**的（有匹配才注入），不像 memory block 每轮都注入。整体 token 开销可控。

---

## 九、设计决策记录

### 为什么用 SQLite 而不是纯文件

- 需要按 tags / score / scenario 高效查询，文件遍历太慢
- 经验量可能增长到数百条，需要索引
- 已有 db-store.ts 使用 sql.js，技术栈一致

### 为什么经验注入在 memory block 之后

- memory block 是跨会话记忆（长期上下文），优先级更高
- experience block 是情境性建议（当前相关），优先级次之
- 两者都以 user 角色注入，不污染 system

### 为什么不直接复用 summarizer 的 learnedFacts

- learnedFacts 是简单字符串（如"完成了记忆系统"），不是结构化经验
- 缺少 scenario / solution / reasoning / score 字段
- 不可检索、不可评分、不可衰减
- 但 summarizer 可以作为经验提取的**输入信号**之一

### 为什么评分要衰减

- 技术栈会变（如依赖版本升级后，旧经验可能失效）
- 近期经验更可靠
- 衰减但不删除——旧经验仍可被搜索到，只是排序靠后
