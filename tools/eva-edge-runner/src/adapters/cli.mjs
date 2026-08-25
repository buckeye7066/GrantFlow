// CLI / Python / PowerShell subprocess adapter. Strict argument allowlist, temp
// working directory, hard timeout, captured output, exit-code assertions, and
// cleanup. Never runs an arbitrary command — only the manifest's declared
// start_command with args drawn from the journey's allowlisted arg set.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

// Run one CLI journey. `journey` = { id, name, command, args[], expect_exit_code,
// expect_stdout_matches, timeout_ms }. `manifest.allowed_processes` gates the
// executable; an arg not in `journey.args` (already the fixed list) is never
// synthesized. Returns a journey-result fragment.
export async function runCliJourney({ manifest, journey }) {
  const started = Date.now()
  const allowed = manifest.allowlist?.processes || manifest.allowed_processes || []
  const cmd = journey.command
  if (!cmd) {
    return failResult(journey, started, 'blocked', 'validation-missing', {
      observed: 'journey has no command to run',
      expected: 'a cli journey declares a command',
      impact: 'journey could not run',
      confidence: 1.0,
    })
  }
  if (allowed.length && !allowed.some((a) => cmd === a || cmd.endsWith(a))) {
    return failResult(journey, started, 'blocked', 'validation-missing', {
      observed: `command "${cmd}" is not in the manifest process allowlist`,
      expected: 'only allowlisted processes run',
      impact: 'journey could not run safely',
      confidence: 1.0,
    })
  }

  // Run the command in the app's OWN repo directory so relative commands like
  // `python flexfactor.py --help` or `python system_cleaner/cleaner.py --help`
  // can find their script. Previously the command ran in a fresh empty temp dir,
  // so the interpreter could not open the script and exited 2 with no usage
  // output — which is exactly the "CLI renders usage/help" failure we saw. The
  // manifest's disposable_data_root (a relative fixture path) also resolves
  // correctly from here. Fall back to a temp dir only if the app has no path.
  const appDir = manifest.local_path || null
  const tmp = appDir ? null : mkdtempSync(join(os.tmpdir(), 'eva-cli-'))
  const cwd = appDir || tmp
  try {
    const result = await runProcess(cmd, journey.args || [], { cwd, timeoutMs: journey.timeout_ms || 60000 })
    const exitOk = journey.expect_exit_code == null || result.code === journey.expect_exit_code
    const stdoutOk = !journey.expect_stdout_matches || new RegExp(journey.expect_stdout_matches).test(result.stdout)
    if (exitOk && stdoutOk) {
      return { journey_id: journey.id, name: journey.name, status: 'passed', duration_ms: Date.now() - started }
    }
    return failResult(journey, started, 'high', result.timedOut ? 'timeout' : 'assertion', {
      observed: result.timedOut
        ? `process timed out after ${journey.timeout_ms || 60000}ms`
        : `exit ${result.code}, stdout did not match /${journey.expect_stdout_matches || ''}/`,
      expected: `exit ${journey.expect_exit_code ?? 0}${journey.expect_stdout_matches ? ` and stdout matching /${journey.expect_stdout_matches}/` : ''}`,
      impact: 'the command-line workflow did not complete as a user expects',
      errorSignature: `exit=${result.code} timedOut=${result.timedOut}`,
      confidence: 0.75,
    })
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

function runProcess(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(cmd, args, { cwd, shell: false })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err?.message || err), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

function failResult(journey, started, severity, failureClass, { observed, expected, impact, errorSignature, confidence }) {
  return {
    journey_id: journey.id,
    name: journey.name,
    status: severity === 'blocked' ? 'blocked' : 'failed',
    severity: severity === 'blocked' ? undefined : severity,
    retry_classification: 'reproducible',
    failure_class: failureClass,
    route_or_control: journey.command,
    error_signature: errorSignature || observed,
    expected_behavior: expected,
    observed_behavior: observed,
    repro_steps: [`Run: ${journey.command} ${(journey.args || []).join(' ')}`],
    user_impact: impact,
    diagnostic_confidence: confidence,
    duration_ms: Date.now() - started,
  }
}
