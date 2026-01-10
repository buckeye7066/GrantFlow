import path from 'path'
import { promises as fs } from 'fs'
import crypto from 'crypto'

import { scrubPII } from '../../utils/piiScrubber.js'
import { getProfileWithLocation } from '../crawlers/crawlerHelpers.js'
import { upsertFundingOpportunity } from '../opportunityInserter.js'

import { crawlLocalFunding } from '../crawlers/localFundingCrawler.js'
import { crawlGovernmentFunding } from '../crawlers/governmentFundingCrawler.js'
import { crawlStudentGrants } from '../crawlers/studentGrantsCrawler.js'
import { crawlECFBenefits } from '../crawlers/ecfBenefitsCrawler.js'
import { crawlItemFunding } from '../crawlers/itemFundingCrawler.js'
import { crawlSpecialNeeds } from '../crawlers/specialNeedsCrawler.js'

const REPO_ROOT = path.resolve(process.cwd())

function isoDay() {
  return new Date().toISOString().slice(0, 10)
}

function nowIso() {
  return new Date().toISOString()
}

function newRunId() {
  return crypto.randomUUID()
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex')
}

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function isValidEvidenceUrl(url) {
  if (!url) return false
  const u = String(url)
  if (!/^https?:\/\//i.test(u)) return false
  if (u.includes('example.com') || u.includes('example.org') || u.includes('placeholder')) return false
  return true
}

function withTimeout(promise, timeoutMs, label = 'operation') {
  if (!timeoutMs || timeoutMs <= 0) return promise
  let timeout
  const t = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise.finally(() => clearTimeout(timeout)), t])
}

function recordTypeFor(opportunityType) {
  const t = String(opportunityType || '').toLowerCase()
  if (t === 'benefit' || t === 'program') return 'PROGRAM'
  if (t === 'directory') return 'DIRECTORY'
  return 'OPPORTUNITY'
}

function normalizeForUpsert(raw, { crawlerType, profile, runId }) {
  const url = raw?.url || raw?.application_url || raw?.source_url || raw?.link || null
  const evidenceUrl = isValidEvidenceUrl(raw?.evidence_url) ? raw.evidence_url : url

  const categories = ensureArray(raw?.categories)
  const keywords = ensureArray(raw?.keywords)
  const eligibilityBullets =
    ensureArray(raw?.eligibility_bullets).length
      ? ensureArray(raw?.eligibility_bullets)
      : ensureArray(raw?.eligibility || raw?.eligibility_criteria)

  const opportunityType =
    raw?.opportunity_type ||
    (crawlerType === 'student_grants' ? 'scholarship' : null) ||
    (crawlerType === 'ecf_benefits' ? 'benefit' : null) ||
    'grant'

  const stableSourceId = sha256(`${crawlerType}|${url || ''}|${raw?.title || ''}|${raw?.sponsor || ''}`)

  // NOTE: we intentionally persist to the GLOBAL pool (profile_id NULL) for "opportunities page"
  return {
    source: `real_crawlers:${crawlerType}`,
    source_id: stableSourceId,
    title: raw?.title || 'Funding opportunity',
    sponsor: raw?.sponsor || raw?.funder || null,
    description: raw?.description || raw?.summary || null,
    application_url: url,
    source_url: url,
    evidence_url: evidenceUrl,
    last_verified_at: nowIso(),
    record_origin: 'live_crawl',
    type: recordTypeFor(opportunityType),
    opportunity_type: opportunityType,
    // derive state/national deterministically in opportunityInserter
    state: raw?.state || profile?.state || null,
    is_national: raw?.is_national === true || raw?.state === 'nationwide',
    categories,
    keywords,
    eligibility_bullets: eligibilityBullets,
    requires_match: raw?.requires_match === true || raw?.requires_match === 1,
    requires_501c3: raw?.requires_501c3 === true || raw?.requires_501c3 === 1,
    match_reasons: ensureArray(raw?.match_reasons),
    notes: `real_crawlers_run=${runId}`,
    profile_id: null,
  }
}

async function auditLog(entry) {
  const auditDir = path.join(REPO_ROOT, 'backend', 'data', 'audit')
  await fs.mkdir(auditDir, { recursive: true })
  const logFile = path.join(auditDir, 'anya-real-crawlers.log')
  const safe = scrubPII(JSON.stringify({ timestamp: nowIso(), ...entry })) + '\n'
  await fs.appendFile(logFile, safe, 'utf8')
}

function ensureRunTables(db) {
  // best-effort: schema.sql should create these, but older DBs may not have executed schema recently.
  db.exec(`
    CREATE TABLE IF NOT EXISTS real_crawler_runs (
      run_id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      status TEXT NOT NULL,
      initiated_by TEXT,
      profiles_targeted INTEGER DEFAULT 0,
      crawler_types TEXT DEFAULT '[]',
      min_match_score INTEGER DEFAULT 80,
      persist_global INTEGER DEFAULT 1,
      dry_run INTEGER DEFAULT 0,
      total_found INTEGER DEFAULT 0,
      total_saved_global INTEGER DEFAULT 0,
      total_updated_global INTEGER DEFAULT 0,
      total_skipped INTEGER DEFAULT 0,
      total_errors INTEGER DEFAULT 0,
      artifact_path TEXT,
      summary TEXT,
      metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS real_crawler_run_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      run_id TEXT NOT NULL,
      profile_id TEXT,
      crawler_type TEXT,
      event_type TEXT NOT NULL,
      message TEXT,
      metadata TEXT DEFAULT '{}'
    );
  `)
}

function crawlerFnFor(type) {
  switch (type) {
    case 'local_funding':
      return crawlLocalFunding
    case 'government_funding':
      return crawlGovernmentFunding
    case 'student_grants':
      return crawlStudentGrants
    case 'ecf_benefits':
      return crawlECFBenefits
    case 'item_matching':
      return crawlItemFunding
    case 'special_needs':
      return crawlSpecialNeeds
    default:
      return null
  }
}

export async function runRealCrawlersAcrossProfiles(
  {
    profileIds = null,
    crawlerTypes = [
      'local_funding',
      'government_funding',
      'student_grants', // scholarships
      'ecf_benefits',
      'item_matching',
      'special_needs',
    ],
    minMatchScore = 80,
    persistGlobal = true,
    dryRun = false,
    maxProfiles = null,
    timeoutMsPerCrawler = 25_000,
    maxSavedPerCrawlerPerProfile = 50,
    itemRequest = null,
  } = {},
  context = {},
) {
  const { db, user } = context
  if (!db) throw new Error('db required')

  ensureRunTables(db)

  const runId = newRunId()
  const startedAt = nowIso()
  const initiatedBy = user?.primary_email || user?.email || user?.id || 'admin'

  const artifactsDir = path.join(REPO_ROOT, 'artifacts', 'real-crawlers', isoDay())
  await fs.mkdir(artifactsDir, { recursive: true })
  const artifactPath = path.join(artifactsDir, `real-crawlers-run.${runId}.json`)

  const insertRun = db.prepare(`
    INSERT INTO real_crawler_runs (
      run_id, started_at, status, initiated_by, profiles_targeted, crawler_types, min_match_score,
      persist_global, dry_run, artifact_path, metadata
    ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertEvent = db.prepare(`
    INSERT INTO real_crawler_run_events (run_id, profile_id, crawler_type, event_type, message, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const profiles = (() => {
    if (Array.isArray(profileIds) && profileIds.length > 0) {
      const placeholders = profileIds.map(() => '?').join(',')
      return db
        .prepare(`SELECT id FROM profiles WHERE id IN (${placeholders}) AND status = 'active'`)
        .all(...profileIds)
        .map((r) => r.id)
    }
    return db.prepare(`SELECT id FROM profiles WHERE status = 'active'`).all().map((r) => r.id)
  })()

  const targetProfiles = Number.isFinite(maxProfiles) && maxProfiles > 0 ? profiles.slice(0, maxProfiles) : profiles

  insertRun.run(
    runId,
    startedAt,
    initiatedBy,
    targetProfiles.length,
    JSON.stringify(crawlerTypes),
    minMatchScore,
    persistGlobal ? 1 : 0,
    dryRun ? 1 : 0,
    artifactPath,
    JSON.stringify({ timeoutMsPerCrawler, maxSavedPerCrawlerPerProfile }),
  )

  await auditLog({ action: 'real_crawlers_run_start', run_id: runId, initiated_by: initiatedBy, profiles: targetProfiles.length, crawler_types: crawlerTypes })

  const report = {
    run_id: runId,
    started_at: startedAt,
    completed_at: null,
    initiated_by: initiatedBy,
    crawler_types: crawlerTypes,
    min_match_score: minMatchScore,
    persist_global: persistGlobal,
    dry_run: dryRun,
    profiles_targeted: targetProfiles.length,
    totals: {
      found: 0,
      saved_global: 0,
      updated_global: 0,
      skipped: 0,
      errors: 0,
    },
    profiles: [],
    artifact_path: artifactPath,
  }

  try {
    for (const profileId of targetProfiles) {
      insertEvent.run(runId, profileId, null, 'profile_start', 'Starting profile', JSON.stringify({ profileId }))

      const profile = getProfileWithLocation(db, profileId)
      if (!profile) {
        report.totals.errors += 1
        insertEvent.run(runId, profileId, null, 'crawler_failure', 'Profile not found', JSON.stringify({ profileId }))
        continue
      }

      const perProfile = {
        profile_id: profileId,
        crawlers: [],
      }

      for (const crawlerType of crawlerTypes) {
        const fn = crawlerFnFor(crawlerType)
        if (!fn) {
          report.totals.errors += 1
          perProfile.crawlers.push({ crawler_type: crawlerType, ok: false, error: 'invalid_crawler_type' })
          insertEvent.run(runId, profileId, crawlerType, 'crawler_failure', 'Invalid crawler type', JSON.stringify({ crawlerType }))
          continue
        }

        insertEvent.run(runId, profileId, crawlerType, 'crawler_start', 'Crawler start', JSON.stringify({ crawlerType }))
        let rawOpps = []
        try {
          const label = `crawler:${crawlerType}`
          if (crawlerType === 'item_matching') {
            rawOpps = await withTimeout(fn(profile, { item_request: itemRequest, min_match_score: minMatchScore }), timeoutMsPerCrawler, label)
          } else {
            rawOpps = await withTimeout(fn(profile, { min_match_score: minMatchScore }), timeoutMsPerCrawler, label)
          }
        } catch (error) {
          report.totals.errors += 1
          perProfile.crawlers.push({ crawler_type: crawlerType, ok: false, error: error.message })
          insertEvent.run(runId, profileId, crawlerType, 'crawler_failure', error.message, JSON.stringify({ crawlerType }))
          continue
        }

        const filtered = ensureArray(rawOpps).filter((o) => Number(o?.match_score ?? 0) >= minMatchScore)
        report.totals.found += ensureArray(rawOpps).length

        let saved = 0
        let updated = 0
        let skipped = 0
        const errors = []

        for (const raw of filtered.slice(0, maxSavedPerCrawlerPerProfile)) {
          const normalized = normalizeForUpsert(raw, { crawlerType, profile, runId })
          const url = normalized?.evidence_url || normalized?.source_url || normalized?.application_url
          if (!persistGlobal) {
            skipped += 1
            continue
          }
          if (!isValidEvidenceUrl(url)) {
            skipped += 1
            insertEvent.run(runId, profileId, crawlerType, 'save_skipped', 'Invalid evidence_url', JSON.stringify({ url }))
            continue
          }

          if (dryRun) {
            saved += 1
            continue
          }

          try {
            const result = upsertFundingOpportunity(db, normalized)
            if (result?.inserted) saved += 1
            else updated += 1
            insertEvent.run(runId, profileId, crawlerType, 'save_success', 'Saved to global pool', JSON.stringify({ id: result?.id, inserted: !!result?.inserted }))
          } catch (error) {
            errors.push(error.message)
            report.totals.errors += 1
            insertEvent.run(runId, profileId, crawlerType, 'save_skipped', error.message, JSON.stringify({ reason: 'db_error' }))
          }
        }

        report.totals.saved_global += saved
        report.totals.updated_global += updated
        report.totals.skipped += skipped

        perProfile.crawlers.push({
          crawler_type: crawlerType,
          ok: true,
          found: ensureArray(rawOpps).length,
          eligible: filtered.length,
          saved_global: saved,
          updated_global: updated,
          skipped,
          errors,
        })

        insertEvent.run(runId, profileId, crawlerType, 'crawler_success', 'Crawler completed', JSON.stringify({ found: ensureArray(rawOpps).length, saved, updated, skipped }))
      }

      report.profiles.push(perProfile)
    }

    report.completed_at = nowIso()
    await fs.writeFile(artifactPath, JSON.stringify(report, null, 2), 'utf8')

    db.prepare(`
      UPDATE real_crawler_runs
      SET completed_at = ?,
          status = 'completed',
          total_found = ?,
          total_saved_global = ?,
          total_updated_global = ?,
          total_skipped = ?,
          total_errors = ?,
          summary = ?
      WHERE run_id = ?
    `).run(
      report.completed_at,
      report.totals.found,
      report.totals.saved_global,
      report.totals.updated_global,
      report.totals.skipped,
      report.totals.errors,
      `profiles=${report.profiles_targeted} saved=${report.totals.saved_global} updated=${report.totals.updated_global} errors=${report.totals.errors}`,
      runId,
    )

    insertEvent.run(runId, null, null, 'run_complete', 'Run completed', JSON.stringify({ totals: report.totals }))
    await auditLog({ action: 'real_crawlers_run_complete', run_id: runId, totals: report.totals, artifact_path: artifactPath })

    return report
  } catch (error) {
    const completedAt = nowIso()
    db.prepare(`
      UPDATE real_crawler_runs
      SET completed_at = ?,
          status = 'failed',
          total_found = ?,
          total_saved_global = ?,
          total_updated_global = ?,
          total_skipped = ?,
          total_errors = ?,
          summary = ?
      WHERE run_id = ?
    `).run(
      completedAt,
      report.totals.found,
      report.totals.saved_global,
      report.totals.updated_global,
      report.totals.skipped,
      report.totals.errors + 1,
      `failed: ${String(error?.message || error)}`,
      runId,
    )
    insertEvent.run(runId, null, null, 'run_complete', 'Run failed', JSON.stringify({ error: String(error?.message || error) }))
    await auditLog({ action: 'real_crawlers_run_failed', run_id: runId, error: String(error?.message || error) })
    throw error
  }
}

export default {
  runRealCrawlersAcrossProfiles,
}

