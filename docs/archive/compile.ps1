# 编译 TypeScript
Set-Location "D:\QClaw_Workspace\agent-system"
npx tsc
if ($LASTEXITCODE -eq 0) {
    Write-Output "✅ 编译成功"
} else {
    Write-Output "❌ 编译失败 (exit code: $LASTEXITCODE)"
}
