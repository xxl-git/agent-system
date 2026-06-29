# Agent System v0.9.2

模块化 AI Agent 框架，基于 LM Studio 本地推理，支持工具调用、上下文管理、Dashboard 监控。

## 特性

- **本地模型自动探测**：启动时自动探测 LM Studio 已加载模型，支持运行时热切换（无需重启）
- **SSE 流式输出**：逐 chunk 实时转发，前端 ReadableStream 消费，失败自动降级到非流式
- **复杂长任务处理**：任务 DAG 分解 + 步骤级检查点 + 跨会话恢复 + 动态重规划（Observe→Replan）
- **多会话管理**：SQLite 持久化多会话历史，侧滑抽屉式 UI，支持新建/切换/重命名/删除
- **文件上传**：📎 按钮上传 + 拖放上传，消息内图片自动渲染，文件提供下载链接
- **多提供商支持**：LM Studio / OAI模型 / OpenRouter / 自定义
- **智能适配器**：自动降级、超时重试、重复检测
- **上下文管理器**：无上限上下文，TF-IDF 注意力评分 + 两层压缩
- **提示词系统**：PromptRegistry 模板注册 + PromptAssembler 语义层次组装，提示词外置可热更新
- **统一 LLM Router**：所有 LLM 调用统一入口，自动广播 payload 到调试面板
- **经验模块**：自动提取成功模式/踩坑教训，三层检索匹配，条件性注入相关经验到每轮对话
- **日志轮转**：大小阈值触发 gzip 压缩，防止日志文件无限增长
- **Dashboard**：Web UI 实时监控（端口 19701）
- **配置文件统一**：YAML 为主，支持热重载和环境变量替换
- **重复检测**：字符级 / 子序列 / 段落级 / 跨轮次四层防护

## 快速开始

### 一键启动（推荐）

双击项目根目录的 `start.bat`，脚本会自动完成：
1. 检测服务器是否已运行 → 已运行则自动停止并重启，未运行则直接启动
2. 编译 TypeScript（`tsc`）→ 确保 dist 产物最新
3. 检查 LM Studio 连接状态 → 未启动时给出警告
4. 在新窗口启动服务器并自动打开浏览器

> 再次双击 `start.bat` = 自动重启服务器。

### 手动启动

```bash
# 安装依赖
npm install

# 构建
npm run build

# 启动服务
node dist/server/agent-server.js
```

服务启动后访问 `http://localhost:19701/agent-ui.html` 打开 Dashboard。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/chat` | POST | 聊天接口（非流式） |
| `/api/chat/stream` | POST | SSE 流式聊天接口 |
| `/api/events` | GET | SSE 事件流（状态/payload/聊天 chunk） |
| `/api/status` | GET | 服务状态 |
| `/api/dashboard` | GET | 完整 Dashboard 数据 |
| `/api/logs/status` | GET | 日志轮转状态 |
| `/api/config` | GET/POST | 查看/更新配置（含 chatTimeoutMs） |
| `/api/models` | GET | 列出 LM Studio 已加载模型（含元数据）|
| `/api/models/switch` | POST | 热切换运行中的模型（无需重启）|
| `/api/models/scan` | POST | 重新扫描 LM Studio 已加载模型 |
| `/api/sessions` | GET/POST | 会话列表 / 新建会话 |
| `/api/sessions/:id` | GET/PUT/DELETE | 查看/重命名/删除会话 |
| `/api/upload` | POST | 文件上传（multipart/form-data） |
| `/uploads/*` | GET | 上传文件静态服务 |
| `/admin` | GET | 管理控制台 |

完整端点列表见 `src/server/agent-server.ts`。

## 配置文件

主配置文件：`config/agent-system.yaml`

```yaml
# 日志配置
logging:
  level: info
  maxFileSizeMB: 10
  maxRotatedFiles: 5

# 模型配置
models:
  defaultProvider: lmstudio
  providers:
    lmstudio:
      baseUrl: "http://127.0.0.1:1234/v1"
      apiKey: "not-needed"
      model: "qwen/qwen3.5-9b"
      timeoutMs: 120000

# 服务器配置
server:
  port: 19701
  chatTimeoutMs: 120000
  maxUploadSizeMB: 20
```

支持环境变量替换：`apiKey: "${DEEPSEEK_API_KEY}"`

## 测试

```bash
# 运行所有测试
npm test

# 运行单个测试
npx ts-node tests/test-env-substitution.ts
```

测试文件：
- `tests/test-env-substitution.ts` - 环境变量替换
- `tests/test-log-rotation.ts` - 日志轮转
- `tests/test-dedup-detection.ts` - 重复检测

## 项目结构

```
src/
  config/          # 配置加载
  core/            # 核心逻辑（AgentCore, SmartAdapter, ContextManager）
  llm/             # 统一 LLM Router（含 callStream 流式接口）
  prompts/         # 提示词模板注册表 + 组装器
  experience/      # 经验模块（Store + Extractor + Retriever + Commands）
  models/adapters/ # 模型适配器（含 chatStream 流式方法）
  server/          # HTTP 服务 + Dashboard API + SessionStore
  tools/           # 工具注册
tests/             # 测试文件
config/            # 配置文件（含 prompts/ 提示词模板）
dist/              # 编译输出
uploads/           # 用户上传文件（运行时生成）
data/              # SQLite 数据库（sessions.db, experiences.db 等）
```

## 版本历史

### v0.9.2 (2026-06-28)
- ✅ 本地模型自动探测：启动时自动列出 LM Studio 已加载模型（名称/架构/上下文长度）
- ✅ 模型热切换：`POST /api/models/switch` 运行时切换模型，无需重启服务
- ✅ 模型重新扫描：`POST /api/models/scan` 重新查询 LM Studio
- ✅ 增强 `GET /api/models`：返回完整元数据 + 连接状态
- ✅ CLI 增强：`/models list|scan|switch <name>` 支持实时探测与切换
- ✅ 前端增强：模型下拉显示上下文/架构，🔄 刷新按钮，热切换即时生效

### v0.9.1 (2026-06-28)
- ✅ 跨会话长任务恢复：`init()` 不再清除检查点，支持跨会话恢复未完成任务
- ✅ 步骤级检查点：orchestrator 每步完成后自动保存到 `CheckpointManager`
- ✅ 动态重规划（Observe→Replan）：失败后 LLM 评估是否调整后续计划，默认最多 2 次重规划
- ✅ `/resume` 命令：列出/恢复待完成任务，重建上下文 + 执行剩余步骤
- ✅ `/ckpt` 命令：检查点管理（list/show/clear）
- ✅ `/pause` 命令：暂停当前任务

### v0.9.0 (2026-06-21)
- ✅ SSE 流式输出：`POST /api/chat/stream` 逐 chunk 转发，前端 ReadableStream 消费
- ✅ 多会话管理：SQLite 持久化，CRUD API，侧滑抽屉式 UI
- ✅ 文件上传/图片显示：multipart 解析 + 拖放上传 + 消息内图片渲染
- ✅ 超时可配置化：`server.chatTimeoutMs` 配置项，设置面板可调
- ✅ 新增文件：`src/server/session-store.ts`
- ✅ 新增流式方法：`chatStream()` / `callStream()` / `sendMessageStream()`

### v0.8.1 (2026-06-21)
- ✅ 经验管理命令系统 (/exp)：add/confirm/cancel/list/view/search/edit/delete/stats
- ✅ LLM 辅助经验加工：用户描述 → 泛化草稿 → 确认保存
- ✅ 去重检查：相似度 >85% 时提示合并而非新建

### v0.8.0 (2026-06-21)
- ✅ 经验模块：ExperienceStore + Extractor + Retriever
- ✅ 自动提取经验（LLM 辅助 + 规则引擎兜底）
- ✅ 三层降级检索（标签→关键词→场景）
- ✅ 评分衰减机制（30/90 天梯度）
- ✅ 条件性注入：有匹配才注入，不浪费 token
- ✅ agent.identity v2.1.0：新增经验能力清单和检索指引

### v0.7.0 (2026-06-21)
- ✅ 提示词系统改造（Phase 2-3）：PromptRegistry + PromptAssembler
- ✅ Memory Block 角色修正：跨会话记忆不再污染 system
- ✅ 提示词硬编码消除：intent-parser/task-decomposer/summarizer 全部模板化
- ✅ 6 个外部提示词模板文件（config/prompts/），支持热更新

### v0.6.6 (2026-06-21)
- ✅ 统一 LLM Router：5 个调用点统一入口，全链路可观测
- ✅ 调试面板增强：taskType 标签 + payload 历史导航

### v0.6.5 (2026-06-21)
- ✅ SSE 实时状态条（事件总线 + 7 种状态）
- ✅ 模型 Payload 调试面板
- ✅ 状态条卡死修复 + 调试面板交互优化

### v0.6.4 (2026-06-21)
- ✅ 推理模型兼容（qwen3.5-9b reasoning_content 支持）
- ✅ 智能适配器重试逻辑（超时 120s，重试 5 次）
- ✅ 日志轮转（gzip 压缩 + 配置化）
- ✅ 配置文件统一（YAML 为主，config.ts 兼容层）
- ✅ Dashboard 日志状态接口
- ✅ 重复检测四层防护
- ✅ API Key 环境变量化

### v0.6.0 (2026-06-17)
- 初始版本
