<#
  GrantFlow - Windows npm EPERM repair

  Purpose:
    Recover from common Windows file-lock issues where `npm ci` fails trying to unlink
    native binaries (notably esbuild.exe).

  Policy:
    - Does NOT skip installs or bypass security checks beyond disabling audit/fund noise.
    - Does NOT modify lockfiles.
    - Operates only on local working tree (node_modules).
#>

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg"
}

Write-Step "Stopping common processes that can lock node_modules binaries"
Get-Process node, esbuild -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Step "Removing node_modules (best-effort)"
if (Test-Path ".\\node_modules") {
  for ($i = 1; $i -le 3; $i++) {
    try {
      Remove-Item -Recurse -Force ".\\node_modules"
      break
    } catch {
      if ($i -eq 3) { throw }
      Start-Sleep -Milliseconds 600
    }
  }
}

Write-Step "Running npm install (resilient on Windows)"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Step "Attempting npm ci (fully clean/reproducible). If this fails, continue using npm install."
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "npm ci failed. This is usually due to a remaining file lock."
  Write-Host "You can proceed using the npm install result, or reboot and re-run npm ci."
  exit $LASTEXITCODE
}

Write-Step "Done"

