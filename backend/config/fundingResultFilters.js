/**
 * fundingResultFilters.js — THE SHARED FILTER CHAIN for owner-facing funding
 * results (owner QA pass across all 36 profiles, 2026-08-03).
 *
 * The owner ran Crawler OS "Funding Sources" for every profile plus the Item
 * Funding scanner and found whole junk classes still surfacing:
 *   - regulatory/administrative notices presented as grants (SEC self-regulatory
 *     rule changes, IRS/OMB comment requests, a DOL prohibited-transaction
 *     exemption for Meta Platforms, DOJ antitrust filings) — the engine's
 *     procedural gate existed but its pattern registry was narrower than the
 *     live junk, and STORED match rows predate the gate entirely (the match
 *     store is a rolling snapshot; a stored ACCEPT is replayed verbatim by the
 *     funding-sources route's persisted-truth policy);
 *   - lead-gen "scholarships" ("Portal Sync", "Pawsitively Smart", "YouGov
 *     Voice of the Future");
 *   - clearly-expired programs (COVID-19 Rapid Response, PY2020 allotments);
 *   - records with no fundable signal at all surfacing as direct matches.
 *
 * ONE chain, THREE owner-named predicates — `isFundableOpportunity`,
 * `passesEligibility`, `isRelevantGeo` — consumed by BOTH the crawler results
 * path (matchEngine.makeDecision per-call gate + fundingSourcePresentation
 * read-side partition + the enforceInvariants boot net) and the item scanner
 * (itemNeedSearch). Never re-encode these rules at a call site.
 *
 * HOUSE RULES HONORED HERE:
 *   - The canonical procedural regex stays `RE_PROCEDURAL_NOTICE_TITLE`
 *     (opportunityNormalizer.js) — this module CONSUMES it, extending its
 *     consultation to read paths; it does not fork a second copy.
 *   - MISSING = NEUTRAL: a row that states nothing is never junk for silence
 *     alone (the fundable-signal rule routes it to resources, it never deletes).
 *   - Locator rule: pointer kinds stay in the directories bucket — they are
 *     never dropped from lists and never promoted to direct matches.
 *   - SQL predicates before LIMIT: the boot sweep consumes the LIKE supersets
 *     exported here; the JS classifiers adjudicate each candidate.
 */

import { RE_PROCEDURAL_NOTICE_TITLE } from '../services/opportunityNormalizer.js'
import { hostnameOf, detectForeignOpportunity } from './opportunityJurisdiction.js'
import { resolvedUsOpportunityJurisdiction } from './canonicalUsJurisdiction.js'
import { isPointerKind } from './opportunityKindClasses.js'
import { normalizeState } from '../utils/stateNormalization.js'

/** Hosts whose documents are regulatory-register records, never funding pages. */
export const REGULATORY_SOURCE_HOSTS = Object.freeze(['federalregister.gov'])

const URL_FIELDS = Object.freeze([
  'source_url', 'application_url', 'apply_url', 'url', 'evidence_url', 'info_url',
])

/** True when the row's own url or source provenance is the Federal Register. */
export function isFederalRegisterSource(row) {
  if (!row || typeof row !== 'object') return false
  const source = `${row.source ?? ''} ${row.source_id ?? ''}`.toLowerCase()
  if (/\bfederal[_ ]register\b/.test(source)) return true
  for (const field of URL_FIELDS) {
    const host = hostnameOf(row[field])
    if (!host) continue
    for (const regHost of REGULATORY_SOURCE_HOSTS) {
      if (host === regHost || host.endsWith(`.${regHost}`)) return true
    }
  }
  return false
}

/**
 * Regulatory/administrative notice classifier. The TITLE authority is the
 * canonical RE_PROCEDURAL_NOTICE_TITLE (extended 2026-08-03 with the owner's
 * verbatim junk list); the SOURCE authority is the Federal Register host.
 * Returns a reason string or null.
 */
export function classifyRegulatoryNotice(row) {
  if (!row || typeof row !== 'object') return null
  const title = String(row.title ?? '')
  if (title && RE_PROCEDURAL_NOTICE_TITLE.test(title)) return 'regulatory_notice_title'
  if (isFederalRegisterSource(row)) return 'federal_register_source'
  return null
}

/**
 * Lead-generation "scholarships" — marketing funnels wearing a scholarship
 * costume. REGISTRY of funder/program identities the owner named; word-bounded,
 * identity fields only (title + sponsor, never description prose).
 */
export const LEAD_GEN_SCHOLARSHIP_PATTERNS = Object.freeze([
  { rx: /\bportal sync\b/i, label: 'Portal Sync' },
  { rx: /\bpawsitively smart\b/i, label: 'Pawsitively Smart' },
  { rx: /\byougov\b/i, label: 'YouGov' },
])

export function isLeadGenScholarship(row) {
  if (!row || typeof row !== 'object') return null
  const identity = `${row.title ?? ''} ${row.sponsor ?? row.funder ?? ''}`
  if (!identity.trim()) return null
  for (const entry of LEAD_GEN_SCHOLARSHIP_PATTERNS) {
    if (entry.rx.test(identity)) return entry.label
  }
  return null
}

/**
 * Clearly-expired program shapes. A PY (program-year) allotment names its own
 * program year; one at least a full year in the past is over regardless of any
 * stored deadline. COVID-19 "rapid response" emergency programs ended with the
 * emergency. A past FIRM deadline alone only FLAGS (`stale`) — deadline data is
 * often the crawler's fault, not the program's — but one > `EXPIRED_DEADLINE_
 * GRACE_DAYS` past is treated as clearly expired.
 */
export const STALE_PROGRAM_PATTERNS = Object.freeze([
  { rx: /\bcovid[-\s]?19\b.{0,40}\brapid response\b|\brapid response\b.{0,40}\bcovid[-\s]?19\b/i, label: 'covid_rapid_response' },
])

export const PROGRAM_YEAR_RX = /\bpy\s?(20[0-9]{2})\b/i

export const EXPIRED_DEADLINE_GRACE_DAYS = 180

export function isClearlyExpiredProgram(row, now = new Date()) {
  if (!row || typeof row !== 'object') return null
  const title = String(row.title ?? '')
  for (const entry of STALE_PROGRAM_PATTERNS) {
    if (entry.rx.test(title)) return entry.label
  }
  const py = PROGRAM_YEAR_RX.exec(title)
  if (py) {
    const year = Number(py[1])
    if (Number.isFinite(year) && year < now.getFullYear() - 1) return `program_year_${year}`
  }
  const deadlineType = String(row.deadline_type ?? '').toLowerCase()
  if (row.deadline && deadlineType !== 'rolling') {
    const t = Date.parse(row.deadline)
    if (Number.isFinite(t) && now.getTime() - t > EXPIRED_DEADLINE_GRACE_DAYS * 86400000) {
      return 'deadline_long_past'
    }
  }
  return null
}

/** A past firm deadline that has NOT yet crossed the clearly-expired grace. */
export function isPastDeadline(row, now = new Date()) {
  if (!row?.deadline) return false
  if (String(row.deadline_type ?? '').toLowerCase() === 'rolling') return false
  const t = Date.parse(row.deadline)
  return Number.isFinite(t) && t < now.getTime()
}

/** The anonymized funder label no record may carry (owner rule 2026-08-03). */
export const ANONYMIZED_FUNDER_RX = /^u\.?s\.?\s*federal agency(?:\s*[–—-]\s*national)?$/i

export function isAnonymizedFunder(sponsor) {
  const s = String(sponsor ?? '').trim()
  return s ? ANONYMIZED_FUNDER_RX.test(s) : false
}

/**
 * FUNDABLE SIGNAL — a record may enter DIRECT results only when it states at
 * least one signal a person could act on: an award amount/range, an apply URL,
 * a deadline (or explicit rolling), or a known program id from a structured
 * source. Everything else is a resource/lead, never a direct match.
 *
 * MISSING = NEUTRAL is preserved by ROUTING, not deletion: a signal-less row is
 * presented under "Directories & resources", it is never removed.
 */
export function fundableSignalsOf(row) {
  if (!row || typeof row !== 'object') return []
  const signals = []
  const amt = (v) => Number.isFinite(Number(v)) && Number(v) > 0
  if (amt(row.amount_min) || amt(row.amount_max) || amt(row.amount_requested)) signals.push('award_amount')
  else if (typeof row.amount_text === 'string' && row.amount_text.trim()) signals.push('award_amount_text')
  if (String(row.application_url ?? row.apply_url ?? '').trim()) signals.push('apply_url')
  if (row.deadline) signals.push('deadline')
  // EXPLICIT rolling only. Read surfaces fabricate `is_rolling: !deadline`
  // ("no deadline stated" is silence, not a statement of rolling), so that
  // flag would make every signal-less row read as fundable.
  else if (String(row.deadline_type ?? '').toLowerCase() === 'rolling') signals.push('rolling')
  if (String(row.external_id ?? row.opportunity_number ?? '').trim()) signals.push('program_id')
  return signals
}

export function hasFundableSignal(row) {
  return fundableSignalsOf(row).length > 0
}

/** Result buckets, in the order the chain decides them. */
export const RESULT_BUCKETS = Object.freeze({
  NOT_A_GRANT: 'not_a_grant',
  RESOURCE: 'resource',
  FUNDABLE: 'fundable',
})

/**
 * "<Org> near <Place>, XX" — the countyCityDirectoryAdapter minting shape.
 * Requires the two-letter state anchor after the comma; "near" alone is
 * ordinary English.
 */
export const PLACE_LOCATOR_TITLE_RX = /\bnear\s+[A-Za-z][A-Za-z .''-]{1,60},\s*[A-Z]{2}\b/

/**
 * Resource/data hubs measured leaking into direct matches 2026-08-03 (College
 * Scorecard linked at score 78): exact lower-cased title identity only.
 */
export const RESOURCE_HUB_TITLES = Object.freeze(new Set([
  'college scorecard',
  'state higher ed agencies',
  'united way worldwide',
]))

/**
 * The chain, in one place. Returns `{ bucket, reasons, stale }`:
 *   - not_a_grant : hidden bucket — regulatory/lead-gen/clearly-expired/
 *                   anonymized-funder records. Never Best matches / Worth
 *                   reviewing; kept retrievable, never silently deleted here.
 *   - resource    : pointer kinds and records with no fundable signal — the
 *                   existing "Directories & resources" presentation.
 *   - fundable    : everything else (the only bucket direct matches come from).
 */
export function classifyFundingResult(row, { now = new Date() } = {}) {
  const reasons = []
  if (!row || typeof row !== 'object') return { bucket: RESULT_BUCKETS.RESOURCE, reasons: ['empty_row'], stale: false }

  const regulatory = classifyRegulatoryNotice(row)
  if (regulatory) reasons.push(regulatory)
  const leadGen = isLeadGenScholarship(row)
  if (leadGen) reasons.push(`lead_gen:${leadGen}`)
  const expired = isClearlyExpiredProgram(row, now)
  if (expired) reasons.push(`expired:${expired}`)
  if (isAnonymizedFunder(row.sponsor ?? row.funder)) reasons.push('unresolvable_funder')
  if (reasons.length > 0) {
    return { bucket: RESULT_BUCKETS.NOT_A_GRANT, reasons, stale: Boolean(expired) }
  }

  const stale = isPastDeadline(row, now)
  const kind = String(row.opportunity_kind ?? '').trim()
  if ((kind && isPointerKind(kind)) || row.is_directory === true || row.is_resource === true) {
    return { bucket: RESULT_BUCKETS.RESOURCE, reasons: ['pointer_kind'], stale }
  }
  // Machine-minted per-place locator rows carry the "<Org> near <Place>, XX"
  // title shape with a NULL kind column, so the pointer-kind check above never
  // sees them. Live leak measured 2026-08-03: the first write-enabled
  // catalog-rescore pass linked "United Way near Auburntown, TN" (+ Brentwood,
  // Charlotte, … near-duplicate place variants) to one profile at score 69 —
  // pointers presented as direct matches. The SHAPE is the claim (a real award
  // titled "…near…" without the ", XX" anchor is untouched).
  const title = String(row.title ?? '')
  if (PLACE_LOCATOR_TITLE_RX.test(title)) {
    return { bucket: RESULT_BUCKETS.RESOURCE, reasons: ['place_locator_title'], stale }
  }
  // Known resource/data hubs that carry a URL (a "fundable signal") but award
  // nothing — REGISTRY of measured leaks, exact identity match only, so a real
  // scholarship whose title merely contains one of these phrases is untouched.
  if (RESOURCE_HUB_TITLES.has(title.trim().toLowerCase())) {
    return { bucket: RESULT_BUCKETS.RESOURCE, reasons: ['resource_hub_registry'], stale }
  }
  if (!hasFundableSignal(row)) {
    return { bucket: RESULT_BUCKETS.RESOURCE, reasons: ['no_fundable_signal'], stale }
  }
  return { bucket: RESULT_BUCKETS.FUNDABLE, reasons: [], stale }
}

/** Owner-named predicate #1: may this record enter DIRECT funding results? */
export function isFundableOpportunity(row, opts) {
  return classifyFundingResult(row, opts).bucket === RESULT_BUCKETS.FUNDABLE
}

/**
 * Institutional pass-through / formula programs an INDIVIDUAL can never apply
 * to directly (funds flow to states/localities/institutions): the owner's
 * verbatim list. Identity fields only.
 */
export const INSTITUTIONAL_PASS_THROUGH_PATTERNS = Object.freeze([
  { rx: /\bcommunity development block grant\b|\bcdbg\b/i, label: 'CDBG' },
  { rx: /\bemergency solutions grants?\b/i, label: 'Emergency Solutions Grants' },
  { rx: /\beconomic development administration\b.{0,60}\bplanning\b|\beda\b.{0,20}\bplanning (?:program|grants?)\b/i, label: 'EDA planning' },
  // The FORMULA grant to state agencies only — "State Vocational Rehabilitation
  // SERVICES" is what an individual actually accesses and must never match
  // (caught by conditionSpecificFlagGate's counterweight fixture).
  { rx: /\bvocational rehabilitation\b.{0,40}\b(?:state grants?|formula|allotments?)\b|\bstate grants?\b.{0,40}\bvocational rehabilitation\b/i, label: 'State Voc-Rehab formula' },
  { rx: /\bwioa\b.{0,60}\ballotments?\b|\bworkforce innovation and opportunity act\b.{0,60}\ballotments?\b/i, label: 'WIOA allotments' },
  { rx: /\baarp community challenge\b/i, label: 'AARP Community Challenge' },
])

export function institutionalPassThroughConflict(row) {
  if (!row || typeof row !== 'object') return null
  const identity = `${row.title ?? ''} ${row.sponsor ?? row.funder ?? ''}`
  if (!identity.trim()) return null
  for (const entry of INSTITUTIONAL_PASS_THROUGH_PATTERNS) {
    if (entry.rx.test(identity)) return entry.label
  }
  return null
}

/**
 * Programs whose ONLY eligible applicants are government agencies (federal
 * cooperative programs with states) — the "Vermilion Church at 100% for Feral
 * Swine Eradication" class. Tight, program-anchored patterns; each entry names
 * a real federal program family, never a bare topic.
 */
export const GOVERNMENT_AGENCY_PROGRAM_PATTERNS = Object.freeze([
  { rx: /\bferal swine\b.{0,40}\b(?:eradication|control)\b|\b(?:eradication|control)\b.{0,40}\bferal swine\b/i, label: 'Feral Swine Eradication & Control (state cooperative)' },
  { rx: /\baquatic invasive species\b.{0,60}\binterjurisdictional\b|\binterjurisdictional\b.{0,60}\baquatic invasive species\b|\baquatic invasive species\b.{0,60}\bgreat lakes states\b/i, label: 'Aquatic Invasive Species interjurisdictional (state cooperative)' },
])

export function agencyOnlyProgramConflict(row) {
  if (!row || typeof row !== 'object') return null
  const identity = `${row.title ?? ''} ${row.sponsor ?? row.funder ?? ''}`
  if (!identity.trim()) return null
  for (const entry of GOVERNMENT_AGENCY_PROGRAM_PATTERNS) {
    if (entry.rx.test(identity)) return entry.label
  }
  return null
}

/**
 * Owner-named predicate #2: hard applicant-side eligibility.
 *
 * `facts` carries only what the CALLER has already resolved (matchEngine
 * resolves roots through profileTypeRegistry; the report script resolves them
 * the same way). MISSING = NEUTRAL: a null/undefined fact never fails a row.
 *   - individualRoot:  true when the profile roots to a person/household.
 *   - publicAgencyRoot: true when the profile roots to a government agency.
 *   - professions:      Set of recognised professions (professionEligibility),
 *                       consulted against the row's identity lock by the caller
 *                       (kept there so this config module stays dependency-light).
 */
export function passesEligibility(row, facts = {}) {
  const passThrough = institutionalPassThroughConflict(row)
  if (passThrough && facts.individualRoot === true) {
    return {
      eligible: false,
      reason: `institutional_pass_through:${passThrough}`,
      explanation: `${passThrough} funds flow to states, localities, and institutions — an individual cannot apply directly`,
    }
  }
  const agencyOnly = agencyOnlyProgramConflict(row)
  if (agencyOnly && facts.publicAgencyRoot === false) {
    return {
      eligible: false,
      reason: `government_agency_program:${agencyOnly}`,
      explanation: `${agencyOnly} is a federal cooperative program for government agencies — this profile is not a government agency`,
    }
  }
  return { eligible: true, reason: null, explanation: null }
}

/**
 * Owner-named predicate #3: geography. Foreign funders/jurisdictions are never
 * relevant to a U.S. profile. A row whose own title declares `Place, XX — ...`
 * or whose registered funder/institution carries a canonical state is relevant
 * only in that state. Missing evidence stays neutral; a bare stored `state`
 * remains insufficient because that column is the crawl-noise field being
 * repaired.
 */
export function isRelevantGeo(row, { states = null } = {}) {
  const foreign = detectForeignOpportunity(row)
  if (foreign.foreign) {
    return {
      relevant: false,
      reason: foreign.funder
        ? `foreign_funder:${foreign.funder}`
        : `foreign_jurisdiction:${foreign.host ?? foreign.cctld}`,
    }
  }

  const profileStates = [...new Set(
    (Array.isArray(states) ? states : [])
      .map((state) => normalizeState(state))
      .filter(Boolean),
  )]
  const jurisdiction = resolvedUsOpportunityJurisdiction(row)
  const restrictiveEvidence = jurisdiction.source === 'canonical_funder' ||
    jurisdiction.source === 'declared_title'
  if (
    restrictiveEvidence &&
    jurisdiction.state &&
    profileStates.length > 0 &&
    !profileStates.includes(jurisdiction.state)
  ) {
    const prefix = jurisdiction.source === 'canonical_funder'
      ? `canonical_funder_out_of_state:${jurisdiction.rule_id}`
      : 'declared_place_out_of_state'
    return {
      relevant: false,
      reason: `${prefix}:${jurisdiction.state}`,
      jurisdiction,
    }
  }
  return { relevant: true, reason: null, jurisdiction }
}

/**
 * SQL LIKE superset for the boot net's candidate discovery (title haystack,
 * lower-cased by the caller). A LIKE hit alone never decides — the JS
 * classifiers above adjudicate every candidate (#944: predicates before LIMIT,
 * superset adjudicated, never a post-LIMIT JS filter over an unfiltered scan).
 */
export function nonGrantTitleLikePatterns() {
  return [
    '%information collection%',
    '%self-regulatory organization%',
    '%notice of filing%',
    '%proposed rule change%',
    '%privacy act of 1974%',
    '%system of records%',
    '%systems of records%',
    '%proposed final judgment%',
    '%public hearing%',
    '%prohibited transaction%',
    '%solicitation of nomination%',
    '%request for comment%',
    '%request for information%',
    '%paperwork reduction act%',
    '%day notice%',
    '%notice of re%ission%',
    '%regulatory waiver request%',
    '%federal advisory%',
    // lead-gen identities
    '%portal sync%',
    '%pawsitively smart%',
    '%yougov%',
    // clearly-expired program shapes
    '%covid-19%rapid response%',
    '%covid 19%rapid response%',
    '%rapid response%covid%',
    '%py 20%',
    '%py20%',
  ]
}

export function nonGrantTitleSqlPredicate(hayExpr) {
  const params = nonGrantTitleLikePatterns()
  const clause = params.map(() => `${hayExpr} LIKE ?`).join(' OR ')
  return { clause: `(${clause})`, params }
}

export default {
  REGULATORY_SOURCE_HOSTS,
  isFederalRegisterSource,
  classifyRegulatoryNotice,
  LEAD_GEN_SCHOLARSHIP_PATTERNS,
  isLeadGenScholarship,
  STALE_PROGRAM_PATTERNS,
  PROGRAM_YEAR_RX,
  isClearlyExpiredProgram,
  isPastDeadline,
  ANONYMIZED_FUNDER_RX,
  isAnonymizedFunder,
  fundableSignalsOf,
  hasFundableSignal,
  RESULT_BUCKETS,
  classifyFundingResult,
  isFundableOpportunity,
  INSTITUTIONAL_PASS_THROUGH_PATTERNS,
  institutionalPassThroughConflict,
  GOVERNMENT_AGENCY_PROGRAM_PATTERNS,
  agencyOnlyProgramConflict,
  passesEligibility,
  isRelevantGeo,
  nonGrantTitleLikePatterns,
  nonGrantTitleSqlPredicate,
}
