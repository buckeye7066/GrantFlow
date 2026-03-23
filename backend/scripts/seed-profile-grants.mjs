import Database from 'better-sqlite3';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { applyRelevanceFilter } from '../services/relevanceFilter.js';
import { buildProfileSignals } from '../services/profileHelpers.js';
import {
  computeMatchDecision,
  normalizeProfile,
  normalizeOpportunity,
  computeProfileFingerprint,
  computeOpportunityFingerprint,
  MATCHER_VERSION,
} from '../services/matchDecisionEngine.js';

// Safety guard: refuse to run in production or when seeding is explicitly disabled.
const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
const disableSeeding = String(process.env.DISABLE_SEEDING || '').trim().toLowerCase()
if (nodeEnv === 'production' || disableSeeding === 'true' || disableSeeding === '1') {
  console.error('[seed-profile-grants] Refusing to run in production environment. Seeding disabled.')
  process.exit(1)
}

const db = new Database('./data/grantflow.db');

console.log('=== SEEDING GRANTS FOR PROFILES ===\n');

// Get profiles
const profiles = db.prepare('SELECT * FROM profiles').all();
console.log(`Found ${profiles.length} profiles`);

// Get funding opportunities
const opportunities = db.prepare('SELECT * FROM funding_opportunities WHERE is_active = 1 OR is_active IS NULL LIMIT 200').all();
console.log(`Found ${opportunities.length} opportunities\n`);

// Detect whether decision columns are present in the grants table
const _grantsCols = db.prepare('PRAGMA table_info(grants)').all().map(c => c.name);
const _hasDecisionCols = _grantsCols.includes('match_decision');

// Insert grants — include profile_id for correct pipeline scoping
// When decision columns are present (migrated schema), store full canonical metadata.
const insertGrant = _hasDecisionCols
  ? db.prepare(`
      INSERT INTO grants (
        id, organization_id, profile_id, funding_opportunity_id, title, funder,
        amount_requested, status, match_score, match_reasons, notes,
        match_decision, match_explanation, matched_needs, eligibility_status,
        ineligibility_reasons, profile_fingerprint, opportunity_fingerprint,
        matcher_version, evaluated_at, match_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  : db.prepare(`
      INSERT INTO grants (id, organization_id, profile_id, funding_opportunity_id, title, funder, amount_requested, status, match_score, match_reasons, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)
    `);

let totalGrantsCreated = 0;

for (const profile of profiles) {
  console.log(`\n${profile.display_name}:`);

  // Get profile sections
  const sectionRows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
  const sections = {};
  for (const row of sectionRows) {
    try { sections[row.section_key] = JSON.parse(row.data || '{}'); } catch { sections[row.section_key] = {}; }
  }

  // Build canonical signals using profileHelpers
  let signals;
  try {
    signals = buildProfileSignals({ profile, sections });
  } catch (e) {
    console.warn(`  ⚠ buildProfileSignals failed: ${e.message}`);
    continue;
  }

  const demographics = sections.demographics || {};
  const military = sections.military_service || {};
  const health = sections.health_medical || {};
  const family = sections.family_life || {};
  const basic = sections.basic_information || {};
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
    state: basic.state || locFocus.state || stateFromAddr || null,
    tags: [],
    gender: basic.gender || demographics.gender || null,
    age: basic.age || demographics.age || null,
    foster_youth: family.foster_youth || null,
    first_responder: null,
  };

  // Determine profile type keywords
  const type = profile.primary_type || 'individual';
  
  // Find matching opportunities using canonical signals (not broad hardcoded keywords)
  let matchedOpps = 0;
  
  for (const opp of opportunities) {
    // Apply relevance filter first
    const oppForFilter = {
      ...opp,
      keywords: (() => { try { return JSON.parse(opp.keywords || '[]'); } catch { return []; } })(),
      categories: (() => { try { return JSON.parse(opp.categories || '[]'); } catch { return []; } })(),
    };
    const filterResult = applyRelevanceFilter(oppForFilter, profileData);
    if (!filterResult.pass) continue;

    // Score based on canonical signals (used as pre-filter heuristic only)
    const oppText = `${opp.title || ''} ${opp.description || ''}`.toLowerCase();
    const oppKws = new Set(oppForFilter.keywords.map(k => k.toLowerCase()));
    let heuristicScore = 0;

    // Geographic
    const oppState = (opp.state || '').toLowerCase();
    const profState = (profileData.state || '').toLowerCase();
    if (!oppState || oppState === 'nationwide' || opp.is_national) {
      heuristicScore += 8;
    } else if (profState && oppState === profState) {
      heuristicScore += 18;
    } else if (profState && oppState && oppState !== profState) {
      heuristicScore -= 20;
    }

    // Intent phrases (5 pts each)
    if (signals.intentPhraseSet) {
      for (const phrase of signals.intentPhraseSet) {
        const p = String(phrase).toLowerCase();
        if (p.length >= 4 && (oppText.includes(p) || oppKws.has(p))) {
          heuristicScore += 5;
        }
      }
    }

    // Keywords from profile signals (1.5 pts in opp keywords, 0.5 in text)
    const kwSet = signals.keywordSet || signals.keywords || new Set();
    for (const kw of kwSet) {
      const k = String(kw).toLowerCase();
      if (k.length < 3 || k.includes(' ')) continue;
      if (oppKws.has(k)) { heuristicScore += 1.5; }
      else if (oppText.includes(k)) { heuristicScore += 0.5; }
    }

    heuristicScore = Math.max(0, Math.min(100, Math.floor(heuristicScore)));

    // Pre-filter: skip obviously poor heuristic matches to avoid calling decision engine on every opp
    if (heuristicScore < 10 || matchedOpps >= 50) continue;

    // --- CANONICAL DECISION ENGINE: final acceptance authority ---
    const decision = computeMatchDecision(profile, opp, { profileSections: sections });

    // Hard reject: never insert into profile pipeline
    if (decision.decision === 'REJECT') continue;

    // Use canonical score as the stored match score
    const score = decision.score;

    // Only save if canonical score meets threshold (65 for this seeding script)
    if (score < 65) continue;

    {
      const grantId = crypto.randomUUID();
      // Ensure org exists
      let orgId = profile.organization_id;
      if (!orgId) {
        const existingOrg = db.prepare('SELECT id FROM organizations WHERE name = ?').get(profile.display_name || '');
        orgId = existingOrg?.id || crypto.randomUUID();
        if (!existingOrg) {
          db.prepare(`INSERT INTO organizations (id, name, applicant_type, created_at, updated_at) VALUES (?, ?, 'individual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(orgId, profile.display_name || 'Default Org');
          db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile.id);
        }
      }
      try {
        if (_hasDecisionCols) {
          const profileFingerprint = computeProfileFingerprint(normalizeProfile(profile, sections)) ?? null;
          const opportunityFingerprint = computeOpportunityFingerprint(normalizeOpportunity(opp)) ?? null;
          insertGrant.run(
            grantId,
            orgId,
            profile.id,
            opp.id,
            opp.title,
            opp.sponsor || opp.source,
            opp.amount_max || opp.amount_min || null,
            score,
            JSON.stringify(decision.matchedNeeds ?? []),
            `Auto-matched for ${profile.display_name}`,
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
            grantId,
            orgId,
            profile.id,
            opp.id,
            opp.title,
            opp.sponsor || opp.source,
            opp.amount_max || opp.amount_min || null,
            score,
            JSON.stringify(decision.matchedNeeds ?? []),
            `Auto-matched for ${profile.display_name}`,
          );
        }
        console.log(`  ✓ ${opp.title.substring(0, 50)}... (${score}% canonical:${decision.decision})`);
        matchedOpps++;
        totalGrantsCreated++;
      } catch (err) {
        // Skip duplicates
        if (!err.message.includes('UNIQUE')) {
          console.log(`  ✗ ${err.message.substring(0, 50)}`);
        }
      }
    }
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Total grants created: ${totalGrantsCreated}`);

// Verify
const grantCount = db.prepare('SELECT COUNT(*) as c FROM grants').get().c;
console.log(`Grants in database: ${grantCount}`);

// Show grants per profile
console.log('\nGrants per profile:');
const byProfile = db.prepare(`
  SELECT p.display_name, COUNT(g.id) as grant_count
  FROM profiles p
  LEFT JOIN grants g ON p.id = g.profile_id
  GROUP BY p.id
  ORDER BY grant_count DESC
`).all();

byProfile.forEach(p => {
  console.log(`  ${p.display_name}: ${p.grant_count}`);
});

db.close();
console.log('\n✓ Done!');
