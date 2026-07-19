# agent-system 剩余任务清单

**生成时间**: 2026-07-19 22:49
**当前状态**: 编译通过 ✅ | 9/9 核心测试通过 ✅ | 4 个 commits 待推送 GitHub

---

## 🔴 P0 — 高优先级（建议尽快处理）

### 1. 推送 GitHub（网络问题）
- **现状**: 4 个本地 commits 未推送（`f8d6129`, `3268ef9`, `6056fe1`, `3586074`）
- **阻塞**: `git push` 报 `Connection was reset`（网络不稳定）
- **方案**: ① 等待网络恢复重试 ② 配置 SSH key 走 SSH 协议 ③ 使用代理
- **工作量**: 5 分钟（网络通畅时）

### 2. dist 类型同步问题
- **现状**: 源 110 个 .ts → dist 仅 7 个 .d.ts（严重不匹配）
- **原因**: `tsc -b` 增量编译可能未刷新所有 .d.ts；或 packages 各包独立编译产物未统一
- **影响**: 外部消费者引用 dist 类型会失败
- **方案**: 清理 dist 目录后完整重建 `npm run build:clean && npm run build`
- **工作量**: 10 分钟

---

## 🟡 P1 — 中优先级（建议本轮迭代处理）

### 3. 归档根目录历史 .md 文件
- **现状**: 根目录有 9 个 .md，其中 4 个应归档到 `docs/archive/`
  - `agent-core-refactor-20260717.md` → 已过时（内容已合并到 MEMORY.md）
  - `catch-any-cleanup-report_20260715.md` → 报告类
  - `entity-extractor-refactor_20260717.md` → 报告类
  - `improvement_report_20260715.md` → 报告类
- **保留**: CHANGELOG.md, CONTRIBUTING.md, HANDOVER.md, PLAN.md, README.md
- **工作量**: 5 分钟

### 4. 为 7 个提取模块补充单元测试
- **现状**: 10 个提取模块中仅 3 个有测试（entity-extractor, send-message-core, init-steps）
- **缺测试模块**:
  | 模块 | 复杂度 | 优先级 |
  |------|--------|--------|
  | `model-commands.ts` | 低 | 高 |
  | `checkpoint-commands.ts` | 低 | 高 |
  | `summarize-command.ts` | 低 | 中 |
  | `info-commands.ts` | 中（8个命令） | 中 |
  | `proactive-tasks.ts` | 中 | 中 |
  | `resume-command.ts` | 高（依赖多） | 低 |
  | `agents-command.ts` | 高（依赖多） | 低 |
- **目标**: 覆盖率从 16.5% → 22%+
- **工作量**: 2-3 小时

### 5. 更新 CHANGELOG.md
- **现状**: Unreleased 段未包含最近 4 个 commits 的内容
- **待补充**:
  - agent-core.ts 拆分重构（-1686 行，-68%）
  - 10 个模块提取 + 44 个新测试
  - `catch(err:any)` → `catch(err:unknown)` 类型安全清理
  - Import 清理（删除 8 个未使用 import）
- **工作量**: 15 分钟

---

## 🟢 P2 — 低优先级（可延后）

### 6. 减少 `:any` 类型注解
- **现状**: 279 处 `:any`（已从 288 降到 279）
- **分布**: 主要在 packages/core 的 agent 相关文件中
- **ROI**: 低 — 大部分 `:any` 用于 mock 对象和灵活接口，不影响运行时安全
- **工作量**: 3-5 小时

### 7. 清理 console.* 调用
- **现状**: 26 处 console.* 调用
  - `src/index.ts`: 17 处（CLI 入口，合理保留）
  - `packages/core/src/logger.ts`: 8 处（logger 自用，合理保留）
  - `packages/core/src/audit/audit-server.ts`: 1 处（独立服务入口，合理保留）
- **结论**: 经审核全部为合理使用，**可标记为不需处理**

### 8. 更新 HANDOVER.md
- **现状**: 最后更新 2026-06-28（v0.9.2），未反映 7 月的拆分重构
- **待补充**: agent-core.ts 拆分情况、新增模块列表、测试状态
- **工作量**: 20 分钟

---

## 📊 当前指标

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| agent-core.ts 行数 | 790 | < 800 ✅ |
| @ts-nocheck 文件数 | 0 | 0 ✅ |
| :any 类型注解 | 279 | < 200 |
| 测试/源码比 | 16.5% | 20%+ |
| 核心单元测试 | 9/9 通过 | 全部通过 ✅ |
| console.* 调用 | 26 | 26（合理保留） |
| 根目录 .md 文件 | 9 | 5 |
| 待推送 commits | 4 | 0 |
| dist .d.ts 同步 | 7/110 | 110/110 |

---

## 🎯 建议执行顺序

1. **P0-1**: 尝试推送 GitHub（5分钟）
2. **P0-2**: 修复 dist 类型同步（10分钟）
3. **P1-3**: 归档历史 .md 文件（5分钟）
4. **P1-5**: 更新 CHANGELOG.md（15分钟）
5. **P1-4**: 为 model-commands + checkpoint-commands 写测试（1小时）
6. **P2-8**: 更新 HANDOVER.md（20分钟）
7. **P2-6**: 逐步减少 `:any`（长期任务，可分批）

**预估总工作量**: 3-4 小时（P0+P1 全部完成）
