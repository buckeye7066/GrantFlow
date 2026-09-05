/**
 * Link Verification Service
 *
 * Authoritative source of truth for whether an opportunity URL is currently
 * reachable. Crawlers MAY perform an opportunistic HEAD at ingest, but only
 * this service is allowed to set last_verified_at to "now" without further
 * review.
 *
 * Runs as a background task — does NOT block any request path.
 *
 * Records, per opportunity:
 *   link_status        – ok | redirect | suspicious | broken | skipped | unverified
 *   link_status_code   – HTTP status code (null when no response)
 *   verification_method– 'head' | 'get' | 'manual' | 'crawler:<name>' | null
 *   verified_by        – which run/job/worker performed the check
 *   verification_error – text of the last error (broken only)
 *   last_verified_at   – ISO timestamp (only when status is ok|redirect|broken|skipped)
 *
 * Direct (non-directory) opportunities marked broken twice in a row are
 * deactivated so they stop showing up in user-facing results, regardless of
 * any cached 'last_verified_at'. Directories are never deactivated — they may
 * be flagged but the front-end can still render them with a clear label.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { LINK_VERIFICATION_SKIP_DOMAINS, isPlaceholderUrl, assertSsrfSafeUrl } from '../config/urlRules.js'
import { safeFetch, discardResponseBody, SsrfBlockedError } from './http/safeFetch.js'
import {
  isPointerOpportunityRow,
  linkLifecycleOpportunitySql,
  pointerOpportunityRowSql,
} from '../config/linkLifecycleKinds.js'

const REQUEST_TIMEOUT_MS = 10_000
const BATCH_SIZE = 10
const BATCH_DELAY_MS = 2_000
const REVERIFY_AFTER_DAYS = 30
// Refresh before the hard mission cutoff. Selecting only after day 30 creates
// an unavoidable readiness-red window between recurring verifier ticks.
const REVERIFY_LEAD_DAYS = 2
const REVERIFY_DUE_AFTER_DAYS = Math.max(1, REVERIFY_AFTER_DAYS - REVERIFY_LEAD_DAYS)
// After this many days without a successful re-verification, a direct
// opportunity is considered stale and hidden from user-facing results.
const STALE_AFTER_DAYS = 90
const RETIRED_MARKER = 'retired_after_definitive_recheck:'
const SCHEDULED_RETRY_MARKER = 'retry_scheduled_after_bounded_recheck:'
const NON_RESTORABLE_LIFECYCLE_STATUSES = Object.freeze([
  'expired',
  'deadline_expired',
  'deadline_passed',
  'retired',
  'permanently_retired',
  'quarantined',
])
const NON_RESTORABLE_STATUS_SQL = NON_RESTORABLE_LIFECYCLE_STATUSES
  .map((status) => `'${status}'`)
  .join(', ')

/**
 * A URL probe may update/restore only a non-terminal lifecycle row. The
 * predicate is repeated on every mutating statement so a concurrent deadline
 * expiry or permanent retirement wins the race.
 */
export function mutableLinkLifecycleSql(alias = '') {
  const prefix = alias ? `${alias}.` : ''
  return `LOWER(COALESCE(${prefix}status, 'active')) NOT IN (${NON_RESTORABLE_STATUS_SQL})
    AND LOWER(COALESCE(${prefix}link_status, 'unverified')) NOT IN (${NON_RESTORABLE_STATUS_SQL})
    AND COALESCE(${prefix}verification_error, '') NOT LIKE '${RETIRED_MARKER}%'
    AND (
      ${pointerOpportunityRowSql(alias)}
      OR ${prefix}deadline IS NULL
      OR LOWER(COALESCE(${prefix}deadline_type, 'unknown')) IN ('rolling', 'ongoing')
      OR ${prefix}deadline >= CURRENT_DATE
    )`
}

export function rowLifecycleIsMutable(row = {}) {
  const status = String(row.status || 'active').trim().toLowerCase()
  const linkStatus = String(row.link_status || 'unverified').trim().toLowerCase()
  if (NON_RESTORABLE_LIFECYCLE_STATUSES.includes(status)) return false
  if (NON_RESTORABLE_LIFECYCLE_STATUSES.includes(linkStatus)) return false
  if (String(row.verification_error || '').startsWith(RETIRED_MARKER)) return false
  if (isPointerOpportunityRow(row)) return true
  const deadlineType = String(row.deadline_type || 'unknown').toLowerCase()
  if (!row.deadline || deadlineType === 'rolling' || deadlineType === 'ongoing') return true
  const deadline = String(row.deadline).slice(0, 10)
  return deadline >= new Date().toISOString().slice(0, 10)
}

const SUCCESSFUL_LINK_STATUSES = new Set(['ok', 'redirect', 'verified'])

function rowIsHidden(row = {}) {
  const v = row.is_hidden
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true'
}

/**
 * A row that is HIDDEN while carrying a successful link_status and NO
 * verification marker of any kind has no recorded reason to be hidden. Prod
 * 2026-09-05: 10,427 active rows (http 200, verified within the window,
 * verification_error empty, status active, reality verified) sat hidden while
 * 86% of every profile's match rows pointed at them — and they were
 * unreachable by construction: the candidate query only re-probes broken /
 * never-verified / stale rows, and the restore guard only heals a retryable
 * quarantine, so a fresh successful probe could never have restored them
 * either. Such a row is treated as RETRYABLE: it is re-probed, and a current
 * successful probe restores it. An independent quarantine still records
 * itself (a verification_error marker, a paused/quarantined status) and is
 * still refused here.
 */
export function isUnexplainedHiddenSuccess(row = {}) {
  if (!rowIsHidden(row)) return false
  if (!SUCCESSFUL_LINK_STATUSES.has(String(row.link_status || '').toLowerCase())) return false
  return String(row.verification_error || '').trim() === ''
}

function isRetryableLinkQuarantine(row = {}) {
  const status = String(row.link_status || 'unverified').toLowerCase()
  if (status === 'broken' || status === 'unverified' || status === 'suspicious') return true
  if (isUnexplainedHiddenSuccess(row)) return true
  return status === 'skipped' && String(row.verification_error || '').startsWith(SCHEDULED_RETRY_MARKER)
}

function shouldSkipUrl(url) {
  if (!url || typeof url !== 'string') return true
  if (isPlaceholderUrl(url)) return true
  try {
    const parsed = new URL(url)
    return LINK_VERIFICATION_SKIP_DOMAINS.some((d) => parsed.hostname.includes(d))
  } catch {
    return true
  }
}

/**
 * Append-only audit row for the verification_events table. Used by:
 *   * runLinkVerification (recurring job)
 *   * opportunityInserter bulk + single insert paths
 *
 * The table is best-effort: if the schema migration has not yet run (in-memory
 * test DBs that build their own schema), silently no-op. Verification itself
 * remains correct regardless of whether the audit row got persisted.
 */
export async function recordVerificationEvent(db, event = {}) {
  if (!db || typeof db.prepare !== 'function') return
  try {
    const stmt = db.prepare(`
      INSERT INTO verification_events
        (opportunity_id, source, url, link_status, link_status_code,
         verification_method, verified_by, verification_error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    await stmt.run(
      event.opportunity_id ?? null,
      event.source ?? null,
      event.url ?? null,
      event.link_status ?? null,
      event.link_status_code ?? null,
      event.verification_method ?? null,
      event.verified_by ?? null,
      event.verification_error ?? null,
      event.duration_ms ?? null,
    )
  } catch (err) {
    const msg = String(err?.message || err)
    // Table missing in test DBs — never blow up the verification path on
    // audit-log failures. Log loudly enough that a real schema regression in
    // production still gets noticed.
    if (msg.includes('no such table') || msg.includes('does not exist')) {
      return
    }
    console.warn('[verification-events] insert failed:', msg)
  }
}

/**
 * Probe a single URL with HEAD. Falls back to GET when the server rejects
 * HEAD (some hosts return 403/405 for HEAD even though the page is reachable).
 * Never throws — returns a structured outcome.
 *
 * Exported so the insert path (opportunityInserter) can gate persistence on
 * URL liveness instead of waiting for the 30-day background re-verification.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs] - per-request timeout (default 10s)
 * @returns {Promise<{ status: 'ok'|'redirect'|'suspicious'|'broken'|'skipped', code: number|null, method: string|null, error: string|null }>}
 */
// Minimal two-part public-suffix list for registrable-host comparison. An
// unlisted two-part suffix mis-groups CONSERVATIVELY (two different <x>.co.uk
// sites compare equal → 'ok'), so growing this list only ever ADDS precision.
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'com.au', 'org.au', 'gov.au', 'edu.au',
  'com.br', 'org.br', 'com.mx', 'co.nz', 'org.nz',
  'co.in', 'org.in', 'co.za', 'org.za', 'com.sg',
])

function registrableHost(hostname) {
  const labels = String(hostname || '').toLowerCase().replace(/\.$/, '').split('.')
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  const take = TWO_PART_TLDS.has(lastTwo) ? 3 : 2
  return labels.slice(-take).join('.')
}

/**
 * Given a 2xx probe outcome, decide whether the settled location structurally
 * contradicts the requested one. Returns a reason string when suspicious,
 * null when the success is trustworthy. Only the strong signature fires:
 * the chain crossed to a DIFFERENT registrable host AND settled on that
 * host's root/homepage (path depth ≤ 1 with no query). Everything else —
 * same-site redirects, www/protocol changes, cross-host redirects to a deep
 * program path — stays 'ok'. Exported for tests.
 */
export function classifySuccessfulProbe(requestedUrl, finalUrl) {
  if (!finalUrl || typeof finalUrl !== 'string') return null
  let from, to
  try {
    from = new URL(requestedUrl)
    to = new URL(finalUrl)
  } catch {
    return null
  }
  const fromHost = registrableHost(from.hostname)
  const toHost = registrableHost(to.hostname)
  if (!fromHost || !toHost || fromHost === toHost) return null
  const path = to.pathname.replace(/\/+$/, '')
  const depth = path.split('/').filter(Boolean).length
  const isHomepageish = depth <= 1 && !to.search
  if (!isHomepageish) return null
  return `redirected_off_host_to_homepage:${toHost}`
}

export async function checkUrl(url, opts = {}) {
  if (shouldSkipUrl(url)) {
    return { status: 'skipped', code: null, method: null, error: null }
  }

  // SSRF guard: these URLs come from untrusted ingested/KB-extracted data. Refuse
  // to probe anything that resolves to a private/loopback/link-local address so a
  // crafted application_url can't make us scan internal services (and we follow
  // redirects below, so only fetch hosts we've cleared here).
  const ssrf = await assertSsrfSafeUrl(url)
  if (!ssrf.ok) {
    return { status: 'skipped', code: null, method: null, error: `ssrf_blocked:${ssrf.reason}` }
  }

  // Bound whatever the caller passes: `checkUrl` is exported and reused by
  // several callers (some derive `timeoutMs` from an admin-supplied request
  // body several layers up), so this shared choke point must not trust an
  // unbounded value even when a specific caller already clamps its own copy
  // — an untrusted, very large timeout ties up a fetch/timer for a long time
  // per call (resource exhaustion).
  const timeoutMs = Number.isFinite(opts?.timeoutMs)
    ? Math.max(1000, Math.min(60_000, opts.timeoutMs))
    : REQUEST_TIMEOUT_MS

  const tryProbe = async (method) => {
    try {
      // safeFetch re-validates EVERY redirect hop. The previous
      // `fetch(..., { redirect: 'follow' })` cleared only the first URL, so a
      // crawled page answering `302 -> 169.254.169.254` walked straight past
      // the guard above. It also enforces the per-request timeout.
      const res = await safeFetch(url, {
        method,
        headers: {
            // browser-compatible liveness probe: transparent product token plus
            // normal document headers avoids false 403/404 results from servers
            // that reject bare programmatic HEAD requests.
            'User-Agent': 'Mozilla/5.0 (compatible; GrantFlowLinkVerifier/2.0; +https://app.axiombiolabs.org)',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
      }, { timeoutMs, fetchImpl: opts.fetchImpl })
      // safeFetch stamps the post-redirect URL it actually settled on.
      const finalUrl = res.grantflowFinalUrl
        || (typeof res.url === 'string' && res.url ? res.url : url)
      const code = res.status
      await discardResponseBody(res)
      return { code, error: null, finalUrl, ssrfBlocked: false }
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        // We refused to look. That is NOT evidence the link is dead, so it must
        // never be reported as 'broken' — doing so would deactivate a possibly
        // healthy opportunity on the strength of our own policy decision.
        return { code: null, error: err.message, finalUrl: null, ssrfBlocked: true }
      }
      return { code: null, error: err?.message || String(err), finalUrl: null, ssrfBlocked: false }
    }
  }

  let outcome = await tryProbe('HEAD')
  let method = 'head'

  // Some servers ban HEAD entirely. Retry with GET when HEAD comes back as
  // method-not-allowed / forbidden so we don't mark a working page as broken.
  if (!outcome.ssrfBlocked && (outcome.code === null || outcome.code < 200 || outcome.code >= 400)) {
    outcome = await tryProbe('GET')
    method = 'get'
  }

  if (outcome.ssrfBlocked) {
    return { status: 'skipped', code: null, method, error: outcome.error, finalUrl: null }
  }

  if (outcome.code !== null && outcome.code !== undefined) {
    if (outcome.code >= 200 && outcome.code < 300) {
      // A 200 is not unconditional proof the PROGRAM page is alive. The one
      // structural signal we can read without a body is where the redirect
      // chain SETTLED: landing on a different registrable host's homepage is
      // the parked-domain / program-retired-to-homepage signature (epic slice
      // 2: "never display a generic funder homepage as an open direct
      // application"). Deliberately conservative — a same-site redirect or a
      // cross-host redirect to a DEEP path stays 'ok'; suspicious rows are
      // demoted from default library results but NEVER deactivated (that
      // remains the broken path's two-strike job).
      const suspicion = classifySuccessfulProbe(url, outcome.finalUrl)
      if (suspicion) {
        return {
          status: 'suspicious',
          code: outcome.code,
          method,
          error: suspicion,
          finalUrl: outcome.finalUrl,
        }
      }
      return { status: 'ok', code: outcome.code, method, error: null, finalUrl: outcome.finalUrl }
    }
    if (outcome.code >= 300 && outcome.code < 400) {
      return { status: 'redirect', code: outcome.code, method, error: null, finalUrl: outcome.finalUrl }
    }
    return {
      status: 'broken',
      code: outcome.code,
      method,
      error: `HTTP ${outcome.code}`,
      finalUrl: outcome.finalUrl,
    }
  }

  return { status: 'broken', code: null, method, error: outcome.error, finalUrl: null }
}

/**
 * Verify ONE opportunity's link RIGHT NOW and persist the verdict through the
 * same columns + audit event the recurring sweep writes (one write path, no
 * drift). For rows whose stale 'broken' mark is actively BLOCKING something —
 * the Hamilton stop-recheck class (2026-07-27): an insert-time HEAD probe
 * failed once (bot-block/timeout), stamped link_status='broken' WITH
 * last_verified_at set, so the recurring sweep won't revisit for the
 * re-verify window while trust blocks every task on the row the whole time.
 *
 * @returns {Promise<{status:string, code:number|null, updated:boolean}>}
 */
export async function verifyOpportunityLinkNow(db, oppRow, { verifiedBy = 'stop-recheck' } = {}) {
  if (!db || !oppRow?.id) return { status: 'skipped', code: null, updated: false }
  let current
  try {
    current = await db.prepare(`
      SELECT id, application_url, source_url, opportunity_kind, result_kind,
             opportunity_type, type, status, deadline, deadline_type,
             link_status, verification_error, is_hidden
        FROM funding_opportunities
       WHERE id = ?
    `).get(String(oppRow.id))
  } catch {
    return { status: 'skipped', code: null, updated: false }
  }
  const url = current?.application_url || current?.source_url || null
  if (!url || !rowLifecycleIsMutable(current)) {
    return { status: 'skipped', code: null, updated: false }
  }

  const startMs = Date.now()
  const result = await checkUrl(url)
  if (result.status === 'skipped') return { status: 'skipped', code: null, updated: false }

  let updated = false
  try {
    const write = await db.prepare(`
      UPDATE funding_opportunities
      SET last_verified_at = ?,
          link_status = ?,
          link_status_code = ?,
          verification_method = ?,
          verified_by = ?,
          verification_error = ?,
          final_url = COALESCE(?, final_url),
          http_status = COALESCE(?, http_status)
      WHERE id = ?
        AND ${mutableLinkLifecycleSql()}
    `).run(
      new Date().toISOString(),
      result.status,
      result.code,
      result.method,
      verifiedBy,
      result.error,
      result.finalUrl ?? null,
      typeof result.code === 'number' ? result.code : null,
      String(oppRow.id),
    )
    updated = Number(write?.changes ?? write?.rowCount ?? 0) > 0
    if (updated && (result.status === 'ok' || result.status === 'redirect') && isRetryableLinkQuarantine(current)) {
      const isPostgres = db?.dialect === 'postgres'
      const falseVal = isPostgres ? false : 0
      const trueVal = isPostgres ? true : 1
      await db.prepare(`
        UPDATE funding_opportunities
           SET is_hidden = ?, is_active = ?,
               status = CASE WHEN status = 'paused' THEN 'active' ELSE status END
         WHERE id = ?
           AND link_status IN ('ok', 'redirect', 'verified')
           AND ${mutableLinkLifecycleSql()}
      `).run(falseVal, trueVal, String(oppRow.id))
    }
  } catch {
    return { status: result.status, code: result.code, updated: false }
  }

  try {
    await recordVerificationEvent(db, {
      opportunity_id: oppRow.id,
      url,
      link_status: result.status,
      link_status_code: result.code,
      verification_method: result.method,
      verified_by: verifiedBy,
      verification_error: result.error,
      duration_ms: Date.now() - startMs,
    })
  } catch { /* audit is best-effort, same as the sweep */ }

  return { status: result.status, code: result.code, updated }
}

/**
 * Verify a batch of opportunities that have not been checked recently or have
 * never been verified at all.
 *
 * @param {object} db - database instance
 * @param {object} options
 * @param {number} options.limit - max records to check per run (default 100)
 * @param {string} options.verifiedBy - identifier for who/what triggered the run
 * @returns {Promise<{ checked, ok, broken, redirect, skipped, deactivated, expired }>}
 */
export async function quarantineUnverifiedDirectOpportunities(db) {
  if (!db || typeof db.prepare !== 'function') {
    return { ok: false, quarantined: 0, deactivated: 0, restored: 0, reason: 'database_unavailable' }
  }

  const isPostgres = db?.dialect === 'postgres'
  const trueVal = isPostgres ? true : 1
  const falseVal = isPostgres ? false : 0
  const changes = (result) => Number(result?.changes ?? result?.rowCount ?? 0)
  // Mission health defines a visible direct row as every non-pointer catalog
  // row, including legacy/unknown kind spellings. Quarantine must use the same
  // denominator or malformed-but-visible rows can keep /readyz red forever.
  const visibleDirectPredicate = linkLifecycleOpportunitySql()
  const freshnessCutoff = new Date(
    Date.now() - REVERIFY_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const staleMarker = `stale_reverification_required:${freshnessCutoff}`

  try {
    // A formerly successful probe is not current proof forever. Move only
    // VISIBLE stale direct rows into the same retryable state as an unchecked
    // row. Preserve last_verified_at as historical evidence; the verifier will
    // replace it and restore visibility only after a current successful probe.
    // Already-hidden rows are left untouched so an independent quarantine can
    // never be erased by this freshness repair.
    const staleSuccessful = await db
      .prepare(
        "UPDATE funding_opportunities SET is_hidden = ?, link_status = 'unverified', verification_error = ? WHERE " +
        visibleDirectPredicate +
        " AND COALESCE(is_hidden, ?) = ? AND LOWER(TRIM(COALESCE(link_status, ''))) IN ('ok', 'redirect', 'verified')" +
        ' AND last_verified_at IS NOT NULL AND last_verified_at < ?' +
        ` AND ${mutableLinkLifecycleSql()}`,
      )
      .run(trueVal, staleMarker, falseVal, falseVal, freshnessCutoff)

    const quarantined = await db
      .prepare(
        'UPDATE funding_opportunities SET is_hidden = ? WHERE ' + visibleDirectPredicate +
        // proof-based startup quarantine: only a timestamped successful probe
        // may keep a lifecycle row visible. skipped, null, stale-claimed,
        // unknown, and future noncanonical statuses all fail closed.
        " AND COALESCE(is_hidden, ?) = ? AND (COALESCE(link_status, 'unverified') NOT IN ('ok', 'redirect', 'verified') OR last_verified_at IS NULL)" +
        ` AND ${mutableLinkLifecycleSql()}`,
      )
      .run(trueVal, falseVal, falseVal)

    // Broken direct targets get both the soft quarantine and the hard active-row
    // kill switch so older readers that only filter is_active still fail closed.
    const deactivated = await db
      .prepare(
        'UPDATE funding_opportunities SET is_active = ? WHERE ' + visibleDirectPredicate +
        " AND COALESCE(is_active, ?) = ? AND link_status = 'broken'" +
        ` AND ${mutableLinkLifecycleSql()}`,
      )
      .run(falseVal, trueVal, trueVal)

    return {
      ok: true,
      quarantined: changes(staleSuccessful) + changes(quarantined),
      deactivated: changes(deactivated),
      // SQL-only startup state cannot prove that a hidden row was hidden by a
      // retryable link failure rather than an independent quarantine. Only a
      // current successful probe that observed the prior failure may restore.
      restored: 0,
      reason: null,
    }
  } catch (error) {
    return {
      ok: false,
      quarantined: 0,
      deactivated: 0,
      restored: 0,
      reason: 'quarantine_failed',
      error: error?.message || String(error),
    }
  }
}

export async function runLinkVerification(
  db,
  { limit = 100, verifiedBy = 'recurring-verifier', fetchImpl } = {},
) {
  // Normalize visibility before selecting work so a visible stale success is
  // selected back as retryable/unverified and can be restored by this same run.
  // Selecting first left the in-memory row at status=ok, which made the restore
  // guard preserve its new quarantine even after the fresh probe succeeded.
  const quarantine = await quarantineUnverifiedDirectOpportunities(db)
  if (!quarantine?.ok) {
    console.warn('[link-verify] quarantine pass failed:', quarantine?.reason || 'unknown')
  }

  // Select successful rows before their proof expires. The quarantine cutoff
  // remains the hard 30-day mission boundary; this earlier due cutoff provides
  // enough runway for bounded batches, retries, and scheduler jitter.
  const cutoff = new Date(Date.now() - REVERIFY_DUE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const hiddenTrueSql = db?.dialect === 'postgres' ? 'TRUE' : '1'
  const hiddenFalseSql = db?.dialect === 'postgres' ? 'FALSE' : '0'
  // A hidden row with a successful status and no verification marker is a
  // quarantine nobody recorded; it is re-probed so a current success can
  // restore it (see isUnexplainedHiddenSuccess).
  const unexplainedHiddenSuccessSql = `(COALESCE(is_hidden, ${hiddenFalseSql}) = ${hiddenTrueSql}
              AND LOWER(COALESCE(link_status, '')) IN ('ok', 'redirect', 'verified')
              AND COALESCE(verification_error, '') = '')`

  const rows = await db
    .prepare(
      `
        SELECT id, application_url, source_url, type, opportunity_type,
               opportunity_kind, result_kind, last_verified_at, link_status,
               verification_error, status, deadline, deadline_type, is_hidden
        FROM funding_opportunities
        WHERE (application_url IS NOT NULL OR source_url IS NOT NULL)
            AND NOT (
              link_status = 'skipped'
              AND COALESCE(verification_error, '') LIKE 'retired_after_definitive_recheck:%'
            )
            AND COALESCE(is_active, TRUE) = TRUE
            AND (link_status = 'broken' OR last_verified_at IS NULL OR last_verified_at < ?
                 OR ${unexplainedHiddenSuccessSql})
            AND ${mutableLinkLifecycleSql()}
          ORDER BY CASE WHEN link_status = 'broken' THEN 0
                        WHEN ${unexplainedHiddenSuccessSql} THEN 1
                        ELSE 2 END,
                   (last_verified_at IS NULL) DESC, last_verified_at ASC
        LIMIT ?
      `,
    )
    .all(cutoff, limit)

  const stats = {
    checked: 0,
    ok: 0,
    broken: 0,
    skipped: 0,
    redirect: 0,
    unverified: 0,
    deactivated: 0,
    expired: 0,
    quarantined: 0,
    restored: 0,
  }

  const update = db.prepare(`
    UPDATE funding_opportunities
    SET last_verified_at = ?,
        link_status = ?,
        link_status_code = ?,
        verification_method = ?,
        verified_by = ?,
        verification_error = ?,
        final_url = COALESCE(?, final_url),
        http_status = COALESCE(?, http_status)
    WHERE id = ?
      AND ${mutableLinkLifecycleSql()}
  `)

  // Soft-hide for broken direct opps (separate from is_active; allows admin
  // views to surface them via allowHidden, while normal users don't see them).
  const hide = db.prepare(`
      UPDATE funding_opportunities
      SET is_hidden = ?
      WHERE id = ? AND ${mutableLinkLifecycleSql()}
    `)

  const deactivate = db.prepare(`
    UPDATE funding_opportunities
    SET is_active = ?
    WHERE id = ? AND ${mutableLinkLifecycleSql()}
  `)

  const isPostgres = db?.dialect === 'postgres'
  const falseVal = isPostgres ? false : 0
  const trueVal = isPostgres ? true : 1
  // link_repair_success_restores_visibility: current proof heals only a row
  // that was quarantined by a retryable link
  // failure. A successful recheck of an independently hidden row must not
  // silently undo the separate quarantine.
  const restoreVerifiedVisibility = async (row) => {
    if (!isRetryableLinkQuarantine(row)) return 0
    const result = await db.prepare(`
      UPDATE funding_opportunities
         SET is_hidden = ?, is_active = ?,
             status = CASE WHEN status = 'paused' THEN 'active' ELSE status END
       WHERE id = ?
         AND link_status IN ('ok', 'redirect', 'verified')
         AND ${mutableLinkLifecycleSql()}
    `).run(falseVal, trueVal, row.id)
    return Number(result?.changes ?? result?.rowCount ?? 0)
  }

  if (quarantine?.ok) {
    stats.quarantined += Number(quarantine.quarantined || 0)
    stats.deactivated += Number(quarantine.deactivated || 0)
    stats.restored += Number(quarantine.restored || 0)
  }

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    await Promise.all(
      batch.map(async (row) => {
        const url = row.application_url || row.source_url
        const startMs = Date.now()
        const result = await checkUrl(url, { fetchImpl })
        const durationMs = Date.now() - startMs
        const now = new Date().toISOString()
        const persisted = await update.run(
          now,
          result.status,
          result.code,
          result.method,
          verifiedBy,
          result.error,
          result.finalUrl ?? null,
          typeof result.code === 'number' ? result.code : null,
          row.id,
        )
        const didPersist = Number(persisted?.changes ?? persisted?.rowCount ?? 0) > 0
        stats.checked++
        stats[result.status] = (stats[result.status] || 0) + 1

        if (didPersist && (result.status === 'ok' || result.status === 'redirect')) {
          try {
            stats.restored += await restoreVerifiedVisibility(row)
          } catch (err) {
            console.warn('[link-verify] restore verified row failed for', row.id, err?.message)
          }
        }

        // Append-only audit log of every probe (mission dashboard input).
        await recordVerificationEvent(db, {
          opportunity_id: row.id,
          url,
          link_status: result.status,
          link_status_code: result.code,
          verification_method: result.method,
          verified_by: verifiedBy,
          verification_error: result.error,
          duration_ms: durationMs,
        })

        // Direct (non-directory) broken opportunities should not stay visible.
        // Prefer the explicit result_kind column when set; fall back to
        // legacy heuristics for older rows.
        if (
          didPersist &&
          result.status === 'broken' &&
          !isPointerOpportunityRow(row)
        ) {
          try {
            // is_hidden is the soft signal consumer queries filter on; deactivate
            // is the hard kill-switch that strips it from active=1 paths.
            await hide.run(isPostgres ? true : 1, row.id)
            await deactivate.run(falseVal, row.id)
            stats.deactivated++
          } catch (err) {
            console.warn('[link-verify] hide/deactivate failed for', row.id, err?.message)
          }
        }
      }),
    )
    if (i + BATCH_SIZE < rows.length) await sleep(BATCH_DELAY_MS)
  }

  // Expire direct opportunities that have not been successfully verified in
  // STALE_AFTER_DAYS — either their last verification confirmed broken, or
  // they have been sitting un-checked since discovery for longer than the
  // staleness window. Directories are pointers and remain visible.
  const staleCutoff = new Date(
    Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  try {
    const result = await db
      .prepare(
        `
          UPDATE funding_opportunities
          SET is_active = ?, is_hidden = ?
          WHERE is_active = ?
            AND ${linkLifecycleOpportunitySql()}
            AND link_status IN ('broken', 'unverified')
            AND COALESCE(last_verified_at, discovered_at, created_at) < ?
            AND ${mutableLinkLifecycleSql()}
        `,
      )
      .run(falseVal, isPostgres ? true : 1, isPostgres ? true : 1, staleCutoff)
    stats.expired = Number(result?.changes ?? result?.rowCount ?? 0)
  } catch (err) {
    console.warn('[link-verify] stale expiry pass failed:', err?.message)
  }

  // Close the write-time race: a probe can downgrade a previously visible
  // direct row to suspicious/skipped/unverified. Re-apply the exact mission
  // visibility invariant after all verdicts are persisted so /readyz never
  // observes a non-successful direct row left visible by this run.
  const postProbeQuarantine = await quarantineUnverifiedDirectOpportunities(db)
  if (postProbeQuarantine?.ok) {
    stats.quarantined += Number(postProbeQuarantine.quarantined || 0)
    stats.deactivated += Number(postProbeQuarantine.deactivated || 0)
  } else {
    console.warn('[link-verify] post-probe quarantine failed:', postProbeQuarantine?.reason || 'unknown')
  }

  return stats
}

/**
 * Get summary of link health across all opportunities.
 */
export function getLinkHealthSummary(db) {
  return db
    .prepare(
      `
        SELECT link_status, COUNT(*) as count
        FROM funding_opportunities
        GROUP BY link_status
      `,
    )
    .all()
}

export const REVERIFY_AFTER_DAYS_CONST = REVERIFY_AFTER_DAYS
export const REVERIFY_LEAD_DAYS_CONST = REVERIFY_LEAD_DAYS
export const STALE_AFTER_DAYS_CONST = STALE_AFTER_DAYS
