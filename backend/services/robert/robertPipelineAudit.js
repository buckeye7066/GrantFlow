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
import { programIdentityKey, sameProgram, programTokens } from "../../config/programIdentity.js"
import { isPointerKind, pointerKindSql } from '../../config/opportunityKindClasses.js'
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
import {
  declaredNeedsFrom,
  evaluateDeclaredNeedCoverage,
  NEED_COVERAGE_DETAIL,
  parseMaybeJson,
} from '../pipelinePrecision.js'
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

// The need vocabulary (canonical registry, structured DECLARED_NEED_FIELDS,
// "silence is neutral") lives in services/pipelinePrecision.js — the ONE
// implementation the admission gate (opportunityMatcher Gate 1.9), the boot
// removal sweep (enforceInvariants.enforcePipelinePrecision) and this audit
// all consume. Re-encoding it here is how the two halves drift.

/**
 * Derive the facts every gate reads from a profile ROW + its parsed sections.
 * Pure — the admission gate (which already holds the row + sections in memory)
 * and the DB-backed `loadProfileFacts` both consume it, so "what the profile
 * declares" has exactly one reading.
 */
export function deriveProfileFacts(row, sections, { profileId = null } = {}) {
  const sectionMap = {}
  for (const [key, value] of Object.entries(sections && typeof sections === 'object' ? sections : {})) {
    const parsed = parseMaybeJson(value, null)
    if (parsed && typeof parsed === 'object') sectionMap[key] = parsed
  }
  const basic = sectionMap.basic_information ?? sectionMap.basic_info ?? {}
  const applicantType = row?.applicant_type || row?.primary_type ||
    basic?.profile_category || basic?.applicant_type || null

  // States: declared only. A missing state stays NEUTRAL (isRelevantGeo's own
  // rule) — it must never become a reason to delete someone's funding.
  const states = []
  for (const candidate of [basic?.state, basic?.state_code, sectionMap.location_focus?.state, row?.state]) {
    if (typeof candidate === 'string' && candidate.trim()) states.push(candidate.trim())
  }

  // Needs: STRUCTURED declarations only (services/pipelinePrecision.js).
  // `buildProfileSignals` mines free text, and free text carries its own
  // DENIALS ("we do not need housing assistance") — the veteran-gate class
  // this repo has shipped twice.
  const needs = declaredNeedsFrom(row, sectionMap)

  return {
    profileId: String(profileId ?? row?.id ?? ''),
    displayName: row?.display_name ?? null,
    profile: row ?? null,
    sections: sectionMap,
    applicantType,
    states,
    needs,
    protectedProfile: PROTECTED_PROFILE_NAME_RX.test(String(row?.display_name ?? '')),
  }
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

  return deriveProfileFacts(row, sections, { profileId })
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
/** `grants` columns the gates read — [column, alias]. */
const GRANT_ROW_COLUMNS = Object.freeze([
  ['id', 'grant_id'], ['profile_id', 'profile_id'], ['funding_opportunity_id', 'funding_opportunity_id'],
  ['title', 'grant_title'], ['funder', 'funder'], ['status', 'grant_status'], ['deadline', 'grant_deadline'],
  ['application_url', 'grant_application_url'], ['url', 'grant_url'], ['amount_requested', 'amount_requested'],
  ['match_score', 'match_score'], ['match_decision', 'match_decision'], ['updated_at', 'updated_at'],
])

/** `funding_opportunities` columns the gates read — [column, alias]. */
const OPPORTUNITY_ROW_COLUMNS = Object.freeze([
  ['title', 'opp_title'], ['sponsor', 'sponsor'], ['description', 'description'],
  ['eligibility_text', 'eligibility_text'], ['eligibility_bullets', 'eligibility_bullets'],
  ['entity_types_allowed', 'entity_types_allowed'], ['need_types_supported', 'need_types_supported'],
  ['categories', 'categories'], ['keywords', 'keywords'], ['opportunity_kind', 'opportunity_kind'],
  ['opportunity_type', 'opportunity_type'], ['funding_category', 'funding_category'], ['source', 'source'],
  ['source_url', 'source_url'], ['application_url', 'opp_application_url'], ['apply_url', 'apply_url'],
  ['final_url', 'final_url'], ['evidence_url', 'evidence_url'], ['external_id', 'external_id'],
  ['state', 'state'], ['is_national', 'is_national'], ['deadline', 'opp_deadline'],
  ['deadline_type', 'deadline_type'], ['amount_min', 'amount_min'], ['amount_max', 'amount_max'],
  ['amount_text', 'amount_text'], ['is_active', 'is_active'], ['link_status', 'link_status'],
  ['canonical_opportunity_key', 'canonical_opportunity_key'],
])

/**
 * Columns that MUST exist for the gates to see any evidence at all. A schema
 * lacking one of these is reported (thrown), never silently degraded to a
 * bare-title sweep that "keeps" everything.
 */
export const REQUIRED_PIPELINE_ROW_COLUMNS = Object.freeze({
  grants: ['id', 'profile_id', 'title', 'status'],
  funding_opportunities: ['title', 'sponsor', 'entity_types_allowed', 'need_types_supported', 'categories', 'opportunity_kind', 'source_url'],
})

const _columnCache = new WeakMap()

async function listColumns(db, table) {
  const cached = _columnCache.get(db)
  if (cached?.[table]) return cached[table]
  let names
  try {
    if ((db?.dialect || 'sqlite') === 'postgres') {
      const rows = await db
        .prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?")
        .all(table)
      names = new Set((rows || []).map((r) => String(r.column_name)))
    } else {
      const rows = await db.prepare(`PRAGMA table_info(${table})`).all()
      names = new Set((rows || []).map((r) => String(r.name)))
    }
  } catch {
    names = new Set()
  }
  _columnCache.set(db, { ...(cached || {}), [table]: names })
  return names
}

/**
 * Build the pipeline-row SELECT from the columns that ACTUALLY EXIST on this
 * database. Prod Postgres 2026-08-22: `funding_opportunities` has no
 * `external_id` column, so a hand-written SELECT naming it threw
 * `column fo.external_id does not exist` for EVERY profile — the manual audit
 * tool failed outright and a boot net reading it would have logged a warning
 * and reported "scanned 0" as green. Optional columns are selected as
 * `NULL AS alias`; REQUIRED ones missing throw with the column named.
 */
export async function buildPipelineRowSql(db) {
  const grantCols = await listColumns(db, 'grants')
  const oppCols = await listColumns(db, 'funding_opportunities')
  const missingGrant = REQUIRED_PIPELINE_ROW_COLUMNS.grants.filter((c) => grantCols.size > 0 && !grantCols.has(c))
  const missingOpp = REQUIRED_PIPELINE_ROW_COLUMNS.funding_opportunities.filter((c) => oppCols.size > 0 && !oppCols.has(c))
  if (missingGrant.length || missingOpp.length) {
    throw new Error(
      `pipeline row evidence columns missing — grants: [${missingGrant.join(', ')}] funding_opportunities: [${missingOpp.join(', ')}]`,
    )
  }
  const pick = (alias, cols, prefix) => cols.map(([col, as]) =>
    (alias.size === 0 || alias.has(col)) ? `${prefix}.${col} AS ${as}` : `NULL AS ${as}`)
  const selects = [
    ...pick(grantCols, GRANT_ROW_COLUMNS, 'g'),
    ...pick(oppCols, OPPORTUNITY_ROW_COLUMNS, 'fo'),
  ]
  // FUNDER LEADS are a DISTINCT pipeline category (config/pipelineCategory.js):
  // a research/relationship prospect Robert auto-added and is investigating,
  // NOT a leaf application. They are directory-kind grantmaker rows, so the
  // RELATABLE gate would wrongly remove them — and their qualification was
  // already decided on the funder-specific four gates at admission. So the
  // four-gate AUDIT and the pipeline-precision boot net never see them here.
  const funderLeadExclusion = grantCols.has('pipeline_category')
    ? `\n    AND NOT (
      LOWER(COALESCE(g.pipeline_category, '')) = 'funder_lead'
      AND ${pointerKindSql('fo.opportunity_kind')}
      AND ${oppCols.has('source') ? "LOWER(COALESCE(fo.source, '')) <> 'grants_gov'" : 'TRUE'}
      AND ${oppCols.has('deadline') ? 'fo.deadline IS NULL' : 'TRUE'}
    )`
    : ''
  return `
  SELECT
    ${selects.join(',\n    ')}
  FROM grants g
  LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
  WHERE g.profile_id = ?${funderLeadExclusion}
`
}

/**
 * Pipeline statuses a human has ALREADY progressed. Never auto-removed — the
 * standing guardrail ("protected (user-progressed) statuses are never
 * auto-purged").
 */
export const PROTECTED_GRANT_STATUSES = Object.freeze(new Set([
  'submitted', 'awarded', 'declined', 'follow_up', 'in_review', 'under_review', 'archived',
]))

export async function loadPipelineRows(db, profileId) {
  const sql = await buildPipelineRowSql(db)
  const rows = await db.prepare(sql).all(String(profileId))
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
  // ONE implementation (services/pipelinePrecision.js) shared with the
  // admission gate and the boot sweep. Silence on either side is neutral and
  // REPORTED through `detail`, never folded into a bare "kept".
  const verdict = evaluateDeclaredNeedCoverage(row, facts?.needs)
  const neutralSilence = verdict.detail === NEED_COVERAGE_DETAIL.PROFILE_DECLARES_NO_NEEDS ||
    verdict.detail === NEED_COVERAGE_DETAIL.OPPORTUNITY_STATES_NO_NEEDS
  if (verdict.pass || neutralSilence) {
    return {
      pass: true,
      reason: null,
      evidence: {
        gate: 'covers_need',
        detail: verdict.detail,
        ...(verdict.matched.length > 0 ? { matched: verdict.matched } : {}),
      },
    }
  }
  return {
    pass: false,
    reason: REJECTION_REASONS.PROFILE_MISMATCH,
    evidence: {
      gate: 'covers_need',
      detail: verdict.detail,
      profile_needs: verdict.profile_needs,
      opportunity_needs: verdict.opportunity_needs,
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
/**
 * The DETERMINISTIC half of the REAL gate — the funder's own words say the
 * program ended, the deadline is long past, or there is no URL at all. No
 * network. The boot sweep (`enforceInvariants.enforcePipelinePrecision`) runs
 * ONLY this half: a boot must not spend minutes on HEAD requests, and an outage
 * during boot must never read as "dead". Returns `null` when this half has
 * nothing to say (the networked half then decides for Robert).
 */
export function gateRealOffline(row, { now = new Date() } = {}) {
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
  return null
}

export async function gateReal(row, { now = new Date(), checkUrl = defaultCheckUrl, attempts = REAL_GATE_MAX_ATTEMPTS } = {}) {
  const offline = gateRealOffline(row, { now })
  if (offline) return offline
  const url = row?.application_url || row?.source_url || null

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
// Program identity moved to backend/config/programIdentity.js (2026-08-25) so the
// OWNER-FACING read path can consult the SAME predicate. Re-exported here so
// every existing importer of this module keeps working and the two cannot drift.
export {
  programTokens,
  programIdentityKey,
  sameProgram,
  MIN_LONE_TOKEN_IDENTITY_LENGTH,
} from "../../config/programIdentity.js"

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
    // Duplicate removals are row-specific cleanup, not a user rejection of
    // the program title. Persist only the losing opportunity id so the kept
    // twin cannot be removed later by title/fingerprint reconciliation.
    grantRow: gate === 'duplicate'
      ? { id: row.grant_id, funding_opportunity_id: row.funding_opportunity_id }
      : {
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
      const rowTitle = String(row.title || '').trim().replace(/\s+/g, ' ').toLowerCase()
      for (const [existingKey, existingRow] of survivors.entries()) {
        const existingTitle = String(existingRow.title || '').trim().replace(/\s+/g, ' ').toLowerCase()
        // Exact normalized titles are duplicate program rows even when two
        // ingestion lanes minted disagreeing canonical keys.
        if ((rowTitle && rowTitle === existingTitle) || sameProgram(existingRow, row)) {
          matchedKey = existingKey
          break
        }
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
  deriveProfileFacts,
  gateCoversNeed,
  gateQualifies,
  gateReal,
  gateRealOffline,
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
