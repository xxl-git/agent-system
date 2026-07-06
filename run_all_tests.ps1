[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
$root = "D:\QClaw_Workspace\agent-system"
$tests = @(
  "dist/__tests__/logger.test.js",
  "packages/core/dist/core/agent/__tests__/chat-handler.test.js",
  "packages/core/dist/core/agent/__tests__/command-handler.test.js",
  "packages/core/dist/core/agent/__tests__/task-handler.test.js",
  "packages/core/dist/core/__tests__/context-manager-p0.test.js",
  "packages/core/dist/core/__tests__/context-manager-pure.test.js",
  "packages/core/dist/core/__tests__/intent-parser.test.js",
  "packages/core/dist/core/__tests__/p2-fixes.test.js"
)
$totalPass = 0
$totalFail = 0
$anyFail = $false
foreach ($t in $tests) {
  $rel = $t
  $full = Join-Path $root $t
  if (-not (Test-Path $full)) {
    Write-Host "[MISSING] $rel" -ForegroundColor Yellow
    $anyFail = $true
    continue
  }
  try {
    $out = & node $full 2>&1 | Out-String
  } catch {
    $out = $_.Exception.Message
  }
  $lines = $out -split "`n"
  $summary = $lines | Where-Object { $_ -match "通过" -and $_ -match "失败" } | Select-Object -Last 1
  if (-not $summary) {
    $summary = $lines | Where-Object { $_ -match "PASS" -or $_ -match "FAIL" -or $_ -match "✅" -or $_ -match "❌" } | Select-Object -Last 1
  }
  if (-not $summary) { $summary = "(无摘要，详见输出)" }
  # 解析通过/失败数
  if ($out -match "(\d+)\s*通过") { $totalPass += [int]$Matches[1] }
  if ($out -match "(\d+)\s*失败") { $totalFail += [int]$Matches[1] }
  if ($out -match "失败|FAIL|❌|Error" -and $out -notmatch "0\s*失败") { $anyFail = $true }
  $ok = if ($out -match "0\s*失败" -or $out -match "所有测试通过" -or $out -match "✅") { "OK" } else { "CHECK" }
  Write-Host "[$ok] $rel" -ForegroundColor $(if($ok -eq "OK"){"Green"}else{"Yellow"})
  Write-Host "     $summary"
}
Write-Host ""
Write-Host "=== 汇总: 通过 $totalPass, 失败 $totalFail ===" -ForegroundColor Cyan
if ($totalFail -gt 0 -or $anyFail) {
  Write-Host "⚠ 存在失败或异常" -ForegroundColor Red
} else {
  Write-Host "✅ 全部测试通过" -ForegroundColor Green
}
