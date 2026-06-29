# Agent System — 开发者交接文档
# 版本: v0.9.2 | 更新: 2026-06-28T17:20 | 状态: ✅ 本地模型自动探测 + 热切换

## 当前状态

### ✅ 已完成功能
> 从上到下按完成时间排列，最新在最前

- [x] **本地模型自动探测 + 热切换** — 启动时自动探测 LM Studio 已加载模型，支持运行时热切换
  - **启动自动探测**：`onboardModel()` 增强 — 调用 `listModels()` 列出所有已加载模型，日志输出模型名/架构/上下文长度
  - **热切换 API**：`POST /api/models/switch` — 验证模型已加载 → `adapter.setModel()` 热切换 → 更新上下文长度 → 持久化到 YAML
  - **重新扫描 API**：`POST /api/models/scan` — 重新查询 LM Studio 已加载模型列表
  - **增强 GET /api/models** — 返回完整元数据（context_length/arch/publisher/type/loaded）+ 连接状态 + 运行实例当前模型
  - **CLI 命令增强**：`/models list` 列出已加载模型 + 标记当前、`/models scan` 重新扫描、`/models switch <name>` 热切换
  - **前端增强**：模型下拉显示上下文长度/架构元数据，🔄 刷新按钮重新扫描，热切换无需重启，连接状态视觉指示
  - **降级保护**：热切换 API 不可用时自动降级到配置写入方式

- [x] **Phase 6: Web UI 全面升级** — SSE 流式输出 + 文件上传/图片显示 + 多会话管理 + 超时可配置
  - **SSE 流式输出**：`POST /api/chat/stream` 返回 `text/event-stream`，逐 chunk 转发
    - `lmstudio.ts` 新增 `chatStream()` — OpenAI 兼容端点 `stream:true`，逐 token yield delta
    - `smart-adapter.ts` 新增 `chatStream()` — 直接委托，不走重试/重复检测
    - `llm-router.ts` 新增 `callStream()` — 广播 payload 后调用 adapter.chatStream()
    - `agent-event-bus.ts` 新增 `emitChatChunk()` / `emitChatDone()` / `emitChatError()` 三种事件
    - `agent-core.ts` 新增 `sendMessageStream()` / `handleChatStream()` — 与非流式相同的 pipeline
    - 前端使用 `fetch()` + `response.body.getReader()` 逐行解析 SSE，流式失败自动降级到非流式
  - **多会话管理**：SQLite (`data/sessions.db`) 持久化多会话聊天历史
    - `src/server/session-store.ts` — 新文件，CRUD 接口，自动从首条用户消息生成标题
    - 会话 API：`GET/POST /api/sessions`、`GET/PUT/DELETE /api/sessions/:id`
    - 前端侧滑抽屉式会话列表，支持新建/切换/重命名/删除
  - **文件上传/图片显示**：
    - `POST /api/upload` — multipart/form-data 解析，保存到 `uploads/`，返回 `{ok, url, filename, isImage, size}`
    - `/uploads/` 静态文件服务
    - 前端 📎 按钮上传 + 拖放上传（dragenter/dragleave/drop）
    - 消息内图片 URL 自动渲染为 `<img>`，文件 URL 渲染为下载链接
  - **超时可配置化**：
    - `config/agent-system.yaml` 新增 `server` 段：`port`、`chatTimeoutMs`、`maxUploadSizeMB`
    - `config.ts` AppConfig 接口新增 `server?` 段
    - `GET/POST /api/config` 支持读写 `chatTimeoutMs`（写入 YAML）
    - 设置面板新增"聊天接口超时 (ms)"配置项
- [x] **Experience Module: 经验管理命令** — `/exp` 命令系统，支持用户主动录入/查看/修改/删除经验
  - `src/experience/commands.ts` — ExperienceCommandHandler，草稿→加工→确认流程
  - `config/prompts/experience.refine.md` — 经验精炼提示词模板（泛化优先）
  - `src/experience/extractor.ts` 新增 `refine()` — LLM 加工用户原始描述为泛化草稿
  - `src/experience/store.ts` 新增 `delete()` / `update()` — 硬删除 + 保留统计的更新
  - **录入流程**：`/exp add <描述>` → Agent LLM 加工泛化 → 展示草稿 → `/exp confirm` 确认保存
  - **编辑流程**：`/exp edit <id>` → 加载已有经验 → LLM 再加工 → 展示草稿 → `/exp confirm` 更新
  - **去重检查**：保存前检索相似经验，相似度 >85% 时提示合并而非新建
  - **查看**：`/exp list [n]` `/exp view <id>` `/exp search <关键词>` `/exp stats`
  - **删除**：`/exp delete <id>`（硬删除，含 MD 文件清理）
- [x] **Experience Module: 经验模块** — `src/experience/` 新建，自动提取/存储/检索/注入可复用经验
  - `src/experience/types.ts` — ExperienceRecord 数据模型（场景+问题+解法+结果+评分）
  - `src/experience/store.ts` — ExperienceStore，SQLite (data/experiences.db) + MD 文件双层存储
  - `src/experience/extractor.ts` — ExperienceExtractor，LLM 辅助提取 + 规则引擎兜底
  - `src/experience/retriever.ts` — ExperienceRetriever，三层降级检索（标签→关键词→场景）
  - `config/prompts/experience.extract.md` — 经验提取提示词模板
  - **自动提取**：任务成功/失败后异步提取经验，不阻塞响应
  - **条件性注入**：每轮检索 Top-3 相关经验，有匹配才注入（以 user 角色，位于 memory block 之后）
  - **评分衰减**：score = baseScore × decay(lastUsed) × successRate，30/90 天衰减梯度
  - `agent.identity.md` 升级到 v2.1.0，新增 Experience store 能力清单和 [相关经验] 检索指引
  - PromptAssembler 新增 experienceBlock 字段，AssembledPromptMetadata 新增 hasExperience/experienceBlockLen

- [x] **Phase 2-3: 提示词系统改造** — `src/prompts/` 新建，PromptRegistry + PromptAssembler 全链路接入
  - `src/prompts/registry.ts` — PromptRegistry 单例，管理所有模板，支持变量插值 `{{var}}`、热重载（从 `config/prompts/` 加载）
  - `src/prompts/assembler.ts` — PromptAssembler，按语义层次组装 messages（identity → memory → experience → context → userInput）
  - `config/prompts/` — 7 个外部模板文件（可不重启直接修改生效）
  - **Memory Block 角色修正**：跨会话记忆不再塞进 system，改为 user 角色注入（避免污染 system identity）
  - **提示词硬编码消除**：intent-parser、task-decomposer、summarizer 全部改用 registry 获取模板
  - `agent-core.ts` init() 使用 PromptRegistry 初始化 system message
  - `agent-core.ts` handleChat() 使用 PromptAssembler 组装最终 messages（含组装元数据传入调试面板）
- [x] **Phase 1: 统一 LLM Router** — `src/llm/llm-router.ts` 新建，5 个调用点统一入口，自动广播带 taskType 的 `model_payload`，前端调试面板增加 taskType 标签 + payload 历史导航
- [x] **调试面板交互优化** — 自动弹出→手动触发（消息工具栏"🔍 调试"按钮），流式消息完成后补充工具栏（复制/重试/调试/删除）
- [x] **状态条修复** — 需要澄清分支、命令快速通道两处路径遗漏 `endSession()` 导致状态卡死，已补充
- [x] **SSE 实时状态条** — 事件总线（7 种状态）+ SSE 广播 + UI 状态条显示（思考/执行工具/模型输出/完成）
- [x] **模型 payload 调试面板** — 通过 SSE `model_payload` 事件广播发送给模型的完整消息内容，前端可视化面板，角色分色
- [x] P0: LM Studio 适配器修复（chat()路由修正 + reasoning_content 移入 content）
- [x] P0: 推理模型重试逻辑（超时 120s，重试 5 次，Promise.race 竞态修复）
- [x] P1: 配置文件统一（YAML 为主，config.ts 改为兼容层，环境变量替换）
- [x] P2: Dashboard 改进（日志轮转状态接口 /api/logs/status）+ 测试覆盖（3个测试文件）
- [x] P3: TypeScript strict 模式（已开启）+ 文档更新
- [x] 三层重复检测（字符级/子序列/段落级 + 跨轮次）
- [x] 日志轮转（gzip 压缩 + 配置化 + Dashboard 状态接口）
- [x] 全局配置体系（YAML 热重载 + 环境变量 ${VAR} 替换）
- [x] 代码审查 12 个问题清零
- [x] Git 仓库初始化，全部代码已提交（14 commits）

### ⚠️ 遗留问题（非阻塞）
- [ ] 模型响应慢（qwen3.5-9b ~30-60秒/次，偶尔触发重复检测重试）— 硬件局限
- [ ] 14 个 pending checkpoint 任务未消费 — 功能完整，可后续优化
- [ ] safePath() 防御不完整 — 低优先级
- [ ] getCurrentModel() 静默失败 — 低优先级

## Phase 2-3: 提示词系统改造详解（v0.7.0）

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/prompts/registry.ts` | PromptRegistry 单例：模板存储、变量插值、热重载 |
| `src/prompts/assembler.ts` | PromptAssembler：按语义层次组装最终 messages |
| `src/prompts/index.ts` | barrel export |
| `config/prompts/agent.identity.md` | Agent 身份系统提示词 |
| `config/prompts/agent.memory.md` | 跨会话记忆注入模板 |
| `config/prompts/intent.parse.md` | 意图解析提示词 |
| `config/prompts/task.decompose.md` | 任务分解提示词 |
| `config/prompts/context.summarize.md` | 上下文压缩摘要提示词 |
| `config/prompts/session.summarize.md` | 会话记忆蒸馏提示词 |

### 组装顺序（固定）

```
1. System Identity  ← [role: system]   来自 agent.identity 模板
2. Memory Block     ← [role: user]     跨会话记忆（不再污染 system）
   ↑ assistant: "好的，我已了解历史背景"（维持对话结构）
3. Context Messages ← [role: *]        ContextManager 处理后的对话历史
   ↑ 含压缩摘要时，摘要以 user 角色 + [此前对话摘要] 标记展示
4. Task Instruction ← [role: user]     可选任务指令
5. User Input       ← [role: user]     当前用户输入（永远最后一条）
```

### 关键变化

| 改动 | 改造前 | 改造后 |
|------|--------|--------|
| system message 内容 | 硬编码字符串 + memoryBlock 直接拼接 | PromptRegistry 读取模板（外部可编辑） |
| 跨会话记忆注入 | 塞进 `system.content`（污染身份） | user 角色独立消息（PromptAssembler） |
| 意图解析提示词 | intent-parser.ts 内硬编码 | PromptRegistry 'intent.parse' |
| 任务分解提示词 | task-decomposer.ts 内硬编码 | PromptRegistry 'task.decompose' |
| 会话摘要提示词 | summarizer.ts 内英文硬编码 | PromptRegistry 'session.summarize' |

### 热更新提示词

修改 `config/prompts/` 目录下任意 .md 文件后，在 Agent 内执行：
```
/config reload
```
或直接重启服务，无需改代码。

### 使用 PromptRegistry

```typescript
import { getPromptRegistry } from '../prompts/registry';

// 获取模板（支持变量插值）
const registry = getPromptRegistry();
const tpl = registry.get('task.decompose', { availableTools: 'exec, write, read' });
const systemPrompt = tpl.system; // 变量已替换
```

### 使用 PromptAssembler

```typescript
import { getPromptAssembler } from '../prompts/assembler';

const assembler = getPromptAssembler();
const { messages, metadata } = assembler.assemble({
  identityTemplateId: 'agent.identity',  // 可切换不同角色
  memoryBlock: '上次会话：用户在开发一个 Agent 系统...',
  context: ctxResult.messages,  // ContextManager 处理后的上下文
  userInput: '继续开发',        // 可选，如果 context 末尾已含则省略
});
// metadata 包含各层长度统计，自动传入调试面板
```

## Phase 1: 统一 LLM Router 详解

### 为什么做
Phase 8（实时状态条 + 调试面板）只有主聊天路径会广播 `model_payload`，意图解析、任务分解、摘要、探针等 LLM 调用完全不可观测。用户反馈"发送的内容不对"但无据可查。

### 架构

```
用户请求 → intent-parser ─→ llmRouter.call(taskType='intent')
         → task-decomposer ─→ llmRouter.call(taskType='decompose')
         → context-compressor ─→ llmRouter.call(taskType='summarize')
         → agent-core chat ─→ llmRouter.call(taskType='chat')
         → sub-agent ─→ llmRouter.call(taskType='subagent')
                              ↓
               LLMRouter.broadcastPayload() → SSE model_payload (带 taskType)
                              ↓
                        adapter.chat(messages)
```

### 调用点对照表

| 模块 | 源文件 | taskType | 消息数 | 广播 |
|------|--------|----------|--------|------|
| 意图解析 | `src/core/agent/agent-core.ts` | `intent` | 2 (system+user) | ✅ |
| 任务分解 | `src/core/agent/agent-core.ts` | `decompose` | 不定 | ✅ |
| 主聊天 | `src/core/agent/agent-core.ts` | `chat` | 3~N | ✅ |
| 上下文压缩 x2 | `src/core/agent/agent-core.ts` | `summarize` | 1~2 | ✅ |
| 子 Agent | `src/agents/sub-agent.ts` | `chat` | 不定 | ✅ |

### 参数策略

```typescript
const TASK_PARAMS = {
  intent:    { temperature: 0,   max_tokens: 512,  reasoning: 'off' },
  decompose: { temperature: 0,   max_tokens: 1024, reasoning: 'off' },
  chat:      { temperature: 0.7, max_tokens: 2048 },
  summarize: { temperature: 0,   max_tokens: 1024, reasoning: 'off' },
  probe:     { temperature: 0,   max_tokens: 256,  reasoning: 'off' },
  breakin:   { temperature: 0.7, max_tokens: 1024 },
  subagent:  { temperature: 0.7, max_tokens: 2048 },
};
```

### 关键文件
- **新文件**: `src/llm/llm-router.ts` — LLMRouter 单例类，含 `call()` / `callWithDefaults()` / `broadcastPayload()`
- **入口初始化**: `src/core/agent/agent-core.ts` 构造时 `initLLMRouter(this.adapter)`
- **调用方式**: `getLLMRouter().call({ taskType: 'chat', messages })` 或 `callWithDefaults()`
- **事件总线**: `src/core/agent-event-bus.ts` — `ModelPayloadEvent` 接口增加 `taskType: LLMTaskType`

### 前端调试面板增强

在 `agent-ui.html` 中：

1. **taskType 标签** — 面板标题显示任务类型图标：
   - `🎯 意图解析` / `💬 主聊天` / `📝 摘要压缩` / `🤖 子Agent`
2. **Payload 历史** — 所有 payload 存入 `_payloadHistory[]`，支持 ◀ prev / next ▶ 浏览
3. **元信息行** — 增加 `🏷 意图解析` 标签

## Phase 6: Web UI 全面升级详解（v0.9.0）

### SSE 流式输出

**完整链路**：
```
用户输入 → POST /api/chat/stream
         → AgentCore.sendMessageStream()
         → handleChatStream() (与非流式相同 pipeline: 意图解析 → 上下文组装)
         → llmRouter.callStream()
         → SmartAdapter.chatStream()
         → LMStudioAdapter.chatStream() (OpenAI 兼容端点 stream:true)
              ↓ 逐 chunk yield delta content
         → agentEventBus.emitChatChunk(chunk)
              ↓ 一次性监听器转发到当前 response
         → 前端 fetch().body.getReader() 逐行解析 SSE
```

**新增方法**：

| 文件 | 方法 | 说明 |
|------|------|------|
| `lmstudio.ts` | `async *chatStream(messages)` | OpenAI `stream:true`，逐行解析 `data:` SSE delta |
| `smart-adapter.ts` | `async *chatStream(messages)` | 直接委托 `raw.chatStream()`，不走重试/重复检测 |
| `llm-router.ts` | `async *callStream(req)` | 广播 payload 后委托 `adapter.chatStream()` |
| `agent-event-bus.ts` | `emitChatChunk/emitChatDone/emitChatError` | 三种流式事件 |
| `agent-core.ts` | `sendMessageStream()` / `handleChatStream()` | 与非流式相同 pipeline，最终用 `callStream()` |

**前端降级策略**：流式连接中断时，如果已有部分内容则保留并标记完成；否则回退到 `POST /api/chat` 非流式端点。

### 多会话管理

**存储**：SQLite (`data/sessions.db`)，表结构 `sessions(id, title, messages_json, created_at, updated_at)`

**API**：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/sessions` | GET | 列出所有会话（不含消息体） |
| `/api/sessions` | POST | 新建空会话 |
| `/api/sessions/:id` | GET | 获取会话完整消息 |
| `/api/sessions/:id` | PUT | 更新会话标题/消息 |
| `/api/sessions/:id` | DELETE | 删除会话 |

**标题生成**：首次用户消息自动截取前 40 字符作为标题。

**前端 UI**：侧滑抽屉式会话列表（280px），支持新建/切换/重命名/删除。

### 文件上传

**端点**：`POST /api/upload`（multipart/form-data）

**实现**：自写 `parseMultipart(buffer, boundary)` 函数，基于 Buffer 索引分割，无第三方依赖。

**返回**：`{ ok, url, filename, isImage, size }`

**前端**：📎 按钮上传 + 拖放上传（dragenter/dragleave/drop），上传后显示预览缩略图。

**消息渲染**：
- 图片 URL（.png/.jpg/.jpeg/.gif/.webp）→ `<img>` 内嵌显示
- 文件 URL（其他类型）→ `<a>` 下载链接

### 超时可配置化

**配置**（`config/agent-system.yaml` → `server` 段）：
```yaml
server:
  port: 19701
  chatTimeoutMs: 120000
  maxUploadSizeMB: 20
```

**API**：`GET /api/config` 返回 `chatTimeoutMs`，`POST /api/config` 支持写入 YAML。

**前端**：设置面板新增"聊天接口超时 (ms)"配置项。

### 新增/改动文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/server/session-store.ts` | 新增 | SQLite 会话存储，CRUD 接口 |
| `src/models/adapters/lmstudio.ts` | 改动 | 新增 `chatStream()` |
| `src/core/smart-adapter.ts` | 改动 | 新增 `chatStream()` 委托 |
| `src/llm/llm-router.ts` | 改动 | 新增 `callStream()` |
| `src/core/agent-event-bus.ts` | 改动 | 新增 3 个流式事件方法 |
| `src/core/agent/agent-core.ts` | 改动 | 新增 `sendMessageStream()` / `handleChatStream()` |
| `src/server/agent-server.ts` | 改动 | 新增 SSE 流式端点 + 会话 CRUD + 文件上传 + 配置扩展 |
| `src/config.ts` | 改动 | AppConfig 新增 `server?` 段 |
| `config/agent-system.yaml` | 改动 | 新增 `server` 段 |
| `agent-ui.html` | 改动 | 流式消费 + 会话侧边栏 + 文件上传 + 图片渲染 |

## SSE 事件系统说明

### 事件类型

| 事件 | 类型 | 用途 | 来源 |
|------|------|------|------|
| `agent_status` | SSE | 实时状态更新 | agent-core.ts → agent-event-bus |
| `model_payload` | SSE | 完整模型请求数据 | llm-router.ts → agent-event-bus |
| `chat_chunk` | SSE | 流式聊天逐 chunk 内容 | agent-core.ts → agent-event-bus |
| `chat_done` | SSE | 流式聊天完成（含完整回复+耗时） | agent-core.ts → agent-event-bus |
| `chat_error` | SSE | 流式聊天错误 | agent-core.ts → agent-event-bus |

### 状态流转

```
普通聊天: idel → thinking → intent_ready → model_responding → done → idel
带工具任务: idel → thinking → intent_ready → executing_tools → model_responding → done → idel
需澄清: idel → thinking → intent_ready → done (带原因: '需要澄清')
命令: idel → thinking → intent_ready → done (带原因: '命令完成')
```

## 配置文件说明

### 主配置文件
`config/agent-system.yaml` — 用户可编辑，支持热重载（`/config reload` 命令）

```yaml
logging:
  level: info
  maxFileSizeMB: 10
  maxRotatedFiles: 5

models:
  defaultProvider: lmstudio
  providers:
    lmstudio:
      baseUrl: "http://127.0.0.1:1234/v1"
      apiKey: "not-needed"
      model: "qwen3.5-9b-deepseek-v4-flash-mtp"
      timeoutMs: 120000

server:
  port: 19701
  chatTimeoutMs: 120000
  maxUploadSizeMB: 20
```

### 环境变量替换
支持 `${ENV_VAR}` 语法，启动时自动替换，未设置则抛错。

## API 端点列表

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/chat` | POST | 聊天接口（非流式） |
| `/api/chat/stream` | POST | SSE 流式聊天接口（逐 chunk 转发） |
| `/api/events` | GET | SSE 事件流（agent_status + model_payload + chat_chunk/done/error）|
| `/api/status` | GET | 服务状态 |
| `/api/dashboard` | GET | 完整 Dashboard 数据 |
| `/api/logs/status` | GET | 日志轮转状态 |
| `/api/config` | GET/POST | 查看/更新配置（含 chatTimeoutMs） |
| `/api/models` | GET | 列出 LM Studio 已加载模型（含完整元数据）|
| `/api/models/switch` | POST | 热切换运行中的模型（无需重启）|
| `/api/models/scan` | POST | 重新扫描 LM Studio 已加载模型 |
| `/api/sessions` | GET/POST | 会话列表 / 新建会话 |
| `/api/sessions/:id` | GET/PUT/DELETE | 查看/重命名/删除会话 |
| `/api/upload` | POST | 文件上传（multipart/form-data） |
| `/uploads/*` | GET | 上传文件静态服务 |
| `/admin` | GET | 管理控制台 |

访问 UI：`http://localhost:19701/agent-ui.html`

## 架构设计文档

Phase 1 实施前编写了完整的提示词系统架构设计：
```
prompt_system_architecture.md
```
包含：
- 当前 7 个模块的提示词链路拆解
- 7 个痛点总结
- 三层目标架构（PromptRegistry → PromptAssembler → LLMCallRouter）
- 分阶段迁移路径（Phase 1→2→3）
- Phase 1 已完成，Phase 2+ 待规划

## 测试

```bash
# 运行单个测试
npx ts-node tests/test-env-substitution.ts
npx ts-node tests/test-log-rotation.ts
npx ts-node tests/test-dedup-detection.ts
```

测试文件：
- `tests/test-env-substitution.ts` - 环境变量替换
- `tests/test-log-rotation.ts` - 日志轮转
- `tests/test-dedup-detection.ts` - 重复检测

## 运行

```bash
npm install
npm run build
node dist/server/agent-server.js
```

访问 `http://localhost:19701/agent-ui.html`

## 版本历史

### v0.9.2 (2026-06-28T17:20) ← 当前版本
**本地模型自动探测 + 热切换**
- 启动自动探测：`onboardModel()` 增强，调用 `listModels()` 列出所有已加载模型并日志输出
- 热切换 API：`POST /api/models/switch` — 验证模型 → `adapter.setModel()` → 更新上下文 → 持久化 YAML
- 重新扫描 API：`POST /api/models/scan` — 重新查询 LM Studio 已加载模型
- 增强 `GET /api/models` — 返回完整元数据（context_length/arch/publisher）+ 连接状态
- CLI 增强：`/models list` 列出已加载模型、`/models scan` 重新扫描、`/models switch <name>` 热切换
- 前端增强：模型下拉显示上下文/架构元数据，🔄 刷新按钮，热切换无需重启，连接状态指示
- 改动文件：`agent-server.ts`、`agent-core.ts`、`agent-ui.html`、`package.json`

### v0.9.1 (2026-06-28T17:00)
**复杂长任务处理能力增强**
- 修复跨会话任务恢复：`init()` 不再 `clearAll()` 清除检查点，改为检测并记录待恢复任务
- 步骤级检查点集成：`orchestrator.execute()` 接入 `CheckpointManager`，每个步骤完成后自动保存检查点
- 动态重规划（Observe→Replan）：每个并行组执行后，检测失败步骤，LLM 评估是否需要调整后续计划
  - 新增 `shouldReplan()` 方法：LLM 辅助决策 + 规则兜底（失败率 >50% 自动触发）
  - 新增 `setLLMCall()` 方法：agent-core 注入 LLM 调用函数供重规划使用
  - 配置项：`enableReplan`（默认 true）、`maxReplans`（默认 2）
- 新增 `/resume` 命令：列出待恢复任务 / 按序号或 ID 恢复，重建上下文 + 执行剩余步骤
- 新增 `/ckpt` 命令：`list` 列出检查点 / `show <序号>` 查看详情 / `clear` 清除全部
- 新增 `/pause` 命令：暂停当前任务，检查点已自动保存
- `orchestrator.ts` 新增 `busy` getter、`currentTaskId` 字段、`llmCall` 回调
- `agent-core.ts` 新增 `pendingTaskIds` 字段、`toolRegistry` 导入
- 改动文件：`orchestrator.ts`、`agent-core.ts`、`package.json`

### v0.9.0 (2026-06-21T21:30)
**Phase 6 (Web UI) 全面升级**
- SSE 流式输出：`POST /api/chat/stream` 逐 chunk 转发，前端 ReadableStream 消费，失败自动降级到非流式
  - 完整链路：`LMStudioAdapter.chatStream()` → `SmartAdapter.chatStream()` → `LLMRouter.callStream()` → `AgentCore.handleChatStream()` → `agentEventBus.emitChatChunk()` → SSE 端点
- 多会话管理：SQLite (`data/sessions.db`) 持久化，CRUD API，前端侧滑抽屉式会话列表
  - 新文件 `src/server/session-store.ts`，自动从首条用户消息生成标题
- 文件上传/图片显示：`POST /api/upload` multipart 解析 + 拖放上传 + 消息内图片/文件渲染
  - 自写 `parseMultipart()` 函数，无第三方依赖
- 超时可配置化：`server.chatTimeoutMs` 配置项，`GET/POST /api/config` 可读写，设置面板可调
- 新增配置段：`config/agent-system.yaml` → `server`（port / chatTimeoutMs / maxUploadSizeMB）
- 改动文件：`lmstudio.ts`、`smart-adapter.ts`、`llm-router.ts`、`agent-event-bus.ts`、`agent-core.ts`、`agent-server.ts`、`config.ts`、`agent-system.yaml`、`agent-ui.html`、`package.json`

### v0.8.1 (2026-06-21T20:49)
- 新增经验管理命令系统 (/exp)：add/confirm/cancel/list/view/search/edit/delete/stats
- 录入流程：用户描述 → Agent LLM 加工泛化 → 展示草稿 → 用户确认 → 保存
- 编辑流程复用录入流程：/exp edit <id> → LLM 再加工 → 确认更新
- 去重检查：相似度 >85% 时提示合并而非新建
- store.ts 新增 delete()（硬删除+MD清理）和 update()（保留统计字段）
- extractor.ts 新增 refine() 方法和 experience.refine 提示词模板

### v0.8.0 (2026-06-21T20:34)
- 新增经验模块 (src/experience/)：ExperienceStore + Extractor + Retriever
- agent.identity 升级 v2.1.0，新增 Experience store 能力和 [相关经验] 检索指引
- PromptAssembler 新增 experienceBlock 注入层
- 经验提取提示词模板 (config/prompts/experience.extract.md)
- SQLite (data/experiences.db) + MD 文件双层存储
- 三层降级检索 + 评分衰减机制

### v0.7.0 (2026-06-21T19:35)
**Phase 2-3: 提示词系统全面改造**
- 新建 `src/prompts/` 模块：PromptRegistry（模板注册表）+ PromptAssembler（组装器）
- 新建 `config/prompts/` 目录：6 个外部提示词模板文件（.md + YAML frontmatter）
- **Memory Block 角色修正**：跨会话记忆不再拼接到 system.content，改为 user 角色独立注入
- **提示词硬编码消除**：intent-parser、task-decomposer、summarizer 三个模块全部改用 registry
- `agent-core.ts` init() 使用 PromptRegistry 初始化 system message
- `agent-core.ts` handleChat() 使用 PromptAssembler 组装最终 messages
- 组装元数据（各层长度统计）自动传入调试面板
- 编译零错误，设计文档 `prompt_system_architecture.md` 全部 Phase 标记完成

### v0.6.6 (2026-06-21T14:58)
**Phase 1: 统一 LLM Router 全链路可观测**
- 新建 `src/llm/llm-router.ts` — 统一 LLM 调用入口
- 5 个调用点全部改用 `llmRouter.call()`：intent / decompose / chat / summarize / subagent
- 按任务类型自动合并默认参数策略（temperature / max_tokens / reasoning）
- 所有 LLM 调用自动广播 `model_payload`（带 taskType 标签）
- 移除 agent-core.ts 中手动 `emitModelPayload`（避免重复/混淆）
- 前端调试面板改进：
  - 标题显示 taskType 标签（🎯 意图/💬 聊天/📝 摘要等）
  - 增加 payload 历史数组 + ◀ prev / next ▶ 导航浏览
  - LLMRouter 日志级别设为 info（之前为 debug 不可见）
- 设计文档：`prompt_system_architecture.md` 创建

### v0.6.5 (2026-06-21T12:05)
**修复 + 实时状态条**
- Bug 修复：状态条卡死（needsClarification/命令分支缺 endSession）
- Bug 修复：流式消息缺工具栏按钮（finalizeStreamingMsg 补充复制/重试/调试/删除）
- 调试面板：自动弹出→手动触发（消息工具栏"🔍 调试"按钮）
- P2: Agent 实时状态条（事件总线 + SSE + UI 三阶段显示+进度条+耗时）
- P8: 模型 Payload 调试面板（SSE model_payload 事件 + 前端可视化）

### v0.6.4 (2026-06-21T10:45)
**P0-P3 全部完成**
- P0: LM Studio 适配器修复（chat()路由修正 + reasoning_content 移入 content）
- P0: 推理模型重试逻辑（超时 120s，重试 5 次，Promise.race 竞态修复）
- P1: 配置文件统一（YAML 为主，config.ts 改为兼容层，环境变量替换）
- P2: Dashboard 改进（日志轮转状态接口 /api/logs/status）+ 测试覆盖
- P3: TypeScript strict 模式 + README 完整重写

### v0.6.0 (2026-06-17)
- 初始版本：三层重复检测、日志轮转、全局配置体系、代码审查修复

## 技术债务

| 问题 | 优先级 | 状态 |
|------|--------|------|
| 推理模型响应不可靠 | P0 | ✅ 已加重试，仍需观察 |
| 14 个 pending checkpoint | P1 | 待处理 |
| safePath() 防御不完整 | P2 | 待处理 |
| getCurrentModel() 静默失败 | P2 | 待处理 |
| Phase 2-3 提示词系统改造 | P2 | ✅ 已完成 (v0.7.0) |
| Phase 6 Web UI 待改进项（SSE流式/文件上传/多会话/超时配置） | P2 | ✅ 已完成 (v0.9.0) |
| 跨会话长任务恢复（init() 清除检查点） | P1 | ✅ 已修复 (v0.9.1) |
| 步骤级检查点未启用（executeDAGProtected 未调用） | P1 | ✅ 已修复 (v0.9.1) |
| 无动态重规划（Plan→Execute 缺 Observe→Replan） | P2 | ✅ 已修复 (v0.9.1) |
