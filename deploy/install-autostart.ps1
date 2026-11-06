# Run once (per machine). Sets up 24/7 hosting on this PC:
#   - Task Scheduler: manager server + tunnel start at logon
#   - Power settings: never sleep on AC (PC hosting needs the PC always on)
# Run from an elevated PowerShell:  Set-ExecutionPolicy -Scope Process Bypass; .\install-autostart.ps1

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

# never sleep / hibernate on AC
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host '[ok] PC will not sleep on AC power'

# Task 1: server at logon
$act1 = New-ScheduledTaskAction -Execute $node -Argument 'dist\index.js' -WorkingDirectory $root
$trig = New-ScheduledTaskTrigger -AtLogOn
$set  = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'TAARS-Server' -Action $act1 -Trigger $trig -Settings $set -Force | Out-Null
Write-Host '[ok] scheduled task TAARS-Server (runs at logon)'

# Task 2: cloudflared at logon (quick tunnel; URL changes per boot, saved to %USERPROFILE%\taars-tunnel-url.txt)
$runner = Join-Path $PSScriptRoot 'tunnel-run.cmd'
$act2 = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $root
Register-ScheduledTask -TaskName 'TAARS-Tunnel' -Action $act2 -Trigger $trig -Settings $set -Force | Out-Null
Write-Host '[ok] scheduled task TAARS-Tunnel (runs at logon)'

Write-Host 'Tip: for a URL that never changes, see HOSTING.md -> "Stable domain path".'
