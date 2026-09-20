param(
  [ValidateSet('Install','Run','Start','Stop','Status')][string]$Action='Status',
  [ValidateSet('Ollama','Gateway')][string]$Service='Gateway',
  [string]$OllamaExe,
  [ValidateSet('llama3.2:1b','llama3.2:latest','qwen2.5-coder:7b','gemma3:4b')][string]$Model='llama3.2:1b'
)
$ErrorActionPreference='Stop'
$runtimeHome=Join-Path $env:LOCALAPPDATA 'Axiom\LocalFreeAi'
$configPath=Join-Path $runtimeHome 'config.json'
$secretPath=Join-Path $runtimeHome 'gateway-token.dpapi'
$taskName='Axiom Local Free AI '+$Service
switch($Action){
  'Install' {
    if(-not [IO.Path]::IsPathRooted($OllamaExe) -or -not(Test-Path -LiteralPath $OllamaExe -PathType Leaf)){throw 'An existing absolute Ollama executable is required'}
    $node=(Get-Command node.exe -ErrorAction Stop).Source
    $modelCheck=Join-Path $PSScriptRoot 'model-preflight.mjs'
    & $node $modelCheck $Model
    if($LASTEXITCODE-ne0){throw 'Selected local model unavailable; installation was not changed.'}
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    New-Item -ItemType Directory -Force $runtimeHome | Out-Null
    & icacls.exe $runtimeHome /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
    if($LASTEXITCODE-ne0){throw 'Could not protect local model configuration'}
    if(-not(Test-Path $secretPath)){
      $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
      try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
      $token=[Convert]::ToBase64String($bytes)
      ConvertTo-SecureString $token -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $secretPath
      $token=$null
    }
    @{ollamaExe=$OllamaExe;nodeExe=$node;model=$Model}|ConvertTo-Json|Set-Content -LiteralPath $configPath
    foreach($file in @('gateway.mjs','manage.ps1','model-preflight.mjs')){
      $source=Join-Path $PSScriptRoot $file;$destination=Join-Path $runtimeHome $file
      if([IO.Path]::GetFullPath($source)-ne[IO.Path]::GetFullPath($destination)){Copy-Item -LiteralPath $source -Destination $destination -Force}
    }
    foreach($name in @('Ollama','Gateway')){
      $task='Axiom Local Free AI '+$name
      $existing=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
      if($existing -and ($existing.Actions.Arguments -notlike ('*'+$runtimeHome+'*'))){throw 'Refusing to replace an unrelated scheduled task'}
      $args='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $runtimeHome 'manage.ps1')+'" -Action Run -Service '+$name
      $taskAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $args
      $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity
      $principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
      $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      Register-ScheduledTask -TaskName $task -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    }
    Write-Output 'Local model and protected gateway startup tasks installed.'
  }
  'Run' {
    $config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
    if($Service-eq'Ollama'){
      try{$health=Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 3;if($health.version){exit 0}}catch{}
      $env:OLLAMA_HOST='127.0.0.1:11434';$env:OLLAMA_NUM_PARALLEL='1';$env:OLLAMA_MAX_LOADED_MODELS='1';$env:OLLAMA_KEEP_ALIVE='1h'
      & $config.ollamaExe serve
      exit $LASTEXITCODE
    }
    $secure=(Get-Content -LiteralPath $secretPath -Raw).Trim()|ConvertTo-SecureString
    $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try{
      $env:LOCAL_FREE_AI_TOKEN=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
      $env:LOCAL_FREE_AI_MODEL=$config.model
      & $config.nodeExe (Join-Path $runtimeHome 'gateway.mjs')
      exit $LASTEXITCODE
    }finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);Remove-Item Env:LOCAL_FREE_AI_TOKEN -ErrorAction SilentlyContinue}
  }
  'Start' {Start-ScheduledTask -TaskName $taskName}
  'Stop' {Stop-ScheduledTask -TaskName $taskName}
  'Status' {Get-ScheduledTask -TaskName 'Axiom Local Free AI *'|Select-Object TaskName,State}
}
