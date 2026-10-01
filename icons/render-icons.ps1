# ひきがたり アイコン生成(Node/Python 不要)
# 使い方: powershell -ExecutionPolicy Bypass -File icons/render-icons.ps1
# 元絵は icons/icon.svg。Edge(ヘッドレス)で 1024px に描き、.NET System.Drawing で各サイズに縮小する。
# ・icon-192 / icon-512 / favicon-32 は角丸  ・icon-180(iPhone)と maskable は四角(角は端末が丸める)
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$svg = Join-Path $root 'icon.svg'
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Edge か Chrome が見つかりません' }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('hk-icon-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
$big = Join-Path $tmp 'icon-1024.png'
$url = ([System.Uri]$svg).AbsoluteUri
$p = Start-Process -FilePath $edge -Wait -PassThru -NoNewWindow -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1024,1024',
  "--user-data-dir=`"$(Join-Path $tmp 'profile')`"", "--screenshot=`"$big`"", $url
)
if (-not (Test-Path $big)) { throw "描けませんでした (exit $($p.ExitCode))" }

$src = [System.Drawing.Image]::FromFile($big)

function Save-Icon([int]$size, [string]$name, [bool]$rounded) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  if ($rounded) {
    # 縮小した絵を筆にして、角丸の形に塗る(ふちがなめらかになる)
    $scaled = New-Object System.Drawing.Bitmap($size, $size)
    $gs = [System.Drawing.Graphics]::FromImage($scaled)
    $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gs.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gs.DrawImage($src, 0, 0, $size, $size)
    $gs.Dispose()
    $d = [single]($size * 0.44)
    $rr = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rr.AddArc(0, 0, $d, $d, 180, 90)
    $rr.AddArc($size - $d, 0, $d, $d, 270, 90)
    $rr.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $rr.AddArc(0, $size - $d, $d, $d, 90, 90)
    $rr.CloseFigure()
    $brush = New-Object System.Drawing.TextureBrush($scaled)
    $g.FillPath($brush, $rr)
    $brush.Dispose()
    $scaled.Dispose()
  } else {
    $g.DrawImage($src, 0, 0, $size, $size)
  }
  $bmp.Save((Join-Path $root $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

Save-Icon 512 'icon-512.png' $true
Save-Icon 192 'icon-192.png' $true
Save-Icon 512 'icon-maskable-512.png' $false
Save-Icon 180 'icon-180.png' $false
Save-Icon 32 'favicon-32.png' $true

$src.Dispose()
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host "Icons rendered in $root"
