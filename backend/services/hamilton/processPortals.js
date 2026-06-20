/**
 * processPortals.js
 *
 * A small DECLARATIVE registry of profile-type-aware "process" portals — the
 * websites a profile actually has to go through to get money/benefits, beyond
 * the funders already in its pipeline. These are NOT derived from pipeline grants
 * or colleges (that is profilePortalIndex.js's job); they are the well-known,
 * always-relevant destinations for a profile's TYPE + NEEDS + STATE:
 *
 *   • STUDENT      → FAFSA, ACT, College Board (SAT + CSS Profile), + the
 *                    student's own high school (when known).
 *   • INDIVIDUAL / FAMILY / NEED → state benefits portals (SNAP, Medicaid, TANF,
 *                    LIHEAP, unemployment, 211) resolved to the profile's STATE,
 *                    plus SSA/SSDI (national). Only when the matching need signal
 *                    is present — we never bury a profile in benefit links it has
 *                    no reason to use.
 *   • NONPROFIT / ORG → Grants.gov + SAM.gov (national).
 *
 * GATING is two-dimensional and conservative:
 *   1. RELEVANCE — appliesWhen(ps) must be true for the profile's type/needs.
 *   2. GEOGRAPHY — a 'state'-scope portal is ONLY shown for a state the profile
 *      actually belongs to. We NEVER show another state's portal. The state set
 *      comes from profileSignals.location.states[] when present, else the single
 *      location.state. (An out-of-state student therefore gets benefit/process
 *      portals for ALL of their states — home + school.)
 *
 * Each registry entry is `{ id, label, url, kind, scope, appliesWhen }`:
 *   - kind:  'process' | 'benefit' | 'school'
 *   - scope: 'national' (one tile) | 'state' (one tile per applicable state via
 *            a resolver)
 *   - appliesWhen(profileSignals): boolean relevance gate
 *
 * Nothing here drives a portal or stores a secret — it only declares which
 * destinations to surface. The caller (profilePortalIndex.getProfilePortals)
 * pushes each resolved entry through the SAME tile pipeline (status ready/
 * needs_setup from the profile's credentials/sessions, etc.).
 */

// ── normalization helpers ────────────────────────────────────────────────────

function asSet(value) {
  if (value instanceof Set) return value
  if (Array.isArray(value)) return new Set(value.map((v) => String(v).trim().toLowerCase()).filter(Boolean))
  if (value && typeof value === 'object') {
    return new Set(
      Object.entries(value)
        .filter(([, v]) => v !== false && v !== null && v !== undefined && v !== '' && v !== 0)
        .map(([k]) => String(k).trim().toLowerCase()),
    )
  }
  return new Set()
}

function normType(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase()
}

const STUDENT_TYPES = new Set(['student', 'high_school_student', 'college_student', 'graduate_student'])
const INDIVIDUAL_TYPES = new Set(['individual', 'family', 'household', 'person', 'caregiver', 'senior'])
const ORG_TYPES = new Set([
  'nonprofit', 'nonprofit_org', 'organization', 'org', 'church', 'ministry',
  'faith_based', 'school', 'k12', 'charter_school', 'foundation',
])

/**
 * Normalize the assorted profileSignals shapes into ONE flat view the
 * appliesWhen predicates and the caller can read deterministically.
 *
 * @param {object} profileSignals  the `signals` object from loadProfileSignals
 *   (may also be the full { signals } result — we unwrap it).
 * @returns {{ primaryType, isStudent, isIndividualOrFamily, isOrg,
 *             needs:Set, assistance:Set, states:string[], schoolName:string|null }}
 */
export function normalizeProfileSignals(profileSignals) {
  const ps = profileSignals && profileSignals.signals ? profileSignals.signals : (profileSignals || {})
  const primaryType = normType(ps.applicantType || ps.primary_type || ps.primaryType)

  const applicantTypes = asSet(ps.applicantTypes)
  const typeHits = new Set([primaryType, ...applicantTypes])

  const isStudent = [...typeHits].some((t) => STUDENT_TYPES.has(t))
  const isOrg = [...typeHits].some((t) => ORG_TYPES.has(t))
  // Individual/family is the honest default ONLY when no stronger type matched —
  // a nonprofit is never also treated as a benefits-seeking household.
  const isIndividualOrFamily =
    !isOrg && (
      [...typeHits].some((t) => INDIVIDUAL_TYPES.has(t)) ||
      (!isStudent && (primaryType === '' || primaryType === 'individual'))
    )

  const needs = asSet(ps.needs)
  const assistance = asSet(ps.assistance)

  // States: prefer the multi-state array the signals pipeline provides, else the
  // single resolved state. Uppercased 2-letter codes, deduped, order-stable.
  const loc = (ps.location && typeof ps.location === 'object') ? ps.location : {}
  // The signals pipeline exposes the multi-state array at the TOP level
  // (`ps.states`, primary-first). Prefer it; fall back to a nested location.states
  // then the single primary state so single-address profiles are unchanged.
  const rawStates = Array.isArray(ps.states) && ps.states.length
    ? ps.states
    : (Array.isArray(loc.states) && loc.states.length
      ? loc.states
      : (loc.state ? [loc.state] : []))
  const states = []
  const seen = new Set()
  for (const s of rawStates) {
    const code = String(s || '').trim().toUpperCase()
    if (code && !seen.has(code)) { seen.add(code); states.push(code) }
  }

  // The student's own school (high school / current institution) for the school
  // tile. Read the structured education signal first, then the raw section.
  const edu = (ps.education && typeof ps.education === 'object') ? ps.education : {}
  const rawEdu =
    (ps.rawSections && (ps.rawSections.education || ps.rawSections.education_details)) || {}
  const schoolNameRaw =
    edu.currentSchool || edu.school_name || rawEdu.school_name || rawEdu.current_institution || null
  const schoolName = schoolNameRaw ? String(schoolNameRaw).trim() || null : null

  // Student-ADJACENT: a profile can be a real student without being typed one
  // (e.g. primary_type 'individual' but with an education section / college
  // applications). Treat as a student for the FAFSA/ACT/College-Board tiles when
  // there's a concrete education signal — but never for an org. Mirrors the
  // recall fix's requiresStudent softening so a TN student still gets FAFSA/ACT.
  const uniApps = (ps.rawSections && ps.rawSections.university_applications) || ps.university_applications || {}
  const hasUniversityApps = Array.isArray(uniApps.applications) && uniApps.applications.length > 0
  const eduEnrolled = Boolean(
    edu.grade_level || edu.field_of_study || edu.currently_enrolled || edu.highest_level
    || rawEdu.grade_level || rawEdu.field_of_study || rawEdu.currently_enrolled,
  )
  const interest = new Set(
    [...asSet(ps.needs), ...asSet(ps.assistance), ...asSet(ps.intents)].map((x) => String(x).toLowerCase()),
  )
  const eduIntent = ['education', 'student_aid', 'scholarship', 'school', 'college', 'tuition'].some((k) => interest.has(k))
  const isStudentLike = !isOrg && (isStudent || Boolean(schoolName) || hasUniversityApps || eduEnrolled || eduIntent)

  return { primaryType, isStudent, isStudentLike, isIndividualOrFamily, isOrg, needs, assistance, states, schoolName }
}

// ── per-state benefit portal resolver ────────────────────────────────────────
// Maps a 2-letter state code to the RIGHT state's portal for a given program.
// We hand-resolve the states we know precisely (TN, OH) and fall back to the
// federal benefit finder for every other state, so a tile is NEVER wrong-state.
// (A wrong-state link is worse than a correct national fallback.)

const FEDERAL_BENEFIT_FALLBACK = {
  snap: 'https://www.benefits.gov/categories/Food%20and%20Nutrition',
  medicaid: 'https://www.medicaid.gov/about-us/where-can-people-get-help-medicaid-chip/index.html',
  tanf: 'https://www.benefits.gov/categories/Financial%20Assistance',
  liheap: 'https://www.acf.hhs.gov/ocs/programs/liheap/consumer-help',
  unemployment: 'https://www.dol.gov/general/topic/unemployment-insurance',
  benefits: 'https://www.benefits.gov/',
}

// Precise per-state portals. Keyed STATE → program → url.
const STATE_BENEFIT_PORTALS = {
  TN: {
    snap: 'https://www.tn.gov/humanservices/for-families/supplemental-nutrition-assistance-program-snap.html',
    medicaid: 'https://www.tn.gov/tenncare',
    tanf: 'https://www.tn.gov/humanservices/for-families/families-first-tanf.html',
    liheap: 'https://www.tn.gov/humanservices/for-families/low-income-home-energy-assistance-program-liheap.html',
    unemployment: 'https://www.tn.gov/workforce/unemployment.html',
    benefits: 'https://www.tn.gov/humanservices.html',
  },
  OH: {
    snap: 'https://benefits.ohio.gov/',
    medicaid: 'https://medicaid.ohio.gov/',
    tanf: 'https://jfs.ohio.gov/cash-food-and-refugee-assistance/cash-assistance/cash-assistance',
    liheap: 'https://energyhelp.ohio.gov/',
    unemployment: 'https://unemployment.ohio.gov/',
    benefits: 'https://benefits.ohio.gov/',
  },
}

/**
 * Resolve the correct portal URL for one benefit program in one state, never
 * returning a wrong-state link: a known state uses its precise portal; any other
 * state falls back to the federal finder for that program (or benefits.gov).
 */
export function resolveStateBenefitUrl(stateCode, program) {
  const st = String(stateCode || '').trim().toUpperCase()
  const prog = String(program || '').trim().toLowerCase()
  const stateMap = STATE_BENEFIT_PORTALS[st]
  if (stateMap && stateMap[prog]) return stateMap[prog]
  return FEDERAL_BENEFIT_FALLBACK[prog] || FEDERAL_BENEFIT_FALLBACK.benefits
}

// Friendly full state name for labels (best-effort; falls back to the code).
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
}

export function stateLabel(stateCode) {
  const st = String(stateCode || '').trim().toUpperCase()
  return STATE_NAMES[st] || st
}

// ── need-signal helpers for benefit gating ───────────────────────────────────
// A benefit portal applies only when a RELATED need (or current enrollment) is
// present. We read both the canonical `needs` Set and the broad `assistance` Set.

function hasNeed(ps, ...tokens) {
  for (const t of tokens) {
    if (ps.needs.has(t) || ps.assistance.has(t)) return true
  }
  return false
}

// Benefit portals serve PEOPLE (individuals, families, and students), never
// organizations. Students are explicitly included so an out-of-state student who
// needs SNAP/Medicaid gets the right state's benefit portals (the canonical
// "out-of-state student gets both states" case).
function isBenefitsEligible(ps) {
  return !ps.isOrg && (ps.isIndividualOrFamily || ps.isStudent)
}

// Any sign at all that this profile is benefits-seeking (so 211 + general
// benefits make sense even without a single specific program need).
function hasAnyBenefitNeed(ps) {
  return hasNeed(
    ps,
    'food', 'snap', 'nutrition',
    'healthcare', 'medical', 'medicaid', 'health', 'disability',
    'cash_assistance', 'tanf', 'income',
    'utilities', 'liheap', 'weatherization', 'energy',
    'employment', 'unemployment', 'workforce', 'job',
    'housing', 'rent', 'homeless',
    'childcare',
  )
}

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} ProcessPortalDef
 * @property {string} id
 * @property {string} label
 * @property {string} [url]            for national scope; state scope resolves per-state
 * @property {'process'|'benefit'|'school'} kind
 * @property {'national'|'state'} scope
 * @property {(ps:object)=>boolean} appliesWhen   takes the normalized signals
 * @property {string} [program]        benefit program key for state resolution
 */

/** @type {ProcessPortalDef[]} */
export const PROCESS_PORTALS = [
  // ── STUDENT (national) ─────────────────────────────────────────────────────
  {
    id: 'fafsa',
    label: 'FAFSA — federal student aid',
    url: 'https://studentaid.gov/',
    kind: 'process',
    scope: 'national',
    appliesWhen: (ps) => ps.isStudentLike,
  },
  {
    id: 'act',
    label: 'ACT — college entrance exam',
    url: 'https://www.act.org/',
    kind: 'process',
    scope: 'national',
    appliesWhen: (ps) => ps.isStudentLike,
  },
  {
    id: 'collegeboard_sat',
    label: 'College Board — SAT',
    url: 'https://www.collegeboard.org/',
    kind: 'process',
    scope: 'national',
    appliesWhen: (ps) => ps.isStudentLike,
  },
  {
    id: 'collegeboard_css',
    label: 'CSS Profile — college aid application',
    url: 'https://cssprofile.collegeboard.org/',
    kind: 'process',
    scope: 'national',
    appliesWhen: (ps) => ps.isStudentLike,
  },

  // ── INDIVIDUAL / FAMILY / NEED: national benefit anchors ───────────────────
  {
    id: 'ssa',
    label: 'Social Security (SSA / SSDI / SSI)',
    url: 'https://www.ssa.gov/',
    kind: 'benefit',
    scope: 'national',
    appliesWhen: (ps) =>
      isBenefitsEligible(ps) &&
      (hasNeed(ps, 'disability', 'ssdi', 'ssi', 'retirement', 'income') || hasAnyBenefitNeed(ps)),
  },
  {
    id: 'benefits_211',
    label: '211 — local help finder',
    url: 'https://www.211.org/',
    kind: 'benefit',
    scope: 'national',
    appliesWhen: (ps) => isBenefitsEligible(ps) && hasAnyBenefitNeed(ps),
  },

  // ── INDIVIDUAL / FAMILY / NEED: state benefit portals (per-state) ──────────
  {
    id: 'snap',
    program: 'snap',
    label: 'SNAP (food assistance)',
    kind: 'benefit',
    scope: 'state',
    appliesWhen: (ps) => isBenefitsEligible(ps) && hasNeed(ps, 'food', 'snap', 'nutrition'),
  },
  {
    id: 'medicaid',
    program: 'medicaid',
    label: 'Medicaid (health coverage)',
    kind: 'benefit',
    scope: 'state',
    appliesWhen: (ps) => isBenefitsEligible(ps) && hasNeed(ps, 'healthcare', 'medical', 'medicaid', 'health', 'disability'),
  },
  {
    id: 'tanf',
    program: 'tanf',
    label: 'TANF (cash assistance)',
    kind: 'benefit',
    scope: 'state',
    appliesWhen: (ps) => isBenefitsEligible(ps) && hasNeed(ps, 'cash_assistance', 'tanf', 'income'),
  },
  {
    id: 'liheap',
    program: 'liheap',
    label: 'LIHEAP (energy bill help)',
    kind: 'benefit',
    scope: 'state',
    appliesWhen: (ps) => isBenefitsEligible(ps) && hasNeed(ps, 'utilities', 'liheap', 'weatherization', 'energy'),
  },
  {
    id: 'unemployment',
    program: 'unemployment',
    label: 'Unemployment benefits',
    kind: 'benefit',
    scope: 'state',
    appliesWhen: (ps) => isBenefitsEligible(ps) && hasNeed(ps, 'employment', 'unemployment', 'workforce', 'job'),
  },

  // ── NONPROFIT / ORG (national) ─────────────────────────────────────────────
  {
    id: 'grants_gov',
    label: 'Grants.gov — federal grants',
    url: 'https://www.grants.gov/',
    kind: 'process',
    scope: 'national',
    appliesWhen: (ps) => ps.isOrg,
  },
  {
    id: 'sam_gov',
    label: 'SAM.gov — federal registration',
    url: 'https://sam.gov/',
    kind: 'process',
    scope: 'national',
    appliesWhen: (ps) => ps.isOrg,
  },
]

/**
 * Resolve the applicable process portals for a profile, fully gated by relevance
 * AND geography. Returns flat tile descriptors ready to merge into the portals
 * list. NEVER throws (a bad signals shape yields []).
 *
 * Each returned descriptor: { id, portalHost, loginUrl, label, kind, scope,
 * sources:[], state? }. portalHost is the registrable-ish host of the resolved
 * URL so the caller can compute ready/needs_setup status the same way it does for
 * pipeline/college portals.
 *
 * @param {object} profileSignals  the `signals` object (or full result) from
 *   loadProfileSignals.
 * @returns {Array<object>}
 */
export function resolveProcessPortals(profileSignals) {
  try {
    const ps = normalizeProfileSignals(profileSignals)
    const out = []

    for (const def of PROCESS_PORTALS) {
      let applies = false
      try { applies = Boolean(def.appliesWhen(ps)) } catch { applies = false }
      if (!applies) continue

      if (def.scope === 'state') {
        // One tile per applicable state — and ONLY the profile's states, so we
        // never surface another state's portal. Out-of-state students naturally
        // get one per state because ps.states already carries home + school.
        for (const st of ps.states) {
          const url = resolveStateBenefitUrl(st, def.program || def.id)
          const host = hostFromUrl(url)
          if (!host) continue
          out.push({
            id: `${def.id}:${st}`,
            portalHost: host,
            loginUrl: url,
            label: `${def.label} — ${stateLabel(st)}`,
            kind: def.kind,
            scope: def.scope,
            state: st,
            sources: [],
          })
        }
        continue
      }

      // national
      const host = hostFromUrl(def.url)
      if (!host) continue
      out.push({
        id: def.id,
        portalHost: host,
        loginUrl: def.url,
        label: def.label,
        kind: def.kind,
        scope: def.scope,
        sources: [],
      })
    }

    // The student's own high school / institution — declarative SCHOOL tile.
    // We list it even when we can't resolve a login URL (loginUrl stays null and
    // the tile still shows, so the user knows it belongs in their portal list).
    if (ps.isStudent && ps.schoolName) {
      out.push({
        id: `school:${ps.schoolName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        portalHost: null,
        loginUrl: null,
        label: ps.schoolName,
        kind: 'school',
        scope: 'national',
        sources: [],
      })
    }

    return out
  } catch {
    return []
  }
}

/**
 * Minimal http(s) host extractor (inlined so this registry stays dependency-free
 * for the resolver path). Returns the registrable-ish host with leading "www."
 * stripped, or null for a non-http(s) URL.
 */
export function hostFromUrl(u) {
  if (!u) return null
  try {
    const p = new URL(String(u).trim())
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null
    const host = p.hostname.replace(/^www\./i, '')
    return host || null
  } catch {
    return null
  }
}

export default {
  PROCESS_PORTALS,
  resolveProcessPortals,
  normalizeProfileSignals,
  resolveStateBenefitUrl,
  stateLabel,
}
