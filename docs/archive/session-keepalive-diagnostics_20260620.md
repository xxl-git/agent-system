# 会话探活 + 空闲任务调度系统

## 目标
- 模型异常停止时自动记录对话到诊断文件
- 模型空闲时按 P0 优先级处理诊断任务
- 包含执行日志、ID 系统和 P0 任务状态跟踪

## 新增模块

### 1. `src/resilience/idle-task-manager.ts`
- **IdleTaskManager** — 优先级队列 + 执行日志 + 并发控制
- 任务注册/移除/自动清理（超 failCount 自动移除）
- 优先级排序：P0 > P1 > P2（同优先级按创建时间 FIFO）
- 自动日志写入 `data/idle-logs/idle-execution-log.jsonl`
- 心跳收敛：`processAll()` 单次调用内串行执行 ready 任务
- 冷却机制：`cooldownMs` 防频繁执行

### 2. `src/resilience/session-diagnostics.ts`
- **SessionDiagnostics** — 诊断快照 + 自动诊断 + 报告生成
- 5 种触发模式：`ping_failure | timeout | empty_response | circuit_breaker | manual`
- 连续 3 次 Ping 失败自动创建诊断快照
- 诊断结果写入 `data/pending-diagnostics/{id}_report.md`
- 诊断报告包含：发现列表 + 建议列表 + 探针状态快照

### 3. `src/core/agent/agent-core.ts` 集成
- 新增 2 个属性：`idleTaskMgr`, `sessionDiag`
- 构造函数初始化空闲任务管理器和会话诊断
- `onHeartbeat()` 第 1 步：处理空闲任务队列
- `handleChat()` 和 `handleTask()` 的 ping 结果接入诊断
- `init()` 注册 `registerDiagnosticPingTask()`（P2，每 2 分钟探活）
- 新增 `/idle` 命令：`status|pending|log|run`
- 新增 `/diag` 命令：`status|list|reports|force <reason>`
- `/help` 更新包含新命令

## 数据流
```
Heartbeat → processAll()
  ├─ P0: 诊断任务（模型异常时自动创建）
  ├─ P1: 待定（预约扩展点）
  └─ P2: 周期探活诊断（~120s 冷却）

Ping 失败 → SessionDiagnostics.recordPing(false)
  连续 3 次 → triggerDiagnostic()
    → 持久化快照 JSON → data/pending-diagnostics/{id}.json
    → 注册 P0 IdleTask
    → 下次 Heartbeat → runDiagnosis()
      → 生成 _report.md

手动触发 → /diag force <reason>
  → 同上流程（trigger='manual'）
```

## 存储位置
- 空闲任务日志: `data/idle-logs/idle-execution-log.jsonl`
- 诊断快照: `data/pending-diagnostics/{id}.json`
- 诊断报告: `data/pending-diagnostics/{id}_report.md`
- 旧画像备份: `data/profiles_backup_20260620-013153/`

## 当前状态
- ✅ TypeScript 编译通过（0 错误）
- ✅ 空闲任务优先级排序与并发控制
- ✅ 会话诊断自动记录与 P0 诊断生成
- ✅ 探活、超时、空响应、熔断器四种诊断触发
- ✅ 诊断报告自动生成
- ✅ `/idle` 和 `/diag` CLI 命令
- ⏸️ 待服务器重启验证运行时整合
