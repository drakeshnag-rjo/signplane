# build-release.ps1 — assemble the Signplane release bundle.
# Output: dist\signplane-<version>.zip + .sha256, with per-file CHECKSUMS.txt inside.

param([string]$Version = "1.0.0")

$root = $PSScriptRoot
$name = "signplane-$Version"
$staging = Join-Path $root "dist\$name"

if (Test-Path (Join-Path $root "dist")) { Remove-Item -Recurse -Force (Join-Path $root "dist") -Confirm:$false }
New-Item -ItemType Directory -Force $staging | Out-Null

# --- contents ---
Copy-Item (Join-Path $root "server.js")     $staging
Copy-Item (Join-Path $root "executor.py")   $staging
Copy-Item (Join-Path $root "policies.json") $staging
Copy-Item (Join-Path $root "demo-agent-aws.js")       $staging
Copy-Item (Join-Path $root "demo-agent-scheduled.js") $staging
Copy-Item -Recurse (Join-Path $root "lib")      (Join-Path $staging "lib")
Copy-Item -Recurse (Join-Path $root "public")   (Join-Path $staging "public")
Copy-Item -Recurse (Join-Path $root "examples") (Join-Path $staging "examples")

New-Item -ItemType Directory -Force (Join-Path $staging "docs") | Out-Null
foreach ($d in "INSTALL.md", "pilot-runbook.md", "install-phase0.md", "connecting-agents.md") {
    Copy-Item (Join-Path $root "docs\$d") (Join-Path $staging "docs")
}
# the client guide doubles as the bundle's front door
Copy-Item (Join-Path $root "docs\INSTALL.md") (Join-Path $staging "INSTALL.md")

Set-Content -Encoding utf8 (Join-Path $staging "VERSION") "signplane $Version`nbuilt $(Get-Date -Format o)"

# --- per-file checksums (relative paths, forward slashes) ---
$lines = Get-ChildItem -Recurse -File $staging | Where-Object { $_.Name -ne "CHECKSUMS.txt" } | ForEach-Object {
    $rel = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
    "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $rel
}
Set-Content -Encoding utf8 (Join-Path $staging "CHECKSUMS.txt") ($lines -join "`n")

# --- zip + bundle hash ---
$zip = Join-Path $root "dist\$name.zip"
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Set-Content -Encoding utf8 "$zip.sha256" "$hash  $name.zip"

Write-Host "Built $zip"
Write-Host "SHA-256: $hash"
Write-Host ("Files: {0} · Size: {1:N0} KB" -f $lines.Count, ((Get-Item $zip).Length / 1KB))
