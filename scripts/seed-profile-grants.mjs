#!/usr/bin/env node
/**
 * Seed Profile Grants
 * 
 * Seeds each profile with real grants evaluated by the canonical decision engine.
 * Adaptive candidate selection: if junk-filtered candidates ≤ 200, all are evaluated
 * canonically; if > 200, the top 200 by heuristic score are used as a generous ceiling.
 * Strategy: Stage 1 lightweight junk filter (heuristic >= 5) → Stage 2 canonical engine gate.
 * The local heuristic is only used to rank candidates before canonical evaluation,
 * NOT as an acceptance gate. computeMatchDecision() is the sole acceptance authority.
 * Only uses verified real funding opportunities - no fakes.
 */

// Safety guard: refuse to run in production or when seeding is explicitly disabled.
const _nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
const _disableSeeding = String(process.env.DISABLE_SEEDING || '').trim().toLowerCase()
if (_nodeEnv === 'production' || _disableSeeding === 'true' || _disableSeeding === '1') {
  console.error('[seed-profile-grants] Seeding disabled in production.')
  process.exit(1)
}

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { applyRelevanceFilter } from '../backend/services/relevanceFilter.js';
import {
  computeMatchDecision,
  normalizeProfile,
  normalizeOpportunity,
  computeProfileFingerprint,
  computeOpportunityFingerprint,
  MATCHER_VERSION,
} from '../backend/services/matchDecisionEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../backend/data/grantflow.db');

console.log('=== Seed Profile Grants (80%+ Match) ===\n');
console.log('Database:', DB_PATH);

// Connect to database
const db = new Database(DB_PATH);

/**
 * Safely parse array fields that may be JSON arrays or comma-separated strings
 */
function safeParseArrayField(value, fallback = []) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : fallback;
      } catch {
        // Fall through to comma-split
      }
    }
    // Handle comma-separated strings
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return fallback;
}

// Load real opportunities from all data files
function loadAllRealOpportunities() {
  const opportunities = [];
  
  // Load main real opportunities
  const realOppsPath = path.join(__dirname, '../backend/data/crawlers/real_funding_opportunities.json');
  if (fs.existsSync(realOppsPath)) {
    const data = JSON.parse(fs.readFileSync(realOppsPath, 'utf-8'));
    const categories = ['federal_grants', 'foundation_grants', 'state_programs', 
                       'disability_assistance', 'veteran_assistance', 'nonprofit_grants'];
    for (const cat of categories) {
      if (data[cat]) {
        opportunities.push(...data[cat].map(o => ({ ...o, source_category: cat })));
      }
    }
  }
  
  // Load local opportunities
  const localPath = path.join(__dirname, '../backend/data/crawlers/local_opportunities.json');
  if (fs.existsSync(localPath)) {
    const local = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    opportunities.push(...local.map(o => ({ ...o, source_category: 'local' })));
  }
  
  // Load scholarships
  const scholarPath = path.join(__dirname, '../backend/data/crawlers/scholarship_opportunities.json');
  if (fs.existsSync(scholarPath)) {
    const scholarships = JSON.parse(fs.readFileSync(scholarPath, 'utf-8'));
    opportunities.push(...scholarships.map(o => ({ ...o, source_category: 'scholarship' })));
  }
  
  // Load item funding
  const itemPath = path.join(__dirname, '../backend/data/crawlers/item_funding_sources.json');
  if (fs.existsSync(itemPath)) {
    const items = JSON.parse(fs.readFileSync(itemPath, 'utf-8'));
    opportunities.push(...items.map(o => ({ ...o, source_category: 'item_funding' })));
  }
  
  return opportunities;
}

// Build signals from profile data
function buildProfileSignals(profile, sections) {
  const signals = {
    keywords: new Set(),
    demographics: new Set(),
    health: new Set(),
    military: new Set(),
    education: new Set(),
    family: new Set(),
    financial: new Set(),
    location: new Set(),
    is_nonprofit: false
  };
  
  // Basic profile fields
  if (profile.state) signals.location.add(profile.state.toLowerCase());
  if (profile.city) signals.location.add(profile.city.toLowerCase());
  if (profile.focus_area) signals.keywords.add(profile.focus_area.toLowerCase());
  if (profile.organization_type) {
    signals.keywords.add(profile.organization_type.toLowerCase());
    if (profile.organization_type.toLowerCase().includes('nonprofit') || 
        profile.organization_type.toLowerCase().includes('501')) {
      signals.is_nonprofit = true;
    }
  }
  
  // Parse JSON fields using safeParseArrayField
  const tags = safeParseArrayField(profile.tags, []);
  tags.forEach(t => signals.keywords.add(t.toLowerCase()));
  
  const interests = safeParseArrayField(profile.interests, []);
  interests.forEach(i => signals.keywords.add(i.toLowerCase()));
  
  // Process sections
  for (const section of sections) {
    if (!section.data) continue;
    
    let data;
    try {
      data = typeof section.data === 'string' ? JSON.parse(section.data) : section.data;
    } catch (e) {
      continue;
    }
    
    switch (section.section_key) {
      case 'demographics':
        if (data.hispanic_latino) { signals.demographics.add('hispanic'); signals.demographics.add('latino'); }
        if (data.african_american || data.black) signals.demographics.add('african american');
        if (data.asian) signals.demographics.add('asian');
        if (data.native_american) { signals.demographics.add('native american'); signals.demographics.add('indigenous'); }
        if (data.pacific_islander) signals.demographics.add('pacific islander');
        if (data.female || data.woman) signals.demographics.add('women');
        if (data.lgbtq) signals.demographics.add('lgbtq');
        if (data.veteran) { signals.military.add('veteran'); signals.keywords.add('veteran'); }
        break;
        
      case 'health_disabilities':
      case 'health_medical':
        if (data.disability) { signals.health.add('disability'); signals.keywords.add('disability'); }
        if (data.chronic_illness) signals.health.add('chronic illness');
        if (data.mental_health) signals.health.add('mental health');
        if (data.epilepsy) signals.health.add('epilepsy');
        break;
        
      case 'military_service':
        if (data.veteran) { signals.military.add('veteran'); signals.keywords.add('veteran'); }
        if (data.disabled_veteran) signals.military.add('disabled veteran');
        if (data.military_spouse) signals.military.add('military spouse');
        break;
        
      case 'education':
        if (data.first_generation) { signals.education.add('first generation'); signals.keywords.add('first generation'); }
        if (data.current_student) { signals.education.add('student'); signals.keywords.add('student'); }
        if (data.intended_major) signals.keywords.add(data.intended_major.toLowerCase());
        break;
        
      case 'family_life':
        if (data.single_parent) { signals.family.add('single parent'); signals.keywords.add('single parent'); }
        if (data.caregiver || data.family_caregiver) { signals.family.add('caregiver'); signals.keywords.add('caregiver'); }
        if (data.domestic_violence_survivor) signals.family.add('domestic violence');
        break;
        
      case 'financial_information':
        if (data.financial_need_level === 'High' || data.financial_need_level === 'Critical') {
          signals.financial.add('financial need');
          signals.keywords.add('low income');
        }
        if (data.household_income && data.household_income < 50000) {
          signals.financial.add('low income');
          signals.keywords.add('low income');
        }
        break;
        
      case 'location_focus':
        if (data.state) signals.location.add(data.state.toLowerCase());
        if (data.appalachian_region) { signals.location.add('appalachian'); signals.keywords.add('appalachian'); }
        if (data.rural_area) { signals.location.add('rural'); signals.keywords.add('rural'); }
        break;
        
      case 'organization_details':
        if (data.organization_type) signals.keywords.add(data.organization_type.toLowerCase());
        if (data.is_501c3) signals.is_nonprofit = true;
        if (data.mission) {
          const missionTerms = ['health', 'education', 'community', 'youth', 'senior', 'disability', 
                               'veteran', 'faith', 'food', 'housing', 'arts', 'environment'];
          missionTerms.forEach(term => {
            if (data.mission.toLowerCase().includes(term)) signals.keywords.add(term);
          });
        }
        break;
        
      case 'basic_information':
        if (data.state) signals.location.add(data.state.toLowerCase());
        break;
    }
  }
  
  return signals;
}

// Calculate match score between opportunity and profile
function calculateMatchScore(opp, signals, profileState) {
  let score = 40; // Base score
  const matchReasons = [];
  
  const oppKeywords = new Set([
    ...(opp.keywords || []).map(k => k.toLowerCase()),
    ...(opp.categories || []).map(c => c.toLowerCase())
  ]);
  
  const oppText = `${opp.title || ''} ${opp.description || ''}`.toLowerCase();
  
  // State match (20 points)
  const oppState = opp.state?.toLowerCase() || 'nationwide';
  const pState = profileState?.toLowerCase();
  
  if (oppState === 'nationwide' || oppState === 'all') {
    score += 15;
    matchReasons.push('Available nationwide');
  } else if (pState && oppState === pState) {
    score += 20;
    matchReasons.push(`State: ${profileState}`);
  } else if (opp.states?.includes('ALL') || opp.states?.includes(profileState)) {
    score += 18;
    matchReasons.push(`Available in ${profileState}`);
  } else if (oppState && pState && oppState !== pState) {
    score -= 15; // Wrong state penalty
  }
  
  // Keyword matching (up to 25 points)
  let keywordMatches = 0;
  for (const keyword of signals.keywords) {
    if (oppKeywords.has(keyword) || oppText.includes(keyword)) {
      keywordMatches++;
      if (matchReasons.length < 5) {
        matchReasons.push(`Match: ${keyword}`);
      }
    }
  }
  score += Math.min(25, keywordMatches * 5);
  
  // Demographics (up to 15 points)
  for (const demo of signals.demographics) {
    if (oppText.includes(demo) || oppKeywords.has(demo)) {
      score += 5;
      matchReasons.push(`Demographic: ${demo}`);
      break;
    }
  }
  
  // Veteran status (15 points)
  if (signals.military.size > 0) {
    for (const mil of signals.military) {
      if (oppText.includes(mil) || oppText.includes('veteran') || oppKeywords.has('veteran')) {
        score += 15;
        matchReasons.push('Veteran benefits');
        break;
      }
    }
  }
  
  // Disability/health (10 points)
  if (signals.health.size > 0) {
    for (const h of signals.health) {
      if (oppText.includes(h) || oppKeywords.has('disability')) {
        score += 10;
        matchReasons.push('Disability support');
        break;
      }
    }
  }
  
  // Education (10 points)
  if (signals.education.size > 0 && (oppKeywords.has('scholarship') || oppKeywords.has('education') || 
      oppText.includes('scholarship') || oppText.includes('student'))) {
    score += 10;
    matchReasons.push('Education/scholarship');
  }
  
  // Financial need (10 points)
  if (signals.financial.size > 0 && (oppText.includes('low income') || oppText.includes('financial need') ||
      oppText.includes('need-based'))) {
    score += 10;
    matchReasons.push('Financial need support');
  }
  
  // 501c3 penalty if required but profile isn't nonprofit
  if (opp.requires_501c3 && !signals.is_nonprofit) {
    score -= 10;
  }
  
  score = Math.max(0, Math.min(100, score));
  
  return { score, matchReasons };
}

// Main seeding logic
console.log('\n1. Loading all real funding opportunities...');
const allOpportunities = loadAllRealOpportunities();
console.log(`   Loaded ${allOpportunities.length} real opportunities`);

console.log('\n2. Getting all profiles...');
const profiles = db.prepare('SELECT * FROM profiles WHERE id IS NOT NULL').all();
console.log(`   Found ${profiles.length} profiles`);

// First, clean up any fake grants from profiles
console.log('\n3. Removing fake grants from all profiles...');
const fakeGrantsRemoved = db.prepare(`
  DELETE FROM grants 
  WHERE funding_opportunity_id IN (
    SELECT id FROM funding_opportunities 
    WHERE source IN ('comprehensive_crawler', 'synthetic', 'template', 'fake')
  )
`).run();
console.log(`   Removed ${fakeGrantsRemoved.changes} fake grants`);

// Also remove grants with placeholder URLs
const placeholderGrantsRemoved = db.prepare(`
  DELETE FROM grants 
  WHERE application_url LIKE '%example.org%' 
  OR application_url LIKE '%example.com%'
`).run();
console.log(`   Removed ${placeholderGrantsRemoved.changes} placeholder grants`);

// Prepare insert statement — detect whether decision columns are present
const _grantCols = db.prepare('PRAGMA table_info(grants)').all().map(c => c.name);
const _hasDecisionCols = _grantCols.includes('match_decision');

const insertGrant = _hasDecisionCols
  ? db.prepare(`
      INSERT INTO grants (
        id, organization_id, profile_id, title, funder, deadline, status,
        match_score, match_reasons, application_url, amount_requested, notes,
        funding_opportunity_id,
        match_decision, match_explanation, matched_needs, eligibility_status,
        ineligibility_reasons, profile_fingerprint, opportunity_fingerprint,
        matcher_version, evaluated_at, match_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  : db.prepare(`
      INSERT INTO grants (
        id, organization_id, profile_id, title, funder, deadline, status,
        match_score, match_reasons, application_url, amount_requested, notes
      ) VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?)
    `);

const checkExisting = db.prepare(`
  SELECT id FROM grants WHERE profile_id = ? AND title = ?
`);

console.log('\n4. Seeding grants for each profile...');

let totalGrantsAdded = 0;

for (const profile of profiles) {
  console.log(`\n   Processing: ${profile.display_name || profile.id}`);
  
  // Get profile sections
  const sections = db.prepare('SELECT * FROM profile_sections WHERE profile_id = ?').all(profile.id);
  
  // Build signals (used as pre-filter heuristic — final acceptance uses computeMatchDecision below)
  const signals = buildProfileSignals(profile, sections);

  // Convert sections array to object format for canonical decision engine
  const sectionsObj = {};
  for (const row of sections) {
    try { sectionsObj[row.section_key] = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}); } catch { sectionsObj[row.section_key] = {}; }
  }

  // Fix: sections[].data is a JSON string — parse it before accessing .state
  function parseSectionData(sections, key) {
    const row = sections.find(s => s.section_key === key);
    if (!row || !row.data) return {};
    try { return typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch { return {}; }
  }
  const locFocusData = parseSectionData(sections, 'location_focus');
  const basicInfoData = parseSectionData(sections, 'basic_information');
  const addr = basicInfoData.address;
  let stateFromAddr = null;
  if (typeof addr === 'string') {
    stateFromAddr = (addr.match(/\b([A-Z]{2})\s*,?\s*\d{5}/) || [])[1] || null;
  } else if (addr && typeof addr === 'object') {
    stateFromAddr = addr.state || null;
  }
  const profileState = profile.state || locFocusData.state || basicInfoData.state || stateFromAddr || null;

  // Build profileData for relevance filter
  const demographicsData = parseSectionData(sections, 'demographics');
  const militaryData = parseSectionData(sections, 'military_service');
  const healthData = parseSectionData(sections, 'health_medical');
  const familyData = parseSectionData(sections, 'family_life');
  let parsedTags = [];
  try { parsedTags = typeof profile.tags === 'string' ? JSON.parse(profile.tags) : (profile.tags || []); } catch { parsedTags = []; }
  const profileData = {
    primary_type: profile.primary_type || null,
    veteran_status: militaryData.veteran || demographicsData.veteran_status || null,
    immigrant_status: demographicsData.immigrant_status || null,
    disability_status: healthData.disability_type || demographicsData.disability_status || null,
    state: profileState,
    tags: parsedTags,
    gender: basicInfoData.gender || demographicsData.gender || null,
    age: basicInfoData.age || demographicsData.age || null,
    foster_youth: familyData.foster_youth || null,
    first_responder: null,
  };
  
  // Get or create organization for this profile
  let orgId = profile.organization_id;
  if (!orgId) {
    // Check if org exists
    const existingOrg = db.prepare('SELECT id FROM organizations WHERE name = ?')
      .get(profile.display_name || 'Default Organization');
    
    if (existingOrg) {
      orgId = existingOrg.id;
    } else {
      orgId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
        VALUES (?, ?, 'individual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(orgId, profile.display_name || 'Default Organization');
    }
    
    // Link profile to org
    db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile.id);
  }
  
  // Score all opportunities
  const scoredOpps = [];
  for (const opp of allOpportunities) {
    // Skip if requires matching funds
    if (opp.requires_match) continue;
    
    const { score, matchReasons } = calculateMatchScore(opp, signals, profileState);
    
    // Stage 1 (junk filter): only skip obviously irrelevant candidates (score < 5).
    // The canonical decision engine (computeMatchDecision) is the final acceptance
    // authority — this heuristic must NOT exclude plausible canonical matches.
    if (score >= 5) {
      // Apply relevance filter before adding to candidates
      const oppForFilter = {
        ...opp,
        keywords: Array.isArray(opp.keywords) ? opp.keywords : (() => { try { return JSON.parse(opp.keywords || '[]'); } catch { return []; } })(),
        categories: Array.isArray(opp.categories) ? opp.categories : (() => { try { return JSON.parse(opp.categories || '[]'); } catch { return []; } })(),
      };
      const filterResult = applyRelevanceFilter(oppForFilter, profileData);
      if (!filterResult.pass) continue;

      scoredOpps.push({
        ...opp,
        match_score: score,
        match_reasons: matchReasons
      });
    }
  }
  
  // ---------------------------------------------------------------------------
  // Adaptive candidate selection — three-tier strategy:
  //   1. Junk filter (heuristic < 5): removes clear garbage (applied above).
  //   2. Adaptive cap (≤ ADAPTIVE_CANDIDATE_CAP pass through; > cap takes top N):
  //      bounds worst-case canonical engine calls while ensuring no plausible
  //      canonical match is excluded merely because it ranked below an old
  //      hard-50 cutoff. In practice, most profiles have well under 200
  //      junk-filtered candidates so the cap rarely activates.
  //   3. Canonical engine (computeMatchDecision): sole acceptance authority.
  // ---------------------------------------------------------------------------
  const ADAPTIVE_CANDIDATE_CAP = 200;
  let candidatePool;
  if (scoredOpps.length <= ADAPTIVE_CANDIDATE_CAP) {
    // Evaluate ALL junk-filtered candidates — no cap needed.
    candidatePool = scoredOpps;
  } else {
    // More than the cap: sort by heuristic and take the top N.
    // A ceiling of 200 is generous enough that missing a strong canonical
    // match is virtually impossible while keeping performance bounded.
    scoredOpps.sort((a, b) => b.match_score - a.match_score);
    candidatePool = scoredOpps.slice(0, ADAPTIVE_CANDIDATE_CAP);
  }

  const passingCount = scoredOpps.length <= ADAPTIVE_CANDIDATE_CAP
    ? `all ${scoredOpps.length}`
    : `top ${ADAPTIVE_CANDIDATE_CAP} of ${scoredOpps.length}`;
  console.log(`   Found ${scoredOpps.length} heuristic candidates (junk-filtered), passing ${passingCount} to canonical engine...`);

  let addedForProfile = 0;
  for (const opp of candidatePool) {
    // Check if already exists for this profile
    const existing = checkExisting.get(profile.id, opp.title);
    if (existing) continue;

    // --- CANONICAL DECISION ENGINE: final acceptance authority ---
    const decision = computeMatchDecision(profile, opp, { profileSections: sectionsObj });

    // Hard reject: never insert into profile pipeline
    if (decision.decision === 'REJECT') continue;

    // Use canonical score as the stored match score
    const finalScore = decision.score;

    try {
      if (_hasDecisionCols) {
        const profileFingerprint = computeProfileFingerprint(normalizeProfile(profile, sectionsObj)) ?? null;
        const opportunityFingerprint = computeOpportunityFingerprint(normalizeOpportunity(opp)) ?? null;
        insertGrant.run(
          crypto.randomUUID(),
          orgId,
          profile.id,
          opp.title,
          opp.sponsor,
          opp.deadline || null,
          finalScore,
          JSON.stringify(decision.matchedNeeds ?? []),
          opp.application_url || null,
          opp.amount_max || opp.amount_min || null,
          opp.description ? opp.description.substring(0, 500) : null,
          opp.id || null,
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
        );
      } else {
        insertGrant.run(
          crypto.randomUUID(),
          orgId,
          profile.id,
          opp.title,
          opp.sponsor,
          opp.deadline || null,
          finalScore,
          JSON.stringify(decision.matchedNeeds ?? []),
          opp.application_url || null,
          opp.amount_max || opp.amount_min || null,
          opp.description ? opp.description.substring(0, 500) : null,
        );
      }
      addedForProfile++;
      totalGrantsAdded++;
    } catch (err) {
      // Ignore duplicate errors
      if (!err.message.includes('UNIQUE')) {
        console.error(`   Error adding ${opp.title}:`, err.message);
      }
    }
  }
  
  console.log(`   Added ${addedForProfile} grants to pipeline`);
}

// Final summary
console.log('\n5. Summary:');
console.log(`   Total grants added: ${totalGrantsAdded}`);

const grantsByProfile = db.prepare(`
  SELECT p.display_name, COUNT(g.id) as grant_count
  FROM profiles p
  LEFT JOIN grants g ON p.id = g.profile_id
  GROUP BY p.id
`).all();

console.log('\n   Grants per profile:');
for (const row of grantsByProfile) {
  console.log(`     - ${row.display_name || 'Unknown'}: ${row.grant_count} grants`);
}

// Verify no fake grants remain
const fakeCheck = db.prepare(`
  SELECT COUNT(*) as count FROM grants 
  WHERE application_url LIKE '%example.org%' 
  OR application_url LIKE '%example.com%'
`).get();
console.log(`\n   Fake grants remaining: ${fakeCheck.count}`);

db.close();
console.log('\n✅ Done! Each profile now has real grants evaluated by the canonical decision engine.');
