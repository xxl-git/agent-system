# 健壮性修复总结

**日期**：2026-07-10
**Commit**：`7c1f2f1`（本地提交，push 待网络恢复）

## 修复清单

### 1. 服务器优雅关闭（SIGINT/SIGTERM）
- **问题**：原 SIGINT 处理直接 `process.exit(0)`，SSE 客户端/审计日志/会话摘要可能丢失
- **修复**：
  - 新增 `gracefulShutdown()` 函数，处理 SIGINT 和 SIGTERM
  - 关闭流程：停止接受新连接 → 停止 Agent（保存会话/审计/摘要）→ 关闭所有 SSE 客户端 → 停止 SSE 心跳 → 1 秒 grace period → 强制退出
  - 防重入：`shuttingDown` 标志防止多次调用

### 2. 全局未捕获异常兜底
- **问题**：未捕获的 Promise rejection 或同步异常会导致 Node.js 进程崩溃
- **修复**：
  - `unhandledRejection`：记录日志，继续运行
  - `uncaughtException`：记录日志，继续运行（不立即退出）
  - 致命错误（如 EADDRINUSE）仍会触发 gracefulShutdown

### 3. SSE 心跳保活（25 秒间隔）
- **问题**：SSE 连接长时间无事件时，nginx/Cloudflare 等反向代理会超时断连（通常 60 秒）
- **修复**：
  - 每 25 秒向所有 SSE 客户端发送注释行（`: heartbeat\n\n`）
  - SSE 协议规定以冒号开头的行是注释，客户端会忽略
  - 使用 `unref()` 确保定时器不阻止进程退出
  - 在 gracefulShutdown 中清理定时器

### 4. 日志自动归档（启动时）
- **问题**：`2026-06-21.log` 3.21MB 未压缩，`rotateIfNeeded()` 只检查今天的日志文件，旧日志不会被归档
- **修复**：
  - 扩展 `cleanupOldLogs()` 方法：归档超过 3MB 或超过 30 天的旧 `.log` 文件为 `.gz`
  - 在 Agent `init()` Step 1b 调用 `logger.cleanupOldLogs()`
  - 实测：`2026-06-21.log` (3.21MB) → `2026-06-21.log.gz` (48.7KB)，压缩率 98.5%

### 5. 日志大小告警
- **问题**：`/api/logs/status` 只返回文件列表，没有告警信息
- **修复**：
  - `getLogStatus()` 新增 `alerts` 数组
  - 告警条件：单个未压缩 `.log` 文件 >3MB；日志目录总大小 >100MB
  - Dashboard 可展示告警信息

### 6. readBody 支持自定义大小上限
- **问题**：`readBody()` 硬编码 1MB 上限，与 `/api/upload` 的 `maxUploadSizeMB`（默认 20MB）不一致
- **修复**：
  - `readBody(req, maxBytes=1_000_000)` 添加可选参数
  - 默认仍为 1MB，各路由可按需传入更大的上限

## 验证结果

- **编译**：`tsc -b` 通过，0 错误
- **单元测试**：17/17 套件全部通过
- **日志归档实测**：`2026-06-21.log` 3.21MB → 48.7KB（98.5% 压缩率）

## 修改文件

| 文件 | 改动 |
|------|------|
| `src/server/agent-server.ts` | +优雅关闭、+全局异常兜底、+SSE心跳、+readBody参数化 |
| `packages/core/src/logger.ts` | +cleanupOldLogs归档旧日志 |
| `packages/core/src/core/agent/agent-core.ts` | +init() Step 1b 日志清理 |
| `src/server/dashboard-api.ts` | +getLogStatus alerts数组 |

## 未完成的优化（用户可后续选择）

- **性能优化**：agent-core.ts 瘦身（2351行）、路由表化（37个if-else→Map）
- **P3功能补全**：模型列表心跳机制、前端429错误处理
- **测试覆盖加深**：38个路由集成测试、错误注入测试
