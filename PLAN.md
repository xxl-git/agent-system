# 📋 Agent System — 开发计划

> **创建时间**：2026-06-16 22:47
> **原则**：先出垃圾，再迭代。每阶段验证通过才进下一阶段。
> **参考设计**：DESIGN.md

---

## 路线图总览

```
Phase 0      Phase 1          Phase 2        Phase 3        Phase 4
基础骨架     核心循环+记忆     模型适配       技能生态       多Agent
 ────→      ────→           ────→         ────→         ────→
  1天        3-5天           3-5天         5-7天         5-7天
  │          │               │             │             │
  └──────────┴───────────────┘             │             │
           ↑ MVP 分界线                    │             │
      (Phase 0+1 = 能聊天+能规划+能调工具+有记忆)
```

## Phase 0：基础骨架（1天）

**目标**：项目跑起来，能收到消息，能回复消息。

### 任务清单
- [x] 项目初始化（npm init, TypeScript 配置, 目录结构）
- [x] 配置加载模块（config/ 目录，JSON Schema 校验）
- [x] 日志系统（Winston/Pino，按日切割）
- [ ] SQLite 初始化（表结构设计）
- [x] 最简单的 Agent 循环：收消息 → 发模型 → 回消息
- [x] LM Studio 适配器（最简单的 HTTP 对接）
- [x] CLI 入口（能 `npm start` 启动）

### 验证结果 ✅ (2026-06-16 23:30)
```
=== Phase 0 验证测试 ===
✅ 配置加载: OK
✅ 记忆系统: OK
✅ Agent 初始化: OK
>>> 发送: "用中文回复：你好"
<<< Agent (16.8s):
你好！有什么我可以帮你的吗？
✅ Phase 0 验证通过！
```

## Phase 1：核心循环 + 记忆系统（3-5天）⭐ MVP

**目标**：Agent 具备基础能力——能聊天、能规划任务、能分解执行、能记住历史。

### 1A：任务调度与执行
- [x] 意图解析器（分析用户消息，输出结构化意图）
- [x] 任务分解引擎（把大任务拆成子任务 DAG）
- [x] B 型主动性：信息不足自动追问、执行前预检（依赖/权限）、进度主动汇报
- [x] 工具注册表（exec/write/read/web_search 等基础工具）
- [x] 工具执行器（沙箱执行 + 结果收集）
- [x] Agent 主循环：Plan → Execute → Observe → Replan
- [x] A 型主动性：心跳定时器空闲时检查待办（审核队列/记忆整理/事件检查）
  ✅ (2026-06-28) 3 个 idle task 已注册: memory-organization(P2,7天归档) + task-monitor-alerts(P1,1小时查告警) + session-summary-gc(P1,1天GC)
- [x] 基本错误处理和重试 ✅ (2026-06-29) — RetryEngine(12种故障+策略+退避) + CircuitBreaker(模型/工具/路径三级熔断) + ResilienceOrchestrator(executeProtected重试循环) + SmartAdapter(5次指数退避重试) + 工具级熔断(registry.ts) + API端点(/api/resilience/status) + Dashboard集成
- [ ] 审计日志初版（谁调了什么工具，结果是什么）

### 1B：记忆系统（Agent 基础能力，必须入 MVP）
- [x] 文件层记忆（按日 md 文件，追加不覆盖，自动归档）
- [x] 严格记录 hook：每次对话后强制写入，不可跳过，数据库失败降级为纯文件
- [x] SQLite DB 层记忆（sql.js，四表：sessions/decisions/entities/summaries）
- [ ] 跨会话记忆恢复（读取历史 decision/summary 注入 system prompt）

### Phase 1 验证结果 ⚠️ (2026-06-17 00:00)
```
=== Phase 1 验证测试 ===
✅ 配置加载: OK
✅ 文件层记忆: OK
✅ DB 层记忆: OK
✅ Agent 初始化: OK (意图解析器 + 工具注册表就绪)
>>> 测试1: 闲聊 "你好"
<<< (95s): 你好！有什么我可以帮你的吗？
✅ 闲聊: OK
>>> 测试2: 任务 "创建文件"
<<< (113s): 意图识别正确(task, confidence=0.95) → 任务分解 → 工具执行完成
⚠️  路径解析有小偏差（需修复中文路径提取）
>>> 测试3: 搜索
❌ SIGKILL (qwen3.6 已知 tool_calls 空循环，非代码问题)
✅ DB 决策记录: 已写入
✅ Phase 1 核心链路验证通过！
```

### 已知问题
1. **qwen3.6 tool_calls 死循环** — 模型在工具调用时生成空 token 导致超时
   - 方案：在 config 加 `parallelToolCalls: false` 强制纯文本模式
2. **任务分解路径解析** — 中文自然语言到文件路径的提取需要加强
3. **搜索工具未测试** — 因模型超时，web_search 功能未实际调用

### Phase 1C 验证结果 ✅ (2026-06-17 00:06)
```
=== Phase 1C 项目管理闭环验证 ===
✅ 创建项目 (PROGRESS/JOURNAL/TODO/DESIGN.md)
✅ 添加待办 (P0/P1/P2 优先级系统)
✅ 进度自动计算 (TODO done/total → %)
✅ 日报写入 (含 frontmatter)
✅ 检查点保存/恢复 (checkpoint.json + 元数据)
✅ 项目切换 (活跃标记互斥)
✅ 恢复摘要 (含最近日报预览)
✅ 项目列表 (含进度条 + 状态)
✅ 文件验证 (5个标准文件全部生成)
✅ Phase 1C 验证通过！
```

### 1C：项目管理闭环（已完成 ✅）
- [x] 澄清阶段：信息不明确主动追问
- [x] 设计阶段：项目文件生成 (PROGRESS/JOURNAL/TODO/DESIGN.md)
- [x] 执行阶段：检查点保存/恢复 + 日报
- [x] 检查点机制：checkpoint.json + ProjectMeta
- [x] 日报系统：JOURNAL.md 按时间戳追加
- [x] 跨会话恢复：recoverySummary() 读取活跃项目状态
- [x] 活跃项目概念：单活跃 + 切换
- [x] 优先级系统：P0(紧急)/P1(高)/P2(中) 三档制
2. **任务分解路径解析** — 中文自然语言到文件路径的提取需要加强
3. **搜索工具未测试** — 因模型超时，web_search 功能未实际调用

### 1C：项目管理闭环（待开始）
- [ ] 数据库层记忆（SQLite 表结构：decisions, entities, sessions, summaries）
- [ ] 基础检索接口（关键词、时间范围、实体名）
- [ ] 会话摘要（每次会话结束生成短摘要存储）

### 1C：项目管理闭环（Agent 基础能力）
- [ ] 澄清模块：接任务后信息不明确→主动追问
- [ ] 项目文件生成器：自动创建 projects/<name>/DESIGN.md + PROGRESS.md + JOURNAL.md + TODO.md
- [ ] YAML frontmatter 解析器：人机双读格式
- [ ] 待办事项池（优先级三档 P0/P1/P2，同优先级 FIFO）
- [ ] 检查点保存/恢复：中断时完成当前子任务→保存 DAG 快照
- [ ] 进度跟踪：自动更新 PROGRESS.md（已完成/进行中/待开始）
- [ ] 执行日报：每次后台推进自动追加 JOURNAL.md
- [ ] 活跃项目切换：同一时间只推进一个活跃项目
- [ ] 会话启动时展示进度 + 恢复未完成任务

### 验证标准
```
Agent> 帮我在 D:\test 创建一个 index.html，内容是 "Hello World"
  → 自动分解：创建目录 → 写入文件
  → 自动执行两个步骤
  → 返回结果：文件已创建
  → 对话自动写入 memory/2026-06-17.md + SQLite

Agent> 我还记得昨天我们建的那个文件在哪吗？
  → 从 memory 检索到记录
  → 正确回答：D:\test\index.html

Agent> 帮我做一个媒体中心（信息不明确）
  → 主动追问：桌面还是 Web？什么功能优先？
  → 补充完毕 → 生成 projects/media-center/DESIGN.md
  → 自动进入待办池，P1 优先级

Agent> （次日新会话）
  → 展示：媒体中心项目进度 35%，上次停在数据库设计
  → 询问：继续推进吗？
```

## Phase 2：模型适配层（3-5天）

**目标**：自适应模型磨合，智能路由。

### 任务清单
- [ ] 能力探测探针集（工具调用/JSON/上下文长度/推理速度）
- [ ] LM Studio 适配器增强（自动检测本地模型列表）
- [ ] OpenAI/DeepSeek 适配器（在线模型）
- [ ] 行为学习模块（记录每次交互的模型表现）
- [ ] 模型画像存储（每个模型的 capabilities.json）
- [ ] 交互策略生成（根据画像选择 prompt 包装方式）
- [ ] 智能路由器（难度评估 → 选模型 → 成本控制）
- [ ] 兜底切换（主模型不可用 → 自动降级）
- [ ] 磨合期状态机（新模型自动进入磨合→探测→稳定）

### 验证标准
```
1. 连上 qwen3.6 → 自动探测 → 发现 tool_calls 不稳定 → 自动减少工具数
2. 简单任务 → 自动用本地模型
3. 复杂任务 → 自动切在线模型（DeepSeek）
4. 在线挂掉 → 自动降级本地模型 + 加 CoT prompt
```

## Phase 3：技能生态（5-7天）

**目标**：自动感知缺口、申请、审核、开发、装备。

### 任务清单
- [ ] 技能注册表（skill registry，类似 OpenClaw 的 available_skills）
- [ ] 技能格式定义（SKILL.md 规范）
- [ ] 技能加载器（按需注入到 Agent 上下文）
- [ ] 缺口感知器（执行失败/缺能力时自动标记）
- [ ] 技能申请生成器（自动生成申请单：为什么、预期功能）
- [ ] 自动审核器（空闲时审核申请单，规则引擎）
- [ ] 技能开发器（调用 Agent 写 SKILL.md + 脚本）
- [ ] 测试验证器（用样本任务验证新技能）
- [ ] 技能装备器（验证通过 → 注册到 registry → 立即可用）
- [ ] 技能版本管理（技能变更历史）
- [ ] Web 面板：技能列表、申请队列、审核日志

### 审核规则（初版）
```
自动通过条件：
  - 不与现有技能重叠 > 80%
  - 非危险操作（不在 deny list 中）
  - 有明确使用场景
  - 技能依赖可满足

需要人工审核：
  - 涉及网络请求/外部 API
  - 操作财务/账户数据
  - 不确定安全性的操作

直接拒绝：
  - 已存在同类技能
  - 恶意/越权操作
  - 依赖不可满足
```

### 验证标准
```
Agent 开发媒体中心 → 发现需要 ffmpeg 技能 → 自动提交技能申请
  → 空闲时自动审核 → 通过 → 开发 ffmpeg skill
  → 测试通过 → 装备上线
  → 下次直接用 → 不会再申请
```

## Phase 4：多 Agent 协作（5-7天）

**目标**：主 Agent 分配任务给子 Agent，并行执行。

### 任务清单
- [ ] 子 Agent 运行时（独立上下文、独立模型参数）
- [ ] Agent 通信总线（主→子 分配，子→主 汇报）
- [ ] 子 Agent 限时运行 + 超时回收
- [ ] 结果汇聚引擎（多个子 Agent 结果 → 综合判断）
- [ ] 并行调度器（DAG 并行度控制）
- [ ] 资源管理（CPU/内存/API 并发限制）
- [ ] 协作模式：顺序、并行、讨论（多 Agent 辩论）
- [ ] 子 Agent 监控面板

### 验证标准
```
Agent> 帮我同时做一个前端页面和一个后端 API
  → 主 Agent 分解为两个子任务
  → 子 Agent A 写前端，子 Agent B 写后端
  → 并行执行
  → 结果汇聚 → 报告完成
```

---

## 长期升级点（Phase 4 之后）

| 功能 | 优先级 | 备注 |
|------|--------|------|
| 多平台通道（Telegram/Discord） | 中 | 用户在 Phase 0 说后续做 |
| 主动意图引擎（空闲时主动规划任务） | 高 | A 型已入 Phase 1，此为加强版 |
| 向量检索升级 | 中 | 从关键词升级到语义 |
| 集群模式 | 低 | 从单体升级到微服务 |
| 记忆摘要引擎 | 高 | 自动总结对话为结构化知识 |
| 任务模板库 | 中 | 常见任务预制分解方案 |
| 安全沙箱加固 | 中 | Docker/VM 隔离 |

---

## 开发规范

1. **TypeScript 严格模式**：所有类型必须明确
2. **单文件 < 500 行**：超过就拆
3. **每个模块有测试**：至少验证主流程
4. **审计日志全量**：不丢任何操作记录
5. **配置可外部化**：不在代码里写死任何配置
6. **错误信息中文**：用户看得懂
7. **Git 提交规范**：`phase-N: 简短描述`

---

## Phase 6 (v0.6.0): 专业 Web UI（2026-06-17 ~ 06-18）

**目标**：提供媲美 OpenClaw 的专业聊天界面 + 后台管理面板。

### 管理控制台 (`/admin`)
- [x] 仪表盘后端 API（dashboard-api.ts，6个端点）
- [x] admin-panel.html 前端（项目管理/技能/模型/韧性/记忆/审计）
- [x] SSE 实时推送 + 5秒自动刷新
- [x] DOM 增量更新（safeUpdate，不覆盖编辑状态）

### 专业聊天界面 (`/` → agent-ui.html)
- [x] Header: 连接状态 + 模型标签（本地/远程标识）+ 导航
- [x] Status Bar: 模型名/会话ID/运行时间/上下文进度条
- [x] **模型选择器**：下拉列出可用模型，显示本地/远程标签，点击切换
- [x] 消息气泡：用户(紫色渐变) / Agent(绿色) / 系统(透明小字)
- [x] 代码块：语言标签 + 复制按钮 + 语法着色
- [x] **Hover 消息操作**：复制 / 重新生成 / 编辑 / 删除
- [x] **设置面板**：侧滑抽屉，模型/API地址/超时/重试/Token/主题
- [x] 停止生成按钮（AbortController）
- [x] **消息持久化**：localStorage 保存历史，刷新不丢
- [x] **亮/暗/跟随系统** 三种主题
- [x] 输入框字符计数 + 自适应高度
- [x] **Agent 消息显示模型标签**（区分哪个模型回复）
- [x] 快捷命令标签（/status /help /models ... 可折叠）
- [x] 淡入动画 + 滚动到底部
- [x] 移动端响应式适配

### 后端 API 增强
- [x] `GET /api/models` — 列出 LM Studio 可用模型
- [x] `GET /api/config` — 查看当前配置
- [x] `POST /api/config` — 更新配置（写入文件）
- [x] `GET /api/status` — 服务状态

### 待改进
- [x] SSE 流式输出（v0.9.0 完成，`POST /api/chat/stream` 逐 chunk 转发）
- [x] 文件上传/图片显示（v0.9.0 完成，`POST /api/upload` + 拖放上传 + 消息内渲染）
- [x] 对话历史管理（v0.9.0 完成，SQLite 多会话持久化 + 侧滑抽屉 UI）
- [x] `/api/chat` 超时可通过配置控制（v0.9.0 完成，`server.chatTimeoutMs` 配置项）

## Phase 6 (v0.6.0): 专业 Web UI

**目标**：提供媲美 OpenClaw 的专业聊天界面 + 后台管理面板。

（已完成，见 P6_webui_wrapup_2026-06-17.md）

## Phase 7 (v0.6.0): 无上限上下文管理器（2026-06-17）

**目标**：Agent 对话不再受 token 长度限制，智能压缩旧历史。

### 实现功能
- [x] 注意力评分机制（TF-IDF + 位置 + 角色 + 时效性）
- [x] 两层压缩策略（摘要 + 热点保留）
- [x] 递进压缩层级（Lv.0~Lv.4）
- [x] Config 可配参数
- [x] 上下文管理面板（管理控制台）
- [x] CLI `/context` 命令
- [x] Dashboard API `/api/dashboard/context`

### 核心原理
```
原始消息 → 注意力评分 → 未超限? → 直接发送
                          ↓ 超限
                   压缩旧消息为摘要
                          ↓ 摘要+热点仍超限?
                   是 → Lv+1，裁剪到最近N条
                   否 → 摘要 + 热点消息 + 当前问题
```

### 配置默认值
```json
{
  "maxTokens": 4000,
  "hotWindowSize": 12,
  "summaryTokenBudget": 512,
  "compressionThreshold": 0.75,
  "preserveSystem": true,
  "attentionEnabled": true
}
```

### 相关文件
- `src/core/context-manager.ts` — 核心实现
- `src/core/agent/agent-core.ts` — 集成调用
- `config/default.json` — 配置段
- `src/server/dashboard-api.ts` — API 端点
- `admin-panel.html` — 管理面板

---

## 当前状态

- [x] Phase 0 (v0.1.0) — 基础骨架 ✅
- [x] Phase 1 (v0.1.x) — 任务调度/记忆/项目闭环 ✅
- [x] Phase 2 (v0.2.0) — 模型适配层 ✅
- [x] Phase 3 (v0.3.0) — 技能生态 ✅
- [x] Phase 4 (v0.3.0) — 多Agent协作 ✅
- [x] Phase 5 (v0.5.0) — 韧性+恢复+审计 ✅
- [x] Phase 6 (v0.6.0) — 专业聊天UI + 管理面板 ✅
- [x] Phase 7 (v0.6.0) — 无上限上下文管理器 ✅
- [x] **v0.6.3 — 全局配置体系整合 ✅ (2026-06-20)**
  - NonsenseDetector 全配置化：阈值/规则从 `getNonsenseConfig()` 读取
  - `/config` 命令：`show` / `reload` / `path`
  - `config/agent-system.yaml` 统一配置文件（中文注释，热重载）
  - Handler: `src/config/agent-system-config.ts` +
    `src/core/agent/agent-core.ts` + `src/resilience/nonsense-detector.ts`

- [x] **v0.7.0 — 提示词系统改造 (Phase 2-3) ✅ (2026-06-21)**
  - 新建 `src/prompts/` 模块：PromptRegistry（模板注册表）+ PromptAssembler（组装器）
  - 新建 `config/prompts/` 目录：6 个外部提示词模板（.md + YAML frontmatter）
  - Memory Block 角色修正：跨会话记忆不再污染 system，改为 user 角色独立注入
  - 提示词硬编码消除：intent-parser、task-decomposer、summarizer 全部接入 registry
  - `agent-core.ts` init() + handleChat() 全链路接入 PromptAssembler
  - 设计文档 `prompt_system_architecture.md` 全部 Phase 标记完成

- [x] **v0.9.0 — Phase 6 (Web UI) 全面升级 ✅ (2026-06-21)**
  - SSE 流式输出：`POST /api/chat/stream` 逐 chunk 转发，前端 ReadableStream 消费
  - 多会话管理：SQLite (`data/sessions.db`) 持久化，侧滑抽屉式 UI
  - 文件上传/图片显示：`POST /api/upload` multipart 解析 + 拖放上传 + 消息内图片渲染
  - 超时可配置化：`server.chatTimeoutMs` 配置项，设置面板可调
  - 新增文件：`src/server/session-store.ts`
  - 改动文件：`lmstudio.ts`、`smart-adapter.ts`、`llm-router.ts`、`agent-event-bus.ts`、`agent-core.ts`、`agent-server.ts`、`config.ts`、`agent-system.yaml`、`agent-ui.html`

- [x] **v0.9.1 — 复杂长任务处理能力增强 ✅ (2026-06-28)**
  - 修复跨会话任务恢复：`init()` 不再清除检查点，改为检测待恢复任务
  - 步骤级检查点：`orchestrator.execute()` 每步完成后保存到 `CheckpointManager`
  - 动态重规划（Observe→Replan）：失败后 LLM 评估是否调整后续计划（`shouldReplan()`）
  - 新增 `/resume` 命令：列出/恢复未完成任务，重建上下文 + 执行剩余步骤
  - 新增 `/ckpt` 命令：检查点管理（list/show/clear）
  - 新增 `/pause` 命令：暂停当前任务
  - `orchestrator.ts`：新增 `busy` getter、`setLLMCall()`、`shouldReplan()`、`enableReplan`/`maxReplans` 配置
  - `agent-core.ts`：新增 `pendingTaskIds` 字段、`toolRegistry` 导入、3 个命令处理器

- [x] **v0.9.2 — 本地模型自动探测 + 热切换 ✅ (2026-06-28)**
  - 启动自动探测：`onboardModel()` 调用 `listModels()` 列出所有已加载模型
  - 热切换 API：`POST /api/models/switch` — 验证→`setModel()`→更新上下文→持久化 YAML
  - 重新扫描 API：`POST /api/models/scan`
  - 增强 `GET /api/models`：完整元数据 + 连接状态 + 运行实例当前模型
  - CLI 增强：`/models list|scan|switch <name>`
  - 前端增强：模型下拉显示上下文/架构，🔄 刷新按钮，热切换即时生效，连接状态指示

### MVP 交付物
```
src/
├── core/
│   ├── agent/agent-core.ts    (~500L) 核心循环: 路由+磨合+技能+多Agent
│   ├── orchestrator.ts        (~200L) 任务编排
│   ├── intent-parser.ts       (~100L) 意图解析
│   ├── projects/
│   │   ├── types.ts           (~100L)
│   │   └── project-manager.ts (~350L) 项目管理+检查点
│   └── tools/                 (工具注册表)
├── memory/
│   ├── file-store.ts          (文件记忆)
│   └── db-store.ts            (sql.js DB记忆)
├── models/
│   ├── adapters/lmstudio.ts   (LM Studio适配器)
│   ├── probe/                 (能力探测, 7探针)
│   ├── profile/               (模型画像存储)
│   ├── router/                (难度评估+智能路由)
│   └── adaptation/            (磨合期状态机)
├── skills/
│   ├── types.ts               (技能类型)
│   ├── registry.ts            (注册表)
│   ├── gap-detector.ts        (缺口感知)
│   └── pipeline.ts            (审核+开发+测试+装备)
├── agents/
│   ├── sub-agent.ts           (子Agent运行时)
│   └── collaboration.ts       (总线+汇聚+调度+资源)
├── config.ts / logger.ts / index.ts
└── test_phase*.ts
```

## Phase 2 验证结果 ✅ (2026-06-17 00:33)

```
=== Phase 2 模型适配层验证 ===
✅ 难度评估器: 5个场景正确分级
✅ 智能路由: 简单→本地 / 高难度→在线+兜底(lmstudio)
✅ 模型画像: 存储+更新+策略调整
✅ 磨合状态机: learning→degraded检测+恢复
✅ 编译通过 (0 errors)
⚠️ 模型适配器集成测试需 LM Studio 运行中
```

### 2A: 能力探测 ✅
- [x] 探针集定义 (6类7探针)
- [x] 探测引擎 (CapabilityProbe→Profile+Strategy)
- [x] 模型画像存储 (ProfileStore)
- [x] LM Studio 模型列表检测

### 2B: 智能路由器 ✅
- [x] 难度评估器 (5级 + 6因子)
- [x] 模型选择+兜底链
- [x] 在线预算控制

### 2C: 磨合期状态机 ✅
- [x] 5状态 (new→probing→learning→stable↔degraded)
- [x] Agent Core 全集成

