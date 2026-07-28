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
 *   link_status        – ok | redirect | broken | skipped | unverified
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

const REQUEST_TIMEOUT_MS = 10_000
const BATCH_SIZE = 10
const BATCH_DELAY_MS = 2_000
const REVERIFY_AFTER_DAYS = 30
// After this many days without a successful re-verification, a direct
// opportunity is considered stale and hidden from user-facing results.
const STALE_AFTER_DAYS = 90

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
 * @returns {Promise<{ status: 'ok'|'redirect'|'broken'|'skipped', code: number|null, method: string|null, error: string|null }>}
 */
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

  const timeoutMs = Number.isFinite(opts?.timeoutMs) ? opts.timeoutMs : REQUEST_TIMEOUT_MS

  const tryProbe = async (method) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'GrantFlow-LinkChecker/1.0 (contact: support@grantflow.app)',
        },
      })
      clearTimeout(timer)
      // res.url contains the URL after redirects (whatwg-fetch + node-fetch).
      // Fall back to the original URL when undici declines to surface it.
      const finalUrl = typeof res.url === 'string' && res.url ? res.url : url
      return { code: res.status, error: null, finalUrl }
    } catch (err) {
      clearTimeout(timer)
      return { code: null, error: err?.message || String(err), finalUrl: null }
    }
  }

  let outcome = await tryProbe('HEAD')
  let method = 'head'

  // Some servers ban HEAD entirely. Retry with GET when HEAD comes back as
  // method-not-allowed / forbidden so we don't mark a working page as broken.
  if (outcome.code === 405 || outcome.code === 403 || outcome.code === 501) {
    outcome = await tryProbe('GET')
    method = 'get'
  }

  if (outcome.code !== null && outcome.code !== undefined) {
    if (outcome.code >= 200 && outcome.code < 300) {
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
  const url = oppRow?.application_url || oppRow?.source_url || null
  if (!db || !oppRow?.id || !url) return { status: 'skipped', code: null, updated: false }

  const startMs = Date.now()
  const result = await checkUrl(url)
  if (result.status === 'skipped') return { status: 'skipped', code: null, updated: false }

  try {
    await db.prepare(`
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

  return { status: result.status, code: result.code, updated: true }
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
export async function runLinkVerification(
  db,
  { limit = 100, verifiedBy = 'recurring-verifier' } = {},
) {
  const cutoff = new Date(Date.now() - REVERIFY_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const rows = await db
    .prepare(
      `
        SELECT id, application_url, source_url, type, opportunity_type,
               result_kind, last_verified_at, link_status
        FROM funding_opportunities
        WHERE (application_url IS NOT NULL OR source_url IS NOT NULL)
          AND (last_verified_at IS NULL OR last_verified_at < ?)
        ORDER BY (last_verified_at IS NULL) DESC, last_verified_at ASC
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
  `)

  // Soft-hide for broken direct opps (separate from is_active; allows admin
  // views to surface them via allowHidden, while normal users don't see them).
  const hide = db.prepare(`
    UPDATE funding_opportunities
    SET is_hidden = 1
    WHERE id = ?
  `)

  const deactivate = db.prepare(`
    UPDATE funding_opportunities
    SET is_active = ?
    WHERE id = ?
  `)

  const isPostgres = db?.dialect === 'postgres'
  const falseVal = isPostgres ? false : 0

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    await Promise.all(
      batch.map(async (row) => {
        const url = row.application_url || row.source_url
        const startMs = Date.now()
        const result = await checkUrl(url)
        const durationMs = Date.now() - startMs
        const now = new Date().toISOString()
        await update.run(
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
        stats.checked++
        stats[result.status] = (stats[result.status] || 0) + 1

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
        const resultKindLower = String(row.result_kind || '').toLowerCase()
        const isDirectory =
          resultKindLower === 'directory' ||
          String(row.type || '').toUpperCase() === 'DIRECTORY' ||
          String(row.opportunity_type || '').toLowerCase().includes('directory')
        if (result.status === 'broken' && !isDirectory) {
          try {
            // is_hidden is the soft signal consumer queries filter on; deactivate
            // is the hard kill-switch that strips it from active=1 paths.
            await hide.run(row.id)
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
          SET is_active = ?
          WHERE is_active = ?
            AND (
              UPPER(COALESCE(type, '')) <> 'DIRECTORY'
              AND LOWER(COALESCE(opportunity_type, '')) NOT LIKE '%directory%'
              AND LOWER(COALESCE(result_kind, '')) <> 'directory'
            )
            AND link_status IN ('broken', 'unverified')
            AND COALESCE(last_verified_at, discovered_at, created_at) < ?
        `,
      )
      .run(falseVal, isPostgres ? true : 1, staleCutoff)
    stats.expired = Number(result?.changes ?? result?.rowCount ?? 0)
  } catch (err) {
    console.warn('[link-verify] stale expiry pass failed:', err?.message)
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
export const STALE_AFTER_DAYS_CONST = STALE_AFTER_DAYS
