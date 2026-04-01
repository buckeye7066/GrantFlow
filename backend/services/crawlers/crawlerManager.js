/**
 * crawlerManager.js
 *
 * Strategy-routed crawler pipeline.
 *
 * Data flow:
 *   1. Profile → profileSignals → canonical signals + intents
 *   2. Strategy registry selects candidate sources + scoring rules
 *   3. Load curated data per strategy
 *   4. Match programs → scored results with match_explain
 *   5. URL policy enforcement
 *   6. Store results
 */

import { loadProfileSignals, buildSignalsFromContext } from '../profileSignals/index.js';
import { matchPrograms } from './matchEngine.js';
import { getStrategy, checkGates } from './strategyRegistry.js';
import { FEDERAL_BENEFITS } from './data/federalBenefits.js';
import { NATIONAL_PROGRAMS } from './data/nationalPrograms.js';
import { BUSINESS_PROGRAMS } from './data/businessPrograms.js';
import { SCHOLARSHIPS } from './data/scholarships.js';
import { generateStatePrograms, isStateInRegistry } from './data/stateBase.js';
import { upsertFundingOpportunity } from '../opportunityInserter.js';

// ── Schema bootstrap ──

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
      throw err; // Re-throw non-duplicate errors
    }
    crawlSchemaEnsured = true;
  }
}

// ── State data loader ──

async function loadStateData(stateCode) {
  if (!stateCode) return { benefits: [], countyResources: null, meta: null };
  try {
    const mod = await import(`./data/states/${stateCode}.js`);
    return {
      benefits: (mod.STATE_BENEFITS || []).map(b => ({ ...b, stateRestriction: stateCode })),
      countyResources: mod.COUNTY_RESOURCES || {},
      meta: mod.STATE_META || null,
    };
  } catch (importErr) {
    // Only suppress MODULE_NOT_FOUND (file genuinely absent); re-log anything else
    const msg = importErr?.message || '';
    if (!msg.includes('Cannot find module') && !msg.includes('ERR_MODULE_NOT_FOUND')) {
      console.warn(`[CrawlerManager] loadStateData: unexpected error importing state file for ${stateCode}:`, msg);
    }
  }

  if (isStateInRegistry(stateCode)) {
    const generated = generateStatePrograms(stateCode);
    return {
      benefits: generated.benefits.map(b => ({ ...b, stateRestriction: stateCode })),
      countyResources: generated.countyResources || {},
      meta: generated.meta,
    };
  }
  return { benefits: [], countyResources: null, meta: null };
}

// ── Source label map ──

const SOURCE_LABELS = {
  federal: 'Federal Benefits',
  state: 'State Programs',
  national: 'National Programs',
  business: 'Business Programs',
  scholarships: 'Scholarships',
  schoolCards: 'School Cards',
};

// ── Candidate loader: builds program array per strategy ──

function loadCandidates(strategy, stateData, analysis, intents) {
  const sources = new Set(strategy.candidateSources);
  const candidateCounts = {};
  const programs = [];

  if (sources.has('federal')) {
    programs.push(...FEDERAL_BENEFITS);
    candidateCounts.federal = FEDERAL_BENEFITS.length;
  }

  if (sources.has('state')) {
    programs.push(...stateData.benefits);
    candidateCounts.state = stateData.benefits.length;
  }

  if (sources.has('national')) {
    // For health_resources / special_needs, filter national programs to relevant categories
    if (strategy.categoryFilter) {
      const catSet = new Set(strategy.categoryFilter);
      const filtered = NATIONAL_PROGRAMS.filter(p =>
        (p.categories || []).some(c => catSet.has(c))
      );
      programs.push(...filtered);
      candidateCounts.national = filtered.length;
    } else {
      programs.push(...NATIONAL_PROGRAMS);
      candidateCounts.national = NATIONAL_PROGRAMS.length;
    }
  }

  if (sources.has('business')) {
    const hasBizIntent = intents.has('business')
      || analysis.occupation?.has('small_business_owner')
      || analysis.occupation?.has('minority_owned_business')
      || analysis.occupation?.has('women_owned_business')
      || analysis.needs?.has('employment')
      || analysis.applicantType === 'organization';

    if (hasBizIntent) {
      programs.push(...BUSINESS_PROGRAMS);
      candidateCounts.business = BUSINESS_PROGRAMS.length;
    } else {
      candidateCounts.business = 0;
    }
  }

  if (sources.has('scholarships')) {
    if (analysis.applicantType === 'student' || intents.has('education')) {
      programs.push(...SCHOLARSHIPS);
      candidateCounts.scholarships = SCHOLARSHIPS.length;
    } else {
      candidateCounts.scholarships = 0;
    }
  }

  return { programs, candidateCounts };
}

// ── School cards generator ──

function generateSchoolCards(analysis) {
  const schools = analysis.schools || [];
  if (schools.length === 0) return [];
  const cards = [];
  const gender = analysis.demographics?.has?.('female') ? 'female' : (analysis.demographics?.has?.('male') ? 'male' : null);

  for (const school of schools) {
    const prefix = school.name;
    const slug = (school.id || school.name).replace(/\s+/g, '-').toLowerCase();
    const baseScore = 85;
    const hasPortal = !!school.portals?.financialAid;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(school.name + ' financial aid office')}`;
    const finaidUrl = school.portals?.financialAid || school.website || searchUrl;

    cards.push({
      id: `school-finaid-${slug}`,
      name: `${prefix} — Financial Aid`,
      description: `Apply for institutional scholarships, grants, and work-study through ${prefix}'s financial aid portal.${school.fafsaCode ? ` FAFSA Code: ${school.fafsaCode}.` : ''}`,
      url: finaidUrl,
      categories: ['education', 'financial'],
      type: 'school_portal',
      fundingType: 'institutional_aid',
      matchScore: hasPortal ? baseScore + 5 : baseScore - 5,
      matchReasons: [`Target school: ${prefix}`, hasPortal ? 'Financial aid portal linked' : 'Portal URL not yet added'],
      contact: extractPrimaryContact(school.contacts, 'Financial Aid'),
      schoolName: prefix,
    });

    if (school.portals?.admissions) {
      cards.push({
        id: `school-admissions-${slug}`,
        name: `${prefix} — Admissions Portal`,
        description: `Track your application status and communicate with ${prefix}'s admissions office.`,
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

    // Housing / off-campus resources card
    const housingUrl = school.portals?.housing || `https://www.google.com/search?q=${encodeURIComponent(school.name + ' off-campus housing scholarships student housing')}`;
    cards.push({
      id: `school-housing-${slug}`,
      name: `${prefix} — Housing & Off-Campus Resources`,
      description: `Search for housing scholarships, off-campus assistance, and student housing resources at ${prefix}. Many schools offer emergency housing funds and cost-of-attendance adjustments that cover off-campus rent.`,
      url: housingUrl,
      categories: ['education', 'housing', 'scholarship'],
      type: 'school_portal',
      fundingType: 'institutional_aid',
      matchScore: baseScore,
      matchReasons: [`Housing resources for target school: ${prefix}`],
      contact: extractPrimaryContact(school.contacts, 'Housing') || extractPrimaryContact(school.contacts, 'Financial Aid'),
      schoolName: prefix,
    });

    // Scholarship search card specific to this school
    const scholarshipSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(school.name + ' scholarships grants financial aid')}`;
    cards.push({
      id: `school-scholarships-${slug}`,
      name: `${prefix} — Institutional Scholarships & Grants`,
      description: `Search for scholarships, grants, and financial aid specific to ${prefix}. Includes merit aid, need-based grants, departmental awards, and endowed scholarships.`,
      url: school.portals?.scholarships || scholarshipSearchUrl,
      categories: ['education', 'scholarship'],
      type: 'school_portal',
      fundingType: 'institutional_aid',
      matchScore: baseScore + 2,
      matchReasons: [`Institutional scholarships for target school: ${prefix}`],
      contact: extractPrimaryContact(school.contacts, 'Financial Aid'),
      schoolName: prefix,
    });

    if (school.departmentContacts?.length > 0) {
      const relevantDepts = filterDeptContacts(school.departmentContacts, analysis.interests, analysis.sports, gender);
      for (const dept of relevantDepts) {
        const deptSlug = (dept.area || 'dept').replace(/\s+/g, '-').toLowerCase();
        const contactLines = [dept.name, dept.title, dept.email, dept.phone].filter(Boolean).join(' | ');
        cards.push({
          id: `school-dept-${slug}-${deptSlug}`,
          name: `${prefix} — ${dept.area || 'Department Contact'}`,
          description: `Contact for ${dept.area || 'this program'} at ${prefix}. ${contactLines}`,
          url: dept.url || school.website || searchUrl,
          categories: ['education'],
          type: 'school_department',
          fundingType: 'department_contact',
          matchScore: baseScore + 3,
          matchReasons: [`Department contact for interest: ${dept.area}`],
          contact: { name: dept.name, title: dept.title, email: dept.email, phone: dept.phone },
          schoolName: prefix,
        });
      }
    }
  }
  return cards;
}

function extractPrimaryContact(contacts, labelHint) {
  if (!contacts?.length) return null;
  const c = contacts.find(c => c.label?.toLowerCase().includes(labelHint.toLowerCase())) || contacts[0];
  return (c.name || c.email || c.phone) ? { name: c.name, title: c.title, email: c.email, phone: c.phone } : null;
}

function filterDeptContacts(deptContacts, interests, sports, gender) {
  const all = new Set([...(interests || []), ...(sports || [])]);
  if (all.size === 0) return deptContacts;
  const needles = [...all].map(s => String(s).toLowerCase());
  return deptContacts.filter(dept => {
    const hay = [dept.area, dept.category, dept.name, dept.title].filter(Boolean).join(' ').toLowerCase();
    for (const n of needles) {
      if (!hay.includes(n)) continue;
      if (gender && dept.genderTarget && !['any','unknown'].includes(dept.genderTarget)) {
        if (gender === 'female' && dept.genderTarget.toLowerCase() === 'men') continue;
        if (gender === 'male' && dept.genderTarget.toLowerCase() === 'women') continue;
      }
      return true;
    }
    return false;
  });
}

// ── URL policy enforcement ──

function enforceUrlPolicy(results, policy) {
  if (policy === 'relaxed') return { accepted: results, demoted: [] };

  const accepted = [];
  const demoted = [];

  for (const r of results) {
    const url = r.url || r.applicationUrl || '';
    const hasRealUrl = /^https?:\/\/.+/.test(url);
    const isDirectory = r.type === 'portal' || r.type === 'referral' || r.type === 'school_portal';

    if (policy === 'strict' && !hasRealUrl && !isDirectory) {
      demoted.push(r);
    } else {
      r._urlPolicy = {
        urlUsed: url || null,
        isDirectory,
        acceptedReason: hasRealUrl ? 'valid_url' : (isDirectory ? 'directory_fallback' : 'no_url_kept'),
      };
      accepted.push(r);
    }
  }
  return { accepted, demoted };
}

// ── PII redaction for Vercel-safe debug output ──

const PII_KEYS = new Set([
  'name', 'display_name', 'email', 'phone', 'ssn', 'social_security',
  'address', 'street', 'dob', 'date_of_birth', 'birth_date',
  'first_name', 'last_name', 'full_name', 'password', 'token',
]);

function redactPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactPII);
  const safe = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PII_KEYS.has(k.toLowerCase())) {
      safe[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      safe[k] = redactPII(v);
    } else {
      safe[k] = v;
    }
  }
  return safe;
}

/**
 * Run the full crawler pipeline for a profile.
 *
 * @param {Object} db
 * @param {string} profileId
 * @param {Object} options - { minScore, maxResults, forceRefresh, crawlerType }
 * @returns {{ results, analysis, statePortal, countyContacts, debug }}
 */
export async function runCrawler(db, profileId, options = {}) {
  const { minScore, maxResults, forceRefresh = false, crawlerType = 'comprehensive', profileContext: externalContext = null } = options;
  const timing = {};
  const t0 = Date.now();

  await ensureCrawlSchema(db);

  // ── Step 1: Load profile signals ──
  // When a snapshot context is provided (e.g. from a crawler job snapshot), use it directly
  // to prevent cross-profile contamination from live DB re-queries.
  const t1 = Date.now();
  const { signals: analysis, intents, assistancePrograms, rawInputs } = externalContext
    ? buildSignalsFromContext(externalContext)
    : await loadProfileSignals(db, profileId);
  timing.signalLoad_ms = Date.now() - t1;

  // ── Step 2: Resolve strategy ──
  const strategy = getStrategy(crawlerType);
  const effectiveMinScore = minScore ?? strategy.minScore;
  const effectiveMaxResults = maxResults ?? strategy.maxResults;
  const gateResult = checkGates(strategy, intents);

  console.log(`[CrawlerManager] strategy=${strategy.id} profile=${profileId} intents=[${[...intents]}]`);

  if (gateResult.gated) {
    console.log(`[CrawlerManager] Strategy "${strategy.id}" gated: ${gateResult.reason}`);
    return {
      results: [],
      analysis,
      statePortal: null,
      countyContacts: null,
      debug: {
        strategy: strategy.id,
        gated: true,
        gateReason: gateResult.reason,
        intents: [...intents],
        candidateCounts: {},
        timing: { ...timing, total_ms: Date.now() - t0 },
      },
    };
  }

  // ── Step 3: Load candidate programs per strategy ──
  const t3 = Date.now();
  const stateData = await loadStateData(analysis.location?.state);
  const { programs: allPrograms, candidateCounts } = loadCandidates(strategy, stateData, analysis, intents);

  let schoolCards = [];
  if (strategy.candidateSources.includes('schoolCards') && analysis.schools?.length > 0) {
    schoolCards = generateSchoolCards(analysis);
    candidateCounts.schoolCards = schoolCards.length;
  }
  timing.candidateLoad_ms = Date.now() - t3;

  const totalCandidates = allPrograms.length + schoolCards.length;
  console.log(`[CrawlerManager] Candidates: ${JSON.stringify(candidateCounts)} total=${totalCandidates}`);

  // ── Step 4: Match and score ──
  const t4 = Date.now();
  const matchOpts = {
    minScore: effectiveMinScore,
    maxResults: effectiveMaxResults,
    strategyId: strategy.id,
    needEmphasis: strategy.needEmphasis,
    intentBoost: strategy.intentBoost,
    intents,
  };

  const results = matchPrograms(allPrograms, analysis, matchOpts);

  // Extract match engine stats (attached as non-enumerable by matchPrograms)
  const matchStats = results._matchStats || {};

  if (schoolCards.length > 0) {
    for (const card of schoolCards) {
      card.match_explain = {
        crawler_type: crawlerType,
        strategy_id: strategy.id,
        matchedSignals: ['education', 'target_school'],
        matchedNeeds: ['education', 'scholarship'],
        matchedNeedTerms: [card.schoolName],
        scoreBreakdown: { locality: 0, eligibility: 0, specificity: card.matchScore, trust: 10, penalties: 0 },
        urlPolicy: { urlUsed: card.url, isDirectory: true, acceptedReason: 'school_portal' },
      };
    }
    results.push(...schoolCards);
    results.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  }
  timing.matching_ms = Date.now() - t4;

  // ── Step 5: URL policy enforcement ──
  const { accepted, demoted } = enforceUrlPolicy(results, strategy.urlPolicy);

  // ── Step 6: Resolve county contacts ──
  let countyContacts = null;
  if (analysis.location?.county && stateData.countyResources) {
    const countyKey = analysis.location.county.toLowerCase().replace(/\s+county$/i, '').trim();
    countyContacts = stateData.countyResources[countyKey] || null;
  }

  // ── Step 7: Store results ──
  const t7 = Date.now();
  await storeResults(db, profileId, accepted, analysis, stateData.meta, countyContacts);
  timing.storage_ms = Date.now() - t7;
  timing.total_ms = Date.now() - t0;

  // ── Debug summary (PII-safe) ──
  const safeRawInputs = redactPII(rawInputs);

  const debug = {
    strategy: strategy.id,
    gated: false,
    intents: [...intents],
    assistancePrograms,
    candidateCounts,
    totalCandidates,
    matchedCount: accepted.length,
    demotedForUrl: demoted.length,
    schoolCards: schoolCards.length,
    minScore: effectiveMinScore,
    maxResults: effectiveMaxResults,
    matchStats: {
      dupId: matchStats.dupId || 0,
      dupUrl: matchStats.dupUrl || 0,
      dupName: matchStats.dupName || 0,
      informational: matchStats.informational || 0,
      excluded: matchStats.excluded || 0,
      nullScore: matchStats.nullScore || 0,
      belowMin: matchStats.belowMin || 0,
    },
    timing,
    rawInputs: safeRawInputs,
  };

  console.log(
    `[CrawlerManager] Done strategy=${strategy.id} ` +
    `accepted=${accepted.length} demoted=${demoted.length} schoolCards=${schoolCards.length} ` +
    `dedup(id:${matchStats.dupId||0} url:${matchStats.dupUrl||0} name:${matchStats.dupName||0}) ` +
    `filtered(info:${matchStats.informational||0} excl:${matchStats.excluded||0}) ` +
    `scored(null:${matchStats.nullScore||0} low:${matchStats.belowMin||0}) ` +
    `timing=${JSON.stringify(timing)}`
  );

  return {
    results: accepted,
    analysis,
    statePortal: stateData.meta,
    countyContacts,
    debug,
  };
}

// ── Store results ──

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
      try {
        await stmt.run(
          profileId, result.id, result.name,
          result.url || result.applicationUrl || null,
          result.description, result.matchScore,
          JSON.stringify(result.matchReasons),
          JSON.stringify(result.matchedCategories),
          result.type, result.fundingType, result.maxAmount || null,
          result.id?.startsWith('school-') ? 'school' : (result.stateRestriction ? 'state' : (result.id?.startsWith('fed-') ? 'federal' : 'national')),
        );
      } catch (err) {
        console.error(`Failed to store result ${result.id}:`, err.message);
        throw err;
      }
    }

    const analysisJson = JSON.stringify({
      needs: [...(analysis.needs || [])],
      demographics: [...(analysis.demographics || [])],
      health: [...(analysis.health || [])],
      family: [...(analysis.family || [])],
      military: [...(analysis.military || [])],
      county: analysis.location?.county,
      statePortalUrl: stateMeta?.benefitsPortal || null,
      statePortalName: stateMeta?.benefitsPortalName || null,
    });

    if (isPg) {
      await db.prepare(`
        INSERT INTO crawl_metadata (profile_id, state, analysis_json, county_contacts, total_matches, crawled_at)
        VALUES (?, ?, ?, ?, ?, now())
        ON CONFLICT (profile_id) DO UPDATE SET
          state = EXCLUDED.state, analysis_json = EXCLUDED.analysis_json,
          county_contacts = EXCLUDED.county_contacts, total_matches = EXCLUDED.total_matches, crawled_at = now()
      `).run(profileId, analysis.location?.state, analysisJson, countyContacts ? JSON.stringify(countyContacts) : null, results.length);
    } else {
      await db.prepare(`
        INSERT OR REPLACE INTO crawl_metadata (profile_id, state, analysis_json, county_contacts, total_matches, crawled_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(profileId, analysis.location?.state, analysisJson, countyContacts ? JSON.stringify(countyContacts) : null, results.length);
    }

    let fundingUpserted = 0;
    for (const result of results) {
      try {
        const isSchoolCard = result.id?.startsWith('school-');
        const contactObj = result.contact || null;
        const contactInfo = contactObj ? [contactObj.name, contactObj.title, contactObj.email, contactObj.phone].filter(Boolean).join(' | ') : null;

        await upsertFundingOpportunity(db, {
          title: result.name,
          description: result.description,
          sponsor: isSchoolCard ? (result.schoolName || 'University Program') : result.stateRestriction ? `${result.stateRestriction} State Program` : (result.id?.startsWith('fed-') ? 'Federal Program' : 'National Program'),
          source: isSchoolCard ? 'school_portal' : 'curated_benefits',
          source_url: result.url || null,
          url: result.url || null,
          application_url: result.applicationUrl || result.url || null,
          state: result.stateRestriction || 'nationwide',
          is_national: !result.stateRestriction,
          opportunity_type: isSchoolCard ? 'school_resource' : (result.type === 'portal' ? 'directory' : result.type === 'grant' ? 'grant' : 'program'),
          type: (isSchoolCard || result.type === 'portal') ? 'DIRECTORY' : 'OPPORTUNITY',
          deadline_type: 'rolling',
          amount_max: result.maxAmount || null,
          contact_info: contactInfo,
          categories: JSON.stringify(result.categories || []),
          keywords: JSON.stringify(result.matchedCategories || []),
          match_reasons: JSON.stringify(result.matchReasons || []),
          match_score: result.matchScore,
          funding_type: result.fundingType,
          record_origin: 'curated_verified',
          last_verified_at: new Date().toISOString(),
          profile_id: isSchoolCard ? profileId : null,
        });
        fundingUpserted++;
      } catch (e) {
        console.error(`[CrawlerManager] upsert failed for ${result.id}: ${e.message}`);
        // Do not modify fundingUpserted â it counts successes only
      }
    }
    console.log(`[CrawlerManager] Stored ${results.length} crawl_results + ${fundingUpserted} funding_opportunities`);
  } catch (err) {
    console.error('[CrawlerManager] Error storing results:', err.message);
    throw err;
  }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS crawl_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL, program_id TEXT NOT NULL, program_name TEXT NOT NULL,
  program_url TEXT, program_description TEXT, match_score INTEGER NOT NULL,
  match_reasons TEXT, matched_categories TEXT, program_type TEXT, funding_type TEXT,
  max_amount REAL, source_type TEXT, crawled_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(profile_id, program_id)
);
CREATE TABLE IF NOT EXISTS crawl_metadata (
  profile_id TEXT PRIMARY KEY, state TEXT, analysis_json TEXT,
  county_contacts TEXT, total_matches INTEGER, crawled_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_crawl_results_profile ON crawl_results(profile_id);
CREATE INDEX IF NOT EXISTS idx_crawl_results_score ON crawl_results(match_score DESC);
`;

export default { runCrawler, SCHEMA };
