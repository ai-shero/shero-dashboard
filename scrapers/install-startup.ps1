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

# ── Task 1: Chrome CDP — ensure it's up ──────────────────────────────────────
# launch-chrome.ps1 is idempotent (exits immediately if 9222 is already up).
# Triggers: at logon AND daily at 00:20 (10 min before the scrape). The daily
# time trigger is the workhorse — an always-on machine that stays logged in
# never fires a logon event, which is why the logon-only task never ran.
$chromeScript = Join-Path $PSScriptRoot "launch-chrome.ps1"
$chromeTask   = "Shero Dashboard - Chrome CDP"

$chromeAction = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$chromeScript`""

$chromeTrigLogon = New-ScheduledTaskTrigger -AtLogOn
$chromeTrigLogon.Delay = "PT10S"
$chromeTrigDaily = New-ScheduledTaskTrigger -Daily -At "12:20AM"

$chromeSettings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $chromeTask `
  -Action $chromeAction `
  -Trigger @($chromeTrigLogon, $chromeTrigDaily) `
  -Settings $chromeSettings `
  -Principal $principal `
  -Force | Out-Null
Write-Host "[Setup] Registered '$chromeTask' (Chrome up at logon + daily 00:20)."

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
