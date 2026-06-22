// crawler-os/profileIntelligence.js
//
// Profile -> funding thesis. Uses the FULL profile (top-level fields, sections,
// linked org, location, needs, documents, school data) — not just a field or two
// — to derive what to search for and how to score. Supports every GrantFlow
// profile type: individuals, families, students, businesses, churches,
// ministries, nonprofits, schools, volunteer fire departments, government/
// community entities, and more.
//
// Pure, no I/O. Output is a plain mutable object (the pipeline attaches env).

const APPLICANT_TYPE_SYNONYMS = {
  individual: ['individual', 'person', 'resident'],
  family: ['family', 'household', 'parent', 'parents', 'caregiver'],
  student: ['student', 'scholar', 'undergraduate', 'graduate', 'pupil'],
  nonprofit: ['nonprofit', 'non-profit', '501c3', '501(c)(3)', 'charity', 'ngo'],
  church: ['church', 'congregation', 'parish'],
  ministry: ['ministry', 'faith-based', 'religious'],
  school: ['school', 'district', 'k-12', 'education', 'university', 'college'],
  vfd: ['volunteer fire', 'fire department', 'vfd', 'first responder', 'ems'],
  business: ['business', 'company', 'llc', 'startup', 'small business', 'employer'],
  farm: ['farm', 'farmer', 'agriculture', 'rural', 'ranch'],
  government: ['government', 'municipal', 'city', 'county', 'community', 'tribal'],
  veteran: ['veteran', 'military', 'service member'],
};

const NEED_KEYWORDS = {
  housing: ['housing', 'rent', 'mortgage', 'homeless', 'shelter', 'utilities'],
  food: ['food', 'nutrition', 'meals', 'snap', 'pantry'],
  medical: ['medical', 'health', 'disability', 'treatment', 'prescription', 'mental health'],
  education: ['education', 'tuition', 'scholarship', 'school', 'books', 'training'],
  emergency: ['emergency', 'disaster', 'fire', 'flood', 'crisis', 'relief'],
  equipment: ['equipment', 'apparatus', 'gear', 'vehicle', 'truck', 'tools'],
  operations: ['operations', 'operating', 'general support', 'capacity', 'payroll'],
  capital: ['capital', 'building', 'construction', 'renovation', 'facility'],
  programs: ['program', 'programming', 'services', 'outreach', 'project'],
  technology: ['technology', 'computers', 'software', 'internet', 'broadband'],
  veterans: ['veteran', 'military', 'va benefits'],
  energy: ['energy', 'heating', 'liheap', 'weatherization', 'solar'],
};

function lc(x) { return String(x ?? '').toLowerCase(); }

function gatherText(profile) {
  const parts = [];
  const push = (v) => { if (v != null) parts.push(typeof v === 'string' ? v : JSON.stringify(v)); };
  push(profile?.type); push(profile?.profile_type); push(profile?.name);
  push(profile?.description); push(profile?.summary); push(profile?.mission);
  push(profile?.needs); push(profile?.need_categories); push(profile?.tags);
  for (const s of profile?.sections ?? []) { push(s?.title); push(s?.body); push(s?.value); }
  for (const o of profile?.organizations ?? []) { push(o?.name); push(o?.type); push(o?.mission); }
  for (const d of profile?.documents ?? []) { push(d?.name); push(d?.extracted_text); push(d?.summary); }
  if (profile?.school) { push(profile.school.name); push(profile.school.type); }
  return parts.join(' \n ').toLowerCase();
}

// Applicant types that describe an ORGANIZATION (vs. a person/household).
const ORG_APPLICANT_TYPES = new Set(['nonprofit', 'church', 'ministry', 'school', 'vfd', 'business', 'farm', 'government']);
const INDIVIDUAL_APPLICANT_TYPES = new Set(['individual', 'family', 'student', 'veteran']);

function deriveApplicantTypes(profile, blob) {
  const explicit = []
    .concat(profile?.applicant_types ?? [])
    .concat(profile?.type ?? [])
    .concat(profile?.profile_type ?? [])
    .map(lc)
    .filter(Boolean);
  const found = new Set(explicit);
  for (const [canon, syns] of Object.entries(APPLICANT_TYPE_SYNONYMS)) {
    if (syns.some((s) => blob.includes(s))) found.add(canon);
  }
  // Map common explicit strings onto canonical buckets.
  for (const e of explicit) {
    for (const [canon, syns] of Object.entries(APPLICANT_TYPE_SYNONYMS)) {
      if (syns.some((s) => e.includes(s))) found.add(canon);
    }
  }

  // Identity guard: applicant TYPE (who you are) is not a NEED (what you need).
  // A profile whose PRIMARY type is a person/household (individual / family /
  // student / veteran — including compounds like "high_school_student") must NOT
  // acquire organizational applicant types from free-text noise — otherwise the
  // words "community" or "education" make a high-school student look like a
  // "government" or "school" applicant and pull in org/agency grants they can
  // never apply for. An individual is not an organization, period. Individual
  // primary identity takes precedence: note "high_school_student" CONTAINS the
  // substring "school", so a naive org-substring check would misfire — we detect
  // the person tokens with word boundaries (+ a "student" catch-all) instead.
  const primaryRaw = lc(profile?.profile_type ?? profile?.type ?? '');
  const primaryIsIndividual =
    INDIVIDUAL_APPLICANT_TYPES.has(primaryRaw) ||
    primaryRaw.includes('student') ||
    /\b(individual|person|resident|family|household|parent|parents|caregiver|scholar|undergraduate|graduate|pupil|veteran)\b/.test(primaryRaw);
  if (primaryIsIndividual) {
    for (const t of [...found]) if (ORG_APPLICANT_TYPES.has(t)) found.delete(t);
  }

  if (found.size === 0) found.add('individual'); // safe default; never zero
  return [...found];
}

function deriveNeeds(profile, blob) {
  const explicit = []
    .concat(profile?.needs ?? [])
    .concat(profile?.need_categories ?? [])
    .map(lc)
    .filter(Boolean);
  const found = new Set();
  for (const e of explicit) {
    // accept canonical need names directly
    if (NEED_KEYWORDS[e]) found.add(e);
    for (const [canon, kws] of Object.entries(NEED_KEYWORDS)) {
      if (kws.some((k) => e.includes(k))) found.add(canon);
    }
  }
  for (const [canon, kws] of Object.entries(NEED_KEYWORDS)) {
    if (kws.some((k) => blob.includes(k))) found.add(canon);
  }
  return [...found];
}

function normalizeState(state) {
  if (!state) return null;
  const s = String(state).trim();
  // 2-letter codes are uppercased; full names pass through unchanged.
  return s.length === 2 ? s.toUpperCase() : s;
}

function deriveLocation(profile) {
  const loc = profile?.location ?? profile?.address ?? {};
  return {
    state: normalizeState(loc.state ?? loc.region ?? profile?.state ?? null),
    county: loc.county ?? profile?.county ?? null,
    zip: loc.zip ?? loc.postal_code ?? profile?.zip ?? null,
    city: loc.city ?? profile?.city ?? null,
  };
}

/**
 * buildThesis — derive the funding thesis from a profile.
 *
 * @param {object} profile
 * @returns {object} thesis
 */
export function buildThesis(profile = {}) {
  const blob = gatherText(profile);
  const applicant_types = deriveApplicantTypes(profile, blob);
  const needs = deriveNeeds(profile, blob);
  const location = deriveLocation(profile);

  // Loans and cost-share are OFF unless the profile explicitly opts in. This is
  // the doctrine default: never surface loans as grants.
  const loan_allowed = profile?.allow_loans === true || profile?.preferences?.allow_loans === true;
  const cost_share_allowed =
    profile?.allow_cost_share === true || profile?.preferences?.allow_cost_share === true;

  const isStudent = applicant_types.includes('student') || Boolean(profile?.school);
  const isOrg = applicant_types.some((t) =>
    ['nonprofit', 'church', 'ministry', 'school', 'vfd', 'business', 'farm', 'government'].includes(t));

  return {
    profile_id: profile?.id ?? profile?.profile_id ?? null,
    applicant_types,
    needs,
    location,
    loan_allowed,
    cost_share_allowed,
    is_student: isStudent,
    is_org: isOrg,
    school: profile?.school ?? null,
    // Match floor / slider. Individuals get a slightly lower floor so they are
    // not starved; the planner/match engine can override per-run.
    min_match_score: Number.isFinite(profile?.min_match_score)
      ? profile.min_match_score
      : (isOrg ? 60 : 55),
    // Searchable keyword seeds (deduped) for the planner's query builders.
    keywords: [...new Set([...needs, ...applicant_types])],
    raw_profile_present: Boolean(profile && Object.keys(profile).length),
  };
}

export default { buildThesis };
