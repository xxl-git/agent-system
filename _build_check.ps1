Set-Location 'D:\QClaw_Workspace\agent-system'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:NODE_OPTIONS = ''
npm run build 2>&1
exit $LASTEXITCODE
