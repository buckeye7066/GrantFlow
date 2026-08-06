#!/usr/bin/env node
/**
 * Prepopulate Profiles with Grant Matches
 *
 * Dev-only helper. For every profile, find funding opportunities that the
 * canonical decision engine ACCEPTs and insert the top N into
 * the grants pipeline.
 *
 * Architectural contract:
 *   - `computeMatchDecision()` is the sole scoring and acceptance authority.
 *   - Every active opportunity is adjudicated before the accepted set is
 *     ranked and bounded; no heuristic prefilter can hide an ACCEPT.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  computeMatchDecision,
  MATCHER_VERSION,
} from '../backend/services/matchDecisionEngine.js'

// Safety guard: never run in production or when seeding is explicitly disabled.
const _nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
const _disableSeeding = String(process.env.DISABLE_SEEDING || '').trim().toLowerCase()
if (_nodeEnv === 'production' || _disableSeeding === 'true' || _disableSeeding === '1') {
  console.error('[prepopulate] Seeding disabled in production.')
  process.exit(1)
}

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('[prepopulate] Refusing to seed a PostgreSQL target; this helper is SQLite-only.')
  process.exit(1)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const TARGET_GRANTS_PER_PROFILE = 50

function ensureFile(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${description} at ${filePath}`)
  }
}


function main() {
  const dbPath = path.resolve(projectRoot, 'backend', 'data', 'grantflow.db')
  ensureFile(dbPath, 'SQLite database (run `npm run seed:db` first)')

  console.log(`[prepopulate] Starting profile grant prepopulation`)
  console.log(`[prepopulate] Target grants per profile: ${TARGET_GRANTS_PER_PROFILE}\n`)

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  try {
    // Get all profiles
    const profiles = db.prepare('SELECT * FROM profiles ORDER BY created_at ASC').all()
    
    if (profiles.length === 0) {
      console.error('[prepopulate] ERROR: No profiles found in database')
      db.close()
      process.exit(1)
    }

    console.log(`[prepopulate] Found ${profiles.length} profiles\n`)

    // Get all active funding opportunities
    const opportunities = db.prepare(`
      SELECT * FROM funding_opportunities 
      WHERE is_active = TRUE
      ORDER BY created_at DESC
    `).all()

    console.log(`[prepopulate] Found ${opportunities.length} active funding opportunities\n`)

    if (opportunities.length === 0) {
      console.error('[prepopulate] ERROR: No opportunities found. Run nationwide crawler first.')
      db.close()
      process.exit(1)
    }

    let totalGrantsInserted = 0

    // Process each profile
    profiles.forEach((profile, profileIndex) => {
      console.log(`[${profileIndex + 1}/${profiles.length}] Processing profile: ${profile.display_name || profile.id}`)

      // Get profile sections for better matching
      const sectionRows = db.prepare(
        'SELECT * FROM profile_sections WHERE profile_id = ?'
      ).all(profile.id)
      const sections = {}
      for (const row of sectionRows) {
        try {
          sections[row.section_key] = typeof row.data === 'string'
            ? JSON.parse(row.data)
            : (row.data || {})
        } catch {
          sections[row.section_key] = {}
        }
      }

      const acceptedCandidates = []
      for (const opp of opportunities) {
        try {
          const decision = computeMatchDecision(profile, opp, { profileSections: sections })
          if (decision.decision === 'ACCEPT') acceptedCandidates.push({ opp, decision })
        } catch (error) {
          console.warn(
            `  Canonical adjudication failed for ${opp.id || opp.title || 'unknown'}:`,
            error?.message || error,
          )
        }
      }

      const matchedOpportunities = acceptedCandidates
        .sort((a, b) => Number(b.decision.score || 0) - Number(a.decision.score || 0))
        .slice(0, TARGET_GRANTS_PER_PROFILE)
        .map(({ opp, decision }) => ({
          ...opp,
          matchScore: decision.score,
          matchReasons: decision.reasons ?? [],
          match_decision: decision.decision,
          match_explanation: decision.explanation ?? null,
          matched_needs: decision.matchedNeeds ?? [],
          eligibility_status: decision.eligible ?? null,
          ineligibility_reasons: decision.ineligibilityReasons ?? [],
          match_confidence: decision.confidence ?? null,
          matcher_version: decision.matcherVersion ?? MATCHER_VERSION,
          evaluated_at: decision.evaluatedAt ?? new Date().toISOString(),
        }))

      console.log(`  → Found ${matchedOpportunities.length} canonical ACCEPT opportunities`)

      if (matchedOpportunities.length === 0) {
        console.log(`  ⚠️  No matches found for this profile`)
        return
      }

      // Check for existing grants to avoid duplicates
      const existingGrantIds = db.prepare(`
        SELECT funding_opportunity_id FROM grants 
        WHERE profile_id = ? AND funding_opportunity_id IS NOT NULL
      `).all(profile.id).map(g => g.funding_opportunity_id)

      const existingSet = new Set(existingGrantIds)

      // Insert matched opportunities as grants
      const insertStmt = db.prepare(`
        INSERT INTO grants (
          organization_id,
          profile_id,
          funding_opportunity_id,
          title,
          funder,
          status,
          deadline,
          amount_requested,
          match_score,
          match_reasons,
          notes,
          application_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      let inserted = 0
      matchedOpportunities.forEach(opp => {
        // Skip if already exists
        if (existingSet.has(opp.id)) {
          return
        }

        try {
          insertStmt.run(
            profile.organization_id,
            profile.id,
            opp.id,
            opp.title,
            opp.sponsor,
            'discovered', // Initial status
            opp.deadline,
            opp.amount_max || opp.amount_min,
            opp.matchScore,
            JSON.stringify(opp.matchReasons),
            `Auto-matched at ${new Date().toISOString()}`,
            opp.application_url
          )
          inserted++
        } catch (error) {
          console.error(`  ❌ Failed to insert grant: ${error.message}`)
          throw error // Stop on error as per requirement
        }
      })

      totalGrantsInserted += inserted
      console.log(`  ✓ Inserted ${inserted} new grants into pipeline\n`)
    })

    db.close()

    console.log('='.repeat(80))
    console.log('PROFILE PREPOPULATION COMPLETE')
    console.log('='.repeat(80))
    console.log(`Profiles processed: ${profiles.length}`)
    console.log(`Total grants inserted: ${totalGrantsInserted}`)
    console.log(`Average grants per profile: ${Math.round(totalGrantsInserted / profiles.length)}`)
    console.log(`Completed at: ${new Date().toISOString()}`)
    console.log('='.repeat(80))

  } catch (error) {
    db.close()
    throw error
  }
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error('\n[prepopulate] FATAL ERROR:', message)
  console.error(error.stack)
  process.exit(1)
}
