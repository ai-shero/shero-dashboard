# Shero Dashboard - Lazada gross-sales correction.
#
# Runs each morning (06:00) when Lazada is freshest (no rapid access yet), and
# overwrites the realtime-frozen Lazada gross_sales with the date-accurate
# BA overviewV2 payAmount. Spaced per-day (LZ_DELAY_MS) to avoid Lazada throttling.
#
# Backfills June 1 -> yesterday by default. Idempotent (safe to re-run daily);
# once the range is confirmed correct you can disable/remove this task.

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

function Test-Cdp {
  try { Invoke-WebRequest -Uri "http://localhost:9222/json/version" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop | Out-Null; return $true }
  catch { return $false }
}

if (-not (Test-Cdp)) {
  Write-Log "Chrome CDP not running - launching..."
  & (Join-Path $scrapers "launch-chrome.ps1")
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) { if (Test-Cdp) { $ready = $true; break }; Start-Sleep -Seconds 1 }
  if (-not $ready) { Write-Log "ERROR: Chrome CDP not ready after 60s. Aborting."; exit 1 }
}

Set-Location $root
$env:LZ_DELAY_MS = "8000"
Write-Log "Running lazada-gross-backfill.js (June 1 -> yesterday)..."
& node scrapers/lazada-gross-backfill.js 2026-06-01 *>> $logFile
$code = $LASTEXITCODE
Write-Log "Finished (exit $code)."
exit $code
