/**
 * Link Verification Service
 *
 * Checks whether opportunity application URLs are still live.
 * Runs as a background task — does NOT block any request path.
 *
 * Uses HEAD requests with a 10s timeout. Marks:
 *   ok       — 2xx response
 *   redirect — 3xx (still reachable, just moved)
 *   broken   — 4xx/5xx or connection failure
 *   skipped  — no URL, placeholder URL, or known-static domain
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { LINK_VERIFICATION_SKIP_DOMAINS, isPlaceholderUrl } from '../config/urlRules.js'

const REQUEST_TIMEOUT_MS = 10_000
const BATCH_SIZE = 10
const BATCH_DELAY_MS = 2_000
const REVERIFY_AFTER_DAYS = 30

function shouldSkipUrl(url) {
  if (!url || typeof url !== 'string') return true
  if (isPlaceholderUrl(url)) return true
  try {
    const parsed = new URL(url)
    return LINK_VERIFICATION_SKIP_DOMAINS.some(d => parsed.hostname.includes(d))
  } catch {
    return true
  }
}

/**
 * HEAD-check a single URL. Exported so the insert path (opportunityInserter)
 * can gate persistence on URL liveness, instead of waiting for the 30-day
 * background re-verification to flag dead links after they're already in the DB.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs] - per-request timeout (default 10s)
 * @returns {Promise<{ status: 'ok'|'redirect'|'broken'|'skipped', code: number|null }>}
 */
export async function checkUrl(url, opts = {}) {
  if (shouldSkipUrl(url)) return { status: 'skipped', code: null }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'GrantFlow-LinkChecker/1.0 (contact: support@grantflow.app)' },
    })
    clearTimeout(timer)
    if (res.status >= 200 && res.status < 300) return { status: 'ok', code: res.status }
    if (res.status >= 300 && res.status < 400) return { status: 'redirect', code: res.status }
    return { status: 'broken', code: res.status }
  } catch (err) {
    clearTimeout(timer)
    return { status: 'broken', code: null }
  }
}

/**
 * Verify a batch of opportunities that haven't been checked recently.
 * @param {object} db - database instance
 * @param {object} options
 * @param {number} options.limit - max records to check per run (default 100)
 * @returns {Promise<{ checked: number, ok: number, broken: number, skipped: number }>}
 */
export async function runLinkVerification(db, { limit = 100 } = {}) {
  const cutoff = new Date(Date.now() - REVERIFY_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const rows = db.prepare(`
    SELECT id, application_url
    FROM funding_opportunities
    WHERE application_url IS NOT NULL
      AND (last_verified_at IS NULL OR last_verified_at < ?)
    ORDER BY last_verified_at ASC NULLS FIRST
    LIMIT ?
  `).all(cutoff, limit)

  const stats = { checked: 0, ok: 0, broken: 0, skipped: 0, redirect: 0 }

  const update = db.prepare(`
    UPDATE funding_opportunities
    SET last_verified_at = ?, link_status = ?, link_status_code = ?
    WHERE id = ?
  `)

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    await Promise.all(batch.map(async (row) => {
      const result = await checkUrl(row.application_url)
      update.run(new Date().toISOString(), result.status, result.code, row.id)
      stats.checked++
      stats[result.status] = (stats[result.status] || 0) + 1
    }))
    if (i + BATCH_SIZE < rows.length) await sleep(BATCH_DELAY_MS)
  }

  return stats
}

/**
 * Get summary of link health across all opportunities.
 */
export function getLinkHealthSummary(db) {
  return db.prepare(`
    SELECT link_status, COUNT(*) as count
    FROM funding_opportunities
    GROUP BY link_status
  `).all()
}
