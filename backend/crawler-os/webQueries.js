// crawler-os/webQueries.js
//
// Pure: turn a funding thesis into a small set of profile-keyed web-search
// queries for the open-web discovery lane. This is how GrantFlow reaches the
// state/local/foundation/community funding that has NO public API — the breadth
// the federal-API sources (Grants.gov/SAM/NIH) structurally cannot cover.
//
// No I/O, no clock dependency in the core (the year is injected so the module
// stays deterministic for tests).
//
// TWO ENTRY POINTS, ONE PLANNER (2026-09-12):
//   buildWebQueryPlan(thesis, opts) -> { queries, entries, ... }  provenance
//   buildWebQueries(thesis, opts)   -> plan.queries (string[])    compatibility
// The live lane executes only ~6 of its 28 planned queries (44 pages at eight
// hits/query), so the planner's contract is about the HEAD of the plan — see
// buildWebQueryPlan for the guarantee.

// Readable noun for an applicant bucket (used in the query text). Every person
// bucket PRIMARY_TYPE_TO_APPLICANT can emit FIRST needs a noun here, or the
// applicant is searched as an "organization" (a teacher was: hyperlocal-4).
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
  teacher: 'teacher',
  active_duty: 'service member',
  guard_reserve: 'service member',
  transitioning_service_member: 'transitioning service member',
  military_spouse: 'military spouse',
  candidate: 'candidate',
  senior: 'senior',
  caregiver: 'caregiver',
});

// The FIRST applicant bucket that has a noun wins; a bucket without one never
// demotes a person to "organization".
function typeWord(types = []) {
  for (const t of types || []) {
    if (!t || t === '*') continue;
    const noun = TYPE_WORD[String(t).toLowerCase()];
    if (noun) return noun;
  }
  return 'organization';
}

// US-territory codes are poison as bare tokens in search text ("PR" reads as
// public relations, "GU"/"VI"/"AS"/"MP" are noise), and "<code> state ..."
// phrasing is wrong for a territory. Expand them to the full territory name in
// every query phrase — the fifty-state assumption must never silently exclude
// a territorial profile (Puerto Rico is the canonical case).
const TERRITORY_NAME = Object.freeze({
  PR: 'Puerto Rico',
  GU: 'Guam',
  VI: 'U.S. Virgin Islands',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
});
function regionName(stateCode) {
  const code = String(stateCode || '').trim();
  return TERRITORY_NAME[code.toUpperCase()] || code;
}

function geoPhrase(location = {}) {
  const city = location?.city ? String(location.city).trim() : '';
  const state = regionName(location?.state);
  if (city && state) return `${city}, ${state}`;
  return state || city || '';
}

// Alaska has no counties. The county-bearing datasets and Amy's probe space
// both supply the BARE name ("Anchorage", "Bethel"), and appending " County"
// searched a jurisdiction that does not exist — "Anchorage County, AK" is
// listed in config/placeholderProfileSignals.js as invented geography seen in
// prod (hyperlocal-2). Nineteen boroughs / consolidated city-boroughs and
// eleven census areas; an unmapped name stays a bare place.
const ALASKA_COUNTY_EQUIVALENT = Object.freeze({
  anchorage: 'Municipality of Anchorage',
  skagway: 'Municipality of Skagway',
  juneau: 'City and Borough of Juneau',
  sitka: 'City and Borough of Sitka',
  wrangell: 'City and Borough of Wrangell',
  yakutat: 'City and Borough of Yakutat',
  'aleutians east': 'Aleutians East Borough',
  'bristol bay': 'Bristol Bay Borough',
  denali: 'Denali Borough',
  'fairbanks north star': 'Fairbanks North Star Borough',
  haines: 'Haines Borough',
  'kenai peninsula': 'Kenai Peninsula Borough',
  'ketchikan gateway': 'Ketchikan Gateway Borough',
  'kodiak island': 'Kodiak Island Borough',
  'lake and peninsula': 'Lake and Peninsula Borough',
  'matanuska-susitna': 'Matanuska-Susitna Borough',
  'matanuska susitna': 'Matanuska-Susitna Borough',
  'north slope': 'North Slope Borough',
  'northwest arctic': 'Northwest Arctic Borough',
  petersburg: 'Petersburg Borough',
  'aleutians west': 'Aleutians West Census Area',
  bethel: 'Bethel Census Area',
  chugach: 'Chugach Census Area',
  'copper river': 'Copper River Census Area',
  dillingham: 'Dillingham Census Area',
  'hoonah-angoon': 'Hoonah-Angoon Census Area',
  kusilvak: 'Kusilvak Census Area',
  nome: 'Nome Census Area',
  'prince of wales-hyder': 'Prince of Wales-Hyder Census Area',
  'southeast fairbanks': 'Southeast Fairbanks Census Area',
  'yukon-koyukuk': 'Yukon-Koyukuk Census Area',
});
// A county string that already names its own jurisdiction class.
const COUNTY_EQUIVALENT_RX = /\b(county|parish|borough|municipio|municipality|census area|city and borough|district of columbia)\b|\bcity$/i;

/**
 * countyPhrase — the county-level search phrase ("Bradley County, TN").
 * Hyperlocal awards (community foundations, county scholarships, local civic
 * clubs) are keyed to the COUNTY, not the city — and the city phrase never
 * reaches them. State-aware: Louisiana parishes, Alaska boroughs / census
 * areas / consolidated municipalities, Puerto Rico municipios; territory and
 * county-equivalent strings that already carry their suffix pass through;
 * Virginia independent cities ("Richmond city") pass through; a county that
 * merely repeats its territory ("Guam") adds nothing.
 */
export function countyPhrase(location = {}) {
  const raw = location?.county ? String(location.county).replace(/\s+/g, ' ').trim() : '';
  if (!raw) return '';
  const stateCode = String(location?.state || '').trim().toUpperCase();
  const state = regionName(stateCode);
  if (state && raw.toLowerCase() === state.toLowerCase()) return '';
  let county = raw;
  if (!COUNTY_EQUIVALENT_RX.test(raw)) {
    if (stateCode === 'AK') {
      county = ALASKA_COUNTY_EQUIVALENT[raw.toLowerCase()] || raw;
    } else if (stateCode === 'LA') {
      county = `${raw} Parish`;
    } else if (stateCode === 'PR') {
      county = `${raw} Municipio`;
    } else if (TERRITORY_NAME[stateCode] || stateCode === 'DC') {
      county = raw;
    } else {
      county = `${raw} County`;
    }
  }
  if (/^district of columbia$/i.test(county)) return county;
  return state ? `${county}, ${state}` : county;
}

// Normalize a school/employer name for query text (drop trailing punctuation).
function cleanInstitution(v) {
  const s = String(v || '').replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
  return s.length >= 3 && s.length <= 90 ? s : '';
}

const SCHOOL_PUBLICATION_ALIASES = Object.freeze({
  'the ohio state university': ['Ohio State'],
});
function schoolPublicationAliases(name) {
  return SCHOOL_PUBLICATION_ALIASES[String(name || '').toLowerCase().trim()] || [];
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

export const PERSISTENT_QUERY_ANCHOR_COUNT = 2;

// The page-derived execution window: the live lane's 44-page queue fills after
// six eight-hit SERPs, so only the first six planned queries are guaranteed to
// run. Everything the planner promises, it promises inside this window.
export const WEB_QUERY_HEAD_WINDOW = 6;

export function hasPersistentQueryShortfall(thesis = {}) {
  const classes = Array.isArray(thesis.learned_gaps?.classes) ? thesis.learned_gaps.classes : [];
  return classes.some((gap) => gap === 'low_results' || gap === 'result_floor_shortfall');
}

/**
 * normalizeQueryKey — the ONE dedup key for web queries (builder, lane and
 * directive callers). Case, whitespace and punctuation variants collapse
 * ("Cleveland, TN" == "cleveland tn"); double quotes are a search operator
 * (exact phrase) and are kept, so `"Lee University" scholarships` stays
 * distinct from the broad-recall unquoted form.
 */
export function normalizeQueryKey(query) {
  return String(query ?? '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}"\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CRISIS_NEED_RX = /\bfood|\bhousing|\brent|\benergy|\butilit|\bmedical|\btransport|\bemergency|\bhomeless/;

/**
 * buildWebQueryPlan — produce deduped, profile-relevant open-web funding
 * queries WITH provenance.
 *
 * Three placement tiers:
 *   - anchor  : learned-gap steering reserved at the head (shortfall profiles
 *               only, at most PERSISTENT_QUERY_ANCHOR_COUNT). Never rotated.
 *   - core    : the highest-signal fixed queries — the profile's own strongest
 *               searches plus any remaining learned-gap steering. Never rotated.
 *   - breadth : the broadening pool, rotated by `seed` so re-runs explore NEW
 *               ground instead of the same set.
 *
 * HEAD GUARANTEE: the first min(max, WEB_QUERY_HEAD_WINDOW) positions contain
 * every anchor, the strongest profile-own core query, and — whenever any
 * breadth exists and the budget allows (max >= 3, or max == 2 without a
 * shortfall) — at least ONE rotated breadth query. A caller that can execute
 * only six queries therefore still gets anchors + core + rotation, and
 * different seeds change which breadth query sits in the head. The rotating
 * slot comes right after the reserved ones: under a shortfall the head reads
 * [anchors…, first breadth, strongest core, core…] (so a consumer taking the
 * first PERSISTENT_QUERY_ANCHOR_COUNT + 1 entries gets anchors + rotation),
 * otherwise [strongest core, first breadth, core…]. Within the head no
 * single need takes more than ceil(H/3) slots and no single query family
 * more than ceil(H/2) slots (surplus entries stay fixed, later).
 *
 * Tiny budgets: max 0 -> []; max 1 -> the strongest core query (never a
 * seed-dependent extra); max 2 -> strongest core + one rotating query, or under
 * a shortfall one anchor + the strongest core.
 *
 * @param {object} thesis  crawler-os thesis (applicant_types, needs, location,
 *                          keywords, interest_terms, is_student, learned_gaps…)
 * @param {{ year?:number, max?:number, seed?:number, headWindow?:number }} [opts]
 * @returns {{
 *   queries: string[],
 *   entries: Array<{ query:string, tier:'anchor'|'core'|'breadth', family:string, gap_class:string|null, need:string|null }>,
 *   planned_total: number,
 *   dropped_by_budget: Array<{ query:string, tier:string, family:string }>,
 *   dropped_duplicates: Array<{ query:string, duplicate_of:string }>,
 *   seed: number, max: number, shortfall: boolean, head_size: number,
 * }}
 */
export function buildWebQueryPlan(thesis = {}, opts = {}) {
  const max = Number.isFinite(opts.max) ? Math.max(0, Math.floor(opts.max)) : 6;
  const seed = Number.isFinite(opts.seed) ? opts.seed : 0;
  const headWindow = Number.isFinite(opts.headWindow) ? Math.max(1, Math.floor(opts.headWindow)) : WEB_QUERY_HEAD_WINDOW;
  const shortfall = hasPersistentQueryShortfall(thesis);
  const emptyPlan = () => ({
    queries: [], entries: [], planned_total: 0, dropped_by_budget: [], dropped_duplicates: [],
    seed, max, shortfall, head_size: 0,
  });
  if (max === 0) return emptyPlan();
  const year = Number.isFinite(opts.year) ? opts.year : new Date().getFullYear();
  const word = typeWord(thesis.applicant_types);
  const types = Array.isArray(thesis.applicant_types) ? thesis.applicant_types : [];
  // Org-shaped profile: no person bucket present. Orgs get the institution
  // entity lane below INSTEAD of the individual safety-net lane — benefits.gov
  // / 211 / church-assistance queries are person searches and were crowding
  // institution-class program queries out of the per-run query cap.
  const isOrgProfile = thesis.is_org === true ||
    (types.length > 0 && !types.some((t) => ['individual', 'family', 'student', 'veteran', 'senior', 'caregiver'].includes(t)));
  const geo = geoPhrase(thesis.location);
  const county = countyPhrase(thesis.location);
  const stateCode = thesis.location?.state ? String(thesis.location.state).trim().toUpperCase() : '';
  // `state` is SEARCH LANGUAGE (territory codes expanded to full names) — use
  // stateCode for any code comparison.
  const state = regionName(stateCode);
  const isTerritory = Boolean(TERRITORY_NAME[stateCode]);
  // Towns within the ~25-mile local radius of the profile ZIP (nearest first,
  // computed by geoRadius in the thesis). These reach the next-town-over and
  // across-county/state-line funders that the exact city/county tokens miss.
  const nearby = (Array.isArray(thesis.location?.nearby_cities) ? thesis.location.nearby_cities : [])
    .map((n) => (n?.city && n?.state ? `${String(n.city).trim()}, ${regionName(n.state)}` : ''))
    .filter(Boolean)
    .slice(0, 4);
  const schools = (Array.isArray(thesis.schools) ? thesis.schools : [])
    .map(cleanInstitution)
    .filter(Boolean)
    .slice(0, 2);
  const field = cleanInstitution(thesis.field_of_study);
  const employer = cleanInstitution(thesis.employer);
  const isStudent =
    Boolean(thesis.is_student) ||
    (Array.isArray(thesis.applicant_types) && thesis.applicant_types.includes('student'));
  // Higher-education institution as an IDENTITY (a university, a community
  // college), not a need phrase — set by the thesis when the profile's type
  // says so. Gating the family on need text alone gave a university K-12
  // teacher lanes and no higher-ed query (hyperlocal-7).
  const isHigherEd = thesis.is_higher_ed === true;
  const needs = (Array.isArray(thesis.needs) ? thesis.needs : []).map(humanize).filter(Boolean);
  const needsDefaulted = thesis.needs_defaulted === true || thesis.needs?.defaulted === true;
  // Free-text field-of-study / career-goal / interest seeds the applicant entered.
  // Distinct from needs: these do NOT affect matching — they only widen the query
  // set so a student reaches field-specific scholarships (e.g. "nursing").
  const interests = (Array.isArray(thesis.interest_terms) ? thesis.interest_terms : [])
    .map(humanize)
    .filter((t) => t && t.length > 2 && t.length < 40)
    .slice(0, 8);

  // ── Entry construction ────────────────────────────────────────────────────
  // Every query is an entry { query, family, need, gap_class, origin }. `family`
  // names the template group (county, nearby_town, need_geo, …) so the plan can
  // cap a family's share of the head and telemetry can say which family a hit
  // came from; `need` is the humanized need the template was keyed to.
  const dropped_duplicates = [];
  const seen = new Map(); // normalized key -> first surface form
  let currentFamily = 'general';
  const setFamily = (f) => { currentFamily = f; };
  const entry = (list, s, meta = {}) => ({
    query: s,
    family: meta.family ?? currentFamily,
    need: meta.need ?? null,
    gap_class: meta.gap_class ?? null,
    origin: list,
  });
  const core = [];
  const extra = [];
  const add = (list, q, meta = {}) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (s.length <= 6) return;
    const k = normalizeQueryKey(s);
    if (!k) return;
    if (seen.has(k)) {
      if (seen.get(k) !== s) dropped_duplicates.push({ query: s, duplicate_of: seen.get(k) });
      return;
    }
    seen.set(k, s);
    list.push(entry(list === core ? 'core' : list === extra ? 'extra' : 'forced', s, meta));
  };

  // Amy flywheel precision lane: pin the defining program families for the
  // organization classes that repeatedly came back REVIEW-only. These must be
  // inserted BEFORE generic type/geo queries because the final query cap slices
  // from the end. The rows still face the normal reality, eligibility, and match
  // gates; this changes discovery priority, not scoring permissiveness.
  {
    const hasType = (t) => types.includes(t);
    const needSet = needs.map((n) => n.toLowerCase());
    const needSignal = (re) => needSet.some((n) => re.test(n));

    setFamily('program_family');
    const communityDevelopment =
      hasType('nonprofit') && needSignal(/housing development|community facilit/);
    if (communityDevelopment) {
      if (state) add(core, `community development block grant ${state}`);
      if (state) add(core, `HOME CHDO affordable housing funding ${state}`);
      add(core, `CDFI Fund community development grants ${year}`);
    }

    const publicHousing = hasType('government') && needSignal(/housing|housing development/);
    if (publicHousing) {
      add(core, `HUD Public Housing Capital Fund ${year}`);
      add(core, `HUD Choice Neighborhoods grants ${year}`);
      add(core, `HUD ROSS resident services funding ${year}`);
    }

    const workforceOrganization =
      (hasType('nonprofit') || hasType('government')) && needSignal(/workforce|employment/);
    if (workforceOrganization) {
      if (state) add(core, `WIOA workforce development funding ${state}`);
      add(core, `Department of Labor apprenticeship grants ${year}`);
      add(core, `Employment and Training Administration funding opportunities ${year}`);
    }

    // Persistent Amy hyperlocal misses need an entity-class query, not another
    // generic "grants for organization" variant. Put these ahead of the shared
    // core so they survive the live query cap. They only widen discovery; every
    // result still passes the normal reality, eligibility, and match gates.
    setFamily('precision_hyperlocal');
    const local = county || geo || state;
    if (local && hasType('business') && !hasType('farm')) {
      add(core, `small business economic development grants ${local}`);
    }
    if (local && hasType('nonprofit') && !hasType('school')) {
      add(core, `nonprofit capacity building grants ${local}`);
    }
    if (local && hasType('school') && hasType('government')) {
      // Keyed to the DECLARED need: a transportation department was searching
      // "STEM literacy" because the wording was fixed (hyperlocal-8). The
      // Amy-learned STEM literacy phrasing stays for the generic education
      // need and for type-defaulted needs.
      const districtNeed = needsDefaulted ? null : needs.find((n) => !/^(education|programs|operations|capital|equipment)$/.test(n));
      if (districtNeed) {
        const phrase = districtNeed.replace(/^school /, '');
        add(core, `school district ${phrase} grants ${local}`, { need: districtNeed });
      } else {
        add(core, `school district STEM literacy grants ${local}`);
      }
    }
    if (local && hasType('school') && !hasType('government') && (isHigherEd || needSignal(/research|higher education|student access|trio/))) {
      add(core, `higher education research student access grants ${local}`);
    }
  }

  // ── CORE (always emitted, highest signal) ──
  // Institution-specific funding FIRST — endowed / departmental / foundation
  // scholarships are findable ONLY by the school's name; no geo/type/need query
  // can reach them. This is the single biggest recall gap for a named student.
  setFamily('institution');
  if (isStudent) {
    schools.forEach((school, i) => {
      // Exact-name query defeats generic scholarship SERP drift while the
      // existing unquoted form preserves broad recall.
      add(core, `"${school}" scholarships`);
      for (const alias of schoolPublicationAliases(school)) {
        add(core, `"${alias}" scholarships`);
        if (i === 0) add(extra, `"${alias}" financial aid scholarships`);
      }
      add(core, `${school} scholarships`);
      if (i === 0) add(extra, `"${school}" financial aid scholarships`);
      // Departmental / field-of-study endowment at the primary institution.
      if (i === 0 && field) add(core, `${school} ${field} scholarship`);
      // The university FOUNDATION is where most named endowments live.
      if (i === 0) add(core, `${school} foundation scholarships`);
      // ENDOWED awards are catalogued separately from general scholarships on
      // most university sites — the word "endowed" is the phrase that reaches them.
      if (i === 0) add(core, `${school} endowed scholarships`);
    });
    // The student's STATE aid programs (HOPE, TSAA, Promise, Cal Grant…) are
    // their largest single non-federal source and have no API. For a
    // school-bearing profile the query is emitted HERE, directly after the
    // institution block: the late-core slot it also holds (below) sits PAST
    // the live cap for a query-rich two-school profile — measured 2026-08-02,
    // `TN state scholarship programs` was position 15 of a 14-slot budget,
    // truncated on every run: the exact fate its own comment says it was moved
    // out of the EXTRA pool to prevent, recreated one level up by CORE growth.
    // A schoolless student's core is far under the cap, so the original late
    // slot still serves them (the global `seen` dedup collapses the pair).
    setFamily('student_state_aid');
    if (schools.length > 0 && state) {
      add(core, isTerritory ? `${state} scholarship programs` : `${state} state scholarship programs`);
    }
    // Field-of-study scholarships (major), independent of any one school.
    setFamily('field_of_study');
    if (field) add(core, `${field} scholarships ${year}`);
  }
  // Employer education programs (tuition assistance / employer scholarships) —
  // a real funding class for a working applicant, reachable only by employer name.
  setFamily('employer');
  if (employer) {
    add(core, `${employer} scholarship`);
    add(core, `${employer} tuition assistance`);
  }
  // The two strongest need-specific searches.
  setFamily('need_geo');
  for (const need of needs.slice(0, 2)) add(core, `${need} grants for ${word} ${geo}`, { need });
  // The profile's OWN declared study topics, strongest evidence first
  // (`config/profileDerivedFacts.js`: intended major, then declared education
  // interests, then curated programs/services topics).
  //
  // THESE MUST BE CORE. The interest-keyed queries below live in the ROTATED
  // EXTRA pool, and the final cap truncates from the END — a student with two
  // schools builds 8+ CORE queries before the first topical one, so on the
  // live cap (maxQueries 14) not a single interest query ever ran. Measured on
  // Demo Tennessee STEM Student 2026-08-02: all 14 executed queries were school/geo CORE,
  // zero topical. Two slots is the bound — enough to reach the declared major
  // and its nearest declared neighbour, small enough that the school and
  // county queries #1089/#886 fought for are never displaced. Placed AFTER the
  // need-specific pair: at a starvation-level budget (max 2–3) the need+geo
  // queries are the ones that serve ANY profile, and a topical query must not
  // consume the whole run (the pre-2026-08-02 order put topical first and a
  // max-2 run searched nothing but the two interests).
  setFamily('interest');
  if (isStudent) {
    for (const term of interests.slice(0, 2)) add(core, `${term} scholarships ${year}`);
  }
  // What the profile qualifies for BY HISTORY OR ORIGIN (owner rule
  // 2026-09-07): the high school it graduated from, the college it left, its
  // heritage, its birthplace. `config/temporalRelatability.originSearchTerms`
  // phrases these as ready queries ("<school> alumni scholarship", "<heritage>
  // heritage scholarship"). Two are CORE for the same reason the declared
  // major is; the rest rotate through EXTRA.
  setFamily('origin');
  const originTerms = (Array.isArray(thesis.origin_terms) ? thesis.origin_terms : [])
    .map((t) => String(t ?? '').trim())
    .filter((t) => t.length > 6 && t.length < 80);
  originTerms.forEach((term, i) => add(i < 2 ? core : extra, term));
  // Hyperlocal, COUNTY-level awards (community foundations, county scholarships,
  // local civic clubs) — keyed to the county, which the city phrase never reaches.
  setFamily('county');
  if (county) {
    add(core, isStudent ? `scholarships ${county}` : `grants for ${word} ${county}`);
    add(core, `community foundation ${county}`);
    // A K-12 school's education foundation is ITS county-level funder; it used
    // to be emitted from the institution lane at position 9-10 of 28 — inside
    // the query budget, outside the ~6-query page budget (hyperlocal-5).
    if (types.includes('school') && !isStudent) add(core, `${county} education foundation`);
  }
  // 25-mile-radius towns (nearest first). The nearest neighbor is CORE — "local"
  // means the radius, not just the profile's own mailing city; the rest broaden
  // via the rotated EXTRA pool. An organization states GRANT intent; the
  // "assistance programs" phrasing is the individual safety-net search and was
  // occupying an org's CORE slot with the wrong intent (hyperlocal-6).
  setFamily('nearby_town');
  nearby.forEach((town, i) => {
    const q = isStudent ? `scholarships ${town}` : (isOrgProfile ? `${word} grants ${town}` : `${word} assistance programs ${town}`);
    if (i === 0) {
      add(core, q);
      add(core, `community foundation ${town}`);
    } else {
      add(extra, q);
      add(extra, `community foundation grants ${town}`);
    }
  });
  // Geo + type funding, current cycle (orgs/individuals; a student's best geo
  // query is the scholarship one below, so skip the weak "student grants" phrase).
  setFamily('geo_type');
  if (geo && !isStudent) add(core, `${word} grants ${geo} ${year}`);
  // Community/place-based philanthropy (where most local money lives).
  setFamily('community_foundation');
  if (geo) add(core, `community foundation grants ${geo}`);
  // Puerto Rico: much of the territorial/municipal assistance surface is
  // published in Spanish only — an English-only query set structurally
  // misses it. One core + one broadening Spanish query.
  setFamily('territory_language');
  if (stateCode === 'PR') {
    add(core, `programas de ayuda ${geo || 'Puerto Rico'}`);
    add(extra, `subvenciones y ayudas ${geo || 'Puerto Rico'}`);
  }
  // Students: the single best scholarship query is core (federal APIs skip them).
  setFamily('student_scholarship');
  if (isStudent) add(core, `scholarships for students ${geo} ${year}`);
  // State aid programs (HOPE, TSAA, Promise, Cal Grant...) have no API and are a
  // student's largest single non-federal source — CORE, never rotated out (was
  // in the rotated EXTRA pool, so runs under the query cap could drop it).
  setFamily('student_state_aid');
  if (isStudent && state) add(core, isTerritory ? `${state} scholarship programs` : `${state} state scholarship programs`);
  // Hyperlocal scholarship ENTITIES (2026-07-06, hyperlocal_recall_miss fix):
  // county education foundations, civic clubs (Rotary/Lions/Elks), Dollars for
  // Scholars chapters, and local churches run most small-town scholarships, and
  // no geo/need phrase reaches their pages — the ENTITY name is the search
  // term. County education foundation is CORE (the single best hyperlocal
  // scholarship source); the clubs broaden via the rotated EXTRA pool. Every
  // place-keyed template needs a place: with no location they degraded to
  // unanchored national noise ("Rotary Club scholarship") that occupied
  // rotating slots (webq-8).
  setFamily('student_entity');
  if (isStudent) {
    if (county) add(core, `${county} education foundation scholarships`);
    if (county || geo) add(extra, `Rotary Club scholarship ${county || geo}`);
    if (geo) add(extra, `Lions Club scholarship ${geo}`);
    if (state) add(extra, `Dollars for Scholars ${state}`);
    if (geo) add(extra, `church scholarships ${geo}`);
    if (geo) add(extra, `${geo} school district education foundation`);
  }
  // Research-org lane (the Axiom BioLabs archetype, 2026-07-06): SBIR/STTR and
  // state innovation matching funds are a biotech/R&D org's PRIMARY funding
  // universe, and no generic org query ever reaches them (the catalog held
  // ZERO SBIR-class rows). Keyed to the org's top interest term so a genomics
  // shop and an ag-tech shop search different solicitations.
  setFamily('research_org');
  if (thesis.is_research_org) {
    // Topic comes from the thesis's extracted research field, falling back to
    // the first interest that LOOKS research-shaped — never blind interests[0]
    // (tag ordering once made the query "SBIR STTR designated solicitation").
    const RESEARCH_SHAPED = /biotech|genomic|bioinformat|genetic|life scien|biomedical|pharma|bioscience|research/i;
    const topic = thesis.research_topic
      || interests.find((t) => RESEARCH_SHAPED.test(t))
      || 'biotechnology';
    add(core, `SBIR STTR ${topic} solicitation ${year}`);
    add(core, `${topic} research grants small business ${year}`);
    if (state) add(core, `${state} SBIR matching funds program`);
    // Per-interest SBIR breadth — research-shaped terms ONLY, so a stray
    // bookkeeping tag can never become a solicitation search.
    for (const term of interests.filter((t) => t !== topic && RESEARCH_SHAPED.test(t)).slice(0, 3)) {
      add(extra, `SBIR ${term} funding opportunity`);
    }
    add(extra, `NIH SBIR ${topic} ${year}`);
    add(extra, `NSF SBIR ${topic}`);
  }

  // ── EXTRA (broadening pool, rotated by seed) ──
  // Remaining needs + an alternate phrasing for each need.
  setFamily('need_breadth');
  for (const need of needs.slice(2)) add(extra, `${need} grants for ${word} ${geo}`, { need });
  for (const need of needs) add(extra, `${need} assistance program ${geo}`, { need });
  // Alternate geo phrasings so a run reaches pages the core phrasing misses.
  setFamily('geo_breadth');
  if (geo) {
    add(extra, `local grants ${word} ${geo}`);
    add(extra, `${word} funding opportunities ${geo} ${year}`);
  }
  // National fallback keyed to each need (also covers no-geo profiles).
  setFamily('need_national');
  for (const need of needs) add(extra, `${need} grant funding ${word}`, { need });

  // Student-specific scholarship breadth.
  if (isStudent) {
    setFamily('student_breadth');
    if (geo) add(extra, `need-based scholarships ${geo}`);
    add(extra, `merit scholarships ${geo} ${year}`);
    if (geo) add(extra, `local scholarships ${geo}`);
    if (geo) add(extra, `${geo} college grants for students`);
    if (geo) add(extra, `community foundation scholarships ${geo}`);
    // Field-of-study / career-goal keyed scholarships.
    setFamily('interest_breadth');
    for (const term of interests) {
      if (geo) add(extra, `${term} scholarships ${geo}`);
      add(extra, `${term} scholarships ${year}`);
    }
  } else {
    // Non-student interest/keyword-keyed grant searches.
    setFamily('interest_breadth');
    for (const term of interests) add(extra, `${term} grants for ${word} ${geo}`);
  }

  // Signals shared by the person lanes. FRAGMENT-SAFE HAYSTACK (#1086, the
  // fabricated-phrase class). `thesis.keywords` is the undifferentiated signal
  // bag — CLAUDE.md measures 453 INDEPENDENT entries for one real profile.
  // Joining them with a BARE SPACE made the boundary between two members
  // indistinguishable from a space inside a real phrase, so adjacent members
  // spelled phrases no profile ever stated: `family` + `violence` fabricated
  // "family violence" and fired the domestic-violence lane (a CORE slot) for
  // any family profile. A pipe is not a word character, so every phrase INSIDE
  // one keyword still matches; only boundary-spanning matches are removed.
  const kw = (Array.isArray(thesis.keywords) ? thesis.keywords : []).join(' | ').toLowerCase();
  const needSetLower = needs.map((n) => n.toLowerCase());
  const signal = (re) => re.test(kw) || needSetLower.some((n) => re.test(n));
  // The need the safety-net ENTITY queries are phrased around: the first
  // declared crisis need, never a scholarship/disability token.
  const crisisNeed = needs.find((n) => CRISIS_NEED_RX.test(n)) || needs[0] || 'emergency';

  // ── Individual / benefit-need breadth (NON-students) ──
  // Students get a rich, scholarship-specific query set above. Individuals and
  // families seeking assistance (disability, senior, housing, food, energy,
  // medical, caregiver) were previously served by only 1-2 generic "need grants"
  // phrases — the single biggest recall gap for real people. People in need
  // qualify for PROGRAMS/BENEFITS/referral services (benefits.gov, 211, Area
  // Agencies on Aging, state HHS, community action, vocational rehab), not
  // competitive "grants", so emit the searches that actually reach them.
  // Org profiles skip this lane (see isOrgProfile above) — they get the
  // institution entity lane instead.
  if (!isStudent && !isOrgProfile) {
    // Universal safety-net locators — apply to ANY low-income individual, so they
    // surface even for a sparse profile (the Kathy-class empty profile).
    setFamily('safety_net_locator');
    if (state || geo) {
      add(core, `benefits.gov ${state || geo}`);
      add(core, `211 community resources ${state || geo}`);
      add(extra, `community action agency ${county || geo || state}`);
    }
    // ── THE PROFILE'S OWN FACTS BECOME SEARCHES (owner order 2026-09-08) ────
    // These channels reached the thesis and no query ever read them, so a
    // profile's occupation, income band, rural status, licensure, immigration
    // status and first-generation status could not find a single source. The
    // richest profile-to-query mapping in the repo (services/crawlers/
    // queryPlanner.profileSignalTerms) has NO runtime importer at all — this
    // ports its highest-value terms onto the live path.
    //
    // CORE, not EXTRA: `.slice(0, max)` truncates from the END and the live
    // route passes a small max, so an EXTRA query is one that never runs.
    // Each is guarded by a POSITIVE structured flag — silence adds nothing.
    setFamily('profile_fact');
    for (const job of (thesis.occupation ?? []).slice(0, 2)) {
      add(core, `${String(job).replace(/_/g, ' ')} assistance programs ${state || geo}`);
      add(extra, `grants for ${String(job).replace(/_/g, ' ')} ${state || geo}`);
    }
    for (const tag of (thesis.geographic ?? []).slice(0, 2)) {
      // rural / appalachian / tribal / frontier / urban_underserved
      add(core, `${String(tag).replace(/_/g, ' ')} assistance grants ${state || geo}`);
    }
    for (const status of (thesis.immigration ?? []).slice(0, 1)) {
      add(core, `${String(status).replace(/_/g, ' ')} assistance programs ${state || geo}`);
    }
    if (thesis.is_licensed_professional === true) {
      for (const cred of (thesis.credentials ?? []).slice(0, 1)) {
        add(extra, `${String(cred).replace(/_/g, ' ')} professional assistance fund`);
      }
    }
    {
      const fin = thesis.financial ?? {};
      const income = Number(fin.householdIncome);
      const size = Number(fin.householdSize);
      // A stated LOW income is what unlocks means-tested programs; a high one
      // states nothing useful, so only the low end becomes a query.
      if (Number.isFinite(income) && income > 0 && income < 60000) {
        add(core, `low income assistance programs ${state || geo}`);
        if (Number.isFinite(size) && size > 0) {
          add(extra, `household of ${size} income eligibility assistance ${state || geo}`);
        }
      }
      if (String(fin.needLevel ?? '').toLowerCase() === 'urgent') {
        add(core, `emergency financial assistance ${county || state || geo}`);
      }
    }
    {
      const edu = thesis.education_profile ?? {};
      if (edu.firstGeneration === true) add(core, `first generation student scholarships ${state || geo}`);
      if (edu.returningAdult === true) add(extra, `adult learner returning student grants ${state || geo}`);
      if (edu.gedGraduate === true) add(extra, `GED graduate scholarships ${state || geo}`);
      if (edu.jobRetraining === true) add(core, `job retraining workforce grants ${state || geo}`);
    }
    {
      const ac = thesis.academics ?? {};
      const gpa = Number(ac.gpa);
      if (Number.isFinite(gpa) && gpa >= 3.5) add(extra, `merit scholarships GPA ${gpa} ${state || geo}`);
    }

    // Per-need ASSISTANCE PROGRAMS (distinct from the "need grants" phrase above).
    setFamily('need_assistance');
    for (const need of needs.slice(0, 3)) {
      add(core, `${need} assistance programs ${state || geo}`, { need });
      if (county) add(extra, `local ${need} support services ${county}`, { need });
    }
    // State benefit programs by name (where individuals actually apply).
    setFamily('state_benefit');
    if (state) {
      add(extra, `${state} emergency assistance program`);
      add(extra, `${state} LIHEAP energy assistance`);
      add(extra, `${state} Medicaid application`);
      add(extra, `${state} SNAP food assistance`);
    }
    // Senior-specific safety net.
    // LEFT word boundary on every alternative below (#937 substring-floor class).
    // These are deliberately STEMS (`utilit` -> utility/utilities, `disab` ->
    // disability/disabled, `caregiv` -> caregiver/caregiving), so a TRAILING \b
    // would break them — but with no LEADING one they matched inside unrelated
    // words and spent CORE query slots the profile never earned. Measured against
    // the live regexes: `aging` fires on "managing"/"packaging"/"engaging";
    // `rent` on "parent"/"current"/"different"; `food` on "seafood"; `medical` on
    // "biomedical"; `heating` on "cheating". A family profile carrying the
    // keyword "parent" therefore triggered the crisis safety-net lane, and at the
    // live cap (maxQueries 14) each mis-fired CORE slot DISPLACES a real
    // school/county/topical query — recall loss, not just noise.
    setFamily('senior');
    if (signal(/\bsenior|\baging|\belder|\b6[25]\+|\bolder adult/)) {
      if (state) add(core, `Area Agency on Aging ${state}`);
      if (county || geo) add(extra, `senior services ${county || geo}`);
      if (geo) add(extra, `Meals on Wheels ${geo}`);
      add(extra, `senior housing assistance ${state || geo}`);
    }
    // Disability-specific.
    setFamily('disability');
    if (signal(/\bdisab|\bblind|\bdeaf|\bwheelchair|\badaptive|\bassistive|\bmobility/)) {
      if (state) add(core, `${state} vocational rehabilitation services`);
      add(extra, `disability assistance grants ${state || geo}`);
      add(extra, `assistive technology funding ${state || geo}`);
      if (geo) add(extra, `disability employment support ${geo}`);
    }
    // Caregiver-specific.
    setFamily('caregiver');
    if (signal(/\bcaregiv|\brespite|\bkinship|\bfoster/)) {
      if (state) add(core, `caregiver support program ${state}`);
      if (geo) add(extra, `respite care assistance ${geo}`);
    }
    // Hyperlocal safety-net ENTITIES (2026-07-06, hyperlocal_recall_miss fix).
    // A profile with an immediate-need signal (rent, food, utilities, medical,
    // transport, emergency) must NOT stop at state/national programs: churches,
    // county emergency funds, and utility assistance funds are where local help
    // actually lives, and only entity-phrased searches reach them.
    setFamily('safety_net_entity');
    const safetyNet = signal(CRISIS_NEED_RX);
    if (safetyNet && (geo || county)) {
      // "churches that help with X near Y" is the real-world search phrasing
      // that surfaces congregation assistance ministries.
      add(core, `churches that help with ${crisisNeed} ${geo || county}`, { need: crisisNeed });
      add(core, `${county || geo} emergency assistance fund`);
      add(extra, `Salvation Army assistance ${geo || county}`);
      if (geo) add(extra, `St Vincent de Paul assistance ${geo}`);
      add(extra, `church assistance programs ${county || geo}`);
    }
    setFamily('utility');
    if (signal(/\benergy|\butilit|\belectric|\bheating/) && (geo || state)) {
      add(extra, `utility bill assistance ${geo || state}`);
      if (state) add(extra, `${state} weatherization assistance program`);
    }
    setFamily('food');
    if (signal(/\bfood|\bnutrition|\bgrocer/) && (county || geo)) {
      add(extra, `food pantry ${county || geo}`);
    }
    setFamily('housing');
    if (signal(/\bhousing|\brent|\bhomeless/) && (county || geo)) {
      add(extra, `housing assistance programs ${county || geo}`);
    }
    setFamily('transportation');
    if (signal(/\btransport/) && (county || geo)) {
      add(extra, `transportation assistance ${county || geo}`);
    }
    // Employment/workforce → the local workforce board / American Job Center.
    setFamily('workforce');
    if (signal(/\bemploy|\bworkforce|\bjob|\bcareer/) && (county || state)) {
      add(extra, `workforce development board ${county || state}`);
      add(extra, `American Job Center ${geo || state}`);
    }
    // Domestic-violence survivor lane (relevance_precision archetype fix):
    // victim services are county/state-programmatic, never generic "grants".
    setFamily('domestic_violence');
    if (signal(/\bdomestic violence|\bfamily violence|\babuse|\bvictim/)) {
      if (county || geo || state) add(core, `domestic violence assistance ${county || geo || state}`);
      if (state) add(extra, `crime victim compensation ${state}`);
      if (geo || state) add(extra, `domestic violence shelter services ${geo || state}`);
    }
  }

  // ── Students with a DECLARED crisis need (hyperlocal-9) ──
  // A high-school or college student who declares housing / utilities / food /
  // medical / transport needs qualifies for the same local safety-net ENTITIES
  // (churches, county emergency funds, utility funds, food pantries) as any
  // resident — but was excluded from the whole lane above. Additive and in the
  // rotated pool only: scholarship CORE is never displaced, and the individual
  // benefit LOCATORS (benefits.gov / 211 / AAA / voc-rehab) stay out of the
  // student lane by design.
  if (isStudent && !isOrgProfile && signal(CRISIS_NEED_RX) && (geo || county)) {
    setFamily('safety_net_entity');
    add(extra, `churches that help with ${crisisNeed} ${geo || county}`, { need: crisisNeed });
    add(extra, `${county || geo} emergency assistance fund`);
    setFamily('utility');
    if (signal(/\benergy|\butilit|\belectric|\bheating/) && (geo || state)) add(extra, `utility bill assistance ${geo || state}`);
    setFamily('food');
    if (signal(/\bfood|\bnutrition|\bgrocer/)) add(extra, `food pantry ${county || geo}`);
    setFamily('housing');
    if (signal(/\bhousing|\brent|\bhomeless/)) add(extra, `housing assistance programs ${county || geo}`);
  }

  // ── Institution / org-type entity lane (2026-07-06, institution_recall_miss
  // fix). An organization's real funding universe is keyed to its INSTITUTION
  // CLASS (fire grants for a VFD, CDBG for a CDC, HRSA for a clinic, OVW for a
  // DV shelter, USDA co-op programs for an agricultural cooperative) — generic
  // "${word} grants ${geo}" phrasing structurally cannot reach these programs.
  {
    const has = (t) => types.includes(t);
    const needSet = needs.map((n) => n.toLowerCase());
    const needSignal = (re) => needSet.some((n) => re.test(n));

    setFamily('vfd');
    if (has('vfd')) {
      // Fire/EMS: AFG is the sector's primary program; state fire grants next.
      add(core, `Assistance to Firefighters Grant ${year}`);
      if (state) add(extra, `${state} fire department grants`);
      add(extra, `volunteer fire department equipment grants`);
      add(extra, `EMS equipment grants ${state || year}`);
      add(extra, `Firehouse Subs Public Safety Foundation grant`);
    }
    setFamily('government');
    if (has('government') && !has('vfd') && !has('law_enforcement')) {
      if (state) add(extra, `USDA community facilities grant ${state}`);
      if (state) add(extra, `${state} municipal grants ${year}`);
      if (state) add(extra, `community development block grant ${state}`);
    }
    setFamily('nonprofit_program');
    if (has('nonprofit')) {
      // CDC / housing & economic development orgs.
      if (needSignal(/housing development|economic development|community facilit|community development/)) {
        if (state) add(core, `community development block grant ${state}`);
        add(extra, `CDFI Fund grant programs`);
        if (state) add(extra, `HOME CHDO funding ${state}`);
        if (state) add(extra, `Federal Home Loan Bank affordable housing program ${state}`);
      }
      // DV shelters / victim-services orgs.
      if (needSignal(/domestic violence|victim/)) {
        if (state) add(core, `domestic violence shelter grants ${state}`);
        add(extra, `OVW grant programs ${year}`);
        add(extra, `Family Violence Prevention and Services grants`);
        if (state) add(extra, `VOCA victim assistance funding ${state}`);
      }
      // Disability service providers.
      if (needSignal(/disab/)) {
        if (state) add(extra, `developmental disabilities council grants ${state}`);
        if (state) add(extra, `disability services provider grants ${state}`);
      }
      // Workforce boards / job-training orgs.
      if (needSignal(/workforce|employment/)) {
        if (state) add(extra, `WIOA workforce development funding ${state}`);
      }
      // Hospitals / clinics / health centers.
      if (needSignal(/medical|health/) && (has('government') || needSignal(/equipment|capital|operations/))) {
        if (state) add(core, `rural health grants ${state}`);
        add(extra, `HRSA funding opportunities ${year}`);
        if (state) add(extra, `rural health clinic funding ${state}`);
      }
      // Libraries / museums.
      if (needSignal(/library/)) {
        add(extra, `IMLS grants for libraries ${year}`);
        if (state) add(extra, `${state} library grants`);
      }
      // Local private foundations fund nonprofits by place; only the learned
      // hyperlocal gap used to reach them.
      if (county || geo) add(extra, `private foundation grants for ${word} ${county || geo}`);
    }
    setFamily('church');
    if (has('church') || has('ministry')) {
      add(extra, `grants for churches ${year}`);
      if (state) add(extra, `faith-based organization grants ${state}`);
      add(extra, `church building grants`);
    }
    setFamily('school');
    if (has('school') && !isStudent) {
      // `${county} education foundation` is emitted in the county block above.
      if (!county && geo) add(core, `${geo} school district education foundation grants`);
      else if (geo) add(extra, `${geo} school district education foundation grants`);
      if (state) add(extra, `${state} education grants for schools ${year}`);
      if (isHigherEd) {
        if (state) add(extra, `${state} higher education institutional grants ${year}`);
      } else {
        add(extra, `teacher classroom grants ${year}`);
      }
    }
    setFamily('farm');
    if (has('farm')) {
      if (state) add(core, `USDA rural development grants ${state}`);
      // Agricultural cooperatives (relevance_precision archetype fix).
      if (has('business') || needSignal(/economic development|cooperative/)) {
        add(extra, `USDA value-added producer grant ${year}`);
        add(extra, `USDA rural cooperative development grant`);
      }
      if (state) add(extra, `${state} department of agriculture grants ${year}`);
      if (state) add(extra, `Farm Service Agency programs ${state}`);
    }
    setFamily('business');
    if (has('business') && !has('farm')) {
      if (county || geo) add(extra, `chamber of commerce small business grants ${county || geo}`);
      if (state) add(extra, `${state} small business grant programs ${year}`);
      // The local SBDC / economic-development office is a small business's
      // front door; only the learned hyperlocal gap used to reach it.
      if (county || geo || state) add(extra, `small business development center ${county || geo || state}`);
    }
    // County extension office: the local front door for both farm and family
    // programs — relevant to ag profiles and to rural family/individual needs.
    setFamily('extension');
    if ((has('farm') || needSignal(/agricultur/)) && county) {
      add(extra, `${county} extension office programs`);
    }
  }

  // ── Closed-loop gap targeting ───────────────────────────────────────────────
  // If a PRIOR crawl learned a coverage gap for this profile (recorded by
  // liveCrawlGapLearning into Anya's brain, attached to the thesis by
  // buildThesisForProfile), steer THIS run to fill it — so the crawlers evolve
  // from what they learn instead of repeating the same misses.
  // These land in `forced`, which is emitted FIRST: a rich student profile
  // already builds 15+ CORE queries, and the final `.slice(0, max)` truncates
  // from the END — so gap-steering queries appended to core were exactly the
  // ones a query-rich profile dropped, and the closed loop silently never
  // closed (found 2026-07-27 while tracing institution_recall_miss ×12).
  // The `seen` dedup still applies: a school query core already emits (within
  // the cap at its normal position) is not re-added here.
  const forced = [];
  // PROMOTE a gap-steering query into `forced`, moving it out of the truncatable
  // `extra` pool if it is already there.
  //
  // THE TRAP, one level below the one the comment above describes. `add`'s
  // `seen` set is GLOBAL across the three lists, so a query the ordinary
  // broadening pool already emitted is SILENTLY DISCARDED when a gap branch
  // tries to force it — and it stays in `extra`, where the final
  // `.slice(0, max)` cuts it. The need-national loop above already adds
  // `<need> grant funding <word>` to `extra` for every need, which is verbatim
  // what the `low_results` branch below "forces": moving that branch to
  // `forced` alone changed NOTHING, because `add` refused every one of its
  // queries as a duplicate. The institution branch escaped this only by
  // accident — its quoted `"<school>" scholarships` form differs from anything
  // core emits.
  //
  // It does NOT remove the query from `extra`. `extra` is rotated by `seed`
  // before the cut, so shortening it shifts the rotation and silently drops a
  // DIFFERENT baseline query — additivity ("every query a gap-free run emits is
  // still emitted") is a contract `amyArchetypeLearning.test.js` pins. The
  // duplicate is collapsed at final assembly instead, where the earlier
  // (forced) copy wins and the pool's order is untouched.
  const force = (q, meta) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (s.length <= 6) return;
    const k = normalizeQueryKey(s);
    if (!k || forced.some((f) => normalizeQueryKey(f.query) === k)) return;
    const existing = core.find((e) => normalizeQueryKey(e.query) === k) || extra.find((e) => normalizeQueryKey(e.query) === k);
    if (existing) {
      forced.push({ ...existing, family: meta.family ?? currentFamily, gap_class: meta.gap_class, need: meta.need ?? existing.need, origin: 'forced' });
      return;
    }
    add(forced, s, meta);
  };
  const learned = thesis.learned_gaps || null;
  if (learned) {
    const classes = Array.isArray(learned.classes) ? learned.classes : [];
    const missingSchools = (Array.isArray(learned.missing_schools) ? learned.missing_schools : [])
      .map(cleanInstitution).filter(Boolean);
    // institution_gap → force the still-missing school names (endowed / foundation
    // scholarships are reachable ONLY by the institution's name).
    setFamily('learned_institution');
    if (classes.includes('institution_gap') || missingSchools.length) {
      const gap = { gap_class: 'institution_gap' };
      for (const s of missingSchools.slice(0, 3)) {
        force(`${s} scholarships`, gap);
        force(`"${s}" scholarships`, gap);
        for (const alias of schoolPublicationAliases(s)) {
          force(`"${alias}" scholarships`, gap);
          add(extra, `"${alias}" financial aid scholarships`);
        }
        force(`${s} foundation scholarships`, gap);
        add(extra, `"${s}" financial aid scholarships`);
      }
    }
    // hyperlocal_gap → re-emit county-scoped queries even if a prior run tried
    // them, AND escalate to the hyperlocal entity classes (education foundation
    // / churches / civic clubs) that plain county phrasing misses.
    // City-only profiles used to ignore the learned gap entirely. An org must
    // also retain its applicant intent: household/church emergency assistance
    // is not a useful escalation for a business, nonprofit, or university.
    setFamily('learned_hyperlocal');
    const hyperlocal = county || (thesis.location?.city ? geo : '');
    if (classes.includes('hyperlocal_gap') && hyperlocal) {
      const gap = { gap_class: 'hyperlocal_gap' };
      if (isStudent) {
        force(`local scholarships ${hyperlocal}`, gap);
        force(`${hyperlocal} education foundation scholarships`, gap);
        add(extra, `Rotary Club scholarship ${hyperlocal}`);
      } else if (isOrgProfile) {
        force(`${word} grants application ${hyperlocal}`, gap);
        force(`community foundation grants for ${word} ${hyperlocal}`, gap);
        if (types.includes('business')) add(extra, `small business development center funding ${hyperlocal}`);
        if (types.includes('nonprofit')) add(extra, `private foundation nonprofit grants ${hyperlocal}`);
        if (types.includes('school')) add(extra, `education foundation institutional grants ${hyperlocal}`);
      } else {
        force(`local assistance programs ${hyperlocal}`, gap);
        force(`${hyperlocal} emergency assistance fund`, gap);
        add(extra, `church assistance programs ${hyperlocal}`);
      }
      add(extra, `community foundation grants ${hyperlocal}`);
    }
    // low_results → broaden with national + state fallbacks keyed to the needs.
    //
    // These land in `forced`, NOT `extra`. The comment 30 lines up records that
    // gap-steering queries appended to a truncatable bucket "silently never
    // closed" the loop for a query-rich profile — and this branch was left in
    // exactly that bucket. A rich profile builds 15+ core queries against a
    // default cap of 14, so `[...forced, ...core, ...rotate(extra)].slice(0, max)`
    // dropped every broadening query this branch has ever produced. The
    // "too few results ⇒ search wider" hook existed and could not fire.
    setFamily('learned_low_results');
    if (classes.includes('low_results')) {
      const gap = { gap_class: 'low_results' };
      for (const need of needs.slice(0, 3)) force(`${need} grant funding ${word}`, { ...gap, need });
      if (state) force(isStudent
        ? `${state} scholarship financial aid programs`
        : (isOrgProfile ? `${state} grant programs for ${word}` : `${state} assistance programs`), gap);
    }
    // result_floor_shortfall → the profile is BELOW ITS REQUESTED RESULT NUMBER
    // on rows that name money it could actually receive (pointers excluded).
    // Escalate the SEARCH, never the admission: broader geography (national and
    // the region above the state) and adjacent need phrasing. Every hit still
    // faces the full fetch → extract → reality gate → match engine stack, so
    // this can only change WHAT IS LOOKED FOR, never what is let through.
    setFamily('learned_floor');
    if (classes.includes('result_floor_shortfall')) {
      const gap = { gap_class: 'result_floor_shortfall' };
      for (const need of needs.slice(0, 3)) {
        force(`national ${need} ${isOrgProfile ? 'grants' : 'assistance'} programs ${year}`, { ...gap, need });
        add(extra, `${need} fund application ${word} ${year}`, { need });
      }
      for (const term of interests.slice(0, 2)) add(extra, `${term} ${isStudent ? 'scholarship' : 'grant'} ${year}`);
      if (state) force(`${state} foundation grants ${word} ${year}`, gap);
      if (needs.length === 0) force(`${word} financial assistance programs ${year}`, gap);
    }
  }

  // Last resort: a sparse profile still searches something useful.
  setFamily('fallback');
  if (forced.length === 0 && core.length === 0 && extra.length === 0) add(core, `grants for ${word} ${geo || year}`);

  // ── Assembly ──────────────────────────────────────────────────────────────
  // Deduplicate BEFORE rotating, then rotate the unselected pool exactly once.
  // Rotating EXTRA and then rotating the merged tail with the same seed can
  // visit only a subset of the candidates indefinitely (e.g. 23/35 searches
  // for a four-need individual), despite every nightly run claiming breadth.
  // Keep the highest-priority forced/core head fixed and guarantee each other
  // candidate a turn over one full seed cycle. Seed zero preserves ordering.
  const emitted = new Set();
  const unique = (list) => list.filter((e) => {
    const k = normalizeQueryKey(e.query);
    if (emitted.has(k)) return false;
    emitted.add(k);
    return true;
  });
  const priority = unique([...forced, ...core]);
  const broadening = unique(extra);
  const forcedCount = priority.filter((e) => e.gap_class !== null).length;

  // Anchors: learned-gap steering reserved at the head — shortfall profiles
  // only, bounded, and never at the expense of the one profile-own core slot.
  let anchorCount = 0;
  if (shortfall && forcedCount > 0) {
    anchorCount = max === 1 ? 0 : max === 2 ? 1 : Math.min(PERSISTENT_QUERY_ANCHOR_COUNT, forcedCount, max - 2);
  }
  const anchors = priority.slice(0, anchorCount);
  const afterAnchors = priority.slice(anchorCount);
  // The strongest profile-own query: under a shortfall the first non-steering
  // entry (the anchors already carry the steering); otherwise simply the
  // highest-priority entry — learned-gap queries lead a non-shortfall plan by
  // the module's long-standing contract (institution_gap ×12 trace).
  let coreIndex = afterAnchors.length ? 0 : -1;
  if (shortfall) {
    const own = afterAnchors.findIndex((e) => e.gap_class === null);
    if (own >= 0) coreIndex = own;
  }
  const core0 = coreIndex >= 0 ? afterAnchors[coreIndex] : null;
  const restPriority = afterAnchors.filter((_, i) => i !== coreIndex);
  const reservedFixed = anchors.length + (core0 ? 1 : 0);

  // How much of the budget stays fixed vs rotates.
  const rotatable = restPriority.length + broadening.length;
  const wantRotating = rotatable > 0 && (max >= 3 || (!shortfall && max === 2)) ? 1 : 0;
  let fixedCount;
  if (!shortfall) {
    fixedCount = Math.min(priority.length, Math.max(reservedFixed, max - wantRotating));
  } else {
    // A continuing shortfall must meaningfully explore: keep the highest-
    // priority half fixed and rotate the rest — but every learned-gap query
    // stays fixed (it is the steering the shortfall asked for) as long as at
    // least a quarter of the budget still rotates (webq-5).
    const fixedTarget = Math.max(Math.ceil(max / 2), forcedCount + 1);
    const fixedCap = max - Math.max(wantRotating, Math.floor(max / 4));
    fixedCount = Math.min(priority.length, Math.max(reservedFixed, Math.min(fixedTarget, fixedCap)));
  }
  fixedCount = Math.min(fixedCount, max);

  // Head composition with per-need / per-family share caps. Reserved slots
  // (anchors, strongest core) bypass the caps but count toward them; a fixed
  // entry the cap defers is still fixed — it moves behind the head.
  const headSize = Math.min(max, headWindow);
  const capFamily = Math.max(1, Math.ceil(headSize / 2));
  const capNeed = Math.max(1, Math.ceil(headSize / 3));
  const familyTally = new Map();
  const needTally = new Map();
  const tally = (e) => {
    familyTally.set(e.family, (familyTally.get(e.family) ?? 0) + 1);
    if (e.need) needTally.set(e.need, (needTally.get(e.need) ?? 0) + 1);
  };
  const withinCaps = (e) =>
    (familyTally.get(e.family) ?? 0) < capFamily && (!e.need || (needTally.get(e.need) ?? 0) < capNeed);
  const headReserved = [...anchors, ...(core0 ? [core0] : [])];
  headReserved.forEach(tally);
  const breadthInHead = wantRotating && broadening.length + Math.max(0, priority.length - fixedCount) > 0 ? 1 : 0;
  const headFillSlots = Math.max(0, Math.min(headSize - headReserved.length - breadthInHead, fixedCount - reservedFixed));
  const headFills = [];
  const deferred = [];
  let scan = 0;
  for (; scan < restPriority.length && headFills.length < headFillSlots; scan += 1) {
    const e = restPriority[scan];
    if (withinCaps(e)) { headFills.push(e); tally(e); } else deferred.push(e);
  }
  // Not enough cap-respecting candidates: the head is still filled, in order.
  while (headFills.length < headFillSlots && deferred.length) headFills.push(deferred.shift());
  const fixedOrder = [...headReserved, ...headFills, ...deferred, ...restPriority.slice(scan)];
  const fixed = fixedOrder.slice(0, fixedCount);
  const overflow = fixedOrder.slice(fixedCount);
  const pool = [...overflow, ...broadening];
  const rotated = rotate(pool, seed);
  const rotatingBudget = Math.max(0, max - fixed.length);
  const selectedBreadth = rotated.slice(0, rotatingBudget);
  const droppedBreadth = rotated.slice(rotatingBudget);

  const label = (e, tier) => ({ query: e.query, tier, family: e.family, gap_class: e.gap_class, need: e.need });
  const tailFixed = fixed.slice(headReserved.length + headFills.length).map((e) => label(e, 'core'));
  let breadthQueue = selectedBreadth.map((e) => label(e, 'breadth'));
  const firstBreadth = breadthInHead && breadthQueue.length ? breadthQueue[0] : null;
  if (firstBreadth) breadthQueue = breadthQueue.slice(1);
  // The rotating slot sits IMMEDIATELY after the reserved slots, never at the
  // end of the head: a caller that can execute only the first two or three
  // built queries (six directive SERPs already queued, a thin window) must
  // still reach fresh ground. Under a shortfall it follows the anchors and
  // precedes the strongest core query — webLane's shortfall merge takes
  // builtQueries.slice(0, PERSISTENT_QUERY_ANCHOR_COUNT + 1) as "anchors +
  // first rotating slot"; without one it follows the strongest core query.
  const headEntries = shortfall
    ? [
        ...anchors.map((e) => label(e, 'anchor')),
        ...(firstBreadth ? [firstBreadth] : []),
        ...(core0 ? [label(core0, 'core')] : []),
        ...headFills.map((e) => label(e, 'core')),
      ]
    : [
        ...anchors.map((e) => label(e, 'anchor')),
        ...(core0 ? [label(core0, 'core')] : []),
        ...(firstBreadth ? [firstBreadth] : []),
        ...headFills.map((e) => label(e, 'core')),
      ];

  const entries = [...headEntries];
  if (!shortfall) {
    entries.push(...tailFixed, ...breadthQueue);
  } else {
    // The page queue can fill before the query budget does. Behind the head,
    // put one rotating query ahead of every two remaining fixed queries so a
    // thin-SERP run keeps exploring; the budget bounds both queues, so no
    // fixed query is ever cut for a rotating one.
    let p = 0;
    let b = 0;
    while (p < tailFixed.length || b < breadthQueue.length) {
      if (b < breadthQueue.length) entries.push(breadthQueue[b++]);
      for (let i = 0; i < 2 && p < tailFixed.length; i += 1) entries.push(tailFixed[p++]);
    }
  }

  const dropped_by_budget = droppedBreadth.map((e) => ({
    query: e.query,
    tier: e.origin === 'extra' ? 'breadth' : 'core',
    family: e.family,
  }));

  return {
    queries: entries.map((e) => e.query),
    entries,
    planned_total: entries.length,
    dropped_by_budget,
    dropped_duplicates,
    seed,
    max,
    shortfall,
    head_size: headSize,
  };
}

/**
 * buildWebQueries — the string-list view of buildWebQueryPlan (unchanged
 * contract for every existing caller).
 *
 * @param {object} thesis
 * @param {{ year?:number, max?:number, seed?:number }} [opts]
 * @returns {string[]}
 */
export function buildWebQueries(thesis = {}, opts = {}) {
  return buildWebQueryPlan(thesis, opts).queries;
}

export default {
  buildWebQueries,
  buildWebQueryPlan,
  normalizeQueryKey,
  countyPhrase,
  hasPersistentQueryShortfall,
  PERSISTENT_QUERY_ANCHOR_COUNT,
  WEB_QUERY_HEAD_WINDOW,
};
