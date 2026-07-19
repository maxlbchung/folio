$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$config = Get-Content -Raw "src-tauri/tauri.conf.json" | ConvertFrom-Json
$version = $config.version
$portableZip = "Folio_${version}_windows_x64_portable.zip"

& npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw "Project checks failed." }

& npm.cmd run tauri -- build
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed." }

$releaseExe = "src-tauri/target/release/folio.exe"
Copy-Item -LiteralPath $releaseExe -Destination "Folio.exe" -Force
Compress-Archive -LiteralPath "Folio.exe" -DestinationPath $portableZip -Force

$artifacts = @(
  "Folio.exe",
  $portableZip,
  "src-tauri/target/release/bundle/msi/Folio_${version}_x64_en-US.msi",
  "src-tauri/target/release/bundle/nsis/Folio_${version}_x64-setup.exe"
)

$missing = $artifacts | Where-Object { -not (Test-Path -LiteralPath $_) }
if ($missing) { throw "Missing release artifacts: $($missing -join ', ')" }

Get-FileHash -Algorithm SHA256 -LiteralPath $artifacts | Select-Object Path, Hash
