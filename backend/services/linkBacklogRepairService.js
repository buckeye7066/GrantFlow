import { checkUrl, recordVerificationEvent } from './linkVerificationService.js'
import { findOfficialUrlForOpportunity } from './urlEnrichment.js'

const SUCCESS = new Set(['ok', 'redirect', 'verified'])
const RESOURCE_RESULTS = new Set(['action_step', 'directory', 'referral', 'school_portal', 'past_award_intel'])
const PERMANENT_HTTP_CODES = new Set([404, 410])
const RETIRED_MARKER = 'retired_after_definitive_recheck:'

const countChanges = (result) => Number(result?.changes ?? result?.rowCount ?? 0)
const nowIso = () => new Date().toISOString()
const bools = (db) => db?.dialect === 'postgres'
  ? { yes: true, no: false }
  : { yes: 1, no: 0 }

export function osmElementUrl(sourceId) {
  const match = String(sourceId || '').trim().match(/^(node|way|relation):(\d+)$/i)
  return match ? `https://www.openstreetmap.org/${match[1].toLowerCase()}/${match[2]}` : null
}

export function candidateUrlEntries(row = {}) {
  const seen = new Set()
  // Probe every canonical stored HTTP candidate before retirement.
  return [
    { role: 'application_url', url: row.application_url },
    { role: 'apply_url', url: row.apply_url },
    { role: 'apply_guidelines_url', url: row.apply_guidelines_url },
    { role: 'final_url', url: row.final_url },
    { role: 'source_url', url: row.source_url },
    { role: 'evidence_url', url: row.evidence_url },
  ]
    .map((entry) => ({ ...entry, url: String(entry.url || '').trim() }))
    .filter((entry) => {
      if (!/^https?:\/\//i.test(entry.url) || seen.has(entry.url)) return false
      seen.add(entry.url)
      return true
    })
}

export function candidateUrls(row = {}) {
  return candidateUrlEntries(row).map((entry) => entry.url)
}

/**
 * Build the six persisted URL fields after a successful rescue.
 *
 * A candidate proven permanently gone is cleared. Transiently blocked or
 * untested candidates are preserved because silence/access denial is not proof
 * of death. The successful candidate remains in its semantic field and becomes
 * final_url; an application/apply endpoint is mirrored across both apply fields.
 */
export function restoredUrlFields(row = {}, result = {}, outcome = {}, url = null) {
  const permanentRoles = new Set(
    (Array.isArray(result?.outcomes) ? result.outcomes : [])
      .filter((entry) => PERMANENT_HTTP_CODES.has(Number(entry?.code)))
      .map((entry) => String(entry?.role || ''))
      .filter(Boolean),
  )
  const keep = (role) => permanentRoles.has(role) ? null : (row?.[role] || null)
  const restored = {
    application_url: keep('application_url'),
    apply_url: keep('apply_url'),
    apply_guidelines_url: keep('apply_guidelines_url'),
    source_url: keep('source_url'),
    evidence_url: keep('evidence_url'),
    final_url: url || null,
  }

  switch (outcome?.role) {
    case 'application_url':
    case 'apply_url':
      restored.application_url = url
      restored.apply_url = url
      break
    case 'apply_guidelines_url':
      restored.apply_guidelines_url = url
      break
    case 'source_url':
      restored.source_url = url
      break
    case 'evidence_url':
      restored.evidence_url = url
      break
    default:
      break
  }
  return restored
}

function parseContactInfo(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value }
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function preservedOsmContactInfo(row = {}, stableUrl = null) {
  const contact = parseContactInfo(row.contact_info)
  const website = contact.website || candidateUrls(row).find((url) => {
    if (url === stableUrl) return false
    try { return new URL(url).hostname.toLowerCase() !== 'www.openstreetmap.org' } catch { return false }
  })
  if (website) contact.website = website
  return Object.keys(contact).length ? JSON.stringify(contact) : null
}

export function failureClass(result = {}) {
  const code = Number(result.code)
  const error = String(result.error || '').toLowerCase()
  if (error.includes('no_candidate_url')) return 'no_candidate_url'
  if (code === 404 || code === 410) return 'permanent_http_gone'
  if (code === 401 || code === 403) return 'access_or_bot_block'
  if (code === 429) return 'rate_limited'
  if (code >= 500 && code <= 599) return 'remote_5xx'
  if (code >= 400 && code <= 499) return 'other_4xx'
  if (/timeout|abort/.test(error)) return 'timeout'
  if (/enotfound|eai_again|dns/.test(error)) return 'dns'
  if (/certificate|tls|ssl/.test(error)) return 'tls'
  if (/fetch failed|network|socket|reset|connect/.test(error)) return 'network'
  if (String(result.status || '').toLowerCase() === 'skipped') return 'verification_skipped'
  return 'unknown'
}

function semanticResourceKind(row) {
  const result = String(row?.result_kind || '').toLowerCase()
  if (result === 'school_portal') return 'school_portal'
  if (result === 'action_step' || result === 'referral') return 'referral'
  if (result === 'directory' || result === 'past_award_intel') return 'directory'
  return null
}

export async function reclassifyBrokenResources(db) {
  const { yes, no } = bools(db)
  let osm = 0
  let semantic = 0

  const osmRows = await db.prepare(`
    SELECT id, source_id, application_url, source_url, final_url, contact_info
      FROM funding_opportunities
     WHERE LOWER(COALESCE(source, '')) = 'osm_overpass'
       AND COALESCE(opportunity_kind, 'direct') IN ('direct', 'benefit')
  `).all()
  const updateOsm = db.prepare(`
    UPDATE funding_opportunities
       SET opportunity_kind = 'directory', result_kind = 'directory',
           type = 'DIRECTORY', opportunity_type = 'directory',
           record_origin = 'directory_resource',
           source_trust_tier = 'community_directory', contact_info = ?,
           application_url = ?, source_url = ?, evidence_url = ?, final_url = NULL,
           link_status = 'unverified', link_status_code = NULL,
           last_verified_at = NULL, verification_method = NULL,
           verified_by = 'link-repair:osm-resource', verification_error = NULL,
           http_status = NULL, is_hidden = ?, is_active = ?, status = 'active'
     WHERE id = ?
  `)
  for (const row of osmRows || []) {
    const url = osmElementUrl(row.source_id)
    if (!url) continue
    const contactInfo = preservedOsmContactInfo(row, url)
    osm += countChanges(await updateOsm.run(contactInfo, url, url, url, no, yes, row.id))
  }

  const rows = await db.prepare(`
    SELECT id, result_kind
      FROM funding_opportunities
     WHERE COALESCE(opportunity_kind, 'direct') IN ('direct', 'benefit')
       AND LOWER(COALESCE(result_kind, '')) IN
           ('action_step','directory','referral','school_portal','past_award_intel')
  `).all()
  const updateResource = db.prepare(`
    UPDATE funding_opportunities
       SET opportunity_kind = ?, type = 'DIRECTORY', opportunity_type = ?,
           source_trust_tier = COALESCE(source_trust_tier, 'verified_directory')
     WHERE id = ?
  `)
  for (const row of rows || []) {
    const kind = semanticResourceKind(row)
    if (!kind || !RESOURCE_RESULTS.has(String(row.result_kind || '').toLowerCase())) continue
    semantic += countChanges(await updateResource.run(kind, kind, row.id))
  }
  return { osm, semantic }
}

function terminalFailureSet(outcomes = [], entries = []) {
  // No usable URL is a terminal catalog defect. Otherwise, permanent retirement
  // requires EVERY distinct candidate to return a definitive 404/410. A 401/403,
  // rate limit, timeout, DNS/TLS/network error, 5xx, or skipped probe is not proof
  // that a public program is gone and must remain retryable in quarantine.
  if (entries.length === 0) return true
  return outcomes.length === entries.length && outcomes.every((outcome) => PERMANENT_HTTP_CODES.has(Number(outcome.code)))
}

async function probeRow(row, timeoutMs) {
  const entries = candidateUrlEntries(row)
  const outcomes = []
  for (const entry of entries) {
    let last = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = Date.now()
      const result = await checkUrl(entry.url, { timeoutMs })
      last = { ...result, url: entry.url, role: entry.role, duration_ms: Date.now() - started }
      if (SUCCESS.has(String(result.status || '').toLowerCase())) {
        return { success: true, terminal: false, outcome: last, outcomes: [...outcomes, last] }
      }
      if (PERMANENT_HTTP_CODES.has(Number(result.code)) || result.status === 'skipped') break
    }
    if (last) outcomes.push(last)
  }
  const outcome = outcomes.at(-1) || {
    status: 'broken', code: null, method: null, error: 'no_candidate_url',
    url: null, role: null, duration_ms: 0,
  }
  return {
    success: false,
    terminal: terminalFailureSet(outcomes, entries),
    outcome,
    outcomes,
  }
}

async function rescueOfficialUrl(row, findOfficialUrlImpl) {
  const started = Date.now()
  const rescue = await findOfficialUrlImpl({ title: row.title, sponsor: row.sponsor })
  if (!rescue?.url) {
    return {
      rescued: false,
      searched: rescue?.searched === true,
      unavailable: rescue?.searched === false,
      hits: Number(rescue?.hits || 0),
    }
  }
  const probe = rescue.probe || {}
  return {
    rescued: true,
    searched: true,
    unavailable: false,
    hits: Number(rescue?.hits || 0),
    outcome: {
      status: SUCCESS.has(String(probe.status || '').toLowerCase()) ? probe.status : 'ok',
      code: probe.code ?? 200,
      method: probe.method || 'official_search',
      error: null,
      finalUrl: probe.finalUrl || rescue.url,
      url: rescue.url,
      role: 'source_url',
      duration_ms: Date.now() - started,
    },
  }
}

async function concurrentMap(rows, concurrency, fn) {
  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < rows.length) {
      const index = cursor
      cursor += 1
      await fn(rows[index])
    }
  }))
}

export async function brokenDirectSummary(db) {
  const row = await db.prepare(`
    SELECT
      SUM(CASE WHEN link_status='broken' AND COALESCE(status,'active')='active'
                    AND COALESCE(is_active,TRUE)=TRUE AND COALESCE(is_hidden,FALSE)=FALSE THEN 1 ELSE 0 END) visible,
      SUM(CASE WHEN link_status='broken' AND COALESCE(status,'active')='active'
                    AND (COALESCE(is_hidden,FALSE)=TRUE OR COALESCE(is_active,TRUE)=FALSE) THEN 1 ELSE 0 END) quarantined,
      SUM(CASE WHEN link_status='broken' AND status='paused' THEN 1 ELSE 0 END) repair_pending,
      SUM(CASE WHEN link_status='skipped' AND verification_error LIKE ? THEN 1 ELSE 0 END) retired
      FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN ('direct','benefit')
  `).get(`${RETIRED_MARKER}%`)
  return {
    visible: Number(row?.visible || 0),
    quarantined: Number(row?.quarantined || 0),
    repair_pending: Number(row?.repair_pending || 0),
    retired: Number(row?.retired || 0),
  }
}

export async function repairBrokenDirectBatch(db, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 40))
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8))
  const timeoutMs = Math.max(3000, Math.min(20000, Number(options.timeoutMs) || 10000))
  const cycleId = String(options.cycleId || '').trim() || null
  const verifiedBy = String(options.verifiedBy || (cycleId ? `link-backlog-repair:${cycleId}` : 'link-backlog-repair'))
  const pendingRetryAfterMs = Math.max(
    5 * 60 * 1000,
    Math.min(30 * 24 * 60 * 60 * 1000, Number(options.pendingRetryAfterMs) || 24 * 60 * 60 * 1000),
  )
  const pendingRetryCutoff = new Date(Date.now() - pendingRetryAfterMs).toISOString()
  const findOfficialUrlImpl = options.findOfficialUrlImpl || findOfficialUrlForOpportunity
  const { yes, no } = bools(db)
  const before = await brokenDirectSummary(db)
  const reclassified = await reclassifyBrokenResources(db)

  // Quarantine every broken direct row, but claim only the selected batch as
  // paused. Untouched rows remain active-status quarantine, not fake pending work.
  await db.prepare(`
    UPDATE funding_opportunities
       SET is_hidden=?, is_active=?
     WHERE COALESCE(opportunity_kind,'direct') IN ('direct','benefit')
       AND link_status='broken' AND COALESCE(status,'active') <> 'expired'
  `).run(yes, no)

  // link_backlog_selected_row_claim: active quarantine drains first. Fresh
  // retryable rows wait for the bounded retry window; cycle IDs never exclude them.
  const rows = await db.prepare(`
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
  `).all(pendingRetryCutoff, limit)

  const stats = {
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
  const claimSelected = db.prepare(`
    UPDATE funding_opportunities
       SET is_hidden=?, is_active=?, status='paused'
     WHERE id=? AND link_status='broken' AND COALESCE(status,'active') <> 'expired'
  `)
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
  const restore = db.prepare(`
    UPDATE funding_opportunities
       SET application_url=?, apply_url=?, apply_guidelines_url=?,
           source_url=?, evidence_url=?, final_url=?, last_verified_at=?, link_status=?,
           link_status_code=?, verification_method=?, verified_by=?, verification_error=NULL,
           http_status=?, is_hidden=?, is_active=?, status='active'
     WHERE id=?
  `)
  const retire = db.prepare(`
    UPDATE funding_opportunities
       SET last_verified_at=?, link_status='skipped', link_status_code=?,
           verification_method=?, verified_by=?, verification_error=?,
           final_url=COALESCE(?,final_url), http_status=?,
           is_hidden=?, is_active=?, status='expired'
     WHERE id=?
  `)
  const keepPending = db.prepare(`
    UPDATE funding_opportunities
       SET last_verified_at=?, link_status='broken', link_status_code=?,
           verification_method=?, verified_by=?, verification_error=?,
           final_url=COALESCE(?,final_url), http_status=?,
           is_hidden=?, is_active=?, status='paused'
     WHERE id=?
  `)

  // link_backlog_row_error_isolation: one provider, probe, or DB failure
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
        const fields = restoredUrlFields(row, result, outcome, url)
        rowStats.restored = countChanges(await restore.run(
          fields.application_url,
          fields.apply_url,
          fields.apply_guidelines_url,
          fields.source_url,
          fields.evidence_url,
          fields.final_url,
          at,
          outcome.status === 'verified' ? 'ok' : outcome.status,
          outcome.code ?? null,
          outcome.method ?? 'get',
          verifiedBy,
          typeof outcome.code === 'number' ? outcome.code : null,
          no,
          yes,
          row.id,
        ))
        finalStatus = outcome.status === 'verified' ? 'ok' : outcome.status
      } else {
        const kind = failureClass(outcome)
        fail(kind)
        if (result.terminal) {
          rowStats.retired = countChanges(await retire.run(
            at, outcome.code ?? null, outcome.method ?? null, verifiedBy,
            `${RETIRED_MARKER}${kind}:${String(outcome.error || '').slice(0,120)}`,
            outcome.finalUrl ?? null, typeof outcome.code === 'number' ? outcome.code : null,
            yes, no, row.id,
          ))
          finalStatus = 'skipped'
        } else {
          rowStats.pending = countChanges(await keepPending.run(
            at, outcome.code ?? null, outcome.method ?? null, verifiedBy,
            `retryable_after_recheck:${kind}:${String(outcome.error || '').slice(0,120)}`,
            outcome.finalUrl ?? null, typeof outcome.code === 'number' ? outcome.code : null,
            yes, no, row.id,
          ))
        }
      }
    } catch (error) {
      rowStats.row_errors += 1
      fail('repair_exception')
      const message = String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 120)
      outcome = {
        status: 'broken', code: null, method: 'repair_exception', error: message,
        finalUrl: null, url: null, role: null, duration_ms: 0,
      }
      try {
        rowStats.pending = countChanges(await keepPending.run(
          nowIso(), null, 'repair_exception', verifiedBy,
          `retryable_after_recheck:repair_exception:${message}`,
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

  return { ok: true, before, ...stats, after: await brokenDirectSummary(db) }
}

export default {
  brokenDirectSummary,
  candidateUrlEntries,
  candidateUrls,
  failureClass,
  osmElementUrl,
  preservedOsmContactInfo,
  restoredUrlFields,
  reclassifyBrokenResources,
  repairBrokenDirectBatch,
}
