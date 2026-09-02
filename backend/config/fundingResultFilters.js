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
  // `||` on the sponsor/funder pair: a row whose `sponsor` column is an empty
  // string (not NULL) would stop `??` from ever reading `funder`, so the
  // identity these registries match against silently lost the funder's name.
  const identity = `${row.title ?? ''} ${row.sponsor || row.funder || ''}`
  if (!identity.trim()) return null
  for (const entry of LEAD_GEN_SCHOLARSHIP_PATTERNS) {
    if (entry.rx.test(identity)) return entry.label
  }
  return null
}

/**
 * SITE SECTION / ADMINISTRATIVE PAGES — a program website's own navigation
 * surfaced as a "benefit" (2026-08-22, the four-profile measurement: 8 of one
 * TennCare member's top 10 were site sections stored kind=benefit and
 * ACCEPTed at 89 — 'Program Integrity', 'Waiver and State Plan Public
 * Notices', 'Reimbursement Information for RHC and FQHC Providers', 'Member
 * Benefit Table', 'Programs and Facilities'). The tn_ecf_choices live-link
 * pass admits any anchor sharing ONE program keyword ('program', 'benefit',
 * 'reimbursement', 'waiver') — the #937 one-shared-word floor — so a site's
 * chrome walked straight into direct results. REGISTRY of measured junk
 * phrases, word-bounded, TITLE identity only (never description prose). A
 * page nobody can apply to is not a grant; classified NOT_A_GRANT so the
 * matches sweep converges the store and the read path hides it.
 */
export const SITE_SECTION_PAGE_PATTERNS = Object.freeze([
  { rx: /\bprogram integrity\b/i, label: 'program_integrity' },
  { rx: /\bpublic notices?\b/i, label: 'public_notices' },
  { rx: /\bstate plan\b/i, label: 'state_plan' },
  { rx: /\breimbursement information\b/i, label: 'reimbursement_information' },
  { rx: /\bbenefits? table\b/i, label: 'benefit_table' },
  { rx: /\bprograms? and facilities\b/i, label: 'programs_and_facilities' },
  { rx: /\bmember handbook\b/i, label: 'member_handbook' },
  // Provider-directed pages: "Information for … Providers" is directed at the
  // program's vendors, never at the member/applicant the profile represents.
  { rx: /\binformation for\b.{0,40}\bproviders\b/i, label: 'provider_directed' },
])

export function isSiteSectionPage(row) {
  if (!row || typeof row !== 'object') return null
  const title = String(row.title ?? '')
  if (!title.trim()) return null
  for (const entry of SITE_SECTION_PAGE_PATTERNS) {
    if (entry.rx.test(title)) return entry.label
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
  // ── A PROGRAM WHOSE OWN NAME SAYS IT ENDED (owner report 2026-08-21) ──
  // "Affordable Connectivity Program (ACP) — Ended May 2024" sat In Progress in
  // a live application queue. Expiry in this product was 100% a function of the
  // `deadline` COLUMN (`opportunityHelpers.isExpiredOpportunity` returns false
  // for a NULL deadline, and `deadlineExpiryService`'s first SQL predicate is
  // `deadline IS NOT NULL`), so a curated row that states its sunset in prose
  // and carries no deadline was structurally unreachable by every expiry net.
  // These patterns read the TITLE, which is the one place the fact was written.
  // Deliberately narrow — each requires an explicit terminal verb, so an
  // ordinary program name ("Ending Homelessness Initiative", "Sunset District
  // Community Fund") never matches.
  { rx: /(?:^|[\s([—–|:-])ended\s+(?:in\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|\d{1,2}\/)?\s*\d{4}\b/i, label: 'title_states_ended' },
  { rx: /\bprogram\s+(?:has\s+)?(?:been\s+)?(?:ended|closed|discontinued|terminated|sunset)\b/i, label: 'title_states_program_closed' },
  { rx: /\bno\s+longer\s+(?:accepting|available|funded|active|offered)\b/i, label: 'title_states_no_longer_accepting' },
  { rx: /\b(?:discontinued|permanently\s+closed)\b/i, label: 'title_states_discontinued' },
])

/**
 * A cycle year at least two years old, with NO future deadline to contradict it.
 *
 * Owner report 2026-08-21: "Community Foundation of Cleveland and Bradley
 * County 2022 …" was queued as an active application. `PROGRAM_YEAR_RX` only
 * matches the literal `PY 2022` allotment spelling, so a bare cycle year in a
 * title was invisible.
 *
 * THREE conditions, all required, because a false positive here REMOVES a real
 * grant from someone's pipeline:
 *   1. the title names a year <= now - 2 (this year and last year are live);
 *   2. that year is not the start of a range reaching into the present
 *      ("2022-2027", "2022–27" — a multi-year program is not stale);
 *   3. the row states NO deadline in the future. A future deadline is the
 *      funder's own statement that the program is open, and it OUTRANKS a year
 *      in a name — "Tennessee HOPE Scholarship (2026-27)" and any renamed-but-
 *      open program survive on this condition alone.
 */
export const STALE_CYCLE_MIN_AGE_YEARS = 2

export function staleCycleYear(row, now = new Date()) {
  if (!row || typeof row !== 'object') return null
  const title = String(row.title ?? '')
  if (!title) return null
  const currentYear = now.getFullYear()

  // Condition 3 first — it is the cheapest and the most authoritative.
  if (row.deadline) {
    const t = Date.parse(row.deadline)
    if (Number.isFinite(t) && t >= now.getTime()) return null
  }
  if (String(row.deadline_type ?? '').toLowerCase() === 'rolling') return null

  // A year that NAMES the fund rather than dating a cycle — an endowment
  // memorialising a graduating class, or a founding date — is not a stale
  // cycle. Narrow, literal phrasings only.
  if (/\b(?:class\s+of|founded(?:\s+in)?|established(?:\s+in)?|est\.?|since|in\s+memory\s+of)\s+(?:the\s+)?20\d{2}\b/i.test(title)) return null

  let stale = null
  const rx = /\b(20\d{2})\b(?:\s*[-–—/]\s*(\d{2,4}))?/g
  let m = rx.exec(title)
  while (m) {
    const year = Number(m[1])
    if (Number.isFinite(year) && year <= currentYear - STALE_CYCLE_MIN_AGE_YEARS) {
      let rangeEnd = null
      if (m[2]) {
        const tail = Number(m[2])
        rangeEnd = m[2].length === 2 ? Number(`${String(year).slice(0, 2)}${m[2]}`) : tail
      }
      if (!(Number.isFinite(rangeEnd) && rangeEnd >= currentYear - 1)) {
        if (stale === null || year < stale) stale = year
      }
    }
    m = rx.exec(title)
  }
  return stale === null ? null : `stale_cycle_year_${stale}`
}

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
  const staleCycle = staleCycleYear(row, now)
  if (staleCycle) return staleCycle
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
  // `||`, NOT `??`: a normalizer that coerces an absent column to '' would stop
  // `??` from ever reaching the second field, so a row carrying ONLY `apply_url`
  // (the crawler-os page-fact field name) lost its apply signal and was routed
  // to "Directories & resources" instead of the direct results the owner reads.
  if (String(row.application_url || row.apply_url || '').trim()) signals.push('apply_url')
  if (row.deadline) signals.push('deadline')
  // EXPLICIT rolling only. Read surfaces fabricate `is_rolling: !deadline`
  // ("no deadline stated" is silence, not a statement of rolling), so that
  // flag would make every signal-less row read as fundable.
  else if (String(row.deadline_type ?? '').toLowerCase() === 'rolling') signals.push('rolling')
  if (String(row.external_id || row.opportunity_number || '').trim()) signals.push('program_id')
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
/**
 * A SEARCH SURFACE names itself (owner report 2026-08-21).
 *
 * These arrived in a student's Application Tracker as leaf APPLICATIONS:
 * "Scholarships.com — Free Scholarship Search", "Fastweb — Room & Board /
 * Housing Scholarships", "Bold.org — No-Essay & Traditional Scholarships",
 * "Going Merry — Apply to Multiple Scholarships", "College Board BigFuture
 * Scholarship Search", "Criminal Justice & Forensics Scholarship Directory",
 * "STEM Scholarship Directory", "Music & Performing Arts Scholarship Finder",
 * "Scholarships Search". You cannot submit an application to a search engine.
 *
 * WHY THE TITLE AND NOT THE HOST: scholarships.com, bold.org, fastweb.com and
 * goingmerry.com all serve INDIVIDUAL award pages that state a real fixed
 * award, and `locatorUrlKind.test.js` pins that distinction deliberately.
 * Classifying those hosts wholesale would retire real awards — the
 * starving-recall end of the locator defect this repo has already documented.
 * The SHAPE of the title is the claim, and it is the claim the owner's rows
 * actually made.
 *
 * The trailing noun must be the SEARCH ITSELF, so "National Merit Scholarship"
 * and "Forensic Science Scholarship" are untouched — they name an award.
 */
export const SEARCH_SURFACE_TITLE_RX =
  /\b(?:scholarships?|grants?|awards?|funding|aid)\b[^|]{0,40}\b(?:search|searches|finder|directory|database|listings?|browse|index)\b|\b(?:search|find|browse)\b[^|]{0,30}\b(?:scholarships?|grants?)\b|\bapply\s+to\s+multiple\b/i

/**
 * AGGREGATOR BRANDS — the scholarship search platforms `pipelineAllowedSources`
 * already lists as vetted REFERRAL sources. Being a good source to INGEST from
 * is not the same as being something you can APPLY to, and the two were being
 * conflated: every one of these arrived as a leaf application.
 *
 * The claim is made only when the brand LEADS the title (`"Bold.org — No-Essay
 * & Traditional Scholarships"`, `"Fastweb — Room & Board / Housing
 * Scholarships"`) or is recorded as the FUNDER (the owner's row "Education
 * Future International Scholarship" carried funder "WeMakeScholars"). That
 * shape is a category page on an aggregator, never an award.
 *
 * An INDIVIDUAL award page hosted on one of these platforms is untouched,
 * because its title is the award's own name — which is exactly the distinction
 * `locatorUrlKind.test.js` protects for scholarships.com.
 */
export const AGGREGATOR_BRANDS = Object.freeze([
  'scholarships.com', 'fastweb', 'bold.org', 'going merry', 'goingmerry',
  'bigfuture', 'college board bigfuture', 'wemakescholars', 'we make scholars',
  'unigo', 'cappex', 'niche.com', 'scholarshipowl', 'scholarship owl',
  'chegg', 'sallie mae', 'salliemae', 'needymeds', 'grantwatch',
])

const AGGREGATOR_BRAND_LEAD_RX = new RegExp(
  `^\\s*(?:${AGGREGATOR_BRANDS.map((b) => b.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|')})\\s*(?:[—–\\-|:]|$)`,
  'i',
)

/** Is this record an aggregator's own category/brand page rather than an award? */
export function aggregatorBrandSurface(row) {
  if (!row || typeof row !== 'object') return null
  const title = String(row.title ?? '').trim()
  if (title && AGGREGATOR_BRAND_LEAD_RX.test(title)) return 'brand_leads_title'
  const funder = String(row.sponsor || row.funder || '').trim().toLowerCase()
  if (funder && AGGREGATOR_BRANDS.includes(funder)) return 'aggregator_is_the_funder'
  return null
}

export const RESOURCE_HUB_TITLES = Object.freeze(new Set([
  'college scorecard',
  'state higher ed agencies',
  'united way worldwide',
]))

/** Known locator/service hosts and titles that cannot be leaf funding awards. */
export const NON_LEAF_HOSTS = Object.freeze([
  'usgrants.org',
  'bergenresourcenet.org',
  'elpasogivingday.org',
])

export const NON_FUNDING_SERVICE_TITLE_RX =
  /\b(?:national\s+)?(?:helpline|hotline)\b|\b(?:2-1-1|211)\b|\bstate health insurance assistance\b|\b(?:discount|savings)\s+(?:program|card)\b/i

export function classifyKnownNonLeaf(row) {
  const hosts = URL_FIELDS.map((field) => hostnameOf(row?.[field])).filter(Boolean)
  const matchedHost = hosts.find((host) =>
    NON_LEAF_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`)) ||
    /(?:^|\.)[^.]*resourcenet\.org$/.test(host) ||
    /(?:^|\.)[^.]*givingday\.org$/.test(host))
  if (matchedHost) {
    if (matchedHost.includes('givingday')) return { bucket: RESULT_BUCKETS.NOT_A_GRANT, reason: `donation_page_host:${matchedHost}` }
    return { bucket: RESULT_BUCKETS.RESOURCE, reason: `directory_host:${matchedHost}` }
  }
  if (NON_FUNDING_SERVICE_TITLE_RX.test(String(row?.title ?? ''))) {
    return { bucket: RESULT_BUCKETS.NOT_A_GRANT, reason: 'non_funding_service_title' }
  }
  return null
}

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
  const siteSection = isSiteSectionPage(row)
  if (siteSection) reasons.push(`site_section:${siteSection}`)
  const expired = isClearlyExpiredProgram(row, now)
  if (expired) reasons.push(`expired:${expired}`)
  if (isAnonymizedFunder(row.sponsor || row.funder)) reasons.push('unresolvable_funder')
  if (reasons.length > 0) {
    return { bucket: RESULT_BUCKETS.NOT_A_GRANT, reasons, stale: Boolean(expired) }
  }

  const stale = isPastDeadline(row, now)
  const knownNonLeaf = classifyKnownNonLeaf(row)
  if (knownNonLeaf) {
    return { bucket: knownNonLeaf.bucket, reasons: [knownNonLeaf.reason], stale }
  }
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
  // A title that names itself a SEARCH / DIRECTORY / FINDER is a discovery
  // surface, whatever kind the crawler stamped on it.
  if (SEARCH_SURFACE_TITLE_RX.test(title)) {
    return { bucket: RESULT_BUCKETS.RESOURCE, reasons: ['search_surface_title'], stale }
  }
  const brandSurface = aggregatorBrandSurface(row)
  if (brandSurface) {
    return { bucket: RESULT_BUCKETS.RESOURCE, reasons: [`aggregator_surface:${brandSurface}`], stale }
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
  // `||` on the sponsor/funder pair: a row whose `sponsor` column is an empty
  // string (not NULL) would stop `??` from ever reading `funder`, so the
  // identity these registries match against silently lost the funder's name.
  const identity = `${row.title ?? ''} ${row.sponsor || row.funder || ''}`
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
  // `||` on the sponsor/funder pair: a row whose `sponsor` column is an empty
  // string (not NULL) would stop `??` from ever reading `funder`, so the
  // identity these registries match against silently lost the funder's name.
  const identity = `${row.title ?? ''} ${row.sponsor || row.funder || ''}`
  if (!identity.trim()) return null
  for (const entry of GOVERNMENT_AGENCY_PROGRAM_PATTERNS) {
    if (entry.rx.test(identity)) return entry.label
  }
  return null
}

/**
 * Federal COMPETITIVE RESEARCH / COOPERATIVE-AGREEMENT / REGULATORY program
 * families whose applicant is ALWAYS an institution (a university, hospital,
 * research org, LEA, tribe, state/local agency) — never an individual PERSON
 * (2026-08-23, owner pipeline-fit audit). Measured on the Demo Tennessee STEM
 * Student profile (a TN forensic-science undergraduate): her pipeline carried Conservation Innovation
 * Grants, "African Medical Devices Regulatory Harmonization Program", six
 * Defense-Health-Agency "DoW"/Peer-Reviewed-Medical research awards, NSF
 * Antarctic Research / "Research on Research Security", DARPA "Decentralized
 * AI…", "Full-Service Community Schools", "Harold Rogers Prescription Drug
 * Monitoring", CDC global-health cooperative agreements, and the Economic
 * Development Administration — all at scores 14-34, admitted because the
 * applicant-type gate is silence-neutral (these web-minted rows carry NULL
 * entity_types_allowed) and the existing agency/pass-through registries name
 * only ~8 program families.
 *
 * Unlike GOVERNMENT_AGENCY_PROGRAM_PATTERNS (agency-ONLY, gated to non-agency
 * roots), an org/nonprofit/university CAN hold most of these — so this class is
 * gated to INDIVIDUAL roots only (a nonprofit is unaffected). Each entry names
 * a REAL federal program family, anchored on program name and/or funding
 * agency, never a bare topic (the CLAUDE.md "never a bare topic" rule). Real
 * individual benefits (Pell, SNAP, HUD counseling, scholarships, individual
 * fellowships) match none of these.
 */
export const INDIVIDUAL_INELIGIBLE_PROGRAM_PATTERNS = Object.freeze([
  { rx: /\bconservation innovation grants?\b|\bnatural resources conservation service\b/i, label: 'Conservation Innovation Grants (NRCS)' },
  { rx: /\bmedical devices?\b.{0,40}\bregulatory harmonization\b/i, label: 'Medical Devices Regulatory Harmonization (FDA institutional)' },
  { rx: /\bfull[-\s]?service community schools\b/i, label: 'Full-Service Community Schools (LEA/institution only)' },
  { rx: /\b(?:congressionally directed|peer[-\s]?reviewed) medical research\b|\bdefense health agency\b|\bdod ?w? (?:peer reviewed|bone marrow|hiv)/i, label: 'DoD Congressionally Directed Medical Research (institutional)' },
  { rx: /\bharold rogers\b.{0,40}\bprescription drug monitoring\b|\bprescription drug monitoring program\b.{0,40}\b(?:grant|bja)/i, label: 'Harold Rogers PDMP (state/agency)' },
  { rx: /\bantarctic research\b|\bu\.?s\.? antarctic program\b/i, label: 'NSF Antarctic Research (institutional)' },
  { rx: /\bresearch on research security\b/i, label: 'NSF Research on Research Security (institutional)' },
  { rx: /\beconomic development administration\b(?!.{0,40}\bplanning\b)/i, label: 'Economic Development Administration (institutional)' },
  { rx: /\bdefense advanced research projects agency\b|\bdarpa\b/i, label: 'DARPA research (institutional)' },
  { rx: /\boffice of naval research\b|\bbroad agency announcement\b/i, label: 'Federal research BAA (institutional)' },
  { rx: /\bglobal health security\b.{0,60}\b(?:cooperative agreement|protect and improve|public health)/i, label: 'CDC Global Health Security cooperative agreement (institutional)' },
  { rx: /\bindian health\b.{0,40}\b(?:outreach and education|national)\b/i, label: 'IHS National Indian Health Outreach (institutional)' },
])

export function individualIneligibleProgramConflict(row) {
  if (!row || typeof row !== 'object') return null
  const identity = `${row.title ?? ''} ${row.sponsor || row.funder || ''}`
  if (!identity.trim()) return null
  for (const entry of INDIVIDUAL_INELIGIBLE_PROGRAM_PATTERNS) {
    if (entry.rx.test(identity)) return entry.label
  }
  return null
}

/**
 * Individual-root tokens (mirrors profileTypeRegistry's person/household roots)
 * so a config-light caller that resolved only `applicantType`/`profileType`
 * still gets the individual-only gates. A business/organization/agency root is
 * deliberately NOT here — those profiles CAN hold institutional programs.
 */
const INDIVIDUAL_ROOT_TYPES = Object.freeze(new Set([
  'individual', 'person', 'family', 'household', 'student', 'college_student',
  'high_school_student', 'graduate_student', 'veteran', 'senior', 'retiree',
  'disabled_adult', 'caregiver', 'military_spouse', 'active_duty',
]))

function resolveIndividualRoot(facts = {}) {
  if (facts.individualRoot === true) return true
  if (facts.individualRoot === false) return false
  const t = String(facts.applicantType ?? facts.profileType ?? '').trim().toLowerCase()
  if (!t) return null // MISSING = NEUTRAL: unknown root never fails a row
  return INDIVIDUAL_ROOT_TYPES.has(t)
}

/**
 * Government-agency roots (the profiles the agency-only registry is neutral
 * about). Kept parallel to INDIVIDUAL_ROOT_TYPES so a config-light caller that
 * resolved only `applicantType`/`profileType` still gets `publicAgencyRoot`
 * derived — the removal path (robertPipelineAudit) passes those, not the
 * boolean, so before this the agency-only gate was dead there.
 */
const PUBLIC_AGENCY_ROOT_TYPES = Object.freeze(new Set([
  'government', 'government_agency', 'public_agency', 'state_agency',
  'local_government', 'municipality', 'county_government', 'tribal_government',
  'federal_agency',
]))

function resolvePublicAgencyRoot(facts = {}) {
  if (facts.publicAgencyRoot === true) return true
  if (facts.publicAgencyRoot === false) return false
  const t = String(facts.applicantType ?? facts.profileType ?? '').trim().toLowerCase()
  if (!t) return null // MISSING = NEUTRAL
  return PUBLIC_AGENCY_ROOT_TYPES.has(t)
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
  // Resolve roots ONCE. A caller that already knows the boolean (matchEngine,
  // via profileTypeRegistry) passes it through unchanged; a config-light caller
  // that resolved only applicantType/profileType (robertPipelineAudit's removal
  // path) now gets the same booleans DERIVED — before this the institutional /
  // agency gates were structurally dead on that path.
  const individualRoot = resolveIndividualRoot(facts)
  const publicAgencyRoot = resolvePublicAgencyRoot(facts)

  const passThrough = institutionalPassThroughConflict(row)
  if (passThrough && individualRoot === true) {
    return {
      eligible: false,
      reason: `institutional_pass_through:${passThrough}`,
      explanation: `${passThrough} funds flow to states, localities, and institutions — an individual cannot apply directly`,
    }
  }
  const individualIneligible = individualIneligibleProgramConflict(row)
  if (individualIneligible && individualRoot === true) {
    return {
      eligible: false,
      reason: `individual_ineligible_program:${individualIneligible}`,
      explanation: `${individualIneligible} is a federal competitive research / cooperative-agreement / regulatory program whose applicant is always an institution — an individual person cannot apply directly`,
    }
  }
  const agencyOnly = agencyOnlyProgramConflict(row)
  if (agencyOnly && publicAgencyRoot === false) {
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
  const persistedState = normalizeState(row?.state)
  const isNational = row?.is_national === true || row?.is_national === 1 ||
    String(row?.is_national ?? '').toLowerCase() === 'true'
  if (persistedState && !isNational && profileStates.length > 0 && !profileStates.includes(persistedState)) {
    return {
      relevant: false,
      reason: `persisted_state_out_of_state:${persistedState}`,
      jurisdiction: { state: persistedState, source: 'persisted_state' },
    }
  }

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
    // site-section / administrative pages (the TennCare nav-page class)
    '%program integrity%',
    '%public notice%',
    '%state plan%',
    '%reimbursement information%',
    '%benefit table%',
    '%benefits table%',
    '%and facilities%',
    '%member handbook%',
    '%information for%providers%',
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

/**
 * SQL LIKE superset for FEDERAL REGISTER provenance. The title superset above
 * cannot find an FR record wearing a benign title (the live class: EPA
 * "Innovation Challenge … Notice of Availability" scored 76 into a pipeline —
 * its only junk evidence is the federalregister.gov URL). One pattern per
 * registered regulatory host + the source-label shape; the JS classifier
 * (`classifyRegulatoryNotice`) adjudicates every candidate, so an FR-hosted
 * record is condemned by the SAME rule the matches net already applies.
 */
export function federalRegisterSourceLikePatterns() {
  const hostPatterns = REGULATORY_SOURCE_HOSTS.map((host) => `%${host}%`)
  return [...hostPatterns, '%federal_register%', '%federal register%']
}

/**
 * Combined boot-net candidate predicate: title superset OR Federal Register
 * provenance (url/source expressions supplied by the caller, lower-cased).
 * Superset only — adjudication stays with the JS classifiers (#944 posture).
 */
export function nonGrantCandidateSqlPredicate({ hayExpr, urlExprs = [], sourceExpr = null }) {
  const title = nonGrantTitleSqlPredicate(hayExpr)
  const clauses = [title.clause]
  const params = [...title.params]
  const frPatterns = federalRegisterSourceLikePatterns()
  for (const expr of urlExprs) {
    for (const pattern of frPatterns) {
      clauses.push(`${expr} LIKE ?`)
      params.push(pattern)
    }
  }
  if (sourceExpr) {
    for (const pattern of frPatterns) {
      clauses.push(`${sourceExpr} LIKE ?`)
      params.push(pattern)
    }
  }
  return { clause: `(${clauses.join(' OR ')})`, params }
}

export default {
  REGULATORY_SOURCE_HOSTS,
  isFederalRegisterSource,
  classifyRegulatoryNotice,
  LEAD_GEN_SCHOLARSHIP_PATTERNS,
  isLeadGenScholarship,
  SITE_SECTION_PAGE_PATTERNS,
  isSiteSectionPage,
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
  INDIVIDUAL_INELIGIBLE_PROGRAM_PATTERNS,
  individualIneligibleProgramConflict,
  passesEligibility,
  isRelevantGeo,
  classifyKnownNonLeaf,
  nonGrantTitleLikePatterns,
  nonGrantTitleSqlPredicate,
}
