# Shero Dashboard - Lazada gross-sales correction.
#
# Run by the "Shero Dashboard - Lazada Gross Fix" task (daily 06:00). Lazada is
# freshest in the morning (no prior access), so its BA metrics aren't throttled.
# Overwrites the realtime-frozen Lazada gross_sales with the date-accurate BA
# overviewV2 payAmount. Spaced per-day (LZ_DELAY_MS) to avoid throttling.
#
# The scraper self-launches its own Chrome via Playwright (scrapers/cdp.js), so
# there is NO Chrome launch or CDP-port dependency here (mirrors run-daily.ps1).
# Idempotent; disable this task once the range is confirmed correct.

$scrapers = $PSScriptRoot
$root     = Split-Path $scrapers -Parent
$logDir   = Join-Path $scrapers "logs"
$logFile  = Join-Path $logDir "lazada-gross.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts  $msg" | Tee-Object -FilePath $logFile -Append
}

Write-Log "===== Lazada gross correction starting ====="

Set-Location $root
$env:LZ_DELAY_MS = "8000"
Write-Log "Running node scrapers/lazada-gross-backfill.js (June 1 -> yesterday)..."
& node scrapers/lazada-gross-backfill.js 2026-06-01 *>> $logFile
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Log "Finished OK (exit 0)."
} else {
  Write-Log "ERROR: exit $code. If Lazada login expired, run: node scrapers/login.js"
}
exit $code
