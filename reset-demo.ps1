# reset-demo.ps1 — one-click clean slate before a customer demo.
# Stops Signplane + the AWS emulator, wipes demo data, restarts both
# in their own windows, and opens the dashboard.

Write-Host "Resetting Signplane demo environment..." -ForegroundColor Cyan

foreach ($port in 4820, 5000) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $conn | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
            Write-Host "  stopping process $_ on port $port"
            try { Stop-Process -Id $_ -Force -Confirm:$false -ErrorAction Stop } catch {}
        }
        Start-Sleep -Milliseconds 500
    }
}

if (Test-Path "$PSScriptRoot\data") {
    Remove-Item -Recurse -Force "$PSScriptRoot\data" -Confirm:$false
    Write-Host "  cleared data\ (agents, intents, evidence ledger)"
}

Write-Host "Starting AWS emulator (moto) on :5000..."
Start-Process powershell -ArgumentList '-NoExit', '-Command', "python -m moto.server -p 5000"

Start-Sleep -Seconds 2

Write-Host "Starting Signplane on :4820..."
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$PSScriptRoot'; node server.js"

Start-Sleep -Seconds 2
Start-Process "http://localhost:4820"

Write-Host "Ready. Dashboard is open, mode is OBSERVE, ledger is empty." -ForegroundColor Green
