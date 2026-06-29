# 更新 agent-system-config.ts 添加 skipIntentParsing 字段
$filePath = "D:\QClaw_Workspace\agent-system\src\config\agent-system-config.ts"
$content = Get-Content $filePath -Raw -Encoding UTF8

# 1. 在 agent 接口中添加 skipIntentParsing: boolean
$oldInterface = "  agent: {`n    callTimeoutMs: number;`n    maxRetries: number;`n    emptyLoopThreshold: number;`n  };"
$newInterface = "  agent: {`n    loopIntervalMs: number;`n    heartbeatIntervalMs: number;`n    maxSubTasks: number;`n    defaultTimeoutMs: number;`n    callTimeoutMs: number;`n    maxRetries: number;`n    emptyLoopThreshold: number;`n    debugLogging: boolean;`n    skipIntentParsing: boolean;`n  };"
$content = $content -replace [Regex]::Escape($oldInterface), $newInterface

# 2. 在 DEFAULT_CONFIG 中添加默认值
$oldDefault = "    agent: {`n      callTimeoutMs: 60000,`n      maxRetries: 1,`n      emptyLoopThreshold: 3,`n    },"
$newDefault = "    agent: {`n      loopIntervalMs: 1000,`n      heartbeatIntervalMs: 300000,`n      maxSubTasks: 10,`n      defaultTimeoutMs: 600000,`n      callTimeoutMs: 300000,`n      maxRetries: 5,`n      emptyLoopThreshold: 3,`n      debugLogging: false,`n      skipIntentParsing: false,`n    },"
$content = $content -replace [Regex]::Escape($oldDefault), $newDefault

# 3. 更新 formatConfig 中的日志输出（可选）
# 保存
Set-Content -Path $filePath -Value $content -Encoding UTF8
Write-Host "✅ agent-system-config.ts 已更新"
