# catch(err:any) → catch(err:unknown) 清理报告

**日期**: 2026-07-15
**Commit**: `403dbc0`
**状态**: ✅ 完成（推送 GitHub 失败，网络问题）

## 目标
将项目中所有 `catch (err: any)` 替换为类型安全的 `catch (err: unknown)`，配合 `errorMessage()` 辅助函数提取错误信息。

## 范围
共修改 23 个文件，清理 50+ 处 `catch (err: any)` 用法。

### 修改的文件

**src/server/ (3 文件)**
- `agent-server.ts` — 5 处（路由处理、模型切换、YAML 写入、SSE cleanup、shutdown）
- `dashboard-api.ts` — 11 处（前次提交已处理）
- `routes/index.ts` — 15 处（前次提交已处理）

**packages/core/src/ (12 文件)**
- `agents/sub-agent.ts`
- `audit/audit-server.ts`
- `core/orchestrator.ts`
- `core/smart-adapter.ts`
- `core/agent/agent-core.ts` — 5 处
- `core/agent/command-handler.ts`
- `core/agent/__tests__/chat-handler.test.ts` — 5 处
- `core/agent/__tests__/command-handler.test.ts`
- `core/tools/base-tools.ts` — 含 `execErrorOutput()` 辅助（处理 child_process exec 错误的 stdout/stderr）
- `core/tools/registry.ts`
- `models/adapters/lmstudio.ts`
- `models/probe/capability-probe.ts`
- `tools/registry.ts` — 3 处

**packages/llm/src/ (1 文件)**
- `smart-adapter.ts` — 4 处 + `streamError: any` → `streamError: unknown`，新增 `errorMessage()` 和 `errorName()` 辅助

**packages/{models-core,resilience,skills,tools}/ (4 文件)**
- `models-core/src/capability-probe.ts`
- `resilience/src/idle-task-manager.ts`
- `skills/src/pipeline.ts`
- `tools/src/base-tools.ts` — 含 `execErrorOutput()` 辅助
- `tools/src/registry.ts`

### 辅助函数模式

```typescript
/** 从 unknown 错误中提取 message */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 从 child_process exec error 中提取 stdout/stderr */
function execErrorOutput(err: unknown): { stdout: string; stderr: string } {
  if (err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
    return { stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
  return { stdout: '', stderr: '' };
}
```

### Smart-adapter.ts 特殊处理
- `streamError: any = null` → `streamError: unknown = null`
- `err.name === 'TimeoutError'` → 用 `errorName(err) === 'TimeoutError'`（带类型守卫）
- 正则匹配 `streamError.message` → 先提取 `streamMsg = errorMessage(streamError)` 再匹配

## 验证

### TypeScript 编译
```
tsc -b --force
Exit: 0
```
0 errors。

### 单元测试
10/10 全部通过：
- dist/__tests__/logger.test.js ✓
- packages/events/dist/__tests__/events.test.js ✓
- packages/experience/dist/__tests__/experience.test.js ✓
- packages/llm/dist/__tests__/llm.test.js ✓
- packages/memory/dist/__tests__/memory.test.js ✓
- packages/models-core/dist/__tests__/models-core.test.js ✓
- packages/prompts/dist/__tests__/prompts.test.js ✓
- packages/resilience/dist/__tests__/resilience.test.js ✓
- packages/skills/dist/__tests__/skills.test.js ✓
- packages/tools/dist/__tests__/tools.test.js ✓

### API 端点验证（8/8 通过）
- GET /api/health ✓
- GET /api/status ✓
- GET /api/models ✓
- GET /api/config ✓
- GET /api/sessions ✓
- GET /api/dashboard ✓
- GET /api/logs/status ✓
- POST /api/models/scan ✓

## 实施方法

1. **简单文件**（1-2 处）：用 `edit` 工具逐个手动替换，确保质量
2. **批量文件**（16 文件）：用 Node.js 脚本 `catch-any-cleanup.js` 自动化处理
   - 自动添加 `errorMessage()` 辅助函数
   - 自动在每个 `catch (XXX: unknown)` 块内将 `XXX.message` 替换为 `errorMessage(XXX)`
   - 通过大括号匹配确定 catch 块范围
   - 从后往前替换以保持索引正确

## 待办

- 🟡 Git push 到 GitHub（网络恢复后）
- 🟡 减少 288 处 `:any` 类型注解（P3，ROI 低）
- 🟡 拆分 agent-core.ts (2474 行)
- 🟡 提升测试覆盖率到 20%+（当前 17%）
