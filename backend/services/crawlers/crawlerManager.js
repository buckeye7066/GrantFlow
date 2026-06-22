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
import { normalizeState, statesMatch } from '../../utils/stateNormalization.js';
import { FEDERAL_BENEFITS } from '../shared/data/federalBenefits.js';
import { NATIONAL_PROGRAMS } from '../shared/data/nationalPrograms.js';
import { BUSINESS_PROGRAMS } from '../shared/data/businessPrograms.js';
import { SCHOLARSHIPS } from '../shared/data/scholarships.js';
import { PRESCRIPTION_ASSISTANCE_PROGRAMS } from '../shared/data/prescriptionAssistance.js';
import { SENIOR_PROGRAMS } from '../shared/data/seniorPrograms.js';
import { PROPERTY_TAX_RELIEF_PROGRAMS } from '../shared/data/propertyTaxRelief.js';
import { UTILITY_ASSISTANCE_PROGRAMS } from '../shared/data/utilityAssistance.js';
import { FAITH_BASED_PROGRAMS } from '../shared/data/faithBasedPrograms.js';
import { FAMILY_PROGRAMS } from '../shared/data/familyPrograms.js';
import { SCHOOL_PROGRAMS } from '../shared/data/schoolPrograms.js';
import { VOLUNTEER_FIRE_PROGRAMS } from '../shared/data/volunteerFirePrograms.js';
import { generateStatePrograms, isStateInRegistry } from '../shared/data/stateBase.js';
import { enrichSchool } from '../shared/data/knownSchools.js';
import { upsertFundingOpportunity } from '../opportunityInserter.js';
import { createLogger } from '../../utils/logger.js'
const log = createLogger('crawlerManager')

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
  faith_based: 'Faith-Based Programs',
  scholarships: 'Scholarships',
  schoolCards: 'School Cards',
  prescription: 'Prescription Assistance',
  senior: 'Senior Programs',
  property_tax: 'Property Tax Relief',
  utility_assistance: 'Utility Assistance Programs',
  family: 'Family Programs',
  school: 'K-12 School Programs',
  volunteer_fire: 'Volunteer Fire Programs',
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

  if (sources.has('faith_based')) {
    programs.push(...FAITH_BASED_PROGRAMS);
    candidateCounts.faith_based = FAITH_BASED_PROGRAMS.length;
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

  if (sources.has('prescription')) {
    programs.push(...PRESCRIPTION_ASSISTANCE_PROGRAMS);
    candidateCounts.prescription = PRESCRIPTION_ASSISTANCE_PROGRAMS.length;
  }

  if (sources.has('senior')) {
    programs.push(...SENIOR_PROGRAMS);
    candidateCounts.senior = SENIOR_PROGRAMS.length;
  }

  if (sources.has('property_tax')) {
    programs.push(...PROPERTY_TAX_RELIEF_PROGRAMS);
    candidateCounts.property_tax = PROPERTY_TAX_RELIEF_PROGRAMS.length;
  }

  if (sources.has('utility_assistance')) {
    // Filter by state restriction when a state is known, or include all if no state available
    // v4: Use statesMatch for robust comparison
    const userState = normalizeState(analysis.location?.state);
    const filtered = userState
      ? UTILITY_ASSISTANCE_PROGRAMS.filter(p => !p.stateRestriction || statesMatch(p.stateRestriction, userState))
      : UTILITY_ASSISTANCE_PROGRAMS;
    programs.push(...filtered);
    candidateCounts.utility_assistance = filtered.length;
  }

  if (sources.has('family')) {
    programs.push(...FAMILY_PROGRAMS);
    candidateCounts.family = FAMILY_PROGRAMS.length;
  }

  if (sources.has('school')) {
    programs.push(...SCHOOL_PROGRAMS);
    candidateCounts.school = SCHOOL_PROGRAMS.length;
  }

  if (sources.has('volunteer_fire')) {
    programs.push(...VOLUNTEER_FIRE_PROGRAMS);
    candidateCounts.volunteer_fire = VOLUNTEER_FIRE_PROGRAMS.length;
  }

  return { programs, candidateCounts };
}

// ── School cards generator ──

// Status values that mean "this is the school the student has chosen to
// attend". Once any school in the profile carries one of these statuses,
// generateSchoolCards narrows its output to JUST that school — the other
// applications stay on the profile for the user's reference but they no
// longer produce school-specific funding cards (no more UCF / Alabama
// scholarship / housing / off-campus cards once the student commits to
// MTSU). User rule: "I also need a way for student profiles to be updated
// once they have chosen a university to where the others fall off".
export const COMMITTED_SCHOOL_STATUSES = Object.freeze(
  new Set(['committed', 'enrolled', 'attending'])
)

export function isCommittedSchool(school) {
  if (!school || typeof school !== 'object') return false
  const status = String(school.status || '').trim().toLowerCase()
  return COMMITTED_SCHOOL_STATUSES.has(status)
}

export function generateSchoolCards(analysis) {
  const allSchools = analysis.schools || [];
  if (allSchools.length === 0) return [];

  // Narrow to committed school(s) when at least one school is marked as
  // "committed" / "enrolled" / "attending". This is the "others fall off"
  // behavior — the user has chosen, so we stop pestering them with
  // institutional cards for the schools they're no longer pursuing.
  const committed = allSchools.filter(isCommittedSchool)
  const schools = committed.length > 0 ? committed : allSchools

  const cards = [];
  const gender = analysis.demographics?.has?.('female') ? 'female' : (analysis.demographics?.has?.('male') ? 'male' : null);

  for (const rawSchool of schools) {
    // Enrich with knownSchools registry — fills in real institutional URLs
    // (financial aid, housing, off-campus, scholarships, admissions) for any
    // school the user typed by name. Falls through unchanged when unknown.
    const school = enrichSchool(rawSchool) || rawSchool;
    const prefix = school.name;
    const slug = (school.id || school.name).replace(/\s+/g, '-').toLowerCase();
    const baseScore = 85;
    const hasPortal = !!school.portals?.financialAid;
    const matchedRegistry = !!school.knownSchoolMatched;
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
      matchReasons: [
        `Target school: ${prefix}`,
        hasPortal ? 'Financial aid portal linked' : 'Portal URL not yet added',
      ],
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

    // On-campus housing & residence life card — links to the school's housing
    // office when known, otherwise a Google search.
    const housingUrl =
      school.portals?.housing
      || `https://www.google.com/search?q=${encodeURIComponent(school.name + ' housing residence life')}`;
    const housingHasReal = !!school.portals?.housing;
    cards.push({
      id: `school-housing-${slug}`,
      name: `${prefix} — Housing & Residence Life`,
      description: `Apply for on-campus housing, learn about residence hall scholarships, and review the cost of attendance for housing at ${prefix}. Many schools offer emergency housing funds and cost-of-attendance adjustments that can be applied toward room and board.`,
      url: housingUrl,
      categories: ['education', 'housing', 'scholarship'],
      type: 'school_portal',
      fundingType: 'institutional_aid',
      matchScore: housingHasReal ? baseScore + 3 : baseScore,
      matchReasons: [
        `Housing resources for target school: ${prefix}`,
        housingHasReal ? 'On-campus housing portal linked' : 'Portal URL not yet added',
      ],
      contact: extractPrimaryContact(school.contacts, 'Housing') || extractPrimaryContact(school.contacts, 'Financial Aid'),
      schoolName: prefix,
    });

    // Off-campus housing card — only emitted as a separate, distinct card
    // when we have a verified off-campus URL for the school. This is the
    // exact card a student looking for "off-campus housing scholarships /
    // grants for MTSU" expects. When unknown, fall back to a generic
    // off-campus search card so the user still gets *something* actionable.
    const offCampusHasReal = !!school.portals?.offCampusHousing;
    const offCampusUrl =
      school.portals?.offCampusHousing
      || `https://www.google.com/search?q=${encodeURIComponent(school.name + ' off-campus housing student rent assistance')}`;
    cards.push({
      id: `school-offcampus-${slug}`,
      name: `${prefix} — Off-Campus Housing & Rent Assistance`,
      description: `Find off-campus apartments, roommate boards, and rent-assistance resources affiliated with ${prefix}. Federal Pell Grants, Federal Work-Study, and TN HOPE refunds can all be applied to off-campus rent and utilities — talk to ${prefix}'s financial aid office about a Cost-of-Attendance (COA) appeal if your actual rent exceeds the standard COA budget.`,
      url: offCampusUrl,
      categories: ['education', 'housing', 'scholarship'],
      type: 'school_portal',
      fundingType: 'institutional_aid',
      matchScore: offCampusHasReal ? baseScore + 4 : baseScore - 2,
      matchReasons: [
        `Off-campus housing resources for target school: ${prefix}`,
        offCampusHasReal
          ? 'Verified off-campus housing portal linked'
          : 'Portal URL not yet added — using public search fallback',
      ],
      contact: extractPrimaryContact(school.contacts, 'Housing') || extractPrimaryContact(school.contacts, 'Financial Aid'),
      schoolName: prefix,
      knownSchoolMatched: matchedRegistry,
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

  log.info(`[CrawlerManager] strategy=${strategy.id} profile=${profileId} intents=[${[...intents]}]`);

  if (gateResult.gated) {
    log.info(`[CrawlerManager] Strategy "${strategy.id}" gated: ${gateResult.reason}`);
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
  log.info(`[CrawlerManager] Candidates: ${JSON.stringify(candidateCounts)} total=${totalCandidates}`);

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
  const stored = await storeResults(db, profileId, accepted, analysis, stateData.meta, countyContacts);
  const insertedCount = Number(stored?.fundingUpserted || 0);
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

  log.info(
    `[CrawlerManager] Done strategy=${strategy.id} ` +
    `accepted=${accepted.length} demoted=${demoted.length} schoolCards=${schoolCards.length} ` +
    `dedup(id:${matchStats.dupId||0} url:${matchStats.dupUrl||0} name:${matchStats.dupName||0}) ` +
    `filtered(info:${matchStats.informational||0} excl:${matchStats.excluded||0}) ` +
    `scored(null:${matchStats.nullScore||0} low:${matchStats.belowMin||0}) ` +
    `timing=${JSON.stringify(timing)}`
  );

  return {
    results: accepted,
    // Real count of rows actually upserted into funding_opportunities this run.
    // Distinct from results.length (matched/accepted) — many accepted records
    // are dropped at the import gate (dup/below-floor/reality-gate), so this is
    // the number that answers "did the crawl actually add anything?".
    inserted: insertedCount,
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

  // Atomic replace of the profile's crawl_results + crawl_metadata. Previously
  // the DELETE auto-committed before the INSERT loop, so a mid-loop failure (or
  // crash) left the profile with WIPED or partial results. Wrapping DELETE +
  // INSERTs + metadata in one transaction means a failure rolls the DELETE back
  // too — the profile keeps its previous results until a full new batch commits.
  // withTransaction is the canonical helper (works on both SQLite + Postgres);
  // fall back to sequential when a raw db without it is passed (e.g. some tests).
  const runAtomic = typeof db?.withTransaction === 'function'
    ? (fn) => db.withTransaction(fn)
    : (fn) => fn(db);

  try {
    await runAtomic(async (tx) => {
      await tx.prepare('DELETE FROM crawl_results WHERE profile_id = ?').run(profileId);

      const stmt = tx.prepare(`
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
          throw err; // abort the transaction → DELETE rolls back, results preserved
        }
      }

      if (isPg) {
        await tx.prepare(`
          INSERT INTO crawl_metadata (profile_id, state, analysis_json, county_contacts, total_matches, crawled_at)
          VALUES (?, ?, ?, ?, ?, now())
          ON CONFLICT (profile_id) DO UPDATE SET
            state = EXCLUDED.state, analysis_json = EXCLUDED.analysis_json,
            county_contacts = EXCLUDED.county_contacts, total_matches = EXCLUDED.total_matches, crawled_at = now()
        `).run(profileId, analysis.location?.state, analysisJson, countyContacts ? JSON.stringify(countyContacts) : null, results.length);
      } else {
        await tx.prepare(`
          INSERT OR REPLACE INTO crawl_metadata (profile_id, state, analysis_json, county_contacts, total_matches, crawled_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(profileId, analysis.location?.state, analysisJson, countyContacts ? JSON.stringify(countyContacts) : null, results.length);
      }
    });

    // Funding-catalog enrichment runs AFTER the atomic crawl_results commit, on
    // the auto-commit connection: each upsert is independent + best-effort, so a
    // single bad row never wipes the profile's freshly-stored results, and the
    // many async verification calls inside upsertFundingOpportunity don't hold
    // the crawl_results transaction open.
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
          // Discovered now; the recurring linkVerificationService owns the
          // honest `last_verified_at`. Curated rows may be re-confirmed by the
          // verifier (or by URL_VERIFICATION_ENABLED at bulk insert time) and
          // their last_verified_at will be set then — not here.
          discovered_at: new Date().toISOString(),
          profile_id: isSchoolCard ? profileId : null,
        });
        fundingUpserted++;
      } catch (e) {
        console.error(`[CrawlerManager] upsert failed for ${result.id}: ${e.message}`);
        // Do not modify fundingUpserted â it counts successes only
      }
    }
    log.info(`[CrawlerManager] Stored ${results.length} crawl_results + ${fundingUpserted} funding_opportunities`);
    return { fundingUpserted };
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
