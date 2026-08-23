/**
 * robertSourceAcquisition.js — Robert as an ACTIVE source-finder.
 *
 * OWNER DIRECTIVE (2026-08-23, verbatim): "Expand agent Robert's role into
 * finding real sources and add them to GrantFlow's database, whether they be a
 * URL that opens an application OR a page like ScholarshipOwl that is a set of
 * scholarships. Then, once inside GrantFlow's database, parse the sources
 * against existing profiles and auto-add them to the profile. Doing the same
 * with future profiles once they join GrantFlow. That way, not only are we
 * crawling the internet, we are looking at predetermined resources."
 *
 * NORTH STAR (owner): "if grandma is giving away cookies down the street for
 * students, I want GrantFlow to find it." GrantFlow blind-crawls and MISSES
 * sources the models already KNOW (SBA / Hello Alice / Amber Grant for a small
 * business; ScholarshipOwl / Scholarships.com / Fastweb for students). So we
 * ALSO work PREDETERMINED resources, not only crawl.
 *
 * TWO SOURCE SHAPES, both handled:
 *   (a) a URL that opens an APPLICATION  → ingested as an applyable opportunity
 *       through the CANONICAL admission gate (opportunityInserter
 *       .upsertFundingOpportunity — reality gate + dedup, the ONLY door).
 *   (b) a HUB page (ScholarshipOwl / Scholarships.com / a foundation's
 *       scholarship listing) → DECOMPOSED into the individual awards it lists
 *       via the EXISTING, fabrication-guarded
 *       hamilton/listingDecomposition.decomposeListing, each award admitted
 *       through the same canonical inserter. We never fork the decomposer.
 *
 * THEN: every newly-admitted catalog source is parsed against EVERY profile
 * with Robert's FOUR-GATE qualification (RELATABLE / QUALIFIES / COVERS-A-NEED /
 * REAL), and the passers are AUTO-ADDED to that profile's pipeline — gated on
 * QUALIFICATION, NOT the fuzzy relevance-score floor (which buries
 * grantmaker-style rows). No approval queue: the publish toggle is the only
 * human gate, so a qualifying source is ADDED.
 *
 * SAFETY (carried from #1346): a source Hamilton could COLD-auto-submit for a
 * fully-autonomous profile must be genuinely apply-ready — an application URL or
 * a decomposed award, NEVER a hub landing page or an info/account page. The
 * apply_ready vs funder_lead split (config/pipelineCategory.js) is decided by
 * #2's applyability classifier (sourceApplyability.classifyApplyability) when
 * merged, else by a strict structural fallback here — a hub/info page can never
 * be marked apply_ready.
 *
 * INTEGRATION (consumes, never forks):
 *   #1  config/profileSourceArchetypes.js  — SOURCE_ARCHETYPES, the predetermined
 *       resources + query patterns per profile type. Lazily imported; a thin
 *       built-in FALLBACK keeps the feature functioning before #1 merges.
 *   #2  config/sourceApplyability.js       — classifyApplyability (apply_ready vs
 *       funder_lead). Lazily imported; strict structural fallback otherwise.
 *   #1346 config/pipelineCategory.js + robertFunderLeads.js — the category split.
 */

import crypto from 'crypto'
import { createLogger } from '../../utils/logger.js'
import { upsertFundingOpportunity } from '../opportunityInserter.js'
import { decomposeListing as canonicalDecomposeListing } from '../hamilton/listingDecomposition.js'
import {
  PIPELINE_CATEGORY,
  FUNDER_LEAD_STATE,
  hasUsableApplyPath,
} from '../../config/pipelineCategory.js'
import { looksLikeApplicationPath } from './robertFunderLeads.js'
import { isDismissed } from '../pipelineDismissals.js'
import {
  loadProfileFacts as canonicalLoadProfileFacts,
  gateRelatable,
  gateQualifies,
  gateCoversNeed,
  gateRealOffline,
  PROTECTED_GRANT_STATUSES,
} from './robertPipelineAudit.js'

const log = createLogger('robert-source-acquisition')

export const ACQUISITION_MATCHER_VERSION = 'robert-source-acquisition'

function boundedInt(envName, dflt, min) {
  const n = Number.parseInt(process.env[envName] || '', 10)
  return Number.isFinite(n) && n >= min ? n : dflt
}
function parseBoolEnv(v) {
  if (v === undefined || v === null || v === '') return null
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase())
}
function isPg(db) {
  return (db?.dialect || 'sqlite') === 'postgres'
}

/** How many awards a single hub is decomposed into per pass. */
const HUB_MAX_ITEMS = boundedInt('ROBERT_ACQUIRE_HUB_MAX_ITEMS', 25, 1)
/** How many profiles a single acquisition cycle scans. */
const ACQUIRE_PROFILE_LIMIT = boundedInt('ROBERT_ACQUIRE_PROFILE_LIMIT', 200, 1)
/** How many auto-adds a single profile may gain per parse pass. */
export const AUTOADD_PER_PROFILE_CAP = boundedInt('ROBERT_ACQUIRE_AUTOADD_PER_PROFILE', 25, 1)
/** Fleet-wide auto-add write cap per parse pass. */
export const AUTOADD_WRITE_LIMIT = boundedInt('ROBERT_ACQUIRE_AUTOADD_LIMIT', 1000, 1)

// ---------------------------------------------------------------------------
// Predetermined-resource archetypes (#1's contract, with a thin fallback)
// ---------------------------------------------------------------------------

/**
 * A KNOWN, real, model-known funding surface keyed by a coarse profile root.
 * Every URL here is a real page; a hub is DECOMPOSED (never ingested whole as an
 * opportunity), an application is ingested directly. This fallback exists ONLY
 * so the feature functions and is prod-verifiable before #1's richer
 * `profileSourceArchetypes.js` merges; #1's data supersedes it on rebase.
 *
 * shape: { title, sponsor, url, shape: 'application' | 'hub',
 *          applicant_types: string[], need_categories: string[] }
 */
export const FALLBACK_ARCHETYPE_SOURCES = Object.freeze({
  small_business: [
    { title: 'Amber Grant for Women', sponsor: 'WomensNet', url: 'https://ambergrantsforwomen.com/', shape: 'application', applicant_types: ['small_business'], need_categories: ['business_funding'] },
    { title: 'Hello Alice Small Business Grants', sponsor: 'Hello Alice', url: 'https://helloalice.com/grants/', shape: 'hub', applicant_types: ['small_business'], need_categories: ['business_funding'] },
    { title: 'SBA Funding Programs — Grants', sponsor: 'U.S. Small Business Administration', url: 'https://www.sba.gov/funding-programs/grants', shape: 'hub', applicant_types: ['small_business'], need_categories: ['business_funding'] },
  ],
  student: [
    { title: 'Scholarships.com Scholarship Directory', sponsor: 'Scholarships.com', url: 'https://www.scholarships.com/', shape: 'hub', applicant_types: ['student'], need_categories: ['education'] },
    { title: 'Fastweb Scholarship Search', sponsor: 'Fastweb', url: 'https://www.fastweb.com/', shape: 'hub', applicant_types: ['student'], need_categories: ['education'] },
    { title: 'Bold.org Scholarships', sponsor: 'Bold.org', url: 'https://bold.org/scholarships/', shape: 'hub', applicant_types: ['student'], need_categories: ['education'] },
  ],
  nonprofit: [
    { title: 'Grants.gov — Find Grant Opportunities', sponsor: 'Grants.gov', url: 'https://www.grants.gov/search-grants', shape: 'hub', applicant_types: ['nonprofit'], need_categories: ['operating_support'] },
    { title: 'Candid Foundation Directory', sponsor: 'Candid', url: 'https://candid.org/find-funding', shape: 'hub', applicant_types: ['nonprofit'], need_categories: ['operating_support'] },
  ],
  veteran: [
    { title: 'SBA Veteran-Owned Business Resources', sponsor: 'U.S. Small Business Administration', url: 'https://www.sba.gov/business-guide/grow-your-business/veteran-owned-businesses', shape: 'hub', applicant_types: ['veteran', 'small_business'], need_categories: ['business_funding'] },
  ],
})

/** Coarse root of a profile, for the fallback archetype table. */
function profileRootKey(facts) {
  const t = String(facts?.applicantType ?? '').toLowerCase()
  if (!t) return null
  if (/(small_business|business|entrepreneur|startup|company|llc)/.test(t)) return 'small_business'
  if (/(student|scholar|college|university|high_school|graduate)/.test(t)) return 'student'
  if (/(veteran|military)/.test(t)) return 'veteran'
  if (/(nonprofit|ngo|charit|foundation|church|ministry|organization)/.test(t)) return 'nonprofit'
  return null
}

/**
 * Resolve the KNOWN/predetermined sources for a profile. Prefers #1's
 * `knownSeedSourcesForProfile`; falls back to the built-in table above.
 * Normalizes every entry to { title, sponsor, url, shape, applicant_types,
 * need_categories }.
 */
export async function resolveKnownSourcesForProfile(facts, { deps = {} } = {}) {
  let seeds = null
  const resolver = deps.knownSeedSourcesForProfile
  if (typeof resolver === 'function') {
    try { seeds = await resolver(facts?.profile ?? null, facts?.sections ?? {}) } catch { seeds = null }
  } else {
    try {
      const mod = await import('../../config/profileSourceArchetypes.js')
      if (typeof mod.knownSeedSourcesForProfile === 'function') {
        seeds = await mod.knownSeedSourcesForProfile(facts?.profile ?? null, facts?.sections ?? {})
      }
    } catch { seeds = null }
  }
  if (Array.isArray(seeds) && seeds.length) return seeds.map(normalizeSeed).filter(Boolean)

  // Fallback: the built-in predetermined resources for this profile's root.
  const root = profileRootKey(facts)
  const fallback = (root && FALLBACK_ARCHETYPE_SOURCES[root]) || []
  return fallback.map(normalizeSeed).filter(Boolean)
}

function normalizeSeed(seed) {
  if (!seed || typeof seed !== 'object') return null
  const url = typeof seed.url === 'string' ? seed.url.trim()
    : typeof seed.source_url === 'string' ? seed.source_url.trim()
    : typeof seed.application_url === 'string' ? seed.application_url.trim() : null
  if (!url || !/^https?:\/\//i.test(url)) return null
  // Shape may be declared (fallback table / a future #1 field) or left null — in
  // which case acquisition resolves it from #2's applyability (a not-applyable
  // page, e.g. ScholarshipOwl / a benefit portal, is a HUB to decompose; an
  // application form is ingested directly). #1's seeds are {url,title,snippet}
  // with no shape, so this is the normal path.
  const declared = String(seed.shape || seed.kind || '').toLowerCase()
  const shape = declared === 'hub' ? 'hub'
    : declared === 'application' ? 'application'
    : (seed.is_hub === true ? 'hub' : null)
  return {
    title: String(seed.title || seed.name || seed.sponsor || url).slice(0, 300),
    sponsor: seed.sponsor || seed.funder || seed.name || null,
    url,
    shape,
    applicant_types: Array.isArray(seed.applicant_types) ? seed.applicant_types : [],
    need_categories: Array.isArray(seed.need_categories) ? seed.need_categories : [],
  }
}

/**
 * Resolve whether a seed is a HUB (a page listing several awards → decompose) or
 * an APPLICATION (a single form → ingest). Prefers #2's applyability tiering;
 * a not-applyable page (info_only / account_portal) is a hub. Falls back to
 * 'application' when #2 is unavailable and nothing is declared — a hub homepage
 * ingested that way becomes a DIRECTORY row that the RELATABLE gate then refuses
 * to auto-add whole (harvest_first), so nothing unsafe reaches a profile.
 */
async function resolveSeedShape(seed, deps = {}) {
  if (seed.shape === 'hub' || seed.shape === 'application') return seed.shape
  const classifier = await loadApplyabilityClassifier(deps)
  if (typeof classifier === 'function') {
    try {
      const verdict = await classifier({ application_url: seed.url, source_url: seed.url, url: seed.url, title: seed.title })
      const applyable = verdict?.isApplyable === true || verdict?.apply_ready === true || verdict?.applyable === true
      const tier = String(verdict?.tier || '').toLowerCase()
      if (applyable || tier === 'online_form' || tier === 'mail_or_pdf') return 'application'
      if (tier === 'info_only' || tier === 'account_portal' || verdict?.isApplyable === false) return 'hub'
    } catch { /* fall through */ }
  }
  return 'application'
}

let _applyabilityClassifier = undefined
async function loadApplyabilityClassifier(deps = {}) {
  if (typeof deps.classifyApplyability === 'function') return deps.classifyApplyability
  if (_applyabilityClassifier !== undefined) return _applyabilityClassifier
  try {
    const mod = await import('../../config/sourceApplyability.js')
    _applyabilityClassifier = typeof mod.classifyApplyability === 'function' ? mod.classifyApplyability : null
  } catch { _applyabilityClassifier = null }
  return _applyabilityClassifier
}

// ---------------------------------------------------------------------------
// Applyability (#2's contract, with a strict structural fallback)
// ---------------------------------------------------------------------------

/**
 * Decide the pipeline category for an auto-added source. #2 owns the real
 * classifier; the fallback is deliberately STRICT so a hub/info page can never
 * be marked apply_ready (the Hamilton cold-submit safety rule).
 *
 * @returns {'apply_ready' | 'funder_lead'}
 */
export async function classifyPipelineCategory(oppRow, { deps = {} } = {}) {
  const classifier = await loadApplyabilityClassifier(deps)
  if (typeof classifier === 'function') {
    try {
      const verdict = await classifier(oppRow)
      if (verdict && typeof verdict === 'object') {
        // #2's contract: { tier, isApplyable, reason } — isApplyable is the
        // authority for whether Hamilton may ever cold-submit it.
        if (verdict.isApplyable === true || verdict.apply_ready === true || verdict.applyable === true) return PIPELINE_CATEGORY.APPLY_READY
        if (verdict.isApplyable === false || verdict.apply_ready === false || verdict.applyable === false) return PIPELINE_CATEGORY.FUNDER_LEAD
      }
      if (verdict === true) return PIPELINE_CATEGORY.APPLY_READY
      if (verdict === false) return PIPELINE_CATEGORY.FUNDER_LEAD
    } catch { /* fall through to structural fallback */ }
  }
  return structuralApplyable(oppRow) ? PIPELINE_CATEGORY.APPLY_READY : PIPELINE_CATEGORY.FUNDER_LEAD
}

/**
 * Structural apply-readiness: a usable (non-search-engine) http apply/application
 * path whose PATH looks like an application surface (not a bare hub homepage).
 * The caller only reaches this after the RELATABLE gate already rejected pointer
 * kinds, so a directory hub never arrives here — this is a second line of
 * defense for an info/account page that is not a pointer but is not applyable.
 */
export function structuralApplyable(oppRow) {
  if (!hasUsableApplyPath(oppRow)) return false
  const applyUrl = oppRow?.application_url || oppRow?.apply_url || oppRow?.portal_url || null
  if (applyUrl && looksLikeApplicationPath(applyUrl)) return true
  // A decomposed listing award carries its own application_url; if that is
  // present and usable it is apply-ready even when the path is generic.
  const decomposed = oppRow?.record_origin === 'scholarship_crawler' || oppRow?.source === 'scholarship_crawler'
  return decomposed && Boolean(applyUrl)
}

// ---------------------------------------------------------------------------
// Catalog acquisition — ingest applications, decompose hubs
// ---------------------------------------------------------------------------

/**
 * Acquire the KNOWN/predetermined sources for a set of profiles into the CATALOG
 * through the canonical inserter. Hubs are decomposed; applications ingested.
 *
 * @returns accounting incl. `admittedOpportunityIds` (the freshly-admitted
 *   catalog rows the parse pass then adjudicates against every profile).
 */
export async function acquireKnownSources(db, {
  profileIds = null,
  writeLimit = boundedInt('ROBERT_ACQUIRE_WRITE_LIMIT', 500, 1),
  deps = {},
  allowHubDecomposition = true,
} = {}) {
  const out = {
    profiles: 0, sourcesConsidered: 0, ingested: 0, decomposedAdmitted: 0,
    hubsDecomposed: 0, hubsSkipped: 0, byReason: {}, admittedOpportunityIds: [],
    examples: [], skipped: null,
  }
  const bump = (r) => { out.byReason[r] = (out.byReason[r] || 0) + 1 }
  const insert = deps.insert || ((d, rec, o) => upsertFundingOpportunity(d, rec, o))
  const decompose = deps.decomposeListing || canonicalDecomposeListing
  // fetchPage(url) => { text, links[], title } | null. Absent by default: hub
  // decomposition needs a live, SSRF-safe fetch which the scheduler wires; on
  // the request path / in tests it is honestly reported unavailable.
  const fetchPage = deps.fetchPage || null

  let ids = Array.isArray(profileIds) && profileIds.length ? profileIds.map(String) : null
  if (!ids) {
    try {
      const rows = await db.prepare(
        "SELECT id FROM profiles WHERE (deleted_at IS NULL) AND (status IS NULL OR status <> 'deleted') LIMIT ?",
      ).all(ACQUIRE_PROFILE_LIMIT)
      ids = (rows || []).map((r) => String(r.id))
    } catch {
      try { ids = (await db.prepare('SELECT id FROM profiles LIMIT ?').all(ACQUIRE_PROFILE_LIMIT) || []).map((r) => String(r.id)) } catch { ids = [] }
    }
  }

  const admitted = new Set()
  for (const profileId of ids) {
    if (out.ingested + out.decomposedAdmitted >= writeLimit) break
    let facts
    try { facts = await loadFactsCached(db, profileId, deps) } catch { continue }
    if (!facts?.profile) continue

    let seeds
    try { seeds = await resolveKnownSourcesForProfile(facts, { deps }) } catch { seeds = [] }
    if (!seeds.length) continue
    out.profiles += 1

    for (const seed of seeds) {
      if (out.ingested + out.decomposedAdmitted >= writeLimit) break
      out.sourcesConsidered += 1
      const shape = await resolveSeedShape(seed, deps)

      if (shape === 'hub') {
        if (!allowHubDecomposition || typeof fetchPage !== 'function') { out.hubsSkipped += 1; bump('hub_fetch_unavailable'); continue }
        let page = null
        try { page = await fetchPage(seed.url) } catch { page = null }
        if (!page || (!page.text && !(Array.isArray(page.links) && page.links.length))) { out.hubsSkipped += 1; bump('hub_unreadable'); continue }
        let result
        try {
          result = await decompose(
            { db, profile: facts.profile, profileSections: facts.sections, listing: { url: seed.url, title: page.title || seed.title, text: page.text || '', links: page.links || [] }, maxItems: HUB_MAX_ITEMS },
            {},
          )
        } catch (err) { out.hubsSkipped += 1; bump(`hub_decompose_error:${String(err?.message || err).slice(0, 40)}`); continue }
        out.hubsDecomposed += 1
        for (const item of result?.items || []) {
          if (item?.opportunity_id && !admitted.has(item.opportunity_id)) {
            admitted.add(item.opportunity_id)
            out.decomposedAdmitted += 1
            if (out.examples.length < 8) out.examples.push(`hub-award:${item.title || item.opportunity_id}`)
          }
        }
        if (result?.enumeration_unavailable) bump('hub_enumeration_unavailable')
        continue
      }

      // shape === 'application' — ingest directly through the canonical door.
      const record = {
        title: seed.title,
        sponsor: seed.sponsor,
        source: 'curated_verified',
        record_origin: 'curated_verified',
        source_url: seed.url,
        application_url: seed.url,
        final_url: seed.url,
        entity_types_allowed: seed.applicant_types.length ? seed.applicant_types : null,
        need_types_supported: seed.need_categories.length ? seed.need_categories : null,
        raw_meta: { robert_acquired: true, archetype_seed: true },
      }
      let ins
      try { ins = await insert(db, record, { allowDirectories: true, allowExpired: true }) } catch (err) { bump(`ingest_error:${String(err?.message || err).slice(0, 40)}`); continue }
      if (!ins || ins.skipped) { bump(`ingest_skipped:${ins?.reason || 'unknown'}`.slice(0, 60)); continue }
      const oid = ins.id
      if (oid && !admitted.has(oid)) {
        admitted.add(oid)
        out.ingested += 1
        if (out.examples.length < 8) out.examples.push(`app:${seed.title}`)
      } else if (oid) {
        bump('ingest_deduped')
      }
    }
  }

  out.admittedOpportunityIds = [...admitted]
  return out
}

// ---------------------------------------------------------------------------
// Parse admitted sources against profiles + auto-add qualifiers
// ---------------------------------------------------------------------------

const _factsCache = new Map()
async function loadFactsCached(db, profileId, deps = {}) {
  const key = String(profileId)
  if (_factsCache.has(key)) return _factsCache.get(key)
  const loader = typeof deps.loadProfileFacts === 'function' ? deps.loadProfileFacts : canonicalLoadProfileFacts
  const facts = await loader(db, profileId)
  _factsCache.set(key, facts)
  return facts
}

async function loadOpportunityRow(db, oppId) {
  try {
    const row = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(oppId))
    if (!row) return null
    // Normalize the fields the gates read (mirror robertPipelineAudit.loadPipelineRows).
    return {
      ...row,
      application_url: row.application_url || row.apply_url || row.source_url || row.url || null,
      source_url: row.source_url || row.final_url || row.evidence_url || row.url || null,
    }
  } catch { return null }
}

/**
 * Run Robert's four gates for one (opportunity, profile) pair. REAL uses the
 * DETERMINISTIC half only — the row was just admitted through the inserter's
 * reality gate + a liveness probe, so a boot/parse pass never spends the network
 * again, and an outage never reads as "dead".
 *
 * ADMISSION requires a POSITIVE declared-need match (requirePositiveNeed) — the
 * owner's PIPELINE PRECISION bar ("at least PART of a declared need"). The audit
 * gate `gateCoversNeed` FAILS OPEN on silence (correct for REMOVAL — silence is
 * not a denial), but for ADDITION that fail-open is what floods a profile with
 * sources serving needs it never declared (measured on prod: Olivia got 19
 * scholarships/job-postings/benefits with no declared-need overlap). So a source
 * is auto-added only when the opportunity's own need vocabulary POSITIVELY
 * overlaps a need the profile DECLARED (`evidence.matched` non-empty).
 *
 * @returns { pass: boolean, reason: string|null, harvest_first?: boolean }
 */
export function qualifyForProfile(oppRow, facts, { now = new Date(), requirePositiveNeed = true } = {}) {
  const relatable = gateRelatable(oppRow, { now })
  if (!relatable.pass) {
    // A hub/pointer is harvested (decomposed), never auto-added whole.
    return { pass: false, reason: relatable.reason || 'not_relatable', harvest_first: relatable.harvest_first === true }
  }
  const qualifies = gateQualifies(oppRow, facts)
  if (!qualifies.pass) return { pass: false, reason: qualifies.reason || 'not_qualified' }
  const covers = gateCoversNeed(oppRow, facts)
  if (!covers.pass) return { pass: false, reason: covers.reason || 'need_not_covered' }
  // ADMISSION bar: a positive declared-need overlap, not just fail-open silence.
  if (requirePositiveNeed && !(Array.isArray(covers.evidence?.matched) && covers.evidence.matched.length > 0)) {
    return { pass: false, reason: 'covers_need:no_positive_declared_match' }
  }
  const realOffline = gateRealOffline(oppRow, { now })
  if (realOffline && realOffline.pass === false) return { pass: false, reason: realOffline.reason || 'not_real' }
  return { pass: true, reason: null }
}

async function grantColumnSet(db) {
  try {
    if (isPg(db)) {
      const rows = await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='grants'").all()
      return new Set((rows || []).map((r) => String(r.column_name)))
    }
    const rows = await db.prepare('PRAGMA table_info(grants)').all()
    return new Set((rows || []).map((r) => String(r.name)))
  } catch { return new Set() }
}

/**
 * Auto-add a qualifying opportunity to a profile's pipeline. Raw insert (like
 * robertFunderLeads.admitFunderLeads) so admission is gated on QUALIFICATION,
 * not the fuzzy relevance-score floor that buries grantmaker-style rows. The
 * pipeline_category (apply_ready vs funder_lead) decides whether Hamilton may
 * ever cold-submit it.
 */
async function autoAddToProfile(db, { profileId, oppRow, facts, category, cols }) {
  const isLead = category === PIPELINE_CATEGORY.FUNDER_LEAD
  const noteLine = isLead
    ? `Robert auto-added (funder lead): ${oppRow.sponsor || oppRow.title} — qualifies for [${[...(facts.needs || [])].slice(0, 6).join(', ')}]. Under investigation — confirm an application path before applying.`
    : `Robert auto-added (apply-ready): ${oppRow.title} — real, relatable, covers a declared need, and the profile qualifies.`
  const grantId = crypto.randomUUID()
  const insCols = ['id', 'profile_id', 'funding_opportunity_id', 'title', 'funder', 'status', 'notes', 'pipeline_category']
  const insVals = [grantId, profileId, oppRow.id, oppRow.title, oppRow.sponsor || oppRow.title || null,
    isLead ? 'interested' : 'saved', noteLine, category]
  const optional = [
    ['organization_id', facts.profile?.organization_id ?? null],
    ['funder_lead_state', isLead ? FUNDER_LEAD_STATE.CANDIDATE : null],
    ['matcher_version', ACQUISITION_MATCHER_VERSION],
    ['application_url', oppRow.application_url ?? null],
    ['url', oppRow.application_url ?? oppRow.source_url ?? null],
    ['source_url', oppRow.source_url ?? null],
    ['amount_min', oppRow.amount_min ?? null],
    ['amount_max', oppRow.amount_max ?? null],
    ['amount_requested', oppRow.amount_max ?? oppRow.amount_min ?? null],
  ]
  for (const [c, v] of optional) if (cols.has(c)) { insCols.push(c); insVals.push(v) }
  const ph = insCols.map(() => '?').join(', ')
  await db.prepare(`INSERT INTO grants (${insCols.join(', ')}) VALUES (${ph})`).run(...insVals)
}

/**
 * Parse the given catalog opportunities against every profile and AUTO-ADD each
 * qualifier. Idempotent (skips an existing profile↔opportunity link and a
 * tombstoned pair); bounded (per-profile cap + fleet write limit).
 *
 * @returns accounting { added (apply_ready), addedLeads (funder_lead), scanned,
 *   byReason, examples }.
 */
export async function parseOpportunitiesAgainstProfiles(db, {
  opportunityIds = [],
  profileIds = null,
  perProfileCap = AUTOADD_PER_PROFILE_CAP,
  writeLimit = AUTOADD_WRITE_LIMIT,
  countOnly = parseBoolEnv(process.env.ENFORCE_ROBERT_SOURCE_AUTOADD) === false,
  deps = {},
} = {}) {
  const out = {
    scanned: 0, added: 0, addedLeads: 0, wouldAdd: 0, skippedExisting: 0,
    skippedTombstoned: 0, harvestFirst: 0, byReason: {}, perProfileCapped: 0,
    truncated: false, examples: [], skipped: null,
  }
  const bump = (r) => { out.byReason[r] = (out.byReason[r] || 0) + 1 }
  const ids = (Array.isArray(opportunityIds) ? opportunityIds : []).map(String).filter(Boolean)
  if (!ids.length) { out.skipped = 'no_opportunities'; return out }

  const cols = await grantColumnSet(db)
  if (!cols.has('pipeline_category')) { out.skipped = 'schema:pipeline_category'; return out }

  let pids = Array.isArray(profileIds) && profileIds.length ? profileIds.map(String) : null
  if (!pids) {
    try {
      const rows = await db.prepare(
        "SELECT id FROM profiles WHERE (deleted_at IS NULL) AND (status IS NULL OR status <> 'deleted') LIMIT ?",
      ).all(ACQUIRE_PROFILE_LIMIT)
      pids = (rows || []).map((r) => String(r.id))
    } catch { pids = [] }
  }

  // Load each opportunity row once.
  const oppRows = []
  for (const oid of ids) {
    const row = await loadOpportunityRow(db, oid)
    if (row) oppRows.push(row)
  }
  if (!oppRows.length) { out.skipped = 'no_opportunity_rows'; return out }

  const perProfileAdded = new Map()
  for (const profileId of pids) {
    if (out.added + out.addedLeads + out.wouldAdd >= writeLimit) { out.truncated = true; break }
    let facts
    try { facts = await loadFactsCached(db, profileId, deps) } catch { continue }
    if (!facts?.profile) continue

    for (const oppRow of oppRows) {
      if (out.added + out.addedLeads + out.wouldAdd >= writeLimit) { out.truncated = true; break }
      const already = perProfileAdded.get(profileId) || 0
      if (already >= perProfileCap) { out.perProfileCapped += 1; break }
      out.scanned += 1

      const verdict = qualifyForProfile(oppRow, facts)
      if (!verdict.pass) {
        if (verdict.harvest_first) out.harvestFirst += 1
        bump(verdict.reason || 'rejected')
        continue
      }

      // Existing link? (idempotent)
      let linked = false
      try {
        const ex = await db.prepare('SELECT 1 FROM grants WHERE profile_id = ? AND funding_opportunity_id = ? LIMIT 1').get(String(profileId), oppRow.id)
        linked = Boolean(ex)
      } catch { linked = false }
      if (linked) { out.skippedExisting += 1; continue }

      // Tombstone (a source the user explicitly removed stays gone).
      try { if (await isDismissed(db, profileId, oppRow)) { out.skippedTombstoned += 1; continue } } catch { /* recall over suppression */ }

      const category = await classifyPipelineCategory(oppRow, { deps })

      if (countOnly) {
        out.wouldAdd += 1
        perProfileAdded.set(profileId, already + 1)
        if (out.examples.length < 8) out.examples.push(`${category}:${oppRow.title}→${facts.displayName || profileId}`)
        continue
      }

      try {
        await autoAddToProfile(db, { profileId, oppRow, facts, category, cols })
        if (category === PIPELINE_CATEGORY.FUNDER_LEAD) out.addedLeads += 1
        else out.added += 1
        perProfileAdded.set(profileId, already + 1)
        if (out.examples.length < 8) out.examples.push(`${category}:${oppRow.title}→${facts.displayName || profileId}`)
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase()
        if (msg.includes('unique') || msg.includes('duplicate')) { out.skippedExisting += 1; continue }
        log.warn('auto-add insert failed (non-fatal)', { profile: profileId, opportunity: oppRow.id, error: String(err?.message || err) })
        bump('insert_error')
      }
    }
  }
  return out
}

/**
 * Self-heal: remove Robert-auto-added rows that no longer pass the (stricter,
 * positive-need) admission bar. A row Robert added under an earlier, fail-open
 * rule that serves no DECLARED need of its profile is deleted — but only when it
 * is still in an early, non-user-progressed status (PROTECTED_GRANT_STATUSES are
 * re-labeled-not-deleted territory and are left untouched here). A plain DELETE
 * (not a tombstone) so the same source can be re-added later if the profile
 * comes to declare a need it covers.
 *
 * @returns { scanned, removed, kept, protected, byReason }
 */
export async function cleanupNonQualifyingAcquiredGrants(db, {
  limit = boundedInt('ROBERT_ACQUIRE_CLEANUP_LIMIT', 3000, 1),
  deps = {},
} = {}) {
  const out = { scanned: 0, removed: 0, kept: 0, protected: 0, byReason: {}, skipped: null }
  const bump = (r) => { out.byReason[r] = (out.byReason[r] || 0) + 1 }
  let rows
  try {
    rows = await db.prepare(
      `SELECT id, profile_id, funding_opportunity_id, status
         FROM grants
        WHERE matcher_version = ?
        ORDER BY created_at ASC
        LIMIT ?`,
    ).all(ACQUISITION_MATCHER_VERSION, limit)
  } catch (err) { out.skipped = `query:${String(err?.message || err).slice(0, 60)}`; return out }
  if (!rows?.length) return out

  for (const row of rows) {
    out.scanned += 1
    const status = String(row.status || '').toLowerCase()
    if (PROTECTED_GRANT_STATUSES.has(status)) { out.protected += 1; continue }
    if (!row.funding_opportunity_id) { out.kept += 1; continue } // nothing to re-adjudicate against
    let facts, oppRow
    try { facts = await loadFactsCached(db, row.profile_id, deps) } catch { out.kept += 1; continue }
    if (!facts?.profile) { out.kept += 1; continue }
    try { oppRow = await loadOpportunityRow(db, row.funding_opportunity_id) } catch { oppRow = null }
    if (!oppRow) { out.kept += 1; continue } // opportunity gone — leave for the dangling-match net
    const verdict = qualifyForProfile(oppRow, facts, { requirePositiveNeed: true })
    if (verdict.pass) { out.kept += 1; continue }
    try {
      await db.prepare('DELETE FROM grants WHERE id = ?').run(row.id)
      out.removed += 1
      bump(verdict.reason || 'rejected')
    } catch (err) {
      out.kept += 1
      log.warn('acquired-grant cleanup: delete failed (non-fatal)', { grant: row.id, error: String(err?.message || err) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Full acquisition cycle: acquire the predetermined/archetype (+ hub) sources
 * into the catalog, then parse every freshly-admitted source against every
 * profile and auto-add the qualifiers. This is what the scheduler cadence runs.
 */
export async function runSourceAcquisitionCycle(db, {
  profileIds = null,
  deps = {},
  allowHubDecomposition = true,
  parseExistingCatalog = true,
  catalogLimitPerProfile = boundedInt('ROBERT_ACQUIRE_CATALOG_SLICE', 400, 1),
} = {}) {
  clearFactsCache()
  // (a0) Self-heal FIRST: drop any Robert-added rows that no longer meet the
  //     positive-need admission bar (rows added under an earlier fail-open rule).
  const cleanup = await cleanupNonQualifyingAcquiredGrants(db, { deps })
  clearFactsCache()
  // (a) The owner's "parse the sources against EXISTING profiles and auto-add"
  //     half — bounded, LLM-independent, and PURE (no network in the gates'
  //     offline REAL half). Robert re-adjudicates a slice of the REAL catalog
  //     already in GrantFlow's database against every profile with the FOUR
  //     gates (positive-need admission) and auto-adds the qualifiers the fuzzy
  //     score-floor buried. This runs before the slow acquisition half so the
  //     high-value auto-adds (e.g. real small-business grants for Olivia) land
  //     even if acquisition is interrupted. It never depends on the hub LLM.
  let catalogParse = null
  if (parseExistingCatalog) {
    catalogParse = await parseCatalogForProfiles(db, {
      profileIds: profileIds ? profileIds.map(String) : null,
      catalogLimitPerProfile,
      deps,
    })
  }
  // (b) THEN acquire the predetermined/archetype (+ decomposed hub) sources into
  //     the catalog (slower — live URL-liveness probes + optional hub fetch)...
  const acquisition = await acquireKnownSources(db, { profileIds, deps, allowHubDecomposition })
  // (c) ...and offer each freshly-acquired source to EVERY profile it qualifies for.
  const parse = await parseOpportunitiesAgainstProfiles(db, {
    opportunityIds: acquisition.admittedOpportunityIds,
    profileIds: null,
    deps,
  })
  const result = { cleanup, acquisition, parse, catalogParse }
  await persistLastRunSummary(db, result)
  return result
}

/** Last-run summary key for read-back verification (survives the fire-and-forget run). */
export const LAST_RUN_KV_KEY = 'robert_source_acquisition_last_run'

/**
 * Persist a compact summary of the last cycle to system_kv so a background run
 * (fire-and-forget from the route / scheduler) is observable after the fact —
 * counts, not the id lists. Best-effort; never throws into the cycle.
 */
async function persistLastRunSummary(db, result) {
  try {
    const summary = {
      at: new Date().toISOString(),
      cleanup: result.cleanup ? { scanned: result.cleanup.scanned, removed: result.cleanup.removed, protected: result.cleanup.protected, byReason: result.cleanup.byReason } : null,
      catalogParse: result.catalogParse
        ? { profiles: result.catalogParse.profiles, added: result.catalogParse.added, addedLeads: result.catalogParse.addedLeads, scanned: result.catalogParse.scanned, byReason: result.catalogParse.byReason }
        : null,
      acquisition: { ingested: result.acquisition.ingested, decomposedAdmitted: result.acquisition.decomposedAdmitted, hubsDecomposed: result.acquisition.hubsDecomposed, hubsSkipped: result.acquisition.hubsSkipped, byReason: result.acquisition.byReason },
      parse: { added: result.parse.added, addedLeads: result.parse.addedLeads, scanned: result.parse.scanned },
    }
    const value = JSON.stringify(summary)
    // Canonical system_kv upsert (matches robertPipelineAudit.persistGapNotes and
    // every other writer): ON CONFLICT(key) with updated_at as a BOUND param.
    // The earlier DELETE + INSERT ... now() form did not persist on prod.
    try {
      await db.prepare(
        `INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(LAST_RUN_KV_KEY, value, new Date().toISOString())
    } catch { /* table shape may differ — summary is best-effort */ }
  } catch { /* never fail the cycle on bookkeeping */ }
}

/**
 * Select a bounded slice of ACTIVE catalog opportunity ids NOT already on a
 * profile's pipeline, newest first. A SQL predicate (never a post-LIMIT JS
 * filter) so the bound limits the scan, and an already-linked row is excluded
 * so the same rows are not re-scanned every pass.
 */
async function selectCatalogCandidateIds(db, profileId, limit) {
  const trueLit = isPg(db) ? 'TRUE' : '1'
  const notLinked = 'NOT EXISTS (SELECT 1 FROM grants g WHERE g.profile_id = ? AND g.funding_opportunity_id = funding_opportunities.id)'
  // The catalog churns with ProPublica 990 DIRECTORY rows (grantmakers) that the
  // RELATABLE gate rejects wholesale — a plain "newest N" window fills with those
  // and the parse finds nothing qualifiable. So the candidate window excludes
  // directory/pointer kinds and the 990 grantmaker source, and requires a real
  // leaf URL, so it holds actual applyable opportunities. Falls back to the plain
  // window if a column is absent — never silently returns 0 on a schema mismatch.
  const strict =
    `SELECT id FROM funding_opportunities
      WHERE (is_active IS NULL OR is_active = ${trueLit})
        AND COALESCE(source,'') <> 'propublica_990'
        AND LOWER(COALESCE(opportunity_kind,'')) NOT IN ('directory','referral','resource_hub','resource_hub_registry','past_award_intel','school_portal','place_locator')
        AND (application_url IS NOT NULL OR source_url IS NOT NULL)
        AND ${notLinked}
      ORDER BY created_at DESC
      LIMIT ?`
  const loose =
    `SELECT id FROM funding_opportunities
      WHERE (is_active IS NULL OR is_active = ${trueLit})
        AND ${notLinked}
      ORDER BY created_at DESC
      LIMIT ?`
  try {
    return ((await db.prepare(strict).all(String(profileId), limit)) || []).map((r) => String(r.id))
  } catch {
    try { return ((await db.prepare(loose).all(String(profileId), limit)) || []).map((r) => String(r.id)) } catch { return [] }
  }
}

/**
 * Parse a bounded slice of the EXISTING catalog against each profile and
 * auto-add the qualifiers. Per profile so each gets its own newest-unlinked
 * slice; bounded by catalogLimitPerProfile and the auto-add caps.
 */
export async function parseCatalogForProfiles(db, { profileIds = null, catalogLimitPerProfile = 400, deps = {} } = {}) {
  const summary = { profiles: 0, added: 0, addedLeads: 0, scanned: 0, byReason: {}, examples: [], skipped: null }
  let pids = Array.isArray(profileIds) && profileIds.length ? profileIds.map(String) : null
  if (!pids) {
    try {
      const rows = await db.prepare(
        "SELECT id FROM profiles WHERE (deleted_at IS NULL) AND (status IS NULL OR status <> 'deleted') LIMIT ?",
      ).all(ACQUIRE_PROFILE_LIMIT)
      pids = (rows || []).map((r) => String(r.id))
    } catch { pids = [] }
  }
  if (!pids.length) { summary.skipped = 'no_profiles'; return summary }

  for (const profileId of pids) {
    const ids = await selectCatalogCandidateIds(db, profileId, catalogLimitPerProfile)
    if (!ids.length) continue
    const out = await parseOpportunitiesAgainstProfiles(db, { opportunityIds: ids, profileIds: [profileId], deps })
    summary.profiles += 1
    summary.added += out.added
    summary.addedLeads += out.addedLeads
    summary.scanned += out.scanned
    for (const [k, v] of Object.entries(out.byReason || {})) summary.byReason[k] = (summary.byReason[k] || 0) + v
    for (const ex of out.examples || []) if (summary.examples.length < 12) summary.examples.push(ex)
  }
  return summary
}

/**
 * Future-profile hook: a NEW profile is immediately parsed against the
 * predetermined/archetype sources (acquired for it) AND the recent catalog, and
 * gains its qualifying sources without waiting for the scheduled cadence.
 * Bounded to THIS profile; fire-and-forget from the route.
 */
export async function parseNewProfileAgainstCatalog(db, profileId, { deps = {}, recentCatalogLimit = boundedInt('ROBERT_NEWPROFILE_CATALOG_SCAN', 400, 1) } = {}) {
  clearFactsCache()
  // 1. Acquire the profile's own predetermined sources (direct applications
  //    ingest immediately; hubs are deferred to the scheduler which has a live
  //    fetcher). This is the "predetermined resources for future profiles" half.
  const acquisition = await acquireKnownSources(db, { profileIds: [String(profileId)], deps, allowHubDecomposition: deps.fetchPage ? true : false })

  // 2. Candidate catalog rows to parse against this one profile: the just-
  //    acquired rows PLUS a bounded slice of recently-added real catalog rows
  //    (so an archetype/hub source another profile acquired earlier also
  //    reaches this new profile).
  const candidateIds = new Set(acquisition.admittedOpportunityIds)
  for (const id of await selectCatalogCandidateIds(db, profileId, recentCatalogLimit)) candidateIds.add(id)

  const parse = await parseOpportunitiesAgainstProfiles(db, {
    opportunityIds: [...candidateIds],
    profileIds: [String(profileId)],
    deps,
  })
  return { acquisition, parse }
}

function clearFactsCache() { _factsCache.clear() }

export const __testing__ = { profileRootKey, normalizeSeed, clearFactsCache }

export default {
  acquireKnownSources,
  parseOpportunitiesAgainstProfiles,
  parseCatalogForProfiles,
  cleanupNonQualifyingAcquiredGrants,
  runSourceAcquisitionCycle,
  parseNewProfileAgainstCatalog,
  resolveKnownSourcesForProfile,
  classifyPipelineCategory,
  qualifyForProfile,
  ACQUISITION_MATCHER_VERSION,
}
