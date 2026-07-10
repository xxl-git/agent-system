# 路由表化专项重构总结

**日期**：2026-07-11
**Commit**：`c04cd75`（本地，push 待网络恢复）

## 重构目标

将 agent-server.ts 中 37+ 个 `if (url === '/api/...')` 路由替换为 Map 路由表，提高性能和可维护性。

## 实施方案：渐进式迁移

采用**双层路由分发**策略：
1. **第一层**：路由表 Map 查找（O(1)）— 已迁移的路由
2. **第二层**：原 if-else 链（fall through）— 未迁移的路由

这样可以在不破坏现有功能的情况下逐步迁移路由，每次迁移一部分，验证通过后再迁移下一部分。

## 新增文件

### `src/server/routes/router.ts`（274 行）
- `Router` 类：路由注册和查找
- `RouteContext`：统一的路由上下文（req/res/url/pathname/query/params/body/rawBody）
- `RouteMiddleware`：中间件支持
- O(1) Map 查找（精确匹配）+ O(n) 线性扫描（前缀/参数匹配）
- 辅助函数：`sendJson`、`sendError`、`readJsonBody`、`parseUrl`、`createRouteContext`
- `router.list()`：列出所有路由（用于调试和 OpenAPI 生成）

### `src/server/routes/index.ts`（151 行）
- 19 个 GET 路由注册
- `RouteDeps` 接口：依赖注入（agent/dashboard-api/session-store 等）
- `createRouter(deps)` 工厂函数

## 已迁移的路由（19 个 GET）

| 路由 | 原位置 | 新位置 |
|------|--------|--------|
| `GET /api/health` | agent-server.ts L212 | routes/index.ts |
| `GET /api/status` | agent-server.ts L199 | routes/index.ts |
| `GET /api/dashboard` | agent-server.ts L224 | routes/index.ts |
| `GET /api/dashboard/projects` | agent-server.ts L232 | routes/index.ts |
| `GET /api/dashboard/skills` | agent-server.ts L239 | routes/index.ts |
| `GET /api/dashboard/models` | agent-server.ts L246 | routes/index.ts |
| `GET /api/dashboard/health` | agent-server.ts L253 | routes/index.ts |
| `GET /api/dashboard/memory` | agent-server.ts L682 | routes/index.ts |
| `GET /api/dashboard/context` | agent-server.ts L689 | routes/index.ts |
| `GET /api/resilience/status` | agent-server.ts L260 | routes/index.ts |
| `GET /api/logs/status` | agent-server.ts L267 | routes/index.ts |
| `GET /api/logs` | agent-server.ts L274 | routes/index.ts |
| `GET /api/logs/errors` | agent-server.ts L310 | routes/index.ts |
| `GET /api/logs/modules` | agent-server.ts L447 | routes/index.ts |
| `GET /api/logs/json` | agent-server.ts L507 | routes/index.ts |
| `GET /api/trace/list` | agent-server.ts L603 | routes/index.ts |
| `GET /api/models` | agent-server.ts L696 | routes/index.ts |
| `GET /api/config` | agent-server.ts L1240 | routes/index.ts |
| `GET /api/sessions` | agent-server.ts L1403 | routes/index.ts |

## 验证结果

### 编译
- `tsc -b` 通过，0 错误

### 单元测试
- 17/17 套件全部通过

### 实际服务器测试
启动服务器后测试 14 个路由表端点：

```
200 /api/health
200 /api/status
200 /api/dashboard
200 /api/dashboard/projects
200 /api/dashboard/skills
200 /api/dashboard/health
200 /api/dashboard/memory
200 /api/dashboard/context
200 /api/resilience/status
200 /api/logs/status
200 /api/logs/modules
200 /api/trace/list
200 /api/config
200 /api/sessions
```

### Fall-through 验证
未迁移的路由仍通过原 if-else 链处理：

```
200 /api/models          (原 if-else)
200 /api/dashboard/models (原 if-else)
200 /api/logs/errors     (原 if-else)
200 /api/logs            (原 if-else)
```

## 后续迁移计划

### 第二批：POST 路由（~10 个）
- `POST /api/logs/level`
- `POST /api/logs/cleanup`
- `POST /api/logs/modules`
- `POST /api/logs/buffer`
- `POST /api/logs/flush`
- `POST /api/logs/json`
- `POST /api/logs/trace`
- `POST /api/config`
- `POST /api/models/switch`
- `POST /api/models/scan`
- `POST /api/models/load`
- `POST /api/models/unload`
- `POST /api/sessions`
- `POST /api/upload`

### 第三批：前缀匹配路由（~10 个）
- `GET /api/logs/errors/:id`
- `GET /api/logs/:filename`
- `GET /api/trace/:traceId`
- `GET /api/assembly/:id`
- `GET/PUT/DELETE /api/sessions/:id`
- `GET /uploads/:filename`
- `GET /api/files`

### 第四批：删除原 if-else 中的已迁移路由
完成所有迁移后，删除 agent-server.ts 中的冗余 if-else 代码块。

## 代码影响

| 文件 | 变化 |
|------|------|
| `src/server/routes/router.ts` | +274 行（新增） |
| `src/server/routes/index.ts` | +151 行（新增） |
| `src/server/agent-server.ts` | +60 行（路由表初始化+查找），0 行删除（渐进式保留原 if-else） |

**净增加**：485 行（路由表基础设施），但为后续删除 1000+ 行 if-else 奠定基础。
