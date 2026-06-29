# Phase 7：无上限上下文管理器 (Context Manager)

**日期**: 2026-06-17
**版本**: v0.6.0

## 变更清单

### 新建文件
- `src/core/context-manager.ts` — 上下文管理器核心（注意力评分+两层压缩）
  - `Class ContextManager` (Singleton)
  - 注意力评分：TF-IDF关键词 + 位置权重 + 角色权重 + 时效性衰减
  - 压缩策略：保留系统消息 → 生成摘要 → 热点消息 → 当前问题
  - 递进层级：Lv.0 不压缩 → Lv.1 低压缩 → Lv.2 中 → Lv.3 高 → Lv.4 极限
  - 配置路径：`config.context.*`

### 修改文件

| 文件 | 改动 |
|---|---|
| `src/core/agent/agent-core.ts` | 导入 ContextManager，初始化于构造函数，替换 `context_truncate_needed` 粗暴截断为 ContextManager 压缩，`handleChat()` 发送前调用 `ctxManager.process()`，新增 `/context` 命令 |
| `src/config.ts` | AppConfig 新增 `context?: ContextConfig` |
| `config/default.json` | 新增 context 配置段（maxTokens=4000, hotWindowSize=12, summaryTokenBudget=512, compressionThreshold=0.75） |
| `src/server/dashboard-api.ts` | 新增 `getContextSummary()`，dashboard 摘要包含 context 状态 |
| `src/server/agent-server.ts` | 新增 `/api/dashboard/context` 路由 |
| `admin-panel.html` | 新增上下文管理面板卡片 + renderContext() |

### 实现特性
1. **热点评分系统**：每条消息按关键词匹配、位置、角色、时效性评分
2. **两层压缩**：先摘要旧消息，预算仍超则裁剪到最近 N 条
3. **递进压缩层级**：自动从 Lv.1 升级到 Lv.4，永不丢失关键上下文
4. **Singleton 设计**：全局共享一个 ContextManager 实例
5. **管理员面板**：管理控制台新增上下文状态面板
6. **CLI 命令**：`/context` 查看状态，`/context reset` 重置

## 测试验证
- ✅ TypeScript 编译零错误
- ✅ 服务器重启 + API 测试通过
- ✅ `/api/dashboard/context` 返回配置和统计
- ✅ `/api/dashboard` 返回 8 个面板完整数据
- ✅ 管理面板上下文卡片渲染正常
