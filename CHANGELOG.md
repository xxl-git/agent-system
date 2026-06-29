# Changelog - Agent System

## [Unreleased] - 2026-06-22

### Added
- **模块化重构 (Phase 1-4 完成)**:
  - ✅ `@agent-system/prompts` v0.1.0
  - ✅ `@agent-system/experience` v0.1.0
  - ✅ `@agent-system/memory` v0.1.0（db-store, file-store, summarizer, session-recovery）
  - ✅ `@agent-system/resilience` v0.1.0（9个韧性组件）
  - ✅ `@agent-system/events` v0.1.0（EventEmitter 单例，状态/SSE 事件广播）
  - ✅ `@agent-system/llm` v0.1.0（SmartAdapter + LLMRouter）
  - ✅ `@agent-system/tools` v0.1.0（ToolRegistry + BaseTools）
  - ✅ `@agent-system/models-core` v0.1.0（probes, CapabilityProbe, ModelProfileStore, assessDifficulty）
  - ✅ `@agent-system/skills` v0.1.0（SkillRegistry, GapDetector, SkillAuditor/Developer/Tester/Equipper）
- **npm workspaces** 已配置，所有 packages 自动链接
- **根项目消除重复代码**：
  - `core/smart-adapter.ts` → 转发 `@agent-system/llm`（消除 421 行重复）
  - `core/agent-event-bus.ts` → 转发 `@agent-system/events`（消除 161 行重复）
  - `agent-core.ts` → 直接 import SmartAdapter from `@agent-system/llm`
- **模块化分析文档** (`modularization-analysis.md`)
  - 评估拆分收益：编译速度 +300%，测试覆盖率 +150%
  - 制定5阶段迁移路线图（预估 12-17 天）

### Changed
- `packages/experience/src/extractor.ts` - 使用依赖注入模式，解耦对 models/llm/prompts 的直接依赖
- `packages/experience/src/llm-client.ts` - 新增，定义 LLMClient 和 PromptRegistry 接口

### Status（Phase 4 完成）
- ✅ `@agent-system/prompts` v0.1.0 - 可独立构建
- ✅ `@agent-system/experience` v0.1.0 - 可独立构建
- ✅ `@agent-system/memory` v0.1.0 - 可独立构建
- ✅ `@agent-system/resilience` v0.1.0 - 可独立构建
- ✅ `@agent-system/events` v0.1.0 - 可独立构建
- ✅ `@agent-system/llm` v0.1.0 - 可独立构建
- ✅ `@agent-system/tools` v0.1.0 - 可独立构建
- ✅ `@agent-system/models-core` v0.1.0 - 可独立构建
- ✅ `@agent-system/skills` v0.1.0 - 可独立构建
- ✅ npm workspaces 配置完成
- ⏳ `@agent-system/core` - 深度耦合，AgentCore 1400+ 行，需渐进拆分
- ⏳ `@agent-system/server` - 深度耦合，待拆分

### Next Steps
1. 渐进拆分 `AgentCore` 巨型类（注入包服务，降低单文件认知负荷）
2. 提取 `agent-core.ts` 中的 chat/execution/resilience 子类
3. 根项目迁移：各模块 import 从 local 文件 → @agent-system/* 包
4. 根项目 TypeScript project references 引入（加速增量编译）

---

## [0.9.0] - 2026-06-21

### Added
- Phase 6: Web UI (SSE 流式输出、文件上传、多会话管理)
- Experience Module (经验提取/存储/检索)
- Prompts 系统 (模板外部化 + PromptAssembler)
- LLM Router 统一入口
- 调试面板 (模型 payload 可视化)
- 状态条 (Agent 实时状态)
- 配置体系 (YAML + 环境变量)

### Fixed
- 推理模型兼容性 (reasoning_content)
- SmartAdapter 死循环修复
- ES 模块导入修复

---

## [0.6.0] - 2026-06-15

### Added
- Phase 4: 断点续播功能
- Phase 7: 无上限上下文管理器

### Fixed
- Windows 脚本兼容性
- 编码问题修复

---

## [0.1.0] - 2026-06-10

### Added
- 初始版本
- 基础 Agent 功能
- 技能系统
- 审计日志
