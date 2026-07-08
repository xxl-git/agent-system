# 胡话检测器全链路集成 (2026-06-20)

## 设计

```
init() → nonsenseDetector.startMonitor()  // 10s 间隔
                │
handleChat/handleTask → markConversationStart()
     │
     ├─ 正常响应 → markConversationEnd(true, ...) → tick 无事
     │
     └─ 异常/胡话 → markConversationEnd(false, ..., reason)
                          │
                 10s tick 检查:
                    │
                    ├─ 模型正在处理？→ 跳过
                    └─ 空闲且上次异常？
                         │
                         └─ 快照 JSON → data/pending-diagnostics/{id}.json
                            P0 空闲任务 → diagnose-{id}
                              下次 Heartbeat → 生成 _report.md
```

## 修改文件

### 新建: `src/resilience/nonsense-detector.ts`
- `NonsenseDetector` 类
- 全程 10s setInterval 监控（startMonitor/stopMonitor）
- `markConversationStart()` / `markConversationEnd(normal, input, output, reason?)`
- 静态方法 `detectGibberish(text)`：空响应、字符高重复(>60%)、文本循环、纯符号、模型崩溃标记
- `tick()`：空闲 + 上次异常 → 诊断快照 + P0 任务
- `forceCheck()` 手动触发
- P0 任务执行时生成 `{id}_report.md`

### 修改: `src/core/agent/agent-core.ts`
| 位置 | 改动 |
|------|------|
| 导入 | + `NonsenseDetector, getNonsenseDetector` |
| 属性 | + `private nonsenseDetector: NonsenseDetector` |
| 构造函数 | + `this.nonsenseDetector = getNonsenseDetector(this.idleTaskMgr)` |
| init() | + `setModelName()` + `startMonitor()` 在 Heartbeat 启动后 |
| handleChat | `markConversationStart()` → ... → `detectGibberish()` → `markConversationEnd()` |
| handleTask | 同上，含 early-return 路径独立处理 |
| `/nonsense` 命令 | 查看监控状态 + `force` 手动触发 |
| `/help` | 列表新增 `/nonsense` |

## 检测标准（`detectGibberish`）
1. 空响应 → `'空响应'`
2. 去掉标点后 <2 个有效字符 → `'响应过短或仅含标点'`
3. 某字符占比 >60% → `'字符高重复'`
4. 分 4 块比较，≥2 块相同 → `'文本循环重复'`
5. 去掉符号后 0 个字母数字 → `'输出仅为符号/空白'`
6. 匹配崩溃关键词 → `'模型错误'`
7. 全不匹配 → null（正常）

## 数据持久化
- 诊断快照: `data/pending-diagnostics/{id}.json`
- 诊断报告: `data/pending-diagnostics/{id}_report.md`

## ✅ 构建状态: 通过 (npm run build 0 error)
