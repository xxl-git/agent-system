# 路由表迁移完整收官 (2026-07-12 08:49)

## 目标
将 `agent-server.ts` 中所有遗留的 if-else 端点处理器迁移到 `routes/index.ts` 路由表，删除死代码，统一路由架构。

## 背景
之前的批次 1-4 已经迁移了 19 个 GET 路由 + 7 个 POST /api/logs/* + 4 个 Session CRUD + POST /api/config。但 `agent-server.ts` 中仍然保留着大量已迁移端点的旧 if-else 处理器代码（死代码），因为路由器 `router.lookup()` 会先匹配并 `return`，导致后面的 if-else 永远不会执行。

## 本次工作

### 1. 识别问题
- `routeDeps` 缺少 `updateConfig` 字段 → 导致 `POST /api/config` 路由无法工作
- `routeDeps.getModels` 始终返回 `null` → 导致 `GET /api/models` 返回 null
- 10 个未迁移的端点仍以死代码形式存在于 `agent-server.ts`

### 2. 修复 routeDeps 缺失字段
- 添加 `updateConfig` 函数（写入 YAML 配置文件）
- 修复 `getModels` 使其返回真实模型列表（27 个）

### 3. 迁移 10 个剩余端点到 routes/index.ts
- **SSE**: `/api/events`
- **Trace**: `/api/trace`, `/api/trace/:sessionId`, `/api/trace/list`
- **Assembly**: `/api/assembly`, `/api/assembly/:sessionId`  
- **Models**: `/api/models/switch`, `/api/models/scan`, `/api/models/load`, `/api/models/unload`
- **Chat**: `/api/chat`, `/api/chat/stream` (含 SSE StreamWriter)
- **Upload**: `/api/upload` (multipart 解析)

新增 `RouteDeps` 字段：
- `switchModel`, `scanModels`, `loadModel`, `unloadModel`
- `sendChat`, `sendChatStream` (带 StreamWriters 类型)
- `saveUpload`, `getTraceReport`, `getAssemblyReport`
- `streamChatInProgress` (并发标志)

### 4. 删除死代码
使用 Node.js 脚本精确识别每个 `if (url === ...)` 块的起止位置（包括上方的注释块），从后向前删除避免行号偏移。

**两轮删除**：
- 第一轮：17 个块，合并为 5 个，删除 774 行
- 第二轮：28 个块，合并为 1 个，删除 581 行
- **总计删除：1358 行死代码**

### 5. 保留的端点（特殊路由）
- `/uploads/*` — 静态文件服务（涉及文件系统，保留在 agent-server.ts）
- `/api/files` — 文件浏览（同上）

## 验证

### 编译
```
tsc -b → Exit 0 ✅
```

### 运行时测试
- ✅ `/api/health` → `{"status":"ok"}`
- ✅ `/api/models` → 返回 27 个模型（qwen3.6-35b-a3b 已加载）
- ✅ `/api/config` → 完整配置 JSON
- ✅ `/api/sessions` → 9 个会话
- ✅ `/api/dashboard` → 完整仪表盘数据
- ✅ `POST /api/models/scan` → 重扫返回 27 个模型
- ✅ `/api/trace` → `{"trace":null,"message":"No trace data available"}`
- ✅ `/api/assembly` → `{"report":null,"message":"No assembly data"}`
- ✅ `/api/resilience/status` → 弹性状态正常
- ✅ `/api/logs/status` → 日志状态正常（10 个文件，12.8MB）

## 代码量变化

| 文件 | 之前 | 之后 | 变化 |
|------|------|------|------|
| agent-server.ts | 2072 行 | 716 行 | -65% |
| routes/index.ts | 269 行 | 604 行 | +124% |
| routes/router.ts | 274 行 | 274 行 | 0% |
| **总计** | 2615 行 | 1594 行 | -39% |

净减少 1021 行代码，通过路由表复用和死代码删除实现。

## 提交记录
- `b57bb51` - refactor: 完成路由迁移 — 10 个端点从 if-else 迁移到路由表
- 已推送到 `origin/main`

## 结论

`agent-server.ts` 从一个 2072 行的"巨型路由文件"成功瘦身到 716 行的"服务器启动+特殊路由"文件。所有业务路由统一由 `routes/index.ts` 路由表管理，架构清晰、易维护、易扩展。

下一步可以考虑：
1. 将 `/uploads/*` 和 `/api/files` 也迁移到路由表
2. 将路由按功能拆分到 `routes/models.ts`, `routes/chat.ts`, `routes/logs.ts` 等子模块
3. 添加路由级中间件支持（认证、限流等）
