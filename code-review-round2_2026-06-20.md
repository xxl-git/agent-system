# 第2轮代码审查 + 修复记录 — 2026-06-20

## 审查范围

对所有 `src/` 下核心模块进行系统性审查，包括：

- `src/core/smart-adapter.ts` — 智能适配器
- `src/core/context-manager.ts` — 上下文管理
- `src/core/agent/agent-core.ts` — Agent 核心循环
- `src/server/agent-server.ts` — HTTP 服务入口
- `src/server/dashboard-api.ts` — 仪表盘 API
- `src/logger.ts` — 日志系统
- `src/config.ts` — 配置加载
- `src/models/adapters/lmstudio.ts` — LM Studio 适配器
- `src/models/probe/capability-probe.ts` — 能力探测引擎
- `src/models/probe/probes.ts` — 探针定义
- `src/models/adaptation/break-in-machine.ts` — 磨合期状态机
- `src/models/profile/model-profile.ts` — 模型画像存储
- `src/resilience/orchestrator.ts` — 恢复编排器

外加对应的 `dist/` 编译产物一致性检查。

## 发现的 12 个问题

### 🔴 严重 (3个已修复)

| 问题 | 根因 | 修复 |
|------|------|------|
| `reset()` 引用未定义属性 `consecutiveTimeouts` | 旧代码重构后残留，该属性已用局部变量 `localTimeouts` 替代 | 移除该行 |
| `JSON.stringify(err)` 输出 `{}` | Error 对象属性 non-enumerable，所有 `warn/error` 日志中的错误信息丢失 | 新增 `formatArg()` 函数，Error 输出 name+message+stack |
| `callWithTimeout()` 绕过底层适配器 | 直接用 `fetch()` 重复 HTTP 逻辑，跳过认证/日志/格式化 | 改为委托 `this.raw.chat()` + Promise.race 超时 |

### 🔴 严重 (1个待修复)

| 问题 | 根因 |
|------|------|
| 双超时竞争 (capability-probe.ts:107) | Probe 30s + SmartAdapter 30s 同时跑，超时后底层请求不取消 |

### 🟡 中等 (5个，2个已修复)

| 问题 | 状态 |
|------|------|
| config 加载路径错误 (`agent-core.ts` require → 错误路径) | ✅ 修复 |
| `_currentHotCount` unused + `lastHotCount: 0` 占位 | ✅ 修复 |
| dashboard-api `loadConfig` import 未使用 + require 混用 | ✅ 修复 |
| stuck checkpoint tasks (14 pending 从未消费) | ⏳ 待修复 |
| `safePath()` URL 编码绕过 | ⏳ 待修复 |

### 🔵 低 (3个已记录未修复)

| 问题 | 说明 |
|------|------|
| `loadConfig()` 被调用两次 | 模块级 + ensureAgent 内，纯浪费 |
| `(adapter as any)` 模式过多 | SmartAdapter 缺 getEffectiveContextWindow 等类型定义 |
| import 风格不一致 | `{ logger }` vs `logger` default |

## 修改的文件

### 源文件 (4个)
- `src/core/smart-adapter.ts` — reset() 修复 + callWithTimeout 委托
- `src/logger.ts` — formatArg 函数
- `src/core/agent/agent-core.ts` — config 加载路径修复
- `src/server/dashboard-api.ts` — import 清理

### 编译产物 (3个)
- `dist/core/smart-adapter.js` — 对应 callWithTimeout 委托
- `dist/logger.js` — 对应 formatArg
- `dist/core/agent/agent-core.js` — 对应 require 路径

### 文档 (2个)
- `CODE_REVIEW_2026-06-20.md` — 更新待办+已修复列表
- `LESSONS_LEARNED.md` — 新增 5.2, 5.3, 6.1, 6.2, 7.1, 7.2 经验教训
- `HANDOVER.md` — 追加第7节修复记录
