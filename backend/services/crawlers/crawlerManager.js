/**
 * crawlerManager.js
 * 
 * THE COMPLETE REPLACEMENT for the old crawler system.
 * 
 * Old system: 6 crawlers all querying Grants.gov (wrong database)
 *             with Benefits.gov API calls that silently fail.
 * 
 * New system: Profile analysis → curated program matching → scored results.
 * 
 * Data flow:
 *   1. Profile → profileAnalyzer → structured needs
 *   2. Load curated data: federal benefits + state benefits + national programs
 *   3. Match programs against needs → scored results
 *   4. Store results in database
 * 
 * DELETE the following old files entirely:
 *   - governmentFundingCrawler.js
 *   - localFundingCrawler.js  
 *   - ecfBenefitsCrawler.js
 *   - healthResourcesCrawler.js
 *   - specialNeedsCrawler.js
 *   - studentGrantsCrawler.js
 *   - crawlerHelpers.js (old)
 *   - profileHelpers.js (old)
 */

import { analyzeProfile } from './profileAnalyzer.js';
import { matchPrograms } from './matchEngine.js';
import { FEDERAL_BENEFITS } from './data/federalBenefits.js';
import { NATIONAL_PROGRAMS } from './data/nationalPrograms.js';
import { SCHOLARSHIPS } from './data/scholarships.js';
import { generateStatePrograms, isStateInRegistry } from './data/stateBase.js';
import { upsertFundingOpportunity } from '../opportunityInserter.js';

let crawlSchemaEnsured = false;
async function ensureCrawlSchema(db) {
  if (crawlSchemaEnsured) return;
  const isPg = db?.dialect === 'postgres';
  const pk = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const ts = isPg ? 'TIMESTAMPTZ DEFAULT now()' : "DATETIME DEFAULT (datetime('now'))";
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS crawl_results (
        id ${pk},
        profile_id TEXT NOT NULL,
        program_id TEXT NOT NULL,
        program_name TEXT NOT NULL,
        program_url TEXT,
        program_description TEXT,
        match_score INTEGER DEFAULT 0,
        match_reasons TEXT,
        matched_categories TEXT,
        program_type TEXT,
        funding_type TEXT,
        max_amount TEXT,
        source_type TEXT,
        crawled_at ${ts}
      );
      CREATE INDEX IF NOT EXISTS idx_crawl_results_profile ON crawl_results(profile_id);
      CREATE INDEX IF NOT EXISTS idx_crawl_results_score ON crawl_results(match_score DESC);
      CREATE TABLE IF NOT EXISTS crawl_metadata (
        id ${pk},
        profile_id TEXT NOT NULL UNIQUE,
        state TEXT,
        analysis_json TEXT,
        county_contacts TEXT,
        total_matches INTEGER,
        crawled_at ${ts}
      );
    `);
    crawlSchemaEnsured = true;
  } catch (err) {
    if (!String(err?.message).includes('already exists')) {
      console.error('[CrawlerManager] Schema ensure error:', err.message);
    }
    crawlSchemaEnsured = true;
  }
}

// Dynamic state data loader — tries dedicated file first, falls back to auto-generated
async function loadStateData(stateCode) {
  if (!stateCode) return { benefits: [], countyResources: null, meta: null };

  // 1. Try dedicated state file (WV.js, TN.js, etc.)
  try {
    const mod = await import(`./data/states/${stateCode}.js`);
    console.log(`[CrawlerManager] Loaded dedicated state file for ${stateCode}`);
    return {
      benefits: (mod.STATE_BENEFITS || []).map(b => ({ ...b, stateRestriction: stateCode })),
      countyResources: mod.COUNTY_RESOURCES || {},
      meta: mod.STATE_META || null,
    };
  } catch {
    // No dedicated file — fall through to auto-generated
  }

  // 2. Auto-generate from state registry
  if (isStateInRegistry(stateCode)) {
    const generated = generateStatePrograms(stateCode);
    console.log(`[CrawlerManager] Auto-generated ${generated.benefits.length} programs for ${stateCode} from registry`);
    return {
      benefits: generated.benefits.map(b => ({ ...b, stateRestriction: stateCode })),
      countyResources: generated.countyResources || {},
      meta: generated.meta,
    };
  }

  console.warn(`[CrawlerManager] No data for state ${stateCode}. Using federal/national only.`);
  return { benefits: [], countyResources: null, meta: null };
}

/**
 * Generate per-school funding opportunity cards from university application portal data.
 * Each school with populated financial-aid portals, department contacts, etc. gets cards
 * injected directly into the results so they appear as clickable funding opportunities.
 */
function generateSchoolCards(analysis) {
  const schools = analysis.schools || [];
  if (schools.length === 0) return [];

  const cards = [];
  const gender = analysis.demographics?.gender || null;

  for (const school of schools) {
    const prefix = school.name;
    const slug = (school.id || school.name).replace(/\s+/g, '-').toLowerCase();
    const baseScore = 85;
    const hasPortal = !!school.portals?.financialAid;

    // Construct a Google-searchable fallback URL when no portal is stored
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(school.name + ' financial aid office')}`;

    // Financial Aid card — ALWAYS generated for every target school
    const finaidUrl = school.portals?.financialAid || school.website || searchUrl;
    const finaidDesc = school.portals?.financialAid
      ? `Apply for institutional scholarships, grants, and work-study through ${prefix}'s financial aid portal.`
      : `${prefix} is a target school. Add the financial aid portal URL in the school card to get direct-link access.`;
    const finaidExtra = [
      school.fafsaCode ? `FAFSA Code: ${school.fafsaCode}` : null,
      school.financialAidDeadline ? `Aid deadline: ${school.financialAidDeadline}` : null,
      school.tuition ? `Tuition: $${school.tuition.toLocaleString()}` : null,
    ].filter(Boolean).join('. ');

    cards.push({
      id: `school-finaid-${slug}`,
      name: `${prefix} — Financial Aid`,
      description: `${finaidDesc}${finaidExtra ? ' ' + finaidExtra + '.' : ''}`,
      url: finaidUrl,
      categories: ['education', 'financial'],
      type: 'school_portal',
      fundingType: 'institutional_aid',
      matchScore: hasPortal ? baseScore + 5 : baseScore - 5,
      matchReasons: [`Target school: ${prefix}`, hasPortal ? 'Financial aid portal linked' : 'Portal URL not yet added'],
      contact: extractPrimaryContact(school.contacts, 'Financial Aid'),
      schoolName: prefix,
    });

    // Admissions Portal card — only when URL is present
    if (school.portals?.admissions) {
      cards.push({
        id: `school-admissions-${slug}`,
        name: `${prefix} — Admissions Portal`,
        description: `Track your application status, submit documents, and communicate with ${prefix}'s admissions office.`,
        url: school.portals.admissions,
        categories: ['education'],
        type: 'school_portal',
        fundingType: 'application_resource',
        matchScore: baseScore,
        matchReasons: [`Admissions portal for target school: ${prefix}`],
        contact: extractPrimaryContact(school.contacts, 'Admissions'),
        schoolName: prefix,
      });
    }

    // Department contacts matching student interests
    if (school.departmentContacts && school.departmentContacts.length > 0) {
      const relevantDepts = filterDeptContactsByInterest(
        school.departmentContacts,
        analysis.interests,
        analysis.sports,
        gender,
      );

      for (const dept of relevantDepts) {
        const deptSlug = (dept.area || 'dept').replace(/\s+/g, '-').toLowerCase();
        const contactLines = [];
        if (dept.name) contactLines.push(dept.name);
        if (dept.title) contactLines.push(dept.title);
        if (dept.email) contactLines.push(dept.email);
        if (dept.phone) contactLines.push(dept.phone);

        cards.push({
          id: `school-dept-${slug}-${deptSlug}`,
          name: `${prefix} — ${dept.area || 'Department Contact'}`,
          description: `Contact for ${dept.area || 'this program'} at ${prefix}. ${contactLines.join(' | ')}`,
          url: dept.url || school.website || searchUrl,
          categories: ['education'],
          type: 'school_department',
          fundingType: 'department_contact',
          matchScore: baseScore + 3,
          matchReasons: [`Department contact for interest: ${dept.area}`],
          contact: {
            name: dept.name || null,
            title: dept.title || null,
            email: dept.email || null,
            phone: dept.phone || null,
          },
          schoolName: prefix,
        });
      }
    }

    // Counseling / advising card
    if (school.portals?.counseling) {
      cards.push({
        id: `school-counseling-${slug}`,
        name: `${prefix} — Academic Counseling & Advising`,
        description: `Access academic counseling, disability services, and advising resources at ${prefix}.`,
        url: school.portals.counseling,
        categories: ['education'],
        type: 'school_portal',
        fundingType: 'support_service',
        matchScore: baseScore - 5,
        matchReasons: [`Counseling portal for target school: ${prefix}`],
        schoolName: prefix,
      });
    }

    // Transcript / Score sending cards
    if (school.portals?.transcripts || school.portals?.sendScores) {
      const urls = [];
      if (school.portals.transcripts) urls.push({ label: 'Transcripts', url: school.portals.transcripts });
      if (school.portals.sendScores) urls.push({ label: 'Send Scores', url: school.portals.sendScores });

      cards.push({
        id: `school-docs-${slug}`,
        name: `${prefix} — Transcript & Score Submission`,
        description: `Submit official transcripts and test scores to ${prefix}. ${urls.map(u => u.label + ': ' + u.url).join(' | ')}`,
        url: urls[0].url,
        categories: ['education'],
        type: 'school_portal',
        fundingType: 'application_resource',
        matchScore: baseScore - 10,
        matchReasons: [`Document submission portal for target school: ${prefix}`],
        schoolName: prefix,
      });
    }
  }

  return cards;
}

function extractPrimaryContact(contacts, labelHint) {
  if (!contacts || contacts.length === 0) return null;
  const match = contacts.find(c =>
    c.label && c.label.toLowerCase().includes(labelHint.toLowerCase()),
  );
  const c = match || contacts[0];
  if (!c.name && !c.email && !c.phone) return null;
  return { name: c.name, title: c.title, email: c.email, phone: c.phone };
}

function filterDeptContactsByInterest(deptContacts, interests, sports, gender) {
  const interestSet = interests instanceof Set ? interests : new Set(interests || []);
  const sportSet = sports instanceof Set ? sports : new Set(sports || []);
  const allInterests = new Set([...interestSet, ...sportSet]);

  if (allInterests.size === 0) return deptContacts;

  const needleSet = new Set();
  for (const interest of allInterests) {
    needleSet.add(String(interest).toLowerCase().trim());
  }

  return deptContacts.filter(dept => {
    const haystack = [dept.area, dept.category, dept.name, dept.title]
      .filter(Boolean)
      .map(s => s.toLowerCase())
      .join(' ');

    for (const needle of needleSet) {
      if (haystack.includes(needle)) {
        if (gender && dept.genderTarget && dept.genderTarget !== 'any' && dept.genderTarget !== 'unknown') {
          const gNorm = gender.toLowerCase();
          const tNorm = dept.genderTarget.toLowerCase();
          if (gNorm === 'female' && tNorm === 'men') continue;
          if (gNorm === 'male' && tNorm === 'women') continue;
        }
        return true;
      }
    }
    return false;
  });
}

/**
 * Run the full crawler pipeline for a profile.
 * 
 * @param {Object} db - Database connection
 * @param {string} profileId - Profile ID to crawl for
 * @param {Object} options - { minScore, maxResults, forceRefresh }
 * @returns {Object} { results, analysis, statePortal, countyContacts }
 */
export async function runCrawler(db, profileId, options = {}) {
  const { minScore = 25, maxResults = 100, forceRefresh = false } = options;

  await ensureCrawlSchema(db);

  console.log(`\n[CrawlerManager] ═══════════════════════════════════════`);
  console.log(`[CrawlerManager] Starting crawl for profile: ${profileId}`);
  console.log(`[CrawlerManager] ═══════════════════════════════════════\n`);

  // ── Step 1: Analyze the profile ──
  console.log('[CrawlerManager] Step 1: Analyzing profile...');
  const analysis = await analyzeProfile(db, profileId);
  
  if (!analysis.location.state) {
    console.warn('[CrawlerManager] WARNING: No state detected in profile. Results will be federal/national only.');
  }

  // ── Step 2: Load all program data ──
  console.log('[CrawlerManager] Step 2: Loading program data...');
  const stateData = await loadStateData(analysis.location.state);
  
  // Include scholarships only for student profiles
  const scholarshipPrograms = analysis.applicantType === 'student' ? SCHOLARSHIPS : [];

  const allPrograms = [
    ...FEDERAL_BENEFITS,
    ...stateData.benefits,
    ...NATIONAL_PROGRAMS,
    ...scholarshipPrograms,
  ];

  console.log(`[CrawlerManager]   Federal programs:  ${FEDERAL_BENEFITS.length}`);
  console.log(`[CrawlerManager]   State programs:    ${stateData.benefits.length}`);
  console.log(`[CrawlerManager]   National programs: ${NATIONAL_PROGRAMS.length}`);
  console.log(`[CrawlerManager]   Scholarships:      ${scholarshipPrograms.length}`);
  console.log(`[CrawlerManager]   Total candidates:  ${allPrograms.length}`);

  // ── Step 3: Match and score ──
  console.log('[CrawlerManager] Step 3: Matching programs to profile needs...');
  const results = matchPrograms(allPrograms, analysis, { minScore, maxResults });

  console.log(`[CrawlerManager]   Matched programs:  ${results.length}`);
  if (results.length > 0) {
    console.log(`[CrawlerManager]   Top match: ${results[0].name} (${results[0].matchScore}%)`);
    console.log(`[CrawlerManager]   Lowest match: ${results[results.length - 1].name} (${results[results.length - 1].matchScore}%)`);
  }

  // ── Step 4: Generate per-school funding cards from university application portals ──
  const schoolCards = generateSchoolCards(analysis);
  if (schoolCards.length > 0) {
    results.push(...schoolCards);
    results.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
    console.log(`[CrawlerManager]   School-specific cards: ${schoolCards.length}`);
  }

  // ── Step 5: Resolve county-level contacts ──
  let countyContacts = null;
  if (analysis.location.county && stateData.countyResources) {
    const countyKey = analysis.location.county.toLowerCase().replace(/\s+county$/i, '').trim();
    countyContacts = stateData.countyResources[countyKey] || null;
    if (countyContacts) {
      console.log(`[CrawlerManager]   Found county contacts for: ${analysis.location.county}`);
    }
  }

  // ── Step 6: Store results ──
  console.log('[CrawlerManager] Step 5: Storing results...');
  await storeResults(db, profileId, results, analysis, stateData.meta, countyContacts);

  console.log(`\n[CrawlerManager] ═══════════════════════════════════════`);
  console.log(`[CrawlerManager] Crawl complete. ${results.length} programs matched.`);
  console.log(`[CrawlerManager] ═══════════════════════════════════════\n`);

  return {
    results,
    analysis,
    statePortal: stateData.meta,
    countyContacts,
  };
}

/**
 * Store results in the database.
 * Clears old results and writes new ones.
 */
async function storeResults(db, profileId, results, analysis, stateMeta, countyContacts) {
  const isPg = db?.dialect === 'postgres';
  const nowExpr = isPg ? 'now()' : "datetime('now')";

  try {
    await db.prepare('DELETE FROM crawl_results WHERE profile_id = ?').run(profileId);

    const stmt = db.prepare(`
      INSERT INTO crawl_results (
        profile_id, program_id, program_name, program_url, program_description,
        match_score, match_reasons, matched_categories,
        program_type, funding_type, max_amount,
        source_type, crawled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowExpr})
    `);

    for (const result of results) {
      await stmt.run(
        profileId,
        result.id,
        result.name,
        result.url || result.applicationUrl || null,
        result.description,
        result.matchScore,
        JSON.stringify(result.matchReasons),
        JSON.stringify(result.matchedCategories),
        result.type,
        result.fundingType,
        result.maxAmount || null,
        result.id?.startsWith('school-') ? 'school' : (result.stateRestriction ? 'state' : (result.id.startsWith('fed-') ? 'federal' : 'national')),
      );
    }

    // Upsert crawl metadata — store analysis as a single JSON blob for cross-dialect compat
    const analysisJson = JSON.stringify({
      needs: [...analysis.needs],
      demographics: [...analysis.demographics],
      health: [...analysis.health],
      family: [...analysis.family],
      military: [...analysis.military],
      county: analysis.location.county,
      statePortalUrl: stateMeta?.benefitsPortal || null,
      statePortalName: stateMeta?.benefitsPortalName || null,
    });

    if (isPg) {
      await db.prepare(`
        INSERT INTO crawl_metadata (profile_id, state, analysis_json, county_contacts, total_matches, crawled_at)
        VALUES (?, ?, ?, ?, ?, now())
        ON CONFLICT (profile_id) DO UPDATE SET
          state = EXCLUDED.state,
          analysis_json = EXCLUDED.analysis_json,
          county_contacts = EXCLUDED.county_contacts,
          total_matches = EXCLUDED.total_matches,
          crawled_at = now()
      `).run(
        profileId,
        analysis.location.state,
        analysisJson,
        countyContacts ? JSON.stringify(countyContacts) : null,
        results.length,
      );
    } else {
      await db.prepare(`
        INSERT OR REPLACE INTO crawl_metadata (
          profile_id, state, analysis_json, county_contacts, total_matches, crawled_at
        ) VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(
        profileId,
        analysis.location.state,
        analysisJson,
        countyContacts ? JSON.stringify(countyContacts) : null,
        results.length,
      );
    }
    console.log(`[CrawlerManager]   Occupation: [${[...(analysis.occupation || [])]}]`);
    console.log(`[CrawlerManager]   Immigration: [${[...(analysis.immigration || [])]}]`);
    console.log(`[CrawlerManager]   Geographic: [${[...(analysis.geographic || [])]}]`);

    console.log(`[CrawlerManager]   Stored ${results.length} results + metadata in crawl_results`);

    // Also upsert into funding_opportunities so results appear as clickable cards
    let fundingUpserted = 0;
    for (const result of results) {
      try {
        const isSchoolCard = result.id?.startsWith('school-');
        const contactObj = result.contact || null;
        const contactInfo = contactObj
          ? [contactObj.name, contactObj.title, contactObj.email, contactObj.phone].filter(Boolean).join(' | ')
          : null;

        const opp = {
          title: result.name,
          description: result.description,
          sponsor: isSchoolCard
            ? (result.schoolName || 'University Program')
            : result.stateRestriction
              ? `${result.stateRestriction} State Program`
              : (result.id.startsWith('fed-') ? 'Federal Program' : (result.id.startsWith('sch-') ? 'Scholarship / Financial Aid' : 'National Program')),
          source: isSchoolCard ? 'school_portal' : (result.id.startsWith('sch-') ? 'scholarship_crawler' : 'curated_benefits'),
          source_url: result.url || result.applicationUrl || null,
          url: result.url || result.applicationUrl || null,
          application_url: result.applicationUrl || result.url || null,
          state: result.stateRestriction || 'nationwide',
          is_national: !result.stateRestriction,
          opportunity_type: isSchoolCard ? 'school_resource' : (result.type === 'portal' ? 'directory' : (result.type === 'grant' ? 'grant' : 'program')),
          type: isSchoolCard ? 'DIRECTORY' : (result.type === 'portal' ? 'DIRECTORY' : 'OPPORTUNITY'),
          deadline_type: result.recurring ? 'rolling' : (result.deadline || 'rolling'),
          amount_min: null,
          amount_max: result.maxAmount || null,
          contact_info: contactInfo,
          categories: JSON.stringify(result.categories || []),
          keywords: JSON.stringify(result.matchedCategories || []),
          match_reasons: JSON.stringify(result.matchReasons || []),
          match_score: result.matchScore,
          funding_type: result.fundingType,
          record_origin: isSchoolCard ? 'curated_verified' : 'curated_verified',
          last_verified_at: new Date().toISOString(),
          profile_id: isSchoolCard ? profileId : null,
        };
        await upsertFundingOpportunity(db, opp);
        fundingUpserted++;
      } catch (upsertErr) {
        console.warn(`[CrawlerManager] funding_opportunities upsert failed for ${result.id}: ${upsertErr.message}`);
      }
    }
    console.log(`[CrawlerManager]   Upserted ${fundingUpserted} into funding_opportunities`);
  } catch (err) {
    console.error('[CrawlerManager] Error storing results:', err.message);
    throw err;
  }
}

/**
 * Database schema for new tables.
 * Run this once to create/update tables.
 */
export const SCHEMA = `
-- Drop old crawler results if migrating
-- DROP TABLE IF EXISTS grant_results;

CREATE TABLE IF NOT EXISTS crawl_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  program_name TEXT NOT NULL,
  program_url TEXT,
  program_description TEXT,
  match_score INTEGER NOT NULL,
  match_reasons TEXT, -- JSON array
  matched_categories TEXT, -- JSON array
  program_type TEXT, -- 'benefit', 'grant', 'assistance', 'portal', 'referral'
  funding_type TEXT, -- 'direct_benefit', 'direct_grant', 'direct_service', 'referral_service'
  max_amount REAL,
  source_type TEXT, -- 'federal', 'state', 'national'
  crawled_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(profile_id, program_id)
);

CREATE TABLE IF NOT EXISTS crawl_metadata (
  profile_id TEXT PRIMARY KEY,
  needs TEXT, -- JSON array
  demographics TEXT, -- JSON array
  health_signals TEXT, -- JSON array
  family_signals TEXT, -- JSON array
  military_signals TEXT, -- JSON array
  state TEXT,
  county TEXT,
  state_portal_url TEXT,
  state_portal_name TEXT,
  county_contacts TEXT, -- JSON
  total_matches INTEGER,
  crawled_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crawl_results_profile ON crawl_results(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawl_results_score ON crawl_results(match_score DESC);
`;

export default { runCrawler, SCHEMA };
