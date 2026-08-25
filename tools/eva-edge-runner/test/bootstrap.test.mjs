// Static security/regression guards for the Windows scheduled-task bootstrap.
// These run cross-platform; Windows still executes -PrepareOnly during install.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bootstrap = readFileSync(join(here, '..', 'bin', 'eva-bootstrap.ps1'), 'utf8')
const installer = readFileSync(join(here, '..', 'bin', 'install-eva-task.ps1'), 'utf8')

test('scheduled task invokes only the installed bootstrap from a trusted PowerShell path', () => {
  assert.match(installer, /System32\\WindowsPowerShell\\v1[.]0\\powershell[.]exe/)
  assert.match(installer, /New-ScheduledTaskAction -Execute \$powerShellExe/)
  assert.match(installer, /-File \$quotedBootstrap/)
  assert.match(installer, /-WorkingDirectory \$stableRoot/)
  assert.match(installer, /-MultipleInstances IgnoreNew/)
  assert.doesNotMatch(installer, /\$HOME[\\/]GrantFlow[\\/]tools[\\/]eva-edge-runner/i)
  assert.doesNotMatch(installer, /EVA_RUNNER_SECRET|EVA_APP_ENV/, 'credentials must never appear in task arguments')
})

test('installer validates a staged bootstrap before changing the installed task target', () => {
  assert.match(installer, /-Destination \$installCandidate/)
  assert.match(installer, /-File \$installCandidate -PrepareOnly/)
  assert.doesNotMatch(installer, /-Destination \$installedBootstrap -Force/)
  const prepare = installer.indexOf('-File $installCandidate -PrepareOnly')
  const register = installer.indexOf('Register-ScheduledTask')
  assert.ok(prepare >= 0 && register > prepare)
  assert.match(bootstrap, /if \(\$PrepareOnly\)[\s\S]*installation was not prepared[\s\S]*exit 3/)
  assert.match(bootstrap, /Global\\GrantFlow-EVA-Portfolio-QA/)
})

test('bootstrap fetches and verifies the dedicated checkout, never mutating the developer checkout', () => {
  assert.match(bootstrap, /runner-repo/)
  assert.match(bootstrap, /\+refs\/heads\/main:refs\/remotes\/origin\/main/)
  assert.match(bootstrap, /\$resolvedHead -ne \$main/)
  assert.match(bootstrap, /Get-ValidatedGrantFlowOrigin -Repository \$runnerRepo/)
  assert.match(bootstrap, /buckeye7066\/GrantFlow/)
  assert.doesNotMatch(
    bootstrap,
    /@\('-C', \$developerRepo, '(?:checkout|reset|clean|pull)'/,
    'the developer checkout may supply an origin URL but is never mutated',
  )
  assert.match(bootstrap, /'clean', '-fdx', '--quiet'/, 'ignored stale runner inputs are removed')
  assert.match(bootstrap, /tools\/eva-edge-runner\/node_modules\/[*][*]/, 'only the lockfile-keyed dependency cache survives clean')
})

test('owned paths cannot be adopted through a junction or an unrelated directory', () => {
  assert.match(installer, /Refusing to adopt a non-empty directory not already owned by EVA/)
  assert.match(installer, /FileAttributes]::ReparsePoint/)
  assert.match(bootstrap, /FileAttributes]::ReparsePoint/)
  assert.match(bootstrap, /\$ownedMarkerValue/)
})

test('a new runner revision is tested before credentials or portfolio code are exposed', () => {
  const unitGate = bootstrap.indexOf('& npm test')
  const selftestGate = bootstrap.indexOf('--selftest')
  const restoreSecret = bootstrap.indexOf('$env:EVA_RUNNER_SECRET = $runnerSecret')
  const clearAppEnvFile = bootstrap.indexOf("SetEnvironmentVariable('EVA_APP_ENV_FILE', $null, 'Process')")
  const restoreAppEnvFile = bootstrap.indexOf('$env:EVA_APP_ENV_FILE = $appEnvFile')
  const realRun = bootstrap.indexOf('& node @runnerArgs')
  assert.ok(clearAppEnvFile >= 0 && clearAppEnvFile < unitGate, 'the credentials file is hidden before candidate code runs')
  assert.ok(unitGate >= 0 && selftestGate > unitGate)
  assert.ok(restoreSecret > selftestGate, 'signing secret is restored only after candidate validation')
  assert.ok(restoreAppEnvFile > selftestGate, 'the per-app credentials file is restored only after candidate validation')
  assert.ok(realRun > restoreSecret, 'portfolio execution starts only after credentials are restored')
  assert.ok(realRun > restoreAppEnvFile, 'portfolio execution starts only after the credentials file is restored')
})

test('an abandoned mutex is recovered as acquired instead of poisoning future scheduled runs', () => {
  assert.match(bootstrap, /catch \[Threading[.]AbandonedMutexException\]/)
  assert.match(bootstrap, /\$mutexAcquired = \$true/)
  assert.match(bootstrap, /if \(\$mutexAcquired\) \{ try \{ \$mutex[.]ReleaseMutex\(\)/)
})

test('payload build provenance is the exact verified runner commit', () => {
  const verified = bootstrap.indexOf('$resolvedHead -ne $main')
  const stamped = bootstrap.indexOf('$env:EVA_RUNNER_BUILD_SHA = $head')
  const realRun = bootstrap.indexOf('& node @runnerArgs')
  assert.ok(verified >= 0 && stamped > verified)
  assert.ok(realRun > stamped)
})

test('Chromium is repaired on every preparation, not only when the npm lock changes', () => {
  assert.match(
    bootstrap,
    /if \(\$needsNpmCi\) \{[\s\S]*?npm ci[\s\S]*?\}\s*# Browser binaries[\s\S]*?npx playwright install chromium/,
  )
})

test('a failed origin/main candidate rolls back only to a re-tested last-known-good SHA', () => {
  const candidateCatch = bootstrap.indexOf('$candidateFailure = $_.Exception.Message')
  const prepareRefusal = bootstrap.indexOf('Candidate origin/main runner failed validation; installation was not prepared')
  const verifyObject = bootstrap.indexOf("'cat-file', '-e'")
  const rollback = bootstrap.indexOf('Set-EvaRunnerRevision -Revision $validatedSha')
  const rollbackRetest = bootstrap.indexOf('Test-EvaRunnerRevision -EdgeDirectory $edgeDir', rollback)
  const stamp = bootstrap.indexOf('$env:EVA_RUNNER_BUILD_SHA = $head')
  assert.ok(candidateCatch >= 0)
  assert.ok(prepareRefusal > candidateCatch, '-PrepareOnly must fail rather than install a rejected candidate')
  assert.ok(verifyObject > prepareRefusal && rollback > verifyObject)
  assert.ok(rollbackRetest > rollback, 'the marker alone never authorizes an unready rollback')
  assert.ok(stamp > rollbackRetest, 'payload provenance names the selected last-known-good commit')
})

test('the stable bootstrap self-updates only after candidate validation', () => {
  const validated = bootstrap.indexOf('Set-Content -LiteralPath $validatedShaFile')
  const staged = bootstrap.indexOf("$nextBootstrap = Join-Path $stableRoot 'eva-bootstrap.next.ps1'")
  const replaced = bootstrap.indexOf('[System.IO.File]::Replace')
  assert.ok(validated >= 0 && staged > validated && replaced > staged)
})
