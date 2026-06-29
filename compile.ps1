# compile.ps1 - 使用完整路径 node.exe 编译 TypeScript (绕过 OpenClaw node.cmd 包装器)
# 用法: .\compile.ps1             # 正常编译
#        .\compile.ps1 -NoEmit   # 只检查错误不生成文件

param(
    [switch]$NoEmit
)

$nodeExe = "D:\software\Common\nodejs\node.exe"
$tscJs = "node_modules\typescript\lib\tsc.js"
$projectRoot = $PSScriptRoot

# 检查 node.exe 是否存在
if (-not (Test-Path $nodeExe)) {
    Write-Error "Node.exe not found: $nodeExe"
    exit 1
}

# 检查 tsc.js 是否存在
if (-not (Test-Path (Join-Path $projectRoot $tscJs))) {
    Write-Error "TypeScript compiler not found: $tscJs"
    exit 1
}

# 构建参数
$args = @()
if ($NoEmit) {
    $args += "--noEmit"
}

# 切换到项目根目录
Set-Location $projectRoot

# 执行编译
Write-Host "Using node.exe: $nodeExe"
Write-Host "Compiling TypeScript project..."
& $nodeExe $tscJs @args

# 检查退出码
if ($LASTEXITCODE -eq 0) {
    Write-Host "Compilation successful!" -ForegroundColor Green
    
    # 显示编译后的文件
    $compiledFiles = Get-ChildItem dist -Filter "*.js" -Recurse | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-5) }
    if ($compiledFiles) {
        Write-Host "Compiled files:"
        $compiledFiles | ForEach-Object { Write-Host "  - $($_.FullName)" }
    }
} else {
    Write-Error "Compilation failed (exit code: $LASTEXITCODE)"
    exit $LASTEXITCODE
}
