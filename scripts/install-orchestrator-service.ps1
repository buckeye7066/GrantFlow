<#
.SYNOPSIS
    Install or remove the GrantFlow orchestrator Windows service.

.PARAMETER Action
    "install" (default) installs/updates the service, "remove" deletes it.

.PARAMETER ServiceName
    Internal Windows service name.

.PARAMETER DisplayName
    Friendly name shown in the Services UI.

.PARAMETER BridgeHost
    Host interface that the orchestrator WebSocket bridge should bind to.

.PARAMETER BridgePort
    Port used by the orchestrator WebSocket bridge.

.PARAMETER MemoryDir
    Directory where persistent memory transcripts are stored.

.EXAMPLE
    ./install-orchestrator-service.ps1 -Action install -BridgeHost 0.0.0.0

.EXAMPLE
    ./install-orchestrator-service.ps1 -Action remove
#>

param(
    [ValidateSet("install", "remove")]
    [string]$Action = "install",
    [string]$ServiceName = "GrantFlowOrchestrator",
    [string]$DisplayName = "GrantFlow Orchestrator",
    [string]$BridgeHost = "0.0.0.0",
    [int]$BridgePort = 8765,
    [string]$MemoryDir = "",
    [string]$MailboxPollInterval = "0.5",
    [string]$AllowedActions = "",
    [string]$AdditionalArgs = ""
)

function Assert-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
        throw "Administrator privileges are required. Re-run PowerShell as Administrator."
    }
}

Assert-Administrator

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runnerPath = (Resolve-Path (Join-Path $scriptDir "run-orchestrator.ps1")).Path

if ($Action -eq "remove") {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        Write-Host "Service '$ServiceName' not found."
        return
    }

    Write-Host "Stopping service '$ServiceName'..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Write-Host "Removing service '$ServiceName'..."
    sc.exe delete $ServiceName | Out-Null
    Write-Host "Service removed."
    return
}

$binaryPath = @(
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$runnerPath`"",
    "-BridgeHost", "`"$BridgeHost`"",
    "-BridgePort", $BridgePort
)

if ($MemoryDir -and $MemoryDir.Trim() -ne "") {
    $binaryPath += "-MemoryDir"
    $binaryPath += "`"$MemoryDir`""
}

if ($MailboxPollInterval -and $MailboxPollInterval.Trim() -ne "") {
    $binaryPath += "-MailboxPollInterval"
    $binaryPath += "`"$MailboxPollInterval`""
}

if ($AllowedActions -and $AllowedActions.Trim() -ne "") {
    $binaryPath += "-AllowedActions"
    $binaryPath += "`"$AllowedActions`""
}

if ($AdditionalArgs -ne "") {
    $binaryPath += "-AdditionalArgs"
    $binaryPath += "`"$AdditionalArgs`""
}

$binaryCommand = $binaryPath -join " "
Write-Host "Configuring service '$ServiceName' with command:"
Write-Host "  $binaryCommand"

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "Service exists; updating configuration."
    sc.exe config $ServiceName binPath= "$binaryCommand" start= auto | Out-Null
} else {
    New-Service -Name $ServiceName `
        -BinaryPathName $binaryCommand `
        -DisplayName $DisplayName `
        -Description "GrantFlow orchestrator realtime bridge" `
        -StartupType Automatic | Out-Null
}

Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" `
    -Name "ImagePath" `
    -Value $binaryCommand

Write-Host "Service '$ServiceName' installed/updated."
Write-Host "Start it with: Start-Service -Name $ServiceName"

