/**
 * adminCrawlCoverageActions.js — Admin-only, MUTATING companion to
 * adminCrawlCoverage.js (which documents itself as read-only and must stay
 * that way). This file exists solely so the CrawlCoverage dashboard's "stale
 * sources" list can offer a real remediation action ("Run now") without
 * breaking that read-only contract.
 *
 * POST /api/admin/crawl-coverage-actions/run-source
 *   Kicks off ONE targeted, bounded Crawler OS discovery run scoped to a
 *   single registry source_id — the same runProfileDiscoveryLive() code path
 *   the nightly/login/on-demand discovery lanes already use, just narrowed via
 *   the `onlySourceIds` option (backend/crawler-os/pipeline.js) so a stale
 *   source can be refreshed without fanning out into a full multi-source
 *   crawl (and without touching matching/scoring logic at all — narrowing
 *   which registry sources run is orthogonal to how candidates are scored).
 *
 * Scope is deliberately narrow:
 *   - source_id must resolve in the Crawler OS registry (backend/crawler-os/
 *     sourceRegistry.js) — the one the live pipeline actually consults. The
 *     admin coverage report's "stale sources" list is built from the older
 *     `services/sourceRegistry.js` catalog, whose ids don't all have a
 *     Crawler OS equivalent; a source with none returns an honest
 *     `source_not_crawlable` (never a silent no-op).
 *   - profile_id is optional; when omitted, the single most-recently-active
 *     profile is used so the action is always bounded to ONE profile x ONE
 *     source, never a fleet-wide sweep.
 *   - The open-web search+LLM lane is skipped for this run (see
 *     runProfileDiscoveryLive's onlySourceIds handling) — it is a separate,
 *     unbounded discovery mechanism not keyed to any one registry source.
 *   - Bounded wall-clock: mirrors the /api/real-crawlers gateway-budget
 *     pattern so this never hangs a request past Vercel's proxy deadline; an
 *     overrun reports `partial: true` while the crawl keeps running and
 *     persisting in the background.
 */

import express from 'express'
import { ensureAdmin } from '../middleware/auth.js'
import { standardRateLimiter } from '../middleware/rateLimiting.js'
import { runProfileDiscoveryLive } from '../services/crawlerOsService.js'
import { getSource as getCrawlerOsSource } from '../crawler-os/sourceRegistry.js'
import { resolveCrawlerOsSourceId } from '../services/sourceRegistryParity.js'
import { createLogger } from '../utils/logger.js'

const routeLogger = createLogger('route:adminCrawlCoverageActions')
const router = express.Router()

// Same gateway-safe budget shape as backend/routes/realCrawlers.js — a single
// -source run is small, but the shared deadline protects against a slow
// upstream fetch stalling the admin request past Vercel's ~30s proxy cutoff.
const RUN_SOURCE_BUDGET_MS = Number(process.env.ADMIN_RUN_SOURCE_BUDGET_MS) || 20000
const RUN_SOURCE_TIMEOUT = Symbol('run-source-timeout')

async function withBudget(fn, budgetMs) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(RUN_SOURCE_TIMEOUT), Math.max(1, budgetMs))
    if (typeof timer?.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([Promise.resolve().then(fn), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * POST /api/admin/crawl-coverage-actions/run-source
 * body: { source_id: string, profile_id?: string }
 */
router.post('/run-source', ensureAdmin, standardRateLimiter, async (req, res) => {
  const sourceId = String(req.body?.source_id || '').trim()
  if (!sourceId) {
    return res.status(400).json({ error: 'source_id is required' })
  }

  // The dashboard row carries a DISPLAY registry id; the engine only knows its
  // own ids. Seven display ids are the SAME source under a renamed id (see
  // sourceRegistryParity.js) — resolving them here is why "Run now" on e.g.
  // sam_gov_assistance_listings stops 404ing when the sam_gov lane exists.
  const resolvedSourceId = resolveCrawlerOsSourceId(sourceId) ?? sourceId
  const source = getCrawlerOsSource(resolvedSourceId)
  if (!source) {
    // Honest, not silent: this source_id (likely from the legacy display
    // registry) has no Crawler OS adapter/registry row, so there is nothing
    // this action can actually run. Never claim a crawl happened.
    return res.status(404).json({
      error: 'source_not_crawlable',
      message: `"${sourceId}" has no Crawler OS registry entry — nothing to run for it yet.`,
      source_id: sourceId,
    })
  }

  const db = req.db
  let profileId = req.body?.profile_id ? String(req.body.profile_id).trim() : null

  try {
    if (profileId) {
      const row = await db.prepare('SELECT id FROM profiles WHERE id = ? LIMIT 1').get(profileId)
      if (!row) {
        return res.status(404).json({ error: 'profile_not_found', profile_id: profileId })
      }
    } else {
      const row = await db
        .prepare(`SELECT id FROM profiles WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`)
        .get()
      profileId = row?.id ?? null
      if (!profileId) {
        return res.status(404).json({ error: 'no_active_profile', message: 'No active profile available to scope this run to.' })
      }
    }

    const outcome = await withBudget(
      () => runProfileDiscoveryLive({ db, profileId, onlySourceIds: [resolvedSourceId] }),
      RUN_SOURCE_BUDGET_MS,
    )

    if (outcome === RUN_SOURCE_TIMEOUT) {
      routeLogger.warn(`[adminCrawlCoverageActions] run-source ${sourceId} for profile ${profileId} exceeded budget; continues in background`)
      return res.json({
        success: true,
        partial: true,
        timed_out: true,
        source_id: sourceId,
        profile_id: profileId,
        message: 'Crawl is still running in the background — check back shortly for updated results.',
      })
    }

    // run.sources is keyed by the ENGINE id, so look the summary up by the id
    // that actually ran — an aliased display id would never match here.
    const sourceRunSummary =
      (outcome?.run?.sources ?? []).find((s) => s.source_id === resolvedSourceId) ?? null

    return res.json({
      success: true,
      partial: false,
      source_id: sourceId,
      profile_id: profileId,
      outcome: sourceRunSummary?.outcome ?? null,
      found: sourceRunSummary?.stored ?? 0,
      rejected: sourceRunSummary?.rejected ?? 0,
    })
  } catch (err) {
    routeLogger.error(`[adminCrawlCoverageActions] run-source ${sourceId} failed: ${err?.message ?? err}`)
    return res.status(500).json({ error: 'run_source_failed', message: err?.message || String(err) })
  }
})

export default router
