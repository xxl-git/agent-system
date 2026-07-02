# 日志系统 P0 优化 — 完成

> commit: b792437 | 2 files changed, +95/-1
> 2026-07-02 21:42 GMT+8

## 改动清单

### 1. `src/logger.ts`（核心）

| 优化项 | 改动量 | 说明 |
|--------|--------|------|
| 轮转互斥锁 | +3 行 | `_rotating: boolean`，`performRotation()` 入口设 true，出口设 false；`checkRotation()` 入口判断 `if (_rotating) return` |
| off-by-one 修复 | +1 行 | 加 `if (writeCount < rotationCheckInterval) return`，防止首次触发时机提前 |
| WARN Map 内存保护 | +8 行 | `MAX_WARN_KEYS=500` 常量；超出时排序后删除最旧的一半 |
| 日志留存策略 | +23 行 | `_logRetentionDays=30`；`cleanupOldLogs()` 扫描 `.*\.log\.\d+\.gz` 文件，按 mtime 删除过期项 |

### 2. `src/server/agent-server.ts`（API）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/logs/level` | POST | 请求体 `{level: "debug"}`，校验后调用 `logger.setLevel()` |
| `/api/logs/cleanup` | POST | 触发 `logger.cleanupOldLogs()`，返回 `{deletedFiles: N}` |

## 测试结果

```
GET  /api/logs/status       → ✅ {enabled:true, files:[...10 files], totalSize:8464339}
POST /api/logs/level debug  → ✅ {ok:true, level:"debug"}
POST /api/logs/level info   → ✅ {ok:true, level:"info"}
POST /api/logs/level invalid → ✅ 400 {error:"无效日志级别: superdebug"}
POST /api/logs/cleanup      → ✅ {ok:true, deletedFiles:0}
```

## 待推送

commit 已本地保存，推送待网络恢复后手动执行。
