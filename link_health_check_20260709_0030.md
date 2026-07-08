# Agent-System 全链路运行评估报告 — 2026-07-09 00:30

## 评估方法

启动完整服务（agent-server + LM Studio），逐层验证从启动到聊天回复的完整调用链，记录各环节表现和问题。

## 链路图

```
启动链路:
  initConfig() → LMStudioAdapter → SessionStore → AgentCore.init()
  → DB → 记忆恢复 → 摘要引擎 → 经验模块 → PromptRegistry → 模型探测
  → IdleTaskManager → Orchestrator心跳 → Handler集成

请求链路 (sendMessage):
  用户输入 → push messages
  → [快速通道] /命令 → handleCommand()
  → [正常路径] IntentParser.parse() → 路由
    → chat → handleChat() → ContextManager → PromptAssembler → LLM → 回复
    → task → handleTask() → Orchestrator → 工具执行 → 回复
    → command → handleCommand()
```

## 链路验证结果

### ✅ 启动链路（通畅）

- 配置加载 ✅ (13 个模块, 56ms)
- 数据库初始化 ✅ (8-24ms)
- 跨会话记忆恢复 ✅ (10 条决策, 4 实体, 1 摘要)
- 摘要引擎 ✅ (LLM 模式)
- 经验模块 ✅ (9 条经验)
- PromptRegistry ✅
- 模型探测 ✅ (LM Studio 已加载 qwen3.6-35b-a3b)
- Handler 集成 ✅ (ChatHandler + CommandHandler + TaskHandler)
- Orchestrator 心跳 ✅ (300s 间隔)
- IdleTaskManager ✅ (3 个任务已注册)

**总启动时间**: 56-208ms，合理范围

### ⚠️ 请求链路（存在严重问题）

#### 问题 1: 意图解析链路断裂（P0 严重）

**现象**: 发送 "ping" → LLM 解析为 `type=command confidence=0.9` → 走 handleCommand → 返回 "Unknown command: ing"

**根因分析**:
1. `quickParse("ping")` 匹配 `msg.length < 5` 返回 `confidence: 0.7`
2. 阈值是 `>= 0.9`，0.7 不满足，继续走 `modelParse`
3. LLM（qwen3.6-35b）把 "ping" 误判为 `type=command`
4. `handleCommand("ping")` 没有匹配任何命令，返回 "Unknown command"
5. **额外问题**: 回复中显示 "ing" 而非 "ping"，说明 handleCommand 可能把首字符当作命令前缀剥离了

**影响**: 用户发送短消息（<5字且不匹配 chatPatterns）会被 LLM 误判，走错误路径

**修复方案**:
- 方案 A: 降低 quickParse 阈值到 `>= 0.7`（短消息直接走 chat）
- 方案 B: 对 `type=command` 但输入不以 `/` 开头的情况，回退到 chat 路径
- 方案 C: 在 handleCommand 入口检查 `!userInput.startsWith('/')` 时回退到 handleChat

**推荐**: 方案 C 最安全（防御性编程），方案 B 次之

#### 问题 2: 意图解析不必要的 LLM 调用（P1 性能）

**现象**: "ping" 这种 4 字短消息走了 55 秒 LLM 意图解析

**根因**: `quickParse` 对短消息返回 `confidence: 0.7`，低于 0.9 阈值

**影响**: 每次闲聊都要等 30-60 秒 LLM 意图解析，严重浪费资源

**修复方案**:
- 短消息（<5字）直接返回 `confidence: 0.95`（提高置信度）
- 或在 `parse()` 中添加规则: `msg.length < 10` 直接返回 chat

#### 问题 3: 配置不一致（P1）

**现象**:
- `GET /api/config` 返回 `model=qwen/qwen3.5-9b`
- `GET /api/models` 返回 `current=qwen/qwen3.6-35b-a3b`
- 实际 LM Studio 加载的是 `qwen3.6-35b-a3b`

**根因**: YAML 配置中的 model 字段是 `qwen/qwen3-1.7b`（之前修复 YAML 拼写时 js-yaml dump 重写了文件），但 GET /api/config 返回 `qwen3.5-9b`（可能来自 default.json 的残留）

**影响**: 配置显示与实际运行不一致，调试困难

#### 问题 4: 模型探测不匹配（P2）

**现象**: 日志显示 `[BreakIn] qwen/qwen3-1.7b: 已有画像 (learning)，跳过探测`，但实际模型是 `qwen3.6-35b-a3b`

**根因**: BreakIn 模块查询的模型名来自配置文件（qwen3-1.7b），与实际加载的模型（qwen3.6-35b-a3b）不匹配

**影响**: 模型能力画像不准确，可能影响智能路由决策

#### 问题 5: SSE 无超时保护（P1，Bug U 未修复）

**现象**: SSE 流式请求阻塞超过 2 分钟，最终被 kill

**根因**: `/api/chat/stream` 没有使用 `chatTimeoutMs` 设置超时

**影响**: 客户端连接长时间占用，服务器资源泄漏

#### 问题 6: 并发请求阻塞（P1）

**现象**: 同时发送同步和流式 chat 请求，两个请求互相阻塞，LM Studio 串行处理导致超时重试

**根因**: LM Studio 只支持串行推理，但服务器没有请求队列/互斥锁

**影响**: 多用户/多标签页场景下请求堆积

### ✅ 功能链路（正常）

- Dashboard API ✅ (返回完整状态)
- 模型列表 ✅ (23 个模型)
- 会话管理 ✅ (7 个会话，CRUD 正常)
- 上下文管理 ✅ (enabled, effectiveWindow=348)
- 配置读写 ✅ (Bug T 修复后 YAML 读写一致)
- 日志系统 ✅ (轮转正常)
- 审计日志 ✅ (4 条事件，100% 成功率)
- 记忆恢复 ✅ (10 条决策, 4 实体)

## 链路合理性评估

### 设计合理的部分

1. **模块化分层清晰**: Config → Adapter → AgentCore → Handlers → LLM
2. **Handler 委托模式**: agent-core 保留 fallback，handler 存在时委托
3. **事件总线 + SSE**: 实时状态推送设计良好
4. **上下文管理器**: TF-IDF + 位置权重的注意力机制
5. **韧性保障**: 检查点 + 熔断器 + 重试引擎
6. **记忆系统**: 文件 + DB 双层，跨会话恢复

### 设计不合理的部分

1. **意图解析阈值不合理**: 0.9 太高，导致大多数消息都要走 LLM（55秒延迟）
2. **handleCommand 无防御**: 不检查输入是否以 `/` 开头就执行命令解析
3. **配置源混乱**: YAML 和 JSON 并存，容易不一致（Bug T 的根因）
4. **无请求互斥**: LM Studio 串行推理但服务器无队列
5. **模型探测与配置脱节**: BreakIn 查询配置中的模型名，而非实际加载的模型名
6. **SSE 无超时**: chatTimeoutMs 配置存在但未使用

## 修复优先级

| 优先级 | 问题 | 修复难度 | 影响 |
|--------|------|----------|------|
| 🔴 P0 | 意图解析断裂（ping→command） | 低 | 用户无法正常聊天 |
| 🔴 P0 | handleCommand 无 / 前缀检查 | 低 | 命令路径误触发 |
| 🟡 P1 | 意图解析阈值过高 | 低 | 闲聊延迟 30-60s |
| 🟡 P1 | SSE 无超时（Bug U） | 中 | 资源泄漏 |
| 🟡 P1 | 并发请求阻塞 | 中 | 多用户场景不可用 |
| 🟡 P1 | 配置不一致 | 低 | 调试困难 |
| 🟢 P2 | 模型探测不匹配 | 低 | 路由决策不准 |

## 总结

**整体链路通畅性**: ⚠️ **部分通畅，有严重阻塞点**

- 启动链路: ✅ 通畅
- 管理链路（dashboard/config/models/sessions）: ✅ 通畅
- **聊天链路: ❌ 严重阻塞** — 意图解析误判导致短消息走错误路径

**最紧急修复**: 
1. handleCommand 入口添加 `/` 前缀检查（5分钟）
2. quickParse 提高短消息置信度到 0.95（5分钟）

这两个修复能让聊天链路立即恢复通畅。
