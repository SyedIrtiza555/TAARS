# Runs at logon: boots (if needed) the hosted instance + quick tunnel.
# URL of the day is written to %USERPROFILE%\taars-tunnel-url.txt
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Irtiza\Documents\Projects\WhatsApp-Agent\deploy\start-host.ps1"
