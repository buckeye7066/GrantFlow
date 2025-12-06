/**
 * Optimized Profile Helpers
 * Single-pass extraction functions to reduce computational overhead
 * (Hardened for safety and backend variability)
 */

/** Title-case a label (very lightweight) */
function toTitleCase(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .split(/\s+/g)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Accept true | "true" | 1 | "1" as true; tolerate backend variability */
function isTrue(v) {
  if (v === true) return true;
  if (typeof v === 'string') return v.toLowerCase().trim() === 'true';
  if (typeof v === 'number') return v === 1;
  return false;
}

/** Safe object keys */
function safeKeys(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj) : [];
}

/** Safe array test */
function hasArrayValues(arr) {
  return Array.isArray(arr) && arr.length > 0;
}

/**
 * Extract all religious affiliations in a single pass
 * @param {Object} profile - Organization object
 * @returns {string[]} Array of affiliation keys (humanized)
 */
export function extractReligiousAffiliations(profile) {
  if (!profile || typeof profile !== 'object') return [];
  const out = new Set();

  // Scan keys safely; accept true-like values
  for (const key of safeKeys(profile)) {
    if (key.startsWith('religious_affiliation_') && isTrue(profile[key])) {
      const label = key.slice('religious_affiliation_'.length).replace(/_/g, ' ');
      out.add(toTitleCase(label));
    }
  }

  // Legacy/singular field support
  if (profile.religious_affiliation) {
    out.add(toTitleCase(String(profile.religious_affiliation)));
  }

  return Array.from(out);
}

/**
 * Extract cultural heritage in a single pass
 * @param {Object} profile - Organization object
 * @returns {string[]} Array of heritage types (humanized)
 */
export function extractCulturalHeritage(profile) {
  if (!profile || typeof profile !== 'object') return [];
  const heritage = new Set();

  // Heritage booleans (single pass)
  const heritageMap = {
    jewish_heritage: 'jewish',
    irish_heritage: 'irish',
    italian_heritage: 'italian',
    polish_heritage: 'polish',
    greek_heritage: 'greek',
    armenian_heritage: 'armenian',
    cajun_creole_heritage: 'cajun creole',
    pacific_islander: 'pacific islander',
    middle_eastern: 'middle eastern',
    white_caucasian: 'white caucasian',
    multiracial: 'multiracial',
    african_american: 'african american',
    hispanic_latino: 'hispanic latino',
    asian_american: 'asian american',
    native_american: 'native american',
  };

  for (const field of Object.keys(heritageMap)) {
    if (isTrue(profile[field])) heritage.add(toTitleCase(heritageMap[field]));
  }

  // Add array fields, if present
  if (hasArrayValues(profile.cultural_heritage)) {
    for (const h of profile.cultural_heritage) {
      if (h) heritage.add(toTitleCase(String(h)));
    }
  }
  if (hasArrayValues(profile.race_ethnicity)) {
    for (const r of profile.race_ethnicity) {
      if (r) heritage.add(toTitleCase(String(r)));
    }
  }

  return Array.from(heritage);
}

/**
 * Extract special circumstances in a single pass
 * @param {Object} profile - Organization object
 * @returns {string[]} Array of circumstances (humanized)
 */
export function extractSpecialCircumstances(profile) {
  if (!profile || typeof profile !== 'object') return [];
  const out = new Set();

  const circumstanceMap = {
    foster_youth: 'foster youth',
    homeless: 'homeless/housing insecure',
    first_generation: 'first-generation college student',
    low_income: 'low-income',
    single_parent: 'single parent',
    caregiver: 'caregiver',
    veteran: 'veteran/military',
    disabled_veteran: 'disabled veteran',
    military_spouse: 'military spouse',
    rare_disease: 'rare disease',
    dental_need: 'dental care need',
    behavioral_health_smi: 'mental health',
    lgbtq: 'LGBTQ+',
    lgbtq_plus: 'LGBTQ+',
    new_immigrant: 'immigrant/refugee',
    refugee: 'immigrant/refugee',
    african_american: 'African American',
    hispanic_latino: 'Hispanic/Latino',
    native_american: 'Native American',
    asian_american: 'Asian American',
    cancer_survivor: 'cancer survivor',
    chronic_illness: 'medical challenges',
  };

  for (const field of Object.keys(circumstanceMap)) {
    if (isTrue(profile[field])) out.add(circumstanceMap[field]);
  }

  // Disabilities only if arrays have values
  const hasDisabilities =
    hasArrayValues(profile.disabilities) || hasArrayValues(profile.disability_type);
  if (hasDisabilities) out.add('disabilities');

  return Array.from(out);
}

/**
 * Derive ZIP codes from college names - optimized
 * @param {string[]} colleges - Array of college names
 * @param {Object} lookup - ZIP lookup map (keys must be normalized toLowerCase)
 * @returns {string[]} Array of ZIP codes
 */
export function deriveZipsFromColleges(colleges, lookup) {
  if (!Array.isArray(colleges) || colleges.length === 0 || !lookup) return [];
  const zips = new Set();

  // Precompute normalized lookup keys once
  const normEntries = Object.entries(lookup).map(([k, v]) => [k.toLowerCase().trim(), v]);

  for (const college of colleges) {
    if (!college || typeof college !== 'string') continue;

    const normalized = college.toLowerCase().trim();
    if (!normalized) continue;

    // Exact match first
    const exact = normEntries.find(([k]) => k === normalized);
    if (exact) {
      zips.add(exact[1]);
      continue;
    }

    // Bounded partial match (require length >= 4 to reduce noise)
    if (normalized.length >= 4) {
      const partial = normEntries.find(([k]) => k.includes(normalized) || normalized.includes(k));
      if (partial) zips.add(partial[1]);
    }
  }

  return Array.from(zips);
}

/**
 * Build compact profile summary for AI prompts
 * Reduces token usage while maintaining matching power
 * @param {Object} profile - Organization object
 * @returns {string} Compact text summary
 */
export function buildCompactProfileSummary(profile) {
  if (!profile || typeof profile !== 'object') return 'Name: Unknown\nType: individual';
  const parts = [];

  // Core identity
  const name = (profile.name || 'Unknown').toString().trim();
  const type = (profile.applicant_type || 'individual').toString().trim();
  parts.push(`Name: ${name}`);
  parts.push(`Type: ${type}`);

  // Location (single line)
  const city = profile.city?.toString().trim();
  const state = profile.state?.toString().trim();
  const zip = profile.zip?.toString().trim();
  if (city && state) {
    parts.push(`Location: ${city}, ${state}${zip ? ` ${zip}` : ''}`);
  } else if (zip) {
    parts.push(`ZIP: ${zip}`);
  }

  // Education (compact)
  if (profile.intended_major) parts.push(`Major: ${String(profile.intended_major)}`);
  if (profile.gpa) parts.push(`GPA: ${String(profile.gpa)}`);
  if (profile.current_college) parts.push(`College: ${String(profile.current_college)}`);

  // Keywords (single line)
  if (hasArrayValues(profile.keywords)) parts.push(`Keywords: ${profile.keywords.join(', ')}`);
  if (hasArrayValues(profile.focus_areas)) parts.push(`Focus: ${profile.focus_areas.join(', ')}`);

  // Special circumstances (compact boolean list)
  const flags = [];
  if (isTrue(profile.veteran)) flags.push('veteran');
  if (isTrue(profile.disabled_veteran)) flags.push('disabled-vet');
  if (isTrue(profile.low_income)) flags.push('low-income');
  if (isTrue(profile.first_generation)) flags.push('first-gen');
  if (isTrue(profile.foster_youth)) flags.push('foster');
  if (isTrue(profile.homeless)) flags.push('homeless');
  if (isTrue(profile.cancer_survivor)) flags.push('cancer');
  if (isTrue(profile.rare_disease)) flags.push('rare-disease');
  if (isTrue(profile.behavioral_health_smi)) flags.push('SMI');
  if (isTrue(profile.dental_need)) flags.push('dental');
  if (isTrue(profile.lgbtq) || isTrue(profile.lgbtq_plus)) flags.push('LGBTQ+');
  if (isTrue(profile.gun_owner)) flags.push('gun-owner');
  if (isTrue(profile.hunter)) flags.push('hunter');
  if (isTrue(profile.nra_member)) flags.push('NRA');
  if (isTrue(profile.elected_official)) flags.push('elected-official');
  if (isTrue(profile.political_candidate)) flags.push('candidate');
  if (isTrue(profile.eviction_risk)) flags.push('eviction-risk');
  if (isTrue(profile.disaster_survivor)) flags.push('disaster-survivor');
  if (flags.length) parts.push(`Flags: ${flags.join(', ')}`);

  // Religious (compact)
  const religious = extractReligiousAffiliations(profile);
  if (religious.length) parts.push(`Religious: ${religious.slice(0, 3).join(', ')}`);

  // Heritage (compact)
  const heritage = extractCulturalHeritage(profile);
  if (heritage.length) parts.push(`Heritage: ${heritage.slice(0, 3).join(', ')}`);

  return parts.join('\n');
}