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

  console.log(\`[\${crawlerName}:\${requestId}] Starting crawl for profile \${profileId}\`);

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