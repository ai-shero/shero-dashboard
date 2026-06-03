# Shero Dashboard — Register Windows scheduled tasks.
# Run this script ONCE (Administrator NOT required — tasks run as the current user).
#
# Registers TWO tasks:
#   1. "Shero Dashboard - Chrome CDP"   — launches Chrome with remote debugging at logon.
#   2. "Shero Dashboard - Daily Scrape" — runs the self-healing scraper nightly at 00:30,
#                                          and catches up if a scheduled start was missed
#                                          (PC asleep / powered off through midnight).
#
# Together these make data collection survive reboots, sleep, and missed nights:
# the scrape task ensures Chrome is up, then run.js backfills any gap automatically.

$ErrorActionPreference = "Stop"

# Both tasks run as the current user, in the INTERACTIVE session — the scraper
# attaches to the CDP Chrome that lives in your logged-in desktop, so the task
# must share that session (not run headless in session 0).
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

# ── Task 1: Chrome CDP at logon ──────────────────────────────────────────────
$chromeScript = Join-Path $PSScriptRoot "launch-chrome.ps1"
$chromeTask   = "Shero Dashboard - Chrome CDP"

$chromeAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$chromeScript`""

$chromeTrigger = New-ScheduledTaskTrigger -AtLogOn
$chromeTrigger.Delay = "PT10S"

$chromeSettings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $chromeTask `
  -Action $chromeAction `
  -Trigger $chromeTrigger `
  -Settings $chromeSettings `
  -Principal $principal `
  -Force | Out-Null
Write-Host "[Setup] Registered '$chromeTask' (Chrome auto-launch at logon)."

# ── Task 2: Daily self-healing scrape at 00:30 ───────────────────────────────
$scrapeScript = Join-Path $PSScriptRoot "run-daily.ps1"
$scrapeTask   = "Shero Dashboard - Daily Scrape"

$scrapeAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scrapeScript`""

# 00:30 local time (machine is on MYT). Day just ended → scrape yesterday + trailing.
$scrapeTrigger = New-ScheduledTaskTrigger -Daily -At "12:30AM"

# StartWhenAvailable = run as soon as possible after a MISSED start (sleep/off).
# This is the key resilience flag — a missed midnight is auto-recovered.
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
Write-Host "[Setup] Done. Both tasks installed."
Write-Host ""
Write-Host "Verify:    Get-ScheduledTask -TaskName 'Shero Dashboard*'"
Write-Host "Run now:   Start-ScheduledTask -TaskName '$scrapeTask'"
Write-Host "Remove:    Unregister-ScheduledTask -TaskName '$chromeTask','$scrapeTask' -Confirm:`$false"
