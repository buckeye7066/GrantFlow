param(
  [ValidateSet('Install', 'Start', 'Run', 'Stop', 'Uninstall', 'LoginClaude', 'LoginCodex')]
  [string]$Action = 'Start',
  [string]$Url
)
$ErrorActionPreference = 'Stop'
$taskName = 'GrantFlow Owner AI Bridge'
$bridgeHome = Join-Path $env:LOCALAPPDATA 'GrantFlow\owner-ai-bridge'
$secretPath = Join-Path $bridgeHome 'bridge-secret.dpapi'
$urlPath = Join-Path $bridgeHome 'url.txt'
$scriptPath = $PSCommandPath

function Invoke-SubscriptionLogin([string]$Provider) {
  $savedEnvironment = @{}
  Get-ChildItem Env: | ForEach-Object { $savedEnvironment[$_.Name] = $_.Value }
  try {
    $allowed = @('PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE', 'HOME')
    Get-ChildItem Env: | Where-Object { $_.Name -notin $allowed } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
    if ($Provider -eq 'claude') {
      $env:CLAUDE_CONFIG_DIR = Join-Path $env:LOCALAPPDATA 'GrantFlow\subscriptions\claude'
      $env:CLAUDE_CODE_SAFE_MODE = '1'
      & claude.exe auth login
    } else {
      $env:CODEX_HOME = Join-Path $env:LOCALAPPDATA 'GrantFlow\subscriptions\codex'
      & codex.exe login
    }
  } finally {
    Get-ChildItem Env: | Where-Object { -not $savedEnvironment.ContainsKey($_.Name) } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
    foreach ($key in $savedEnvironment.Keys) { Set-Item -LiteralPath ('Env:' + $key) -Value $savedEnvironment[$key] }
  }
}

switch ($Action) {
  'Install' {
    $target = [Uri]$Url
    if ($target.Scheme -ne 'https' -or $target.UserInfo -or $target.Query -or $target.Fragment -or $target.AbsolutePath -ne '/') { throw 'An explicit HTTPS origin is required.' }
    New-Item -ItemType Directory -Force $bridgeHome | Out-Null
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $bridgeHome /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot secure bridge directory.' }
    $secret = Read-Host 'Dedicated bridge token (at least 32 characters)' -AsSecureString
    if ($secret.Length -lt 32) { throw 'Bridge token is too short.' }
    $secret | ConvertFrom-SecureString | Set-Content -LiteralPath $secretPath
    $target.AbsoluteUri | Set-Content -LiteralPath $urlPath
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $scriptPath + '" -Action Run'
    $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  }
  'Start' { Start-ScheduledTask -TaskName $taskName }
  'Stop' { Stop-ScheduledTask -TaskName $taskName }
  'Uninstall' {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $secretPath, $urlPath -Force -ErrorAction SilentlyContinue
  }
  'Run' {
    $secure = Get-Content -LiteralPath $secretPath -Raw | ConvertTo-SecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $env:OWNER_AI_BRIDGE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
      $env:GRANTFLOW_OWNER_AI_URL = (Get-Content -LiteralPath $urlPath -Raw).Trim()
      & node.exe (Join-Path $PSScriptRoot 'bridge.mjs')
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
      Remove-Item Env:OWNER_AI_BRIDGE_TOKEN -ErrorAction SilentlyContinue
    }
  }
  'LoginClaude' { Invoke-SubscriptionLogin 'claude' }
  'LoginCodex' { Invoke-SubscriptionLogin 'codex' }
}
