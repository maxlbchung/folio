$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$config = Get-Content -Raw "src-tauri/tauri.conf.json" | ConvertFrom-Json
$version = $config.version
$portableZip = "Inktile_${version}_windows_x64_portable.zip"

& npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw "Project checks failed." }

& npm.cmd run tauri -- build
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed." }

$releaseExe = "src-tauri/target/release/inktile.exe"
Copy-Item -LiteralPath $releaseExe -Destination "Inktile.exe" -Force

# The portable zip must ship the Inkjet broker beside the exe: at runtime the
# app spawns agent/broker.mjs from disk next to Inktile.exe (find_broker_script
# in src-tauri/src/lib.rs), so without the agent/ folder the AI panel cannot
# start. The broker is dependency-free plain Node — nothing to build, just the
# source files. Stage the exe and a clean copy of agent/ (minus the
# runtime-generated .*-workspace scratch dirs) so the zip unpacks as
# Inktile.exe + agent/ side by side.
$stage = Join-Path $env:TEMP "inktile-portable-$version"
if (Test-Path -LiteralPath $stage) { Remove-Item -Recurse -Force -LiteralPath $stage }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath "Inktile.exe" -Destination $stage
Copy-Item -LiteralPath "agent" -Destination $stage -Recurse
Get-ChildItem -LiteralPath (Join-Path $stage "agent") -Directory -Force |
  Where-Object { $_.Name -like "*-workspace" } |
  Remove-Item -Recurse -Force
Compress-Archive -Path (Join-Path $stage "Inktile.exe"), (Join-Path $stage "agent") -DestinationPath $portableZip -Force
Remove-Item -Recurse -Force -LiteralPath $stage

$artifacts = @(
  "Inktile.exe",
  $portableZip,
  "src-tauri/target/release/bundle/msi/Inktile_${version}_x64_en-US.msi",
  "src-tauri/target/release/bundle/nsis/Inktile_${version}_x64-setup.exe"
)

$missing = $artifacts | Where-Object { -not (Test-Path -LiteralPath $_) }
if ($missing) { throw "Missing release artifacts: $($missing -join ', ')" }

Get-FileHash -Algorithm SHA256 -LiteralPath $artifacts | Select-Object Path, Hash
