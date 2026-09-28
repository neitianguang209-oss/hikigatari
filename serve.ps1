# 最小の静的ファイルサーバ（ビルド不要・依存なし）
# 使い方:  powershell -ExecutionPolicy Bypass -File serve.ps1
# ブラウザで http://localhost:<PORT> を開く
# 同じWi-Fi内のスマホからは http://<このPCのLAN IP>:<PORT> でアクセス可能（管理者権限で起動した場合のみ）
#
# ↓↓↓ プロジェクトごとに、他のプロジェクトと被らない番号に変更すること（~/.claude/launch.json を確認）
$port = 5507
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown'
} | Select-Object -First 1 -ExpandProperty IPAddress)

$mime = @{
  ".html"="text/html; charset=utf-8"; ".css"="text/css; charset=utf-8";
  ".js"="text/javascript; charset=utf-8"; ".mjs"="text/javascript; charset=utf-8";
  ".json"="application/json; charset=utf-8";
  ".webmanifest"="application/manifest+json; charset=utf-8";
  ".png"="image/png"; ".svg"="image/svg+xml"; ".ico"="image/x-icon";
  ".jpg"="image/jpeg"; ".jpeg"="image/jpeg"
}

$lanBound = $false
$listener = New-Object System.Net.HttpListener
if ($lanIp) {
  $listener.Prefixes.Add("http://localhost:$port/")
  $listener.Prefixes.Add("http://${lanIp}:$port/")
  try {
    $listener.Start()
    $lanBound = $true
  } catch {
    # LAN IPでのバインドには管理者権限 or URL ACL登録が必要。
    # 無ければ localhost のみで起動し直す（スマホからは繋がらない）。
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$port/")
    $listener.Start()
    Write-Host "注意: スマホからのアクセス用バインドに失敗しました（管理者権限が必要です）。localhostのみで起動します。"
    Write-Host "スマホから使うには、このスクリプトを『管理者として実行』したPowerShellで動かしてください。"
  }
} else {
  $listener.Prefixes.Add("http://localhost:$port/")
  $listener.Start()
}

Write-Host "Serving $root at http://localhost:$port/"
if ($lanBound) { Write-Host "スマホから(同じWi-Fi内): http://${lanIp}:$port/" }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    # keep-alive接続の使い回しで稀にレスポンスが壊れることがあるため無効化
    $ctx.Response.KeepAlive = $false

    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq "/") { $path = "/index.html" }
    $file = Join-Path $root ($path.TrimStart("/"))

    if (-not (Test-Path $file -PathType Leaf)) {
      $file = Join-Path $root "index.html"
    }

    if (Test-Path $file -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $ct = $mime[$ext]; if (-not $ct) { $ct = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ctx.Response.ContentType = $ct
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
      $ctx.Response.ContentLength64 = $msg.Length
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch {
    # 1件のリクエスト処理で失敗してもサーバー全体は落とさない
    Write-Host "リクエスト処理でエラー: $_"
  } finally {
    try { $ctx.Response.OutputStream.Close() } catch {}
  }
}
