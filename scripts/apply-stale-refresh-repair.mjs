import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const originals = {
  'backend/services/matching/staleMatchExplainRefresh.js': '0dae55768e5c92862fdf79922a8d9e54c2418417',
  'backend/startup/enforceInvariants.js': 'b65d14d89af8337beb39b8d2c13e4710faaf8a9a',
  'backend/server.js': '16af82931c4c8e7b3c65d8d6171ee5a1d572aeb7',
}
const sources = new Map()
for (const [file, expected] of Object.entries(originals)) {
  assert.equal(execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim(), expected, 'Source changed: ' + file)
  sources.set(file, fs.readFileSync(file, 'utf8'))
}
function edit(file, before, after) {
  const text = sources.get(file)
  assert.equal(text.split(before).length, 2, 'Expected one exact anchor: ' + file + ' ' + before.slice(0, 60))
  sources.set(file, text.replace(before, after))
}
const service = 'backend/services/matching/staleMatchExplainRefresh.js'
edit(service, ' * @param {object} [opts.deps]', ' * @param {AbortSignal} [opts.signal]\n * @param {object} [opts.deps]')
edit(service, 'export async function runStaleMatchExplainRefresh(db, opts = {}) {\n  const startedAt', 'export async function runStaleMatchExplainRefresh(db, opts = {}) {\n  opts.signal?.throwIfAborted()\n  const startedAt')
edit(service, '    ).all(Math.max(pairBudget, 1))', '    // One read-only sentinel makes an unfinished bounded batch observable.\n    // The processing loop still permits at most pairBudget rows and writes.\n    ).all(Math.max(pairBudget, 1) + 1)')
edit(service, '  for (const row of rows || []) {\n    if (summary.scanned', '  for (const row of rows || []) {\n    opts.signal?.throwIfAborted()\n    if (summary.scanned')
edit(service, "    if (!ctx?.profile) { summary.skipped_no_profile += 1; continue }", "    opts.signal?.throwIfAborted()\n    if (!ctx?.profile) { summary.skipped_no_profile += 1; continue }")
edit(service, '    try {\n      const res = await db.prepare(\n        `UPDATE profile_opportunity_matches', '    // Do not start another write after the scheduler loses its lease.\n    opts.signal?.throwIfAborted()\n    try {\n      const res = await db.prepare(\n        `UPDATE profile_opportunity_matches')
const startup = 'backend/startup/enforceInvariants.js'
edit(startup, "  'convergenceErrors', 'foreignLaneSkipped', 'truncated', 'enforced',\n])", "  'convergenceErrors', 'foreignLaneSkipped', 'truncated', 'enforced',\n  'unscorable', 'skippedNoProfile', 'concurrentChangesSkipped', 'skipped', 'wouldRepair',\n])")
edit(startup, `export async function enforceStaleMatchExplainRefresh(db) {
  return runInvariant('stale_match_explain_refresh', async () => {
    let runStaleMatchExplainRefresh
    try {
      ;({ runStaleMatchExplainRefresh } = await import('../services/matching/staleMatchExplainRefresh.js'))
    } catch (err) {
      log.warn('stale_match_explain_refresh: unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const res = await runStaleMatchExplainRefresh(db)
    return {
      scanned: res.scanned ?? 0,
      repaired: res.refreshed ?? 0,
      wouldRepair: res.would_refresh ?? 0,
      unscorable: res.unscorable ?? 0,
      truncated: Boolean(res.truncated),
      enforced: Boolean(res.write_enabled),
    }
  })
}`, `export async function enforceStaleMatchExplainRefresh(db, opts = {}) {
  return runInvariant('stale_match_explain_refresh', async () => {
    let runStaleMatchExplainRefresh
    try {
      ;({ runStaleMatchExplainRefresh } = await import('../services/matching/staleMatchExplainRefresh.js'))
    } catch (err) {
      log.warn('stale_match_explain_refresh: unavailable (non-fatal)', { error: String(err?.message || err) })
      return { ok: false, scanned: 0, repaired: 0, enforced: false, skipped: 'deps' }
    }
    const res = await runStaleMatchExplainRefresh(db, opts)
    return {
      ok: res.ok === true,
      skipped: res.skipped,
      scanned: res.scanned ?? 0,
      repaired: res.refreshed ?? 0,
      wouldRepair: res.would_refresh ?? 0,
      unscorable: res.unscorable ?? 0,
      convergenceErrors: res.convergence_errors ?? 0,
      skippedNoProfile: res.skipped_no_profile ?? 0,
      concurrentChangesSkipped: res.concurrent_changes_skipped ?? 0,
      truncated: Boolean(res.truncated),
      enforced: Boolean(res.write_enabled),
    }
  })
}`)
const server = 'backend/server.js'
const anchor = "          console.log('[link-repair] recurring lifecycle pass:', lifecycle)"
edit(server, anchor, anchor + `
          // Resume the existing bounded explanation drain after boot and link
          // repair, under this scheduler's lease. No second timer or crawler.
          const { enforceStaleMatchExplainRefresh } = await import('./startup/enforceInvariants.js')
          const explainRefresh = await enforceStaleMatchExplainRefresh(dbInstance, { signal: lease.signal })
          lease.signal?.throwIfAborted()
          console.log('[stale-match-explain] recurring refresh:', explainRefresh)
          if (!explainRefresh.ok) {
            console.warn('[stale-match-explain] recurring refresh failed:', explainRefresh)
          }`)
for (const [file, source] of sources) fs.writeFileSync(file, source)
console.log('EXACT_REPAIR_APPLIED', JSON.stringify({ files: [...sources.keys()], acceptance_policy_changed: false, batch_budget_increased: false }))
