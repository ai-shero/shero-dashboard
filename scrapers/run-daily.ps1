# Shero Dashboard - Nightly scrape wrapper.
#
# Run by the "Shero Dashboard - Daily Scrape" Windows scheduled task.
#   1. Ensures the CDP Chrome is running (launches it if not).
#   2. Waits for CDP port 9222 to be ready.
#   3. Runs the self-healing scraper (node scrapers/run.js with no args).
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

function Test-Cdp {
  try {
    Invoke-WebRequest -Uri "http://localhost:9222/json/version" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

Write-Log "===== Daily scrape starting ====="

if (Test-Cdp) {
  Write-Log "Chrome CDP already running."
} else {
  Write-Log "Chrome CDP not running - launching..."
  & (Join-Path $scrapers "launch-chrome.ps1") | Out-Null

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Cdp) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if ($ready) {
    Write-Log "Chrome CDP is up."
  } else {
    Write-Log "ERROR: Chrome CDP did not become ready after 30s. Aborting scrape."
    exit 1
  }
}

Set-Location $root
Write-Log "Running node scrapers/run.js (self-healing)..."
& node scrapers/run.js *>> $logFile
$code = $LASTEXITCODE
Write-Log "Scrape finished (exit $code)."
exit $code
