#!/usr/bin/env node
/**
 * Seed profiles with matched grants using the real matching algorithm
 */

import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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

function buildProfileSignals(profile, sections, organization) {
  const signals = {
    keywords: new Set(),
    demographics: new Set(),
    military: new Set(),
    assistance: new Set(),
    family: new Set(),
    location: {
      state: null,
      city: null,
      zip: null,
    }
  }
  
  // Extract location
  const locationSection = sections.find(s => s.section_key === 'location')
  if (locationSection) {
    const locData = safeParseJSON(locationSection.data, {})
    signals.location.state = locData.state || null
    signals.location.city = locData.city || null
    signals.location.zip = locData.zip || null
  }
  
  // Fallback to organization
  if (organization) {
    if (!signals.location.state && organization.state) {
      signals.location.state = organization.state
    }
    if (organization.mission) {
      // Extract keywords from mission
      const missionWords = organization.mission.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 3)
      missionWords.forEach(w => signals.keywords.add(w))
    }
  }
  
  // Extract from organization section
  const orgSection = sections.find(s => s.section_key === 'organization')
  if (orgSection) {
    const orgData = safeParseJSON(orgSection.data, {})
    
    // Categories as keywords
    const categories = orgData.categories || []
    categories.forEach(cat => {
      signals.keywords.add(cat.toLowerCase())
      // Also add individual words
      cat.toLowerCase().split(/\s+/).forEach(w => {
        if (w.length > 2) signals.keywords.add(w)
      })
    })
    
    // Check for special populations
    if (orgData.serves_veterans) {
      signals.military.add('veteran')
      signals.keywords.add('veteran')
      signals.keywords.add('veterans')
    }
    if (orgData.serves_disabled) {
      signals.keywords.add('disability')
      signals.keywords.add('disabled')
    }
    
    // Organization type
    if (orgData.organization_type) {
      signals.keywords.add(orgData.organization_type.toLowerCase())
    }
  }
  
  // Add profile type
  if (profile.primary_type) {
    signals.keywords.add(profile.primary_type.toLowerCase())
  }
  
  return signals
}

function calculateMatchScore(signals, opp) {
  let score = 40 // Base score of 40%
  const matchedFields = []
  
  // Parse opportunity data
  const oppKeywords = safeParseJSON(opp.keywords, []).map(k => k.toLowerCase())
  const oppCategories = safeParseJSON(opp.categories, []).map(c => c.toLowerCase())
  const eligibility = safeParseJSON(opp.eligibility_bullets, []).map(e => e.toLowerCase())
  
  const oppTerms = new Set([...oppKeywords, ...oppCategories, ...eligibility])
  const oppText = `${opp.title || ''} ${opp.description || ''}`.toLowerCase()
  
  // Location matching (up to 15 points)
  if (opp.state && signals.location.state) {
    const profileState = signals.location.state.toLowerCase()
    const oppState = opp.state.toLowerCase()
    
    if (oppState === profileState) {
      score += 15
      matchedFields.push('state match')
    } else if (oppState === 'nationwide' || opp.is_national) {
      score += 10
      matchedFields.push('national availability')
    }
  } else if (opp.state === 'nationwide' || opp.is_national) {
    score += 10
    matchedFields.push('national availability')
  }
  
  // Keyword matching (up to 30 points)
  let keywordMatches = 0
  signals.keywords.forEach(keyword => {
    for (const term of oppTerms) {
      if (term.includes(keyword) || keyword.includes(term)) {
        keywordMatches++
        matchedFields.push(keyword)
        break
      }
    }
    // Also check title/description
    if (oppText.includes(keyword)) {
      keywordMatches += 0.5
    }
  })
  score += Math.min(30, Math.floor(keywordMatches * 5))
  
  // Military matching (up to 20 points)
  if (signals.military.size > 0) {
    let militaryScore = 0
    signals.military.forEach(mil => {
      for (const term of oppTerms) {
        if (term.includes(mil) || mil.includes(term) || oppText.includes(mil)) {
          militaryScore += 10
          matchedFields.push('military: ' + mil)
          break
        }
      }
    })
    score += Math.min(20, militaryScore)
  }
  
  // 501c3 bonus for nonprofits
  if (opp.requires_501c3 && signals.keywords.has('nonprofit')) {
    score += 5
    matchedFields.push('nonprofit eligible')
  }
  
  // Cap at 100
  return {
    score: Math.min(100, Math.max(0, score)),
    matchedFields: [...new Set(matchedFields)].slice(0, 5)
  }
}

async function main() {
  console.log('🎯 Seeding Profiles with Matched Grants')
  console.log('========================================\n')
  
  const db = new Database(DB_PATH)
  
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
    
    // Get organization
    const organization = profile.organization_id 
      ? db.prepare('SELECT * FROM organizations WHERE id = ?').get(profile.organization_id)
      : null
    
    // Build signals
    const signals = buildProfileSignals(profile, sections, organization)
    console.log(`  Keywords: ${[...signals.keywords].slice(0, 5).join(', ')}...`)
    console.log(`  State: ${signals.location.state || 'none'}`)
    console.log(`  Military: ${signals.military.size > 0 ? [...signals.military].join(', ') : 'none'}`)
    
    // Score each opportunity
    const scoredOpps = opportunities.map(opp => {
      const { score, matchedFields } = calculateMatchScore(signals, opp)
      return { opp, score, matchedFields }
    })
    
    // Sort by score and filter for 80%+
    const highMatches = scoredOpps
      .filter(s => s.score >= 80)
      .sort((a, b) => b.score - a.score)
    
    console.log(`  High matches (80%+): ${highMatches.length}`)
    
    // Take top 10 for this profile
    const grantsToCreate = highMatches.slice(0, 10)
    
    if (grantsToCreate.length === 0) {
      // If no high matches, take top 5 anyway for demo purposes
      const topMatches = scoredOpps
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
      console.log(`  No 80%+ matches, creating top ${topMatches.length} matches anyway`)
      grantsToCreate.push(...topMatches)
    }
    
    // Create grants
    for (const { opp, score, matchedFields } of grantsToCreate) {
      // Check if grant already exists for this org/opportunity
      const existing = db.prepare(`
        SELECT id FROM grants 
        WHERE organization_id = ? 
          AND (funding_opportunity_id = ? OR title = ?)
      `).get(profile.organization_id, opp.id, opp.title)
      
      if (existing) {
        continue // Skip duplicate
      }
      
      const grantId = crypto.randomUUID()
      
      db.prepare(`
        INSERT INTO grants (
          id, organization_id, funding_opportunity_id, title, funder,
          deadline, status, match_score, match_reasons, application_url,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        grantId,
        profile.organization_id,
        opp.id,
        opp.title,
        opp.sponsor,
        opp.deadline,
        score,
        JSON.stringify(matchedFields),
        opp.application_url
      )
      
      totalGrantsCreated++
      console.log(`    ✓ Added: ${opp.title} (${score}%)`)
    }
  }
  
  console.log(`\n✅ Created ${totalGrantsCreated} grants total`)
  
  // Print summary
  const stats = db.prepare(`
    SELECT p.display_name, COUNT(g.id) as grant_count
    FROM profiles p
    LEFT JOIN grants g ON g.organization_id = p.organization_id
    GROUP BY p.id
  `).all()
  
  console.log('\n📊 Final Grant Counts:')
  stats.forEach(s => {
    console.log(`  ${s.display_name}: ${s.grant_count} grants`)
  })
  
  db.close()
}

main().catch(console.error)
