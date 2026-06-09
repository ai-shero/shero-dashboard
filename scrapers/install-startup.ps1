# Shero Dashboard — Register Windows scheduled task(s).
#
# Run this ONCE in an ELEVATED PowerShell (Administrator). Registering/removing
# tasks that were previously created elevated requires admin.
#
# As of the Playwright self-launch refactor, there is only ONE task:
#   "SHERO Dashboard - Daily Scrape" — runs the self-healing scraper nightly at
#   00:30, and catches up if a scheduled start was missed (PC asleep / off).
#
# The old "Shero Dashboard - Chrome CDP" task (which launched a separate Chrome
# for remote debugging on port 9222) is GONE — the scraper now launches its own
# Chrome via Playwright (scrapers/cdp.js). This script removes that task if it
# still exists; leaving it would lock the scraper's Chrome profile and break the
# nightly scrape.

$ErrorActionPreference = "Stop"

# ── Remove the obsolete Chrome CDP task if present ───────────────────────────
$chromeTask = "Shero Dashboard - Chrome CDP"
if (Get-ScheduledTask -TaskName $chromeTask -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $chromeTask -Confirm:$false
  Write-Host "[Setup] Removed obsolete task '$chromeTask'."
}

# Task runs as the current user in the INTERACTIVE session: Playwright launches a
# headed Chrome that needs the logged-in desktop to render.
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

# ── Daily self-healing scrape at 00:30 ───────────────────────────────────────
$scrapeScript = Join-Path $PSScriptRoot "run-daily.ps1"
$scrapeTask   = "SHERO Dashboard - Daily Scrape"

$scrapeAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scrapeScript`""

# 00:30 local time (machine is on MYT). Day just ended → scrape yesterday + trailing.
$scrapeTrigger = New-ScheduledTaskTrigger -Daily -At "12:30AM"

# StartWhenAvailable = run as soon as possible after a MISSED start (sleep/off).
$scrapeSettings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
  -TaskName $scrapeTask `
  -Action $scrapeAction `
  -Trigger $scrapeTrigger `
  -Settings $scrapeSettings `
  -Principal $principal `
  -Force | Out-Null
Write-Host "[Setup] Registered '$scrapeTask' (nightly 00:30, catches up if missed)."

Write-Host ""
Write-Host "[Setup] Done."
Write-Host ""
Write-Host "Verify:    Get-ScheduledTask -TaskName 'SHERO Dashboard*'"
Write-Host "Run now:   Start-ScheduledTask -TaskName '$scrapeTask'"
Write-Host "Re-login:  npm run login"
