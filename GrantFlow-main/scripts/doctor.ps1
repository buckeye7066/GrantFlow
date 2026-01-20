param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

Push-Location $RepoRoot
try {
  node "scripts/doctor.mjs"
  exit $LASTEXITCODE
} finally {
  Pop-Location
}

