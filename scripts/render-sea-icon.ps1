# 물때첩 — 원본 JPG에서 흰 여백 제거 후 PWA 아이콘 PNG 생성
param(
  [string]$Source = (Join-Path $PSScriptRoot "..\icons\source\sea-app-icon.jpg"),
  [string]$OutDir = (Join-Path $PSScriptRoot "..\icons"),
  [int]$WhiteThreshold = 248
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Source)) {
  Write-Error "Source not found: $Source"
}

function Get-ContentBounds {
  param([System.Drawing.Bitmap]$Bmp, [int]$Threshold)

  $minX = $Bmp.Width
  $minY = $Bmp.Height
  $maxX = 0
  $maxY = 0
  $found = $false

  for ($y = 0; $y -lt $Bmp.Height; $y++) {
    for ($x = 0; $x -lt $Bmp.Width; $x++) {
      $c = $Bmp.GetPixel($x, $y)
      if ($c.A -lt 16) { continue }
      if ($c.R -ge $Threshold -and $c.G -ge $Threshold -and $c.B -ge $Threshold) { continue }
      $found = $true
      if ($x -lt $minX) { $minX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }

  if (-not $found) {
    return [System.Drawing.Rectangle]::FromLTRB(0, 0, $Bmp.Width, $Bmp.Height)
  }

  # 1px 안쪽 여백만 (안티앨리어싱 잘림 방지)
  $pad = 1
  $minX = [Math]::Max(0, $minX - $pad)
  $minY = [Math]::Max(0, $minY - $pad)
  $maxX = [Math]::Min($Bmp.Width - 1, $maxX + $pad)
  $maxY = [Math]::Min($Bmp.Height - 1, $maxY + $pad)
  $w = $maxX - $minX + 1
  $h = $maxY - $minY + 1
  return New-Object System.Drawing.Rectangle $minX, $minY, $w, $h
}

function New-SquareBitmap {
  param([System.Drawing.Bitmap]$Cropped)

  $side = [Math]::Max($Cropped.Width, $Cropped.Height)
  $sq = New-Object System.Drawing.Bitmap $side, $side
  $g = [System.Drawing.Graphics]::FromImage($sq)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 224, 242, 254)) # #E0F2FE
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $x = [int](($side - $Cropped.Width) / 2)
  $y = [int](($side - $Cropped.Height) / 2)
  $g.DrawImage($Cropped, $x, $y, $Cropped.Width, $Cropped.Height)
  $g.Dispose()
  return $sq
}

function Save-ResizedPng {
  param(
    [System.Drawing.Bitmap]$Master,
    [int]$Size,
    [string]$Path
  )
  $out = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($Master, 0, 0, $Size, $Size)
  $g.Dispose()
  $out.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
}

function Save-MaskablePng {
  param(
    [System.Drawing.Bitmap]$Master,
    [int]$Size,
    [string]$Path,
    [double]$FillRatio = 0.82
  )
  $out = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 14, 165, 233)) # theme #0EA5E9
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $inner = [int]($Size * $FillRatio)
  $x = [int](($Size - $inner) / 2)
  $g.DrawImage($Master, $x, $x, $inner, $inner)
  $g.Dispose()
  $out.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
}

$srcImg = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
try {
  $full = New-Object System.Drawing.Bitmap $srcImg
  $bounds = Get-ContentBounds -Bmp $full -Threshold $WhiteThreshold
  $cropped = $full.Clone($bounds, $full.PixelFormat)
  $master = New-SquareBitmap -Cropped $cropped

  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

  Save-ResizedPng -Master $master -Size 192 -Path (Join-Path $OutDir "icon-192.png")
  Save-ResizedPng -Master $master -Size 512 -Path (Join-Path $OutDir "icon-512.png")
  Save-MaskablePng -Master $master -Size 512 -Path (Join-Path $OutDir "icon-maskable-512.png")
  Copy-Item (Join-Path $OutDir "icon-512.png") (Join-Path $OutDir "google-oauth-logo.png") -Force

  Write-Host "Icons written to $OutDir"
  Write-Host "  icon-192.png, icon-512.png, icon-maskable-512.png, google-oauth-logo.png"
} finally {
  $srcImg.Dispose()
}