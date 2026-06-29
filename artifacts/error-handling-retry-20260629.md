# 错误处理与重试系统 — 完成报告 (2026-06-29)

## 目标
完成 PLAN.md 中的「基本错误处理和重试」TODO 项。

## 完成工作

### 1. 创建缺失文件 `src/tools/registry.ts` (12KB)
**关键问题**：`src/tools/registry.ts` 不存在，但 `agent-core.ts` 在恢复流程中调用它。

**实现内容**：
- 工具注册表主类 `ToolRegistry`
- 5个内置工具：write_file、read_file、web_search、exec、list_dir
- **熔断器集成**：执行前检查熔断状态（`canUseTool()`），执行后记录结果（`recordToolSuccess/recordToolFailure()`）
- 安全防护：路径穿越检查、危险命令过滤、超时控制（executeWithTimeout）
- 熔断后自动禁用工具
- `setCircuitBreaker()` 注入点（由 AgentCore 调用）

### 2. CircuitBreaker.getStatus() (circuit-breaker.ts)
添加 `getStatus()` 方法返回结构化状态：
```typescript
{
  state: string,
  modelState: Record<name, { state, failureCount, lastFailure }>,
  toolState: Record<name, { state, failureCount, lastFailure }>,
  pathState: Record<name, { state, failureCount, lastFailure }>,
  failureCount: number,
  lastFailure: number | null
}
```

### 3. HealthMonitor.getSummary() (health-monitor.ts)
添加 `getSummary()` 方法返回：
```typescript
{
  emptyLoopCount: number,       // 空循环计数
  consecutiveUnreachable: number, // 模型连续不可达次数
  lastPingTime: number | null,
  tokenWarning: boolean,
  lastToolCallArgs: string | null
}
```

### 4. RecoveryOrchestrator.getStats() + 全局计数器 (orchestrator.ts)
- 添加类级计数器：`_recoveryAttempts`, `_successfulRecoveries`, `_failedRecoveries`, `_degradations`
- 添加 `_recoveryHistory` 数组（保留最近100条）
- 添加 `_recordHistory()` 私有方法
- `getStats()` 返回：
```typescript
{
  recoveryAttempts: number,
  successfulRecoveries: number,
  failedRecoveries: number,
  degradations: number,
  recentEvents: [{ timestamp, type, message, taskId }]
}
```

### 5. API 端点 `/api/resilience/status` (agent-server.ts)
```
GET /api/resilience/status
→ { circuitBreaker, healthMonitor, diagnostics, retry, pendingTasks, pendingTaskCount }
```
集成到完整 Dashboard（`getFullDashboard()`）。

### 6. Dashboard API 更新 (dashboard-api.ts)
`getResilienceSummary()` 函数，整合：
- 熔断器状态（模型/工具/路径）
- 健康监控（空循环/不可达/Token警告）
- 会话诊断
- 重试统计
- 待恢复任务

## 验证
- ✅ TypeScript 编译通过（`tsc -b` exit 0）
- ✅ 服务器启动正常
- ✅ `/api/resilience/status` 返回完整结构
- ✅ `/api/dashboard` 包含 resilience 数据

## 架构总览
```
agent-core.ts
  └─ toolRegistry.call(toolName, args)
        ├─ canUseTool() → circuitBreaker.canUseTool()
        ├─ 执行工具（write/read/search/exec/list）
        ├─ recordToolSuccess() → circuitBreaker.toolSuccess()
        └─ recordToolFailure() → circuitBreaker.toolFailure()

circuitBreaker.getStatus() → Dashboard API → /api/resilience/status
healthMonitor.getSummary() → Dashboard API → /api/resilience/status
recoveryOrchestrator.getStats() → Dashboard API → /api/resilience/status
```

## PLAN.md 状态
- ❌ → ✅ "基本错误处理和重试"
