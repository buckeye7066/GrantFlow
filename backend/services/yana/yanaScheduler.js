/**
 * yanaScheduler.js
 *
 * Optional background runner for Yana, the Client Discoverer (Phase 9 / charter
 * §5). Disabled by default. Mirrors robertScheduler so all agents share the same
 * background-execution contract:
 *   - reads YANA_ENABLED / YANA_RUN_ON_STARTUP / YANA_RUN_ON_SCHEDULE (getYanaConfig)
 *   - runs at most one cycle at a time (in-memory lock — no overlapping runs)
 *   - persists run state via yana_lead_runs (runYanaDiscovery)
 *   - never crashes the server if a cycle fails; never blocks startup
 *   - runs whether or not anyone is logged in
 *
 * Cron syntax is intentionally simplified to match robertScheduler: "0 * * * *"
 * hourly and "0 H * * *" daily; anything else falls back to hourly.
 */

import { runYanaDiscovery, getYanaConfig } from './yanaLeadDiscovery.js'
import { runYanaWebCrawl, getYanaCrawlerConfig, registerConfiguredWebSources } from './yanaWebCrawler.js'
import { runWithSchedulerLock } from '../schedulerLock.js'

let _running = false
let _interval = null
let _stopped = false

/** Convert a simplified cron spec to milliseconds (hourly default). */
export function parseSchedule(spec) {
  if (typeof spec !== 'string' || spec.trim().length === 0) return 60 * 60 * 1000
  const parts = spec.trim().split(/\s+/)
  if (parts.length !== 5) return 60 * 60 * 1000
  if (parts[0] === '0' && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return 60 * 60 * 1000
  }
  const [minute, hour] = parts
  if (minute === '0' && /^\d+$/.test(hour) && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return 24 * 60 * 60 * 1000
  }
  return 60 * 60 * 1000
}

/**
 * Run one Yana discovery cycle under the in-memory lock. Exported so it can be
 * driven deterministically from tests (no microtask/interval racing).
 */
export async function runYanaScheduledCycle({ db, deps = {}, logger = console, trigger = 'scheduled', cfg = getYanaConfig() } = {}) {
  if (_stopped) return { skipped: true, reason: 'stopped' }
  if (_running) return { skipped: true, reason: 'already_running' }
  _running = true
  try {
    return await runWithSchedulerLock(db, {
      lockName: 'yana:discovery',
      ttlMs: 60 * 60 * 1000,
      logger,
    }, async () => {
      // Optional broad-web client discovery first (default OFF, vetted sources
      // only) so freshly-crawled orgs are scored in this same cycle. Best-effort.
      let webCrawl = null
      const crawlerCfg = getYanaCrawlerConfig()
      if (crawlerCfg.enabled && crawlerCfg.sources.length) {
        try {
          registerConfiguredWebSources(crawlerCfg)
          webCrawl = await runYanaWebCrawl(db, { config: crawlerCfg, logger })
          logger?.info?.('yana.scheduler.web_crawl', { inserted: webCrawl?.inserted, sources: webCrawl?.sources_run })
        } catch (crawlErr) {
          logger?.warn?.('yana.scheduler.web_crawl_failed', { message: String(crawlErr?.message || crawlErr) })
        }
      }

      const result = await runYanaDiscovery(db, {
        trigger,
        allowLeads: cfg.allowLeads,
        limit: cfg.limit,
        allowLiveWeb: cfg.allowLiveWeb,
        prospectLimit: cfg.prospectLimit,
        backlogEnrichLimit: cfg.backlogEnrichLimit,
        deps,
      })
      logger?.info?.('yana.scheduler.run', {
        run_id: result?.run_id,
        mode: result?.mode,
        candidates_qualified: result?.candidates_qualified,
        leads_pushed_to_john: result?.leads_pushed_to_john,
      })
      return webCrawl ? { ...result, web_crawl: webCrawl } : result
    })
  } catch (err) {
    logger?.error?.('yana.scheduler.error', { message: String(err?.message || err) })
    return { ok: false, error: String(err?.message || err) }
  } finally {
    _running = false
  }
}

/** Start the scheduler if env opts in. Safe to call multiple times. */
export function startYanaScheduler({ db, deps = {}, logger = console } = {}) {
  const cfg = getYanaConfig()
  if (!cfg.enabled) return { started: false, reason: 'yana_disabled' }
  if (!cfg.runOnSchedule && !cfg.runOnStartup) return { started: false, reason: 'no_runtime_triggers_enabled' }
  _stopped = false

  if (cfg.runOnStartup) {
    queueMicrotask(() => runYanaScheduledCycle({ db, deps, logger, trigger: 'startup', cfg }))
  }
  if (cfg.runOnSchedule) {
    const intervalMs = parseSchedule(cfg.schedule)
    if (_interval) clearInterval(_interval)
    _interval = setInterval(() => runYanaScheduledCycle({ db, deps, logger, trigger: 'scheduled', cfg }), intervalMs)
    if (typeof _interval.unref === 'function') _interval.unref()
  }
  return { started: true }
}

export function stopYanaScheduler() {
  _stopped = true
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
}

export const __testing__ = { parseSchedule, _resetLock: () => { _running = false; _stopped = false } }
