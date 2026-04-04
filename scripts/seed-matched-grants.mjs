#!/usr/bin/env node
/**
 * Seed profiles with matched grants using the real matching algorithm
 */

import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import { applyRelevanceFilter } from '../backend/services/relevanceFilter.js'
import {
  computeMatchDecision,
  normalizeProfile,
  normalizeOpportunity,
  computeProfileFingerprint,
  computeOpportunityFingerprint,
  MATCHER_VERSION,
} from '../backend/services/matchDecisionEngine.js'
import { calculateMatchScore } from '../backend/services/matchingEngine.js'

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

// Local implementation of profile signal building and matching
// (simplified version of the full algorithm for seeding)

function safeParseJSON(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch (e) {
    return fallback
  }
}

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
    
    // Build profileContext for canonical engine
    const profileContext = { profile, sections }
    const profileState = sectionsObj?.location_focus?.state || sectionsObj?.location?.state || profile.state || null
    console.log(`  State: ${profileState || 'none'}`)
    console.log(`  Profile type: ${profile.primary_type || profile.applicant_type || 'none'}`)

    // Build profileData for relevance filter
    function parseSec(key) {
      const row = sections.find(s => s.section_key === key)
      if (!row || !row.data) return {}
      try { return typeof row.data === 'string' ? JSON.parse(row.data) : row.data } catch { return {} }
    }
    const basicSec = parseSec('basic_information')
    const demoSec = parseSec('demographics')
    const milSec = parseSec('military_service')
    const healthSec = parseSec('health_medical')
    const familySec = parseSec('family_life')
    const locSec = parseSec('location_focus')
    let parsedTags = []
    try { parsedTags = typeof profile.tags === 'string' ? JSON.parse(profile.tags) : (profile.tags || []) } catch { parsedTags = [] }
    const profileData = {
      primary_type: profile.primary_type || null,
      veteran_status: milSec.veteran || demoSec.veteran_status || null,
      immigrant_status: demoSec.immigrant_status || null,
      disability_status: healthSec.disability_type || demoSec.disability_status || null,
      state: profileState || basicSec.state || locSec.state || null,
      tags: parsedTags,
      gender: basicSec.gender || demoSec.gender || null,
      age: basicSec.age || demoSec.age || null,
      foster_youth: familySec.foster_youth || null,
      first_responder: null,
    }
    
    // Score each opportunity using canonical engine and apply relevance filter
    const scoredOpps = []
    for (const opp of opportunities) {
      const oppForFilter = {
        ...opp,
        keywords: safeParseJSON(opp.keywords, []),
        categories: safeParseJSON(opp.categories, []),
      }
      const relevance = applyRelevanceFilter(oppForFilter, profileData)
      if (!relevance.pass) continue

      const { score, reasons: matchReasons } = calculateMatchScore(profileContext, opp)
      // Stage 1 (junk filter): only skip obviously irrelevant candidates (score < 5).
      // The canonical decision engine (computeMatchDecision) is the final acceptance
      // authority — this heuristic must NOT exclude plausible canonical matches.
      if (score >= 5) {
        scoredOpps.push({ opp, score, matchReasons })
      }
    }
    
    // ---------------------------------------------------------------------------
    // Adaptive candidate selection — three-tier strategy:
    //   1. Junk filter (heuristic < 5): removes clear garbage (applied above).
    //   2. Adaptive cap (≤ ADAPTIVE_CANDIDATE_CAP pass through; > cap takes top N):
    //      bounds worst-case canonical engine calls while ensuring no plausible
    //      canonical match is excluded merely because it ranked below an old
    //      hard-50 cutoff.
    //   3. Canonical engine (computeMatchDecision): sole acceptance authority.
    // ---------------------------------------------------------------------------
    const ADAPTIVE_CANDIDATE_CAP = 200
    let grantsToCreate
    if (scoredOpps.length <= ADAPTIVE_CANDIDATE_CAP) {
      grantsToCreate = scoredOpps
    } else {
      scoredOpps.sort((a, b) => b.score - a.score)
      grantsToCreate = scoredOpps.slice(0, ADAPTIVE_CANDIDATE_CAP)
    }

    const passingCount = scoredOpps.length <= ADAPTIVE_CANDIDATE_CAP
      ? `all ${scoredOpps.length}`
      : `top ${ADAPTIVE_CANDIDATE_CAP} of ${scoredOpps.length}`
    console.log(`  Heuristic candidates (junk-filtered, score>=5): ${scoredOpps.length}, passing ${passingCount} to canonical engine`)
    
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
    for (const { opp, score: _heuristicScore } of grantsToCreate) {
      // Check if grant already exists for this profile/opportunity
      const existing = db.prepare(`
        SELECT id FROM grants 
        WHERE profile_id = ? 
          AND (funding_opportunity_id = ? OR title = ?)
      `).get(profile.id, opp.id, opp.title)
      
      if (existing) {
        continue // Skip duplicate
      }

      // --- CANONICAL DECISION ENGINE: final acceptance authority ---
      const decision = computeMatchDecision(profile, opp, { profileSections: sectionsObj })

      // Hard reject: never insert into profile pipeline
      if (decision.decision === 'REJECT') continue

      // Use canonical score as the stored match score
      const finalScore = decision.score
      
      const grantId = crypto.randomUUID()
      
      try {
        if (_hasDecisionCols) {
          const profileFingerprint = computeProfileFingerprint(normalizeProfile(profile, sectionsObj)) ?? null
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
            MATCHER_VERSION,
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
        console.log(`    ✓ Added: ${opp.title} (${finalScore}% canonical:${decision.decision})`)
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

main().catch(console.error)
