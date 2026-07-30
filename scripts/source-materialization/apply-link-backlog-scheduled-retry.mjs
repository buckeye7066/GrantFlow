import fs from 'node:fs'

const original = new Map()
const staged = new Map()

const read = (file) => {
  if (staged.has(file)) return staged.get(file)
  if (!original.has(file)) original.set(file, fs.readFileSync(file, 'utf8'))
  return original.get(file)
}
const stage = (file, value) => staged.set(file, value)

function replaceOnce(file, pattern, replacement, label) {
  const before = read(file)
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matches = before.match(new RegExp(pattern.source, flags)) || []
  if (matches.length !== 1) throw new Error(`${label}: expected one match, found ${matches.length}`)
  stage(file, before.replace(pattern, replacement))
}

function insertBefore(file, marker, addition, label) {
  const before = read(file)
  const first = before.indexOf(marker)
  if (first < 0 || before.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${label}: marker missing or ambiguous`)
  }
  stage(file, before.slice(0, first) + addition + before.slice(first))
}

function insertAfter(file, marker, addition, label) {
  const before = read(file)
  const first = before.indexOf(marker)
  if (first < 0 || before.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${label}: marker missing or ambiguous`)
  }
  stage(file, before.slice(0, first + marker.length) + addition + before.slice(first + marker.length))
}

const serviceFile = 'backend/services/linkBacklogRepairService.js'
const routeFile = 'backend/routes/linkBacklogRepair.js'
const missionFile = 'backend/services/missionHealthService.js'
const serviceTestFile = 'backend/tests/linkBacklogRepairService.test.js'
const safetyTestFile = 'backend/tests/linkBacklogSafetyRegression.test.js'

const signatures = [
  [serviceFile, 'export async function scheduleRetryableBrokenRows'],
  [serviceFile, 'retry_scheduled_after_bounded_recheck:'],
  [routeFile, "router.post('/schedule-retry'"],
  [missionFile, 'scheduled_retry_broken_direct_opportunities'],
  [safetyTestFile, 'schedules exhausted transient rows without retiring them'],
]

if (signatures.every(([file, signature]) => read(file).includes(signature))) {
  console.log('[source-materialization] scheduled-retry lifecycle already present')
} else {
  if (signatures.some(([file, signature]) => read(file).includes(signature))) {
    throw new Error('[source-materialization] partial scheduled-retry lifecycle detected')
  }

  replaceOnce(
    serviceFile,
    /const RETIRED_MARKER = 'retired_after_definitive_recheck:'/, 
    `const RETIRED_MARKER = 'retired_after_definitive_recheck:'
const SCHEDULED_RETRY_MARKER = 'retry_scheduled_after_bounded_recheck:'`,
    'Scheduled-retry marker',
  )

  replaceOnce(
    serviceFile,
    /      SUM\(CASE WHEN link_status='skipped' AND verification_error LIKE \? THEN 1 ELSE 0 END\) retired/,
    `      SUM(CASE WHEN link_status='skipped' AND verification_error LIKE ? THEN 1 ELSE 0 END) retired,
      SUM(CASE WHEN link_status='skipped' AND status='paused'
                    AND verification_error LIKE ? THEN 1 ELSE 0 END) scheduled_retry`,
    'Scheduled-retry summary SQL',
  )
  replaceOnce(
    serviceFile,
    /  `\)\.get\(`\$\{RETIRED_MARKER\}%`\)/,
    `  \`).get(\`${'${RETIRED_MARKER}'}%\`, \`${'${SCHEDULED_RETRY_MARKER}'}%\`)`,
    'Scheduled-retry summary binds',
  )
  replaceOnce(
    serviceFile,
    /    retired: Number\(row\?\.retired \|\| 0\),/,
    `    retired: Number(row?.retired || 0),
    scheduled_retry: Number(row?.scheduled_retry || 0),`,
    'Scheduled-retry summary response',
  )

  insertBefore(
    serviceFile,
    'export async function repairBrokenDirectBatch(db, options = {}) {',
    `/**
 * Move repeatedly inconclusive direct rows out of the active repair queue without
 * pretending they are live or dead. The row remains hidden and inactive, carries
 * the canonical \`skipped\` status, and is eligible for the normal verifier again
 * after its staleness window. Evidence in verification_events proves the bounded
 * attempts happened before this transition.
 */
export async function scheduleRetryableBrokenRows(db, options = {}) {
  const cyclePrefix = String(options.cyclePrefix || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '')
    .slice(0, 96)
  if (!cyclePrefix) throw new Error('cyclePrefix is required')

  const minAttempts = Math.max(2, Math.min(10, Number(options.minAttempts) || 2))
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 500))
  const retryAfterDays = Math.max(1, Math.min(90, Number(options.retryAfterDays) || 30))
  const { yes, no } = bools(db)
  const verifiedByLike = \`admin-link-repair:\${cyclePrefix}%\`
  const scheduledBy = \`scheduled-link-retry:\${cyclePrefix}\`

  const rows = await db.prepare(\`
    SELECT fo.id, fo.source, fo.application_url, fo.apply_url,
           fo.apply_guidelines_url, fo.source_url, fo.evidence_url, fo.final_url,
           fo.verification_error, attempts.attempt_count
      FROM funding_opportunities fo
      JOIN (
        SELECT opportunity_id, COUNT(DISTINCT verified_by) AS attempt_count
          FROM verification_events
         WHERE link_status='broken' AND verified_by LIKE ?
         GROUP BY opportunity_id
      ) attempts ON attempts.opportunity_id = fo.id
     WHERE COALESCE(fo.opportunity_kind,'direct') IN ('direct','benefit')
       AND fo.link_status='broken' AND fo.status='paused'
       AND COALESCE(fo.is_hidden,TRUE)=TRUE
       AND COALESCE(fo.is_active,FALSE)=FALSE
       AND attempts.attempt_count >= ?
     ORDER BY fo.last_verified_at ASC NULLS FIRST, fo.id ASC
     LIMIT ?
  \`).all(verifiedByLike, minAttempts, limit)

  const update = db.prepare(\`
    UPDATE funding_opportunities
       SET link_status='skipped', status='paused',
           verification_method='scheduled_retry', verified_by=?,
           verification_error=?, last_verified_at=?,
           is_hidden=?, is_active=?
     WHERE id=? AND link_status='broken' AND status='paused'
  \`)

  let scheduled = 0
  for (const row of rows || []) {
    const previous = String(row.verification_error || 'transient_failure')
      .replace(/[\\r\\n]+/g, ' ')
      .slice(0, 120)
    const marker = \`${'${SCHEDULED_RETRY_MARKER}'}attempts=\${Number(row.attempt_count || 0)};retry_after_days=\${retryAfterDays};cycle=\${cyclePrefix};last=\${previous}\`
    const at = nowIso()
    const changed = countChanges(await update.run(scheduledBy, marker, at, yes, no, row.id))
    scheduled += changed
    if (changed > 0) {
      await recordVerificationEvent(db, {
        opportunity_id: row.id,
        source: row.source,
        url: candidateUrls(row)[0] || null,
        link_status: 'skipped',
        link_status_code: null,
        verification_method: 'scheduled_retry',
        verified_by: scheduledBy,
        verification_error: marker,
        duration_ms: 0,
      })
    }
  }

  return {
    ok: true,
    cycle_prefix: cyclePrefix,
    min_attempts: minAttempts,
    retry_after_days: retryAfterDays,
    selected: rows.length,
    scheduled,
    summary: await brokenDirectSummary(db),
  }
}

`,
    'Scheduled-retry service',
  )

  replaceOnce(
    serviceFile,
    /  reclassifyBrokenResources,\n  repairBrokenDirectBatch,/,
    `  reclassifyBrokenResources,
  repairBrokenDirectBatch,
  scheduleRetryableBrokenRows,`,
    'Scheduled-retry default export',
  )

  replaceOnce(
    routeFile,
    /  reclassifyBrokenResources,\n  repairBrokenDirectBatch,/,
    `  reclassifyBrokenResources,
  repairBrokenDirectBatch,
  scheduleRetryableBrokenRows,`,
    'Scheduled-retry route import',
  )

  insertBefore(
    routeFile,
    'export default router',
    `router.post('/schedule-retry', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const cyclePrefix = cleanCycleId(req.body?.cycle_prefix)
    if (!cyclePrefix) {
      return res.status(400).json({ ok: false, error: 'cycle_prefix is required' })
    }
    const actor = req.ctx?.email || req.ctx?.userId || 'admin'
    const result = await runWithSchedulerLock(req.db, {
      lockName: LOCK_NAME,
      ttlMs: RECLASSIFY_LOCK_TTL_MS,
      logger: log,
      acquiredBy: \`admin-link-schedule-retry:\${actor}\`,
    }, () => scheduleRetryableBrokenRows(req.db, {
      cyclePrefix,
      minAttempts: req.body?.min_attempts,
      retryAfterDays: req.body?.retry_after_days,
      limit: req.body?.limit,
    }))
    res.set('Cache-Control', 'no-store')
    if (result?.skipped) return lockConflict(res, result)
    return res.json(result)
  } catch (error) {
    log.error('schedule_retry_failed', { error: error?.message || String(error) })
    return res.status(500).json({ ok: false, error: 'LINK_RETRY_SCHEDULING_FAILED', details_redacted: true })
  }
})

`,
    'Scheduled-retry route',
  )

  const retiredMetricMarker = `  const retiredBrokenDirect = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN \${directKinds}
       AND link_status = 'skipped'
       AND COALESCE(verification_error, '') LIKE 'retired_after_definitive_recheck:%'\`,
  ))?.n)`
  insertAfter(
    missionFile,
    retiredMetricMarker,
    `
  const scheduledRetryBrokenDirect = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN \${directKinds}
       AND link_status = 'skipped' AND status = 'paused'
       AND COALESCE(verification_error, '') LIKE 'retry_scheduled_after_bounded_recheck:%'\`,
  ))?.n)`,
    'Mission scheduled-retry metric',
  )
  replaceOnce(
    missionFile,
    /      retired_broken_direct_opportunities: retiredBrokenDirect,/,
    `      retired_broken_direct_opportunities: retiredBrokenDirect,
      scheduled_retry_broken_direct_opportunities: scheduledRetryBrokenDirect,`,
    'Mission scheduled-retry count response',
  )

  replaceOnce(
    serviceTestFile,
    /      repair_pending: 0,\n      retired: 1,/,
    `      repair_pending: 0,
      retired: 1,
      scheduled_retry: 0,`,
    'Service test retired summary',
  )
  replaceOnce(
    serviceTestFile,
    /      repair_pending: 1,\n      retired: 0,/,
    `      repair_pending: 1,
      retired: 0,
      scheduled_retry: 0,`,
    'Service test pending summary',
  )

  replaceOnce(
    safetyTestFile,
    /  estimateRepairLockTtlMs,\n  repairBrokenDirectBatch,/,
    `  estimateRepairLockTtlMs,
  repairBrokenDirectBatch,
  scheduleRetryableBrokenRows,`,
    'Scheduled-retry test import',
  )

  insertBefore(
    safetyTestFile,
    "  it('pins shared locking and success-driven visibility restoration', () => {",
    `  it('schedules exhausted transient rows without retiring them', async () => {
    const db = makeDb()
    insert(db, {
      id: 'bounded-transient',
      application_url: 'https://8.8.8.8/blocked',
      link_status: 'broken',
      status: 'paused',
      is_hidden: 1,
      is_active: 0,
      verification_error: 'retryable_after_recheck:access_or_bot_block:HTTP 403',
    })
    const addEvent = db.prepare(\`
      INSERT INTO verification_events (
        opportunity_id, source, url, link_status, verification_method,
        verified_by, verification_error, duration_ms
      ) VALUES (?, 'verified_real', ?, 'broken', 'get', ?, 'HTTP 403', 10)
    \`)
    addEvent.run('bounded-transient', 'https://8.8.8.8/blocked', 'admin-link-repair:proof-cycle-r1')
    addEvent.run('bounded-transient', 'https://8.8.8.8/blocked', 'admin-link-repair:proof-cycle-r2')

    const result = await scheduleRetryableBrokenRows(db, {
      cyclePrefix: 'proof-cycle-r',
      minAttempts: 2,
      retryAfterDays: 30,
    })
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('bounded-transient')

    expect(result).toMatchObject({ selected: 1, scheduled: 1, min_attempts: 2, retry_after_days: 30 })
    expect(row).toMatchObject({
      link_status: 'skipped',
      status: 'paused',
      verification_method: 'scheduled_retry',
      is_hidden: 1,
      is_active: 0,
    })
    expect(row.verification_error).toMatch(/^retry_scheduled_after_bounded_recheck:/)
    expect(await brokenDirectSummary(db)).toMatchObject({
      visible: 0,
      quarantined: 0,
      repair_pending: 0,
      retired: 0,
      scheduled_retry: 1,
    })
    const latest = db.prepare('SELECT * FROM verification_events ORDER BY id DESC LIMIT 1').get()
    expect(latest).toMatchObject({ link_status: 'skipped', verification_method: 'scheduled_retry' })
    db.close()
  })

`,
    'Scheduled-retry regression',
  )
  replaceOnce(
    safetyTestFile,
    /    expect\(route\)\.toContain\('link_backlog_runtime_bounded_lock_ttl'\)/,
    `    expect(route).toContain('link_backlog_runtime_bounded_lock_ttl')
    expect(route).toContain("router.post('/schedule-retry'")`,
    'Scheduled-retry route source pin',
  )

  const missing = signatures.filter(([file, signature]) => !read(file).includes(signature))
  if (missing.length > 0) {
    throw new Error(
      `[source-materialization] scheduled-retry signatures missing: ${missing
        .map(([file, signature]) => `${file}:${signature}`)
        .join(', ')}`,
    )
  }

  const written = []
  try {
    for (const [file, value] of staged) {
      fs.writeFileSync(file, value)
      written.push(file)
    }
  } catch (error) {
    for (const file of written.reverse()) {
      try { fs.writeFileSync(file, original.get(file)) } catch { /* keep first error */ }
    }
    throw error
  }

  console.log('[source-materialization] scheduled-retry lifecycle applied')
}
