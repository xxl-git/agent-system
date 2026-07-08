$base = "http://127.0.0.1:19701"
$body = '{"message":"hello"}'
Write-Host "===== SSE 流式 Chat ====="
try {
  $resp = Invoke-WebRequest -Uri "$base/api/chat/stream" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 120
  Write-Host "Status: $($resp.StatusCode)"
  Write-Host "Body length: $($resp.Content.Length)"
  $preview = if ($resp.Content.Length -gt 500) { $resp.Content.Substring(0, 500) } else { $resp.Content }
  Write-Host "Body: $preview"
} catch {
  Write-Host "FAIL: $($_.Exception.Message)"
}
