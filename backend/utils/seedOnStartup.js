/**
 * Seed database on startup
 * This runs automatically when the server starts to ensure data persists
 * across Railway deploys (since Railway uses ephemeral storage)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { applyRelevanceFilter } from '../services/relevanceFilter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Returns true if this process should NOT run any seeding.
 * Blocked when NODE_ENV=production OR DISABLE_SEEDING=true.
 */
function isSeedingBlocked() {
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
  if (nodeEnv === 'production') return true
  const disableSeeding = String(process.env.DISABLE_SEEDING || '').trim().toLowerCase()
  return disableSeeding === 'true' || disableSeeding === '1'
}

function loadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.warn(`[seedOnStartup] Could not load ${path}:`, error.message);
    return null;
  }
}

function ensureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

export function seedFundingOpportunities(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] seedFundingOpportunities: blocked (production or DISABLE_SEEDING)')
    return 0
  }
  console.log('[seedOnStartup] Seeding funding opportunities...');
  
  const REAL_OPPS_PATH = join(__dirname, '../data/crawlers/real_funding_opportunities.json');
  const LOCAL_OPPS_PATH = join(__dirname, '../data/crawlers/local_opportunities.json');
  const SCHOLARSHIP_OPPS_PATH = join(__dirname, '../data/crawlers/scholarship_opportunities.json');
  const ITEM_OPPS_PATH = join(__dirname, '../data/crawlers/item_funding_sources.json');
  
  const realOpps = loadJSON(REAL_OPPS_PATH) || {};
  const localOpps = loadJSON(LOCAL_OPPS_PATH) || [];
  const scholarshipOpps = loadJSON(SCHOLARSHIP_OPPS_PATH) || [];
  const itemOpps = loadJSON(ITEM_OPPS_PATH) || [];
  
  const allOpportunities = [
    ...(realOpps.federal_grants || []),
    ...(realOpps.foundation_grants || []),
    ...(realOpps.state_programs || []),
    ...(realOpps.disability_assistance || []),
    ...(realOpps.veteran_benefits || []),
    ...(realOpps.nonprofit_grants || []),
    ...(realOpps.individual_assistance || []),
    ...(realOpps.healthcare_grants || []),
    ...(realOpps.senior_programs || []),
    ...(realOpps.emergency_assistance || []),
    ...(realOpps.scholarships || []),
    ...localOpps,
    ...scholarshipOpps,
    ...itemOpps,
  ].filter(Boolean);
  
  console.log(`[seedOnStartup] Found ${allOpportunities.length} opportunities to seed`);
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO funding_opportunities (
      id, title, sponsor, description, deadline, amount_min, amount_max,
      application_url, source_url, eligibility_summary, eligibility_bullets,
      categories, keywords, source, source_id, opportunity_type,
      requires_501c3, requires_match, is_national, state, is_active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  
  let seeded = 0;
  for (const opp of allOpportunities) {
    try {
      const id = opp.id || crypto.randomUUID();
      stmt.run(
        id,
        opp.title || 'Untitled',
        opp.sponsor || opp.funder || 'Unknown',
        opp.description || '',
        opp.deadline || null,
        opp.amount_min || opp.min_amount || null,
        opp.amount_max || opp.max_amount || null,
        opp.application_url || opp.url || null,
        opp.source_url || opp.url || null,
        opp.eligibility_summary || '',
        JSON.stringify(ensureArray(opp.eligibility_bullets)),
        JSON.stringify(ensureArray(opp.categories)),
        JSON.stringify(ensureArray(opp.keywords)),
        opp.source || 'seeded',
        opp.source_id || id,
        opp.opportunity_type || 'grant',
        opp.requires_501c3 ? 1 : 0,
        opp.requires_match ? 1 : 0,
        opp.is_national || opp.state === 'nationwide' ? 1 : 0,
        opp.state || null
      );
      seeded++;
    } catch (error) {
      // Ignore duplicates
    }
  }
  
  console.log(`[seedOnStartup] Seeded ${seeded} funding opportunities`);
  return seeded;
}

export function seedProfileGrants(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] seedProfileGrants: blocked (production or DISABLE_SEEDING)')
    return 0
  }
  console.log('[seedOnStartup] Seeding profile grants...');
  
  // Get all profiles
  const profiles = db.prepare('SELECT * FROM profiles WHERE status = ?').all('active');
  console.log(`[seedOnStartup] Found ${profiles.length} active profiles`);
  
  // Get all opportunities
  const opportunities = db.prepare(`
    SELECT * FROM funding_opportunities 
    WHERE is_active = 1 
    AND (requires_match = 0 OR requires_match IS NULL)
    LIMIT 100
  `).all();
  
  console.log(`[seedOnStartup] Found ${opportunities.length} opportunities to match`);
  
  let totalGrantsAdded = 0;
  
  for (const profile of profiles) {
    // Skip Rachel and Joshua
    const displayName = (profile.display_name || '').toLowerCase();
    if (displayName.includes('rachel') || displayName.includes('joshua') || displayName.includes('josh')) {
      continue;
    }
    
    // Get profile sections
    const sections = {};
    const sectionRows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
    sectionRows.forEach(row => {
      try { sections[row.section_key] = JSON.parse(row.data || '{}'); } catch (e) { sections[row.section_key] = {}; }
    });
    
    // Build profile signals
    const keywords = new Set();
    
    // Add tags
    try {
      const tags = JSON.parse(profile.tags || '[]');
      tags.forEach(t => keywords.add(t.toLowerCase()));
    } catch (e) { /* ignore */ }
    
    // Add general keywords based on profile type
    if (profile.primary_type === 'individual') {
      keywords.add('individual');
      keywords.add('personal');
    }
    if (profile.primary_type === 'organization' || profile.primary_type === 'nonprofit') {
      keywords.add('nonprofit');
      keywords.add('organization');
      keywords.add('community');
    }
    
    // Military
    if (sections.military_service) {
      if (sections.military_service.veteran) { keywords.add('veteran'); }
      if (sections.military_service.disabled_veteran) { keywords.add('disabled veteran'); }
    }
    
    // Health
    if (sections.health_medical) {
      if (sections.health_medical.chronic_illness) { keywords.add('chronic'); keywords.add('health'); }
      if (sections.health_medical.disability_type) {
        const types = Array.isArray(sections.health_medical.disability_type) ? sections.health_medical.disability_type : [];
        types.forEach(t => keywords.add(t.toLowerCase()));
        if (types.length > 0) { keywords.add('disability'); }
      }
    }
    
    // Family
    if (sections.family_life?.single_parent) { keywords.add('single parent'); keywords.add('family'); }
    if (sections.family_life?.caregiver) { keywords.add('caregiver'); keywords.add('family'); }
    
    // Financial - intentionally omit broad words "financial" and "assistance"
    // which match nearly every opportunity and produce false positives
    
    // Narrative
    if (sections.narrative?.mission) {
      const missionTerms = ['wellness', 'health', 'education', 'community', 'youth', 'senior', 
        'disability', 'veteran', 'faith', 'ministry', 'food', 'housing', 'employment'];
      missionTerms.forEach(term => {
        if (sections.narrative.mission.toLowerCase().includes(term)) {
          keywords.add(term);
        }
      });
    }
    
    // Score opportunities
    const scored = opportunities.map(opp => {
      let score = 25;
      const matchedFields = [];
      
      let oppKeywords = [], oppCategories = [];
      try { oppKeywords = JSON.parse(opp.keywords || '[]'); } catch (e) { /* ignore malformed JSON */ }
      try { oppCategories = JSON.parse(opp.categories || '[]'); } catch (e) { /* ignore malformed JSON */ }
      
      const oppTerms = new Set([
        ...oppKeywords.map(k => k.toLowerCase()),
        ...oppCategories.map(c => c.toLowerCase())
      ]);
      
      // Keyword matching
      let keywordMatches = 0;
      keywords.forEach(kw => {
        for (const term of oppTerms) {
          if (term.includes(kw) || kw.includes(term)) {
            keywordMatches++;
            matchedFields.push(kw);
            break;
          }
        }
      });
      score += Math.min(30, keywordMatches * 5);
      
      return { opp, score: Math.min(100, score), matchedFields };
    });
    
    // Filter and sort — raise threshold to 75 to reduce false positives
    const topMatches = scored
      .filter(s => s.score >= 75)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    
    // Ensure organization exists
    let orgId = profile.organization_id;
    if (!orgId) {
      orgId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
        VALUES (?, ?, 'individual_need', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(orgId, profile.display_name || 'My Organization');
      db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile.id);
    }
    
    // Build profileData for relevance filter
    let parsedTags = [];
    try { parsedTags = JSON.parse(profile.tags || '[]'); } catch (e) { /* ignore */ }
    const basic = sections.basic_information || {};
    const demographics = sections.demographics || {};
    const military = sections.military_service || {};
    const health = sections.health_medical || {};
    const family = sections.family_life || {};
    const locFocus = sections.location_focus || {};
    const addr = basic.address;
    let stateFromAddr = null;
    if (typeof addr === 'string') {
      stateFromAddr = (addr.match(/\b([A-Z]{2})\s*,?\s*\d{5}/) || [])[1] || null;
    } else if (addr && typeof addr === 'object') {
      stateFromAddr = addr.state || null;
    }
    const profileData = {
      primary_type: profile.primary_type || null,
      veteran_status: military.veteran || demographics.veteran_status || null,
      immigrant_status: demographics.immigrant_status || null,
      disability_status: health.disability_type || demographics.disability_status || null,
      state: profile.state || basic.state || locFocus.state || stateFromAddr || null,
      tags: parsedTags,
      gender: basic.gender || demographics.gender || null,
      age: basic.age || demographics.age || null,
      foster_youth: family.foster_youth || null,
      first_responder: null,
    };

    // Add grants to pipeline
    let added = 0;
    for (const { opp, score, matchedFields } of topMatches) {
      // Apply relevance filter before inserting
      const oppForFilter = {
        ...opp,
        keywords: (() => { try { return JSON.parse(opp.keywords || '[]'); } catch (e) { return []; } })(),
        categories: (() => { try { return JSON.parse(opp.categories || '[]'); } catch (e) { return []; } })(),
      };
      const filterResult = applyRelevanceFilter(oppForFilter, profileData);
      if (!filterResult.pass) continue;

      // Check for duplicates
      const existing = db.prepare(`
        SELECT id FROM grants 
        WHERE profile_id = ? AND (funding_opportunity_id = ? OR title = ?)
      `).get(profile.id, opp.id, opp.title);
      
      if (!existing) {
        const grantId = crypto.randomUUID();
        try {
          db.prepare(`
            INSERT INTO grants (
              id, organization_id, profile_id, funding_opportunity_id, title, funder,
              deadline, status, match_score, match_reasons, application_url,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(
            grantId, orgId, profile.id, opp.id, opp.title, opp.sponsor,
            opp.deadline, score, JSON.stringify(matchedFields.slice(0, 10)),
            opp.application_url
          );
          added++;
        } catch (e) {
          // Ignore errors
        }
      }
    }
    
    if (added > 0) {
      console.log(`[seedOnStartup] Added ${added} grants for ${profile.display_name}`);
    }
    totalGrantsAdded += added;
  }
  
  console.log(`[seedOnStartup] Total grants added: ${totalGrantsAdded}`);
  return totalGrantsAdded;
}

/**
 * Scan all existing grants and delete those that fail the canonical relevance
 * filter for their profile. This runs on every server start (dev-only) so that
 * grants inserted by prior buggy code are automatically purged.
 */
export function cleanupIrrelevantGrants(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] cleanupIrrelevantGrants: blocked (production or DISABLE_SEEDING)')
    return 0
  }

  // Build a list of state name → abbr entries, sorted by name length descending
  // so multi-word names ("west virginia") match before sub-strings ("virginia").
  const STATE_NAME_TO_ABBR = [
    ['west virginia', 'WV'], ['north carolina', 'NC'], ['north dakota', 'ND'],
    ['south carolina', 'SC'], ['south dakota', 'SD'], ['new hampshire', 'NH'],
    ['rhode island', 'RI'], ['new mexico', 'NM'], ['new jersey', 'NJ'],
    ['new york', 'NY'], ['connecticut', 'CT'], ['massachusetts', 'MA'],
    ['mississippi', 'MS'], ['pennsylvania', 'PA'], ['minnesota', 'MN'],
    ['tennessee', 'TN'], ['california', 'CA'], ['louisiana', 'LA'],
    ['wisconsin', 'WI'], ['kentucky', 'KY'], ['oklahoma', 'OK'],
    ['nebraska', 'NE'], ['arkansas', 'AR'], ['colorado', 'CO'],
    ['maryland', 'MD'], ['michigan', 'MI'], ['missouri', 'MO'],
    ['delaware', 'DE'], ['illinois', 'IL'], ['virginia', 'VA'],
    ['montana', 'MT'], ['wyoming', 'WY'], ['georgia', 'GA'],
    ['arizona', 'AZ'], ['indiana', 'IN'], ['florida', 'FL'],
    ['alabama', 'AL'], ['vermont', 'VT'], ['kansas', 'KS'],
    ['nevada', 'NV'], ['oregon', 'OR'], ['alaska', 'AK'],
    ['hawaii', 'HI'], ['idaho', 'ID'], ['maine', 'ME'],
    ['texas', 'TX'], ['utah', 'UT'], ['iowa', 'IA'],
    ['ohio', 'OH'],
  ].sort((a, b) => b[0].length - a[0].length)

  function extractStateNameFromTitle(title) {
    const lower = (title || '').toLowerCase()
    for (const [name, abbr] of STATE_NAME_TO_ABBR) {
      if (lower.includes(name)) return abbr
    }
    return null
  }

  function extractStateFromAddress(addr) {
    if (!addr) return null
    if (typeof addr === 'object') return addr.state || null
    if (typeof addr === 'string') {
      const m = addr.match(/\b([A-Z]{2})\s*,?\s*\d{5}/)
      return m ? m[1] : null
    }
    return null
  }

  console.log('[seedOnStartup] cleanupIrrelevantGrants: scanning all profile grants...')
  const profiles = db.prepare("SELECT id, display_name, primary_type, tags FROM profiles WHERE status = 'active'").all()
  const deleteStmt = db.prepare('DELETE FROM grants WHERE id = ?')
  let totalRemoved = 0

  for (const profile of profiles) {
    const grants = db.prepare(`
      SELECT id, title, funder, notes FROM grants
      WHERE profile_id = ?
         OR (profile_id IS NULL AND organization_id IN (
           SELECT organization_id FROM profiles WHERE id = ? AND organization_id IS NOT NULL
         ))
    `).all(profile.id, profile.id)
    if (grants.length === 0) continue

    const sections = {}
    const rows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id)
    for (const row of rows) {
      try { sections[row.section_key] = JSON.parse(row.data || '{}') } catch { sections[row.section_key] = {} }
    }

    const basic = sections.basic_information || {}
    const demographics = sections.demographics || {}
    const military = sections.military_service || {}
    const health = sections.health_medical || {}
    const family = sections.family_life || {}
    const locFocus = sections.location_focus || {}
    const comp = sections.comprehensive_application || {}

    let parsedTags = []
    try { parsedTags = JSON.parse(profile.tags || '[]') } catch { /* ignore */ }

    const rawVeteran = demographics.veteran_status || military.veteran || null
    const veteranStatus = (rawVeteran === true || /^veteran/i.test(String(rawVeteran || ''))) ? true : null

    const profileState = (
      profile.state ||
      basic.state ||
      locFocus.state ||
      extractStateFromAddress(basic.address) ||
      extractStateFromAddress(comp.address) ||
      null
    )

    const profileData = {
      primary_type: profile.primary_type || null,
      veteran_status: veteranStatus,
      immigrant_status: demographics.immigrant_status || null,
      disability_status: demographics.disability_status || health.disability_type || null,
      foster_youth: family.foster_youth || null,
      first_responder: null,
      gender: basic.gender || demographics.gender || null,
      age: basic.age || demographics.age || null,
      state: profileState,
      tags: parsedTags,
      employment: sections.employment || {},
      education: sections.education || {},
    }

    const seenTitles = new Set()
    let removedForProfile = 0

    for (const grant of grants) {
      const titleNorm = (grant.title || '').trim()

      // Duplicate: keep first occurrence, remove the rest
      if (seenTitles.has(titleNorm)) {
        deleteStmt.run(grant.id)
        removedForProfile++
        continue
      }
      seenTitles.add(titleNorm)

      // Wrong-state check: title contains an explicit state name different from profile's
      if (profileState) {
        const grantState = extractStateNameFromTitle(grant.title || '')
        if (grantState && grantState !== profileState.toUpperCase()) {
          console.log(`[seedOnStartup] cleanup: removing "${grant.title}" (wrong state ${grantState}) from ${profile.display_name}`)
          deleteStmt.run(grant.id)
          removedForProfile++
          continue
        }
      }

      // Full relevance filter
      const opportunity = {
        title: grant.title || '',
        description: grant.notes || '',
        sponsor: grant.funder || '',
        keywords: [],
        categories: [],
        eligibility_bullets: [],
        state: null,
        is_national: true, // geo check done above via state-name-in-title
      }
      const result = applyRelevanceFilter(opportunity, profileData)
      if (!result.pass) {
        console.log(`[seedOnStartup] cleanup: removing "${grant.title}" (${result.reason}) from ${profile.display_name}`)
        deleteStmt.run(grant.id)
        removedForProfile++
      }
    }

    if (removedForProfile > 0) {
      totalRemoved += removedForProfile
    }
  }

  console.log(`[seedOnStartup] cleanupIrrelevantGrants: removed ${totalRemoved} irrelevant grants across ${profiles.length} profiles`)
  return totalRemoved
}

export function seedOnStartup(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] seedOnStartup: blocked (production or DISABLE_SEEDING)')
    return
  }
  console.log('[seedOnStartup] Starting database seeding...');
  
  // Check if we need to seed
  const grantCount = db.prepare('SELECT COUNT(*) as c FROM grants').get().c;
  const oppCount = db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c;
  
  console.log(`[seedOnStartup] Current state: ${oppCount} opportunities, ${grantCount} grants`);
  
  // Cleanup: remove irrelevant grants from prior seeding passes before adding new ones
  cleanupIrrelevantGrants(db);
  
  // Seed opportunities if needed
  if (oppCount < 50) {
    seedFundingOpportunities(db);
  }
  
  // Seed grants if needed
  const grantCountAfterCleanup = db.prepare('SELECT COUNT(*) as c FROM grants').get().c;
  if (grantCountAfterCleanup < 50) {
    seedProfileGrants(db);
  }
  
  console.log('[seedOnStartup] Database seeding complete');
}

export default seedOnStartup;
