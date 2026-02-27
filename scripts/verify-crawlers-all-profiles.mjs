#!/usr/bin/env node
/**
 * Run all Discover Grants crawlers against each real profile in the DB.
 * Ensures crawlers work optimally with real profile data; reports counts and issues.
 *
 * Run: node scripts/verify-crawlers-all-profiles.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { getProfileWithLocation } from '../backend/services/crawlers/crawlerHelpers.js'
import { buildProfileFacets, requireFacets } from '../backend/services/profile/profileTaxonomy.js'
import { planCrawlerQueries } from '../backend/services/crawlers/queryPlanner.js'
import { crawlLocalFunding } from '../backend/services/crawlers/localFundingCrawler.js'
import { crawlGovernmentFunding } from '../backend/services/crawlers/governmentFundingCrawler.js'
import { crawlStudentGrants } from '../backend/services/crawlers/studentGrantsCrawler.js'
import { crawlHealthResources } from '../backend/services/crawlers/healthResourcesCrawler.js'
import { crawlSpecialNeeds } from '../backend/services/crawlers/specialNeedsCrawler.js'
import { crawlECFBenefits } from '../backend/services/crawlers/ecfBenefitsCrawler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const dbPath = path.join(projectRoot, 'backend', 'data', 'grantflow.db')

const MIN_MATCH_SCORE = 50
const TIMEOUT_MS = 28_000
const MAX_PROFILES = 20

const CRAWLERS = [
  { id: 'local_funding', fn: crawlLocalFunding },
  { id: 'government_funding', fn: crawlGovernmentFunding },
  { id: 'student_grants', fn: crawlStudentGrants },
  { id: 'health_resources', fn: crawlHealthResources },
  { id: 'special_needs', fn: crawlSpecialNeeds },
  { id: 'ecf_benefits', fn: crawlECFBenefits },
]

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms),
    ),
  ])
}

function normalizeState(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  const upper = raw.toUpperCase().replace(/[^A-Z]/g, '')
  return upper.length === 2 ? upper : null
}

async function main() {
  const db = new Database(dbPath, { readonly: false })
  db.pragma('journal_mode = WAL')

  const profileRows = db.prepare(`
    SELECT id, display_name, primary_type, status
    FROM profiles
    WHERE status = 'active' OR status IS NULL
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(MAX_PROFILES)

  if (profileRows.length === 0) {
    console.log('[verify-crawlers-all-profiles] No active profiles found')
    db.close()
    return
  }

  console.log(`[verify-crawlers-all-profiles] Running ${CRAWLERS.length} crawlers for ${profileRows.length} profiles (min_match_score=${MIN_MATCH_SCORE})\n`)

  const summary = { profiles: [], totalByCrawler: Object.fromEntries(CRAWLERS.map((c) => [c.id, 0])), errors: [] }

  for (const row of profileRows) {
    const { id: profileId, display_name: displayName, primary_type: primaryType } = row
    let profile
    try {
      profile = await getProfileWithLocation(db, profileId)
    } catch (err) {
      summary.errors.push({ profileId, stage: 'load', error: err?.message || String(err) })
      console.log(`  [${displayName || profileId}] Load failed: ${err?.message}`)
      continue
    }

    let profileContext = {
      profile,
      sections: profile.sections ?? {},
      signals: profile.signals ?? null,
    }
    try {
      profileContext = buildProfileFacets(profileContext)
      profileContext = requireFacets(profileContext, { strict: false })
    } catch (taxErr) {
      summary.errors.push({ profileId, stage: 'facets', error: taxErr?.message })
    }

    const profileState = normalizeState(profile?.state) || null
    const profileZip = (profile?.zip_code && String(profile.zip_code).trim()) || (profile?.postal_code && String(profile.postal_code).trim()) || null
    const profileCity = (profile?.city && String(profile.city).trim()) || null
    if (profileState || profileZip || profileCity) {
      if (!profileContext.facets) profileContext.facets = {}
      if (!profileContext.facets.geo) profileContext.facets.geo = {}
      if (!profileContext.facets.geo.state && profileState) profileContext.facets.geo.state = profileState
      if (!profileContext.facets.geo.zip && profileZip) profileContext.facets.geo.zip = /^\d{5}/.test(profileZip) ? profileZip.replace(/\D/g, '').slice(0, 5) : profileZip
      if (!profileContext.facets.geo.city && profileCity) profileContext.facets.geo.city = profileCity
      if (profileContext.signals?.location) {
        if (!profileContext.signals.location.state && profileState) profileContext.signals.location.state = profileContext.facets.geo.state
        if (!profileContext.signals.location.zip && profileZip) profileContext.signals.location.zip = profileContext.facets.geo.zip
        if (!profileContext.signals.location.city && profileCity) profileContext.signals.location.city = profileContext.facets.geo.city
      }
    }

    const queryPlan = planCrawlerQueries({
      crawlerType: 'comprehensive',
      facets: profileContext?.facets ?? {},
      location: profileContext?.facets?.geo ?? profileContext?.signals?.location ?? {},
    })
    const effectiveContext = { ...profileContext, queryPlan }

    const profileSummary = { profileId, displayName: displayName || profileId, primaryType: primaryType || null, crawlers: {} }

    for (const { id: crawlerId, fn } of CRAWLERS) {
      try {
        const raw = await withTimeout(fn(effectiveContext, { min_match_score: MIN_MATCH_SCORE }), TIMEOUT_MS, crawlerId)
        const arr = Array.isArray(raw) ? raw : []
        const withUrl = arr.filter((r) => r?.url && String(r.url).startsWith('http'))
        profileSummary.crawlers[crawlerId] = { count: arr.length, withUrl: withUrl.length, error: null }
        summary.totalByCrawler[crawlerId] += arr.length
      } catch (err) {
        profileSummary.crawlers[crawlerId] = { count: 0, withUrl: 0, error: err?.message || String(err) }
        summary.errors.push({ profileId, crawlerId, error: err?.message })
      }
    }

    summary.profiles.push(profileSummary)
    const counts = Object.entries(profileSummary.crawlers).map(([k, v]) => `${k}:${v.count}`).join(', ')
    console.log(`  ${displayName || profileId} (${primaryType || '—'}) → ${counts}`)
  }

  db.close()

  console.log('\n--- Summary by crawler ---')
  for (const [id, total] of Object.entries(summary.totalByCrawler)) {
    console.log(`  ${id}: ${total} total across ${summary.profiles.length} profiles`)
  }
  if (summary.errors.length > 0) {
    console.log('\n--- Errors ---')
    summary.errors.forEach((e) => console.log(`  ${e.profileId}${e.crawlerId ? ` [${e.crawlerId}]` : ''}: ${e.error}`))
  }

  const anyFailed = summary.errors.some((e) => e.crawlerId)
  const allZero = Object.values(summary.totalByCrawler).every((t) => t === 0)
  if (anyFailed || allZero) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[verify-crawlers-all-profiles]', err?.message || err)
  process.exitCode = 1
})
