# Requires: cloudflared installed (winget install --id Cloudflare.cloudflared -e)
# Starts the manager server if it is not already running, then opens a free
# HTTPS Cloudflare quick tunnel to it and prints the public URL.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 1. Manager server (already running? skip)
$listen = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
    Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\taars-server.log" -RedirectStandardError "$env:TEMP\taars-server-err.log"
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { break }
    }
    if (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)) {
        throw 'Server did not start within 30s. Check %TEMP%\taars-server-err.log'
    }
    Write-Host '[ok] manager server started on http://127.0.0.1:8787'
} else {
    Write-Host '[ok] manager server already running on 8787'
}

# 2. Quick tunnel
$log = "$env:TEMP\taars-tunnel.log"
Remove-Item $log -ErrorAction SilentlyContinue
Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:8787' -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError "$env:TEMP\taars-tunnel-err.log"

$url = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $log) {
        $hit = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
        if ($hit) { $url = $hit.Matches[0].Value; break }
    }
}
if ($url) {
    Set-Content -Path "$env:USERPROFILE\taars-tunnel-url.txt" -Value $url
    Write-Host ''
    Write-Host '============================================='
    Write-Host "  Public HTTPS URL:  $url"
    Write-Host '============================================='
    Write-Host 'Admin password: your ADMIN_PASSWORD from the .env file'
    Write-Host 'URL is saved to %USERPROFILE%\taars-tunnel-url.txt'
} else {
    Write-Host '[!] Tunnel URL not found yet. Check %TEMP%\taars-tunnel.log'
}
