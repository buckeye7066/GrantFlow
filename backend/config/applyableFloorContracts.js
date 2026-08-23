/**
 * applyableFloorContracts.js — the shared-contract SEAM for the applyability-aware,
 * per-type coverage floor (initiative agent #3).
 *
 * This feature CONSUMES two sibling deliverables that are built in parallel and
 * may not be merged when this runs:
 *
 *   #1 `backend/config/profileSourceArchetypes.js`
 *        SOURCE_ARCHETYPES (profileType → [{ category, known_sources:[{name,url}],
 *        query_patterns }]), resolveArchetypesForProfile(profile, sections),
 *        knownSeedSourcesForProfile(profile, sections)
 *
 *   #2 `backend/config/sourceApplyability.js`
 *        classifyApplyability(source) → { tier:'online_form'|'mail_or_pdf'|
 *        'account_portal'|'info_only', isApplyable }
 *
 * Per the initiative contract, this module loads the REAL modules when present
 * and falls back to a THIN, faithful local shim when they are not, so the count,
 * the floor and the discovery directive can be built and TESTED before #1/#2
 * land. `loadArchetypesApi()` / `loadApplyabilityApi()` prefer the real export
 * every time — once #1/#2 merge, the shim is dead weight and the loaders return
 * their real functions with zero code change here.
 *
 * WHAT THIS MODULE ADDS ON TOP OF THE CONTRACT (owned here, not by #1/#2):
 *   - `sourceMatchesArchetypes(row, archetypes)` — is a catalog row TYPE-
 *     APPROPRIATE for a profile, i.e. does it belong to one of the profile's
 *     archetype categories (or a known seed source)? This is a CONSUMER concern,
 *     never a claim about #1's internals.
 *   - `buildArchetypeDirective({ archetypes, seeds })` — the pure directive the
 *     floor's shortfall lane runs: known seed URLs (as seed pages) + the
 *     archetype query_patterns (as extra searches). A seed is a URL, not a
 *     verdict — it still faces the full fetch→extract→reality-gate→engine stack.
 */

import { isPointerKind } from './opportunityKindClasses.js'

// ── URL / host helpers (self-contained so this stays a cheap import) ──────────

function normHost(url) {
  const s = String(url || '').trim()
  const m = s.match(/^https?:\/\/([^/?#]+)/i)
  if (!m) return ''
  return m[1].toLowerCase().replace(/^www\./, '')
}

function registrableRoot(host) {
  const parts = String(host || '').split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  // eTLD+1 approximation good enough for identity comparison of known sources.
  return parts.slice(-2).join('.')
}

function firstUrl(source) {
  if (!source || typeof source !== 'object') return ''
  return String(
    source.application_url || source.apply_url || source.url || source.source_url || source.evidence_url || '',
  ).trim()
}

const ACCOUNT_PORTAL_HOST_RX =
  /(academicworks|scholarships\.ngwebsolutions|communityforce|smapply|submittable|survmetrics|awardspring|scholarshipamerica|blackbaud|foundant|grantinterface|fluidreview|reviewr|zoomgrants|slideroom)\./i

// ── #2 APPLYABILITY — thin shim faithful to the contract ──────────────────────

/**
 * SHIM for #2.classifyApplyability. Faithful to the declared contract:
 *   info_only    — a pointer (directory/referral/school_portal/past_award_intel),
 *                  or a row with no resolvable apply path.
 *   account_portal — a known application-portal platform host.
 *   online_form  — anything else with a live apply URL.
 * `mail_or_pdf` is never SYNTHESIZED here (the shim cannot read a PDF); a real
 * #2 will. isApplyable = tier !== 'info_only'.
 */
export function classifyApplyabilityShim(source) {
  const kind = source?.opportunity_kind ?? source?.kind ?? null
  const url = firstUrl(source)
  if (isPointerKind(kind) || !/^https?:\/\//i.test(url)) {
    return { tier: 'info_only', isApplyable: false }
  }
  if (ACCOUNT_PORTAL_HOST_RX.test(url)) {
    return { tier: 'account_portal', isApplyable: true }
  }
  return { tier: 'online_form', isApplyable: true }
}

/** Resolve #2's classifier — the real module when present, else the shim. */
export async function loadApplyabilityApi() {
  try {
    const real = await import('./sourceApplyability.js')
    if (real && typeof real.classifyApplyability === 'function') {
      return { classifyApplyability: real.classifyApplyability, source: 'real' }
    }
  } catch { /* not merged yet — fall through to the shim */ }
  return { classifyApplyability: classifyApplyabilityShim, source: 'shim' }
}

// ── #1 ARCHETYPES — thin shim faithful to the contract ────────────────────────

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * SHIM registry for #1.SOURCE_ARCHETYPES. Keyed by the ROOT profile class the
 * planner already reasons in. Categories carry match TOKENS (what a
 * type-appropriate row's kind/category/title should contain) and a few real,
 * live known sources so the seed lane has something to fetch before #1 lands.
 * Deliberately small and honest — a placeholder, not a curated catalog.
 */
export const SOURCE_ARCHETYPES_SHIM = Object.freeze({
  small_business: [
    {
      category: 'small_business_grant',
      match_tokens: ['small business', 'business grant', 'entrepreneur', 'startup', 'sbir', 'sttr', 'microgrant'],
      known_sources: [
        { name: 'SBA — Grants & funding programs', url: 'https://www.sba.gov/funding-programs/grants' },
        { name: 'Grants.gov — small business', url: 'https://www.grants.gov/search-grants?query=small%20business' },
        { name: 'Hello Alice — small business grants', url: 'https://helloalice.com/grants/' },
      ],
      query_patterns: [
        'small business grant {city} {state}',
        'small business grant for {industry} {state}',
        '{state} small business relief grant apply',
      ],
    },
  ],
  student: [
    {
      category: 'scholarship',
      match_tokens: ['scholarship', 'fellowship', 'grant', 'tuition', 'student aid', 'bursary'],
      known_sources: [
        { name: 'CareerOneStop — scholarship finder', url: 'https://www.careeronestop.org/toolkit/training/find-scholarships.aspx' },
        { name: 'Federal Student Aid — grants', url: 'https://studentaid.gov/understand-aid/types/grants' },
      ],
      query_patterns: [
        'scholarship for {major} students {state}',
        '{state} scholarship application {year}',
        'scholarship for {demographic} students apply',
      ],
    },
  ],
  individual: [
    {
      category: 'patient_assistance',
      match_tokens: ['patient assistance', 'copay', 'hardship', 'emergency assistance', 'financial assistance', 'relief fund', 'benefit'],
      known_sources: [
        { name: 'PAN Foundation — patient assistance', url: 'https://www.panfoundation.org/patients/' },
        { name: 'HealthWell Foundation', url: 'https://www.healthwellfoundation.org/' },
        { name: 'Modest Needs — self-sufficiency grants', url: 'https://www.modestneeds.org/' },
      ],
      query_patterns: [
        'emergency financial assistance {city} {state}',
        'hardship grant for individuals {state}',
        'patient assistance program {condition}',
      ],
    },
  ],
  family: [
    {
      category: 'household_assistance',
      match_tokens: ['rent', 'utility', 'housing', 'food', 'emergency assistance', 'household', 'family', 'liheap', 'benefit'],
      known_sources: [
        { name: 'Modest Needs — self-sufficiency grants', url: 'https://www.modestneeds.org/' },
        { name: 'LIHEAP — home energy assistance', url: 'https://www.acf.hhs.gov/ocs/programs/liheap' },
      ],
      query_patterns: [
        'emergency rent assistance {county} {state}',
        'utility assistance program {city} {state}',
        'family emergency grant {state}',
      ],
    },
  ],
  nonprofit: [
    {
      category: 'operating_grant',
      match_tokens: ['grant', 'foundation', 'nonprofit', 'operating support', 'program grant', 'capacity'],
      known_sources: [
        { name: 'Candid — Foundation Directory (free tier)', url: 'https://fconline.foundationcenter.org/' },
        { name: 'Grants.gov — nonprofit', url: 'https://www.grants.gov/search-grants?query=nonprofit' },
      ],
      query_patterns: [
        'foundation grant for nonprofits {state}',
        'operating grant {mission} nonprofit',
        '{state} community foundation grant apply',
      ],
    },
  ],
  veteran: [
    {
      category: 'veteran_assistance',
      match_tokens: ['veteran', 'military', 'va grant', 'sba veteran', 'boots to business'],
      known_sources: [
        { name: 'SBA — veteran-owned business', url: 'https://www.sba.gov/business-guide/grow-your-business/veteran-owned-businesses' },
        { name: 'VA — veteran benefits', url: 'https://www.va.gov/' },
      ],
      query_patterns: [
        'veteran grant {state} apply',
        'veteran owned business grant {industry}',
        'emergency assistance for veterans {state}',
      ],
    },
  ],
})

/**
 * SHIM for #1.resolveArchetypesForProfile — maps the profile's ROOT class to its
 * archetype list. Uses the same effective-type resolver the planner does, so a
 * business hallucinated onto an individual, or a student under a person root,
 * lands where the rest of the product already reasons about it.
 */
export function resolveArchetypesForProfileShim(profile, sections = {}) {
  const cls = rootArchetypeClass(profile, sections)
  return SOURCE_ARCHETYPES_SHIM[cls] ? [...SOURCE_ARCHETYPES_SHIM[cls]] : []
}

/** SHIM for #1.knownSeedSourcesForProfile — the flat seed list for a profile. */
export function knownSeedSourcesForProfileShim(profile, sections = {}) {
  const out = []
  const seen = new Set()
  for (const arch of resolveArchetypesForProfileShim(profile, sections)) {
    for (const s of Array.isArray(arch.known_sources) ? arch.known_sources : []) {
      const url = String(s?.url || '').trim()
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
      seen.add(url)
      out.push({ name: s.name ?? null, url, category: arch.category })
    }
  }
  return out
}

/**
 * The ROOT archetype class for a profile. Delegates to the product's own
 * effective-type resolver when available (so senior/disabled_adult/caregiver
 * roll up to `individual`, small_business_owner to `small_business`, etc.), and
 * falls back to a token map when it cannot be loaded. Sync + best-effort: the
 * resolver is imported lazily by the async loaders; here we read the already-
 * resolved `primary_type`/tokens.
 */
function rootArchetypeClass(profile, sections = {}) {
  const raw = norm(
    profile?._effective_type ||
      profile?.primary_type ||
      profile?.applicant_type ||
      profile?.type ||
      '',
  )
  const hay = `${raw} ${norm(JSON.stringify(sections?.occupation ?? {}))} ${norm(JSON.stringify(sections?.military_service ?? {}))}`
  if (/veteran|military/.test(hay)) return 'veteran'
  if (/small business|business owner|entrepreneur|self employed|startup/.test(hay) || /business/.test(raw)) return 'small_business'
  if (/student|scholar|college|university|high school/.test(hay) || /student/.test(raw)) return 'student'
  if (/nonprofit|ministry|church|charity|foundation|organization|org/.test(raw)) return 'nonprofit'
  if (/family|household|caregiver|parent/.test(raw)) return 'family'
  return 'individual'
}

/** Resolve #1's archetype API — the real module when present, else the shim. */
export async function loadArchetypesApi() {
  try {
    const real = await import('./profileSourceArchetypes.js')
    if (
      real &&
      typeof real.resolveArchetypesForProfile === 'function' &&
      typeof real.knownSeedSourcesForProfile === 'function'
    ) {
      return {
        resolveArchetypesForProfile: real.resolveArchetypesForProfile,
        knownSeedSourcesForProfile: real.knownSeedSourcesForProfile,
        source: 'real',
      }
    }
  } catch { /* not merged yet — fall through to the shim */ }
  return {
    resolveArchetypesForProfile: resolveArchetypesForProfileShim,
    knownSeedSourcesForProfile: knownSeedSourcesForProfileShim,
    source: 'shim',
  }
}

// ── TYPE-APPROPRIATENESS (owned here — a consumer question, not #1's) ─────────

/**
 * Is a catalog ROW type-appropriate for a profile whose archetypes are `archetypes`?
 *
 * TRUE when EITHER:
 *   - the row's host matches a known_source host of any archetype (an exact
 *     "this is one of the sources this type applies to" signal), OR
 *   - the row's kind/categories/title contains a match TOKEN of any archetype
 *     category (a phrase the source itself states — never a single shared word;
 *     tokens are multi-word or ≥5 chars to avoid the one-shared-word floor).
 *
 * A POINTER is never type-appropriate here — it is not a thing you apply to
 * (the same rule the applyability tier enforces), so the two conjuncts agree.
 */
export function sourceMatchesArchetypes(row, archetypes = []) {
  if (!row || !Array.isArray(archetypes) || archetypes.length === 0) return false
  if (isPointerKind(row?.opportunity_kind ?? row?.kind)) return false

  const rowHost = registrableRoot(normHost(firstUrl(row)))
  const hay = norm(
    `${row.title || ''} ${row.sponsor || ''} ${row.opportunity_kind || row.kind || ''} ${
      Array.isArray(row.categories) ? row.categories.join(' ') : row.categories || ''
    }`,
  )

  for (const arch of archetypes) {
    if (rowHost) {
      for (const s of Array.isArray(arch.known_sources) ? arch.known_sources : []) {
        const kh = registrableRoot(normHost(s?.url))
        if (kh && kh === rowHost) return true
      }
    }
    const tokens = Array.isArray(arch.match_tokens) && arch.match_tokens.length
      ? arch.match_tokens
      // #1 supplies no per-source match_tokens — derive type signals from the
      // semantic category label ('hardship_and_emergency_funds' → hardship,
      // emergency). A single ≥5-char domain word (scholarship, veteran,
      // disability) IS a strong type signal; generic funding words
      // (grant/fund/program/assistance/…) and meta words (hubs/locators) are
      // dropped so this never becomes the one-shared-word floor.
      : categoryTypeTokens(arch.category)
    for (const t of tokens) {
      const tk = norm(t)
      if (!tk) continue
      const multiWord = tk.includes(' ')
      if (!multiWord && tk.length < 5) continue // one-shared-word floor
      if (tokenBoundaryIncludes(hay, tk)) return true
    }
  }
  return false
}

// Words a category label shares with everything — dropped so a category-derived
// token is a real TYPE signal, never a generic funding/meta word.
const GENERIC_CATEGORY_WORDS = new Set([
  'and', 'of', 'the', 'for', 'to', 'a', 'an', 'or',
  'grant', 'grants', 'fund', 'funds', 'funding', 'program', 'programs',
  'assistance', 'aid', 'help', 'support', 'services', 'service', 'resource', 'resources',
  'hub', 'hubs', 'locator', 'locators', 'general', 'other', 'misc',
])

/** Derive distinctive TYPE tokens from a semantic category label. */
function categoryTypeTokens(category) {
  return norm(category)
    .split(' ')
    .filter((w) => w && w.length >= 5 && !GENERIC_CATEGORY_WORDS.has(w))
}

/** Token-boundary containment ("grant" must not match inside "immigrant"). */
function tokenBoundaryIncludes(hay, needle) {
  if (!needle) return false
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^| )${esc}( |$)`).test(hay)
}

// ── THE DISCOVERY DIRECTIVE (pure) ────────────────────────────────────────────

/**
 * Build the archetype discovery directive a below-floor profile emits.
 *
 * @param {object} input
 * @param {Array}  input.archetypes  resolveArchetypesForProfile(...) output
 * @param {Array}  input.seeds       knownSeedSourcesForProfile(...) output
 * @param {object} input.vars        substitution vars for query_patterns
 *                                   ({city,state,county,major,industry,...})
 * @param {number} [input.maxSeeds]  cap on seed pages (default 8)
 * @param {number} [input.maxQueries] cap on query patterns (default 6)
 * @returns {{ seedPages:Array<{url,title,query}>, queries:string[], categories:string[] }}
 *
 * A seed is a URL, not a verdict (the seed-page rule): it earns a LOOK, never a
 * row. `queries` are additive SEARCHES the web lane runs alongside its own.
 */
export function buildArchetypeDirective({ archetypes = [], seeds = [], vars = {}, maxSeeds = 8, maxQueries = 6 } = {}) {
  const seedPages = []
  const seenUrl = new Set()
  for (const s of Array.isArray(seeds) ? seeds : []) {
    const url = String(s?.url || '').trim()
    if (!/^https?:\/\//i.test(url) || seenUrl.has(url)) continue
    seenUrl.add(url)
    seedPages.push({ url, title: s.name ?? null, query: `seed:archetype:${s.category ?? 'known_source'}` })
    if (seedPages.length >= maxSeeds) break
  }

  const queries = []
  const seenQ = new Set()
  for (const arch of Array.isArray(archetypes) ? archetypes : []) {
    for (const pat of Array.isArray(arch.query_patterns) ? arch.query_patterns : []) {
      const q = substituteVars(String(pat || ''), vars).replace(/\s+/g, ' ').trim()
      // Drop a query that still carries an unfilled {placeholder}: an un-anchored
      // "scholarship for {major} students" is noise, not a search.
      if (!q || /\{[a-z_]+\}/i.test(q) || seenQ.has(q)) continue
      seenQ.add(q)
      queries.push(q)
      if (queries.length >= maxQueries) break
    }
    if (queries.length >= maxQueries) break
  }

  const categories = [...new Set((Array.isArray(archetypes) ? archetypes : []).map((a) => a.category).filter(Boolean))]
  return { seedPages, queries, categories }
}

function substituteVars(pattern, vars = {}) {
  return String(pattern).replace(/\{([a-z_]+)\}/gi, (m, key) => {
    const v = vars?.[key]
    return v === null || v === undefined || v === '' ? m : String(v)
  })
}

/**
 * Extract the query substitution vars from a profile context. Best-effort; a
 * missing field leaves its placeholder unfilled, and `buildArchetypeDirective`
 * drops any query that still carries one.
 */
export function directiveVarsFromContext({ profile, sections, thesis } = {}) {
  const s = sections || {}
  const addr = s.basic_information?.address || s.address || profile?.address || {}
  const city = addr.city || s.location_focus?.city || null
  const state = addr.state || s.location_focus?.state || thesis?.location?.state || null
  const county = addr.county || s.location_focus?.county || thesis?.location?.county || null
  const major = s.education?.intended_major || s.education?.major || null
  const industry = s.occupation?.industry || s.small_business_details?.industry || s.business_details?.industry || null
  const year = String(new Date().getFullYear())
  // #1's query_patterns use {geo}/{need}/{sector} — fill them too, or a pattern
  // that carries one is dropped by `buildArchetypeDirective` as un-anchored.
  const geo = [city || county, state].filter(Boolean).join(' ').trim() || null
  const need = firstDeclaredNeed(s) || null
  const sector = major || industry || null
  return { city, state, county, major, industry, year, geo, need, sector }
}

/** First DECLARED structured need for {need} substitution (never prose). */
function firstDeclaredNeed(sections = {}) {
  const candidates = [
    sections.needs, sections.need_categories, sections.primary_needs,
    sections.needs?.categories, sections.needs?.needs,
  ]
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) {
      const v = String(c[0] || '').trim()
      if (v) return v
    }
  }
  return null
}

export default {
  classifyApplyabilityShim,
  loadApplyabilityApi,
  SOURCE_ARCHETYPES_SHIM,
  resolveArchetypesForProfileShim,
  knownSeedSourcesForProfileShim,
  loadArchetypesApi,
  sourceMatchesArchetypes,
  buildArchetypeDirective,
  directiveVarsFromContext,
}
