# 编译 agent-system 项目
# 使用此脚本避免 PowerShell 解析问题

$ErrorActionPreference = "Stop"

Write-Host "=== 开始编译 agent-system ===" -ForegroundColor Cyan

# 切换到项目目录
$projectDir = "D:\QClaw_Workspace\agent-system"
Set-Location $projectDir

Write-Host "当前目录: $(Get-Location)" -ForegroundColor Gray

# 运行 TypeScript 编译
Write-Host "正在编译 TypeScript..." -ForegroundColor Yellow
$output = & ".\node_modules\.bin\tsc.cmd" 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ 编译成功！" -ForegroundColor Green
} else {
    Write-Host "❌ 编译失败！" -ForegroundColor Red
    Write-Host "错误信息:" -ForegroundColor Yellow
    Write-Output $output
}

Write-Host "=== 编译完成 ===" -ForegroundColor Cyan
