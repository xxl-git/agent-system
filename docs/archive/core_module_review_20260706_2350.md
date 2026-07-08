# 核心模块代码审查 — orchestrator.ts + smart-adapter.ts

> 时间：2026-07-06 23:50
> 范围：packages/core/src/core/orchestrator.ts (311行) + packages/core/src/core/smart-adapter.ts (378行)
> 关联：code_review_bugs_fixed_20260706_2330.md（前端轮询/scan/测试修复）

## 审查发现

### ✅ 澄清：orchestrator.checkIdleTasks() 空实现不是 bug
- `checkIdleTasks()` 只 `emit('idle', 'heartbeat')`，但该事件无人监听（agent-core 监听的是 `heartbeat` 事件）。
- 真正的 idle 任务执行路径是 `agent-core.onHeartbeat()`（agent-core.ts:2058）→ `this.idleTaskMgr.processAll()`。
- 结论：idle 任务正常运行，checkIdleTasks 只是冗余死代码（不影响功能，可后续清理）。

### 🔴 Bug 1：smart-adapter 降级响应硬编码版本号 v0.5.0
- 位置：smart-adapter.ts:270 `degradedFallback()` 返回 `'...Agent System v0.5.0...'`
- 问题：当前版本已是 v0.9.2，用户看到降级提示会显示过时版本号。
- 修复：新增模块级 `getVersion()`（从 `process.cwd()/package.json` 读取，与 dashboard-api.ts:15 一致），替换硬编码。

### 🔴 Bug 2：agent-system-config DEFAULT_CONFIG 硬编码 0.6.4
- 位置：agent-system-config.ts:116 `system: { version: '0.6.4' }`
- 问题：DEFAULT_CONFIG 防御值过时（YAML 配置已覆盖为 0.9.2，运行时实际显示 0.9.2，但 default 仍是过时值）。
- 修复：同 smart-adapter，改用 `getVersion()` 动态读取。

### 🟡 Bug 3：orchestrator 重规划逻辑重复 push task
- 位置：orchestrator.ts `execute()` 动态重规划分支
- 原代码：
  ```ts
  const existingIdx = dag.tasks.findIndex(t => remainingTaskIds.includes(t.id) && t.id === newStep.id);
  if (existingIdx >= 0) {
    dag.tasks[existingIdx] = { ...newStep, status: 'pending' };
  } else {
    dag.tasks.push({ ...newStep, status: 'pending' });  // 新 task
    groups[groups.length - 1].push(newStep.id);
  }
  ```
- 问题：`remainingTaskIds.includes(t.id)` 限制匹配范围——若 newStep.id 已存在于已完成/当前组（不在 remaining），existingIdx = -1，会**重复 push 一个同名 task**（导致后续执行重复步骤或状态错乱）。
- 修复：直接用 `t.id === newStep.id` 精确匹配，去掉 `remainingTaskIds` 冗余过滤；同时删除不再使用的 `remainingGroups`/`remainingTaskIds` 变量。

## 验证
- ✅ `tsc -b packages/core --force` 编译通过（exit 0）
- ✅ 全套测试 29/29 通过（ALL PASS，8 套测试文件）
- ✅ commit `d3bb06a`，push 成功 `7afccc0..d3bb06a main -> main`

## 修复文件
- packages/core/src/core/smart-adapter.ts（导入 fs/path + getVersion + degradedFallback 动态版本）
- packages/core/src/config/agent-system-config.ts（getVersion + DEFAULT_CONFIG 动态版本）
- packages/core/src/core/orchestrator.ts（重规划按 id 匹配，删除冗余变量）
