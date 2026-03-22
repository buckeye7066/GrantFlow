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
import { buildProfileSignals } from '../services/profileHelpers.js';
import { computeMatchDecision } from '../services/matchDecisionEngine.js';

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
    LIMIT 200
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
    const sectionsObj = {};
    const sectionRows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
    sectionRows.forEach(row => {
      try { sectionsObj[row.section_key] = JSON.parse(row.data || '{}'); } catch (e) { sectionsObj[row.section_key] = {}; }
    });
    
    // Use canonical buildProfileSignals for comprehensive keyword extraction
    let signals;
    try {
      signals = buildProfileSignals({ profile, sections: sectionsObj });
    } catch (e) {
      console.warn(`[seedOnStartup] buildProfileSignals failed for ${profile.display_name}:`, e.message);
      continue;
    }

    // Build profileData for relevance filter
    let parsedTags = [];
    try { parsedTags = JSON.parse(profile.tags || '[]'); } catch (e) { /* ignore */ }
    const basic = sectionsObj.basic_information || {};
    const demographics = sectionsObj.demographics || {};
    const military = sectionsObj.military_service || {};
    const health = sectionsObj.health_medical || {};
    const family = sectionsObj.family_life || {};
    const locFocus = sectionsObj.location_focus || {};
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

    // Score opportunities using canonical signals
    const scored = opportunities.map(opp => {
      let score = 0;
      const matchedFields = [];
      
      let oppKeywords = [], oppCategories = [];
      try { oppKeywords = JSON.parse(opp.keywords || '[]'); } catch (e) { /* ignore malformed JSON */ }
      try { oppCategories = JSON.parse(opp.categories || '[]'); } catch (e) { /* ignore malformed JSON */ }
      
      const oppTerms = new Set([
        ...oppKeywords.map(k => k.toLowerCase()),
        ...oppCategories.map(c => c.toLowerCase())
      ]);

      const oppText = `${opp.title || ''} ${opp.description || ''}`.toLowerCase();

      // Geographic scoring
      const oppState = (opp.state || '').toLowerCase();
      const profState = (profileData.state || '').toLowerCase();
      if (!oppState || oppState === 'nationwide' || opp.is_national) {
        score += 8;
      } else if (profState && oppState === profState) {
        score += 18;
        matchedFields.push(`state:${opp.state}`);
      } else if (profState && oppState && oppState !== profState) {
        score -= 20; // state mismatch penalty
      }

      // Intent phrase matching (5 pts each, up to 25)
      let intentMatches = 0;
      if (signals.intentPhraseSet) {
        for (const phrase of signals.intentPhraseSet) {
          const p = String(phrase).toLowerCase();
          if (p.length < 4) continue;
          if (oppText.includes(p) || oppKeywords.some(k => k.toLowerCase().includes(p))) {
            intentMatches++;
            matchedFields.push(`intent:${p}`);
          }
        }
      }
      score += Math.min(25, intentMatches * 5);

      // Keyword matching (1.5 pts each in opp keywords, 0.5 in text, up to 20)
      let kwScore = 0;
      const keywordsToCheck = signals.keywordSet || signals.keywords || new Set();
      for (const kw of keywordsToCheck) {
        const k = String(kw).toLowerCase();
        if (k.length < 3 || k.includes(' ')) continue;
        if (oppTerms.has(k)) { kwScore += 1.5; matchedFields.push(`kw:${k}`); }
        else if (oppText.includes(k)) { kwScore += 0.5; }
      }
      score += Math.min(20, Math.floor(kwScore));

      return { opp, score: Math.min(100, Math.max(0, score)), matchedFields };
    });
    
    // Filter with higher threshold (65) and apply relevance filter
    const topMatches = scored
      .filter(s => s.score >= 65)
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

      // v2.0.0 canonical decision engine: skip hard ineligibles (REJECT)
      const decision = computeMatchDecision(profile, opp, { profileSections: sectionsObj });
      if (decision.decision === 'REJECT') continue;

      // Check for duplicates — profile-scoped (prefer profile_id uniqueness check)
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
 * Remove grants from profile pipelines that fail the relevance filter.
 * This is a one-time cleanup that runs on startup (non-production) to remove
 * grants inserted by previous buggy seeding paths.
 * Only removes grants that have a profile_id set (profile-scoped grants).
 */
export function cleanupIrrelevantGrants(db) {
  if (isSeedingBlocked()) {
    console.info('[seedOnStartup] cleanupIrrelevantGrants: blocked (production or DISABLE_SEEDING)')
    return 0
  }
  console.log('[seedOnStartup] Running cleanup of irrelevant profile grants...');

  // Get all profile-scoped grants with their associated profile data
  const grants = db.prepare(`
    SELECT g.id, g.title, g.funder, g.match_score,
           g.profile_id, g.funding_opportunity_id,
           fo.description, fo.keywords, fo.categories, fo.state, fo.is_national,
           fo.sponsor, fo.eligibility_bullets
    FROM grants g
    LEFT JOIN funding_opportunities fo ON g.funding_opportunity_id = fo.id
    WHERE g.profile_id IS NOT NULL
  `).all();

  if (grants.length === 0) {
    console.log('[seedOnStartup] No profile-scoped grants to check');
    return 0;
  }

  console.log(`[seedOnStartup] Checking ${grants.length} profile-scoped grants for relevance...`);

  // Cache profiles and sections to avoid re-querying
  const profileCache = new Map();
  const getProfileData = (profileId) => {
    if (profileCache.has(profileId)) return profileCache.get(profileId);
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profile) { profileCache.set(profileId, null); return null; }
    const sectionRows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId);
    const sections = {};
    sectionRows.forEach(row => {
      try { sections[row.section_key] = JSON.parse(row.data || '{}'); } catch (e) { sections[row.section_key] = {}; }
    });
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
    let parsedTags = [];
    try { parsedTags = JSON.parse(profile.tags || '[]'); } catch (e) { /* ignore */ }
    const data = {
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
    profileCache.set(profileId, data);
    return data;
  };

  let removed = 0;
  for (const grant of grants) {
    const profileData = getProfileData(grant.profile_id);
    if (!profileData) continue;

    const oppForFilter = {
      title: grant.title || '',
      description: grant.description || '',
      sponsor: grant.funder || grant.sponsor || '',
      keywords: (() => { try { return JSON.parse(grant.keywords || '[]'); } catch (e) { return []; } })(),
      categories: (() => { try { return JSON.parse(grant.categories || '[]'); } catch (e) { return []; } })(),
      eligibility_bullets: (() => { try { return JSON.parse(grant.eligibility_bullets || '[]'); } catch (e) { return []; } })(),
      state: grant.state || null,
      is_national: grant.is_national || false,
    };

    const filterResult = applyRelevanceFilter(oppForFilter, profileData);
    if (!filterResult.pass) {
      try {
        db.prepare('DELETE FROM grants WHERE id = ?').run(grant.id);
        console.log(`[seedOnStartup] Removed irrelevant grant "${grant.title}" from profile ${grant.profile_id}: ${filterResult.reason}`);
        removed++;
      } catch (e) {
        // Ignore errors
      }
    }
  }

  console.log(`[seedOnStartup] Cleanup complete: removed ${removed} irrelevant grants`);
  return removed;
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

  // Always run cleanup on startup to remove stale irrelevant grants from prior seeding runs
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
