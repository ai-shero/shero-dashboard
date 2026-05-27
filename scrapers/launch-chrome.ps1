# Shero Dashboard — Launch Chrome with CDP remote debugging.
#
# Run this once at startup (or it runs automatically via Task Scheduler).
# Keep Chrome open — do NOT close it.
# The midnight scraper attaches to this running window every night.
#
# First-time setup after launching:
#   1. Log in to Shopify   → admin.shopify.com/store/shero-cosmetics-my/analytics
#   2. Log in to Shopee    → seller.shopee.com.my
#   3. Log in to Lazada    → sellercenter.lazada.com.my
#   Then minimise Chrome. Sessions stay alive as long as Chrome is open.

$profileDir = Join-Path $PSScriptRoot "profiles\chrome-cdp"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

# Find Chrome executable
$chromePaths = @(
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  Write-Error "Google Chrome not found. Install it from https://www.google.com/chrome/"
  exit 1
}

# Check if already running on port 9222
try {
  $test = Invoke-WebRequest -Uri "http://localhost:9222/json/version" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
  Write-Host "[CDP] Chrome is already running on port 9222. Nothing to do."
  exit 0
} catch {
  # Not running — proceed to launch
}

Write-Host "[CDP] Starting Chrome with remote debugging on port 9222..."
Write-Host "[CDP] Profile: $profileDir"
Write-Host ""
Write-Host "First time? Log in to:"
Write-Host "  Shopify  -> https://admin.shopify.com/store/shero-cosmetics-my/analytics"
Write-Host "  Shopee   -> https://seller.shopee.com.my"
Write-Host "  Lazada   -> https://sellercenter.lazada.com.my"
Write-Host ""
Write-Host "Once logged in, minimise Chrome. Do NOT close it."

$argList = @(
  "--remote-debugging-port=9222",
  "--user-data-dir=`"$profileDir`"",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--disable-background-networking=false"
) -join " "

Start-Process -FilePath $chrome -ArgumentList $argList
