/**
 * connectorIngestService.js
 *
 * Profile-driven ingest from the official funding-data connectors that already
 * ship in backend/src/integrations/ but were never wired into the live crawl:
 *
 *   - Grants.gov search2        (no key)   — federal opportunities, eligibility-filtered
 *   - NIH RePORTER              (no key)   — funded research awards (health/research/edu)
 *   - SAM.gov Assistance Listings (key)    — full CFDA catalog (~2,400 federal programs)
 *   - Simpler.Grants.gov        (key)      — modern HHS opportunity API
 *   - ProPublica Nonprofit Explorer (no key) — real foundations / grantmakers (990 data)
 *
 * Mission rules honored (see project_grantflow_goals):
 *   #1 real opportunities  #2/#3 match the FULL profile  #4 many user types
 *   #6 local→national sources  #8 avoid zero results
 *
 * Design contract:
 *   - Every connector call is independently try/caught and key-gated. A missing
 *     API key or a single failing source NEVER aborts the others, and NEVER
 *     throws out of ingestFromConnectors — it just shows up in the coverage report.
 *   - Rows are written through upsertFundingOpportunity, so the existing quality
 *     gate / policy / verification / dedupe all still apply. We add volume at the
 *     TOP of the funnel and let the established pipeline filter as usual.
 */

import { fetchOpportunities as fetchNihReporter } from '../src/integrations/nihReporter.js'
import { fetchOpportunities as fetchNsfAwards } from '../src/integrations/nsfAwards.js'
import { fetchOpportunities as fetchFederalRegister } from '../src/integrations/federalRegister.js'
import { fetchAssistanceListings } from '../src/integrations/samAssistanceListings.js'
import { fetchOpportunities as fetchSimplerGrants } from '../src/integrations/simplerGrants.js'
import { searchOrganizations, orgToFundingOpportunity } from '../src/integrations/propublica990.js'
import { fetchGrantsGov, transformGrantsGovOpportunity } from './shared/grantsGovApiClient.js'
import { fetchUSASpending } from './sources/usaSpending.js'
import {
  searchClinicalTrials,
  extractConditionTerms,
  isOptedIntoClinicalTrials,
} from './connectors/clinicalTrialsConnector.js'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('connectorIngestService')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE → QUERY PLAN  (the relatability lever)
//
// This map is the single most important piece of domain judgment in the file:
// it translates a GrantFlow profile type into the eligibility/applicant codes
// each external source understands. Get this right and every source returns
// programs the profile can actually apply for; get it wrong and you flood the
// user with irrelevant federal noise.
//
// Codes:
//   ggEligibility    — Grants.gov search2 eligible-applicant codes
//                      (21=Individuals, 12=501c3 nonprofits, 13=non-501c3,
//                       05=school districts, 06=public higher-ed, 20=private higher-ed,
//                       23=small business, 22=other for-profit, 07=tribal gov,
//                       11=tribal orgs, 00=state, 01=county, 02=city/township,
//                       04=special district, 25=others, 99=unrestricted)
//   simplerApplicant — Simpler.Grants.gov applicant_type one_of values
//   foundationSeeker — whether ProPublica foundation grantmakers are relevant
//   wantsResearch    — whether NIH RePORTER research awards are relevant
// ─────────────────────────────────────────────────────────────────────────────
export const PROFILE_QUERY_MAP = Object.freeze({
  individual: { ggEligibility: ['21', '25'], simplerApplicant: ['individuals'], foundationSeeker: true, wantsResearch: false },
  family: { ggEligibility: ['21', '25'], simplerApplicant: ['individuals'], foundationSeeker: true, wantsResearch: false },
  student: { ggEligibility: ['21', '25'], simplerApplicant: ['individuals'], foundationSeeker: true, wantsResearch: false },
  high_school_student: { ggEligibility: ['21', '25'], simplerApplicant: ['individuals'], foundationSeeker: true, wantsResearch: false },
  college_student: { ggEligibility: ['21', '25'], simplerApplicant: ['individuals'], foundationSeeker: true, wantsResearch: false },

  nonprofit: { ggEligibility: ['12', '13', '25'], simplerApplicant: ['nonprofits_non_higher_education_with_501c3', 'nonprofits_non_higher_education_without_501c3'], foundationSeeker: true, wantsResearch: true },
  organization: { ggEligibility: ['12', '13', '25'], simplerApplicant: ['nonprofits_non_higher_education_with_501c3', 'nonprofits_non_higher_education_without_501c3'], foundationSeeker: true, wantsResearch: true },
  church: { ggEligibility: ['12', '13', '25'], simplerApplicant: ['nonprofits_non_higher_education_with_501c3', 'nonprofits_non_higher_education_without_501c3'], foundationSeeker: true, wantsResearch: false },
  ministry: { ggEligibility: ['12', '13', '25'], simplerApplicant: ['nonprofits_non_higher_education_with_501c3', 'nonprofits_non_higher_education_without_501c3'], foundationSeeker: true, wantsResearch: false },

  school: { ggEligibility: ['05', '06', '20', '12'], simplerApplicant: ['independent_school_districts', 'public_and_state_institutions_of_higher_education', 'private_institutions_of_higher_education'], foundationSeeker: true, wantsResearch: true },
  public_school: { ggEligibility: ['05', '06'], simplerApplicant: ['independent_school_districts'], foundationSeeker: true, wantsResearch: false },
  school_district: { ggEligibility: ['05', '06'], simplerApplicant: ['independent_school_districts'], foundationSeeker: true, wantsResearch: false },
  teacher: { ggEligibility: ['05', '25'], simplerApplicant: ['independent_school_districts'], foundationSeeker: true, wantsResearch: false },

  business: { ggEligibility: ['23', '22'], simplerApplicant: ['small_businesses', 'for_profit_organizations_other_than_small_businesses'], foundationSeeker: false, wantsResearch: true },
  small_business: { ggEligibility: ['23', '22'], simplerApplicant: ['small_businesses'], foundationSeeker: false, wantsResearch: true },

  volunteer_fire: { ggEligibility: ['04', '12', '25'], simplerApplicant: ['special_district_governments', 'nonprofits_non_higher_education_with_501c3'], foundationSeeker: true, wantsResearch: false },
  volunteer_fire_department: { ggEligibility: ['04', '12', '25'], simplerApplicant: ['special_district_governments', 'nonprofits_non_higher_education_with_501c3'], foundationSeeker: true, wantsResearch: false },

  tribal: { ggEligibility: ['07', '11'], simplerApplicant: ['federally_recognized_native_american_tribal_governments', 'other_native_american_tribal_organizations'], foundationSeeker: false, wantsResearch: false },
  tribal_government: { ggEligibility: ['07', '11'], simplerApplicant: ['federally_recognized_native_american_tribal_governments'], foundationSeeker: false, wantsResearch: false },

  county_government: { ggEligibility: ['01', '04', '00'], simplerApplicant: ['county_governments', 'special_district_governments'], foundationSeeker: false, wantsResearch: false },
  municipality: { ggEligibility: ['02', '04', '00'], simplerApplicant: ['city_or_township_governments', 'special_district_governments'], foundationSeeker: false, wantsResearch: false },
  local_government: { ggEligibility: ['01', '02', '04'], simplerApplicant: ['county_governments', 'city_or_township_governments'], foundationSeeker: false, wantsResearch: false },
  public_agency: { ggEligibility: ['00', '01', '02', '04'], simplerApplicant: ['state_governments', 'county_governments'], foundationSeeker: false, wantsResearch: false },
  state_local_gov: { ggEligibility: ['00', '01', '02', '04'], simplerApplicant: ['state_governments', 'county_governments', 'city_or_township_governments'], foundationSeeker: false, wantsResearch: false },
})

// Unknown / unset profile type: cast wide but still avoid pure noise.
const DEFAULT_PLAN = Object.freeze({
  ggEligibility: ['99', '25'],
  simplerApplicant: [],
  foundationSeeker: true,
  wantsResearch: false,
})

// buildProfileSignals() emits a category Set per facet of the profile. We mine
// ALL of the discriminating ones for live-source queries — not just keywords —
// so a veteran's "veteran", a dialysis patient's condition, a single parent's
// family status, a nurse's occupation, and a heritage scholarship demographic
// each reach Grants.gov/NIH/NSF/SAM/Simpler/ProPublica. Ordered by discriminating
// power: facets that map to a dedicated funder pool come first, so a bounded
// maxTerms slice still keeps breadth across the profile.
//   (genders / applicantTypes are deliberately omitted — gender alone is a poor
//    funder query, and applicant type is already encoded as eligibility codes.)
const SIGNAL_CATEGORY_ORDER = Object.freeze([
  'health', // disease/disability foundations, NIH, condition-specific aid
  'military', // VA, veteran service orgs, military-family relief
  'occupation', // profession-specific relief (nurses, teachers, first responders)
  'family', // single-parent, foster, caregiver, widow funds
  'demographics', // heritage/race/identity scholarships & funds
  'needs', // explicit need categories (housing, food, childcare…)
  'assistance', // benefit programs (SNAP, LIHEAP, housing vouchers)
  'geographic', // place-based (opportunity zone, appalachian, tribal land)
  'immigration', // refugee/immigrant/new-American programs
  'interests', // program/focus areas the applicant declared
  'keywords', // broad catch-all — lowest discriminating power, so it goes last
])

// Content-free single tokens make useless keyword searches (they match the whole
// pool, or none of it) and would waste a slot in the per-source query budget.
// Multi-word phrases are always kept — they carry real specificity.
const GENERIC_STOP_TERMS = new Set([
  'assistance', 'help', 'support', 'aid', 'need', 'needs', 'fund', 'funds',
  'funding', 'grant', 'grants', 'program', 'programs', 'service', 'services',
  'general', 'other', 'misc', 'individual', 'person', 'people', 'family',
  'money', 'cash', 'benefit', 'benefits', 'resource', 'resources', 'org',
  'organization', 'nonprofit', 'business', 'opportunity', 'opportunities',
])

/**
 * Collect need/topic search terms from every discriminating facet of the
 * profile. Defensive: tolerates missing sections, arrays, Sets, or strings.
 *
 * Explicit profile needs lead; the remaining facets are interleaved
 * round-robin so a downstream `maxTerms` slice keeps category breadth instead
 * of being monopolised by one facet's variants.
 *
 * @returns {string[]} de-duplicated lowercase terms (most specific first)
 */
export function collectNeedTerms(profileContext = {}, signals = {}) {
  const seen = new Set()
  const clean = (v) => {
    if (v === null || v === undefined) return null
    const s = String(v).toLowerCase().trim().replace(/\s+/g, ' ')
    if (s.length < 3 || s.length > 60) return null
    if (!s.includes(' ') && GENERIC_STOP_TERMS.has(s)) return null
    return s
  }
  const bucketize = (values) => {
    const bucket = []
    const add = (v) => {
      const c = clean(v)
      if (c && !seen.has(c)) {
        seen.add(c)
        bucket.push(c)
      }
    }
    if (values instanceof Set || Array.isArray(values)) values.forEach(add)
    else if (values) add(values)
    return bucket
  }

  const profile = profileContext.profile || {}

  // Explicit, user-stated needs are the strongest signal — front-load them.
  const explicit = bucketize([
    ...(Array.isArray(profile.needs) ? profile.needs : []),
    ...(Array.isArray(profileContext.needs) ? profileContext.needs : []),
    profile.primary_need,
    profile.focus_area,
  ])

  // One bucket per signal category, in discriminating-power order.
  const buckets = SIGNAL_CATEGORY_ORDER.map((key) => bucketize(signals?.[key]))

  // Round-robin across the category buckets: take the 1st of each, then the 2nd
  // of each, and so on. This keeps a veteran-disabled-single-parent-nurse
  // profile from spending its whole term budget on one facet.
  const interleaved = []
  for (let depth = 0, more = true; more; depth += 1) {
    more = false
    for (const bucket of buckets) {
      if (depth < bucket.length) {
        interleaved.push(bucket[depth])
        more = true
      }
    }
  }

  return [...explicit, ...interleaved]
}

/** Resolve the query plan for a profile, merging in derived need terms. */
export function buildConnectorQueryPlan(profileContext = {}, signals = {}) {
  const primaryType = String(profileContext.profile?.primary_type || profileContext.primary_type || '')
    .toLowerCase()
    .trim()
  const base = PROFILE_QUERY_MAP[primaryType] || DEFAULT_PLAN
  const state =
    profileContext.profile?.state ||
    profileContext.signals?.location?.state ||
    signals?.location?.state ||
    null

  const terms = collectNeedTerms(profileContext, signals)

  // Clinical trials / research studies are PERSONAL and OPT-IN. Resolve the
  // profile's health section once so the (gated) clinical-trials source knows
  // whether the participant explicitly opted in and what conditions to query.
  const healthSection =
    profileContext.sections?.health_medical ||
    profileContext.profile?.sections?.health_medical ||
    {}
  const clinicalTrialsOptIn = isOptedIntoClinicalTrials(healthSection)
  const conditionTerms = extractConditionTerms(healthSection)

  // Federal agency NOFOs are applied for by organizations/governments, not by
  // individuals/families/students (who want benefits & scholarships instead).
  // Derived here (not stored per-row in PROFILE_QUERY_MAP) so the map stays lean.
  const INDIVIDUAL_TYPES = new Set([
    'individual', 'family', 'student', 'high_school_student', 'college_student',
  ])

  return {
    primaryType: primaryType || 'unknown',
    profileId: profileContext.profile?.id || profileContext.profileId || null,
    state: state ? String(state) : null,
    terms,
    ...base,
    federalApplicant: !INDIVIDUAL_TYPES.has(primaryType),
    // Opt-in study discovery (clinical trials). Default-OFF: a study is only
    // surfaced when the profile EXPLICITLY consented and has condition terms.
    clinicalTrialsOptIn,
    conditionTerms,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-source ingest helpers. Each returns a coverage row and never throws.
// ─────────────────────────────────────────────────────────────────────────────

async function upsertAll(db, opportunities, row, opts = {}) {
  for (const opp of opportunities) {
    if (!opp) continue
    try {
      const result = await upsertFundingOpportunity(db, opp, opts)
      if (result?.inserted) row.inserted += 1
      else if (result?.updated) row.updated += 1
      else row.skipped += 1
    } catch (err) {
      row.skipped += 1
      row.lastError = err?.message || String(err)
    }
  }
}

async function ingestGrantsGov(db, plan, limits, row) {
  // One eligibility-filtered query per need term, plus one broad eligibility-only
  // query so a sparse profile still gets the right slice of the federal pool.
  const queries = [...plan.terms.slice(0, limits.maxTerms), '']
  for (const keyword of queries) {
    const data = await fetchGrantsGov({
      keyword,
      eligibilities: plan.ggEligibility,
      rows: limits.rowsPerQuery,
    })
    const hits = Array.isArray(data?.oppHits) ? data.oppHits : []
    row.fetched += hits.length
    const transformed = hits
      .filter((o) => !['closed', 'archived'].includes(String(o?.oppStatus || '').toLowerCase()))
      .map((o) => ({
        ...transformGrantsGovOpportunity(o),
        record_origin: 'funding_api',
      }))
    await upsertAll(db, transformed, row)
    await sleep(limits.delayMs)
  }
}

async function ingestSimplerGrants(db, plan, limits, row) {
  const filters = {
    opportunity_status: { one_of: ['posted', 'forecasted'] },
    ...(plan.simplerApplicant.length ? { applicant_type: { one_of: plan.simplerApplicant } } : {}),
  }
  const queries = plan.terms.slice(0, limits.maxTerms)
  if (queries.length === 0) queries.push('')
  for (const q of queries) {
    const { opportunities } = await fetchSimplerGrants({
      query: q || undefined,
      queryOperator: q ? 'AND' : undefined,
      pageSize: limits.rowsPerQuery,
      filters,
    })
    row.fetched += opportunities.length
    await upsertAll(db, opportunities, row)
    await sleep(limits.delayMs)
  }
}

async function ingestSamListings(db, plan, limits, row) {
  const queries = plan.terms.slice(0, limits.maxTerms)
  if (queries.length === 0) queries.push('')
  for (const keyword of queries) {
    const { opportunities } = await fetchAssistanceListings({
      keyword: keyword || undefined,
      assistanceType: 'grant',
      limit: limits.rowsPerQuery,
    })
    row.fetched += opportunities.length
    // Assistance listings are programs (not dated postings) — allow directories.
    await upsertAll(db, opportunities, row, { allowDirectories: true })
    await sleep(limits.delayMs)
  }
}

async function ingestNihReporter(db, plan, limits, row) {
  const queries = plan.terms.slice(0, limits.maxTerms)
  if (queries.length === 0) return // never run a blank NIH sweep — pure noise
  for (const text of queries) {
    const opportunities = await fetchNihReporter({ text, limit: limits.rowsPerQuery })
    row.fetched += opportunities.length
    await upsertAll(db, opportunities, row, { allowDirectories: true })
    await sleep(limits.delayMs)
  }
}

async function ingestNsfAwards(db, plan, limits, row) {
  // NSF funded awards (science/engineering/education). Historical, like NIH —
  // never run a blank sweep; bias to the awardee state when known.
  const queries = plan.terms.slice(0, limits.maxTerms)
  if (queries.length === 0) return
  for (const keyword of queries) {
    const opportunities = await fetchNsfAwards({
      keyword,
      ...(plan.state ? { awardeeStateCode: String(plan.state).slice(0, 2).toUpperCase() } : {}),
      limit: limits.rowsPerQuery,
    })
    row.fetched += opportunities.length
    await upsertAll(db, opportunities, row, { allowDirectories: true })
    await sleep(limits.delayMs)
  }
}

async function ingestFederalRegister(db, plan, limits, row) {
  // Cross-agency NOFO/NOFA notices. The connector itself hard-filters to real
  // funding notices, so a blank sweep is safe and useful for sparse profiles.
  const queries = plan.terms.slice(0, limits.maxTerms)
  if (queries.length === 0) queries.push('funding opportunity grant')
  for (const keyword of queries) {
    const opportunities = await fetchFederalRegister({
      keyword,
      perPage: 250,
      sinceDays: 365,
    })
    row.fetched += opportunities.length
    await upsertAll(db, opportunities, row)
    await sleep(limits.delayMs)
  }
}

async function ingestFoundations(db, plan, limits, row) {
  // Surface real grantmakers (501c3 foundations) near the profile, by need.
  const queries = plan.terms.slice(0, limits.maxTerms)
  if (queries.length === 0) return
  for (const q of queries) {
    const { organizations } = await searchOrganizations({
      q,
      ...(plan.state ? { state: String(plan.state).slice(0, 2) } : {}),
      c_code: '3', // 501(c)(3)
    })
    // Keep only orgs that actually pay grants — a recipient charity is not a funder.
    const funders = organizations.filter((o) => Number(o.grant_amount) > 0)
    row.fetched += funders.length
    const opps = funders.map(orgToFundingOpportunity)
    await upsertAll(db, opps, row, { allowDirectories: true })
    await sleep(limits.delayMs)
  }
}

async function ingestUsaSpending(db, plan, limits, row) {
  // Past federal grant awards = funder-lead intelligence (which agencies fund
  // this profile's needs). Keyword-driven; never a blank sweep — that would pull
  // unrelated mega-awards. Records store inactive/historical, like NIH & NSF, so
  // they surface as leads, not as open opportunities.
  const queries = plan.terms.slice(0, limits.maxTerms)
  if (queries.length === 0) return
  for (const keyword of queries) {
    const { opportunities } = await fetchUSASpending({ keyword, limit: limits.rowsPerQuery })
    row.fetched += opportunities.length
    await upsertAll(db, opportunities, row, { allowDirectories: true })
    await sleep(limits.delayMs)
  }
}

async function ingestClinicalTrials(db, plan, limits, row) {
  // OPT-IN ONLY. The gate already guarantees plan.clinicalTrialsOptIn === true,
  // but we re-assert here so this can never surface a study for a profile that
  // did not explicitly consent (defense in depth — the user's choice is sacred).
  if (!plan.clinicalTrialsOptIn) return
  const conditions = Array.isArray(plan.conditionTerms) ? plan.conditionTerms : []
  if (conditions.length === 0) return // no diagnosis = nothing relevant to surface

  const studies = await searchClinicalTrials({
    conditions,
    state: plan.state ? String(plan.state).slice(0, 2).toUpperCase() : null,
    maxConditions: Math.max(1, Math.min(limits.maxTerms, conditions.length)),
    pageSize: limits.rowsPerQuery,
  })
  row.fetched += studies.length
  // Tag every row to the consenting profile so it is profile-scoped (pipeline
  // exclusion + tenancy), and so it can never bleed to a non-consenting profile.
  const profileId = plan.profileId || null
  const tagged = studies.map((s) => ({ ...s, profile_id: profileId }))
  // Studies are rolling/standing listings (not dated award postings) — allow
  // directories so the reality gate treats the recruiting listing as valid.
  await upsertAll(db, tagged, row, { allowDirectories: true })
}

// `keyed` marks sources whose gate failure means "no API key" (vs. simply
// not-applicable to this profile). Drives honest status in the coverage report.
const SOURCES = [
  { key: 'grants.gov', run: ingestGrantsGov, keyed: false, gate: () => true },
  { key: 'federal.register', run: ingestFederalRegister, keyed: false, gate: (plan) => plan.federalApplicant },
  { key: 'simpler.grants.gov', run: ingestSimplerGrants, keyed: true, gate: () => Boolean(process.env.SIMPLER_GRANTS_API_KEY) },
  { key: 'sam.assistance', run: ingestSamListings, keyed: true, gate: () => Boolean(process.env.SAM_GOV_PUBLIC_API_KEY) },
  { key: 'nih.reporter', run: ingestNihReporter, keyed: false, gate: (plan) => plan.wantsResearch },
  { key: 'nsf.awards', run: ingestNsfAwards, keyed: false, gate: (plan) => plan.wantsResearch },
  { key: 'propublica.990', run: ingestFoundations, keyed: false, gate: (plan) => plan.foundationSeeker },
  // Federal award history = funder leads for orgs/governments (not individuals,
  // who want benefits/scholarships). Keyless; gated like Federal Register.
  { key: 'usaspending.gov', run: ingestUsaSpending, keyed: false, gate: (plan) => plan.federalApplicant },
  // Clinical trials / research studies (ClinicalTrials.gov, no key). STUDIES,
  // not funding. EXPLICIT OPT-IN ONLY — gate is false unless the profile
  // consented AND has at least one condition to match. Discovery/display only;
  // the user enrolls themselves on the real study page.
  {
    key: 'clinicaltrials.gov',
    run: ingestClinicalTrials,
    keyed: false,
    gate: (plan) => Boolean(plan.clinicalTrialsOptIn) && (plan.conditionTerms?.length ?? 0) > 0,
  },
]

/**
 * Run profile-driven ingest across every connector.
 *
 * @param {Object} args
 * @param {Object} args.db                 - DB handle (sqlite or pg shim)
 * @param {Object} args.profileContext     - { profile, sections, signals, ... }
 * @param {Object} [args.signals]          - buildProfileSignals() output (optional)
 * @param {Object} [args.limits]
 * @param {number} [args.limits.maxTerms=8]      - need terms used per source (env: CONNECTOR_INGEST_MAX_TERMS)
 * @param {number} [args.limits.rowsPerQuery=25] - rows requested per query
 * @param {number} [args.limits.delayMs=300]     - politeness delay between calls
 * @param {string[]} [args.onlySources]    - if set, run ONLY these source keys
 * @returns {Promise<{ plan: Object, coverage: Array, totals: Object }>}
 */
export async function ingestFromConnectors({ db, profileContext = {}, signals = {}, limits = {}, onlySources = null } = {}) {
  if (!db) throw new Error('ingestFromConnectors requires a db handle')

  // maxTerms bounds how many of the (now category-diverse) profile terms each
  // source is queried with. 4 was far too tight — it starved every facet past
  // the first one or two. 8 keeps breadth while staying polite; tune per
  // environment via CONNECTOR_INGEST_MAX_TERMS without a code change.
  const envMaxTerms = Number.parseInt(process.env.CONNECTOR_INGEST_MAX_TERMS ?? '', 10)
  const defaultMaxTerms = Number.isFinite(envMaxTerms) && envMaxTerms > 0 ? envMaxTerms : 8
  const effLimits = {
    maxTerms: Number.isFinite(limits.maxTerms) ? limits.maxTerms : defaultMaxTerms,
    rowsPerQuery: Number.isFinite(limits.rowsPerQuery) ? limits.rowsPerQuery : 25,
    delayMs: Number.isFinite(limits.delayMs) ? limits.delayMs : 300,
  }

  const plan = buildConnectorQueryPlan(profileContext, signals)
  log.info('[connectorIngest] plan', {
    primaryType: plan.primaryType,
    state: plan.state,
    terms: plan.terms.slice(0, effLimits.maxTerms),
    ggEligibility: plan.ggEligibility,
  })

  const sourceFilter = Array.isArray(onlySources) && onlySources.length
    ? new Set(onlySources)
    : null

  const coverage = []
  for (const source of SOURCES) {
    if (sourceFilter && !sourceFilter.has(source.key)) continue
    const row = { source: source.key, fetched: 0, inserted: 0, updated: 0, skipped: 0, status: 'ok' }
    if (!source.gate(plan)) {
      row.status = source.keyed ? 'no_api_key' : 'not_applicable'
      coverage.push(row)
      continue
    }
    try {
      await source.run(db, plan, effLimits, row)
    } catch (err) {
      // MISSING_API_KEY and transient failures land here — recorded, never fatal.
      row.status = err?.code === 'MISSING_API_KEY' ? 'no_api_key' : 'error'
      row.lastError = err?.message || String(err)
      log.warn(`[connectorIngest] ${source.key} failed: ${row.lastError}`)
    }
    coverage.push(row)
  }

  const totals = coverage.reduce(
    (acc, r) => ({
      fetched: acc.fetched + r.fetched,
      inserted: acc.inserted + r.inserted,
      updated: acc.updated + r.updated,
      skipped: acc.skipped + r.skipped,
    }),
    { fetched: 0, inserted: 0, updated: 0, skipped: 0 },
  )

  log.info('[connectorIngest] complete', { totals, coverage })
  return { plan, coverage, totals }
}

export default { ingestFromConnectors, buildConnectorQueryPlan, collectNeedTerms, PROFILE_QUERY_MAP }
