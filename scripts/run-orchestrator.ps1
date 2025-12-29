param(
    [string]$BridgeHost = "0.0.0.0",
    [int]$BridgePort = 8765,
    [string]$MemoryDir = "",
    [string]$MailboxPollInterval = "0.5",
    [string]$AllowedActions = "",
    [string]$AdditionalArgs = ""
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$orchestratorDir = (Resolve-Path (Join-Path $scriptDir "..\agent-orchestra")).Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path

Write-Host "[Orchestrator] Working directory: $orchestratorDir"
Write-Host "[Orchestrator] Project root: $projectRoot"

$env:GRANTFLOW_PROJECT_ROOT = $projectRoot
Set-Location $orchestratorDir

$python = if ($env:PYTHON) { $env:PYTHON } else { "python" }

if (-not $MemoryDir -or $MemoryDir.Trim() -eq "") {
    $MemoryDir = Join-Path $orchestratorDir "memory"
}
if (-not (Test-Path $MemoryDir)) {
    New-Item -ItemType Directory -Force -Path $MemoryDir | Out-Null
}
$MemoryDir = [System.IO.Path]::GetFullPath($MemoryDir)

$actionsPath = $AllowedActions
if (-not $actionsPath -or $actionsPath.Trim() -eq "") {
    $actionsPath = Join-Path $orchestratorDir "config\allowed_actions.json"
}
$actionsPath = [System.IO.Path]::GetFullPath($actionsPath)

$args = @(
    "main.py",
    "--bridge-host", $BridgeHost,
    "--bridge-port", $BridgePort,
    "--memory-dir", $MemoryDir,
    "--allowed-actions", $actionsPath,
    "--mailbox-poll-interval", $MailboxPollInterval
)

if ($AdditionalArgs -ne "") {
    $args += $AdditionalArgs.Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)
}

Write-Host "[Orchestrator] Starting: $python $($args -join ' ')"
& $python @args

