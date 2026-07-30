import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, value) => fs.writeFileSync(file, value)

function replaceOnce(file, pattern, replacement, label) {
  const before = read(file)
  const matches = before.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) || []
  if (matches.length !== 1) throw new Error(`${label}: expected one match, found ${matches.length}`)
  write(file, before.replace(pattern, replacement))
}

function insertAfter(file, marker, addition, label) {
  const before = read(file)
  const first = before.indexOf(marker)
  if (first < 0 || before.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${label}: marker missing or ambiguous`)
  }
  write(file, before.slice(0, first + marker.length) + addition + before.slice(first + marker.length))
}

const serviceFile = 'backend/services/linkBacklogRepairService.js'
const testFile = 'backend/tests/linkBacklogRepairService.test.js'
const serviceSafe = read(serviceFile).includes('link_backlog_selected_row_claim')
const testSafe = read(testFile).includes('link_backlog_extended_url_fixture')

if (!serviceSafe) {
  replaceOnce(
    serviceFile,
    /  return \[\n    \{ role: 'application_url', url: row\.application_url \},\n    \{ role: 'final_url', url: row\.final_url \},\n    \{ role: 'source_url', url: row\.source_url \},\n  \]/,
    `  // Probe every canonical stored HTTP candidate before retirement.
  return [
    { role: 'application_url', url: row.application_url },
    { role: 'apply_url', url: row.apply_url },
    { role: 'apply_guidelines_url', url: row.apply_guidelines_url },
    { role: 'final_url', url: row.final_url },
    { role: 'source_url', url: row.source_url },
    { role: 'evidence_url', url: row.evidence_url },
  ]`,
    'Complete candidate URL coverage',
  )

  replaceOnce(
    serviceFile,
    /  const cycleMarker = cycleId \? verifiedBy : null\n/,
    `  const pendingRetryAfterMs = Math.max(
    5 * 60 * 1000,
    Math.min(30 * 24 * 60 * 60 * 1000, Number(options.pendingRetryAfterMs) || 24 * 60 * 60 * 1000),
  )
  const pendingRetryCutoff = new Date(Date.now() - pendingRetryAfterMs).toISOString()
`,
    'Age-based retry policy',
  )

  replaceOnce(
    serviceFile,
    /  await db\.prepare\(`\n    UPDATE funding_opportunities\n       SET is_hidden=\?, is_active=\?, status='paused'\n     WHERE COALESCE\(opportunity_kind,'direct'\) IN \('direct','benefit'\)\n       AND link_status='broken' AND COALESCE\(status,'active'\) <> 'expired'\n  `\)\.run\(yes, no\)\n\n  const rows = await db\.prepare\(`\n    SELECT id, title, sponsor, source, application_url, source_url, final_url\n      FROM funding_opportunities\n     WHERE COALESCE\(opportunity_kind,'direct'\) IN \('direct','benefit'\)\n       AND link_status='broken' AND status='paused'\n       AND \(\? IS NULL OR COALESCE\(verified_by, ''\) <> \?\)\n     ORDER BY last_verified_at ASC NULLS FIRST\n     LIMIT \?\n  `\)\.all\(cycleMarker, cycleMarker, limit\)/,
    `  // Quarantine every broken direct row, but claim only the selected batch as
  // paused. Untouched rows remain active-status quarantine, not fake pending work.
  await db.prepare(\`
    UPDATE funding_opportunities
       SET is_hidden=?, is_active=?
     WHERE COALESCE(opportunity_kind,'direct') IN ('direct','benefit')
       AND link_status='broken' AND COALESCE(status,'active') <> 'expired'
  \`).run(yes, no)

  // link_backlog_selected_row_claim: active quarantine drains first. Fresh
  // retryable rows wait for the bounded retry window; cycle IDs never exclude them.
  const rows = await db.prepare(\`
    SELECT id, title, sponsor, source, application_url, apply_url,
           apply_guidelines_url, source_url, evidence_url, final_url,
           status, last_verified_at
      FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN ('direct','benefit')
       AND link_status='broken'
       AND (
         COALESCE(status,'active')='active'
         OR (status='paused' AND (last_verified_at IS NULL OR last_verified_at < ?))
       )
     ORDER BY CASE WHEN COALESCE(status,'active')='active' THEN 0 ELSE 1 END,
              CASE WHEN last_verified_at IS NULL THEN 0 ELSE 1 END,
              last_verified_at ASC, id ASC
     LIMIT ?
  \`).all(pendingRetryCutoff, limit)`,
    'Selected-row claim and portable ordering',
  )

  replaceOnce(
    serviceFile,
    /  const stats = \{\n    cycle_id: cycleId,\n    selected: rows\.length,\n    checked: 0,/,
    `  const stats = {
    cycle_id: cycleId,
    selected: rows.length,
    claimed: 0,
    checked: 0,`,
    'Claim metric',
  )
  replaceOnce(
    serviceFile,
    /    official_search_unavailable: 0,\n    failures: \{},/,
    `    official_search_unavailable: 0,
    row_errors: 0,
    failures: {},`,
    'Row error metric',
  )

  const statsMarker = `  const stats = {
    cycle_id: cycleId,
    selected: rows.length,
    claimed: 0,
    checked: 0,
    restored: 0,
    retired: 0,
    pending: 0,
    official_searches: 0,
    official_search_rescues: 0,
    official_search_unavailable: 0,
    row_errors: 0,
    failures: {},
    reclassified,
  }
`
  insertAfter(
    serviceFile,
    statsMarker,
    `  const claimSelected = db.prepare(\`
    UPDATE funding_opportunities
       SET is_hidden=?, is_active=?, status='paused'
     WHERE id=? AND link_status='broken' AND COALESCE(status,'active') <> 'expired'
  \`)
  const claimedRows = []
  for (const row of rows || []) {
    try {
      const claimed = countChanges(await claimSelected.run(yes, no, row.id))
      if (claimed > 0) {
        stats.claimed += claimed
        claimedRows.push(row)
      }
    } catch {
      stats.row_errors += 1
      stats.failures.claim_failed = (stats.failures.claim_failed || 0) + 1
    }
  }
`,
    'Claim only selected rows',
  )

  replaceOnce(
    serviceFile,
    /  const restore = db\.prepare\(`\n    UPDATE funding_opportunities\n       SET application_url=\?, source_url=\?, final_url=\?, last_verified_at=\?, link_status=\?,/,
    `  const restore = db.prepare(\`
    UPDATE funding_opportunities
       SET application_url=?, apply_url=?, source_url=?, final_url=?, last_verified_at=?, link_status=?,`,
    'Restore canonical apply fields',
  )
}

if (!testSafe) {
  replaceOnce(
    testFile,
    /      application_url TEXT,\n      source_url TEXT,/,
    `      -- link_backlog_extended_url_fixture
      application_url TEXT,
      apply_url TEXT,
      apply_guidelines_url TEXT,
      source_url TEXT,`,
    'Test URL columns',
  )
  replaceOnce(
    testFile,
    /id,title,sponsor,source,source_id,application_url,source_url,final_url,contact_info,/,
    `id,title,sponsor,source,source_id,application_url,apply_url,apply_guidelines_url,source_url,final_url,contact_info,`,
    'Test insert columns',
  )
  replaceOnce(
    testFile,
    /@id,@title,@sponsor,@source,@source_id,@application_url,@source_url,@final_url,@contact_info,/,
    `@id,@title,@sponsor,@source,@source_id,@application_url,@apply_url,@apply_guidelines_url,@source_url,@final_url,@contact_info,`,
    'Test insert values',
  )
  replaceOnce(
    testFile,
    /    application_url: null, source_url: null, final_url: null, contact_info: null,/,
    `    application_url: null, apply_url: null, apply_guidelines_url: null,
    source_url: null, final_url: null, contact_info: null,`,
    'Test URL defaults',
  )
}

console.log(
  serviceSafe && testSafe
    ? '[source-materialization] link backlog candidate selection already safe'
    : '[source-materialization] link backlog candidate selection hardened',
)
