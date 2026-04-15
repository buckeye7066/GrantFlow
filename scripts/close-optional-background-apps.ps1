# Stops common optional background apps (not Windows/Cursor). Safe to re-run.
$ErrorActionPreference = 'SilentlyContinue'
$names = @(
  'Docker Desktop', 'com.docker.backend', 'DockerCli', 'vpnkit',
  'Teams', 'ms-teams',
  'Slack', 'Discord', 'Spotify', 'Zoom',
  'OneDrive', 'GoogleDriveFS',
  'EpicGamesLauncher', 'Steam'
)
$stopped = New-Object System.Collections.ArrayList
foreach ($n in $names) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      Stop-Process -Id $_.Id -Force -ErrorAction Stop
      [void]$stopped.Add("$n (PID $($_.Id))")
    } catch {}
  }
}
if ($stopped.Count -eq 0) {
  Write-Output 'No matching optional processes were running.'
} else {
  Write-Output 'Stopped:'
  $stopped | ForEach-Object { Write-Output "  $_" }
}
Write-Output ''
Write-Output 'Also check: system tray (hidden icons), Chrome/Edge tabs, and Task Manager for other heavy apps.'
