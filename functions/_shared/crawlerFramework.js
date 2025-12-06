/**
 * UNIVERSAL CRAWLER FRAMEWORK
 */

import { logPHIAccess } from './phiAuditLogger.js';
import { randomUUID } from 'node:crypto';

export const PROFILE_SECTIONS = [
  'identity',
  'education', 
  'military',
  'health',
  'financials',
  'interests',
  'household',
  'goals'
];

export const SECTION_FIELDS = {
  identity: ['name', 'age', 'date_of_birth', 'race_ethnicity', 'gender', 'immigration_status'],
  education: ['gpa', 'intended_major', 'current_college', 'target_colleges', 'first_generation', 'grade_levels'],
  military: ['veteran', 'active_duty_military', 'military_spouse', 'military_branch'],
  health: ['health_conditions', 'disabilities', 'icd10_codes', 'primary_diagnosis'],
  financials: ['household_income', 'low_income', 'government_assistance', 'financial_challenges'],
  interests: ['focus_areas', 'program_areas', 'keywords'],
  household: ['household_size', 'single_parent', 'caregiver'],
  goals: ['primary_goal', 'goals', 'funding_need']
};

export function filterRepaymentOpportunities(opportunities) {
  const keywords = [
    'loan','repay','repayment','interest rate','monthly payment',
    'credit score','borrower','lender','debt','financing'
  ];

  return opportunities.filter(opp => {
    const t = \`\${opp.title||''} \${opp.descriptionMd||''} \${opp.sponsor||''}\`.toLowerCase();
    for (const kw of keywords) {
      if (t.includes(kw)) {
        if (t.includes('forgiveness') || t.includes('repayment assistance')) return true;
        return false;
      }
    }
    return true;
  });
}

export function isOpportunityActive(opportunity) {
  if (!opportunity.deadlineAt) return true;
  try {
    return new Date(opportunity.deadlineAt) >= new Date();
  } catch {
    return true;
  }
}

export function extractSectionData(profile, section) {
  const fields = SECTION_FIELDS[section] || [];
  const out = {};
  for (const f of fields) {
    if (profile[f] !== undefined && profile[f] !== null && profile[f] !== '') {
      out[f] = profile[f];
    }
  }
  return out;
}

// Return a flat list of all keys present in the profile
export function getProfileKeys(profile) {
  if (!profile || typeof profile !== 'object') return [];
  const keys = new Set();
  function walk(obj, prefix = '') {
    Object.keys(obj || {}).forEach(k => {
      const v = obj[k];
      const name = prefix ? `${prefix}.${k}` : k;
      keys.add(name);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, name);
      }
    });
  }
  walk(profile);
  return Array.from(keys);
}

export async function auditUnmappedProfileKeys(sdk, { profile, profileId, crawlerName, requestId, sampleLimit = 10 }) {
  try {
    const allMappedKeys = new Set();
    for (const section of Object.keys(SECTION_FIELDS)) {
      for (const k of (SECTION_FIELDS[section] || [])) allMappedKeys.add(k);
    }
    const profileKeys = getProfileKeys(profile);
    const unmapped = profileKeys.filter(k => ![...allMappedKeys].some(mk => k === mk || k.startsWith(mk + '.') || mk.startsWith(k + '.')));
    if (unmapped.length === 0) return { unmappedCount: 0, unmapped: [] };

    // Log a short summary to CrawlLog
    await sdk.entities.CrawlLog.create({
      source: crawlerName,
      status: 'audit',
      results_count: 0,
      profile_id: profileId,
      data: { unmapped_count: unmapped.length, sample: unmapped.slice(0, sampleLimit) }
    });
    console.log(`[${crawlerName}:${requestId}] Found ${unmapped.length} unmapped profile keys, sample: ${unmapped.slice(0, sampleLimit).join(', ')}`);
    return { unmappedCount: unmapped.length, unmappedSample: unmapped.slice(0, sampleLimit) };
  } catch (err) {
    console.warn(`[${crawlerName}:audit] Audit failed: ${err?.message || err}`);
    return { unmappedCount: 0, unmapped: [] };
  }
}

export function extractAllProfileData(profile) {
  const out = {};
  for (const section of PROFILE_SECTIONS) {
    out[section] = extractSectionData(profile, section);
  }
  // include other top-level profile fields not part of sections
  const profileKeys = getProfileKeys(profile);
  for (const k of profileKeys) {
    if (!Object.values(SECTION_FIELDS).flat().includes(k.split('.')[0])) {
      out[k] = profile[k];
    }
  }
  return out;
}

export async function safeCrawlerWrapper(sdk, {
  crawlerName,
  profile,
  profileId,
  organizationId,
  crawlFn,
  user,
  options = {}
}) {
  const requestId = randomUUID().slice(0, 8);
  const start = Date.now();

    console.log(`[${crawlerName}:${requestId}] Starting crawl for profile ${profileId}`);
    // Audit unmapped profile keys to surface fields that are not yet included in SECTION_FIELDS
    try {
      if (sdk && typeof auditUnmappedProfileKeys === 'function') {
        await auditUnmappedProfileKeys(sdk, { profile, profileId, crawlerName, requestId });
      }
    } catch (auditErr) {
      console.warn(`[${crawlerName}:${requestId}] profile audit failed: ${auditErr?.message || auditErr}`);
    }

  await logPHIAccess(sdk, {
    user,
    action: 'crawl_for_profile',
    entity: 'Organization',
    entity_id: organizationId,
    function_name: crawlerName
  });

  try {
    const raw = await crawlFn(profile, options);

    if (!raw || !Array.isArray(raw)) {
      return {
        opportunities: [],
        stats: { total: 0, filtered: 0, duration: Date.now() - start }
      };
    }

    let filtered = raw;

    if (!options.includeLoans)
      filtered = filterRepaymentOpportunities(filtered);

    if (!options.includeExpired)
      filtered = filtered.filter(isOpportunityActive);

    const seen = new Set();
    filtered = filtered.filter(opp => {
      const key = opp.source_id || opp.url || opp.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const tagged = filtered.map(opp => ({
      ...opp,
      profile_id: profileId,
      organization_id: organizationId,
      crawled_by: crawlerName,
      crawled_at: new Date().toISOString()
    }));

    try {
      await sdk.entities.CrawlLog.create({
        source: crawlerName,
        status: 'success',
        results_count: tagged.length,
        profile_id: profileId,
        duration_ms: Date.now() - start
      });
    } catch (logErr) {
      console.warn(\`[\${crawlerName}] CrawlLog write failed:\`, logErr?.message);
    }

    return {
      opportunities: tagged,
      stats: {
        total: raw.length,
        filtered: tagged.length,
        duration: Date.now() - start
      }
    };

  } catch (error) {
    try {
      await sdk.entities.CrawlLog.create({
        source: crawlerName,
        status: 'error',
        error_message: String(error?.message || error),
        profile_id: profileId,
        duration_ms: Date.now() - start
      });
    } catch (logErr) {
      console.warn(\`[\${crawlerName}] CrawlLog error write failed:\`, logErr?.message);
    }

    throw error;
  }
}

export function crawlerSuccess(data, message = "Success") {
  return { ok: true, message, data };
}

export function crawlerError(message, details = null) {
  return { ok: false, error: message, details };
}

export function isGeographicallyRelevant(opportunity, profile) {
  if (opportunity.is_national) return true;
  const oppState = opportunity.state?.toLowerCase();
  const profState = profile.state?.toLowerCase();
  if (!oppState || !profState) return true;
  if (oppState === profState) return true;
  if (Array.isArray(opportunity.regions)) {
    const r = opportunity.regions.map(x => x.toLowerCase());
    if (r.includes(profState)) return true;
    if (r.includes('national') || r.includes('all states')) return true;
  }
  return false;
}

export function isStudentEligible(opportunity, profile) {
  const studentTypes = ['high_school_student', 'college_student', 'graduate_student'];
  const isStudent = studentTypes.includes(profile.applicant_type);

  const t = \`\${opportunity.title||''} \${opportunity.descriptionMd||''}\`.toLowerCase();
  const kws = ['student','scholarship','undergraduate','graduate','college','university'];
  const studentOpp = kws.some(k => t.includes(k));

  if (studentOpp && !isStudent) return false;
  return true;
}

export function isECFEligible(opportunity, profile) {
  const kws = ['exceptional','children','ecf','disability','special needs'];
  const t = \`\${opportunity.title||''} \${opportunity.descriptionMd||''}\`.toLowerCase();
  const isECF = kws.some(k => t.includes(k));

  if (isECF) {
    const hasDisability =
      (profile.disabilities?.length > 0) ||
      (profile.health_conditions?.length > 0) ||
      (profile.icd10_codes?.length > 0);
    return hasDisability;
  }
  return true;
}

export const STATE_ABBREVIATIONS = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
  'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
  'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
  'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', 'tennessee': 'TN',
  'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
  'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY'
};

export function getStateAbbreviation(stateName) {
  if (!stateName) return null;
  const n = stateName.toLowerCase().trim();
  return STATE_ABBREVIATIONS[n] || stateName.toUpperCase();
}

/**
 * Generate dynamic search queries from user profile data
 * This function analyzes profile fields and creates targeted search queries
 * that can be used to discover relevant funding sources
 * 
 * @param {Object} profile - User profile object
 * @param {Object} options - Search query options
 * @param {number} [options.maxQueries=5] - Maximum number of queries to generate
 * @param {string[]} [options.focusSections] - Specific sections to focus on
 * @returns {string[]} Array of search query strings
 */
export function generateSearchQueries(profile, options = {}) {
  const { maxQueries = 5, focusSections = [] } = options;
  const queries = [];
  
  if (!profile || typeof profile !== 'object') {
    return queries;
  }

  // Extract key profile data
  const state = profile.state || profile.location?.state;
  const focusAreas = profile.focus_areas || profile.program_areas || [];
  const interests = profile.interests || profile.keywords || [];
  const applicantType = profile.applicant_type;
  const intendedMajor = profile.intended_major;
  const disabilities = profile.disabilities || profile.health_conditions || [];
  const veteranStatus = profile.veteran || profile.active_duty_military;
  const lowIncome = profile.low_income || profile.government_assistance;
  const firstGeneration = profile.first_generation;

  // Generate queries based on applicant type
  if (applicantType) {
    if (applicantType.includes('student')) {
      queries.push(`${applicantType} scholarships grants`);
      if (intendedMajor) {
        queries.push(`${intendedMajor} scholarships for ${applicantType}`);
      }
      if (firstGeneration) {
        queries.push(`first generation college student grants`);
      }
    }
  }

  // Generate state-specific queries
  if (state) {
    queries.push(`${state} state grants funding opportunities`);
    if (focusAreas.length > 0) {
      queries.push(`${state} ${focusAreas[0]} funding grants`);
    }
  }

  // Generate focus area queries
  for (const area of focusAreas.slice(0, 2)) {
    queries.push(`${area} grants funding opportunities`);
  }

  // Generate interest-based queries
  for (const interest of interests.slice(0, 2)) {
    if (interest && interest.length > 3) {
      queries.push(`${interest} scholarships grants`);
    }
  }

  // Generate disability-related queries
  if (disabilities && disabilities.length > 0) {
    queries.push(`disability grants assistance exceptional children`);
  }

  // Generate veteran-related queries
  if (veteranStatus) {
    queries.push(`veteran grants benefits military funding`);
  }

  // Generate low-income related queries
  if (lowIncome) {
    queries.push(`low income assistance grants financial aid`);
  }

  // Deduplicate and limit queries
  const uniqueQueries = [...new Set(queries)];
  return uniqueQueries.slice(0, maxQueries);
}

/**
 * Perform profile-based search using LLM and web context
 * This function uses the SDK's LLM integration to search for funding sources
 * that match the user's profile
 * 
 * @param {Object} sdk - Base44 SDK instance
 * @param {Object} profile - User profile object
 * @param {Object} options - Search options
 * @param {string} [options.searchQuery] - Specific search query to use
 * @param {string} [options.sourceType] - Type of sources to search for
 * @param {number} [options.maxResults=10] - Maximum results to return
 * @returns {Promise<Array>} Array of discovered funding sources
 */
export async function performProfileBasedSearch(sdk, profile, options = {}) {
  const { searchQuery, sourceType = 'funding', maxResults = 10 } = options;
  
  if (!sdk || !profile) {
    throw new Error('SDK and profile are required');
  }

  try {
    // Generate search query if not provided
    const query = searchQuery || generateSearchQueries(profile, { maxQueries: 1 })[0];
    
    if (!query) {
      return [];
    }

    // Build LLM prompt
    const prompt = `Search for ${maxResults} ${sourceType} sources or directories related to: "${query}". 
    
Profile context:
- State: ${profile.state || 'N/A'}
- Type: ${profile.applicant_type || 'N/A'}
- Focus areas: ${(profile.focus_areas || []).join(', ') || 'N/A'}
- Interests: ${(profile.keywords || profile.interests || []).join(', ') || 'N/A'}

For each source found, extract:
- url: Full URL to the source
- title: Name of the source/directory
- description: Brief description of what this source provides
- categories: Array of relevant categories
- source_type: Type (e.g., 'government', 'foundation', 'directory', 'university')

Return actual, real websites and directories that exist. Focus on official government sites, foundations, and established funding directories.`;

    const llmResponse = await sdk.integrations.Core.InvokeLLM({
      prompt,
      add_context_from_internet: true,
      response_json_schema: {
        type: "object",
        properties: {
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                categories: { type: "array", items: { type: "string" } },
                source_type: { type: "string" }
              },
              required: ["url", "title"]
            }
          }
        }
      }
    });

    return llmResponse?.sources || [];
  } catch (error) {
    console.error('[performProfileBasedSearch] Search failed:', error?.message || error);
    return [];
  }
}

/**
 * Discover and save funding sources based on user profile
 * This is a high-level utility that combines search and save operations
 * 
 * @param {Object} sdk - Base44 SDK instance
 * @param {Object} profile - User profile object
 * @param {string} profileId - Profile ID
 * @param {string} organizationId - Organization ID
 * @param {string} crawlerName - Name of the crawler discovering sources
 * @param {Object} options - Discovery options
 * @returns {Promise<Object>} Discovery results with saved sources
 */
export async function discoverAndSaveSources(sdk, { profile, profileId, organizationId, crawlerName, options = {} }) {
  const { saveFundingSource } = await import('./saveFundingSource.js');
  
  try {
    // Generate multiple search queries
    const queries = generateSearchQueries(profile, { maxQueries: options.maxQueries || 3 });
    
    const allSources = [];
    const savedSources = [];
    const errors = [];

    // Perform searches for each query
    for (const query of queries) {
      try {
        const sources = await performProfileBasedSearch(sdk, profile, {
          searchQuery: query,
          maxResults: options.maxResultsPerQuery || 5
        });
        allSources.push(...sources);
      } catch (searchError) {
        console.warn(`[discoverAndSaveSources] Search failed for query "${query}":`, searchError?.message);
      }
    }

    // Save discovered sources
    for (const source of allSources) {
      try {
        const saved = await saveFundingSource(sdk, {
          ...source,
          discovered_by: crawlerName,
          organization_id: organizationId,
          profile_id: profileId
        });
        savedSources.push(saved);
      } catch (saveError) {
        errors.push({
          source,
          error: saveError?.message || String(saveError)
        });
      }
    }

    console.log(`[discoverAndSaveSources] Discovered ${allSources.length} sources, saved ${savedSources.length}, ${errors.length} errors`);

    return {
      discovered: allSources.length,
      saved: savedSources.length,
      sources: savedSources,
      errors
    };
  } catch (error) {
    console.error('[discoverAndSaveSources] Discovery failed:', error?.message || error);
    throw error;
  }
}