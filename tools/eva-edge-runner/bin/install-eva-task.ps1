[CmdletBinding()]
param(
  [string]$TaskName = 'EVA Portfolio QA',
  [datetime]$At = '4:00 AM'
)

$ErrorActionPreference = 'Stop'
$stableRoot = Join-Path $env:LOCALAPPDATA 'GrantFlow\EVA'
$ownedMarker = Join-Path $stableRoot '.eva-runner-owned'
$ownedMarkerValue = 'Owned exclusively by GrantFlow EVA. Safe target for the EVA bootstrap checkout.'
$installedBootstrap = Join-Path $stableRoot 'eva-bootstrap.ps1'
$installCandidate = Join-Path $stableRoot 'eva-bootstrap.install.ps1'
$sourceBootstrap = Join-Path $PSScriptRoot 'eva-bootstrap.ps1'
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $powerShellExe -PathType Leaf)) {
  throw "Windows PowerShell was not found at the trusted system path: $powerShellExe"
}

if (Test-Path -LiteralPath $stableRoot) {
  $stableRootItem = Get-Item -LiteralPath $stableRoot -Force
  if (($stableRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to install through a reparse point: $stableRoot"
  }
  if (-not (Test-Path -LiteralPath $ownedMarker -PathType Leaf) -and
      @(Get-ChildItem -LiteralPath $stableRoot -Force).Count -gt 0) {
    throw "Refusing to adopt a non-empty directory not already owned by EVA: $stableRoot"
  }
} else {
  New-Item -ItemType Directory -Force -Path $stableRoot | Out-Null
}
if (-not (Test-Path -LiteralPath $ownedMarker)) {
  Set-Content -LiteralPath $ownedMarker -Value $ownedMarkerValue
} elseif ((Get-Content -LiteralPath $ownedMarker -Raw).Trim() -ne $ownedMarkerValue) {
  throw "EVA ownership marker is invalid: $ownedMarker"
}
Copy-Item -LiteralPath $sourceBootstrap -Destination $installCandidate -Force

# Prepare the dedicated checkout and dependency set before replacing the task;
# a failed install therefore leaves the previous task untouched.
& $powerShellExe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installCandidate -PrepareOnly
if ($LASTEXITCODE -ne 0) { throw "EVA bootstrap preparation failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $installedBootstrap -PathType Leaf)) {
  throw 'EVA bootstrap validation succeeded but did not install the versioned bootstrap.'
}
Remove-Item -LiteralPath $installCandidate -Force

$quotedBootstrap = '"' + $installedBootstrap + '"'
$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedBootstrap" -WorkingDirectory $stableRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Installed '$TaskName'. It now updates and runs a dedicated clean origin/main checkout at $stableRoot."
