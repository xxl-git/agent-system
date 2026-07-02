# CheckpointManager 存根配置修复

**日期**：2026-07-02  
**问题**：Agent 服务器启动后卡死在初始化阶段，日志停在 `[LMStudio] reasoning 从 config 自动加载: off`，后续初始化步骤（Step 3/7 开始）永不执行。

## 根因分析

### 调用链

```
AgentCore 构造函数
  → new CheckpointManager(config)  [通过 getCheckpointManager()]
    → this.ensureDir()
      → fs.existsSync(this.config.dataDir)
```

### 问题点

`packages/resilience/src/config.ts` 是存根文件（stub），供包独立编译时使用：

```typescript
// packages/resilience/src/config.ts (stub)
export function getConfigSection(section: string): any {
  return {};  // 始终返回空对象
}
```

编译后 `packages/resilience/dist/config.js`：
```javascript
function getConfigSection(section) {
    return {};  // 空对象，dataDir 属性为 undefined
}
```

`getCheckpointManager()` 中的逻辑：
```typescript
const cpCfg = getConfigSection('checkpoint');  // 返回 {}
const config = cpCfg ? {  // {} 是 truthy！
  dataDir: cpCfg.dataDir,  // undefined！
  contextWindow: cpCfg.contextWindow,
  maxRecoveryAttempts: cpCfg.maxRecoveryAttempts,
} : undefined;
_instance = new CheckpointManager(config);  // config.dataDir = undefined
```

`CheckpointManager` 构造函数：
```typescript
constructor(config?) {
  this.config = { ...DEFAULT_CONFIG, ...config };  // dataDir 被覆盖为 undefined
  this.ensureDir();  // fs.existsSync(undefined) → 在 Windows 上可能卡死
}
```

## 修复方案

**文件**：`packages/resilience/src/checkpoint.ts`

**修改**：`getCheckpointManager()` 函数增加 `dataDir` 真实性检查

```typescript
// 修复前
const config = cpCfg ? {
  dataDir: cpCfg.dataDir,
  contextWindow: cpCfg.contextWindow,
  maxRecoveryAttempts: cpCfg.maxRecoveryAttempts,
} : undefined;

// 修复后
const config = (cpCfg && (cpCfg as any).dataDir) ? {
  dataDir: (cpCfg as any).dataDir,
  contextWindow: (cpCfg as any).contextWindow,
  maxRecoveryAttempts: (cpCfg as any).maxRecoveryAttempts,
} : undefined;
```

**原理**：当 `cpCfg` 是存根空对象 `{}` 时，`cpCfg.dataDir` 为 `undefined`（falsy），`config` 设为 `undefined`，`CheckpointManager` 构造函数使用 `DEFAULT_CONFIG`（包含有效 `dataDir`）。

## 验证结果

1. **编译验证**：
   ```bash
   cd packages/resilience && tsc  # 通过
   cd ../.. && tsc -b             # 通过
   ```

2. **启动验证**：
   - 日志显示完整初始化流程（90ms 完成）
   - API `/api/status` 返回 `{"ready": true}`
   - 服务器正常运行在端口 19701

3. **修复前日志**（卡死）：
   ```
   [INFO] [LMStudio] reasoning 从 config 自动加载: off
   （日志停止，永不显示 "[Agent] ====== 初始化开始 ======"）
   ```

4. **修复后日志**（正常）：
   ```
   [INFO] [LMStudio] reasoning 从 config 自动加载: off
   [INFO] [SessionStore] 已加载会话存储: ...
   [INFO] [Agent] ====== 初始化开始 ======
   [INFO] [Agent] Step 3/7: 会话存储初始化...
   ...
   [INFO] [Agent] ====== 初始化完成 (90ms) ======
   ```

## 经验教训

1. **存根函数必须返回 `null` 而非空对象**：
   - `return {}` 是 truthy，调用方无法区分"配置未加载"和"配置加载成功但为空"
   - 应改为 `return null` 或 `return undefined`

2. **防御性编程**：
   - 配置读取后应检查关键字段（如 `dataDir`）是否存在
   - 不应假设存根会返回合理默认值

3. **Windows 文件系统 API 行为**：
   - `fs.existsSync(undefined)` 在某些 Windows 版本/Node.js 版本组合下会卡死（同步挂起）
   - 应始终确保传入有效路径字符串

## 后续改进建议

1. **修改所有存根函数**：
   - `packages/*/src/config.ts` 中的 `getConfigSection()` 应返回 `null`
   - 调用方应检查返回值是否为 `null`

2. **Workspace 链接验证**：
   - 开发启动时验证 `node_modules/@agent-system/*` 是否正确链接到 `packages/*`
   - 避免运行时使用存根代码

3. **初始化超时保护**：
   - 为 `AgentCore.init()` 添加超时保护（如 5 秒）
   - 超时时输出诊断信息（哪个步骤卡住）

## 修改文件清单

| 文件 | 修改内容 |
|------|-----------|
| `packages/resilience/src/checkpoint.ts` | `getCheckpointManager()` 增加 `dataDir` 真实性检查 |

## 测试覆盖

- [x] 单元测试：`packages/resilience` 编译通过
- [x] 集成测试：服务器启动并完成初始化
- [x] API 测试：`/api/status` 返回 `ready: true`
- [ ] 端到端测试：发送聊天消息并验证响应（待执行）
