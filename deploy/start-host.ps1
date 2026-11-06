# Boots the hosted (fresh) instance of the Agent Manager and exposes it through
# a free Cloudflare quick tunnel.
#
# First visit to the printed URL asks you to create the admin password —
# no plaintext secrets are ever written to any file by hand.
#
# Requires: cloudflared (winget install --id Cloudflare.cloudflared -e)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'data-hosted\hosted.env'
$port = 8788

# 1. Fresh instance env file (copy template once)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $envFile) | Out-Null
if (-not (Test-Path $envFile)) {
    $example = Join-Path $PSScriptRoot 'hosted.env.example'
    if (-not (Test-Path $example)) { throw 'deploy/hosted.env.example is missing.' }
    $content = Get-Content $example -Raw
    $content = $content -replace '(?m)^#.*\r?\n', ''
    Set-Content -Path $envFile -Value $content -Encoding ASCII
    Write-Host "[ok] created $envFile (no secrets inside — they are set in the browser/DB)"
}

# 2. Server: start if not already running
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
    $env:ENV_FILE = $envFile
    Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\taars-hosted.log" -RedirectStandardError "$env:TEMP\taars-hosted-err.log"
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 1
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { break }
    }
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        throw "Hosted instance did not start within 40s. Check %TEMP%\taars-hosted-err.log"
    }
    Write-Host "[ok] hosted manager instance started on port $port (fresh database)"
} else {
    Write-Host "[ok] hosted manager instance already running on port $port"
}

# 3. Cloudflare quick tunnel
$log = "$env:TEMP\taars-tunnel.log"
Remove-Item $log, "$env:TEMP\taars-tunnel-err.log" -ErrorAction SilentlyContinue
Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel', '--url', "http://127.0.0.1:$port" -WindowStyle Hidden `
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
    Write-Host '================================================='
    Write-Host "  Public HTTPS URL:  $url"
    Write-Host '================================================='
    Write-Host 'First visit: create the admin password in the browser,'
    Write-Host 'then add your OpenRouter key in Settings.'
} else {
    Write-Host '[!] Tunnel URL not found yet. Check %TEMP%\taars-tunnel.log'
}
