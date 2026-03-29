#!/usr/bin/env node
/**
 * Prepopulate Profiles with Grant Matches
 * 
 * This script:
 * 1. Fetches all profiles from the database
 * 2. Finds funding opportunities matching at ≥80%
 * 3. Adds top 50 matches per profile to their grants pipeline
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { calculateMatchScore } from '../backend/services/matchingEngine.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const TARGET_MATCH_SCORE = 80
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
  console.log(`[prepopulate] Target match score: ≥${TARGET_MATCH_SCORE}%`)
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

      // Get organization data for better matching
      const organization = profile.organization_id 
        ? db.prepare('SELECT * FROM organizations WHERE id = ?').get(profile.organization_id)
        : null

      // Get profile sections for better matching
      const sections = db.prepare(
        'SELECT * FROM profile_sections WHERE profile_id = ?'
      ).all(profile.id)

      // Calculate match scores for all opportunities using canonical engine
      const profileContext = { profile, sections }
      const matchedOpportunities = opportunities
        .map(opp => {
          const { score: matchScore, reasons: matchReasons } = calculateMatchScore(profileContext, opp)
          return {
            ...opp,
            matchScore,
            matchReasons: matchReasons || [],
          }
        })
        .filter(opp => opp.matchScore >= TARGET_MATCH_SCORE)
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, TARGET_GRANTS_PER_PROFILE)

      if (profileIndex === 0) {
        const scores = opportunities.map(o => calculateMatchScore(profileContext, o).score)
        const maxScore = Math.max(...scores)
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length
        console.log(`  DEBUG [${profile.display_name}]: maxScore=${maxScore}, avgScore=${avgScore.toFixed(1)}`)
      }

      console.log(`  → Found ${matchedOpportunities.length} opportunities matching at ≥${TARGET_MATCH_SCORE}%`)

      if (matchedOpportunities.length === 0) {
        console.log(`  ⚠️  No matches found for this profile`)
        return
      }

      // Check for existing grants to avoid duplicates
      const existingGrantIds = db.prepare(`
        SELECT funding_opportunity_id FROM grants 
        WHERE organization_id = ? AND funding_opportunity_id IS NOT NULL
      `).all(profile.organization_id).map(g => g.funding_opportunity_id)

      const existingSet = new Set(existingGrantIds)

      // Insert matched opportunities as grants
      const insertStmt = db.prepare(`
        INSERT INTO grants (
          organization_id,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
