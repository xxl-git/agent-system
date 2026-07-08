# 系统组件完整性评估 — 2026-07-09 01:00

## 一、组件清单与状态

### 📦 模块化包（11个）

| 包 | 版本 | 源文件 | 测试 | 状态 |
|----|------|--------|------|------|
| @agent-system/core | 0.1.0 | 35 文件 / 415 KB | 7 个测试文件 | ✅ 核心模块齐全 |
| @agent-system/events | 0.1.0 | 2 文件 / 3.6 KB | 0 | ✅ 轻量事件总线 |
| @agent-system/experience | 0.1.0 | 8 文件 / 53.6 KB | 0 | ✅ 经验模块 |
| @agent-system/llm | 0.1.0 | 6 文件 / 18.9 KB | 0 | ✅ LLM Router |
| @agent-system/memory | 0.1.0 | 7 文件 / 44.9 KB | 0 | ✅ 记忆系统 |
| @agent-system/models-core | 0.1.0 | 8 文件 / 18.9 KB | 0 | ✅ 模型探测/画像 |
| @agent-system/prompts | 0.1.0 | 5 文件 / 26.0 KB | 0 | ✅ 提示词系统 |
| @agent-system/resilience | 0.1.0 | 15 文件 / 123.3 KB | 0 | ✅ 韧性保障 |
| @agent-system/server | 0.9.2 | 4 文件 / 82.9 KB | 0 | ⚠️ 仍依赖 workspace src/ |
| @agent-system/skills | 0.1.0 | 6 文件 / 13.3 KB | 0 | ✅ 技能生态 |
| @agent-system/tools | 0.1.0 | 5 文件 / 7.4 KB | 0 | ✅ 工具注册表 |

**测试覆盖**：仅 core 包有 7 个测试文件（29 用例），其他 10 个包 **零测试**。

### 🎯 核心功能模块

| 模块 | 位置 | 状态 | 备注 |
|------|------|------|------|
| AgentCore | core/src/core/agent/agent-core.ts (123KB) | ✅ | 38 个方法，功能完整 |
| ChatHandler | core/src/core/agent/chat-handler.ts | ✅ | 已集成，委托模式 |
| CommandHandler | core/src/core/agent/command-handler.ts | ✅ | 已集成，委托模式 |
| TaskHandler | core/src/core/agent/task-handler.ts | ✅ | 已集成，委托模式 |
| IntentParser | core/src/core/intent-parser.ts | ✅ | 规则+LLM 双路径 |
| Orchestrator | core/src/core/orchestrator.ts | ✅ | Plan→Execute→Observe→Replan |
| ContextManager | core/src/core/context-manager.ts | ✅ | TF-IDF+位置权重，两层压缩 |
| SmartAdapter | core/src/core/smart-adapter.ts | ✅ | 适配器封装 |
| LLMRouter | llm/src/llm-router.ts | ✅ | 统一调用入口 |
| MemorySystem | memory/src/* | ✅ | 文件+DB 双层 |
| ExperienceModule | experience/src/* | ✅ | 提取+存储+检索 |
| SkillRegistry | skills/src/* | ✅ | 技能注册+缺口检测 |
| BreakInMachine | core/src/models/adaptation/ | ✅ | 模型能力画像 |
| SmartRouter | core/src/models/router/ | ✅ | 智能路由 |
| ResilienceOrchestrator | resilience/src/ | ✅ | 熔断+重试+检查点 |
| AuditLog | core/src/audit/ | ✅ | 审计日志 |
| ProjectManager | core/src/core/projects/ | ✅ | 项目管理 |

### 🌐 API 端点（42 个路由）

| 类别 | 数量 | 端点 |
|------|------|------|
| 状态/Dashboard | 7 | /api/status, /api/dashboard, /api/dashboard/{projects,skills,models,health,memory,context} |
| 日志管理 | 10 | /api/logs/{status,errors,level,cleanup,modules,buffer,flush,json,trace} |
| 追踪 | 3 | /api/trace, /api/trace/list, /api/trace/:id |
| 装配 | 2 | /api/assembly, /api/assembly/:id |
| 模型管理 | 5 | /api/models, /api/models/{switch,scan,load,unload} |
| 配置 | 2 | GET/POST /api/config |
| 聊天 | 2 | /api/chat, /api/chat/stream |
| 会话 | 4 | CRUD /api/sessions |
| 韧性 | 1 | /api/resilience/status |
| 文件 | 2 | /api/upload, /api/files |
| **总计** | **42** | |

### ⚙️ 配置文件

| 文件 | 用途 | 状态 |
|------|------|------|
| config/agent-system.yaml | 主配置 | ✅ 13 个模块配置 |
| config/default.json | 旧配置（兼容层） | ⚠️ 仍存在，与 YAML 不一致 |
| config/agent.identity.md | Agent 身份模板 | ✅ v2.1.0 |
| config/prompts/*.md | 7 个提示词模板 | ✅ |
| data/*.db | 3 个 SQLite 数据库 | ✅ |
| data/experiences/*.md | 11 条经验记录 | ✅ |

## 二、需要完善的问题

### 🔴 P0 — 影响核心功能

#### 1. SSE 无超时保护（Bug U，未修复）
- **位置**: `src/server/agent-server.ts` L1211-1330
- **问题**: `/api/chat` 和 `/api/chat/stream` 都没有使用 `chatTimeoutMs` 设置超时
- **影响**: LLM 长时间不响应时请求挂起，资源泄漏
- **修复**: 添加 `AbortController.timeout(chatTimeoutMs)` 包装 `ag.sendMessage/messageStream`

#### 2. 配置不一致
- **YAML**: `models.providers.lmstudio.model = qwen/qwen3.5-9b`（与实际不符）
- **YAML**: `server.chattimeoutMs`（拼写错误，应为 `chatTimeoutMs`）
- **实际**: LM Studio 加载 `qwen/qwen3.6-35b-a3b`
- **影响**: 配置显示与运行不一致，BreakIn 查询错误模型画像
- **修复**: 更新 YAML model 字段为实际模型名；修复 `chattimeoutMs` → `chatTimeoutMs`

### 🟡 P1 — 架构/质量问题

#### 3. 测试覆盖严重不足
- **现状**: 11 个包中仅 `core` 有测试（7 个文件/29 用例）
- **缺口**: events, experience, llm, memory, models-core, prompts, resilience, server, skills, tools 全部零测试
- **风险**: 模块改动无回归保护
- **建议**: 至少为 resilience（熔断/重试）、memory（DB 读写）、llm（路由）添加单元测试

#### 4. 并发请求无互斥
- **问题**: LM Studio 串行推理，但服务器无请求队列/互斥锁
- **影响**: 多用户/多标签页场景下请求互相阻塞
- **修复**: 添加请求队列或互斥锁

#### 5. packages/server 未完全独立
- **现状**: `packages/server/src/` 有 4 个文件，但 `src/server/` 仍有 3 个文件（agent-server.ts, dashboard-api.ts, session-store.ts）
- **问题**: 两份代码可能不同步
- **建议**: 统一到 `packages/server/src/`

#### 6. packages/core 存在冗余/废弃文件
- `core/src/core/agent/agent-core.ts.backup` (70KB) — 废弃备份
- `core/src/core/agent/agent-core.ts.backup_20260623` (67KB) — 废弃备份
- `core/src/core/agent/command-handler-v2.ts` (2.5KB) — 未使用的 v2 版本
- `core/src/core/__test__/alpha.ts` (28 字节，空文件)
- `core/src/core/__test__/beta.ts` (55 字节，空文件)
- **建议**: 删除废弃文件

### 🟢 P2 — 优化项

#### 7. 工作区根目录混乱
- 60+ 个临时文档（FIX/REVIEW/TEST/PHASE/P0/P1/P2 等前缀）
- 30+ 个临时脚本和日志文件
- **建议**: 归档到 `docs/history/` 或 `.archive/`

#### 8. 模型探测与运行时脱节
- **问题**: BreakIn 查询配置中的模型名（qwen3-1.7b），但实际加载 qwen3.6-35b-a3b
- **影响**: 能力画像不准，影响智能路由决策
- **修复**: BreakIn 应查询 `adapter.model`（实际加载的模型名）

#### 9. /api/trace/list 返回空数组
- **问题**: `tracerModule.getRecentTraces` 方法未实现
- **影响**: 追踪列表 API 无数据
- **修复**: 实现该方法或移除该端点

#### 10. 上下文窗口配置过小
- **现状**: `context.maxTokens = 4000`, `effectiveWindow = 348`
- **问题**: 348 tokens 的有效窗口过小，长对话会频繁触发压缩
- **建议**: 根据模型实际能力调整（qwen3.6-35b 支持 32K+）

## 三、组件完整性总结

### ✅ 已完整的部分

1. **核心 Agent 循环**: 意图解析 → 任务分解 → 工具执行 → 记忆 → 回复
2. **模块化架构**: 11 个独立包，npm workspaces 配置
3. **记忆系统**: 文件+DB 双层，跨会话恢复，摘要引擎
4. **上下文管理**: TF-IDF+位置权重，两层压缩
5. **韧性保障**: 熔断器+重试引擎+检查点+健康监控
6. **模型管理**: 探测+画像+智能路由+热切换
7. **经验模块**: 提取+存储+检索+条件注入
8. **提示词系统**: Registry+Assembler+7 个模板
9. **Web API**: 42 个端点覆盖全功能
10. **审计+追踪**: 审计日志+全链路追踪
11. **Handler 委托**: ChatHandler/CommandHandler/TaskHandler 已集成

### ❌ 需要完善的部分

| 优先级 | 项目 | 工作量 |
|--------|------|--------|
| 🔴 P0 | SSE 超时保护 (Bug U) | 30 分钟 |
| 🔴 P0 | 配置不一致修复 | 15 分钟 |
| 🟡 P1 | 测试覆盖（10 个包零测试） | 2-3 天 |
| 🟡 P1 | 并发请求互斥 | 2 小时 |
| 🟡 P1 | packages/server 统一 | 1 小时 |
| 🟡 P1 | 清理废弃文件 | 30 分钟 |
| 🟢 P2 | 工作区归档整理 | 1 小时 |
| 🟢 P2 | 模型探测与运行时对齐 | 1 小时 |
| 🟢 P2 | /api/trace/list 实现 | 30 分钟 |
| 🟢 P2 | 上下文窗口调优 | 15 分钟 |

## 四、结论

**系统组件基本完整**，核心功能链路已打通（启动→意图解析→聊天/任务/命令→记忆→回复）。

**最紧急的 2 个问题**:
1. SSE 无超时（Bug U）— 会导致资源泄漏
2. 配置不一致 — 影响调试和模型探测

**最大的结构性问题**:
- 测试覆盖仅 9%（1/11 包有测试），重构和改动无回归保护

建议按优先级依次修复 P0 → P1 → P2，优先解决 SSE 超时和配置不一致，然后补充测试覆盖。
