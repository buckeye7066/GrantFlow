import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, value) => fs.writeFileSync(file, value)

function countMatches(value, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return value.match(new RegExp(pattern.source, flags))?.length || 0
}

function preflight(operation) {
  const source = read(operation.file)
  if (operation.type === 'replace') {
    const matches = countMatches(source, operation.pattern)
    if (matches !== 1) throw new Error(`${operation.label}: expected one match, found ${matches}`)
    return
  }
  const first = source.indexOf(operation.marker)
  if (first < 0 || source.indexOf(operation.marker, first + operation.marker.length) >= 0) {
    throw new Error(`${operation.label}: marker missing or ambiguous`)
  }
}

function apply(operation) {
  const source = read(operation.file)
  if (operation.type === 'replace') {
    write(operation.file, source.replace(operation.pattern, operation.replacement))
    return
  }
  const first = source.indexOf(operation.marker)
  write(
    operation.file,
    source.slice(0, first + operation.marker.length) + operation.addition + source.slice(first + operation.marker.length),
  )
}

const serviceFile = 'backend/services/linkBacklogRepairService.js'
const routeFile = 'backend/routes/linkBacklogRepair.js'
const safetyTestFile = 'backend/tests/linkBacklogSafetyRegression.test.js'

const serviceSource = read(serviceFile)
const routeSource = read(routeFile)
const safetyTestSource = read(safetyTestFile)
const operations = []

if (!serviceSource.includes('export function estimateRepairLockTtlMs')) {
  operations.push({
    type: 'insert_after',
    file: serviceFile,
    marker: `export function candidateUrls(row = {}) {
  return candidateUrlEntries(row).map((entry) => entry.url)
}`,
    addition: `

const CANDIDATE_URL_FIELD_COUNT = 6
const ATTEMPTS_PER_URL = 2
const OFFICIAL_RESCUE_BUDGET_MS = 32_000
const REPAIR_LOCK_MARGIN_MS = 5 * 60 * 1000
const MIN_REPAIR_LOCK_TTL_MS = 30 * 60 * 1000
const MAX_REPAIR_LOCK_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Size the shared scheduler lease from the same clamps the repair service uses.
 * One wave can probe six URL fields twice plus one bounded official-page rescue.
 * The lease therefore cannot expire while a valid worst-case bounded batch is
 * still working, even when an operator deliberately chooses concurrency=1.
 */
export function estimateRepairLockTtlMs(options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 40))
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8))
  const timeoutMs = Math.max(3000, Math.min(20000, Number(options.timeoutMs) || 10000))
  const waves = Math.ceil(limit / concurrency)
  const perWaveBudgetMs =
    (CANDIDATE_URL_FIELD_COUNT * ATTEMPTS_PER_URL * timeoutMs) + OFFICIAL_RESCUE_BUDGET_MS
  return Math.max(
    MIN_REPAIR_LOCK_TTL_MS,
    Math.min(MAX_REPAIR_LOCK_TTL_MS, (waves * perWaveBudgetMs) + REPAIR_LOCK_MARGIN_MS),
  )
}`,
    label: 'Repair lock TTL estimator',
  })
  operations.push({
    type: 'replace',
    file: serviceFile,
    pattern: /  candidateUrls,\n  failureClass,/,
    replacement: `  candidateUrls,
  estimateRepairLockTtlMs,
  failureClass,`,
    label: 'Repair lock TTL default export',
  })
}

if (!serviceSource.includes('official_rescue_clears_unprobeable_urls')) {
  operations.push({
    type: 'replace',
    file: serviceFile,
    pattern: /  const permanentRoles = new Set\(\n    \(Array\.isArray\(result\?\.outcomes\) \? result\.outcomes : \[\]\)\n      \.filter\(\(entry\) => PERMANENT_HTTP_CODES\.has\(Number\(entry\?\.code\)\)\)\n      \.map\(\(entry\) => String\(entry\?\.role \|\| ''\)\)\n      \.filter\(Boolean\),\n  \)\n  const keep = \(role\) => permanentRoles\.has\(role\) \? null : \(row\?\.\[role\] \|\| null\)/,
    replacement: `  const outcomes = Array.isArray(result?.outcomes) ? result.outcomes : []
  const permanentRoles = new Set(
    outcomes
      .filter((entry) => PERMANENT_HTTP_CODES.has(Number(entry?.code)))
      .map((entry) => String(entry?.role || ''))
      .filter(Boolean),
  )
  // official_rescue_clears_unprobeable_urls: when the row had zero valid HTTP
  // candidates, its old URL-shaped values were never probeable and cannot remain
  // beside a newly proven official page. A rescue after real transient outcomes
  // still preserves those candidates because access denial is not proof of death.
  const clearUnprobeable = result?.official_rescue === true && outcomes.length === 0
  const keep = (role) => (clearUnprobeable || permanentRoles.has(role)) ? null : (row?.[role] || null)`,
    label: 'Official rescue URL hygiene',
  })
  operations.push({
    type: 'replace',
    file: serviceFile,
    pattern: /          result = \{ success: true, terminal: false, outcome: rescue\.outcome, outcomes: result\.outcomes \}/,
    replacement: `          result = {
            success: true,
            terminal: false,
            official_rescue: true,
            outcome: rescue.outcome,
            outcomes: result.outcomes,
          }`,
    label: 'Official rescue provenance flag',
  })
}

if (!routeSource.includes('link_backlog_runtime_bounded_lock_ttl')) {
  operations.push({
    type: 'replace',
    file: routeFile,
    pattern: /  brokenDirectSummary,\n  reclassifyBrokenResources,/,
    replacement: `  brokenDirectSummary,
  estimateRepairLockTtlMs,
  reclassifyBrokenResources,`,
    label: 'Route lock estimator import',
  })
  operations.push({
    type: 'replace',
    file: routeFile,
    pattern: /const LOCK_TTL_MS = 30 \* 60 \* 1000/,
    replacement: `const RECLASSIFY_LOCK_TTL_MS = 30 * 60 * 1000`,
    label: 'Separate reclassification TTL',
  })
  operations.push({
    type: 'replace',
    file: routeFile,
    pattern: /      ttlMs: LOCK_TTL_MS,\n      logger: log,\n      acquiredBy: `admin-link-reclassify:\$\{actor\}`,/,
    replacement: `      ttlMs: RECLASSIFY_LOCK_TTL_MS,
      logger: log,
      acquiredBy: \`admin-link-reclassify:\${actor}\`,`,
    label: 'Reclassification TTL use',
  })
  operations.push({
    type: 'replace',
    file: routeFile,
    pattern: /    const cycleId = cleanCycleId\(req\.body\?\.cycle_id\)\n    const actor = req\.ctx\?\.email \|\| req\.ctx\?\.userId \|\| 'admin'\n    const result = await runWithSchedulerLock\(req\.db, \{\n      lockName: LOCK_NAME,\n      ttlMs: LOCK_TTL_MS,/,
    replacement: `    const cycleId = cleanCycleId(req.body?.cycle_id)
    const actor = req.ctx?.email || req.ctx?.userId || 'admin'
    const repairOptions = {
      limit: req.body?.limit,
      concurrency: req.body?.concurrency,
      timeoutMs: req.body?.timeout_ms,
      pendingRetryAfterMs: req.body?.pending_retry_after_ms,
      cycleId,
      verifiedBy: cycleId
        ? \`admin-link-repair:\${cycleId}\`
        : \`admin-link-repair:\${actor}\`,
    }
    const result = await runWithSchedulerLock(req.db, {
      lockName: LOCK_NAME,
      // link_backlog_runtime_bounded_lock_ttl: derive the lease from the exact
      // bounded batch instead of letting a fixed 30-minute lease expire mid-run.
      ttlMs: estimateRepairLockTtlMs(repairOptions),`,
    label: 'Runtime-bounded repair TTL',
  })
  operations.push({
    type: 'replace',
    file: routeFile,
    pattern: /    \}, \(\) => repairBrokenDirectBatch\(req\.db, \{\n      limit: req\.body\?\.limit,\n      concurrency: req\.body\?\.concurrency,\n      timeoutMs: req\.body\?\.timeout_ms,\n      pendingRetryAfterMs: req\.body\?\.pending_retry_after_ms,\n      cycleId,\n      verifiedBy: cycleId\n        \? `admin-link-repair:\$\{cycleId\}`\n        : `admin-link-repair:\$\{actor\}`,\n    \}\)\)/,
    replacement: `    }, () => repairBrokenDirectBatch(req.db, repairOptions))`,
    label: 'Reuse exact repair options under lock',
  })
}

if (!safetyTestSource.includes('official-only rescue clears unprobeable URL fields')) {
  operations.push({
    type: 'replace',
    file: safetyTestFile,
    pattern: /  candidateUrlEntries,\n  repairBrokenDirectBatch,/,
    replacement: `  candidateUrlEntries,
  estimateRepairLockTtlMs,
  repairBrokenDirectBatch,`,
    label: 'Safety test estimator import',
  })
  operations.push({
    type: 'insert_after',
    file: safetyTestFile,
    marker: `  it('probes every canonical stored opportunity URL field before retirement', () => {
    const entries = candidateUrlEntries({
      application_url: 'https://8.8.8.8/application',
      apply_url: 'https://8.8.8.8/apply',
      apply_guidelines_url: 'https://8.8.8.8/guidelines',
      final_url: 'https://8.8.8.8/final',
      source_url: 'https://8.8.8.8/source',
      evidence_url: 'https://8.8.8.8/evidence',
    })
    expect(entries.map((entry) => entry.role)).toEqual([
      'application_url', 'apply_url', 'apply_guidelines_url',
      'final_url', 'source_url', 'evidence_url',
    ])
  })`,
    addition: `

  it('official-only rescue clears unprobeable URL fields', async () => {
    const db = makeDb()
    insert(db, {
      id: 'official-only-rescue',
      application_url: 'mailto:old@example.org',
      apply_url: '/relative-apply',
      apply_guidelines_url: 'not a URL',
      evidence_url: 'javascript:void(0)',
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HTTP probe should not run'))
    const officialUrl = 'https://official.example.org/current-program'

    const result = await repairBrokenDirectBatch(db, {
      limit: 1,
      concurrency: 1,
      timeoutMs: 3000,
      findOfficialUrlImpl: async () => ({
        url: officialUrl,
        searched: true,
        hits: 1,
        probe: { status: 'ok', code: 200, method: 'get', finalUrl: officialUrl },
      }),
    })
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id=?').get('official-only-rescue')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toMatchObject({ restored: 1, retired: 0, pending: 0 })
    expect(row).toMatchObject({
      application_url: null,
      apply_url: null,
      apply_guidelines_url: null,
      evidence_url: null,
      source_url: officialUrl,
      final_url: officialUrl,
      link_status: 'ok',
      status: 'active',
      is_hidden: 0,
      is_active: 1,
    })
    db.close()
  })

  it('sizes the shared lock lease for the bounded worst case', () => {
    const minimum = 30 * 60 * 1000
    const maximum = 12 * 60 * 60 * 1000
    expect(estimateRepairLockTtlMs()).toBeGreaterThanOrEqual(minimum)
    const worstCase = estimateRepairLockTtlMs({ limit: 100, concurrency: 1, timeoutMs: 20_000 })
    expect(worstCase).toBeGreaterThan(minimum)
    expect(worstCase).toBeLessThanOrEqual(maximum)
  })`,
    label: 'Final link safety regressions',
  })
  operations.push({
    type: 'replace',
    file: safetyTestFile,
    pattern: /    expect\(route\)\.toContain\('link_backlog_shared_scheduler_lock'\)/,
    replacement: `    expect(route).toContain('link_backlog_shared_scheduler_lock')
    expect(route).toContain('link_backlog_runtime_bounded_lock_ttl')
    expect(route).toContain('ttlMs: estimateRepairLockTtlMs(repairOptions)')`,
    label: 'Route TTL source pin',
  })
}

if (operations.length === 0) {
  console.log('[source-materialization] final link-backlog safety corrections already present')
} else {
  for (const operation of operations) preflight(operation)
  const originals = new Map([...new Set(operations.map((operation) => operation.file))].map((file) => [file, read(file)]))
  try {
    for (const operation of operations) apply(operation)
  } catch (error) {
    for (const [file, original] of originals) write(file, original)
    throw error
  }
  console.log('[source-materialization] final link-backlog safety corrections applied')
}
