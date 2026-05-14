# SHERO Dashboard — daily scrape (Shopify + Shopee)
# Runs at 12:30am MYT via Windows Task Scheduler.
# Logs to scrapers\logs\scrape-YYYY-MM-DD.log

$projectRoot = "C:\Users\Sher Min\Documents\Claude\shero-dashboard"
$logDir      = Join-Path $projectRoot "scrapers\logs"
$date        = Get-Date -Format "yyyy-MM-dd"
$logFile     = Join-Path $logDir "scrape-$date.log"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting daily scrape" | Out-File $logFile -Encoding utf8

try {
    $result = & node "$projectRoot\scrapers\run.js" 2>&1
    $result | Out-File $logFile -Append -Encoding utf8
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Done." | Out-File $logFile -Append -Encoding utf8
} catch {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERROR: $_" | Out-File $logFile -Append -Encoding utf8
}

# Keep only last 30 log files
Get-ChildItem $logDir -Filter "scrape-*.log" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 30 |
    Remove-Item -Force
