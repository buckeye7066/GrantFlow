[CmdletBinding()]
param(
  [switch]$Catchup,
  [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$stableRoot = Join-Path $env:LOCALAPPDATA 'GrantFlow\EVA'
$ownedMarker = Join-Path $stableRoot '.eva-runner-owned'
$ownedMarkerValue = 'Owned exclusively by GrantFlow EVA. Safe target for the EVA bootstrap checkout.'
$runnerRepo = Join-Path $stableRoot 'runner-repo'
$dataDir = Join-Path $stableRoot 'data'
$dependencyHashFile = Join-Path $stableRoot 'edge-runner-package-lock.sha256'
$validatedShaFile = Join-Path $stableRoot 'validated-runner.sha'
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $powerShellExe -PathType Leaf)) {
  throw "Windows PowerShell was not found at the trusted system path: $powerShellExe"
}

# Candidate installation/tests must not inherit the upload signing secret or
# per-app credentials. Restore them only for the real runner process.
$runnerSecret = [Environment]::GetEnvironmentVariable('EVA_RUNNER_SECRET', 'Process')
$appEnv = [Environment]::GetEnvironmentVariable('EVA_APP_ENV', 'Process')
$appEnvFile = [Environment]::GetEnvironmentVariable('EVA_APP_ENV_FILE', 'Process')
[Environment]::SetEnvironmentVariable('EVA_RUNNER_SECRET', $null, 'Process')
[Environment]::SetEnvironmentVariable('EVA_APP_ENV', $null, 'Process')
[Environment]::SetEnvironmentVariable('EVA_APP_ENV_FILE', $null, 'Process')

if (-not (Test-Path -LiteralPath $ownedMarker -PathType Leaf) -or
    (Get-Content -LiteralPath $ownedMarker -Raw).Trim() -ne $ownedMarkerValue) {
  throw "EVA stable directory is not initialized. Run install-eva-task.ps1 once: $stableRoot"
}
$ownedPaths = @($stableRoot, $runnerRepo, $dataDir)
foreach ($ownedPath in $ownedPaths) {
  if (Test-Path -LiteralPath $ownedPath) {
    $ownedItem = Get-Item -LiteralPath $ownedPath -Force
    if (($ownedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to use an EVA-owned path that is a reparse point: $ownedPath"
    }
  }
}

$mutex = [Threading.Mutex]::new($false, 'Global\GrantFlow-EVA-Portfolio-QA')
$mutexAcquired = $false
try {
  $mutexAcquired = $mutex.WaitOne(0)
} catch [Threading.AbandonedMutexException] {
  # WaitOne grants ownership when it reports abandonment. Treat that as a
  # recoverable prior-run crash so one killed task cannot poison future runs.
  $mutexAcquired = $true
  Write-Warning '[eva-bootstrap] recovered an abandoned mutex from a terminated prior run.'
}
if (-not $mutexAcquired) {
  $mutex.Dispose()
  if ($PrepareOnly) {
    Write-Error '[eva-bootstrap] another EVA run is active; installation was not prepared.'
    exit 3
  }
  Write-Host '[eva-bootstrap] another EVA run is active; skipping overlap.'
  exit 0
}

function Invoke-GitChecked {
  param([Parameter(Mandatory)][string[]]$Arguments)
  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git failed ($LASTEXITCODE): git $($Arguments -join ' ')"
  }
}

function Get-ValidatedGrantFlowOrigin {
  param([Parameter(Mandatory)][string]$Repository)
  $url = ((& git -C $Repository remote get-url origin) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($url)) {
    throw 'Cannot resolve the GrantFlow origin URL.'
  }
  # Do not execute a scheduled runner fetched from an accidentally repointed
  # remote. HTTPS and the two standard GitHub SSH spellings are accepted.
  if ($url -notmatch '^(https://github[.]com/|git@github[.]com:|ssh://git@github[.]com/)buckeye7066/GrantFlow([.]git)?/?$') {
    throw 'GrantFlow origin does not identify buckeye7066/GrantFlow; refusing to execute it.'
  }
  return $url
}

function Set-EvaRunnerRevision {
  param(
    [Parameter(Mandatory)][string]$Revision,
    [switch]$RequireOriginMain
  )
  Invoke-GitChecked -Arguments @('-C', $runnerRepo, 'checkout', '--force', '--detach', $Revision)
  Invoke-GitChecked -Arguments @('-C', $runnerRepo, 'reset', '--hard', '--quiet', $Revision)
  # Remove every ignored/untracked input produced by an older candidate. Keep
  # only the dependency cache that is separately keyed to package-lock below;
  # stale .env/data/config files must never influence runner validation.
  Invoke-GitChecked -Arguments @(
    '-C', $runnerRepo, 'clean', '-fdx', '--quiet',
    '-e', 'tools/eva-edge-runner/node_modules',
    '-e', 'tools/eva-edge-runner/node_modules/**'
  )

  $resolvedHead = ((& git -C $runnerRepo rev-parse HEAD) | Out-String).Trim()
  $trackedChanges = (& git -C $runnerRepo status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0 -or $resolvedHead -notmatch '^[0-9a-f]{40,64}$' -or $trackedChanges) {
    throw "EVA checkout is not an exact clean commit after selecting $Revision."
  }
  if ($RequireOriginMain) {
    $main = ((& git -C $runnerRepo rev-parse origin/main) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $resolvedHead -ne $main) {
      throw 'Stable EVA checkout is not the exact clean origin/main revision.'
    }
  } elseif ($resolvedHead -ne $Revision) {
    throw "Last-known-good checkout resolved to $resolvedHead instead of $Revision."
  }
  $script:head = $resolvedHead
  $script:edgeDir = Join-Path $runnerRepo 'tools\eva-edge-runner'
}

function Prepare-EvaRunnerDependencies {
  param([Parameter(Mandatory)][string]$EdgeDirectory)
  $packageLock = Join-Path $EdgeDirectory 'package-lock.json'
  $playwrightPackage = Join-Path $EdgeDirectory 'node_modules\playwright\package.json'
  if (-not (Test-Path -LiteralPath $packageLock -PathType Leaf)) {
    throw "Validated runner is missing package-lock.json: $packageLock"
  }
  $lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packageLock).Hash
  $priorHash = if (Test-Path -LiteralPath $dependencyHashFile) {
    (Get-Content -LiteralPath $dependencyHashFile -Raw).Trim()
  } else { '' }
  $needsNpmCi = $priorHash -ne $lockHash -or -not (Test-Path -LiteralPath $playwrightPackage)

  Push-Location $EdgeDirectory
  try {
    if ($needsNpmCi) {
      & npm ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    }
    # Browser binaries live outside node_modules and may be removed/corrupted
    # independently of the lockfile. This command is idempotent and MUST run on
    # every preparation, even when the package hash is unchanged.
    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "Playwright Chromium install failed with exit code $LASTEXITCODE" }
    if ($needsNpmCi) { Set-Content -LiteralPath $dependencyHashFile -Value $lockHash -NoNewline }
  } finally {
    Pop-Location
  }
}

function Test-EvaRunnerRevision {
  param([Parameter(Mandatory)][string]$EdgeDirectory)
  Push-Location $EdgeDirectory
  try {
    & npm test
    if ($LASTEXITCODE -ne 0) { throw "EVA runner tests failed with exit code $LASTEXITCODE" }
    & node bin\eva-runner.mjs --selftest
    if ($LASTEXITCODE -ne 0) { throw "EVA runner selftest failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

try {
  New-Item -ItemType Directory -Force -Path $stableRoot, $dataDir | Out-Null

  if (-not (Test-Path -LiteralPath (Join-Path $runnerRepo '.git'))) {
    $developerRepo = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'GrantFlow'
    if (-not (Test-Path -LiteralPath (Join-Path $developerRepo '.git'))) {
      throw "Cannot initialize stable EVA checkout: developer GrantFlow clone not found at $developerRepo"
    }
    $originUrl = Get-ValidatedGrantFlowOrigin -Repository $developerRepo
    Invoke-GitChecked -Arguments @('clone', '--no-checkout', $originUrl, $runnerRepo)
  }

  $null = Get-ValidatedGrantFlowOrigin -Repository $runnerRepo

  $validatedSha = if (Test-Path -LiteralPath $validatedShaFile) {
    (Get-Content -LiteralPath $validatedShaFile -Raw).Trim()
  } else { '' }
  $candidateFailure = $null
  $candidateNeedsMarker = $false
  try {
    # This checkout exists only for EVA. Updating it can never switch, reset, or
    # clean the developer's GrantFlow working tree.
    Invoke-GitChecked -Arguments @('-C', $runnerRepo, 'fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main')
    Set-EvaRunnerRevision -Revision 'origin/main' -RequireOriginMain
    Prepare-EvaRunnerDependencies -EdgeDirectory $edgeDir
    if ($validatedSha -ne $head) {
      # A new runner revision must prove its own fixture/unit contract before it
      # sees credentials or launches portfolio code.
      Test-EvaRunnerRevision -EdgeDirectory $edgeDir
      $candidateNeedsMarker = $true
    }
  } catch {
    $candidateFailure = $_.Exception.Message
  }

  $usingLastKnownGood = $false
  if ($candidateFailure) {
    if ($PrepareOnly) {
      throw "Candidate origin/main runner failed validation; installation was not prepared: $candidateFailure"
    }
    if ($validatedSha -notmatch '^[0-9a-f]{40,64}$' -or $validatedSha -eq $head) {
      throw "Candidate origin/main runner failed and no distinct last-known-good revision is available: $candidateFailure"
    }
    Write-Warning "[eva-bootstrap] origin/main candidate failed ($candidateFailure); rolling back to validated runner $($validatedSha.Substring(0, 12))."
    try {
      Invoke-GitChecked -Arguments @('-C', $runnerRepo, 'cat-file', '-e', "${validatedSha}^{commit}")
      Set-EvaRunnerRevision -Revision $validatedSha
      Prepare-EvaRunnerDependencies -EdgeDirectory $edgeDir
      # Re-prove the saved revision in the current machine environment. A stale
      # marker is never enough to run code whose dependencies/browser drifted.
      Test-EvaRunnerRevision -EdgeDirectory $edgeDir
      $usingLastKnownGood = $true
    } catch {
      throw "Candidate origin/main runner failed ($candidateFailure), and last-known-good $validatedSha also failed readiness: $($_.Exception.Message)"
    }
  } elseif ($candidateNeedsMarker) {
    # Written only after dependency prep, unit tests, and selftest all pass.
    Invoke-GitChecked -Arguments @('-C', $runnerRepo, 'update-ref', 'refs/eva/last-known-good', $head)
    Set-Content -LiteralPath $validatedShaFile -Value $head -NoNewline
  }

  $env:EVA_RUNNER_BUILD_SHA = $head

  # Refresh the installed bootstrap from the selected validated bundle (the
  # origin/main candidate, or the re-tested last-known-good rollback).
  # This affects the next scheduled invocation; the currently executing script
  # remains in memory. A dirty developer checkout can therefore neither pin nor
  # downgrade bootstrap behavior after the first installation.
  $versionedBootstrap = Join-Path $edgeDir 'bin\eva-bootstrap.ps1'
  $installedBootstrap = Join-Path $stableRoot 'eva-bootstrap.ps1'
  $nextBootstrap = Join-Path $stableRoot 'eva-bootstrap.next.ps1'
  if (-not (Test-Path -LiteralPath $versionedBootstrap -PathType Leaf)) {
    throw 'Validated runner is missing bin\eva-bootstrap.ps1.'
  }
  if (-not (Test-Path -LiteralPath $installedBootstrap -PathType Leaf)) {
    Copy-Item -LiteralPath $versionedBootstrap -Destination $nextBootstrap -Force
    Move-Item -LiteralPath $nextBootstrap -Destination $installedBootstrap
  } elseif ((Get-FileHash -Algorithm SHA256 -LiteralPath $versionedBootstrap).Hash -ne
            (Get-FileHash -Algorithm SHA256 -LiteralPath $installedBootstrap).Hash) {
    Copy-Item -LiteralPath $versionedBootstrap -Destination $nextBootstrap -Force
    [System.IO.File]::Replace($nextBootstrap, $installedBootstrap, $null)
  }

  if ($PrepareOnly) {
    Write-Host "[eva-bootstrap] prepared origin/main $($head.Substring(0, 12)); task not run."
    exit 0
  }

  $env:EVA_RUNNER_DATA_DIR = $dataDir
  $env:EVA_REGISTRY_PATH = Join-Path $runnerRepo 'qa\portfolio-registry.json'
  $env:EVA_MANIFEST_DIR = Join-Path $runnerRepo 'qa\manifests'

  # Replace the separate stale-path Docker task with the versioned preflight.
  # Failure is intentionally non-fatal: the runner will mark Docker apps
  # blocked while continuing to test the rest of the portfolio.
  if ($env:EVA_START_DOCKER -ne 'false') {
    $dockerPreflight = Join-Path $runnerRepo 'tools\ensure-docker-for-eva.ps1'
    if (Test-Path -LiteralPath $dockerPreflight) {
      try { & $powerShellExe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $dockerPreflight } catch {
        Write-Warning "Docker preflight failed: $($_.Exception.Message)"
      }
    }
  }

  if ($null -ne $runnerSecret) { $env:EVA_RUNNER_SECRET = $runnerSecret }
  if ($null -ne $appEnv) { $env:EVA_APP_ENV = $appEnv }
  if ($null -ne $appEnvFile) { $env:EVA_APP_ENV_FILE = $appEnvFile }
  $runner = Join-Path $edgeDir 'bin\eva-runner.mjs'
  $runnerArgs = @($runner)
  if ($Catchup) { $runnerArgs += '--catchup' }
  & node @runnerArgs
  exit $LASTEXITCODE
} finally {
  if ($mutexAcquired) { try { $mutex.ReleaseMutex() } catch { } }
  $mutex.Dispose()
}
