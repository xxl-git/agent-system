# Phase 4 完成记录 — 2026-06-22

## 目标
完成 `@agent-system/models-core` 和 `@agent-system/skills` 独立包提取 + 根项目消除重复代码。

## 执行内容

### 新增包（2个）

**@agent-system/models-core v0.1.0**
- `src/probes.ts` — probes 集合（意图/任务分解/工具/换话题检测探针）
- `src/capability-probe.ts` — CapabilityProbe（自动探测 LLM 工具调用能力）
- `src/model-profile.ts` — ModelProfileStore（profile 存储 + CRUD）
- `src/difficulty-assessor.ts` — assessDifficulty（消息复杂度评估）
- 依赖桩：`logger.ts`（LoggerStub）、`config-stub.ts`、`chat-stub.ts`（chat stub）
- tsconfig.json：`composite: true`, `references: [events, llm]`

**@agent-system/skills v0.1.0**
- `src/types.ts` — SkillManifest + SkillResult 类型
- `src/registry.ts` — SkillRegistry（本地 JSON 驱动）
- `src/gap-detector.ts` — GapDetector（skill 缺口检测 + 建议）
- `src/pipeline.ts` — 4阶段 pipeline（Auditor/Developer/Tester/Equipper）
- `src/logger.ts` — LoggerStub（最小依赖）
- tsconfig.json：`composite: true`, `references: [events]`

### 根项目重构

**`core/smart-adapter.ts`**（421行 → 8行）
- 删除 421 行重复实现
- 替换为 `export { SmartAdapter, type SmartAdapterConfig } from '@agent-system/llm'`
- 消除与 `@agent-system/llm` 包 SmartAdapter 的重复

**`core/agent-event-bus.ts`**（161行 → 12行）
- 删除 161 行重复实现
- 替换为向 `@agent-system/events` 的薄转发
- 保留对现有相对路径 import 的向后兼容

**`agent-core.ts`**
- `import { SmartAdapter } from '@agent-system/llm'` 替代 `import * as smart_adapter_1 from '../smart-adapter'`
- agentEventBus 继续通过相对路径（`../agent-event-bus` → 内部转发到 `@agent-system/events`）

**package.json**
- 新增 `workspaces: ["packages/*"]`
- 新增依赖：`@agent-system/events`, `@agent-system/llm`, `@agent-system/models-core`, `@agent-system/skills`

### 验证
- `npm run build` 编译通过（tsc exit 0）
- 所有 8 个包 dist 目录已生成
- 根项目 dist 正常（dist/core/smart-adapter.js 正确转发到 @agent-system/llm）

## Git 提交

| 提交 | 描述 |
|------|------|
| `2e7ed84` | Phase 4: extract @agent-system/models-core 和 @agent-system/skills 包 |
| `91e0354` | docs: 更新 CHANGELOG.md 和 HANDOVER.md — Phase 4 完成 |

## 当前包状态（8/8 已构建）

| 包 | 版本 | dist | tsbuildinfo |
|----|------|------|-------------|
| prompts | 0.1.0 | ✅ | — |
| experience | 0.1.0 | ✅ | — |
| memory | 0.1.0 | ✅ | — |
| resilience | 0.1.0 | ✅ | — |
| events | 0.1.0 | ✅ | ✅ |
| llm | 0.1.0 | ✅ | ✅ |
| tools | 0.1.0 | ✅ | — |
| models-core | 0.1.0 | ✅ | ✅ |
| skills | 0.1.0 | ✅ | ✅ |

## 待办

- `@agent-system/core`（AgentCore 1400+ 行，深度耦合）
- `@agent-system/server`（658行）
- 根项目各模块 import 路径从 local → `@agent-system/*` 包（渐进）
- TypeScript project references 引入根 tsconfig.json
