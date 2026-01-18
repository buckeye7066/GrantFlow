#!/usr/bin/env node
/**
 * Run the "live" crawler implementations for every profile in the local sqlite DB.
 *
 * Why this exists:
 * - The production-facing "real crawlers" are implemented in `backend/services/crawlers/*`.
 * - This script runs them directly (no auth / no server required) and prints a concise summary.
 *
 * Usage:
 *   node ./scripts/run-live-crawlers-all-profiles.mjs
 *
 * Optional env:
 * - DATABASE_URL: path to sqlite db (defaults to backend/data/grantflow.db)
 * - CRAWLER_TIMEOUT_MS: per-crawler timeout (default 20000)
 * - MAX_PROFILES: limit profiles processed (default: no limit)
 */

import path from 'node:path'
import Database from 'better-sqlite3'

import { getProfileWithLocation } from '../backend/services/crawlers/crawlerHelpers.js'
import { crawlLocalFunding } from '../backend/services/crawlers/localFundingCrawler.js'
import { crawlGovernmentFunding } from '../backend/services/crawlers/governmentFundingCrawler.js'
import { crawlStudentGrants } from '../backend/services/crawlers/studentGrantsCrawler.js'
import { crawlECFBenefits } from '../backend/services/crawlers/ecfBenefitsCrawler.js'
import { crawlItemFunding } from '../backend/services/crawlers/itemFundingCrawler.js'
import { crawlSpecialNeeds } from '../backend/services/crawlers/specialNeedsCrawler.js'

const dbPath =
  process.env.DATABASE_URL || path.join(process.cwd(), 'backend', 'data', 'grantflow.db')

const CRAWLER_TIMEOUT_MS = Number.parseInt(process.env.CRAWLER_TIMEOUT_MS || '20000', 10) || 20000
const MAX_PROFILES_RAW = process.env.MAX_PROFILES
const MAX_PROFILES =
  MAX_PROFILES_RAW && String(MAX_PROFILES_RAW).trim()
    ? Math.max(1, Number.parseInt(String(MAX_PROFILES_RAW), 10) || 0)
    : null

function nowIso() {
  return new Date().toISOString()
}

function withTimeout(promise, ms, label) {
  let t = null
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`)
      err.code = 'TIMEOUT'
      reject(err)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (t) clearTimeout(t)
  })
}

function normalizeRows(result) {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object' && Array.isArray(result.opportunities)) {
    return result.opportunities
  }
  return []
}

function scoreOf(row) {
  return row?.match_score ?? row?.matchScore ?? null
}

function sortByScoreDesc(rows) {
  return rows.sort((a, b) => (scoreOf(b) ?? 0) - (scoreOf(a) ?? 0))
}

function formatTop(rows, limit = 3) {
  return rows.slice(0, limit).map((r) => ({
    title: r?.title ?? null,
    sponsor: r?.sponsor ?? null,
    match_score: scoreOf(r),
    deadline: r?.deadline ?? null,
    state: r?.state ?? null,
    url: r?.url ?? r?.application_url ?? r?.source_url ?? null,
    crawler_type: r?.crawler_type ?? null,
    source: r?.source ?? null,
  }))
}

function defaultItemRequestForProfile(profile) {
  const type = String(profile?.primary_type || '').toLowerCase()
  if (type.includes('business') || type.includes('organization') || type.includes('nonprofit')) {
    return 'equipment'
  }
  return 'vehicle'
}

async function runOne(profile, label, fn) {
  const started = Date.now()
  try {
    const result = await withTimeout(fn(), CRAWLER_TIMEOUT_MS, label)
    const rows = sortByScoreDesc(normalizeRows(result))
    return {
      ok: true,
      duration_ms: Date.now() - started,
      count: rows.length,
      top: formatTop(rows),
    }
  } catch (error) {
    return {
      ok: false,
      duration_ms: Date.now() - started,
      error: error?.message ?? String(error),
    }
  }
}

async function main() {
  const db = new Database(dbPath)
  try {
    const profiles = db
      .prepare('SELECT id, display_name, primary_type, status FROM profiles ORDER BY display_name')
      .all()

    const selected = MAX_PROFILES ? profiles.slice(0, MAX_PROFILES) : profiles

    console.log(
      JSON.stringify(
        {
          started_at: nowIso(),
          dbPath,
          total_profiles: profiles.length,
          running_profiles: selected.length,
          crawler_timeout_ms: CRAWLER_TIMEOUT_MS,
        },
        null,
        2,
      ),
    )

    const allResults = []

    for (const row of selected) {
      const profileId = row.id
      const profile = await getProfileWithLocation(db, profileId)
      const itemRequest = defaultItemRequestForProfile(profile)

      const summary = {
        profile_id: profileId,
        display_name: profile?.display_name ?? row.display_name ?? null,
        primary_type: profile?.primary_type ?? row.primary_type ?? null,
        status: row.status ?? null,
        location: profile?.signals?.location ?? null,
        keyword_count: profile?.signals?.keywordSet?.size ?? null,
        crawlers: {},
      }

      summary.crawlers.local_funding = await runOne(profile, 'local_funding', () =>
        crawlLocalFunding(profile, { min_match_score: 50 }),
      )
      summary.crawlers.government_funding = await runOne(profile, 'government_funding', () =>
        crawlGovernmentFunding(profile, { min_match_score: 50 }),
      )
      summary.crawlers.student_grants = await runOne(profile, 'student_grants', () =>
        crawlStudentGrants(profile, { min_match_score: 50 }),
      )
      summary.crawlers.ecf_benefits = await runOne(profile, 'ecf_benefits', () =>
        crawlECFBenefits(profile, { min_match_score: 50 }),
      )
      summary.crawlers.item_matching = await runOne(profile, 'item_matching', () =>
        crawlItemFunding(profile, { item_request: itemRequest }),
      )
      summary.crawlers.special_needs = await runOne(profile, 'special_needs', () =>
        crawlSpecialNeeds(profile, { min_match_score: 50 }),
      )

      allResults.push(summary)

      const line = {
        profile: summary.display_name,
        id: summary.profile_id,
        state: summary.location?.state ?? null,
        zip: summary.location?.zip ?? null,
        local: summary.crawlers.local_funding.ok ? summary.crawlers.local_funding.count : 'ERR',
        govt: summary.crawlers.government_funding.ok ? summary.crawlers.government_funding.count : 'ERR',
        student: summary.crawlers.student_grants.ok ? summary.crawlers.student_grants.count : 'ERR',
        ecf: summary.crawlers.ecf_benefits.ok ? summary.crawlers.ecf_benefits.count : 'ERR',
        item: summary.crawlers.item_matching.ok ? summary.crawlers.item_matching.count : 'ERR',
        special: summary.crawlers.special_needs.ok ? summary.crawlers.special_needs.count : 'ERR',
      }
      console.log(JSON.stringify(line))
    }

    console.log(
      JSON.stringify(
        {
          finished_at: nowIso(),
          results: allResults,
        },
        null,
        2,
      ),
    )
  } finally {
    db.close()
  }
}

main().catch((err) => {
  console.error('[run-live-crawlers-all-profiles] FAILED', err?.message ?? err)
  process.exitCode = 1
})

