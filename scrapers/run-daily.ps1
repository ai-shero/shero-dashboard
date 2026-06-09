# Shero Dashboard - Nightly scrape wrapper.
#
# Run by the "SHERO Dashboard - Daily Scrape" Windows scheduled task.
# Runs the self-healing scraper (node scrapers/run.js with no args). The scraper
# now self-launches its own Chrome via Playwright (scrapers/cdp.js), so there is
# NO separate Chrome launch or CDP port (9222) dependency here anymore — that was
# the cause of the Jun 4-8 gap.
#
# All output is appended to scrapers/logs/daily-scrape.log with timestamps.

$scrapers = $PSScriptRoot
$root     = Split-Path $scrapers -Parent
$logDir   = Join-Path $scrapers "logs"
$logFile  = Join-Path $logDir "daily-scrape.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts  $msg" | Tee-Object -FilePath $logFile -Append
}

Write-Log "===== Daily scrape starting ====="

Set-Location $root
Write-Log "Running node scrapers/run.js (self-healing, self-launching Chrome)..."
& node scrapers/run.js *>> $logFile
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Log "Scrape finished OK (exit 0)."
} else {
  Write-Log "ERROR: Scrape FAILED (exit $code). Check the log above. If logins expired, run: node scrapers/login.js"
}
exit $code
