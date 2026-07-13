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

// County-level phrase ("Bradley County, TN"). Hyperlocal awards (community
// foundations, county scholarships, local civic clubs) are keyed to the COUNTY,
// not the city — and the city phrase never reaches them. Territory and Alaska
// county-equivalents (municipio, municipality, census area) keep their own
// suffix — never "Ponce Municipio County".
function countyPhrase(location = {}) {
  let county = location?.county ? String(location.county).trim() : '';
  if (!county) return '';
  if (!/county|parish|borough|municipio|municipality|census area/i.test(county)) county = `${county} County`;
  const state = regionName(location?.state);
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
      // ENDOWED awards are catalogued separately from general scholarships on
      // most university sites — the word "endowed" is the phrase that reaches them.
      if (i === 0) add(core, `${school} endowed scholarships`);
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
  // 25-mile-radius towns (nearest first). The nearest neighbor is CORE — "local"
  // means the radius, not just the profile's own mailing city; the rest broaden
  // via the rotated EXTRA pool.
  nearby.forEach((town, i) => {
    const q = isStudent ? `scholarships ${town}` : `${word} assistance programs ${town}`;
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
  if (geo && !isStudent) add(core, `${word} grants ${geo} ${year}`);
  // Community/place-based philanthropy (where most local money lives).
  if (geo) add(core, `community foundation grants ${geo}`);
  // Puerto Rico: much of the territorial/municipal assistance surface is
  // published in Spanish only — an English-only query set structurally
  // misses it. One core + one broadening Spanish query.
  if (stateCode === 'PR') {
    add(core, `programas de ayuda ${geo || 'Puerto Rico'}`);
    add(extra, `subvenciones y ayudas ${geo || 'Puerto Rico'}`);
  }
  // Students: the single best scholarship query is core (federal APIs skip them).
  if (isStudent) add(core, `scholarships for students ${geo} ${year}`);
  // State aid programs (HOPE, TSAA, Promise, Cal Grant...) have no API and are a
  // student's largest single non-federal source — CORE, never rotated out (was
  // in the rotated EXTRA pool, so runs under the query cap could drop it).
  if (isStudent && state) add(core, isTerritory ? `${state} scholarship programs` : `${state} state scholarship programs`);
  // Hyperlocal scholarship ENTITIES (2026-07-06, hyperlocal_recall_miss fix):
  // county education foundations, civic clubs (Rotary/Lions/Elks), Dollars for
  // Scholars chapters, and local churches run most small-town scholarships, and
  // no geo/need phrase reaches their pages — the ENTITY name is the search
  // term. County education foundation is CORE (the single best hyperlocal
  // scholarship source); the clubs broaden via the rotated EXTRA pool.
  if (isStudent) {
    if (county) add(core, `${county} education foundation scholarships`);
    add(extra, `Rotary Club scholarship ${county || geo}`);
    add(extra, `Lions Club scholarship ${geo}`);
    if (state) add(extra, `Dollars for Scholars ${state}`);
    add(extra, `church scholarships ${geo}`);
    if (geo) add(extra, `${geo} school district education foundation`);
  }
  // Research-org lane (the Axiom BioLabs archetype, 2026-07-06): SBIR/STTR and
  // state innovation matching funds are a biotech/R&D org's PRIMARY funding
  // universe, and no generic org query ever reaches them (the catalog held
  // ZERO SBIR-class rows). Keyed to the org's top interest term so a genomics
  // shop and an ag-tech shop search different solicitations.
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
  // Org profiles skip this lane (see isOrgProfile above) — they get the
  // institution entity lane instead.
  if (!isStudent && !isOrgProfile) {
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
    // Hyperlocal safety-net ENTITIES (2026-07-06, hyperlocal_recall_miss fix).
    // A profile with an immediate-need signal (rent, food, utilities, medical,
    // transport, emergency) must NOT stop at state/national programs: churches,
    // county emergency funds, and utility assistance funds are where local help
    // actually lives, and only entity-phrased searches reach them.
    const safetyNet = signal(/food|housing|rent|energy|utilit|medical|transport|emergency|homeless/);
    if (safetyNet && (geo || county)) {
      const topNeed = needs[0] || 'emergency';
      // "churches that help with X near Y" is the real-world search phrasing
      // that surfaces congregation assistance ministries.
      add(core, `churches that help with ${topNeed} ${geo || county}`);
      add(core, `${county || geo} emergency assistance fund`);
      add(extra, `Salvation Army assistance ${geo || county}`);
      add(extra, `St Vincent de Paul assistance ${geo}`);
      add(extra, `church assistance programs ${county || geo}`);
    }
    if (signal(/energy|utilit|electric|heating/) && (geo || state)) {
      add(extra, `utility bill assistance ${geo || state}`);
      if (state) add(extra, `${state} weatherization assistance program`);
    }
    if (signal(/food|nutrition|grocer/) && (county || geo)) {
      add(extra, `food pantry ${county || geo}`);
    }
    if (signal(/housing|rent|homeless/) && (county || geo)) {
      add(extra, `housing assistance programs ${county || geo}`);
    }
    if (signal(/transport/) && (county || geo)) {
      add(extra, `transportation assistance ${county || geo}`);
    }
    // Employment/workforce → the local workforce board / American Job Center.
    if (signal(/employ|workforce|job|career/) && (county || state)) {
      add(extra, `workforce development board ${county || state}`);
      add(extra, `American Job Center ${geo || state}`);
    }
    // Domestic-violence survivor lane (relevance_precision archetype fix):
    // victim services are county/state-programmatic, never generic "grants".
    if (signal(/domestic violence|family violence|abuse|victim/)) {
      add(core, `domestic violence assistance ${county || geo || state}`);
      if (state) add(extra, `crime victim compensation ${state}`);
      add(extra, `domestic violence shelter services ${geo || state}`);
    }
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

    if (has('vfd')) {
      // Fire/EMS: AFG is the sector's primary program; state fire grants next.
      add(core, `Assistance to Firefighters Grant ${year}`);
      if (state) add(extra, `${state} fire department grants`);
      add(extra, `volunteer fire department equipment grants`);
      add(extra, `EMS equipment grants ${state || year}`);
      add(extra, `Firehouse Subs Public Safety Foundation grant`);
    }
    if (has('government') && !has('vfd') && !has('law_enforcement')) {
      if (state) add(extra, `USDA community facilities grant ${state}`);
      if (state) add(extra, `${state} municipal grants ${year}`);
      if (state) add(extra, `community development block grant ${state}`);
    }
    if (has('nonprofit')) {
      // CDC / housing & economic development orgs.
      if (needSignal(/housing development|economic development|community facilit/)) {
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
    }
    if (has('church') || has('ministry')) {
      add(extra, `grants for churches ${year}`);
      if (state) add(extra, `faith-based organization grants ${state}`);
      add(extra, `church building grants`);
    }
    if (has('school') && !isStudent) {
      if (county) add(core, `${county} education foundation`);
      if (state) add(extra, `${state} education grants for schools ${year}`);
      add(extra, `teacher classroom grants ${year}`);
    }
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
    if (has('business') && !has('farm')) {
      add(extra, `chamber of commerce small business grants ${county || geo}`);
      if (state) add(extra, `${state} small business grant programs ${year}`);
    }
    // County extension office: the local front door for both farm and family
    // programs — relevant to ag profiles and to rural family/individual needs.
    if ((has('farm') || needSignal(/agricultur/)) && county) {
      add(extra, `${county} extension office programs`);
    }
  }

  // ── Closed-loop gap targeting ───────────────────────────────────────────────
  // If a PRIOR crawl learned a coverage gap for this profile (recorded by
  // liveCrawlGapLearning into Anya's brain, attached to the thesis by
  // buildThesisForProfile), steer THIS run to fill it — so the crawlers evolve
  // from what they learn instead of repeating the same misses.
  const learned = thesis.learned_gaps || null;
  if (learned) {
    const classes = Array.isArray(learned.classes) ? learned.classes : [];
    const missingSchools = (Array.isArray(learned.missing_schools) ? learned.missing_schools : [])
      .map(cleanInstitution).filter(Boolean);
    // institution_gap → force the still-missing school names (endowed / foundation
    // scholarships are reachable ONLY by the institution's name).
    if (classes.includes('institution_gap') || missingSchools.length) {
      for (const s of missingSchools.slice(0, 3)) {
        add(core, `${s} scholarships`);
        add(core, `${s} foundation scholarships`);
      }
    }
    // hyperlocal_gap → re-emit county-scoped queries even if a prior run tried
    // them, AND escalate to the hyperlocal entity classes (education foundation
    // / churches / civic clubs) that plain county phrasing misses.
    if (classes.includes('hyperlocal_gap') && county) {
      add(core, isStudent ? `local scholarships ${county}` : `local assistance programs ${county}`);
      add(core, isStudent ? `${county} education foundation scholarships` : `${county} emergency assistance fund`);
      add(extra, `community foundation grants ${county}`);
      add(extra, isStudent ? `Rotary Club scholarship ${county}` : `church assistance programs ${county}`);
    }
    // low_results → broaden with national + state fallbacks keyed to the needs.
    if (classes.includes('low_results')) {
      for (const need of needs.slice(0, 3)) add(extra, `${need} grant funding ${word}`);
      if (state) add(extra, `${state} assistance programs`);
    }
  }

  // Last resort: a sparse profile still searches something useful.
  if (core.length === 0 && extra.length === 0) add(core, `grants for ${word} ${geo || year}`);

  return [...core, ...rotate(extra, seed)].slice(0, max);
}

export default { buildWebQueries };
