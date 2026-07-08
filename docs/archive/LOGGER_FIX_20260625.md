# Logger 日志轮转修复总结 (2026-06-25)

## 问题描述

日志轮转功能在应用重启时无法正确触发。具体表现为：
- 应用运行时，日志文件超过阈值后能正常轮转（通过 `checkRotation()` 定期检查）
- 但应用重启时，如果当日日志文件已存在且超过阈值，不会触发轮转
- 直到写入 50 次后（`rotationCheckInterval = 50`）才触发轮转

## 根因分析

**原实现（错误）：**
```typescript
constructor(logDir: string) {
  // ...
  this.rotateIfNeeded(); // ❌ 错误：此时日志文件可能还不存在
}
```

**问题：**
1. `Logger` 构造函数中调用了 `rotateIfNeeded()`
2. 但日志文件在第一次 `write()` 时才创建（通过 `fs.appendFileSync()`）
3. 因此构造函数中 `rotateIfNeeded()` 调用时，文件不存在，`fs.existsSync(logFile)` 返回 `false`，直接返回
4. 导致重启时超过阈值的日志文件不会被轮转

## 修复方案

**新实现（正确）：**
```typescript
class Logger {
  private _firstWrite = true; // 标记是否为第一次写入
  
  constructor(logDir: string) {
    // 注意：不在构造函数中调用 rotateIfNeeded()
    // 因为日志文件可能还不存在（文件在第一次 write() 时创建）
  }
  
  private write(level: LogLevel, message: string, ...args: unknown[]) {
    // ...
    const logFile = this.getLogFilePath();
    
    // ✅ 第一次写入前，检查是否需要对已存在的日志文件进行轮转
    // 这处理了应用程序重启时，日志文件已存在且超过阈值的情况
    if (this._firstWrite) {
      this._firstWrite = false;
      this.rotateIfNeeded();
    }
    
    this.checkRotation();
    fs.appendFileSync(logFile, line + '\n', 'utf-8');
  }
}
```

**修复逻辑：**
1. 添加 `_firstWrite` 标志，默认为 `true`
2. 移除构造函数中的 `rotateIfNeeded()` 调用
3. 在 `write()` 方法中，第一次写入前调用 `rotateIfNeeded()`
4. 这正确处理了应用重启场景：
   - 应用重启时，当日日志文件已存在（可能超过阈值）
   - 第一次写入时，检测到 `_firstWrite=true`，调用 `rotateIfNeeded()`
   - 如果文件超过阈值，触发轮转

## 验证

### 1. 简单 JavaScript 测试
创建 `simple-logger-test.js` 验证核心逻辑：
- ✅ 第一次写入前触发 `rotateIfNeeded()`
- ✅ 超过阈值的日志文件被正确轮转
- ✅ `.gz` 压缩文件正确创建
- ✅ 原日志文件被正确重置（包含轮转记录 + 新写入内容）

### 2. 单元测试
更新 `src/__tests__/logger.test.ts`：
- ✅ 测试 1: `performRotation()` 正确（4/4 通过）
- ✅ 测试 2: `checkRotation()` 正确（2/2 通过）
- ✅ 测试 3: 第一次写入前触发轮转（2/2 通过）**← 之前失败，现在通过**
- ✅ 测试 4: `maxRotatedFiles` 限制正确（2/2 通过）
- ✅ 测试 5: 边界情况处理正确（3/3 通过）

**测试 3 更新：**
- 原测试：验证构造函数中触发轮转（错误的行为）
- 新测试：验证第一次写入前触发轮转（正确的行为）
- 测试步骤：
  1. 创建超过阈值的日志文件
  2. 创建 `TestLogger`
  3. 调用 `logger.info()`（第一次写入）
  4. 验证轮转已触发

## 代码变更

### `src/logger.ts`
- 添加 `private _firstWrite = true;` 属性
- 移除构造函数中的 `this.rotateIfNeeded();` 调用
- 在 `write()` 方法中添加第一次写入前检查

### `src/__tests__/logger.test.ts`
- `TestLogger` 添加 `private _firstWrite = true;` 属性
- 移除 `TestLogger` 构造函数中的 `this.rotateIfNeeded();` 调用
- `TestLogger.write()` 方法添加第一次写入前检查
- 更新测试 3 以验证新的行为

## 提交记录

- `509fa27` - fix(logger): 修复日志轮转逻辑（在第一次写入前检查）
- `d84e85b` - test(logger): 更新单元测试以匹配新的轮转行为

## 后续工作

- [ ] 运行所有 106 个单元测试，确认无回归
- [ ] 在实际部署中验证日志轮转行为
- [ ] 考虑添加日志轮转的集成测试（模拟应用重启场景）

## 经验总结

1. **文件存在性检查很重要**：在操作文件前，务必确认文件是否存在
2. **延迟初始化**：对于可能不存在的资源，延迟到第一次使用时再检查/创建
3. **单元测试要匹配实际行为**：测试应该验证正确的行为，而不是错误的行为
4. **简单验证很重要**：通过简单的 JavaScript 测试快速验证核心逻辑，避免被复杂的测试框架干扰
