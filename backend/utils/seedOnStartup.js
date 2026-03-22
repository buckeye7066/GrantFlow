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
    
    // Financial
    if (sections.financial_information) {
      keywords.add('financial');
      keywords.add('assistance');
    }
    
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
      let score = 40;
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
    
    // Filter and sort
    const topMatches = scored
      .filter(s => s.score >= 45)
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
        WHERE organization_id = ? AND (funding_opportunity_id = ? OR title = ?)
      `).get(orgId, opp.id, opp.title);
      
      if (!existing) {
        const grantId = crypto.randomUUID();
        try {
          db.prepare(`
            INSERT INTO grants (
              id, organization_id, funding_opportunity_id, title, funder,
              deadline, status, match_score, match_reasons, application_url,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(
            grantId, orgId, opp.id, opp.title, opp.sponsor,
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
  
  // Seed opportunities if needed
  if (oppCount < 50) {
    seedFundingOpportunities(db);
  }
  
  // Seed grants if needed
  if (grantCount < 50) {
    seedProfileGrants(db);
  }
  
  console.log('[seedOnStartup] Database seeding complete');
}

export default seedOnStartup;
