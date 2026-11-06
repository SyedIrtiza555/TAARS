# Run once (per machine), from an elevated PowerShell:
#   Set-ExecutionPolicy -Scope Process Bypass; .\install-autostart.ps1
#
# Sets up 24/7 hosting on this PC for the HOSTED instance:
#   - scheduled task that boots server + tunnel at logon (self-healing restarts)
#   - disables sleep/hibernate on AC power
#
# NOTE: this targets the fresh hosted instance on port 8788. It does NOT touch
# the development instance on 8787.

$root = Split-Path -Parent $PSScriptRoot

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host '[ok] PC will not sleep on AC power'

# clean up tasks from earlier revisions
foreach ($old in 'TAARS-Server', 'TAARS-Tunnel') {
    Unregister-ScheduledTask -TaskName $old -Confirm:$false -ErrorAction SilentlyContinue
}

$runner = Join-Path $PSScriptRoot 'tunnel-run.cmd'
$act  = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $root
$trig = New-ScheduledTaskTrigger -AtLogOn
$set  = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'TAARS-Host' -Action $act -Trigger $trig -Settings $set -Force | Out-Null
Write-Host '[ok] scheduled task TAARS-Host (server + tunnel at logon)'

Write-Host 'The public URL changes per reboot (quick tunnel) and is saved to %USERPROFILE%\taars-tunnel-url.txt.'
Write-Host 'For a URL that never changes, see HOSTING.md -> "Stable domain path" or "Zero-PC option".'
