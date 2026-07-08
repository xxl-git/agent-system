# Agent 试跑 + 审计可视化 完成

**日期**: 2026-06-17 12:27-13:20

## 试跑结果

### 全链路干跑: 18/18 ✅

| 子系统 | 测试项 | 结果 |
|--------|--------|------|
| DB 记忆 | init + session + decision | ✅ |
| **审计日志** | 8 类事件写入 + 文件持久化 | ✅ |
| 摘要引擎 | 生成 + 事实提取 + 标签 | ✅ |
| 项目管理 | 创建 + 读取 + 日报 + 待办 | ✅ |
| 健康监控 | ping + token stream | ✅ |
| 检查点 | register → complete | ✅ |
| 断路器 | closed → trip → open | ✅ |
| 重试引擎 | classify + 策略匹配 | ✅ |
| 降级路径 | level3 标注 | ✅ |
| 恢复编排器 | status 查询 | ✅ |
| 跨会话恢复 | decisions 恢复 | ✅ |

### LLM 集成状态
- **qwen3.6-35b-a3b-mtp**: LM Studio 在线但模型挂死（空 tool_calls 循环）
- 已添加 `tool_choice: "none"` + `parallel_tool_calls: false` + 降级 `maxTokens: 2048` + `timeoutMs: 60000`
- 建议更换为 qwen2.5-coder-14b 或 Mistral-Small-24B

## 审计可视化

- **仪表盘**: http://127.0.0.1:19700
- **审计服务器**: Node.js HTTP server, 端口 19700
- **数据源**: `audit/audit-YYYY-MM-DD.log` (行分隔 JSON, 按日轮转)
- **API**: `/api/audit` (全量), `/api/audit/stats` (统计)
- **支持**: 拖拽导入 JSON, localStorage 缓存, 离线模式
- **当前数据**: 60 事件, 8 个分类, 5 种结果

### 审计事件分布
| 分类 | 数量 |
|------|------|
| session | 10 |
| decision | 20 |
| tool_call | 6 |
| error | 4 |
| model_switch | 4 |
| recovery | 4 |
| checkpoint | 2 |
| degradation | 2 |
| **总计** | **60** |

成功率: 42/60 (70%) | 平均耗时: 14.9s

## 关键文件
| 文件 | 状态 |
|------|------|
| `audit-dashboard.html` | 新建 (10.7KB) |
| `src/audit/audit-server.ts` | 新建 (2.8KB) |
| `tests/test-dry-run.ts` | 新建 (6.5KB) |
| `src/models/adapters/lmstudio.ts` | 修改: tool_choice+parallel |
| `src/models/probe/capability-probe.ts` | 修改: 30s 超时 |
| `config/default.json` | 修改: timeout/maxTokens |
| `src/config.ts` | 修改: maxTokens? |

## 下一步建议
1. 更换 LLM 模型 (qwen2.5-coder-14b / Mistral-Small-24B)
2. 审计仪表盘增强: 时间线视图, 分类饼图, 实时推送
3. Agent 正式启动运行长期会话
