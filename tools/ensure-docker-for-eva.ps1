# Ensure the Docker daemon is up before EVA's 04:00 portfolio run.
#
# WHY THIS EXISTS
# family-stewardship-navigator's whole stack IS its compose stack, so its only
# declared prerequisite is a live Docker daemon. EVA reported it BLOCKED with the
# remedy "leave Docker Desktop running overnight, or set it to start at login" -
# but measured 2026-08-03, "start at login" was ALREADY satisfied: Docker Desktop
# sits in HKCU\...\CurrentVersion\Run and settings-store.json carries
# AutoStart=True. It still was not running at 04:00 because Docker's own backend
# log shows the previous instance's last activity at 2026-08-02 16:40 EDT - it
# was quit during the day, and no logon event happened before the 04:00 slot.
# A login-scoped remedy cannot cover "quit yesterday afternoon"; only a
# time-scoped one can.
#
# It is idempotent and non-destructive: if the daemon already answers it does
# NOTHING (it never restarts a healthy daemon, never touches containers, and
# never stops anything).
#
# ASCII ONLY, deliberately: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so a UTF-8 em dash arrives as three bytes ending in a double quote and silently
# terminates the enclosing string - the script then runs its own source as
# commands. Do not reintroduce smart punctuation here.
[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 900,
  [string]$DockerDesktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
)

function Test-DockerDaemon {
  try {
    $v = & docker info --format '{{.ServerVersion}}' 2>$null
    return -not [string]::IsNullOrWhiteSpace($v)
  } catch {
    return $false
  }
}

function Write-Stamped([string]$Message) {
  Write-Output ((Get-Date).ToString('s') + ' ' + $Message)
}

if (Test-DockerDaemon) {
  Write-Stamped 'docker daemon already up - nothing to do'
  exit 0
}

if (-not (Test-Path -LiteralPath $DockerDesktop)) {
  Write-Stamped ('Docker Desktop not installed at ' + $DockerDesktop + ' - cannot start it')
  exit 1
}

Write-Stamped 'docker daemon not answering; starting Docker Desktop'
Start-Process -FilePath $DockerDesktop -ArgumentList '-Autostart' -WindowStyle Minimized | Out-Null

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 10
  if (Test-DockerDaemon) {
    Write-Stamped 'docker daemon is up'
    exit 0
  }
}

# An honest failure: EVA then reports family-stewardship-navigator BLOCKED with
# the daemon named, which is the correct outcome - never a silent pass.
Write-Stamped ('docker daemon did not come up within ' + $TimeoutSeconds + 's')
exit 1
