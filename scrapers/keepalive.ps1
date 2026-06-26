# Shero Dashboard - Lazada session keepalive.
#
# Run by the "Shero Dashboard - Lazada Keepalive" task (every 45 min). Lazada
# seller sessions are ~1-hour rolling tokens (t_sid / EGG_SESS), so a once-a-day
# scrape can't keep them alive. This touches a light Lazada page to roll the
# session forward, so it is still logged in at the 00:30 nightly.
#
# The scraper self-launches its own Chrome via Playwright (scrapers/cdp.js), so
# there is NO Chrome launch or CDP-port dependency here (mirrors run-daily.ps1).
# If a real scrape is running, the profile is locked and keepalive.js skips the
# cycle (exit 0) - no collision with the nightly or the 06:00 backstop.

$scrapers = $PSScriptRoot
$root     = Split-Path $scrapers -Parent
$logDir   = Join-Path $scrapers "logs"
$logFile  = Join-Path $logDir "keepalive.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts  $msg" | Tee-Object -FilePath $logFile -Append
}

Set-Location $root
& node scrapers/keepalive.js *>> $logFile
$code = $LASTEXITCODE

if ($code -eq 2) {
  Write-Log "WARNING: Lazada logged out. Re-arm with: node scrapers/login.js"
} elseif ($code -ne 0) {
  Write-Log "ERROR: keepalive exit $code."
}
exit $code
