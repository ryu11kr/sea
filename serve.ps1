# 사용법: serve.cmd 더블클릭 (권장)
# 포트: uxpwa/dev-ports.json (폴더별)

param([int] $Port = 0)

. (Join-Path $PSScriptRoot "shell-version.ps1")
. (Join-Path $PSScriptRoot "..\Get-PwaDevPort.ps1")

$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$port = if ($Port -gt 0) { $Port } else { Get-PwaDevPort -AppRoot $PSScriptRoot }
$types = @{
  ".html"        = "text/html; charset=utf-8"
  ".css"         = "text/css; charset=utf-8"
  ".js"          = "text/javascript; charset=utf-8"
  ".webmanifest" = "application/manifest+json; charset=utf-8"
  ".json"        = "application/json; charset=utf-8"
  ".png"         = "image/png"
  ".svg"         = "image/svg+xml"
}

Sync-ShellVersion -Root $root | Out-Null

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
try {
  $listener.Start()
} catch {
  Write-Output ""
  Write-Output "오류: 포트 $port 를 쓸 수 없습니다."
  Write-Output "http://127.0.0.1:$port/ 가 이미 켜져 있을 수 있습니다."
  Write-Output ""
  exit 1
}

$folderName = Split-Path $PSScriptRoot -Leaf
Write-Output "폴더: $folderName"
Write-Output "http://127.0.0.1:$port/"
Write-Output "종료: Ctrl+C  |  안 되면 창 X 닫기  |  uxpwa\stop-serves.cmd"
Write-Output ""

. (Join-Path $PSScriptRoot "..\PwaServeLoop.ps1")
$serveState = Initialize-PwaServeShutdown -Listener $listener

try {
  while (-not $serveState.Stop) {
    $client = $null
    try {
      $client = Accept-PwaServeClient -State $serveState
      if ($null -eq $client) { break }
      $stream = $client.GetStream()
      $stream.ReadTimeout = 5000
      $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
      $request = $reader.ReadLine()
      if (-not $request) {
        continue
      }
      while ($true) {
        $line = $reader.ReadLine()
        if ([string]::IsNullOrEmpty($line)) { break }
      }

      $bumped = Sync-ShellVersion -Root $root
      if ($bumped) {
        Write-Output "[PWA] shell 변경 → 빌드 $bumped"
      }

      $parts = $request.Split(" ")
      $target = if ($parts.Length -ge 2) { $parts[1] } else { "/" }
      $pathOnly = ([Uri]::new("http://localhost" + $target)).AbsolutePath
      $relative = [Uri]::UnescapeDataString($pathOnly.TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($relative)) { $relative = "index.html" }

      $full = [IO.Path]::GetFullPath((Join-Path $root ($relative -replace "/", [IO.Path]::DirectorySeparatorChar)))
      $status = 200
      $body = $null
      $type = "text/plain; charset=utf-8"

      if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        $status = 403
        $body = [Text.Encoding]::UTF8.GetBytes("403")
      } elseif (-not (Test-Path $full -PathType Leaf)) {
        $status = 404
        $body = [Text.Encoding]::UTF8.GetBytes("404")
      } else {
        $body = [IO.File]::ReadAllBytes($full)
        $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($types.ContainsKey($ext)) { $type = $types[$ext] }
      }

      $header = "HTTP/1.1 $status OK`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
      if ($status -eq 404) {
        $header = $header.Replace("200 OK", "404 Not Found").Replace("$status OK", "404 Not Found")
      }
      if ($status -eq 403) {
        $header = "HTTP/1.1 403 Forbidden`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      }

      $headBytes = [Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headBytes, 0, $headBytes.Length)
      $stream.Write($body, 0, $body.Length)
      $stream.Flush()
    } catch {
      if ($_.Exception.Message -notmatch "수신 대기") {
        Write-Output $_.Exception.Message
      }
    } finally {
      if ($null -ne $client) {
        $client.Close()
      }
    }
  }
} finally {
  if ($listener.Server.IsBound) {
    $listener.Stop()
  }
}