# Agent System - 项目记忆文档

## 📋 测试文件清单 (更新: 2026-06-24)

### 单元测试文件
| 文件路径 | 大小 | 测试数量 | npm 脚本 | 状态 |
|---------|------|---------|---------|------|
| `src/__tests__/logger.test.ts` | 11.2KB | 12 | `test:logger` | ✅ 通过 |
| `src/resilience/__tests__/checkpoint.test.ts` | 13.8KB | 16 | `test:checkpoint` | ✅ 通过 |
| `src/core/agent/__tests__/chat-handler.test.ts` | 9.3KB | 11 | `test:chat` | ✅ 通过 |
| `src/core/agent/__tests__/command-handler.test.ts` | 11.7KB | 15 | `test:command` | ✅ 通过 |
| `src/core/agent/__tests__/task-handler.test.ts` | 17.5KB | 17 | `test:task` | ✅ 通过 |
| `src/prompts/__tests__/assembler.test.ts` | 16.1KB | 21 | `test:assembler` | ✅ 通过 |
| `src/core/__tests__/context-manager-p0.test.ts` | 6.9KB | 3 | `test:p0` | ✅ 通过 |
| `src/core/__tests__/context-manager-pure.test.ts` | 6.9KB | 16 | `test:pure` | ✅ 通过 |
| `src/core/__tests__/intent-parser.test.ts` | 3.7KB | 2 | `test:intent` | ✅ 通过 |
| `src/core/__tests__/p2-fixes.test.ts` | 7.1KB | 12 | `test:p2` | ✅ 通过 |

### 测试覆盖总结
- **总测试文件**: 10 个
- **总测试用例**: 125+ 个
- **通过率**: 100%
- **代码行数**: ~10,000+ 行测试代码

### 运行所有单元测试
```bash
npm run test:units
```

或单独运行:
```bash
npm run test:logger
npm run test:checkpoint
npm run test:chat
npm run test:command
npm run test:task
npm run test:assembler
```

## 🎯 测试策略

### 依赖隔离
所有 Handler 测试使用依赖注入模式，通过 Mock 对象隔离外部依赖:
- Mock LLM Adapter: 模拟模型调用和响应
- Mock ProjectManager: 模拟项目管理操作
- Mock HealthMonitor: 模拟健康检查
- Mock RecoveryOrchestrator: 模拟恢复流程

### 文件系统测试
Logger 和 CheckpointManager 测试使用临时目录:
- 每个测试创建独立临时目录
- 测试后自动清理
- 验证文件内容、压缩率、路径安全性

### 边界情况覆盖
- 空输入处理
- 超大上下文（100+ 消息）
- 特殊字符和中文内容
- 路径注入攻击防护
- 文件损坏恢复

## 📊 覆盖模块

### 核心模块 (Core)
- ✅ `src/core/agent/chat-handler.ts` - 聊天处理
- ✅ `src/core/agent/command-handler.ts` - 命令处理
- ✅ `src/core/agent/task-handler.ts` - 任务处理
- ✅ `src/core/context-manager.ts` - 上下文管理（纯函数）
- ✅ `src/core/intent-parser.ts` - 意图解析

### 弹性模块 (Resilience)
- ✅ `src/resilience/checkpoint.ts` - 检查点管理
- ⏳ `src/resilience/circuit-breaker.ts` - 熔断器（待测试）
- ⏳ `src/resilience/health-monitor.ts` - 健康监控（待测试）
- ⏳ `src/resilience/orchestrator.ts` - 恢复编排器（待测试）

### 提示词模块 (Prompts)
- ✅ `src/prompts/assembler.ts` - 提示词组装
- ⏳ `src/prompts/registry.ts` - 模板注册表（待测试）

### 基础设施 (Infrastructure)
- ✅ `src/logger.ts` - 日志系统
- ⏳ `src/audit/audit-log.ts` - 审计日志（待测试）
- ⏳ `src/memory/*.ts` - 记忆模块（待测试）

## 🔧 测试最佳实践

### 命名约定
- 测试文件: `*.test.ts` 或 `*.spec.ts`
- 测试函数: `test*()` 或 `test*Feature()`
- Mock 类: `Mock*` 前缀

### 断言风格
使用简单的 `if/else` + `console.log` 输出:
```typescript
if (result === expected) {
  console.log('  ✅ 测试描述');
  passed++;
} else {
  console.log(`  ❌ 错误描述: 实际值`);
  failed++;
}
```

### 清理策略
每个测试文件包含清理函数:
```typescript
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
```

## 📈 下一步计划

### 高优先级
1. 添加 CircuitBreaker 单元测试
2. 添加 HealthMonitor 单元测试
3. 添加 RecoveryOrchestrator 单元测试
4. 添加 PromptRegistry 单元测试

### 中优先级
5. 添加 AuditLog 单元测试
6. 添加 MemoryStore 单元测试
7. 添加 Summarizer 单元测试
8. 添加 Experience 模块测试

### 测试覆盖率目标
- 核心模块: 80%+ 覆盖率
- 弹性模块: 90%+ 覆盖率
- 提示词模块: 85%+ 覆盖率
- 总体目标: 75%+ 覆盖率

---

**最后更新**: 2026-06-24 23:42 GMT+8
**维护者**: Agent System Team
