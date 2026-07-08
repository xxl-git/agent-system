$uri = "http://127.0.0.1:19701/api/events"
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [System.TimeSpan]::FromSeconds(10)

try {
    $stream = $client.GetStreamAsync($uri).Result
    $reader = New-Object System.IO.StreamReader($stream)
    $count = 0
    while ($count -lt 5 -and -not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line) {
            Write-Host $line
            $count++
        }
    }
} finally {
    $client.Dispose()
}
