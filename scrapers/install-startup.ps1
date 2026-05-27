# Shero Dashboard — Register Chrome CDP launch as a Windows startup task.
# Run this script ONCE (as Administrator is NOT required — runs at user logon).
#
# After running: Chrome will auto-launch on every Windows login with
# remote debugging enabled, ready for the midnight scraper.

$scriptPath = Join-Path $PSScriptRoot "launch-chrome.ps1"
$taskName   = "Shero Dashboard - Chrome CDP"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

# Trigger: at user logon, with a 10-second delay to let the desktop settle
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT10S"

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 1)

# Check if task already exists
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($existing) {
  Write-Host "[Setup] Updating existing task '$taskName'..."
  Set-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
} else {
  Write-Host "[Setup] Registering startup task '$taskName'..."
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Force | Out-Null
}

Write-Host ""
Write-Host "[Setup] Done! Chrome will now auto-launch on every login."
Write-Host "[Setup] Task name: $taskName"
Write-Host ""
Write-Host "To remove this task later:"
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
