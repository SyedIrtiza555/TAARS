@echo off
rem Writes the quick-tunnel URL to a file, then keeps cloudflared running.
set LOG=%TEMP%\taars-tunnel-boot.log
cloudflared tunnel --url http://127.0.0.1:8787 > "%LOG%" 2>&1 & powershell -NoProfile -Command "for($i=0;$i-lt60;$i++){ $m=Select-String -Path '%LOG%' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -EA SilentlyContinue | Select -First 1; if($m){ $m.Matches[0].Value | Set-Content \"$env:USERPROFILE\taars-tunnel-url.txt\"; break }; Start-Sleep 2 }"
