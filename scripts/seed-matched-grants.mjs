#!/usr/bin/env node
/**
 * Seed profiles with canonical ACCEPT grants from the active catalog.
 * Every active candidate is adjudicated before accepted rows are ranked and
 * bounded; no heuristic or secondary relevance verdict participates.
 */

import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import {
  computeMatchDecision,
  normalizeProfile,
  normalizeOpportunity,
  computeProfileFingerprint,
  computeOpportunityFingerprint,
  MATCHER_VERSION,
} from '../backend/services/matchDecisionEngine.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Safety guard: refuse to run in production or when seeding is explicitly disabled.
const _nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
const _disableSeeding = String(process.env.DISABLE_SEEDING || '').trim().toLowerCase()
if (_nodeEnv === 'production' || _disableSeeding === 'true' || _disableSeeding === '1') {
  console.error('[seed-matched-grants] Seeding disabled in production.')
  process.exit(1)
}

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('ERROR: This script only supports SQLite databases. DATABASE_URL points to PostgreSQL.')
  console.error('Use the application API or a Postgres client instead.')
  process.exit(1)
}

const DB_PATH = join(__dirname, '../seed/grantflow.db')

async function main() {
  console.log('🎯 Seeding Profiles with Matched Grants')
  console.log('========================================\n')
  
  const db = new Database(DB_PATH)

  // Detect whether decision columns are present in the grants table
  const _grantCols = db.prepare('PRAGMA table_info(grants)').all().map(c => c.name)
  const _hasDecisionCols = _grantCols.includes('match_decision')
  
  // Get all profiles
  const profiles = db.prepare('SELECT * FROM profiles WHERE status = ?').all('active')
  console.log(`Found ${profiles.length} active profiles\n`)
  
  // Get all funding opportunities
  const opportunities = db.prepare('SELECT * FROM funding_opportunities WHERE is_active = 1').all()
  console.log(`Found ${opportunities.length} active opportunities\n`)
  
  let totalGrantsCreated = 0
  
  for (const profile of profiles) {
    console.log(`\n📋 Processing: ${profile.display_name}`)
    
    // Get profile sections
    const sections = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id)
    
    // Convert sections array to object format for canonical decision engine
    const sectionsObj = {}
    for (const row of sections) {
      try { sectionsObj[row.section_key] = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}) } catch { sectionsObj[row.section_key] = {} }
    }
    
    const profileState = sectionsObj?.location_focus?.state || sectionsObj?.location?.state || profile.state || null
    console.log(`  State: ${profileState || 'none'}`)
    console.log(`  Profile type: ${profile.primary_type || profile.applicant_type || 'none'}`)
    
    // Adjudicate the complete active set before ranking or applying the output
    // bound. A thrown adjudication fails closed for that candidate.
    const acceptedCandidates = []
    for (const opp of opportunities) {
      try {
        const decision = computeMatchDecision(profile, opp, { profileSections: sectionsObj })
        if (decision.decision === 'ACCEPT') acceptedCandidates.push({ opp, decision })
      } catch (error) {
        console.warn(
          `  Canonical adjudication failed for ${opp.id || opp.title || 'unknown'}:`,
          error?.message || error,
        )
      }
    }
    const grantsToCreate = acceptedCandidates
      .sort((a, b) => Number(b.decision.score || 0) - Number(a.decision.score || 0))
      .slice(0, 200)
    console.log(
      `  Canonically adjudicated ${opportunities.length} candidates; ` +
      `${acceptedCandidates.length} ACCEPT; seeding top ${grantsToCreate.length}`,
    )
    
    // Ensure organization exists for the profile
    let orgId = profile.organization_id
    if (!orgId) {
      orgId = crypto.randomUUID()
      db.prepare(`
        INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
        VALUES (?, ?, 'individual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(orgId, profile.display_name || 'My Organization')
      db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile.id)
    }

    // Create grants — always set profile_id for correct pipeline scoping
    const profileFingerprint = _hasDecisionCols
      ? computeProfileFingerprint(normalizeProfile(profile, sectionsObj)) ?? null
      : null
    for (const { opp, decision } of grantsToCreate) {
      // Check if grant already exists for this profile/opportunity
      const existing = db.prepare(`
        SELECT id FROM grants 
        WHERE profile_id = ? 
          AND (funding_opportunity_id = ? OR title = ?)
      `).get(profile.id, opp.id, opp.title)
      
      if (existing) {
        continue // Skip duplicate
      }

      // Use canonical score as the stored match score
      const finalScore = decision.score
      
      const grantId = crypto.randomUUID()
      
      try {
        if (_hasDecisionCols) {
          const opportunityFingerprint = computeOpportunityFingerprint(normalizeOpportunity(opp)) ?? null
          db.prepare(`
            INSERT INTO grants (
              id, organization_id, profile_id, funding_opportunity_id, title, funder,
              deadline, status, match_score, match_reasons, application_url,
              match_decision, match_explanation, matched_needs, eligibility_status,
              ineligibility_reasons, profile_fingerprint, opportunity_fingerprint,
              matcher_version, evaluated_at, match_confidence,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(
            grantId,
            orgId,
            profile.id,
            opp.id,
            opp.title,
            opp.sponsor,
            opp.deadline,
            finalScore,
            JSON.stringify(decision.matchedNeeds ?? []),
            opp.application_url,
            decision.decision,
            decision.explanation ?? null,
            JSON.stringify(decision.matchedNeeds ?? []),
            String(decision.eligible),
            JSON.stringify(decision.ineligibilityReasons ?? []),
            profileFingerprint,
            opportunityFingerprint,
            decision.matcherVersion ?? MATCHER_VERSION,
            decision.evaluatedAt ?? new Date().toISOString(),
            decision.confidence ?? null,
          )
        } else {
          db.prepare(`
            INSERT INTO grants (
              id, organization_id, profile_id, funding_opportunity_id, title, funder,
              deadline, status, match_score, match_reasons, application_url,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(
            grantId,
            orgId,
            profile.id,
            opp.id,
            opp.title,
            opp.sponsor,
            opp.deadline,
            finalScore,
            JSON.stringify(decision.matchedNeeds ?? []),
            opp.application_url,
          )
        }
        
        totalGrantsCreated++
        console.log(`    ✓ Added: ${opp.title} (canonical score ${finalScore}; ${decision.decision})`)
      } catch (e) {
        if (!e.message.includes('UNIQUE')) {
          console.error(`    ✗ ${e.message}`)
        }
      }
    }
  }
  
  console.log(`\n✅ Created ${totalGrantsCreated} grants total`)
  
  // Print summary
  const stats = db.prepare(`
    SELECT p.display_name, COUNT(g.id) as grant_count
    FROM profiles p
    LEFT JOIN grants g ON g.profile_id = p.id
    GROUP BY p.id
  `).all()
  
  console.log('\n📊 Final Grant Counts:')
  stats.forEach(s => {
    console.log(`  ${s.display_name}: ${s.grant_count} grants`)
  })
  
  db.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
