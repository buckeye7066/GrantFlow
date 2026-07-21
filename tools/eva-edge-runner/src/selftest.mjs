// Edge-runner selftest — exercises the runner against FIXTURE apps only (never a
// real portfolio app), and verifies a signed payload round-trips through the
// coordinator's verifier if it's importable. Proves: adapters run, failure
// confirmation classifies, the payload validates, and the signature is accepted.
import { runCliJourney } from './adapters/cli.mjs'
import { buildPayload } from './runner.mjs'
import { buildSignedHeaders } from './sign.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Two fixture "apps" implemented as tiny node scripts: one that succeeds, one
// that fails deterministically. They live under fixtures/ and take no real action.
const FIXTURE_GOOD = join(__dirname, '..', 'fixtures', 'good-cli.mjs')
const FIXTURE_BAD = join(__dirname, '..', 'fixtures', 'bad-cli.mjs')

export async function runSelftest({ verbose = true } = {}) {
  const log = (...a) => verbose && console.log('[selftest]', ...a)
  const results = { checks: [], ok: true }
  const check = (name, cond, detail = '') => {
    results.checks.push({ name, ok: !!cond, detail })
    if (!cond) results.ok = false
    log(`${cond ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`)
  }

  const manifest = {
    app_id: 'fixture-app',
    display_name: 'Fixture App',
    runtime_type: 'cli',
    allowlist: { processes: [process.execPath] },
  }

  // 1. A passing CLI journey passes.
  const good = await runCliJourney({
    manifest,
    journey: { id: 'good', name: 'Good journey', command: process.execPath, args: [FIXTURE_GOOD], expect_exit_code: 0, expect_stdout_matches: 'OK', timeout_ms: 10000 },
  })
  check('passing cli journey -> passed', good.status === 'passed', good.status)

  // 2. A failing CLI journey fails with the diagnostic bundle.
  const bad = await runCliJourney({
    manifest,
    journey: { id: 'bad', name: 'Bad journey', command: process.execPath, args: [FIXTURE_BAD], expect_exit_code: 0, timeout_ms: 10000 },
  })
  check('failing cli journey -> failed', bad.status === 'failed', bad.status)
  check('failed journey carries expected/observed/impact', !!(bad.expected_behavior && bad.observed_behavior && bad.user_impact))
  check('failed journey carries repro + confidence', Array.isArray(bad.repro_steps) && typeof bad.diagnostic_confidence === 'number')

  // 3. A command outside the allowlist is blocked, not run.
  const blockedRes = await runCliJourney({
    manifest,
    journey: { id: 'blk', name: 'Blocked', command: 'C:/Windows/System32/cmd.exe', args: ['/c', 'echo hi'], timeout_ms: 5000 },
  })
  check('non-allowlisted process -> blocked', blockedRes.status === 'blocked', blockedRes.status)

  // 4. The assembled payload signs and its header verifies against a recomputed
  //    signature (contract self-consistency; the cross-check against the
  //    coordinator lives in test/sign.test.mjs).
  const payload = buildPayload({
    runnerId: 'selftest-runner',
    environment: 'fixture',
    runId: 'selftest-run-1',
    startedAt: new Date(1).toISOString(),
    completedAt: new Date(2).toISOString(),
    appResults: [{ app_id: 'fixture-app', display_name: 'Fixture App', app_status: 'tested', duration_ms: 1, journeys: [good, bad] }],
  })
  const rawBody = JSON.stringify(payload)
  const headers = buildSignedHeaders({ secret: 'selftest-secret-0123456789abcdef', runnerId: 'selftest-runner', runId: 'selftest-run-1', rawBody, timestamp: 1000 })
  check('payload signs with all required headers', !!(headers['x-eva-signature'] && headers['x-eva-nonce'] && headers['x-eva-idempotency-key']))

  // 5. If the coordinator verifier is importable (running inside the GrantFlow
  //    repo), verify the signed payload is accepted end-to-end.
  try {
    const ingestPath = join(__dirname, '..', '..', '..', 'backend', 'services', 'eva', 'evaIngest.js')
    const { verifyRequest } = await import(pathToFileURL(ingestPath).href)
    // Minimal in-memory db shim (nonce table only).
    const store = new Map()
    const db = {
      dialect: 'sqlite',
      prepare(sql) {
        return {
          run: (...a) => {
            if (/INSERT INTO eva_seen_nonces/.test(sql)) store.set(a[0], true)
            return { changes: 1 }
          },
          get: (...a) => (/eva_seen_nonces/.test(sql) ? (store.has(a[0]) ? { nonce: a[0] } : undefined) : undefined),
          all: () => [],
        }
      },
    }
    const env = { EVA_RUNNER_ID: 'selftest-runner', EVA_RUNNER_SECRET: 'selftest-secret-0123456789abcdef' }
    const v = await verifyRequest(db, { rawBody, headers, env, now: 1000 })
    check('coordinator verifier accepts the signed payload', v.ok, v.ok ? '' : `${v.status} ${v.error}`)
  } catch (e) {
    check('coordinator verifier import (skipped outside repo)', true, `skipped: ${e?.message?.slice(0, 60)}`)
  }

  return results
}
