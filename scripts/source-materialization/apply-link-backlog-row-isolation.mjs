import fs from 'node:fs'

const file = 'backend/services/linkBacklogRepairService.js'
const source = fs.readFileSync(file, 'utf8')
const signature = 'link_backlog_row_error_isolation'
if (source.includes(signature)) {
  console.log('[source-materialization] link backlog row isolation already present')
} else {
  const pattern = /  await concurrentMap\(rows \|\| \[\], concurrency, async \(row\) => \{[\s\S]*?\n  \}\)\n\n  return \{ ok: true, before, \.\.\.stats, after: await brokenDirectSummary\(db\) \}/
  const matches = source.match(new RegExp(pattern.source, 'g')) || []
  if (matches.length !== 1) throw new Error(`link backlog row isolation: expected one match, found ${matches.length}`)
  const replacement = `  // link_backlog_row_error_isolation: one provider, probe, or DB failure
  // never aborts the remaining selected rows. Each worker accumulates locally;
  // the final synchronous fold prevents lost += updates across awaited work.
  await concurrentMap(claimedRows, concurrency, async (row) => {
    const rowStats = {
      checked: 0, restored: 0, retired: 0, pending: 0,
      official_searches: 0, official_search_rescues: 0,
      official_search_unavailable: 0, row_errors: 0, failures: {},
    }
    const fail = (kind) => {
      rowStats.failures[kind] = (rowStats.failures[kind] || 0) + 1
    }
    let outcome = {
      status: 'broken', code: null, method: null, error: 'repair_exception:unknown',
      finalUrl: null, url: null, role: null, duration_ms: 0,
    }
    let finalStatus = 'broken'
    try {
      let result = await probeRow(row, timeoutMs)
      rowStats.checked += 1

      if (!result.success && String(row.title || '').trim()) {
        rowStats.official_searches += 1
        const rescue = await rescueOfficialUrl(row, findOfficialUrlImpl)
        if (rescue.rescued) {
          rowStats.official_search_rescues += 1
          result = { success: true, terminal: false, outcome: rescue.outcome, outcomes: result.outcomes }
        } else if (rescue.unavailable) {
          rowStats.official_search_unavailable += 1
          result.terminal = false
        }
      }

      outcome = result.outcome
      const at = nowIso()
      if (result.success) {
        const url = outcome.finalUrl || outcome.url
        const isApply = outcome.role === 'application_url' || outcome.role === 'apply_url'
        const applicationUrl = isApply ? url : null
        const applyUrl = isApply ? url : null
        const sourceUrl = isApply ? (row.source_url || row.evidence_url || url) : url
        rowStats.restored = countChanges(await restore.run(
          applicationUrl, applyUrl, sourceUrl, url, at,
          outcome.status === 'verified' ? 'ok' : outcome.status,
          outcome.code ?? null, outcome.method ?? 'get', verifiedBy,
          typeof outcome.code === 'number' ? outcome.code : null, no, yes, row.id,
        ))
        finalStatus = outcome.status === 'verified' ? 'ok' : outcome.status
      } else {
        const kind = failureClass(outcome)
        fail(kind)
        if (result.terminal) {
          rowStats.retired = countChanges(await retire.run(
            at, outcome.code ?? null, outcome.method ?? null, verifiedBy,
            \`\${RETIRED_MARKER}\${kind}:\${String(outcome.error || '').slice(0,120)}\`,
            outcome.finalUrl ?? null, typeof outcome.code === 'number' ? outcome.code : null,
            yes, no, row.id,
          ))
          finalStatus = 'skipped'
        } else {
          rowStats.pending = countChanges(await keepPending.run(
            at, outcome.code ?? null, outcome.method ?? null, verifiedBy,
            \`retryable_after_recheck:\${kind}:\${String(outcome.error || '').slice(0,120)}\`,
            outcome.finalUrl ?? null, typeof outcome.code === 'number' ? outcome.code : null,
            yes, no, row.id,
          ))
        }
      }
    } catch (error) {
      rowStats.row_errors += 1
      fail('repair_exception')
      const message = String(error?.message || error).replace(/[\\r\\n]+/g, ' ').slice(0, 120)
      outcome = {
        status: 'broken', code: null, method: 'repair_exception', error: message,
        finalUrl: null, url: null, role: null, duration_ms: 0,
      }
      try {
        rowStats.pending = countChanges(await keepPending.run(
          nowIso(), null, 'repair_exception', verifiedBy,
          \`retryable_after_recheck:repair_exception:\${message}\`,
          null, null, yes, no, row.id,
        ))
      } catch {
        fail('pending_persist_failed')
      }
    }

    // No await in this fold. JavaScript cannot interleave another worker between
    // reading and writing these counters.
    stats.checked += rowStats.checked
    stats.restored += rowStats.restored
    stats.retired += rowStats.retired
    stats.pending += rowStats.pending
    stats.official_searches += rowStats.official_searches
    stats.official_search_rescues += rowStats.official_search_rescues
    stats.official_search_unavailable += rowStats.official_search_unavailable
    stats.row_errors += rowStats.row_errors
    for (const [kind, count] of Object.entries(rowStats.failures)) {
      stats.failures[kind] = (stats.failures[kind] || 0) + count
    }

    try {
      await recordVerificationEvent(db, {
        opportunity_id: row.id,
        source: row.source,
        url: outcome.url,
        link_status: finalStatus,
        link_status_code: outcome.code,
        verification_method: outcome.method,
        verified_by: verifiedBy,
        verification_error: finalStatus === 'ok' || finalStatus === 'redirect' ? null : outcome.error,
        duration_ms: outcome.duration_ms,
      })
    } catch { /* audit persistence is best-effort */ }
  })

  return { ok: true, before, ...stats, after: await brokenDirectSummary(db) }`
  fs.writeFileSync(file, source.replace(pattern, replacement))
  console.log('[source-materialization] link backlog row isolation applied')
}
