import fs from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
const base = 'fdea2e504edbc8ec4561903426272b368eb381db'
const testFile = 'backend/tests/staleRefreshLeaseEvidence.test.js'
const receiptFile = 'backend/services/matching/staleMatchRefreshReceipt.js'
const mode = process.argv[2]
const edit = (file, before, after) => {
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.split(before).length, 2, 'Exact source anchor changed: ' + file + ' ' + before.slice(0, 65))
  fs.writeFileSync(file, text.replace(before, after))
}
const run = (args, required = true) => {
  const result = spawnSync('node', args, { stdio: 'inherit' })
  if (required) assert.equal(result.status, 0, 'Failed: node ' + args.join(' '))
  return result.status
}
const fixtureLease = "const TEST_LEASE = { lockName: 'scheduler:link-verification', ownerToken: 'test-owner' }\n"
const fixtureSchema = `raw.exec("CREATE TABLE agent_control_locks (lock_name TEXT PRIMARY KEY, owner_token TEXT, expires_at TEXT); INSERT INTO agent_control_locks VALUES ('scheduler:link-verification', 'test-owner', '2099-01-01T00:00:00Z')")`
if (mode === 'red') {
  execFileSync('git', ['diff', '--exit-code', base, '--', receiptFile, 'backend/services/sam/samRegistry.js', 'backend/server.js'])
  fs.copyFileSync('scripts/repair-refresh-fence.test.txt', testFile)
  assert.notEqual(run(['scripts/run-vitest-isolated.mjs', 'run', testFile, '--reporter=json', '--outputFile=/tmp/refresh-fence-red.json'], false), 0)
  const report = JSON.parse(fs.readFileSync('/tmp/refresh-fence-red.json', 'utf8'))
  assert.ok(report.numFailedTests >= 8, 'Expected real old-code failures')
  assert.equal(report.testResults.flatMap(s => s.assertionResults ?? []).filter(t => t.status === 'failed').length, report.numFailedTests)
  console.log('FENCE_GENUINE_RED', JSON.stringify({ failed: report.numFailedTests, passed: report.numPassedTests }))
} else if (mode === 'apply') {
  fs.copyFileSync('scripts/repair-refresh-fence.receipt.txt', receiptFile)
  edit('backend/server.js', '{ signal: lease.signal, persistReceipt: true }', '{ signal: lease.signal, lease, persistReceipt: true }')
  const sam = 'backend/services/sam/samRegistry.js'
  edit(sam, "      } catch (err) {\n        return { ok: true, skipped: true, summary: `sweep summary unavailable: ${err?.message || err}` }\n      }", "      } catch {\n        parsed = { steps: [{ name: 'invariant_boot_evidence', ok: false, status: 'unavailable' }] }\n      }")
  const continuation = 'backend/tests/staleMatchRefreshContinuation.test.js'
  edit(continuation, "import { enforceStaleMatchExplainRefresh } from '../startup/enforceInvariants.js'", "import { enforceStaleMatchExplainRefresh as enforceRefresh } from '../startup/enforceInvariants.js'")
  edit(continuation, 'const opened = []', fixtureLease + "const enforceStaleMatchExplainRefresh = (db, opts) => enforceRefresh(db, { ...opts, lease: TEST_LEASE })\nconst opened = []")
  edit(continuation, "  const db = { dialect: 'sqlite', prepare: sql => raw.prepare(sql) }", "  " + fixtureSchema + "\n  const db = { dialect: 'sqlite', prepare: sql => raw.prepare(sql) }")
  const race = 'backend/tests/staleRefreshClaimRace.test.js'
  edit(race, "import { beginStaleRefreshReceipt, finishStaleRefreshReceipt, STALE_REFRESH_RECEIPT_KEY }", "import { beginStaleRefreshReceipt as beginReceipt, finishStaleRefreshReceipt, STALE_REFRESH_RECEIPT_KEY }")
  edit(race, 'for (const existing of [false, true]) {', fixtureLease + "const beginStaleRefreshReceipt = (db, opts = {}) => beginReceipt(db, { ...opts, lease: TEST_LEASE })\n\nfor (const existing of [false, true]) {")
  const schemaAnchor = "raw.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')"
  let text = fs.readFileSync(race, 'utf8')
  assert.equal(text.split(schemaAnchor).length, 3, 'Preserve both existing race fixtures')
  fs.writeFileSync(race, text.replaceAll(schemaAnchor, schemaAnchor + '\n  ' + fixtureSchema))
  const scheduler = 'backend/tests/staleMatchExplainScheduler.test.js'
  edit(scheduler, '// Execute the actual scheduling function', fixtureLease + '\n// Execute the actual scheduling function')
  edit(scheduler, 'callback({ signal })', 'callback({ ...TEST_LEASE, signal })')
  edit(scheduler, 'ExactlyOnceWith(db, { signal, persistReceipt: true })', 'ExactlyOnceWith(db, { signal, lease: { ...TEST_LEASE, signal }, persistReceipt: true })')
  fs.appendFileSync('docs/agent-sync/2026-09-18-stored-refresh-follow-through.md', '\n## Lease fencing and unavailable boot evidence\n\nReceipt claims and terminal writes require the real scheduler owner token and unexpired database lease in the same conditional SQL as the generation check. Local timestamps are diagnostic only. Tests cover delayed reads with equal/skewed process clocks, expired/wrong owners, and lease loss before publication. Sam still consumes recurring evidence when boot JSON is malformed; a completed single batch never certifies absent evidence for unrelated boot sweeps. Existing race, cancellation and scheduler tests now supply explicit fixture leases without weakening assertions. The temporary verifier also checks the same SQL against an ephemeral PostgreSQL database.\n')
  console.log('LEASE_FENCE_AND_BOOT_EVIDENCE_APPLIED')
} else if (mode === 'verify') {
  run(['scripts/run-vitest-isolated.mjs', 'run', testFile,
    'backend/tests/staleMatchRefreshContinuation.test.js', 'backend/tests/staleRefreshClaimRace.test.js',
    'backend/tests/staleMatchExplainScheduler.test.js', 'backend/tests/staleRefreshInvariantReceipt.test.js',
    'backend/tests/staleMatchExplainRefresh.test.js', 'backend/tests/enforceInvariants.test.js', 'backend/tests/profileSignalVersion.test.js'])
  run(['--test', 'tests/unit/stale-match-refresh-budget.test.mjs'])
  run(['scripts/pin-signal-version.mjs', '--check'])
  const { default: pg } = await import('pg')
  const { beginStaleRefreshReceipt, finishStaleRefreshReceipt } = await import('../' + receiptFile)
  const client = new pg.Client({ connectionString: process.env.TEST_POSTGRES_URL })
  try {
    await client.connect()
    await client.query('CREATE TEMP TABLE system_kv (key text PRIMARY KEY, value text, updated_at timestamptz); CREATE TEMP TABLE agent_control_locks (lock_name text PRIMARY KEY, owner_token text, expires_at timestamptz)')
    await client.query("INSERT INTO agent_control_locks VALUES ($1, $2, clock_timestamp() + interval '10 minutes')", ['scheduler:link-verification', 'pg-owner'])
    const db = {
      dialect: 'postgres',
      prepare(sql) {
        let index = 0
        const query = sql.replace(/\?/g, () => '$' + (++index))
        return {
          get: async (...args) => (await client.query(query, args)).rows[0],
          run: async (...args) => ({ changes: (await client.query(query, args)).rowCount }),
        }
      },
    }
    const lease = { lockName: 'scheduler:link-verification', ownerToken: 'pg-owner' }
    const done = { ok: true, status: 'complete', complete: true, remaining_candidates: 0, remaining_stale: 0, verification_failed: false, verification_truncated: false }
    const first = await beginStaleRefreshReceipt(db, { lease }); await finishStaleRefreshReceipt(db, first, done)
    const second = await beginStaleRefreshReceipt(db, { lease })
    await client.query('UPDATE agent_control_locks SET owner_token=$1', ['next-owner'])
    await assert.rejects(() => finishStaleRefreshReceipt(db, second, done), /superseded|expired/)
    await assert.rejects(() => beginStaleRefreshReceipt(db, { lease }), /superseded|expired/)
    await client.query("UPDATE agent_control_locks SET owner_token=$1, expires_at=clock_timestamp() - interval '1 second'", ['pg-owner'])
    await assert.rejects(() => beginStaleRefreshReceipt(db, { lease }), /superseded|expired/)
    console.log('POSTGRES_FENCE_VERIFIED', JSON.stringify({ valid_claim_and_finish: true, lost_owner_start_and_finish_refused: true, expired_refused: true }))
  } finally { await client.end() }
} else throw Error('Unknown repair mode')
