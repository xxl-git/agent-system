# Entity Extractor 模块提取 + 测试增强

**日期**：2026-07-17  
**提交**：`f8d6129`（待推送 GitHub）

## 目标
1. 拆分 agent-core.ts（2476 行，技术债务最大的文件）
2. 提升测试覆盖率（当前 17% → 目标 20%+）
3. 清理 `:any` 类型注解（当前 288 处）

## 完成内容

### 1. 提取 entity-extractor 模块
- **新文件**：`packages/core/src/core/agent/entity-extractor.ts`（94 行）
  - 纯函数 `extractEntities(text, maxEntities?)`，无 `this` 依赖
  - 提取 6 类实体：path、quoted_phrase、mention、proper_noun、email、url
  - 自动去重 + maxEntities 限制（默认 20）
- **agent-core.ts 改动**：
  - 原 57 行 `extractEntities` 方法 → 3 行委托
  - 行数：2476 → 2428（-48 行）
  - 新增 `import { extractEntities as extractEntitiesFn } from './entity-extractor'`
- **packages/core/src/index.ts**：导出 `extractEntities` 和 `Entity` 类型

### 2. 12 个单元测试
- **测试文件**：`packages/core/src/core/agent/__tests__/entity-extractor.test.ts`
- **测试覆盖**：
  - 路径实体（Windows + Unix）
  - 引号短语（中文 + 英文）
  - @-mention 标识符
  - 大写专有名词
  - 邮箱地址
  - URL
  - 去重逻辑
  - 空字符串
  - 无实体文本
  - maxEntities 限制
  - 混合实体
  - 短引号过滤（长度 < 2）
- **结果**：12/12 PASS

### 3. :any 类型清理（agent-server.ts）
- `broadcastSSE(data: any)` → `broadcastSSE(data: SSEData)` 其中 `SSEData = Record<string, unknown>`
- `errors: any[]` → `errors: Record<string, unknown>[]`

### 4. CI/CD 同步
- `package.json` test:units 脚本：添加 entity-extractor.test.ts
- `.github/workflows/ci.yml`：添加 entity-extractor.test.ts 到测试步骤
- `CHANGELOG.md`：更新 Unreleased 段

## 验证
- ✅ `tsc -b` 编译通过（0 errors）
- ✅ 单元测试：69 pass + 2 pre-existing fail（models-core，与本次改动无关）
  - events: 3/3
  - experience: 3/3
  - llm: 2/2
  - prompts: 0/0（模块加载测试）
  - resilience: 5/5
  - nonsense-detector: 12/12
  - circuit-breaker: 15/15
  - idle-task-manager: 12/12
  - skills: 3/3
  - tools: 2/2
  - **entity-extractor: 12/12** ← 新增

## 待办
- 🟡 继续拆分 agent-core.ts（2428 行）：下一步可提取心跳/注册任务（~300 行）
- 🟡 减少剩余 286+ 处 `:any` 类型注解（P3，ROI 较低）
- 🟡 修复 models-core.test.ts 的 2 个预存在失败
- 🟡 推送 commit `f8d6129` 到 GitHub（网络问题待解决）
