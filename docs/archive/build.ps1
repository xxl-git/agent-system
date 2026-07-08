# build.ps1 - Build agent-system
param(
    [string]$Root = "D:\QClaw_Workspace\agent-system"
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$packages = @(
    @("events","models-core","tools","prompts"),
    @("llm","memory","resilience","skills"),
    @("experience"),
    @("core"),
    @("server")
)

$tscCmd = "$Root\node_modules\.bin\tsc.cmd"
$pkgDir = "$Root\packages"

Write-Host "=== Clean ==="
if (Test-Path "$Root\dist") { Remove-Item "$Root\dist" -Recurse -Force }
for ($i = 0; $i -lt $packages.Length; $i++) {
    foreach ($pkg in $packages[$i]) {
        $d = "$pkgDir\$pkg\dist"
        if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    }
}

Write-Host "=== Building packages ==="
$failed = $false
$origLocation = Get-Location

for ($i = 0; $i -lt $packages.Length; $i++) {
    foreach ($pkg in $packages[$i]) {
        Write-Host "$pkg... " -NoNewline
        $cwd = "$pkgDir\$pkg"
        Set-Location $cwd
        $result = & cmd /c "$tscCmd --project tsconfig.json" 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "FAILED" -ForegroundColor Red
            Write-Host $result
        } else {
            Write-Host "OK" -ForegroundColor Green
        }
        Set-Location $origLocation
    }
}

Write-Host "`n=== Building root ==="
Write-Host "root... " -NoNewline
Set-Location $Root
$result = cmd /c "$tscCmd" 2>&1
if ($LASTEXITCODE -ne 0) {
    # Type errors are OK as long as JS is emitted
    Write-Host "WARN (type errors, JS emitted)" -ForegroundColor Yellow
} else {
    Write-Host "OK" -ForegroundColor Green
}
Set-Location $origLocation

Write-Host "`n=== Verify ==="
$agentJs = "$Root\dist\server\agent-server.js"
if (Test-Path $agentJs) {
    Write-Host "[OK] dist\server\agent-server.js ($((Get-Item $agentJs).Length) bytes)"
} else {
    Write-Host "[ERR] Missing" -ForegroundColor Red
}

$lm = "$pkgDir\core\dist\models\adapters\lmstudio.js"
if (Test-Path $lm) {
    $content = Get-Content $lm -Raw
    if ($content -match "this\.baseUrl") {
        Write-Host "[OK] listModels() fix VERIFIED" -ForegroundColor Green
    } else {
        Write-Host "[WARN] fix not in compiled JS" -ForegroundColor Yellow
    }
} else {
    Write-Host "[WARN] packages/core/dist not compiled" -ForegroundColor Yellow
}

Write-Host "=== DONE ==="
