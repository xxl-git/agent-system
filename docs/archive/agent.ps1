# Agent System v0.5.0 — 启动器
param(
  [string]$Mode = "interactive",
  [int]$AuditPort = 19700
)

$ErrorActionPreference = "Stop"
$AGENT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AGENT_DIR

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Agent System v0.5.0                    ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ─── 环境检查 ───
try {
  $lmAlive = (Invoke-RestMethod -Uri "http://127.0.0.1:1234/v1/models" -TimeoutSec 3 -ErrorAction SilentlyContinue)
  if ($lmAlive) { Write-Host "  ✓ LM Studio 在线 (127.0.0.1:1234)" -ForegroundColor Green }
} catch { Write-Host "  ✗ LM Studio 离线" -ForegroundColor Yellow }

try {
  $auditAlive = (Invoke-RestMethod -Uri "http://127.0.0.1:$AuditPort/api/audit/stats" -TimeoutSec 2 -ErrorAction SilentlyContinue)
  if ($auditAlive) { Write-Host "  ✓ 审计仪表盘在线 (127.0.0.1:$AuditPort)" -ForegroundColor Green }
} catch { Write-Host "  ✗ 审计仪表盘离线" -ForegroundColor Yellow }

if (Test-Path "data\agent.db") { Write-Host "  ✓ 数据库 data\agent.db" -ForegroundColor Green }
else { Write-Host "  ✗ 数据库未找到" -ForegroundColor Yellow }

Write-Host ""

# ─── 模式选择 ───
switch ($Mode) {
  "audit" {
    Write-Host "▶ 启动审计仪表盘 (端口 $AuditPort)..." -ForegroundColor Cyan
    node dist\audit\audit-server.js
  }
  "run" {
    Write-Host "▶ 运行全链路干跑测试..." -ForegroundColor Cyan
    npx ts-node tests\test-dry-run.ts
  }
  "interactive" {
    Write-Host "▶ 启动 Agent 交互模式 (需 LM Studio)..." -ForegroundColor Cyan
    node dist\index.js
  }
  default {
    Write-Host "用法: .\agent.ps1 [audit|run|interactive]" -ForegroundColor Yellow
  }
}
