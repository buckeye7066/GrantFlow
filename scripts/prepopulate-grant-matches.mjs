#!/usr/bin/env node

/**
 * Prepopulates each profile with high-scoring funding opportunities.
 *
 * - Ensures every profile has a linked organization (creates one if missing).
 * - Scores all active funding opportunities against each profile using
 *   profile signals extracted by backend/services/profileHelpers.js.
 * - Inserts opportunities into the grants pipeline until each profile has at least 50,
 *   storing a match score of 85 or higher with concise match reasons.
 * - Updates existing grants for the organization to refresh match scores/reasons.
 *
 * This script is intended for bulk seeding/testing and can be re-run safely; it avoids
 * inserting duplicate grants for the same organization + funding opportunity pair.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'

import { loadProfileContext } from '../backend/services/profileHelpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const dbPath = path.resolve(projectRoot, 'backend', 'data', 'grantflow.db')

if (!fs.existsSync(dbPath)) {
  console.error(`[prepopulate] Database not found at ${dbPath}. Run seed or provide DB_PATH.`)
  process.exit(1)
}

const TARGET_MATCH_SCORE = 85
const TARGET_COUNT = 50

const ALLOWED_APPLICANT_TYPES = new Set([
  'individual_need',
  'family',
  'organization',
  'nonprofit',
  'small_business',
  'student',
  'college_student',
  'high_school_student',
  'medical_assistance',
  'government',
  'other',
])

const APPLICANT_TYPE_MAP = {
  individual: 'individual_need',
  individual_need: 'individual_need',
  family: 'family',
  household: 'family',
  organization: 'organization',
  nonprofit: 'nonprofit',
  small_business: 'small_business',
  ministry: 'nonprofit',
  faith_based: 'nonprofit',
  student: 'student',
  college_student: 'college_student',
  high_school_student: 'high_school_student',
  graduate_student: 'college_student',
  medical_assistance: 'medical_assistance',
  medical: 'medical_assistance',
  veteran: 'individual_need',
  military: 'individual_need',
  church: 'nonprofit',
  ministry_org: 'nonprofit',
}

function resolveApplicantType(primaryType) {
  if (!primaryType) return 'other'
  const normalized = normalizeString(primaryType)
  if (ALLOWED_APPLICANT_TYPES.has(normalized)) {
    return normalized
  }
  const mapped = APPLICANT_TYPE_MAP[normalized]
  if (mapped && ALLOWED_APPLICANT_TYPES.has(mapped)) {
    return mapped
  }
  return 'other'
}

function safeParseJSON(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch (error) {
    console.warn('[prepopulate] Failed to parse JSON field', error)
    return fallback
  }
}

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function collectSectionStrings(sections = {}) {
  const results = new Set()

  const visit = (value) => {
    if (value == null) return
    if (typeof value === 'string') {
      const normalized = value.trim()
      if (normalized) {
        results.add(normalized.toLowerCase())
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(visit)
    }
  }

  Object.values(sections).forEach(visit)

  return Array.from(results)
}

function computeMatchScore(opportunity, context, sectionStrings) {
  const reasons = []
  const keywordMatches = []
  const categoryMatches = []
  const locationReasons = []

  // Extract signals
  const signals = context.signals ?? {}
  const profileState = signals.location?.state
  const locationFocus = normalizeString(
    context.sections?.location_focus?.geographic_focus ?? context.sections?.location_focus?.notes ?? '',
  )

  // Base score
  let score = 65

  if (opportunity.is_national) {
    score += 10
    reasons.push('National coverage')
  }

  if (opportunity.state && profileState) {
    const opportunityState = opportunity.state.trim().toUpperCase()
    if (opportunityState === profileState.trim().toUpperCase()) {
      score += 15
      locationReasons.push(`Matches profile state (${profileState.trim().toUpperCase()})`)
    } else if (locationFocus && locationFocus.includes(opportunityState.toLowerCase())) {
      score += 10
      locationReasons.push(`Covered in profile focus (${opportunityState})`)
    }
  } else if (opportunity.is_national && signals.location?.city) {
    // Provide a location rationale when only national coverage exists.
    locationReasons.push(`Relevant to ${signals.location.city}`)
  }

  const phraseArray = Array.isArray(sectionStrings) ? sectionStrings : []
  const keywordSet = signals.keywordSet ?? new Set()
  const phraseSet = signals.phrases ?? new Set()

  const keywordCandidates = Array.isArray(opportunity.keywords) ? opportunity.keywords : []
  keywordCandidates.forEach((keyword) => {
    const normalized = normalizeString(keyword)
    if (!normalized) return
    if (
      keywordSet.has(normalized) ||
      phraseSet.has(normalized) ||
      phraseArray.some((entry) => entry.includes(normalized))
    ) {
      keywordMatches.push(keyword)
    }
  })

  if (keywordMatches.length > 0) {
    const capped = keywordMatches.slice(0, 5)
    score += Math.min(25, capped.length * 5)
    reasons.push(`Matches profile focus: ${capped.join(', ')}`)
  }

  const categories = Array.isArray(opportunity.categories) ? opportunity.categories : []
  categories.forEach((category) => {
    const normalized = normalizeString(category)
    if (!normalized) return
    if (
      keywordSet.has(normalized) ||
      phraseSet.has(normalized) ||
      phraseArray.some((entry) => entry.includes(normalized))
    ) {
      categoryMatches.push(category)
    }
  })

  if (categoryMatches.length > 0) {
    const capped = categoryMatches.slice(0, 4)
    score += Math.min(32, capped.length * 8)
    reasons.push(`Relevant categories: ${capped.join(', ')}`)
  }

  if (opportunity.deadline_type === 'rolling') {
    score += 5
    reasons.push('Rolling deadline – flexible submission window')
  } else if (opportunity.deadline) {
    reasons.push(`Deadline on ${opportunity.deadline}`)
    score += 3
  }

  const combinedReasons = [...locationReasons, ...reasons]
  const dedupedReasons = Array.from(new Set(combinedReasons)).filter(Boolean).slice(0, 5)
  const finalScore = Math.max(TARGET_MATCH_SCORE, Math.min(100, Math.round(score)))

  return {
    score: finalScore,
    rawScore: Math.round(score),
    reasons: dedupedReasons,
    keywordMatches: keywordMatches.slice(0, 5),
    categoryMatches: categoryMatches.slice(0, 4),
  }
}

function ensureOrganizationForProfile(db, profile) {
  if (profile.organization_id) {
    return profile.organization_id
  }

  const generatedId = `org-${profile.id}`
  const existing = db.prepare('SELECT id FROM organizations WHERE id = ?').get(generatedId)

  if (!existing) {
    db.prepare(
      `
      INSERT INTO organizations (id, name, applicant_type, city, state, zip)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      generatedId,
      profile.display_name ?? 'Unnamed Organization',
      resolveApplicantType(profile.primary_type),
      profile.city ?? null,
      profile.state ?? null,
      profile.postal_code ?? null,
    )
  }

  db.prepare('UPDATE profiles SET organization_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    generatedId,
    profile.id,
  )

  console.log(`[prepopulate] Linked profile ${profile.id} → organization ${generatedId}`)

  return generatedId
}

function buildOpportunityIndex(opportunities) {
  const map = new Map()
  opportunities.forEach((opportunity) => {
    map.set(opportunity.id, opportunity)
  })
  return map
}

function main() {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  const opportunities = db
    .prepare('SELECT * FROM funding_opportunities WHERE is_active = 1')
    .all()
    .map((row) => {
      const categories = safeParseJSON(row.categories, [])
      const keywords = safeParseJSON(row.keywords, [])
      const matchReasons = safeParseJSON(row.match_reasons, [])
      return {
        ...row,
        categories,
        keywords,
        match_reasons: matchReasons,
        eligibility_bullets: safeParseJSON(row.eligibility_bullets, []),
        is_national: Number(row.is_national) === 1,
      }
    })

  if (opportunities.length === 0) {
    console.warn('[prepopulate] No opportunities found. Aborting.')
    process.exit(0)
  }

  const opportunityIndex = buildOpportunityIndex(opportunities)

  const profiles = db.prepare('SELECT * FROM profiles ORDER BY created_at ASC').all()
  if (profiles.length === 0) {
    console.warn('[prepopulate] No profiles found. Aborting.')
    process.exit(0)
  }

  const insertGrantStmt = db.prepare(`
    INSERT INTO grants (
      id,
      organization_id,
      funding_opportunity_id,
      title,
      funder,
      amount_requested,
      status,
      deadline,
      match_score,
      match_reasons,
      notes,
      application_url
    ) VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?, ?)
  `)

  const updateGrantStmt = db.prepare(`
    UPDATE grants
    SET match_score = ?,
        match_reasons = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)

  const profileStringsCache = new Map()

  const processProfile = db.transaction((profile) => {
    const organizationId = ensureOrganizationForProfile(db, profile)
    const existingGrants = db
      .prepare(
        `
        SELECT g.id, g.funding_opportunity_id, g.match_score
        FROM grants g
        WHERE g.organization_id = ?
      `,
      )
      .all(organizationId)

    const existingByOpportunity = new Map()
    existingGrants.forEach((grant) => {
      if (grant.funding_opportunity_id) {
        existingByOpportunity.set(grant.funding_opportunity_id, grant)
      }
    })

    const profileContext = loadProfileContext(db, profile.id)
    const sectionStrings =
      profileStringsCache.get(profile.id) ?? collectSectionStrings(profileContext.sections ?? {})
    profileStringsCache.set(profile.id, sectionStrings)

    const scored = opportunities
      .map((opportunity) => {
        const { score, rawScore, reasons, keywordMatches, categoryMatches } = computeMatchScore(
          opportunity,
          profileContext,
          sectionStrings,
        )
        return {
          opportunity,
          score,
          rawScore,
          reasons,
          keywordMatches,
          categoryMatches,
        }
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        const amountA = Number.isFinite(a.opportunity.amount_max)
          ? a.opportunity.amount_max
          : a.opportunity.amount_min ?? 0
        const amountB = Number.isFinite(b.opportunity.amount_max)
          ? b.opportunity.amount_max
          : b.opportunity.amount_min ?? 0
        return amountB - amountA
      })

    const topRanked = scored.filter((entry) => entry.score >= TARGET_MATCH_SCORE)
    let candidateList = topRanked

    if (candidateList.length < TARGET_COUNT) {
      candidateList = scored.slice(0, Math.max(TARGET_COUNT, candidateList.length))
      console.warn(
        `[prepopulate] Profile ${profile.display_name} (${profile.id}) has only ${topRanked.length} matches >= ${TARGET_MATCH_SCORE}. Falling back to top ${
          candidateList.length
        } opportunities.`,
      )
    }

    const selected = []
    const existingOpportunityIds = new Set(existingByOpportunity.keys())

    for (const entry of candidateList) {
      if (selected.length >= TARGET_COUNT) break
      if (existingOpportunityIds.has(entry.opportunity.id)) {
        selected.push({ ...entry, alreadyExists: true })
        continue
      }
      selected.push({ ...entry, alreadyExists: false })
    }

    const timestamp = new Date().toISOString()
    let insertedCount = 0
    let updatedCount = 0

    selected.forEach((entry) => {
      const { opportunity, score, reasons, alreadyExists } = entry
      const combinedReasons = Array.from(
        new Set([...(reasons ?? []), ...(opportunity.match_reasons ?? [])]),
      )
        .filter(Boolean)
        .slice(0, 5)

      if (alreadyExists) {
        const existing = existingByOpportunity.get(opportunity.id)
        if (existing && existing.match_score < score) {
          updateGrantStmt.run(score, JSON.stringify(combinedReasons), existing.id)
          updatedCount += 1
        }
        return
      }

      const amountRequested =
        Number.isFinite(opportunity.amount_max) && opportunity.amount_max > 0
          ? opportunity.amount_max
          : Number.isFinite(opportunity.amount_min) && opportunity.amount_min > 0
          ? opportunity.amount_min
          : null

      const notes = [
        `Auto-prepopulated on ${timestamp.split('T')[0]}`,
        `Match score: ${score}`,
        combinedReasons.length ? `Rationale: ${combinedReasons.join('; ')}` : null,
      ]
        .filter(Boolean)
        .join(' • ')

      insertGrantStmt.run(
        crypto.randomUUID(),
        organizationId,
        opportunity.id,
        opportunity.title ?? 'Untitled opportunity',
        opportunity.sponsor ?? null,
        amountRequested,
        opportunity.deadline ?? null,
        score,
        JSON.stringify(combinedReasons),
        notes,
        opportunity.application_url ?? null,
      )
      insertedCount += 1
    })

    const finalTotal = db
      .prepare('SELECT COUNT(*) AS total FROM grants WHERE organization_id = ?')
      .get(organizationId)?.total

    console.log(
      `[prepopulate] Profile ${profile.display_name} (${profile.id}) → inserted ${insertedCount}, updated ${updatedCount}, total grants ${finalTotal}`,
    )
  })

  profiles.forEach((profile) => {
    try {
      processProfile(profile)
    } catch (error) {
      console.error(`[prepopulate] Failed processing profile ${profile.id}:`, error)
    }
  })

  db.close()
  console.log('[prepopulate] Completed grant prepopulation.')
}

main()
