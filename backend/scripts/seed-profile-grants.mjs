import Database from 'better-sqlite3';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { applyRelevanceFilter } from '../services/relevanceFilter.js';

// Safety guard: refuse to run in production or when seeding is explicitly disabled.
const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
const disableSeeding = String(process.env.DISABLE_SEEDING || '').trim().toLowerCase()
if (nodeEnv === 'production' || disableSeeding === 'true' || disableSeeding === '1') {
  console.error('[seed-profile-grants] Refusing to run in production environment. This script generates random match scores and must not be used in production.')
  process.exit(1)
}

const db = new Database('./data/grantflow.db');

console.log('=== SEEDING GRANTS FOR PROFILES ===\n');

// Get profiles
const profiles = db.prepare('SELECT id, display_name, primary_type FROM profiles').all();
console.log(`Found ${profiles.length} profiles`);

// Get funding opportunities
const opportunities = db.prepare('SELECT * FROM funding_opportunities WHERE is_active = 1 OR is_active IS NULL LIMIT 50').all();
console.log(`Found ${opportunities.length} opportunities\n`);

// Profile-to-opportunity relevance mapping
const profileKeywords = {
  'student': ['pell', 'scholarship', 'education', 'student', 'college'],
  'family': ['liheap', 'snap', 'wic', 'family', 'housing', 'assistance'],
  'individual': ['assistance', 'support', 'grant', 'program', 'benefit'],
  'organization': ['nonprofit', '501c3', 'community', 'organization', 'grant'],
  'small_business': ['business', 'entrepreneur', 'small business', 'loan', 'sba'],
};

// Insert grants
const insertGrant = db.prepare(`
  INSERT INTO grants (id, organization_id, funding_opportunity_id, title, funder, amount_requested, status, match_score, match_reasons, notes)
  VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)
`);

let totalGrantsCreated = 0;

for (const profile of profiles) {
  console.log(`\n${profile.display_name}:`);

  // Get profile sections for relevance filter
  const sectionRows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
  const sections = {};
  for (const row of sectionRows) {
    try { sections[row.section_key] = JSON.parse(row.data || '{}'); } catch { sections[row.section_key] = {}; }
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
  const keywords = profileKeywords[type] || profileKeywords['individual'];
  
  // Find matching opportunities
  let matchedOpps = 0;
  
  for (const opp of opportunities) {
    const title = (opp.title || '').toLowerCase();
    const desc = (opp.description || '').toLowerCase();
    const combined = title + ' ' + desc;
    
    // Check if any keyword matches
    const matches = keywords.some(kw => combined.includes(kw.toLowerCase()));
    
    if (matches && matchedOpps < 5) { // Limit 5 per profile
      // Apply relevance filter before inserting
      const oppForFilter = {
        ...opp,
        keywords: (() => { try { return JSON.parse(opp.keywords || '[]'); } catch { return []; } })(),
        categories: (() => { try { return JSON.parse(opp.categories || '[]'); } catch { return []; } })(),
      };
      const filterResult = applyRelevanceFilter(oppForFilter, profileData);
      if (!filterResult.pass) continue;

      const grantId = crypto.randomUUID();
      const matchScore = 75 + Math.floor(Math.random() * 20); // 75-94%
      const matchReasons = JSON.stringify([
        `Matches ${type} profile type`,
        `Relevant to ${profile.display_name}`,
        `Found via crawler`
      ]);
      
      try {
        insertGrant.run(
          grantId,
          profile.id,  // Using profile.id as organization_id for individual profiles
          opp.id,
          opp.title,
          opp.sponsor || opp.source,
          opp.amount_max || opp.amount_min || 5000,
          matchScore,
          matchReasons,
          `Auto-matched for ${profile.display_name}`
        );
        console.log(`  ✓ ${opp.title.substring(0, 50)}... (${matchScore}%)`);
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
  
  if (matchedOpps === 0) {
    // Add some general opportunities (filtered)
    for (const opp of opportunities.slice(0, 3)) {
      const oppForFilter = {
        ...opp,
        keywords: (() => { try { return JSON.parse(opp.keywords || '[]'); } catch { return []; } })(),
        categories: (() => { try { return JSON.parse(opp.categories || '[]'); } catch { return []; } })(),
      };
      if (!applyRelevanceFilter(oppForFilter, profileData).pass) continue;
      const grantId = crypto.randomUUID();
      try {
        insertGrant.run(
          grantId,
          profile.id,
          opp.id,
          opp.title,
          opp.sponsor || opp.source,
          opp.amount_max || 5000,
          70,
          JSON.stringify(['General opportunity', 'May be relevant']),
          `Auto-matched for ${profile.display_name}`
        );
        console.log(`  + ${opp.title.substring(0, 50)}...`);
        totalGrantsCreated++;
        break; // Only add one general opportunity
      } catch (err) {
        // Skip duplicates
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
  LEFT JOIN grants g ON p.id = g.organization_id
  GROUP BY p.id
  ORDER BY grant_count DESC
`).all();

byProfile.forEach(p => {
  console.log(`  ${p.display_name}: ${p.grant_count}`);
});

db.close();
console.log('\n✓ Done!');
