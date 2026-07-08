# 运行所有单元测试（UTF-8 编码）
# 解决 PowerShell 中文乱码问题

# 设置控制台代码页为 UTF-8
chcp 65001 | Out-Null

# 设置 PowerShell 输出编码为 UTF-8
$PSDefaultParameterValues['Out-File:Encoding'] = 'UTF8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "=== 设置 UTF-8 编码完成 ===" -ForegroundColor Green
Write-Host "Console Encoding: $([Console]::OutputEncoding.EncodingName)" -ForegroundColor Yellow
Write-Host ""

# 编译 TypeScript (包括测试文件)
Write-Host "=== 编译 TypeScript ===" -ForegroundColor Cyan
npx tsc --project tsconfig.json --noEmit 2>&1 | Select-String -Pattern "error" -CaseSensitive:$false

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 编译失败" -ForegroundColor Red
    exit 1
}

Write-Host "✅ 编译成功" -ForegroundColor Green
Write-Host ""

# 运行所有单元测试
Write-Host "=== 运行原有单元测试 ===" -ForegroundColor Cyan
node dist/core/__tests__/context-manager-p0.test.js
node dist/core/__tests__/p2-fixes.test.js
node dist/core/__tests__/intent-parser.test.js
node dist/core/__tests__/context-manager-pure.test.js

Write-Host ""
Write-Host "=== 运行新增单元测试 ===" -ForegroundColor Cyan
node dist/__tests__/logger.test.js
node dist/resilience/__tests__/checkpoint.test.js
node dist/core/agent/__tests__/chat-handler.test.js
node dist/core/agent/__tests__/command-handler.test.js
node dist/core/agent/__tests__/task-handler.test.js
node dist/prompts/__tests__/assembler.test.js

Write-Host ""
Write-Host "=== 所有测试运行完成 ===" -ForegroundColor Green
