# Logger P2 优化：结构化 JSON 日志 + traceId 链路关联

**日期**：2026-07-02  
**提交**：649db5d (18 files, +719/-244)

## P2.1 结构化 JSON 日志

### 控制 API
- **POST /api/logs/json** `{enabled: boolean}` — 切换 JSON 格式输出
- **GET /api/logs/json** — 查看当前状态

### JSON 格式
```json
{
  "t": "2026-07-02T14:00:02.864Z",     // ISO 时间戳（短键名省磁盘）
  "l": "INFO",                          // 日志级别
  "m": "Agent",                         // 模块名（自动提取）
  "msg": "sendMessage completed",       // 消息内容
  "trace": "test-session-001"           // 可选：链路追踪 ID
}
```

### 行为
- 控制台保持 emoji 前缀的文本输出（可读性）
- 文件写入 JSON 行（机器可解析）
- 错误日志（`-errors.log`）同样支持 JSON 格式
- 短字段名（`t`/`l`/`m`）节省磁盘空间

## P2.2 traceId 链路关联

### 实现机制
- 导入 `AsyncLocalStorage` from `async_hooks`
- 导出 `logContext`：`export const logContext = new AsyncLocalStorage<{traceId: string}>()`
- 查询链路：`logContext.getStore()` > `_traceId` 回退
- 每个 HTTP 请求自动包裹 `logContext.run({traceId}, handler)`

### traceId 来源（优先级）
1. `x-trace-id` HTTP Header
2. URL query `?trace=xxx`
3. 自动生成 `req_<timestamp-base36>`

### 文本模式显示
```
[2026-07-02T14:00:02.862Z] [INFO] [Agent] sendMessage completed | trace:test-session-001
```

### API
- **POST /api/logs/trace** `{traceId: xxx}` — 手动设置 traceId（后台任务/非请求上下文）

## 修复的 Bug

### 1. 重复模块名
- **症状**：日志行出现 `[Agent] [Agent] sendMessage completed`
- **根因**：`moduleName` 从消息文本提取后又作为独立标签添加，content 保留原始 `[Agent]` 前缀
- **修复**：`cleanContent = content.replace(/^\[[^\]]+\]\s*/, '')`

### 2. 错误日志缓冲区混合
- **症状**：WARN/ERROR 行在 `writeErrorToFile()` 中进入缓冲区，`flush()` 写回主日志文件
- **修复**：`writeErrorToFile()` 改为 `fs.appendFileSync()` 直写，绕过主日志缓冲区

## 验证结果

| 测试 | 结果 |
|------|------|
| 编译 (`tsc -b`) | ✅ Pass |
| 服务启动 (v0.9.2, ready) | ✅ True |
| GET /api/logs/json (off) | ✅ `{"jsonFormat": false}` |
| POST enable JSON | ✅ `{"ok": true, "jsonFormat": true}` |
| POST set traceId | ✅ `{"ok": true, "traceId": "req_xxx"}` |
| 控制台 JSON 输出 | ✅ 字段正确，模块名不重复 |
| 错误日志隔离 | ✅ JSON 行正确写入 errors.log |
