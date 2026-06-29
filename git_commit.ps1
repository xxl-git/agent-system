$ErrorActionPreference = "Stop"
$env:LC_ALL = "C.UTF-8"
$env:LANG = "C.UTF-8"

# Stage key files
$files = @(
    "config/agent-system.yaml",
    "config/default.json",
    "src/core/context-manager.ts",
    "src/server/agent-server.ts",
    "data/agent.db"
)

foreach ($f in $files) {
    git add "$f"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Staged: $f" -ForegroundColor Green
    } else {
        Write-Host "Failed to stage: $f" -ForegroundColor Red
    }
}

# Show staged diff
Write-Host "`n--- Staged changes ---" -ForegroundColor Cyan
git diff --cached --stat

# Commit
$commitMsg = @"
fix: DB schema + model switch API + config update

- data/agent.db: ADD COLUMN session_id to decisions table (fixes 'no such column' error on startup)
- src/server/agent-server.ts: remove agentReady check from /api/models/switch (allows model switch during init probe)
- src/core/context-manager.ts: export 5 functions (estimateTokens, extractKeywords, keywordMatchScore, buildCompressionPrompt, parseCompressionOutput) to fix compilation
- config/agent-system.yaml + config/default.json: update version to 0.9.2, update model to qwen/qwen3.5-9b
"@

Write-Host "`n--- Committing ---" -ForegroundColor Cyan
git commit -m $commitMsg

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nCommit succeeded!" -ForegroundColor Green
    git log --oneline -3
} else {
    Write-Host "`nCommit failed!" -ForegroundColor Red
}
