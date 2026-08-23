/**
 * robertScheduler.js
 *
 * Optional background runner. Disabled by default. The scheduler:
 *   - reads ROBERT_ENABLED, ROBERT_RUN_ON_STARTUP, ROBERT_RUN_ON_SCHEDULE
 *   - runs at most one job at a time (locked by an in-memory flag)
 *   - persists run state via robertRunStore
 *   - never crashes the server if Robert fails
 *   - never blocks app startup
 *
 * Cron syntax intentionally simplified: we only support the
 * "0 H * * *" daily-at-hour pattern and "0 * * * *" hourly. Anything
 * else falls back to "every <ROBERT_INTERVAL_MS or 1 hour>".
 */

import { runRobert } from './robertAgent.js'
import { ROBERT_TRIGGERS } from './robertTypes.js'
import { getRobertConfig } from './robertSafety.js'
import { autoSeedWeakestProfiles } from './robertFundingTraceBridge.js'
import { upsertSourceCandidate } from './robertRunStore.js'
import { runWithSchedulerLock } from '../schedulerLock.js'

let _running = false
let _interval = null
let _stopped = false
let _autoSeedRunning = false
let _autoSeedInterval = null
let _acquireRunning = false
let _acquireInterval = null

/**
 * Start the scheduler if the env says so. Safe to call multiple times.
 */
export function startRobertScheduler({ db, deps = {}, logger = console } = {}) {
  const cfg = getRobertConfig()

  // Funding-trace weak-coverage sweep runs automatically and INDEPENDENTLY of
  // the master ROBERT_ENABLED switch: it only reads vetted public APIs
  // (USASpending / ProPublica) and stages PENDING source candidates for admin
  // review — it never crawls the open web and never publishes. So it self-
  // starts here even when the broader Robert crawl is disabled. Opt out with
  // ROBERT_AUTOSEED_ON_SCHEDULE=false.
  let autoSeedStarted = false
  if (cfg.autoSeedOnSchedule) {
    const intervalMs = parseSchedule(cfg.autoSeedSchedule)
    if (_autoSeedInterval) clearInterval(_autoSeedInterval)
    _autoSeedInterval = setInterval(() => kickOffAutoSeed({ db, cfg, logger }), intervalMs)
    if (typeof _autoSeedInterval.unref === 'function') _autoSeedInterval.unref()
    // Kick off an initial sweep a few minutes after boot so it doesn't wait a
    // full interval — delayed so the schema self-heal + warm-up have settled.
    const initial = setTimeout(() => kickOffAutoSeed({ db, cfg, logger }), 5 * 60 * 1000)
    if (typeof initial.unref === 'function') initial.unref()
    autoSeedStarted = true
  }

  // Source-acquisition cadence — like autoseed, self-starts INDEPENDENTLY of
  // ROBERT_ENABLED: it acquires the predetermined/archetype (+ hub) sources into
  // the catalog through the CANONICAL admission gate and auto-adds qualifiers to
  // profiles. Opt out with ROBERT_ACQUIRE_ON_SCHEDULE=false.
  let acquireStarted = false
  if (cfg.acquireOnSchedule) {
    const intervalMs = parseSchedule(cfg.acquireSchedule)
    if (_acquireInterval) clearInterval(_acquireInterval)
    _acquireInterval = setInterval(() => kickOffAcquire({ db, cfg, logger }), intervalMs)
    if (typeof _acquireInterval.unref === 'function') _acquireInterval.unref()
    const initial = setTimeout(() => kickOffAcquire({ db, cfg, logger }), 7 * 60 * 1000)
    if (typeof initial.unref === 'function') initial.unref()
    acquireStarted = true
  }

  if (!cfg.enabled) {
    const started = autoSeedStarted || acquireStarted
    return { started, reason: started ? 'background_only' : 'robert_disabled' }
  }
  if (!cfg.runOnSchedule && !cfg.runOnStartup) {
    const started = autoSeedStarted || acquireStarted
    return { started, reason: started ? 'background_only' : 'no_runtime_triggers_enabled' }
  }

  if (cfg.runOnStartup) {
    queueMicrotask(() => kickOff({ db, deps, logger, trigger: ROBERT_TRIGGERS.STARTUP }))
  }
  if (cfg.runOnSchedule) {
    const intervalMs = parseSchedule(cfg.schedule)
    if (_interval) clearInterval(_interval)
    _interval = setInterval(() => kickOff({ db, deps, logger, trigger: ROBERT_TRIGGERS.SCHEDULED }), intervalMs)
    if (typeof _interval.unref === 'function') _interval.unref()
  }
  return { started: true }
}

export function stopRobertScheduler() {
  _stopped = true
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
  if (_autoSeedInterval) {
    clearInterval(_autoSeedInterval)
    _autoSeedInterval = null
  }
  if (_acquireInterval) {
    clearInterval(_acquireInterval)
    _acquireInterval = null
  }
}

async function kickOff({ db, deps, logger, trigger }) {
  if (_stopped || _running) return
  _running = true
  try {
    // Automation-first: a SCHEDULED/STARTUP Robert run should actually DISCOVER,
    // not just analyze coverage. Previously this passed mode:null → runRobert
    // fell back to cfg.mode (ROBERT_MODE, default 'observe'), so the recurring
    // scheduler never ran the Crawler-OS discovery pipeline and Robert silently
    // did nothing on its own cadence. We now default the scheduled mode to
    // 'full-cycle' (the canonical discover→match→recommend run) unless the
    // operator explicitly pins ROBERT_SCHEDULED_MODE. On-demand/API runs are
    // unaffected (they pass their own mode). The OS pipeline is SSRF-safe and
    // self-throttling, and an empty run now degrades honestly.
    await runWithSchedulerLock(db, {
      lockName: 'robert:discovery',
      ttlMs: 2 * 60 * 60 * 1000,
      logger,
    }, async () => {
      const scheduledMode = (process.env.ROBERT_SCHEDULED_MODE || 'full-cycle').toLowerCase()
      const result = await runRobert({ db, deps, trigger, mode: scheduledMode })
      if (logger?.info) logger.info('robert.scheduler.run', { run_id: result?.run_id, mode: result?.mode, status: result?.status, status_reason: result?.status_reason || null })
      return result
    })
  } catch (err) {
    if (logger?.error) logger.error('robert.scheduler.error', { message: String(err?.message || err) })
  } finally {
    _running = false
  }
}

async function kickOffAutoSeed({ db, cfg, logger }) {
  if (_stopped || _autoSeedRunning) return
  _autoSeedRunning = true
  try {
    const result = await runWithSchedulerLock(db, {
      lockName: 'robert:autoseed',
      ttlMs: 60 * 60 * 1000,
      logger,
    }, () => autoSeedWeakestProfiles(db, {
      limit: cfg.autoSeedMaxProfiles,
      maxEntitiesPerProfile: cfg.autoSeedMaxEntitiesPerProfile,
      minRisk: cfg.autoSeedMinRisk,
      deps: { upsert: upsertSourceCandidate },
    }))
    if (logger?.info) {
      logger.info('robert.scheduler.autoseed', {
        evaluated: result?.evaluated,
        weak_profiles: result?.weak_profiles,
        upserted: result?.total_upserted,
      })
    }
  } catch (err) {
    if (logger?.error) logger.error('robert.scheduler.autoseed.error', { message: String(err?.message || err) })
  } finally {
    _autoSeedRunning = false
  }
}

async function kickOffAcquire({ db, cfg, logger }) {
  if (_stopped || _acquireRunning) return
  _acquireRunning = true
  try {
    const result = await runWithSchedulerLock(db, {
      lockName: 'robert:source-acquisition',
      // SHORT ttl + heartbeat so a deploy-killed holder's lock lapses within one
      // ttl (~5 min) instead of orphaning acquisition for a full hour.
      ttlMs: 5 * 60 * 1000,
      heartbeat: true,
      logger,
    }, async () => {
      const { runSourceAcquisitionCycle } = await import('./robertSourceAcquisition.js')
      const deps = cfg.acquireAllowHubs ? { fetchPage: buildHubPageFetcher(cfg) } : {}
      return runSourceAcquisitionCycle(db, { deps, allowHubDecomposition: cfg.acquireAllowHubs })
    })
    if (logger?.info) {
      logger.info('robert.scheduler.acquire', {
        ingested: result?.acquisition?.ingested,
        decomposed_admitted: result?.acquisition?.decomposedAdmitted,
        hubs_decomposed: result?.acquisition?.hubsDecomposed,
        auto_added: result?.parse?.added,
        auto_added_leads: result?.parse?.addedLeads,
      })
    }
  } catch (err) {
    if (logger?.error) logger.error('robert.scheduler.acquire.error', { message: String(err?.message || err) })
  } finally {
    _acquireRunning = false
  }
}

/**
 * Build an SSRF-safe hub-page fetcher for listing decomposition:
 * fetch → cap bytes → text (htmlToText) + a bounded `<a href>` link inventory.
 * Returns null on any failure so a hub is honestly reported unreadable rather
 * than crashing the cadence.
 */
export function buildHubPageFetcher(cfg = {}) {
  return async function fetchHubPage(url) {
    try {
      const { safeFetchOrNull, readTextCapped } = await import('../http/safeFetch.js')
      const { htmlToText } = await import('../webGrantExtractor.js')
      const res = await safeFetchOrNull(url, {
        redirect: 'follow',
        headers: { 'user-agent': cfg.userAgent || 'GrantFlowRobertBot/1.0', accept: 'text/html' },
      }, { timeoutMs: cfg.timeoutMs || 15_000 })
      if (!res || !res.ok) return null
      const html = await readTextCapped(res)
      if (!html) return null
      const links = []
      const seen = new Set()
      const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi
      let m
      while ((m = re.exec(html)) !== null && links.length < 400) {
        let href = m[1]
        try { href = new URL(href, url).toString() } catch { continue }
        if (!/^https?:\/\//i.test(href)) continue
        if (seen.has(href)) continue
        seen.add(href)
        links.push(href)
      }
      let title = null
      const tm = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
      if (tm) title = tm[1].trim().slice(0, 300)
      return { text: htmlToText(html, 12_000), links, title }
    } catch {
      return null
    }
  }
}

/**
 * Convert a cron string to milliseconds (very simplified — we only
 * need correctness for "0 H * * *" daily-at-hour and "0 * * * *"
 * hourly). Returns 1 hour by default.
 */
export function parseSchedule(spec) {
  if (typeof spec !== 'string' || spec.trim().length === 0) return 60 * 60 * 1000
  const parts = spec.trim().split(/\s+/)
  if (parts.length !== 5) return 60 * 60 * 1000
  // "0 * * * *" → hourly
  if (parts[0] === '0' && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return 60 * 60 * 1000
  }
  // "0 H * * *" → daily-at-hour (we approximate as 24h interval)
  const minute = parts[0]
  const hour = parts[1]
  if (minute === '0' && /^\d+$/.test(hour) && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return 24 * 60 * 60 * 1000
  }
  return 60 * 60 * 1000
}

export const __testing__ = { parseSchedule }
