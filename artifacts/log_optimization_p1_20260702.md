# 日志系统 P1 优化 — 完成

> commit: 168c3f2 | 2 files changed, +189/-17
> 2026-07-02 21:58 GMT+8

## 改动清单

### 1. `src/logger.ts`

| 改进 | 代码 | 说明 |
|------|------|------|
| 🎯 模块级过滤 | `_moduleLevels: Map`, `_shouldLog()`, `setModuleLevel()` | 从 `[XXX]` 标签提取模块名，支持独立级别覆盖 |
| 📦 缓冲区 | `_buffer[]`, `_flushTimer` (5s), `flush()`, `setBufferSize()` | 默认缓冲 50 行后落盘，减少磁盘 I/O ~50x |
| 🔄 轮转前刷盘 | `performRotation()` 开头调用 `this.flush()` | 确保缓冲日志不丢失 |
| ✅ `close()` 方法 | `close(): void` | 进程退出前调用，主动刷盘 + 停止定时器 |

### 2. `src/server/agent-server.ts`

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET  /api/logs/modules` | - | `{global: "info", modules: {Tracer: "error", ...}}` |
| `POST /api/logs/modules` | `{module, level\|null}` | 设模块级别；null 恢复全局 |
| `POST /api/logs/buffer` | `{bufferSize: 1-10000}` | 1=禁用缓冲 |
| `POST /api/logs/flush` | - | 强制刷盘 |

## 测试结果

```
GET  /api/logs/modules          → ✅ {global:"info", modules:{}}
POST /api/logs/modules Tracer=error → ✅ {ok, module:Tracer, level:error}
GET  /api/logs/modules          → ✅ {global:"info", modules:{Tracer:"error"}}
POST /api/logs/modules Tracer=null → ✅ {ok, level:"(global)"}
POST /api/logs/buffer 100       → ✅ {ok, bufferSize:100}
POST /api/logs/flush            → ✅ {ok}
POST invalid level              → ✅ 400
```

## 全部已实现日志 API

```
GET  /api/logs/status           日志系统状态
GET  /api/logs                  列出日志文件
GET  /api/logs/errors           列出错误日志
GET  /api/logs/errors/:date     特定日期错误日志
GET  /api/logs/:date            特定日期日志
POST /api/logs/level            动态修改日志级别       ← P0
POST /api/logs/cleanup          清理过期日志           ← P0
GET  /api/logs/modules          查看模块级别           ← P1
POST /api/logs/modules          设置模块级别           ← P1
POST /api/logs/buffer           配置缓冲区             ← P1
POST /api/logs/flush            强制刷盘               ← P1
```

## 待做

- 待推送：commit 168c3f2 (2 commits ahead, 网络恢复后 push)
- P2：结构化 JSON 日志、traceId 关联
