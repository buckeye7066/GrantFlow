import fs from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const base = 'ec9b9cc6491b2b0e74ff2217697bc8b69440c290'
const original = '57dcf8ac6704823f49a215b9b68a395082d4a4e4'
const mode = process.argv[2]
const files = {
  worker: 'backend/services/matching/staleMatchExplainRefresh.js',
  wrapper: 'backend/startup/enforceInvariants.js',
  server: 'backend/server.js',
  sam: 'backend/services/sam/samRegistry.js',
}
const edit = (file, before, after) => {
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.split(before).length, 2, 'Exact patch anchor changed: ' + file + ' ' + before.slice(0, 70))
  fs.writeFileSync(file, text.replace(before, after))
}
const testFile = 'backend/tests/staleMatchRefreshContinuation.test.js'
const schedulerFile = 'backend/tests/staleMatchExplainScheduler.test.js'
const run = (args, required = true) => {
  const result = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: 'inherit' })
  if (required) assert.equal(result.status, 0, 'Failed: node ' + args.join(' '))
  return result.status
}
if (mode === 'red') {
  execFileSync('git', ['diff', '--exit-code', base, '--', ...Object.values(files)])
  fs.copyFileSync('scripts/repair-stale-refresh-continuation.test.txt', testFile)
  const old = execFileSync('git', ['show', original + ':backend/tests/staleMatchExplainScheduler.test.js'], { encoding: 'utf8' })
  fs.writeFileSync(schedulerFile, old.replace('With(db, { signal })', 'With(db, { signal, persistReceipt: true })'))
  const code = run(['scripts/run-vitest-isolated.mjs', 'run', testFile, schedulerFile,
    '--reporter=json', '--outputFile=/tmp/stale-continuation-red.json'], false)
  assert.notEqual(code, 0, 'Expected real baseline assertion failures')
  const report = JSON.parse(fs.readFileSync('/tmp/stale-continuation-red.json', 'utf8'))
  assert.ok(report.numFailedTests >= 8, 'Regression tests did not reproduce the missing continuation/receipt behavior')
  const failed = report.testResults.flatMap(suite => suite.assertionResults ?? []).filter(test => test.status === 'failed')
  assert.equal(failed.length, report.numFailedTests, 'Failure must be assertions, not a missing module or setup error')
  console.log('GENUINE_RED', JSON.stringify({ failed: failed.length, passed: report.numPassedTests }))
} else if (mode === 'apply') {
  const w = files.worker
  edit(w, 'export async function runStaleMatchExplainRefresh(db, opts = {}) {',
    'export async function runStaleMatchExplainRefresh(db, opts = {}) {\n  opts.signal?.throwIfAborted()')
  edit(w, '  const finish = async () => {', '  const finish = async () => {\n    opts.signal?.throwIfAborted()')
  edit(w, '  let rows\n  try {', '  let rows\n  opts.signal?.throwIfAborted()\n  try {')
  edit(w, '  for (const row of rows || []) {', '  for (const row of rows || []) {\n    opts.signal?.throwIfAborted()')
  edit(w, '    if (!ctx?.profile) { summary.skipped_no_profile += 1; continue }',
    '    opts.signal?.throwIfAborted()\n    if (!ctx?.profile) { summary.skipped_no_profile += 1; continue }')
  edit(w, '      refreshedProof = refreshFourTruthProof(', '      opts.signal?.throwIfAborted()\n      refreshedProof = refreshFourTruthProof(')
  edit(w, '    try {\n      const res = await db.prepare(\n        `UPDATE profile_opportunity_matches',
    '    opts.signal?.throwIfAborted()\n    try {\n      const res = await db.prepare(\n        `UPDATE profile_opportunity_matches')
  fs.copyFileSync('scripts/repair-stale-refresh-receipt.txt', 'backend/services/matching/staleMatchRefreshReceipt.js')
  const f = files.wrapper
  const importLine = "import { beginStaleRefreshReceipt, finishStaleRefreshReceipt } from '../services/matching/staleMatchRefreshReceipt.js'\n"
  fs.writeFileSync(f, importLine + fs.readFileSync(f, 'utf8'))
  edit(f, 'export async function enforceStaleMatchExplainRefresh(db) {\n  return runInvariant(',
    "export async function enforceStaleMatchExplainRefresh(db, opts = {}) {\n  const attempt = opts.persistReceipt === true ? await beginStaleRefreshReceipt(db, opts) : null\n  const result = await runInvariant(")
  edit(f, '    const res = await runStaleMatchExplainRefresh(db)', '    const res = await runStaleMatchExplainRefresh(db, opts)')
  edit(f, "      enforced: Boolean(res.write_enabled),\n    }\n  })\n}\n\n/**\n * INVARIANT: `matcher_version`",
    "      enforced: Boolean(res.write_enabled),\n    }\n  })\n  if (attempt) await finishStaleRefreshReceipt(db, attempt, projectPersistedStep(result), opts)\n  return result\n}\n\n/**\n * INVARIANT: `matcher_version`")
  edit(f, "      'convergence_errors', 'concurrent_changes_skipped', 'skipped',",
    "      'convergence_errors', 'concurrent_changes_skipped', 'skipped', 'wouldRepair', 'elapsed_ms',")
  edit(files.server, "          console.log('[link-repair] recurring lifecycle pass:', lifecycle)",
    "          console.log('[link-repair] recurring lifecycle pass:', lifecycle)\n          const { enforceStaleMatchExplainRefresh } = await import('./startup/enforceInvariants.js')\n          const explainRefresh = await enforceStaleMatchExplainRefresh(dbInstance, { signal: lease.signal, persistReceipt: true })\n          lease.signal?.throwIfAborted()\n          console.log('[stale-match-explain] recurring refresh:', explainRefresh)\n          if (!explainRefresh.ok) console.warn('[stale-match-explain] recurring refresh failed:', explainRefresh)")
  edit(files.server, '        const stats = await runLinkVerification(dbInstance, {',
    '        lease.signal?.throwIfAborted()\n        const stats = await runLinkVerification(dbInstance, {')
  const sam = files.sam
  fs.writeFileSync(sam, "import { withLatestStaleRefreshReceipt } from '../matching/staleMatchRefreshReceipt.js'\n" + fs.readFileSync(sam, 'utf8'))
  let text = fs.readFileSync(sam, 'utf8')
  const begin = text.indexOf("    id: 'pipeline.invariantSweepOutcomes',")
  const end = text.indexOf('\n  },\n  {', begin)
  assert.ok(begin > 0 && end > begin, 'Sam check boundary changed')
  let block = text.slice(begin, end)
  assert.ok(block.includes('      if (!parsed || !Array.isArray(parsed.steps)) {'))
  block = block.replace('      if (!parsed || !Array.isArray(parsed.steps)) {',
    '      parsed = await withLatestStaleRefreshReceipt(db, parsed)\n      if (!parsed || !Array.isArray(parsed.steps)) {')
  block = block.replace('FAILED on the last boot:', 'need attention in latest maintenance evidence:')
  block = block.replaceAll('totalRepaired: parsed.totalRepaired', 'totalRepaired: parsed.totalRepaired, stale_match_refresh: parsed.recurring_stale_match_refresh ?? null')
  fs.writeFileSync(sam, text.slice(0, begin) + block + text.slice(end))
  fs.writeFileSync('docs/agent-sync/2026-09-18-stored-refresh-follow-through.md', `# Recurring stored-match refresh and durable progress\n\nReconciles PR #1749 with main ${base} / PR #1750. All newer exact-backlog verification and runner fixtures are preserved.\n\nThe existing leased link-verification callback resumes one bounded batch after boot and link repair, before task-truth maintenance. No new timer, change to the 800-pair/45-second defaults, admission policy, proof history, application history, or source deletion. Cancellation stops new work and writes.\n\nRecurring work stores a running receipt before starting and a conditional terminal receipt under system_kv.stale_match_explain_last_run. A cancelled lease leaves an incomplete running record, and an old attempt cannot overwrite a newer one. Receipts carry aggregate diagnostics only. Sam's existing invariant check overlays a newer recurring result in memory, preserves historical boot records and unrelated failures, and refuses missing, stale, pending, disabled, malformed or failed progress as proof of completion.\n\nTests cover real SQLite batches and durable readback, cancellation, conditional publication, current/old/stale receipt precedence, Sam consumption, and the actual scheduling function. Exact-baseline red/green runs and existing PR #1750 tests are required before publication. Full exact-head CI and production readback remain release gates. No new funding/application outcome is claimed. Phases 3-5 remain open.\n`)
  console.log('APPLIED_BOUNDED_CONTINUATION_AND_RECEIPT')
} else if (mode === 'verify') {
  run(['scripts/run-vitest-isolated.mjs', 'run', testFile, schedulerFile,
    'backend/tests/staleRefreshInvariantReceipt.test.js', 'backend/tests/staleMatchExplainRefresh.test.js',
    'backend/tests/enforceInvariants.test.js', 'backend/tests/fundingTruthPolicy.test.js', 'backend/tests/profileSignalVersion.test.js'])
  run(['--test', 'tests/unit/stale-match-refresh-budget.test.mjs'])
  run(['scripts/pin-signal-version.mjs', '--check'])
  console.log('VERIFIED_CURRENT_BASE_AND_CONTINUATION')
} else throw Error('Unknown repair phase')
