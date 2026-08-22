/**
 * robertPipelineAudit.js — Robert's FOUR-GATE pipeline verifier.
 *
 * OWNER ORDER (2026-08-21, verbatim): "Add to agent Robert's tools the ability
 * to check and verify each funding source in all profile's pipelines to see if
 * they are real, if they are relatable, if they cover a need or needs of the
 * profile, if the profile qualifies, if they are duplicated. If they are
 * duplicated, keep one version if it passes the real, relatable, needs
 * coverage, and qualified coverage. If the funding source cannot answer yes to
 * being real, relatable, covers at least part of the need or needs of the
 * profile, and the profile qualifies for, Have Robert remove it from that
 * profile's pipeline and notate to agent Amy what he did so she can close that
 * gap in the future with active crawler searches in that profile and globally."
 *
 * WHY IT EXISTS: on 2026-08-21 the owner opened one undergraduate's Application
 * Tracker and found 150 tasks / 105 "In Progress" — including six consecutive
 * ACL institutional NOFOs, an Office of Naval Research Broad Agency
 * Announcement, NSF research programs, HUD/EDA/FTA agency grants, a California
 * senior property-tax program, Community Action Agencies in Maine, Alabama and
 * Wyoming, a program whose own title reads "Ended May 2024", and a dozen
 * scholarship SEARCH ENGINES filed as leaf applications. 105 unapplyable
 * queued applications is worse than 20 real ones: it buries the real matches.
 *
 * AUTHORITY BOUNDARIES — this module INVENTS NO VERDICTS. Every gate delegates:
 *   REAL       → config/fundingResultFilters (expiry/ended/anonymized funder)
 *                + linkVerificationService.checkUrl (live evidence, bounded)
 *   RELATABLE  → config/fundingResultFilters.classifyFundingResult
 *                + config/opportunityKindClasses.isPointerKind
 *   COVERS     → profileNormalizer.normalizeNeedCategory over the profile's
 *                own declared needs and the row's own need vocabulary
 *   QUALIFIES  → services/applicantTypeGate + fundingResultFilters
 *                .passesEligibility / .isRelevantGeo
 *   IDENTITY   → crawler-os/contract.canonicalOpportunityKey (CLAUDE.md: "do
 *                NOT invent a second identity rule")
 *   REMOVAL    → pipelineDismissals.recordDismissal +
 *                reconcileDismissedGrants — the SAME auditable, reversible
 *                mechanism pipelineEligibilitySweep uses. Never a hard DELETE.
 *
 * "CANNOT ANSWER YES" MEANS DETERMINED NO, NOT "COULD NOT CHECK".
 * A 503, a timeout, an SSRF refusal or a bot wall is OUR reachability problem,
 * never evidence the grant is dead — the same rule `hamiltonSessionKeepAlive`
 * and `enforceAmountEnrichment` already live by. Those rows land in a distinct
 * `unverifiable` bucket, are REPORTED separately, and STAY in the pipeline
 * pending recheck. This is a deliberate reading of the owner's instruction and
 * is stated plainly in the run summary so it can be overruled.
 *
 * AGGREGATORS ARE HARVESTED BEFORE THEY ARE REMOVED. A directory/listing row is
 * not relatable as a LEAF application, but it is a discovery surface: it is
 * marked `harvest_first` and handed to the listing decomposer so the real
 * awards behind it can be extracted. Deleting it outright would starve recall,
 * which the owner's standing rule forbids ("precision via junk CLASSIFICATION,
 * never by starving recall").
 *
 * ACCOUNTING — the owner's #1 recurring defect is a silent no-op reported as
 * success. Every run enforces
 *   candidates === kept + removed_by_gate + deduped_away + unverifiable + failed
 * and THROWS if that identity does not hold. A run that removes nothing reports
 * `removed: 0` loudly with per-gate counts, never a quiet exit.
 *
 * NO DRY RUN. There is no `dryRun`/`apply:false`/`reportOnly` option here, by
 * owner order (2026-08-13, permanent): "I don't want dry runs, I want work."
 */

import { canonicalOpportunityKey } from '../../crawler-os/contract.js'
import { STATE_REGISTRY } from '../shared/data/stateRegistry.js'
import { isPointerKind } from '../../config/opportunityKindClasses.js'
import { classifyLocatorKindFromRow } from '../sources/locatorUrlKind.js'
import {
  classifyFundingResult,
  isClearlyExpiredProgram,
  isPastDeadline,
  isRelevantGeo,
  passesEligibility,
  RESULT_BUCKETS,
} from '../../config/fundingResultFilters.js'
import { evaluateApplicantTypeEligibility } from '../applicantTypeGate.js'
import { stageOfLifeConflictForSections } from '../../config/stageOfLifeEligibility.js'
import { normalizeNeedCategory } from '../profileNormalizer.js'
import { CANONICAL_NEED_CATEGORIES } from '../../constants/needCategories.js'
import { recordDismissal, reconcileDismissedGrants } from '../pipelineDismissals.js'
import { cleanExtractedText } from '../../utils/htmlTextHygiene.js'
import { checkUrl as defaultCheckUrl } from '../linkVerificationService.js'
import { createLogger } from '../../utils/logger.js'
import { REJECTION_REASONS } from './robertTypes.js'
import { AUTONOMY_FORBIDDEN, LEVER_SURFACE } from '../amy/findingActorRegistry.js'

const log = createLogger('robert-pipeline-audit')

/** The four gates, in the order they are evaluated (cheap → networked). */
export const GATES = Object.freeze({
  RELATABLE: 'relatable',
  QUALIFIES: 'qualifies',
  COVERS_NEED: 'covers_need',
  REAL: 'real',
})
export const GATE_ORDER = Object.freeze([GATES.RELATABLE, GATES.QUALIFIES, GATES.COVERS_NEED, GATES.REAL])

/** Bounded retries for the REAL gate before a row is called `unverifiable`. */
export const REAL_GATE_MAX_ATTEMPTS = Number(process.env.ROBERT_REAL_GATE_ATTEMPTS) || 2
export const REAL_GATE_TIMEOUT_MS = Number(process.env.ROBERT_REAL_GATE_TIMEOUT_MS) || 12_000

/** `system_kv` key Amy's approval queue reads. */
export const ROBERT_GAP_NOTES_KV_KEY = 'robert_pipeline_audit_notes'
/** Never let the note store grow without bound. */
export const ROBERT_GAP_NOTES_MAX = 500

/**
 * PromoPilot's fake test profile. Its junk-looking entries are intentional and
 * must never be cleaned up (standing owner instruction).
 */
const PROTECTED_PROFILE_NAME_RX = /sasquatch/i

/**
 * HTTP codes that are a STATEMENT ABOUT THE PAGE (a determined NO) rather than
 * about our own reachability. 401/403/429 are deliberately absent: those refuse
 * OUR caller (WAF / bot wall / rate limit), exactly as `amountEnrichment`
 * classifies them.
 */
const DETERMINED_DEAD_CODES = new Set([404, 410])

// ---------------------------------------------------------------------------
// Profile facts
// ---------------------------------------------------------------------------

/**
 * The CANONICAL need vocabulary, read from the registry rather than hand-typed.
 *
 * `normalizeNeedCategory` is a pass-through for values it does not recognise —
 * it returns `basic_information` for `basic_information` — so using it alone to
 * decide "is this a need?" turns every profile SECTION NAME into a declared
 * need. Measured on the reconstructed queue: the notation Amy would receive
 * listed the profile's unmet needs as `education, housing, food,
 * basic_information, financial_information`. Two of those are table-of-contents
 * entries, and an instruction to go crawl for "financial_information" is the
 * unfillable-ask class this repo already retired once (`lodging` in the
 * disease-lane wishlist).
 */
const CANONICAL_NEED_IDS = new Set(CANONICAL_NEED_CATEGORIES.map((n) => n.id))

function canonicalNeed(value) {
  if (typeof value !== 'string') return null
  const normalized = normalizeNeedCategory(value)
  return normalized && CANONICAL_NEED_IDS.has(normalized) ? normalized : null
}

/** Structured fields a profile may declare a NEED in. Never prose. */
const DECLARED_NEED_FIELDS = Object.freeze([
  'needs', 'need_categories', 'primary_needs', 'support_needs', 'funding_needs',
  'item_needs', 'assistance_types',
])

function parseMaybeJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}

export async function loadProfileFacts(db, profileId) {
  let row = null
  try {
    row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
  } catch { row = null }

  const sections = {}
  try {
    const rows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
    for (const sec of rows || []) {
      if (!sec?.section_key) continue
      const parsed = parseMaybeJson(sec.data, null)
      if (parsed && typeof parsed === 'object') sections[sec.section_key] = parsed
    }
  } catch { /* a degraded deployment may lack the table — never guess */ }

  const basic = sections.basic_information ?? sections.basic_info ?? {}
  const applicantType = row?.applicant_type || row?.primary_type ||
    basic?.profile_category || basic?.applicant_type || null

  // States: declared only. A missing state stays NEUTRAL (isRelevantGeo's own
  // rule) — it must never become a reason to delete someone's funding.
  const states = []
  for (const candidate of [basic?.state, basic?.state_code, sections.location_focus?.state, row?.state]) {
    if (typeof candidate === 'string' && candidate.trim()) states.push(candidate.trim())
  }

  // Needs: STRUCTURED declarations only. `buildProfileSignals` mines free text,
  // and free text carries its own DENIALS ("we do not need housing assistance")
  // — the veteran-gate class this repo has shipped twice.
  const needs = new Set()
  const addNeed = (value) => {
    const canonical = canonicalNeed(value)
    if (canonical) needs.add(canonical)
  }
  for (const field of DECLARED_NEED_FIELDS) {
    const direct = parseMaybeJson(row?.[field], null)
    if (Array.isArray(direct)) direct.forEach(addNeed)
  }
  for (const section of Object.values(sections)) {
    if (!section || typeof section !== 'object') continue
    for (const field of DECLARED_NEED_FIELDS) {
      const value = section[field]
      if (Array.isArray(value)) value.forEach(addNeed)
      else if (typeof value === 'string') addNeed(value)
    }
  }
  for (const key of Object.keys(sections)) addNeed(key)
  const tags = parseMaybeJson(row?.tags, [])
  if (Array.isArray(tags)) tags.forEach(addNeed)

  return {
    profileId: String(profileId),
    displayName: row?.display_name ?? null,
    profile: row,
    sections,
    applicantType,
    states,
    needs: [...needs],
    protectedProfile: PROTECTED_PROFILE_NAME_RX.test(String(row?.display_name ?? '')),
  }
}

// ---------------------------------------------------------------------------
// Pipeline rows
// ---------------------------------------------------------------------------

/**
 * The pipeline is the `grants` table. The catalog row carries the eligibility
 * evidence the gates need, so it is joined in.
 *
 * COLUMN NAMES ARE THE WHOLE POINT HERE. `pipelineEligibilitySweep.loadPipelineRows`
 * selects `fo.applicant_types`, `fo.eligible_applicants`, `fo.eligibility_types`,
 * `fo.eligibility` and `fo.is_directory_resource` — NONE of which is a column on
 * `funding_opportunities`. Measured 2026-08-21 against the catalog: that SELECT
 * throws `no such column: fo.applicant_types`, the `catch` falls back to a
 * grants-only query with NO eligibility data at all, and the sweep therefore
 * flags nothing while reporting success. Every column below was verified to
 * exist before it was written.
 */
const PIPELINE_ROW_SQL = `
  SELECT
    g.id                        AS grant_id,
    g.profile_id                AS profile_id,
    g.funding_opportunity_id    AS funding_opportunity_id,
    g.title                     AS grant_title,
    g.funder                    AS funder,
    g.status                    AS grant_status,
    g.deadline                  AS grant_deadline,
    g.application_url           AS grant_application_url,
    g.url                       AS grant_url,
    g.amount_requested          AS amount_requested,
    g.match_score               AS match_score,
    g.match_decision            AS match_decision,
    g.updated_at                AS updated_at,
    fo.title                    AS opp_title,
    fo.sponsor                  AS sponsor,
    fo.description              AS description,
    fo.eligibility_text         AS eligibility_text,
    fo.eligibility_bullets      AS eligibility_bullets,
    fo.entity_types_allowed     AS entity_types_allowed,
    fo.need_types_supported     AS need_types_supported,
    fo.categories               AS categories,
    fo.keywords                 AS keywords,
    fo.opportunity_kind         AS opportunity_kind,
    fo.opportunity_type         AS opportunity_type,
    fo.funding_category         AS funding_category,
    fo.source                   AS source,
    fo.source_url               AS source_url,
    fo.application_url          AS opp_application_url,
    fo.apply_url                AS apply_url,
    fo.final_url                AS final_url,
    fo.evidence_url             AS evidence_url,
    fo.external_id              AS external_id,
    fo.state                    AS state,
    fo.is_national              AS is_national,
    fo.deadline                 AS opp_deadline,
    fo.deadline_type            AS deadline_type,
    fo.amount_min               AS amount_min,
    fo.amount_max               AS amount_max,
    fo.amount_text              AS amount_text,
    fo.is_active                AS is_active,
    fo.link_status              AS link_status,
    fo.canonical_opportunity_key AS canonical_opportunity_key
  FROM grants g
  LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
  WHERE g.profile_id = ?
`

/**
 * Pipeline statuses a human has ALREADY progressed. Never auto-removed — the
 * standing guardrail ("protected (user-progressed) statuses are never
 * auto-purged").
 */
export const PROTECTED_GRANT_STATUSES = Object.freeze(new Set([
  'submitted', 'awarded', 'declined', 'follow_up', 'in_review', 'under_review', 'archived',
]))

export async function loadPipelineRows(db, profileId) {
  const rows = await db.prepare(PIPELINE_ROW_SQL).all(String(profileId))
  return (rows || []).map((r) => {
    const title = cleanExtractedText(r.opp_title || r.grant_title || '') || ''
    const sponsor = cleanExtractedText(r.sponsor || r.funder || '') || null
    return {
      ...r,
      // The gates read ONE normalized shape so a gate can never be blind to a
      // field just because two tables spell it differently.
      title,
      sponsor,
      funder: sponsor,
      deadline: r.opp_deadline || r.grant_deadline || null,
      application_url: r.opp_application_url || r.apply_url || r.grant_application_url || null,
      source_url: r.source_url || r.final_url || r.evidence_url || r.grant_url || null,
      entity_types_allowed: r.entity_types_allowed,
    }
  })
}

// ---------------------------------------------------------------------------
// The four gates. Each returns { pass, reason, evidence } — or
// { unverifiable: true } for the REAL gate when we could not look.
// ---------------------------------------------------------------------------

/**
 * GATE 2 — RELATABLE. A fundable opportunity relevant to this profile, not a
 * directory, a search engine, or a listing page.
 */
export function gateRelatable(row, { now = new Date() } = {}) {
  const classification = classifyFundingResult(row, { now })
  const storedKind = String(row?.opportunity_kind ?? '').trim()
  // THE STORED KIND IS NOT ENOUGH, and that is the whole reason these rows
  // reached a leaf application. `opportunity_kind` is stamped at INGEST by
  // `classifyOpportunityKind`; none of scholarships.com / fastweb / bold.org /
  // goingmerry / bigfuture was in any directory registry until 2026-08-21, so
  // every one of them was persisted as `direct` and `isPointerKind` said false.
  // Re-deriving the STRUCTURAL claim from the row's own URL is what recognises
  // an already-persisted aggregator without waiting for a re-crawl.
  const structural = classifyLocatorKindFromRow(row)
  const kind = storedKind || String(structural?.kind ?? '')

  if (isPointerKind(kind) || classification.reasons.includes('pointer_kind') ||
      classification.reasons.includes('place_locator_title') ||
      classification.reasons.includes('resource_hub_registry')) {
    return {
      pass: false,
      reason: REJECTION_REASONS.DIRECTORY_ONLY,
      // A discovery surface is HARVESTED before it is removed. The decomposer
      // is what turns it into the real awards behind it.
      harvest_first: true,
      evidence: {
        bucket: classification.bucket,
        kind: kind || null,
        kind_source: storedKind ? 'stored' : (structural?.reason ?? null),
        reasons: classification.reasons,
      },
    }
  }
  if (classification.bucket === RESULT_BUCKETS.NOT_A_GRANT) {
    // Expiry is the REAL gate's business — do not double-count it here.
    const nonExpiry = classification.reasons.filter((r) => !String(r).startsWith('expired:'))
    if (nonExpiry.length > 0) {
      return {
        pass: false,
        reason: REJECTION_REASONS.NOT_FUNDING,
        evidence: { bucket: classification.bucket, reasons: nonExpiry },
      }
    }
  }
  if (classification.bucket === RESULT_BUCKETS.RESOURCE) {
    return {
      pass: false,
      reason: REJECTION_REASONS.DIRECTORY_ONLY,
      harvest_first: true,
      evidence: { bucket: classification.bucket, reasons: classification.reasons },
    }
  }
  return { pass: true, reason: null, evidence: { bucket: classification.bucket } }
}

/**
 * GATE 4 — QUALIFIES. Is this profile actually eligible to apply?
 *
 * This is the gate that kills the institutional awards an individual
 * undergraduate can never receive. It reads the STRUCTURED applicant types
 * (`entity_types_allowed`) that `applicantTypeGate` was blind to until
 * 2026-08-21, plus geography and the institutional pass-through registry.
 */
export function gateQualifies(row, facts) {
  const applicantEval = evaluateApplicantTypeEligibility(row, facts.applicantType, {
    profile: facts.profile,
    sections: facts.sections,
  })
  if (applicantEval.decision === 'mismatch') {
    return {
      pass: false,
      reason: REJECTION_REASONS.PROFILE_MISMATCH,
      evidence: { gate: 'applicant_type', detail: applicantEval.reason, bucket: applicantEval.matched_bucket ?? null },
    }
  }

  // Academic STAGE-OF-LIFE (owner 2026-08-22: Coolidge = current HS junior;
  // Education Freedom = K-12 — neither is a college student's award). The stage
  // gate refuses ONLY provable impossibility from the row's OWN eligibility text
  // (missing = neutral), so it catches a pre-college award surfaced to an
  // enrolled undergraduate. Also covers website-purpose locks. Consumes the
  // canonical gate; never re-derives the stage.
  const stageConflict = stageOfLifeConflictForSections(facts.sections, row)
  if (stageConflict) {
    return {
      pass: false,
      reason: REJECTION_REASONS.PROFILE_MISMATCH,
      evidence: { gate: 'stage_of_life', detail: stageConflict.reason, bars: stageConflict.classId },
    }
  }

  const eligibility = passesEligibility(row, {
    applicantType: facts.applicantType,
    profileType: facts.applicantType,
    sections: facts.sections,
    profile: facts.profile,
  })
  if (eligibility && eligibility.eligible === false) {
    return {
      pass: false,
      reason: REJECTION_REASONS.PROFILE_MISMATCH,
      evidence: { gate: 'eligibility_predicate', detail: eligibility.reason, explanation: eligibility.explanation },
    }
  }

  // Geography. MISSING = NEUTRAL: a profile with no declared state loses
  // nothing, because `isRelevantGeo` only acts on positive restrictive evidence.
  const geo = isRelevantGeo(row, { states: facts.states })
  if (geo && geo.relevant === false) {
    return {
      pass: false,
      reason: REJECTION_REASONS.PROFILE_MISMATCH,
      evidence: { gate: 'geo', detail: geo.reason, profile_states: facts.states },
    }
  }

  return { pass: true, reason: null, evidence: { gate: 'qualifies', applicant_decision: applicantEval.decision } }
}

/**
 * GATE 3 — COVERS A NEED. The owner's bar is explicit: "at least PART" of one
 * of the profile's stated needs. Full coverage is NOT required — a book
 * voucher covering a sliver of a tuition need passes.
 *
 * FAILS OPEN when the profile declares no needs. An unconfigured profile is a
 * profile we cannot read, not a profile with nothing to fund, and this gate
 * DELETES — so silence must never remove anyone's funding.
 */
export function gateCoversNeed(row, facts) {
  if (!Array.isArray(facts.needs) || facts.needs.length === 0) {
    return { pass: true, reason: null, evidence: { gate: 'covers_need', detail: 'profile_declares_no_needs_gate_neutral' } }
  }
  const supported = new Set()
  const add = (value) => {
    const canonical = canonicalNeed(value)
    if (canonical) supported.add(canonical)
  }
  for (const field of ['need_types_supported', 'categories', 'keywords']) {
    const parsed = parseMaybeJson(row?.[field], null)
    if (Array.isArray(parsed)) parsed.forEach(add)
  }
  add(row?.funding_category)
  add(row?.opportunity_type)

  // A row that states NO need vocabulary is SILENT, not contrary. Silence is
  // never a denial — the same rule that stops a recrawl clearing an amount.
  if (supported.size === 0) {
    return { pass: true, reason: null, evidence: { gate: 'covers_need', detail: 'opportunity_states_no_need_vocabulary' } }
  }

  const overlap = facts.needs.filter((n) => supported.has(n))
  if (overlap.length > 0) {
    return { pass: true, reason: null, evidence: { gate: 'covers_need', matched: overlap } }
  }
  return {
    pass: false,
    reason: REJECTION_REASONS.PROFILE_MISMATCH,
    evidence: {
      gate: 'covers_need',
      profile_needs: facts.needs,
      opportunity_needs: [...supported],
    },
  }
}

/**
 * GATE 1 — REAL. Evidence-based, never an LLM assertion.
 *
 * Two halves: a deterministic half (the funder's own words say the program
 * ended; the deadline is long past; the funder is the anonymized placeholder)
 * and a NETWORK half (the URL actually answers).
 *
 * The network half distinguishes THREE outcomes and the middle one is the
 * whole point: `dead` (a determined 404/410 — remove), `alive` (keep), and
 * `unverifiable` (503 / timeout / bot wall / SSRF refusal — KEEP and report
 * separately). A funder having a bad afternoon must not cost an applicant a
 * real grant.
 */
export async function gateReal(row, { now = new Date(), checkUrl = defaultCheckUrl, attempts = REAL_GATE_MAX_ATTEMPTS } = {}) {
  const expired = isClearlyExpiredProgram(row, now)
  if (expired) {
    return { pass: false, reason: REJECTION_REASONS.EXPIRED_DEADLINE, evidence: { gate: 'real', detail: expired } }
  }
  if (isPastDeadline(row, now)) {
    return {
      pass: false,
      reason: REJECTION_REASONS.EXPIRED_DEADLINE,
      evidence: { gate: 'real', detail: `deadline_passed:${row.deadline}` },
    }
  }

  const url = row?.application_url || row?.source_url || null
  if (!url) {
    return { pass: false, reason: REJECTION_REASONS.NO_REAL_URL, evidence: { gate: 'real', detail: 'no_url_to_verify' } }
  }

  let last = null
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      last = await checkUrl(url, { timeoutMs: REAL_GATE_TIMEOUT_MS })
    } catch (err) {
      last = { status: 'error', code: null, error: err?.message || String(err) }
    }
    if (last?.status === 'ok' || last?.status === 'redirect') {
      return { pass: true, reason: null, evidence: { gate: 'real', detail: `live:${last.code}`, url } }
    }
    if (last?.status === 'broken' && DETERMINED_DEAD_CODES.has(Number(last.code))) {
      return {
        pass: false,
        reason: REJECTION_REASONS.DEAD_LINK,
        evidence: { gate: 'real', detail: `http_${last.code}`, url, attempts: attempt },
      }
    }
    // 'skipped' means we REFUSED to look (SSRF policy) — never evidence.
    if (last?.status === 'skipped') break
  }

  return {
    unverifiable: true,
    reason: 'real_gate_unverifiable',
    evidence: {
      gate: 'real',
      url,
      status: last?.status ?? null,
      code: last?.code ?? null,
      error: last?.error ?? null,
      attempts: Math.max(1, attempts),
      note: 'Could not determine liveness. NOT removed — a transient failure is our reachability problem, not proof the grant is dead.',
    },
  }
}

// ---------------------------------------------------------------------------
// Amy notation — split across the autonomy boundary
// ---------------------------------------------------------------------------

/**
 * Which lever, if any, Amy may autonomously pull to close the gap this removal
 * opened — and which gaps are hers to touch at all.
 *
 * The owner's constraint is hard: Amy may auto-apply keyword / weight / floor /
 * query / url levers ONLY. Eligibility, geo and matching changes are
 * `code_brief`. The split is DERIVED from the canonical registries
 * (`LEVER_SURFACE` + `AUTONOMY_FORBIDDEN`) rather than hand-typed, so a lever
 * reclassified in the registry cannot silently gain authority here.
 */
export const GATE_TO_LEVER = Object.freeze({
  [GATES.COVERS_NEED]: 'source_keyword_coverage',
  [GATES.RELATABLE]: 'url_hygiene',
  [GATES.REAL]: 'url_hygiene',
  [GATES.QUALIFIES]: 'eligibility_gate',
})

/** Gate-specific override where the failure is provably a geo/matching fact. */
function leverForFailure(gate, evidence) {
  if (gate === GATES.QUALIFIES && evidence?.gate === 'geo') return 'geo_scope'
  return GATE_TO_LEVER[gate] ?? 'relevance_policy'
}

export function isAmyAutonomousLever(lever) {
  const surface = LEVER_SURFACE[lever]
  if (!surface) return false
  return !AUTONOMY_FORBIDDEN.includes(surface)
}

/**
 * Build ONE notation for a removal. Amy gets what she can act on; anything
 * touching an autonomy-forbidden surface becomes a code brief instead.
 *
 * The notation carries exactly what Amy needs to close the gap: the profile,
 * the unmet need the removed source was supposed to cover, which gate failed
 * and why, and the SEARCH SURFACE that produced the bad source (so the same
 * lane stops producing junk).
 */
export function buildAmyNotation({ facts, row, gate, verdict, runId, now = new Date() }) {
  const lever = leverForFailure(gate, verdict?.evidence)
  const surface = LEVER_SURFACE[lever] ?? null
  const autonomous = isAmyAutonomousLever(lever)
  const base = {
    id: `robert_gap:${facts.profileId}:${row.grant_id}:${gate}`,
    run_id: runId ?? null,
    created_at: now.toISOString(),
    profile_id: facts.profileId,
    profile_display_name: facts.displayName,
    grant_id: row.grant_id,
    opportunity_id: row.funding_opportunity_id ?? null,
    removed_title: row.title,
    removed_funder: row.sponsor,
    failed_gate: gate,
    failure_reason: verdict?.reason ?? null,
    evidence: verdict?.evidence ?? null,
    // The lane that produced the bad source. Amy tunes the LANE, not the row.
    search_surface: {
      source: row.source ?? null,
      source_url: row.source_url ?? null,
      opportunity_kind: row.opportunity_kind ?? null,
    },
    // What the profile still needs covered — the point of the whole handoff.
    unmet_needs: facts.needs,
    lever,
    lever_surface: surface,
  }
  if (autonomous) {
    return { ...base, channel: 'amy_lever', requires_code_change: false }
  }
  return {
    ...base,
    channel: 'code_brief',
    requires_code_change: true,
    code_brief: {
      lever,
      surface,
      file: gate === GATES.QUALIFIES && verdict?.evidence?.gate === 'geo'
        ? 'backend/config/fundingResultFilters.js (isRelevantGeo)'
        : 'backend/services/applicantTypeGate.js',
      why_not_autonomous:
        `\`${lever}\` touches the ${surface} surface, which is on AUTONOMY_FORBIDDEN. ` +
        'Amy may not auto-apply eligibility, geo or matching changes.',
      subjects: [row.title].filter(Boolean),
      failing_profiles: 1,
      patch_authored_by_amy: false,
    },
  }
}

// ---------------------------------------------------------------------------
// Note store (durable, with a real consumer — see crawlerTuner.buildApprovalQueue)
// ---------------------------------------------------------------------------

async function readKv(db, key) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ? LIMIT 1').get(key)
    return parseMaybeJson(row?.value, null)
  } catch { return null }
}

async function writeKv(db, key, value) {
  const payload = JSON.stringify(value)
  const now = new Date().toISOString()
  try {
    await db.prepare(
      `INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, payload, now)
    return true
  } catch (err) {
    log.warn('gap_notes_write_failed', { err: err?.message })
    return false
  }
}

export async function persistGapNotes(db, notes, { runId = null, now = new Date() } = {}) {
  if (!db || !Array.isArray(notes) || notes.length === 0) return { persisted: 0, total: 0 }
  const existing = await readKv(db, ROBERT_GAP_NOTES_KV_KEY)
  const prior = Array.isArray(existing?.notes) ? existing.notes : []
  const byId = new Map(prior.map((n) => [n?.id, n]))
  for (const note of notes) byId.set(note.id, note)
  const merged = [...byId.values()].slice(-ROBERT_GAP_NOTES_MAX)
  await writeKv(db, ROBERT_GAP_NOTES_KV_KEY, {
    updated_at: now.toISOString(),
    last_run_id: runId,
    notes: merged,
  })
  return { persisted: notes.length, total: merged.length }
}

/**
 * THE CONSUMER SIDE. `crawlerTuner.buildApprovalQueue` calls this so Robert's
 * notation is not a write-only queue — the shape this repo has shipped three
 * times (`web_parity_gap_queue`, the adapter wishlist, the approval queue).
 */
export async function loadGapNotesForAmy(db, { limit = 100 } = {}) {
  const stored = await readKv(db, ROBERT_GAP_NOTES_KV_KEY)
  const notes = Array.isArray(stored?.notes) ? stored.notes : []
  const open = notes.filter((n) => n && !n.consumed_at)
  return {
    updated_at: stored?.updated_at ?? null,
    amy_levers: open.filter((n) => n.channel === 'amy_lever').slice(0, limit),
    code_briefs: open.filter((n) => n.channel === 'code_brief').slice(0, limit),
    total_open: open.length,
  }
}

export async function markGapNotesConsumed(db, ids, { now = new Date() } = {}) {
  if (!db || !Array.isArray(ids) || ids.length === 0) return 0
  const stored = await readKv(db, ROBERT_GAP_NOTES_KV_KEY)
  const notes = Array.isArray(stored?.notes) ? stored.notes : []
  const wanted = new Set(ids)
  let marked = 0
  for (const note of notes) {
    if (!note || !wanted.has(note.id) || note.consumed_at) continue
    note.consumed_at = now.toISOString()
    marked += 1
  }
  if (marked > 0) await writeKv(db, ROBERT_GAP_NOTES_KV_KEY, { ...stored, notes })
  return marked
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * PROGRAM IDENTITY, not exact title string. Uses the canonical
 * `canonicalOpportunityKey` (CLAUDE.md: "do NOT invent a second identity
 * rule"), then falls back to a normalized identity that collapses the real
 * variants the owner listed: "Federal Pell Grant"/"Pell Grant" (funders
 * "Federal Student Aid" vs "U.S. Department of Education"), "HOPE
 * Scholarship"/"Tennessee HOPE Scholarship (2026-27)", "Federal
 * Work-Study"/"Federal Work-Study at Middle Tennessee State University
 * (2026-27)", "Tennessee Reconnect"/"Tennessee Reconnect Grant", "QuestBridge
 * National College Match"/"QuestBridge", "Coca-Cola Scholars
 * Program"/"Coca-Cola Scholars".
 *
 * The FUNDER is deliberately NOT part of the key: the owner's own examples pair
 * the same program with two different funder spellings.
 */
const IDENTITY_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'at', 'in', 'to', 'on',
  'program', 'programs', 'grant', 'grants', 'scholarship', 'scholarships',
  'fund', 'funds', 'award', 'awards', 'federal', 'national', 'initiative',
  // "Scholars" is a suffix half the scholarship world uses ("Coca-Cola
  // Scholars" / "Coca-Cola Scholars Program"); it names no program on its own.
  'scholars',
])

/** Institution/year qualifiers that a variant appends to the same program. */
function stripProgramQualifiers(title) {
  return String(title || '')
    .replace(/\((?:\s*20\d{2}\s*[-–/]?\s*\d{0,4}\s*)\)/g, ' ')
    .replace(/\b20\d{2}\s*[-–/]\s*\d{2,4}\b/g, ' ')
    .replace(/\bat\s+.*$/i, ' ')
    .replace(/\s*[-–—]\s*.*$/, ' ')
}

/** The distinctive tokens of a program name, qualifiers stripped. */
export function programTokens(row) {
  return [...new Set(
    stripProgramQualifiers(row?.title)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !IDENTITY_STOPWORDS.has(t)),
  )].sort()
}

export function programIdentityKey(row) {
  const canonical = row?.canonical_opportunity_key
  if (typeof canonical === 'string' && canonical.trim()) return `c:${canonical.trim().toLowerCase()}`
  const tokens = programTokens(row)
  if (tokens.length > 0) return `t:${tokens.join('-')}`
  const derived = canonicalOpportunityKey({
    external_id: row?.external_id ?? null,
    title: row?.title ?? null,
    sponsor: row?.sponsor ?? null,
    url: row?.application_url || row?.source_url || null,
  })
  return derived ? `k:${derived}` : `g:${row?.grant_id}`
}

/**
 * Minimum length of a LONE distinctive token before it may claim identity with
 * a longer name. Without it, "Gates Scholarship" (`gates`) would collapse into
 * "Gates Millennium Scholars" — different programs that share a surname. With
 * it, "QuestBridge" (11 chars) still collapses into "QuestBridge National
 * College Match", which the owner listed as one program.
 */
export const MIN_LONE_TOKEN_IDENTITY_LENGTH = 6

/**
 * QUALIFIER TOKENS — words a VARIANT of the same program adds: a state, an
 * institution word, a scope word. Read out of `STATE_REGISTRY` so a state name
 * cannot be missed by a hand-typed list.
 *
 * The distinction this encodes: "Tennessee HOPE Scholarship" differs from "HOPE
 * Scholarship" by a PLACE; "Gates Millennium Scholars" differs from "Gates
 * Scholarship" by a PROGRAM WORD. The first pair is one program, the second is
 * two — and no length or overlap heuristic can tell them apart.
 */
const QUALIFIER_TOKENS = (() => {
  const out = new Set([
    'state', 'statewide', 'university', 'college', 'community', 'county', 'city',
    'regional', 'district', 'campus', 'institute', 'school', 'usa', 'us',
    'undergraduate', 'graduate', 'general', 'annual',
  ])
  for (const entry of Object.values(STATE_REGISTRY || {})) {
    for (const word of String(entry?.name ?? '').toLowerCase().split(/\s+/)) {
      if (word.length > 1) out.add(word)
    }
  }
  return out
})()

/**
 * Are these two pipeline rows the SAME PROGRAM?
 *
 * A hash key alone cannot answer this, because the owner's own duplicate list
 * is made of SUBSET pairs, not equal ones: "Pell Grant" ⊂ "Federal Pell Grant",
 * "QuestBridge" ⊂ "QuestBridge National College Match", "HOPE Scholarship" ⊂
 * "Tennessee HOPE Scholarship (2026-27)", "Federal Work-Study" ⊂ "Federal
 * Work-Study at Middle Tennessee State University (2026-27)". A set-equality
 * key reports the first two of those as different programs — measured, and it
 * is why the dedup is a pairwise predicate rather than a Map key.
 *
 * The FUNDER is deliberately not consulted: the owner's examples pair one
 * program with two funder spellings ("Federal Student Aid" vs "U.S. Department
 * of Education").
 *
 * NOT the same program (asserted in the tests): "Tennessee HOPE Scholarship" vs
 * "Tennessee Promise Scholarship" — neither token set contains the other.
 */
export function sameProgram(a, b) {
  const keyA = programIdentityKey(a)
  const keyB = programIdentityKey(b)
  if (keyA === keyB) return true
  // A canonical key is an EXPLICIT identity claim; disagreement there is final.
  if (keyA.startsWith('c:') && keyB.startsWith('c:')) return false

  const ta = programTokens(a)
  const tb = programTokens(b)
  if (ta.length === 0 || tb.length === 0) return false
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  const largeSet = new Set(large)
  if (!small.every((t) => largeSet.has(t))) return false
  // Containment alone is not identity when the shared core is ONE short word.
  // Two independent escapes, and a pair needs only one:
  //   (a) the lone token is long enough to be a program NAME ("questbridge"),
  //   (b) every extra word in the longer title is a QUALIFIER — a place, an
  //       institution, a scope — so the longer title is the same program with
  //       its jurisdiction spelled out ("Tennessee HOPE Scholarship").
  if (small.length === 1 && small[0].length < MIN_LONE_TOKEN_IDENTITY_LENGTH) {
    const extras = large.filter((t) => !small.includes(t))
    if (!extras.every((t) => QUALIFIER_TOKENS.has(t))) return false
  }
  return true
}

/**
 * Which duplicate survives. All candidates here have already passed all four
 * gates, so this ranks by EVIDENCE quality:
 *   1. a real funder URL over an aggregator's mirror
 *   2. the record linked to a catalog row over a bare grants row
 *   3. the richer funder identity (a named sponsor beats a blank one)
 *   4. the more recent cycle (later deadline), then the newer record
 */
export function rankDuplicate(row) {
  const url = String(row?.application_url || row?.source_url || '')
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { host = '' }
  const aggregator = /(scholarships\.com|fastweb\.com|bold\.org|goingmerry\.com|wemakescholars\.com|collegeboard\.org|unigo\.com|cappex\.com|niche\.com|scholarshipowl\.com)$/.test(host)
  const deadlineMs = row?.deadline ? Date.parse(row.deadline) : NaN
  return [
    aggregator ? 0 : 1,
    row?.funding_opportunity_id ? 1 : 0,
    row?.sponsor ? 1 : 0,
    Number.isFinite(deadlineMs) ? deadlineMs : 0,
    Date.parse(row?.updated_at || '') || 0,
  ]
}

function betterOf(a, b) {
  const ra = rankDuplicate(a)
  const rb = rankDuplicate(b)
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b
  }
  return a
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

async function removeFromPipeline(db, { facts, row, gate, verdict, userId }) {
  await recordDismissal(db, {
    profileId: facts.profileId,
    userId: userId || 'agent:robert',
    reason: `robert_pipeline_audit:${gate}:${verdict?.reason ?? 'failed'}`,
    grantRow: {
      id: row.grant_id,
      title: row.title,
      funder: row.sponsor,
      deadline: row.deadline,
      application_url: row.application_url,
      source_url: row.source_url,
      funding_opportunity_id: row.funding_opportunity_id,
    },
  })
}

/**
 * Audit ONE profile's pipeline. Real work only — there is no preview mode.
 *
 * @returns {Promise<object>} an accounting-complete result; the identity
 *   `candidates === kept + removed_by_gate + deduped_away + unverifiable + failed + protected`
 *   is ASSERTED before it is returned.
 */
export async function auditProfilePipeline(db, profileId, {
  userId = 'agent:robert',
  runId = null,
  now = new Date(),
  checkUrl = defaultCheckUrl,
  realGate = true,
} = {}) {
  const facts = await loadProfileFacts(db, profileId)
  const result = {
    profile_id: facts.profileId,
    profile_display_name: facts.displayName,
    applicant_type: facts.applicantType,
    declared_states: facts.states,
    declared_needs: facts.needs,
    candidates: 0,
    kept: 0,
    protected: 0,
    removed: 0,
    removed_by_gate: { relatable: 0, qualifies: 0, covers_need: 0, real: 0 },
    removed_by_reason: {},
    deduped_away: 0,
    unverifiable: 0,
    failed: 0,
    harvest_first: [],
    removals: [],
    notes: [],
    errors: [],
    skipped: null,
  }

  if (facts.protectedProfile) {
    result.skipped = 'protected_profile_sasquatch'
    log.info('audit_skipped_protected', { profileId: facts.profileId })
    return result
  }

  let rows = []
  try {
    rows = await loadPipelineRows(db, profileId)
  } catch (err) {
    result.errors.push({ stage: 'load', error: err?.message || String(err) })
    return result
  }
  result.candidates = rows.length

  /** rows that survived all four gates, keyed by program identity */
  const survivors = new Map()

  for (const row of rows) {
    if (PROTECTED_GRANT_STATUSES.has(String(row.grant_status ?? '').toLowerCase())) {
      result.protected += 1
      continue
    }

    let verdict = null
    let failedGate = null
    try {
      for (const gate of GATE_ORDER) {
        if (gate === GATES.RELATABLE) verdict = gateRelatable(row, { now })
        else if (gate === GATES.QUALIFIES) verdict = gateQualifies(row, facts)
        else if (gate === GATES.COVERS_NEED) verdict = gateCoversNeed(row, facts)
        else if (gate === GATES.REAL) {
          if (!realGate) { verdict = { pass: true, reason: null, evidence: { gate: 'real', detail: 'network_gate_disabled' } }; continue }

          verdict = await gateReal(row, { now, checkUrl })
        }
        if (verdict?.unverifiable) { failedGate = gate; break }
        if (!verdict?.pass) { failedGate = gate; break }
      }
    } catch (err) {
      result.failed += 1
      result.errors.push({ grant_id: row.grant_id, title: row.title, error: err?.message || String(err) })
      continue
    }

    if (verdict?.unverifiable) {
      // KEPT, and reported separately. This is the deliberate reading of
      // "cannot answer yes": determined NO, not "could not check".
      result.unverifiable += 1
      result.removals.push({
        grant_id: row.grant_id, title: row.title, outcome: 'unverifiable',
        gate: failedGate, evidence: verdict.evidence,
      })
      continue
    }

    if (!verdict?.pass) {
      if (verdict?.harvest_first) {
        result.harvest_first.push({
          grant_id: row.grant_id,
          opportunity_id: row.funding_opportunity_id ?? null,
          title: row.title,
          url: row.application_url || row.source_url || null,
          reason: verdict.reason,
        })
      }
      try {

        await removeFromPipeline(db, { facts, row, gate: failedGate, verdict, userId })
      } catch (err) {
        result.failed += 1
        result.errors.push({ grant_id: row.grant_id, stage: 'remove', error: err?.message || String(err) })
        continue
      }
      result.removed += 1
      result.removed_by_gate[failedGate] = (result.removed_by_gate[failedGate] || 0) + 1
      const reasonKey = `${failedGate}:${verdict?.reason ?? 'failed'}`
      result.removed_by_reason[reasonKey] = (result.removed_by_reason[reasonKey] || 0) + 1
      result.removals.push({
        grant_id: row.grant_id, title: row.title, funder: row.sponsor,
        outcome: 'removed', gate: failedGate, reason: verdict?.reason ?? null,
        evidence: verdict?.evidence ?? null,
      })
      result.notes.push(buildAmyNotation({ facts, row, gate: failedGate, verdict, runId, now }))
      continue
    }

    // Passed all four. Dedup on PROGRAM IDENTITY (a pairwise predicate, not a
    // hash key — the owner's duplicate pairs are SUBSETS, not equal strings).
    const key = programIdentityKey(row)
    let matchedKey = survivors.has(key) ? key : null
    if (!matchedKey) {
      for (const [existingKey, existingRow] of survivors.entries()) {
        if (sameProgram(existingRow, row)) { matchedKey = existingKey; break }
      }
    }
    if (!matchedKey) { survivors.set(key, row); continue }
    const incumbent = survivors.get(matchedKey)
    const winner = betterOf(incumbent, row)
    const loser = winner === incumbent ? row : incumbent
    survivors.set(matchedKey, winner)
    try {

      await removeFromPipeline(db, {
        facts, row: loser, gate: 'duplicate',
        verdict: { reason: REJECTION_REASONS.DUPLICATE, evidence: { kept_grant_id: winner.grant_id, kept_title: winner.title, identity_key: matchedKey } },
        userId,
      })
      result.deduped_away += 1
      result.removals.push({
        grant_id: loser.grant_id, title: loser.title, outcome: 'deduped',
        gate: 'duplicate', reason: REJECTION_REASONS.DUPLICATE,
        evidence: { kept_grant_id: winner.grant_id, kept_title: winner.title, identity_key: matchedKey },
      })
    } catch (err) {
      result.failed += 1
      result.errors.push({ grant_id: loser.grant_id, stage: 'dedup', error: err?.message || String(err) })
    }
  }

  result.kept = survivors.size

  // ── ACCOUNTING IDENTITY. A silent no-op reported as success is the owner's
  // #1 recurring defect, so this is an assertion, not a log line.
  const accounted = result.kept + result.protected + result.removed +
    result.deduped_away + result.unverifiable + result.failed
  result.accounting = {
    candidates: result.candidates,
    kept: result.kept,
    protected: result.protected,
    removed_by_gate: result.removed,
    deduped_away: result.deduped_away,
    unverifiable: result.unverifiable,
    failed: result.failed,
    accounted,
    balanced: accounted === result.candidates,
  }
  if (!result.accounting.balanced) {
    throw new Error(
      `robertPipelineAudit accounting broken for ${facts.profileId}: ` +
      `candidates=${result.candidates} but kept+protected+removed+deduped+unverifiable+failed=${accounted}`,
    )
  }

  if (result.notes.length > 0) {
    await persistGapNotes(db, result.notes, { runId, now }).catch((e) =>
      result.errors.push({ stage: 'gap_notes', error: e?.message || String(e) }))
  }
  return result
}

/**
 * Audit EVERY profile's pipeline (or the given subset), then reconcile the
 * tombstones ONCE so the removals actually leave the pipeline.
 */
export async function auditAllPipelines(db, {
  profileIds = null,
  userId = 'agent:robert',
  runId = null,
  now = new Date(),
  checkUrl = defaultCheckUrl,
  realGate = true,
} = {}) {
  let ids = Array.isArray(profileIds) && profileIds.length > 0 ? profileIds.map(String) : null
  if (!ids) {
    try {
      const rows = await db.prepare(
        "SELECT id FROM profiles WHERE (deleted_at IS NULL) AND (status IS NULL OR status <> 'deleted')",
      ).all()
      ids = (rows || []).map((r) => String(r.id))
    } catch {
      const rows = await db.prepare('SELECT id FROM profiles').all()
      ids = (rows || []).map((r) => String(r.id))
    }
  }

  const summary = {
    run_id: runId,
    started_at: now.toISOString(),
    profiles: [],
    totals: {
      profiles: ids.length, candidates: 0, kept: 0, protected: 0, removed: 0,
      deduped_away: 0, unverifiable: 0, failed: 0,
      removed_by_gate: { relatable: 0, qualifies: 0, covers_need: 0, real: 0 },
      removed_by_reason: {},
      amy_levers: 0, code_briefs: 0, harvest_first: 0,
    },
    reconciled: 0,
    unverifiable_policy:
      'A row the REAL gate could not resolve (503 / timeout / bot wall / SSRF refusal) is REPORTED as unverifiable and LEFT in the pipeline. ' +
      '"Cannot answer yes" is read as DETERMINED NO, never as "could not check". State this to the owner so it can be overruled.',
  }

  for (const profileId of ids) {
    let one
    try {

      one = await auditProfilePipeline(db, profileId, { userId, runId, now, checkUrl, realGate })
    } catch (err) {
      one = { profile_id: String(profileId), errors: [{ stage: 'audit', error: err?.message || String(err) }], candidates: 0, kept: 0, protected: 0, removed: 0, deduped_away: 0, unverifiable: 0, failed: 0, removed_by_gate: {}, removed_by_reason: {}, notes: [], harvest_first: [] }
    }
    summary.profiles.push(one)
    const t = summary.totals
    t.candidates += one.candidates || 0
    t.kept += one.kept || 0
    t.protected += one.protected || 0
    t.removed += one.removed || 0
    t.deduped_away += one.deduped_away || 0
    t.unverifiable += one.unverifiable || 0
    t.failed += one.failed || 0
    t.harvest_first += (one.harvest_first || []).length
    for (const [gate, n] of Object.entries(one.removed_by_gate || {})) t.removed_by_gate[gate] = (t.removed_by_gate[gate] || 0) + n
    for (const [reason, n] of Object.entries(one.removed_by_reason || {})) t.removed_by_reason[reason] = (t.removed_by_reason[reason] || 0) + n
    for (const note of one.notes || []) {
      if (note.channel === 'amy_lever') t.amy_levers += 1
      else t.code_briefs += 1
    }
  }

  // Tombstones become actual removals here — the SAME reconcile the dismissal
  // route and pipelineEligibilitySweep use.
  try {
    summary.reconciled = await reconcileDismissedGrants(db)
  } catch (err) {
    summary.reconcile_error = err?.message || String(err)
  }

  const t = summary.totals
  const accounted = t.kept + t.protected + t.removed + t.deduped_away + t.unverifiable + t.failed
  t.accounted = accounted
  t.balanced = accounted === t.candidates
  summary.finished_at = new Date().toISOString()

  // LOUD on a zero-work run. A quiet exit 0 is the defect this rule exists for.
  if (t.candidates === 0) {
    log.warn('pipeline_audit_no_candidates', { profiles: ids.length })
  } else if (t.removed === 0 && t.deduped_away === 0) {
    log.warn('pipeline_audit_removed_nothing', {
      profiles: ids.length, candidates: t.candidates, kept: t.kept,
      unverifiable: t.unverifiable, protected: t.protected,
    })
  }
  log.info('pipeline_audit', t)
  return summary
}

export default {
  GATES,
  GATE_ORDER,
  auditAllPipelines,
  auditProfilePipeline,
  buildAmyNotation,
  gateCoversNeed,
  gateQualifies,
  gateReal,
  gateRelatable,
  isAmyAutonomousLever,
  loadGapNotesForAmy,
  loadPipelineRows,
  loadProfileFacts,
  markGapNotesConsumed,
  persistGapNotes,
  programIdentityKey,
  programTokens,
  rankDuplicate,
  sameProgram,
}
