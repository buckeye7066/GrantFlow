// crawler-os/webQueries.js
//
// Pure: turn a funding thesis into a small set of profile-keyed web-search
// queries for the open-web discovery lane. This is how GrantFlow reaches the
// state/local/foundation/community funding that has NO public API — the breadth
// the federal-API sources (Grants.gov/SAM/NIH) structurally cannot cover.
//
// No I/O, no clock dependency in the core (the year is injected so the module
// stays deterministic for tests).

// Readable noun for an applicant bucket (used in the query text).
const TYPE_WORD = Object.freeze({
  nonprofit: 'nonprofit organization',
  church: 'church / faith-based organization',
  ministry: 'faith-based ministry',
  school: 'school',
  business: 'small business',
  farm: 'farm / agricultural producer',
  government: 'local government',
  tribal: 'tribal organization',
  vfd: 'volunteer fire department',
  law_enforcement: 'law enforcement agency',
  veteran: 'veteran',
  student: 'student',
  family: 'family',
  individual: 'individual',
});

function typeWord(types = []) {
  const t = (types || []).find((x) => x && x !== '*');
  return TYPE_WORD[String(t || '').toLowerCase()] || 'organization';
}

function geoPhrase(location = {}) {
  const city = location?.city ? String(location.city).trim() : '';
  const state = location?.state ? String(location.state).trim() : '';
  if (city && state) return `${city}, ${state}`;
  return state || city || '';
}

// County-level phrase ("Bradley County, TN"). Hyperlocal awards (community
// foundations, county scholarships, local civic clubs) are keyed to the COUNTY,
// not the city — and the city phrase never reaches them.
function countyPhrase(location = {}) {
  let county = location?.county ? String(location.county).trim() : '';
  if (!county) return '';
  if (!/county|parish|borough/i.test(county)) county = `${county} County`;
  const state = location?.state ? String(location.state).trim() : '';
  return state ? `${county}, ${state}` : county;
}

// Normalize a school/employer name for query text (drop trailing punctuation).
function cleanInstitution(v) {
  const s = String(v || '').replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
  return s.length >= 3 && s.length <= 90 ? s : '';
}

// Turn an internal need/interest token (e.g. "medical_bills", "first_gen") into
// human search language ("medical bills", "first gen"). Bounded + lowercased.
function humanize(term) {
  return String(term || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Rotate an array left by `offset` (deterministic given the seed). A rotated
// pool means that when the caller caps to `max`, successive runs (different
// seeds) sample a DIFFERENT slice of the broadening queries — so re-runs explore
// new ground instead of repeating the identical set. The CORE queries are never
// rotated, so the highest-signal searches always run and match quality is never
// traded away for breadth.
function rotate(arr, offset) {
  if (!Array.isArray(arr) || arr.length <= 1) return Array.isArray(arr) ? arr.slice() : [];
  const k = ((Math.trunc(offset) % arr.length) + arr.length) % arr.length;
  return arr.slice(k).concat(arr.slice(0, k));
}

/**
 * buildWebQueries — produce deduped, profile-relevant open-web funding queries.
 *
 * Two tiers:
 *   - CORE  : the highest-signal queries, ALWAYS emitted (never rotated). These
 *             guarantee the strongest searches run every time.
 *   - EXTRA : a broadening pool (more needs, alternate phrasings, student
 *             scholarship templates, field-of-study/interest queries). Rotated by
 *             `seed` so re-runs explore NEW queries instead of the same set.
 *
 * For sparse student profiles this is the main breadth lever: grants.gov/SAM
 * don't serve individuals, so the open-web lane is where a student's real
 * scholarship coverage comes from.
 *
 * @param {object} thesis  crawler-os thesis (applicant_types, needs, location,
 *                          keywords, interest_terms, is_student)
 * @param {{ year?:number, max?:number, seed?:number }} [opts]
 *   seed — rotation offset for the EXTRA pool; default 0 (deterministic). The
 *   live web lane passes a per-run seed so successive discoveries diversify.
 * @returns {string[]}
 */
export function buildWebQueries(thesis = {}, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : 6;
  const year = Number.isFinite(opts.year) ? opts.year : new Date().getFullYear();
  const seed = Number.isFinite(opts.seed) ? opts.seed : 0;
  const word = typeWord(thesis.applicant_types);
  const geo = geoPhrase(thesis.location);
  const county = countyPhrase(thesis.location);
  const state = thesis.location?.state ? String(thesis.location.state).trim() : '';
  const schools = (Array.isArray(thesis.schools) ? thesis.schools : [])
    .map(cleanInstitution)
    .filter(Boolean)
    .slice(0, 2);
  const field = cleanInstitution(thesis.field_of_study);
  const employer = cleanInstitution(thesis.employer);
  const isStudent =
    Boolean(thesis.is_student) ||
    (Array.isArray(thesis.applicant_types) && thesis.applicant_types.includes('student'));
  const needs = (Array.isArray(thesis.needs) ? thesis.needs : []).map(humanize).filter(Boolean);
  // Free-text field-of-study / career-goal / interest seeds the applicant entered.
  // Distinct from needs: these do NOT affect matching — they only widen the query
  // set so a student reaches field-specific scholarships (e.g. "nursing").
  const interests = (Array.isArray(thesis.interest_terms) ? thesis.interest_terms : [])
    .map(humanize)
    .filter((t) => t && t.length > 2 && t.length < 40)
    .slice(0, 8);

  const seen = new Set();
  const add = (list, q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (s.length <= 6) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    list.push(s);
  };

  const core = [];
  const extra = [];

  // ── CORE (always emitted, highest signal) ──
  // Institution-specific funding FIRST — endowed / departmental / foundation
  // scholarships are findable ONLY by the school's name; no geo/type/need query
  // can reach them. This is the single biggest recall gap for a named student.
  if (isStudent) {
    schools.forEach((school, i) => {
      add(core, `${school} scholarships`);
      // Departmental / field-of-study endowment at the primary institution.
      if (i === 0 && field) add(core, `${school} ${field} scholarship`);
      // The university FOUNDATION is where most named endowments live.
      if (i === 0) add(core, `${school} foundation scholarships`);
    });
    // Field-of-study scholarships (major), independent of any one school.
    if (field) add(core, `${field} scholarships ${year}`);
  }
  // Employer education programs (tuition assistance / employer scholarships) —
  // a real funding class for a working applicant, reachable only by employer name.
  if (employer) {
    add(core, `${employer} scholarship`);
    add(core, `${employer} tuition assistance`);
  }
  // The two strongest need-specific searches.
  for (const need of needs.slice(0, 2)) add(core, `${need} grants for ${word} ${geo}`);
  // Hyperlocal, COUNTY-level awards (community foundations, county scholarships,
  // local civic clubs) — keyed to the county, which the city phrase never reaches.
  if (county) {
    add(core, isStudent ? `scholarships ${county}` : `grants for ${word} ${county}`);
    add(core, `community foundation ${county}`);
  }
  // Geo + type funding, current cycle (orgs/individuals; a student's best geo
  // query is the scholarship one below, so skip the weak "student grants" phrase).
  if (geo && !isStudent) add(core, `${word} grants ${geo} ${year}`);
  // Community/place-based philanthropy (where most local money lives).
  if (geo) add(core, `community foundation grants ${geo}`);
  // Students: the single best scholarship query is core (federal APIs skip them).
  if (isStudent) add(core, `scholarships for students ${geo} ${year}`);

  // ── EXTRA (broadening pool, rotated by seed) ──
  // Remaining needs + an alternate phrasing for each need.
  for (const need of needs.slice(2)) add(extra, `${need} grants for ${word} ${geo}`);
  for (const need of needs) add(extra, `${need} assistance program ${geo}`);
  // Alternate geo phrasings so a run reaches pages the core phrasing misses.
  if (geo) {
    add(extra, `local grants ${word} ${geo}`);
    add(extra, `${word} funding opportunities ${geo} ${year}`);
  }
  // National fallback keyed to each need (also covers no-geo profiles).
  for (const need of needs) add(extra, `${need} grant funding ${word}`);

  // Student-specific scholarship breadth.
  if (isStudent) {
    add(extra, `need-based scholarships ${geo}`);
    add(extra, `merit scholarships ${geo} ${year}`);
    add(extra, `local scholarships ${geo}`);
    add(extra, `${geo} college grants for students`);
    add(extra, `community foundation scholarships ${geo}`);
    if (state) add(extra, `${state} state scholarship programs`);
    // Field-of-study / career-goal keyed scholarships.
    for (const term of interests) {
      add(extra, `${term} scholarships ${geo}`);
      add(extra, `${term} scholarships ${year}`);
    }
  } else {
    // Non-student interest/keyword-keyed grant searches.
    for (const term of interests) add(extra, `${term} grants for ${word} ${geo}`);
  }

  // ── Individual / benefit-need breadth (NON-students) ──
  // Students get a rich, scholarship-specific query set above. Individuals and
  // families seeking assistance (disability, senior, housing, food, energy,
  // medical, caregiver) were previously served by only 1-2 generic "need grants"
  // phrases — the single biggest recall gap for real people. People in need
  // qualify for PROGRAMS/BENEFITS/referral services (benefits.gov, 211, Area
  // Agencies on Aging, state HHS, community action, vocational rehab), not
  // competitive "grants", so emit the searches that actually reach them.
  if (!isStudent) {
    const needSet = needs.map((n) => n.toLowerCase());
    const kw = (Array.isArray(thesis.keywords) ? thesis.keywords : []).join(' ').toLowerCase();
    const signal = (re) => re.test(kw) || needSet.some((n) => re.test(n));

    // Universal safety-net locators — apply to ANY low-income individual, so they
    // surface even for a sparse profile (the Kathy-class empty profile).
    if (state || geo) {
      add(core, `benefits.gov ${state || geo}`);
      add(core, `211 community resources ${state || geo}`);
      add(extra, `community action agency ${county || geo}`);
    }
    // Per-need ASSISTANCE PROGRAMS (distinct from the "need grants" phrase above).
    for (const need of needs.slice(0, 3)) {
      add(core, `${need} assistance programs ${state || geo}`);
      if (county) add(extra, `local ${need} support services ${county}`);
    }
    // State benefit programs by name (where individuals actually apply).
    if (state) {
      add(extra, `${state} emergency assistance program`);
      add(extra, `${state} LIHEAP energy assistance`);
      add(extra, `${state} Medicaid application`);
      add(extra, `${state} SNAP food assistance`);
    }
    // Senior-specific safety net.
    if (signal(/senior|aging|elder|\b6[25]\+|older adult/)) {
      if (state) add(core, `Area Agency on Aging ${state}`);
      add(extra, `senior services ${county || geo}`);
      add(extra, `Meals on Wheels ${geo}`);
      add(extra, `senior housing assistance ${state || geo}`);
    }
    // Disability-specific.
    if (signal(/disab|blind|deaf|wheelchair|adaptive|assistive|mobility/)) {
      if (state) add(core, `${state} vocational rehabilitation services`);
      add(extra, `disability assistance grants ${state || geo}`);
      add(extra, `assistive technology funding ${state || geo}`);
      add(extra, `disability employment support ${geo}`);
    }
    // Caregiver-specific.
    if (signal(/caregiv|respite|kinship|foster/)) {
      if (state) add(core, `caregiver support program ${state}`);
      add(extra, `respite care assistance ${geo}`);
    }
  }

  // Last resort: a sparse profile still searches something useful.
  if (core.length === 0 && extra.length === 0) add(core, `grants for ${word} ${geo || year}`);

  return [...core, ...rotate(extra, seed)].slice(0, max);
}

export default { buildWebQueries };
