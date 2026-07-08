# Lessons Learned — Agent System 开发经验

> 最后更新：2026-06-20（九、数据层与存储设计 + 十、通用审查方法）
> 
> 本文档记录开发过程中踩过的坑和学到的教训，供后续开发参考。
> 同步记录在 `HANDOVER.md` 第七节。

---

## 一、诊断铁律

### 1.1 不动外部进程原则 🔴

**踩坑**：用户报"本地模型调用不了"，我直接 `Stop-Process` 杀了 LM Studio → 忘了重启 → API 完全不可达 → 雪上加霜。误杀外部依赖后把操作问题当成代码问题继续排查，浪费大量时间。

**铁律**：
- 诊断外部服务（LM Studio、数据库、Docker）时，**只检查不修改**
- 需要重启/杀进程时，**必须先问用户**，绝不能自行操作
- 外部服务挂了 ≠ 你的代码坏了，先确认外部状态再查代码

**正确流程**：
1. `curl GET /v1/models` → 确认服务存活
2. `lms ps` → 确认模型加载状态
3. `curl POST /v1/chat/completions` → 确认推理正常
4. 确认完外部再查代码

### 1.2 找到问题 ≠ 已经修复 🔴

**踩坑**：定位到 SmartAdapter 缺少 reasoning_content 处理 → 直接上手改 → 改完没验证就报完成 → 引出更多 bug（maxTokens 过大触发死循环）。

**铁律**：
- 确认问题后，**完整列出修复方案给用户确认**
- 修复后必须**自己走通验证**，用户只负责验收
- 多个修复方案时，列出优劣对比让用户选择

### 1.3 "改了什么 = 什么坏了"思维陷阱 🔴

**踩坑**：用户报 bug → 第一反应"是不是我改的代码搞坏了" → 急于证明代码没问题 → 操作变形，创造更大问题（杀 LM Studio 进程）。

**铁律**：
- **外归因优先**：先确认外部依赖状态（进程活着吗？模型加载了吗？网络通吗？），再查代码
- 内归因在确认外部正常后再启动
- **责任边界**：agent-server 是我的可以动，LM Studio 是用户的不能动

---

## 二、开发铁律

### 2.1 每改一处立即验证 🟡

**踩坑**：Provider CRUD + 路由 + UI + 配置一口改完 → bug 混在一起，3 个 bug 需要分别定位，总耗时远超逐个验证。

**铁律**：
- 每改一个接口/路由 → **立即 curl 验证**
- 改动链 >3 层时 → 先画简图再动代码
- 流转路径写注释，标注实际跳转关系

### 2.2 dist 是编译产物，改 src 必须 build 🟡

**踩坑**：直接改了 `dist/core/smart-adapter.js` → 忘了同步 `src/core/smart-adapter.ts` → 下次 `tsc` 编译会覆盖修复。

**铁律**：
- **永远改 src**，改完 `npm run build` 生成新 dist
- 紧急热修可以同时改 dist + src，但必须确保两者一致
- 提交前检查 src 和 dist 的关键修改是否同步

### 2.3 扁平 API 设计是坑 🟡

**踩坑**：`POST /api/config { model }` 把 `model` 写入了顶层 `.model` 而非嵌套的 `models.providers.lmstudio.model`。

**铁律**：
- config 对象的 key 含义取决于调用上下文，不能一刀切
- 嵌套配置的 API 必须显式指定完整路径
- 配置写入后必须**立即读回验证**

### 2.4 实例级计数器不要跨调用共享 🟡

**踩坑**：`SmartAdapter.consecutiveTimeouts` 是实例属性，被所有 `chat()` 调用共享。
CapabilityProbe 依次执行 7 个探针，probe 1 超时后 counter=1；probe 2 超时后 counter=2；
probe 3 调用 `chat()` 即使 LM Studio 秒回，counter=2 不满足 ≥3 条件。但 probe 2 的
SmartAdapter 后台重试仍然在跑，如果 probe 2 的第二轮重试也超时，counter=3 → 死循环降级 →
所有后续 probe 都收到降级回复 → 0% 评分。

**铁律**：
- 一次调用内的重试计数器应该用局部变量，不要用实例属性
- 共享计数器只在需要跨调用统计的场景使用（如连续 N 次空响应）
- 每个 probe 的 request 量级是独立的，失败不应该影响后续 probe

### 2.5 reasoning_content 修校验不忘转发 🟡

**踩坑**：`SmartAdapter.chat()` 内部 `const content = msg?.content || msg?.reasoning_content || ''`
只用于本地的空检测和重复检测，但 `return result;` 返回的是原始 response（content 仍为空）。
下游读取 `response.choices[0].message.content` 得到空字符串 → 判定为失败。

**铁律**：
- SmartAdapter 的职责包括**标准化 response**，不只是校验
- 如果从 `reasoning_content` 拿到了内容，应改写 `msg.content` 再返回
- 写 return 路径前 trace 下游消费者是怎么读响应字段的

### 2.6 代码复用层叠调用时注意跳跃 🟡

**踩坑**：`SmartAdapter.callWithTimeout()` 直接 `fetch()` 跳过了 `LMStudioAdapter.chat()` 的 Authorization 头装配 → HTTP 401。

**铁律**：
- 底层快捷方法可能跳过中间层的关键逻辑（如 header 装配、重试策略）
- 新增快捷路径时，**逐一检查被跳过层的副作用**
- 关键逻辑（认证、超时、重试）不能依赖中间层传递，应在最底层保证

### 2.5 入库操作检查字段完整性 🟡

**踩坑**：`POST /api/providers` 解构只取了 `{ id, name, baseUrl, apiKey, type }`，漏了 `model` → 数据不完整。

**铁律**：
- 任何入库操作必须检查字段完整性
- 不能默认可选字段会被传过来
- 入库后立即读回验证

---

## 三、LM Studio 模型知识库

### 3.1 推理模型 vs 普通模型

| 模型 | 类型 | content | reasoning_content | 适合 Agent？ |
|------|------|---------|-------------------|-------------|
| qwen/qwen3.5-9b | 推理 | 空"" | ✅ 全部内容 | ⚠️ 需 fallback |
| nanbeige4.1-3b | 推理 | 空"" | ✅ 全部内容 | ⚠️ 需 fallback |
| deepseek-r1-0528-qwen3-8b | 推理 | 空"" | ✅ 全部内容 | ⚠️ 需 fallback |
| qwen/qwen3-4b-thinking-2507 | 推理 | 空"" | ✅ 全部内容 | ⚠️ 需 fallback |
| glm-4-9b-chat-1m | 普通 | ✅ 正常 | 无 | ✅ 但有重复生成 |
| qwen3.6-35b-a3b-mtp | 未测 | - | - | 需测试 |

**关键发现**：
- 推理模型的 token 全部进入 `reasoning_content`，`content` 为空字符串
- 代码必须兼容：`content = msg?.content || msg?.reasoning_content || ''`
- 推理模型需限制 `maxTokens`（建议 256），避免触发重复检测死循环
- 普通模型直接写 `content`，无 `reasoning_content`

### 3.2 lms CLI 调试工具

- 路径：`C:\Users\xl\.lmstudio\bin\lms.exe`
- `lms ps` — 查看已加载模型及状态（IDLE/GENERATING）
- `lms load <model>` — 加载模型到显存
- `lms unload <model>` — 卸载模型释放显存
- `lms ls` — 列出磁盘上所有可用模型
- 模型卡在 GENERATING 时需 `lms unload` + `lms load` 重新加载

### 3.3 LM Studio 常见故障模式

| 故障 | 症状 | 修复 |
|------|------|------|
| 模型未加载 | API 500 `{"error":"terminated"}` | GUI 手动加载 或 `lms load` |
| 模型卡死 | 状态 GENERATING 不产出 | `lms unload` + `lms load` |
| 端口占用 | 新进程无法绑定 | `Get-NetTCPConnection -LocalPort 1234` |
| 显存不足 | 加载大模型失败 | 先 unload 其他模型 |

---

## 四、安全教训

### 4.1 API Key 管理
- **不要硬编码**到 `config/default.json`，应使用环境变量
- **不要通过 API 明文返回** Key（`GET /api/providers` 曾暴露 DeepSeek Key）
- 脱敏处理：API 响应中只显示前4位 + `****`
- `config/providers.json` 应加入 `.gitignore`

### 4.2 路径穿越防护
- 已实现 `safePath()` + 敏感目录名单
- 但仍需定期审查 API 端点是否泄露配置信息

---

## 五、模块初始化

### 5.1 singleton 模式的隐式依赖 🔴

**踩坑**：`FileMemoryStore` 设计为 singleton（`getMemoryStore()`），但 `initMemoryStore(dir)` 从未被调
用过。所有调用者（`recordInteraction`、`SessionRecoverer.recover`）都静默失败，因为 `store` 为 null 时
`getMemoryStore()` 直接 throw `'Memory store 未初始化'`。

**铁律**：
- Singleton 模式必须有两个显式调用点：`init()`（初始化可用资源）和 `get()`（获取实例）
- 未初始化时 `get()` 应静默返回 safe default（如 no-op 实现），而不是 throw
- 每次模块初始化，检查所有 singleton 是否在 bootstrap 中被调用了 `init()`

### 5.2 构造函数中的路径假设必须与模块位置一致 🔴

**踩坑**：`agent-core.ts` 构造函数中 `require('../config')` 从 `src/core/agent/` 解析为
`src/core/config`，但实际文件在 `src/config.ts`。try-catch 吞了错误，cfg 始终为 null，
导致 `config/default.json` 中所有 `agent.callTimeoutMs`、`maxRetries` 等配置值从未被应用。

**铁律**：
- 构造函数中的 require 路径基于文件位置，不是基于入口文件
- 内联 require 和模块级 import 使用相同的相对路径计算方式
- try-catch 吞异常时必须加注释说明可能吞了什么

### 5.3 类属性必须与使用保持同步 🟡

**踩坑**：`ContextManager` 声明了 `_currentHotCount` 属性但从未写入，`getStats()` 返回
`lastHotCount: 0` 硬编码而非读取属性。积累无用属性增加代码理解成本。

**铁律**：
- TypeScript 类属性如果有字段声明必须有写操作
- getStats/getStatus 应反映实际收集的数据，不用占位值

---

## 六、日志系统

### 6.1 JSON.stringify(Error) 输出 {} 🔴

**踩坑**：项目中所有 `logger.warn('...', err)` 记录的错误信息都是空的，因为 Error 对象
的实例属性（`message`、`stack`）是 non-enumerable 的，`JSON.stringify(new Error('x'))` 返回 `{}`。
所有日志中的 `memory write failed {}`、`探测失败 {}` 都无声丢失了错误描述。

**铁律**：
- 日志参数中的 Error 对象必须特殊处理：输出 `name: message` 和 stack 的前几行
- `formatArg()` 函数应作为日志系统的标准组件
- 每次日志改造后应验证：`logger.warn('test', new Error('hello'))` 是否包含 `hello`

### 6.2 日志级别的运行时读取能力 🟡

**铁律**：
- Logger 应该暴露只读的 `getLevel()` 方法，供外部检查
- 日志组件状态也是系统状态的一部分

---

## 七、架构层

### 7.1 SmartAdapter 不应绕过 LMStudioAdapter 🔴

**踩坑**：`SmartAdapter.callWithTimeout()` 直接用 `fetch()` 调用 LM Studio API，完全跳过了
`LMStudioAdapter.chat()`。导致：
1. 重复代码（两处构建完全相同的 HTTP payload）
2. 日志不一致（两套日志路径）
3. 缺少适配器侧的任何认证/超时扩展点

**铁律**：
- 适配器模式要求中间层只能增强不能跳过底层
- `callWithTimeout` 的正确实现：`Promise.race([this.raw.chat(), timeout])`
- 如果底层需要取消能力，在 `chat()` 接口上新增 `AbortSignal` 参数

### 7.2 dist 同步双写原则 🟡

**踩坑**：修改 src 后无法运行 `npm run build`（exec 被安全策略拦截），需要手动同步修改 dist。

**铁律**：
- 同时改 src 和 dist 时必须逐行对比确保一致
- 逻辑变更（如 `callWithTimeout` 重写）比数据变更更容易遗漏
- 源文件和编译产物之间必须有显式的同步检查点

## 八、代码审查范围铁律 🔴

### 8.1 Review 必须覆盖跨层依赖

**踩坑**：两轮代码审查共修复 17+ 个代码问题（类型错误、超时竞争、`as any`、import 风格等），但没有发现管理面板 iframe 加载 `/chat` 路径缺失——这个问题的根源只需要三步就能发现：
1. 看 `admin-panel.html` 里 `frame.src = '/chat'`
2. 看 `agent-server.ts` 路由表里没有 `/chat`
3. 两个文件放一起对照 → 0.5 秒定位

**铁律**：
- Review 范围不能只盯 `src/` 下的 TS 代码，**必须包含前端静态文件**（HTML/CSS/JS）
- 后端路由修改后，**必须检查**前端所有 `fetch()`、`iframe.src`、`window.location` 的目标路径是否都有对应实现
- 前端路由依赖必须与后端路由表做**交叉验证**

### 8.2 Review ≠ 功能测试

**踩坑**：两轮 review 没有任何一步是实际启动服务器并打开浏览器验证。如果 review 后跑一次集成测试（启动 → 点 admin/chat tab），0.5 秒就能发现白屏。

**铁律**：
- Review 完成后，**必须执行一次功能验证**（启动服务 + UI 操作）
- 静态 HTML 文件不是编译产物，审查时必须将其纳入跨层依赖检查范围

---

## 九、数据层与存储设计 🔴

### 9.1 数据库计数器慎用自增，改设最终值

**踩坑**：`DBStore.endSession()` 中 `message_count = message_count + 1` 每次调用 +1。但 `endSession` 只被调用一次（会话结束），应该设最终消息数而非增量。更隐蔽的问题是：如果未来某天 `endSession` 被多次调用，消息数会膨胀成错误的数字。

**铁律**：
- 写操作若语义是「设值」而非「增量」，就不要用 `+= 1` 自增
- 接收明确的值作为参数：`endSession(messageCount: number)` 而非 `endSession()`
- 被调用一次 ≠ 未来只会被调用一次，API 应在设计上防御重复调用

### 9.2 上游层不能跳过中间层 API 直接操作底层资源

**踩坑**：`SessionRecoverer.loadRecentFileMemory()` 直接 `readdirSync` + `readFileSync` 绕过 `FileMemoryStore`，重复实现了文件读取逻辑（路径拼接、UTF-8 读取）。绕过导致：
1. 无法利用 FileMemoryStore 的 readToday() 去重能力
2. 读取逻辑分散在多个文件中，修改需改多处
3. 增加了 `fs` 模块的导入依赖

**铁律**：
- 如果抽象层（如 FileMemoryStore）存在，上层代码必须通过其公共 API 操作
- 直接调用 `fs` 绕过抽象层等同于「抽象泄漏」——标志是注释说「直接读文件更快」
- 发现抽象泄漏时，优先增强抽象层 API，不要在上游「走捷径」

### 9.3 持久化数据的截断阈值要留余地

**踩坑**：`recordInteraction()` 写文件记忆时 `input.slice(0, 200)` + `output.slice(0, 200)`。对于长对话，输入的上下文（用户问题+历史摘要）和模型输出轻松超过这个数，90% 的内容被丢掉，记忆恢复时只有摘要片段。

**铁律**：
- `n=200` 的截断对任何真实对话场景都太小，500-1000 是合理起点
- 截断应在添加 `...(truncated)` 标记让下游知道数据不完整
- 如果数据可能是结构化的（JSON/代码），截断会破坏语法，考虑按语义边界截断

### 9.4 SQL 查询的条件字段必须与语义一致

**踩坑**：`queryDecisions({ sessionId: 'xxx' })` 执行的 SQL 是 `WHERE project = ?`，把 `sessionId` 传给了 `project` 字段。两张表 `decisions` 根本没有 `session_id` 列，查出来的结果要么为空，要么匹配到同名 project 的错误数据。

**铁律**：
- SQL 查询的 WHERE 字段必须与传入的参数名一致，不能「隐式映射」
- 如果需要跨字段匹配，应在 SQL 中显式写 `WHERE session_id = ? OR project = ?`
- 新字段的 schema 变更必须：`CREATE TABLE` 包含新列 + `ALTER TABLE` 兼容旧表 + 索引

### 9.5 文件存储必须有旋转/裁剪机制

**踩坑**：`FileMemoryStore` 无大小限制无轮转。每天会话追加写入可产生任意大的文件。`readToday()` 一次性读出全部内容，对 Agent 上下文窗口造成内存冲击。

**铁律**：
- 任何 append-only 文件存储都必须有裁剪机制（按时间/按大小/按条目数）
- 裁剪应在 init 时自动执行，不需要使用者手动触发
- 新增 `getStats()` 方法暴露当前存储的健康状态：文件数、总大小、最旧文件

### 9.6 LLM 递归必须有逃生门

**踩坑**：`summarizer.ts` 中 `llmSummarize()` 失败后调用 `this.summarizeSession()`，而 `summarizeSession()` 又尝试调用 `llmSummarize()` → 无限递归。递归深度取决于 LLM 失败次数，实际上每次调用都重新从 LLM 开始尝试，永远无法退出。

**铁律**：
- 任何递归调用 LLM 的路径必须有递归深度计数
- LLM 失败两次后必须 fallback 到纯规则引擎，不能再尝试 LLM
- fallback 路径必须与方法入口解耦（提取 `ruleEngineSummarize()` 为独立方法），避免「fallback 到递归入口」的 bug

### 9.7 搜索 API 返回的结果要有内容可消费

**踩坑**：`FileMemoryStore.search()` 返回 `string[]`（仅文件名列表）。调用者拿到一堆文件名但不知道为什么匹配、匹配在哪些行，除了打印出来毫无用处。

**铁律**：
- 搜索功能的返回值必须包含匹配证据：文件名 + 匹配的行片段（前后各 N 行上下文）
- 如果只返回文件名的 search，和 `ls | grep` 没有区别，不应作为 API 存在
- 返回结构应扁平化，方便下游直接拼接展示

### 9.8 不保留「有替代」的 API 别名

**踩坑**：`DBStore` 上有 `storeSummary()` 和 `addSummary()` 两个方法，功能完全相同。调用方 `summarizer.ts` 用 `storeSummary()`，其余地方用 `addSummary()`。两处改一处时会遗漏另一处。

**铁律**：
- 功能完全相同的 API 不要保留两个名字，消除不确定性
- 别名会制造「哪个是对的」的困惑，增加认知负担
- 删除别名后必须更新所有调用点，并编译验证

---

## 十、通用审查方法 🟡

### 10.1 审查起点选择：从最可疑的文件跳进去

**踩坑总结**：本次审查从 `agent-core.ts` 出发，依次追踪其调用的记忆模块，形成了天然的调用链审查顺序：`agent-core.ts` → `session-recovery.ts` → `db-store.ts` → `file-store.ts` → `summarizer.ts`。按此路径找到 9 个问题的完整链路。

**铁律**：
- 审查从入口文件（agent-core.ts）开始，沿调用链顺藤摸瓜
- 每种「沉默的失败」都是潜在 bug——`try-catch` 不打印来源、`slice` 不告知截断、SQL 查不出来不 log
- 审查完要问一个问题：如果现在发生故障，日志能不能告诉我发生了什么？答案如果是否定的，日志就是下一个修复目标

### 10.2 表结构审查备忘录

审查任何数据库存储层时，逐项检查：
- [ ] 字段语义与参数名一致（sessionId 查 session_id 而非 project）
- [ ] 写操作的语义是增量还是设值（+= 1 vs = value）
- [ ] 截断阈值上线后验证是否够用（测试真实数据量）
- [ ] 文件/记录有无裁剪机制（按时间/数量）
- [ ] LLM 调用路径有无递归保护（计数+逃生门）
- [ ] 搜索 API 返回的内容是否可直接消费（带匹配片段的行）
- [ ] 重复/别名方法是否已清理（storeSummary/addSummary 二选一）
- [ ] 抽象层是否被绕过（上层直接 fs 而非走 store API）
