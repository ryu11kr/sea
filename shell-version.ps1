function Get-PwaCachePrefix {
  param([string] $Root)

  $configPath = Join-Path $Root "pwa.config.json"
  if (-not (Test-Path $configPath -PathType Leaf)) {
    return "pwa-starter"
  }
  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.cachePrefix) { return [string]$config.cachePrefix }
  } catch {
    return "pwa-starter"
  }
  return "pwa-starter"
}

function Get-ShellFingerprint {
  param([string] $Root)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = New-Object IO.MemoryStream

  foreach ($name in @("index.html", "offline.html")) {
    $path = Join-Path $Root $name
    if (Test-Path $path -PathType Leaf) {
      $bytes = [IO.File]::ReadAllBytes($path)
      $stream.Write($bytes, 0, $bytes.Length)
    }
  }

  $cssDir = Join-Path $Root "css"
  if (Test-Path $cssDir -PathType Container) {
    Get-ChildItem $cssDir -Filter "*.css" -File |
      Sort-Object Name |
      ForEach-Object {
        $bytes = [IO.File]::ReadAllBytes($_.FullName)
        $stream.Write($bytes, 0, $bytes.Length)
      }
  }

  foreach ($name in @("sw.js", "sw.config.js")) {
    $path = Join-Path $Root $name
    if (Test-Path $path -PathType Leaf) {
      $bytes = [IO.File]::ReadAllBytes($path)
      $stream.Write($bytes, 0, $bytes.Length)
    }
  }

  $jsDir = Join-Path $Root "js"
  if (Test-Path $jsDir -PathType Container) {
    Get-ChildItem $jsDir -Filter "*.js" -File |
      Sort-Object Name |
      ForEach-Object {
        $bytes = [IO.File]::ReadAllBytes($_.FullName)
        $stream.Write($bytes, 0, $bytes.Length)
      }
  }

  $hash = $sha.ComputeHash($stream.ToArray())
  return ([BitConverter]::ToString($hash) -replace "-", "").ToLower()
}

function Sync-ShellVersion {
  param([string] $Root)

  $statePath = Join-Path $Root ".pwa-build-state.json"
  $versionPath = Join-Path $Root "version.json"
  $fingerprint = Get-ShellFingerprint -Root $Root
  $prefix = Get-PwaCachePrefix -Root $Root

  $state = [ordered]@{ build = 1; fingerprint = "" }
  if (Test-Path $statePath -PathType Leaf) {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
  }

  if ($fingerprint -eq $state.fingerprint) {
    return $null
  }

  if ([string]::IsNullOrEmpty($state.fingerprint)) {
    $build = 1
  } else {
    $build = [int]$state.build + 1
  }

  $newState = @{
    build = $build
    fingerprint = $fingerprint
  }
  $version = [ordered]@{
    build = $build
    cacheName = "$prefix-$build"
    label = "빌드 $build"
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }

  $utf8 = New-Object Text.UTF8Encoding $false
  [IO.File]::WriteAllText($versionPath, ($version | ConvertTo-Json -Compress), $utf8)
  [IO.File]::WriteAllText($statePath, ($newState | ConvertTo-Json -Compress), $utf8)
  return $build
}