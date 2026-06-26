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
  // NOTE: applicant-type synonyms must be IDENTITY words, not theme words.
  // 'rural'/'community'/'city'/'county' are themes that appear in almost any
  // mission statement — a rural church is not a "farm" applicant and a community
  // center is not a "government" applicant. They were pulling unrelated org
  // grants into every org's results, so they are excluded here (they remain
  // useful as NEED/geo signals elsewhere).
  farm: ['farm', 'farmer', 'agriculture', 'ranch'],
  government: ['government', 'municipal', 'tribal', 'municipality'],
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

// HIGH-PRECISION phrase → applicant-bucket safety net. Unlike the broad
// single-word synonym scan (which only runs as a last-resort fallback because
// theme words like "community"/"military" caused false positives), these are
// multi-word, unambiguous funding-IDENTITY phrases. They run ADDITIVELY for
// ORGANIZATION-class profiles only (never on a person/household primary
// identity) so a profile whose TYPE field is generic ('organization', 'other',
// blank) but whose text clearly says what it is still reaches the right
// sources. Canonical example: a profile typed 'organization' whose mission says
// "we are a volunteer fire department" must still pull FEMA AFG — it must never
// silently miss it again. Additive only → recall, never suppression; the match
// engine still scores relevance so this cannot flood.
// Deliberately NARROW. Earlier theme-prone buckets (farm/government/school/
// church via single words like "farm-area", "community", "education") caused
// exactly the over-broadening the 2026-06-23 false-positive audit guards
// against — a church whose mission mentioned "rural families / farm-area
// ministry" was wrongly typed farm. Those identities are already covered
// reliably by the declared-type PRIMARY_TYPE_TO_APPLICANT map. The ONE case
// that genuinely needs a free-text safety net is fire/EMS: a profile typed
// generically ('organization'/'other') but whose text clearly says it is a
// fire department must still reach FEMA AFG. These phrases are multi-word and
// unambiguous (they do not appear as themes in other orgs' missions), and the
// add is purely additive recall (the match engine still scores relevance).
const PHRASE_APPLICANT_TRIGGERS = Object.freeze([
  {
    add: 'vfd',
    label: 'fire / EMS / first-responder',
    re: /\b(volunteer\s+fire|fire\s+department|fire\s+district|fire\s+protection\s+district|fire\s+rescue|firefighter|first\s+responder|emergency\s+medical\s+services?|\bvfd\b|fema\s+afg|\bafg\s+grant|safer\s+grant|assistance\s+to\s+firefighter)/i,
  },
]);

/**
 * detectKeywordApplicantTriggers — scan free text for high-precision identity
 * phrases. Returns the buckets that fired with the matched phrase, so the
 * crawler-plan explainer (and Anya's plan-for-profile tool) can show EXACTLY
 * which keyword pulled in which source. ORG-only by design — pass
 * isIndividual=true to suppress (a person who volunteers at a fire dept is not
 * a VFD applicant).
 *
 * @param {string} blob lowercased profile text
 * @param {boolean} isIndividual whether the primary identity is a person/household
 * @returns {Array<{add:string,label:string,matched:string}>}
 */
export function detectKeywordApplicantTriggers(blob, isIndividual) {
  if (isIndividual) return [];
  const text = String(blob ?? '');
  const fired = [];
  for (const trig of PHRASE_APPLICANT_TRIGGERS) {
    const m = text.match(trig.re);
    if (m) fired.push({ add: trig.add, label: trig.label, matched: m[0].trim() });
  }
  return fired;
}

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

// AUTHORITATIVE primary_type -> applicant-bucket map. The substring-synonym
// scan below cannot recognize multi-word canonical types whose stored
// primary_type uses underscores (e.g. 'volunteer_fire_department',
// 'food_pantry', 'local_housing_authority') — those silently fell through to
// the 'individual' default and were then HARD-EXCLUDED from grants_gov/sam_gov
// (their applicant_types omit 'individual'), producing zero real funding for
// fire departments, food pantries, shelters, libraries, government agencies,
// etc. — a mission-rule violation (zero-results / hard boolean filter).
// This map is consulted FIRST so every canonical type lands in the correct
// funding-eligibility bucket(s). Multiple buckets widen recall; the match
// engine still scores relevance so this never floods.
const PRIMARY_TYPE_TO_APPLICANT = Object.freeze({
  // Person / household (federal grant APIs don't serve these directly; they
  // get honest benefit/direct-aid directories and locators).
  individual: ['individual'],
  medical_need: ['individual'],
  senior: ['individual'],
  veteran: ['veteran', 'individual'],
  disabled_adult: ['individual'],
  teacher: ['individual'],
  classroom_teacher: ['individual'],
  educator: ['individual'],
  family: ['family', 'individual'],
  homeschool_family: ['family', 'individual'],
  // Students
  student: ['student', 'individual'],
  high_school_student: ['student', 'individual'],
  college_student: ['student', 'individual'],
  graduate_student: ['student', 'individual'],
  // Schools / education institutions
  school: ['school'],
  school_district: ['school', 'government'],
  public_school: ['school', 'government'],
  special_education_program: ['school'],
  school_food_service: ['school', 'government'],
  school_transportation: ['school', 'government'],
  library: ['nonprofit', 'government'],
  library_media_center: ['nonprofit', 'government'],
  pta_pto: ['nonprofit'],
  // Nonprofits / community orgs
  nonprofit: ['nonprofit'],
  organization: ['nonprofit'], // legacy seed string
  food_pantry: ['nonprofit'],
  homeless_shelter: ['nonprofit'],
  animal_rescue: ['nonprofit'],
  mental_health_nonprofit: ['nonprofit'],
  substance_recovery_org: ['nonprofit'],
  reentry_program: ['nonprofit'],
  community_center: ['nonprofit'],
  museum: ['nonprofit'],
  domestic_violence_shelter: ['nonprofit'],
  // Faith-based (also nonprofit-eligible for federal/foundation funding)
  church: ['church', 'nonprofit'],
  ministry: ['ministry', 'nonprofit'],
  // Emergency services
  volunteer_fire_department: ['vfd', 'government'],
  // Government / public agencies
  county_government: ['government'],
  local_government: ['government'],
  municipality: ['government'],
  public_agency: ['government'],
  local_housing_authority: ['government'],
  parks_department: ['government'],
  regional_planning_agency: ['government'],
  economic_development_agency: ['government'],
  tribal_government: ['government'],
  public_health_department: ['government'],
  // Business
  business: ['business'],
  small_business: ['business'], // legacy seed string
  minority_owned_business: ['business'],
  women_owned_business: ['business'],
});

function deriveApplicantTypes(profile, blob, triggerCollector = null) {
  const explicit = []
    .concat(profile?.applicant_types ?? [])
    .concat(profile?.type ?? [])
    .concat(profile?.profile_type ?? [])
    .map(lc)
    .filter(Boolean);
  const found = new Set();

  // Applicant TYPE = WHO the applicant is. It comes from the DECLARED identity
  // (applicant_types / profile_type), never from free-text. Free text describes
  // NEEDS and CONTEXT — a student whose file mentions a parent's "military"
  // service, or a church whose mission mentions "education"/"community", is not
  // a veteran/school/government applicant. Augmenting the declared identity from
  // the blob was the root false-positive driver (veteran-only grants matched to
  // students; farm/government grants matched to a church). So:
  //   0. map EXACT canonical primary_type strings to their funding bucket(s)
  //      (authoritative — handles underscore multi-word types the synonym scan
  //      misses, e.g. volunteer_fire_department, food_pantry),
  //   1. canonicalize the EXPLICIT identity strings via synonyms (trusted), and
  //   2. ONLY when the profile declares no identity at all, fall back to a blob
  //      scan so a bare profile still searches something (never zero).
  for (const e of explicit) {
    const mapped = PRIMARY_TYPE_TO_APPLICANT[e];
    if (mapped) for (const bucket of mapped) found.add(bucket);
  }
  for (const e of explicit) {
    if (APPLICANT_TYPE_SYNONYMS[e]) found.add(e); // already a canonical bucket
    for (const [canon, syns] of Object.entries(APPLICANT_TYPE_SYNONYMS)) {
      if (syns.some((s) => e.includes(s))) found.add(canon);
    }
  }
  if (found.size === 0) {
    // Fallback only — no declared identity. Infer from free text.
    for (const [canon, syns] of Object.entries(APPLICANT_TYPE_SYNONYMS)) {
      if (syns.some((s) => blob.includes(s))) found.add(canon);
    }
  }

  // Identity guard: a person/household primary identity must NOT carry
  // organizational applicant types (an individual is not an organization).
  // "high_school_student" CONTAINS "school", so detect person tokens with word
  // boundaries (+ a "student" catch-all) rather than a naive org-substring test.
  const primaryRaw = lc(profile?.profile_type ?? profile?.type ?? '');
  const primaryIsIndividual =
    INDIVIDUAL_APPLICANT_TYPES.has(primaryRaw) ||
    primaryRaw.includes('student') ||
    /\b(individual|person|resident|family|household|parent|parents|caregiver|scholar|undergraduate|graduate|pupil|veteran)\b/.test(primaryRaw);
  if (primaryIsIndividual) {
    for (const t of [...found]) if (ORG_APPLICANT_TYPES.has(t)) found.delete(t);
    // A person applicant is an INDIVIDUAL applicant — ensure individual-eligible
    // opportunities still match even when the only declared subtype is e.g.
    // "student". This is a correct structural implication, not free-text noise.
    found.add('individual');
  }

  // HIGH-PRECISION keyword safety net (ORG-class profiles only): pull in the
  // correct applicant bucket(s) for profiles whose TYPE is generic but whose
  // text unambiguously identifies them (e.g. type='organization' + mission
  // "volunteer fire department" → add 'vfd' so FEMA AFG fires). Additive only.
  const firedTriggers = detectKeywordApplicantTriggers(blob, primaryIsIndividual);
  for (const t of firedTriggers) {
    if (!found.has(t.add)) {
      found.add(t.add);
      if (Array.isArray(triggerCollector)) triggerCollector.push(t);
    } else if (Array.isArray(triggerCollector)) {
      triggerCollector.push({ ...t, already_present: true });
    }
  }

  // Structural implication: faith-based organizations (church / ministry) are
  // eligible for federal and foundation funding on the SAME basis as nonprofits
  // — grants.gov classifies faith-based orgs under its "Nonprofits" eligibility,
  // and HHS / CDBG / USDA community-facilities / FEMA programs are open to them.
  // Without this, a pure church/ministry profile (applicant_types=['church'])
  // is HARD-EXCLUDED from grants_gov + sam_gov at the planner (their
  // applicant_types omit church/ministry) → ZERO federal grants for a church,
  // a mission-rule violation ("hard boolean filters forbidden unless the source
  // is explicitly exclusive"; "avoid zero results"). We ADD nonprofit (keeping
  // the church/ministry identity tag) so federal/foundation sources fire; the
  // match engine still scores relevance, so this widens recall without flooding.
  if (!primaryIsIndividual && (found.has('church') || found.has('ministry'))) {
    found.add('nonprofit');
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
  const keywordTriggers = [];
  const applicant_types = deriveApplicantTypes(profile, blob, keywordTriggers);
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
    // Which high-precision identity phrases (if any) pulled in an applicant
    // bucket from free text — surfaced so the crawler-plan explainer / Anya can
    // show WHY a source fired (e.g. "FEMA AFG fired because the mission text
    // says 'volunteer fire department'"). Empty for individuals and for
    // profiles whose declared type already covered everything.
    keyword_triggers: keywordTriggers,
    raw_profile_present: Boolean(profile && Object.keys(profile).length),
  };
}

export default { buildThesis };
