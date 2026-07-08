# Agent System 代码审查与修复 (2026-07-06)

## 审查范围
- `packages/server/src/agent-server.ts` 模型相关路由（GET/POST /api/models/*）
- `packages/core/src/core/context-manager.ts` 压缩逻辑
- 前端轮询机制（agent-ui.html / admin-panel.html）
- 单元测试套件（8 个 .test.ts 文件）

## 发现的 Bug 与修复

### 1. [实现 Bug] `/api/models/scan` 仅返回已加载模型
- **现象**：UI 点击刷新模型列表后只剩 1 个已加载模型，其余 22 个本地模型消失
- **根因**：scan 路由回退逻辑错误调用 OpenAI `/v1/models`（仅返回已加载模型），与 `GET /api/models` 使用的 REST `/api/v1/models` 不一致；agent 未就绪时走回退导致丢模型
- **修复**：scan 回退改为调用 REST `/api/v1/models`（REST 全量 + 双源 loaded 校验），与 GET 一致
- **验证**：GET 与 POST /api/models/scan 均返回 `total=23, loaded=1`，行为一致
- **提交**：`2c6a3c6`（已推送 main）

### 2. [性能 Bug] 前端高频轮询（每 2s / 5s 请求）
- **现象**：浏览器每 2s 请求 `/api/status`（附带 model 字段），每 5s 请求 `/api/dashboard`；后台观察到每 2s 模型列表请求
- **根因**：无心跳机制自动检查模型列表；前端两个 setInterval 间隔过短（2000ms / 5000ms）
- **修复**：
  - `agent-ui.html`：`/api/status` 和 `/api/dashboard` 间隔 → 30000ms
  - `admin-panel.html`：`setInterval(loadDashboard, 5000)` → 30000ms
- **提交**：`e55408c` (agent-ui), `78dd5f3` (admin-panel)，已推送 main
- **注意**：模型列表获取仍为被动+手动（`fetchModels()` / `refreshModels()` 仅刷新按钮触发），LM Studio 变动需手动刷新

### 3. [测试质量] ContextManager 单元测试失败
- **context-manager-pure**（2 失败）：`estimateTokens` 测试期望基于旧逻辑（1字符≈1 token），实际实现已改为英文 4 字符/token（P2 修复）。更新期望到合理区间（英文短文 1-5 tokens、100字符英文 20-30 tokens、中文长文 300-400 tokens）。修复后 **16/16 通过**。
- **context-manager-p0**（测试3 警告）：测试3 "摘要超预算" 因 `mockSummarizer` 返回摘要过短（~25 tokens），`summaryTokens(25) < budget(50)`，未触发超预算分支（`[对话历史摘要]`），实际走正常分支（`[此前对话摘要]`）。修复 `mockSummarizer` 返回 ~100 tokens 摘要，使测试3 真正触发超预算分支。修复后 3/3 场景通过（均验证摘要块 role='user'）。
- **提交**：`7afccc0`（已推送 main）

### 4. [构建问题] dist 与源不同步（增量编译缓存）
- **现象**：`run-tests.ps1` 找不到 dist 下测试文件；旧 dist 的 `context-manager-p0.test.js` 无 `process.exit` 导致测试误判
- **根因**：`build.ps1` 用 `tsc -b` 增量编译，tsbuildinfo 缓存导致 test 文件未重编
- **解决**：用 `node ../../node_modules/typescript/bin/tsc -b --force` 强制重编 packages/core（注意：`npx` 在 PowerShell 下因 shell 转义报错 "此时不应有 )"，需直接调 node 二进制）。`.gitignore` 已忽略 `dist/`，重编产物不提交。
- **验证**：强制重编后 dist 与源同步，8 套测试真实通过

## 测试覆盖真相
- 工作区**实际只有 8 个 .test.ts 文件**（root `logger` + packages/core 7 个），**不存在** MEMORY 中声称的 `checkpoint.test.ts` (17 用例) 和 `assembler.test.ts` (24 用例) —— 历史记录"106 用例"是不准确的（可能为计划/旧版本）
- 8 套测试结果：**29 通过 0 失败，ALL PASS**
  - `dist/__tests__/logger.test.js` (3)
  - `packages/core/dist/core/agent/__tests__/{chat,command,task}-handler.test.js` (4+3+4)
  - `packages/core/dist/core/__tests__/{context-manager-p0,pure,intent-parser,p2-fixes}.test.js` (p0=场景验证, pure=16, intent=2, p2=4)

## 提交记录（均已推送 main）
| Commit | 说明 |
|--------|------|
| `2c6a3c6` | fix: 修复 /api/models/scan 仅返回已加载模型的问题 |
| `e55408c` | fix: 前端轮询间隔调整为 30s 降低请求频率 (agent-ui) |
| `78dd5f3` | fix: admin-panel 轮询间隔调整为 30s 降低请求频率 |
| `7afccc0` | fix: ContextManager 测试套件修复（estimateTokens 期望 + 超预算分支 mock） |

## 建议后续
- [ ] 补充缺失的 `checkpoint.test.ts` 和 `assembler.test.ts` 单元测试（恢复完整覆盖）
- [ ] 考虑模型列表心跳推送（SSE broadcast on LM Studio model change）替代手动刷新
- [ ] `build.ps1` 增加 `--force` 或清理 tsbuildinfo 步骤，避免增量编译缓存导致"假编译通过"
- [ ] 统一测试运行器（run_all_tests.js 已可用，修复 run-tests.ps1 路径或弃用）
