# ひきがたり アイコン生成（Node/Python不要、.NET System.Drawing のみ使用）
# 使い方: powershell -ExecutionPolicy Bypass -File icons/generate-icons.ps1
# 朱色の角丸に、白いピック(ギターのピック)と音符。src/ui/icons.js の Logo と同じ形。
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$bg = [System.Drawing.Color]::FromArgb(255, 0xE0, 0x57, 0x2B)
$fg = [System.Drawing.Color]::FromArgb(255, 0xFF, 0xFF, 0xFF)

function New-Icon([int]$size, [string]$path, [bool]$square, [double]$inset) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $bgBrush = New-Object System.Drawing.SolidBrush($bg)
  if ($square) {
    $g.FillRectangle($bgBrush, 0, 0, $size, $size)
  } else {
    $radius = [int]($size * 0.22)
    $rr = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $rr.AddArc(0, 0, $d, $d, 180, 90)
    $rr.AddArc($size - $d, 0, $d, $d, 270, 90)
    $rr.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $rr.AddArc(0, $size - $d, $d, $d, 90, 90)
    $rr.CloseFigure()
    $g.FillPath($bgBrush, $rr)
  }

  # 64x64 の設計座標を、余白 inset を取って拡大する
  $s = $size * (1 - 2 * $inset) / 64.0
  $o = $size * $inset
  function P([double]$x, [double]$y) { New-Object System.Drawing.PointF(($o + $x * $s), ($o + $y * $s)) }

  $pick = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pick.AddBezier((P 32 13), (P 41.5 13), (P 49 17.8), (P 49 24.5))
  $pick.AddBezier((P 49 24.5), (P 49 33.1), (P 39.4 46.9), (P 34.7 51.6))
  $pick.AddBezier((P 34.7 51.6), (P 33.2 53.1), (P 30.8 53.1), (P 29.3 51.6))
  $pick.AddBezier((P 29.3 51.6), (P 24.6 46.9), (P 15 33.1), (P 15 24.5))
  $pick.AddBezier((P 15 24.5), (P 15 17.8), (P 22.5 13), (P 32 13))
  $pick.CloseFigure()
  $fgBrush = New-Object System.Drawing.SolidBrush($fg)
  $g.FillPath($fgBrush, $pick)

  # 音符(ピックの上に朱色で)
  $pen = New-Object System.Drawing.Pen($bg, [single](3.2 * $s))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawLines($pen, [System.Drawing.PointF[]]@((P 27 36.2), (P 27 23), (P 37 20.8), (P 37 33.2)))
  $r = 3.2 * $s
  $c1 = P 24.4 36.6
  $c2 = P 34.4 33.4
  $g.FillEllipse($bgBrush, $c1.X - $r, $c1.Y - $r, $r * 2, $r * 2)
  $g.FillEllipse($bgBrush, $c2.X - $r, $c2.Y - $r, $r * 2, $r * 2)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

New-Icon -size 192 -path (Join-Path $root "icon-192.png") -square $false -inset 0.02
New-Icon -size 512 -path (Join-Path $root "icon-512.png") -square $false -inset 0.02
New-Icon -size 512 -path (Join-Path $root "icon-maskable-512.png") -square $true -inset 0.14
New-Icon -size 180 -path (Join-Path $root "icon-180.png") -square $true -inset 0.08
New-Icon -size 32  -path (Join-Path $root "favicon-32.png") -square $false -inset 0.0

Write-Host "Icons generated in $root"
