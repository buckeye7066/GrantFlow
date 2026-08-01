/**
 * portalSync/connectors/studentaid.js
 *
 * REAL connector for the U.S. Department of Education's studentaid.gov — the
 * FAFSA portal. Driven with an already-authenticated Playwright page (the
 * durable storageState captured through the owner's own watched login).
 *
 * WHY THIS EXISTS: studentaid.gov previously fell through to the GENERIC
 * connector, which proves sign-in and scans page text but has no field mapping
 * — a live run on 2026-08-01 signed in successfully and honestly reported
 * "no structured data connector for this portal yet", writing 0 fields. The
 * FAFSA is the single highest-leverage aid record a student has (it gates Pell,
 * Direct Loans, Work-Study, and most state/institutional aid), so it earns a
 * dedicated connector.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * COMPLIANCE POSTURE — read-only, by construction
 * ───────────────────────────────────────────────────────────────────────────
 * Federal student aid is not something an agent may transact on a student's
 * behalf. This connector therefore:
 *   - READS the user's own already-authenticated pages only;
 *   - NEVER stores, reads, or transmits an FSA ID / password (the session is an
 *     opaque encrypted cookie jar; this code never touches credentials);
 *   - NEVER submits, corrects, signs, or renews a FAFSA — `write()` is a HARD
 *     REFUSAL that returns a skip reason, not a no-op that might later be
 *     "improved" into a submitter. This is the deliberate ceiling, not a TODO.
 * (backend/services/college/fafsaStatus.js carries the matching note.)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * EXTRACTION STRATEGY (selector-INDEPENDENT, same rule as the MTSU connector)
 * ───────────────────────────────────────────────────────────────────────────
 * The authenticated studentaid.gov DOM cannot be verified from this
 * environment, and it is a React app whose markup changes without notice. So
 * the PRIMARY path navigates the known authenticated surfaces and delegates to
 * the shared, model-driven `extractPortalDataWithLLM`, then derives FAFSA
 * facts from the page TEXT with deterministic, quote-anchored patterns. No
 * guessed CSS selectors are load-bearing anywhere in this file.
 *
 * Every derived fact must be ANCHORED to a verbatim quote from the page — a
 * pattern that matches nothing yields `notFound`, never a default. The FAFSA
 * stage in particular is never assumed: "we could not read a stage" and "the
 * student has not started" are different facts, and only the page may say
 * which.
 */

import { normalizeHost } from '../../hamiltonCredentialSessionService.js'
import { extractPortalDataWithLLM } from '../llmPageExtract.js'
import { isKnownStage, stageIndex } from '../../../college/fafsaStatus.js'

export const id = 'studentaid'
export const label = 'Federal Student Aid (studentaid.gov — FAFSA)'
export const hostMatch = /(^|\.)studentaid\.gov$|(^|\.)fafsa\.gov$|(^|\.)studentaid\.ed\.gov$/i

// studentaid.gov authenticates through the FSA ID (login.gov-style SSO) with
// 2FA; a saved username/password can never drive it headlessly. Mandating a
// captured session makes runPortalSync fail honestly instead of running an
// unauthenticated pass that reports "completed, 0 awards".
export const requiresSession = true

// Completeness contract (audit #19): this connector may certify a terminal
// `merged` only when its read reports each of these domains complete.
export const supportsFullMerge = true
export const requiredReadDomains = ['fafsa_status', 'aid_summary']

// Authenticated surfaces worth reading. Best-effort: a 404/redirect simply
// yields no text for that page and the extractor reads whatever we landed on.
const NAV = [
  'https://studentaid.gov/fsa-id/sign-in/landing',
  'https://studentaid.gov/h/apply-for-aid/fafsa',
  'https://studentaid.gov/aid-summary/',
  'https://studentaid.gov/fafsa-apply/status',
]

// ── Deterministic, quote-anchored FAFSA facts ────────────────────────────────
// Each rule maps a phrase the portal actually renders to a canonical lifecycle
// stage. Ordered MOST-ADVANCED FIRST: a page showing "Verification requested"
// also says "Submitted", and the furthest stage the page evidences is the true
// one. Every rule keeps the matched text as evidence.
//
// EVERY PATTERN MUST BE USER-RECORD PHRASING, NEVER NAVIGATION OR CTA COPY.
// This rule is written in blood: the first version matched
// /\bfafsa\b[^.]{0,60}\b(complete|completed)\b/, and studentaid.gov's own
// persistent nav ("… Loans and Grants  FAFSA Form  Complete Aid Application
// …") satisfied it. The first live run (2026-08-01, run 6b5a26fd) therefore
// advanced a real student's lifecycle to `complete` — the terminal "no further
// FAFSA action needed" — off a menu label, on a page that showed no SAI, no
// Pell statement and no aid. A CTA telling you to DO a thing is evidence you
// have NOT done it; only the student's own record may move the stage.
//
// So each pattern requires a possessive ("your FAFSA…"), a status label
// ("Status: In Progress"), a date ("submitted on …"), or another phrase that
// cannot appear as a menu item. `fsa_id_created` was REMOVED outright: "Your
// FSA ID" is nav copy on every signed-in page and no honest user-record
// phrasing distinguishes it.
const STAGE_RULES = Object.freeze([
  {
    stage: 'complete',
    re: /\byour fafsa (form )?is complete\b|\bfafsa (form )?status:?\s*complete\b|\byour fafsa (form )?(has been|was) completed\b/i,
  },
  {
    stage: 'verification',
    re: /\b(you (were|have been) |your fafsa (form )?(was|has been) )?selected for verification\b|\bverification (is )?(required|requested)\b|\bwe need more information to verify\b/i,
  },
  {
    stage: 'school_received',
    re: /\bsent to your school\b|\byour (fafsa )?(form |information )?was sent to\b|\byour school(s)? (have |has )?received\b/i,
  },
  {
    stage: 'processed',
    // The SAI is a printed FIGURE on the student's own summary — a nav item
    // never carries one. "Submission Summary" alone is a menu link, so it must
    // be possessive to count.
    re: /\bstudent aid index\b[^0-9-]{0,40}-?\$?\s?-?[\d,]+|\byour sai\b|\byour fafsa submission summary\b|\byour fafsa (form )?(was|has been) processed\b/i,
  },
  {
    stage: 'submitted',
    re: /\bsubmitted on\b|\byour fafsa (form )?(was|has been) submitted\b|\byour (fafsa )?application (was|has been) received\b/i,
  },
  {
    stage: 'in_progress',
    re: /\b(fafsa (form )?)?status:?\s*in progress\b|\byour fafsa (form )?is in progress\b|\byou have (an? )?(fafsa )?(form )?in progress\b|\byour (fafsa )?(form )?(is )?not yet submitted\b/i,
  },
  {
    stage: 'not_started',
    re: /\bno fafsa (form )?on file\b|\byou have(n'?t| not) started\b|\byou have no (fafsa|application)s? (form )?(on file|started)\b/i,
  },
])

// The Student Aid Index (SAI, formerly EFC) as printed on the submission
// summary. Negative values are real (down to -1500), so the sign is captured.
const SAI_RE = /\b(?:student aid index|sai|expected family contribution|efc)\b[^0-9-]{0,40}(-?\$?\s?-?[\d,]+)/i

// Pell eligibility as STATED — never inferred from an SAI number, because the
// federal formula also depends on enrollment intensity and cost of attendance.
const PELL_YES_RE = /\b(eligible for|you (may )?qualify for|awarded)\b[^.]{0,40}\bpell grant\b|\bpell grant\b[^.]{0,30}\beligib(le|ility): ?yes\b/i
const PELL_NO_RE = /\bnot eligible\b[^.]{0,40}\bpell grant\b|\bpell grant\b[^.]{0,30}\bnot eligible\b/i

/** First rule whose pattern hits, with the matched text kept as evidence. */
export function deriveFafsaStage(text) {
  const hay = String(text || '')
  if (!hay.trim()) return null
  for (const rule of STAGE_RULES) {
    const m = hay.match(rule.re)
    if (m) return { stage: rule.stage, evidence: String(m[0]).trim().slice(0, 200) }
  }
  return null
}

/** Parse the SAI/EFC figure with its sign; null when not printed. */
export function deriveSai(text) {
  const m = String(text || '').match(SAI_RE)
  if (!m) return null
  const cleaned = String(m[1]).replace(/[\s$]/g, '')
  const n = Number(cleaned.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  return { value: n, evidence: String(m[0]).trim().slice(0, 200) }
}

/** Pell eligibility ONLY when the page states it. Never derived from the SAI. */
export function derivePellEligibility(text) {
  const hay = String(text || '')
  const no = hay.match(PELL_NO_RE)
  if (no) return { eligible: false, evidence: String(no[0]).trim().slice(0, 200) }
  const yes = hay.match(PELL_YES_RE)
  if (yes) return { eligible: true, evidence: String(yes[0]).trim().slice(0, 200) }
  return null
}

/**
 * The `education.efc_sai_band` field is TEXT and is consumed as a coarse band
 * elsewhere, so we store a human-readable band plus the exact figure rather
 * than a bare number (which would read as dollars of aid to anyone glancing).
 */
export function saiBand(value) {
  if (!Number.isFinite(value)) return null
  if (value < 0) return `SAI ${value} (negative — maximum need)`
  if (value === 0) return 'SAI 0 (maximum need)'
  if (value <= 3000) return `SAI ${value} (very high need)`
  if (value <= 7000) return `SAI ${value} (high need)`
  if (value <= 15000) return `SAI ${value} (moderate need)`
  return `SAI ${value} (lower need)`
}

async function gotoQuiet(page, url, log) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {})
    log?.(`navigated to ${url}`)
    return true
  } catch (err) {
    log?.(`navigation failed: ${url}`, { error: err?.message })
    return false
  }
}

async function readText(page) {
  try {
    const snap = await page.evaluate(() => ({ text: document.body?.innerText || '', title: document.title || '' }))
    if (typeof snap === 'string') return { text: snap, title: '' }
    return { text: String(snap?.text || ''), title: String(snap?.title || '') }
  } catch {
    return { text: '', title: '' }
  }
}

function safeUrl(page) {
  try { return page.url() } catch { return null }
}

/**
 * READ: the FAFSA lifecycle stage, the SAI, stated Pell eligibility, and any
 * federal aid actually offered to this user (Pell / Direct Loans / Work-Study).
 *
 * Returns the standard PortalReadResult plus:
 *   - `fafsaStatus`: { stage, evidence } — applied by the orchestrator through
 *     the CANONICAL lifecycle owner (setFafsaStage), so history and the derived
 *     `fafsa_completed` boolean stay consistent. Never written as a raw field.
 *   - `domains`: completeness certification for the merge contract.
 */
export async function read(page, ctx = {}) {
  const log = ctx.log || (() => {})
  const fields = []
  const awards = []
  const notFound = []
  const raw = { pages: [], llm: null, derived: {} }

  // 1) Gather text from the authenticated FAFSA surfaces.
  let corpus = ''
  for (const url of NAV) {
    const ok = await gotoQuiet(page, url, log)
    if (!ok) continue
    const snap = await readText(page)
    if (!snap.text.trim()) continue
    raw.pages.push({ url, title: snap.title, chars: snap.text.length })
    corpus += `\n\n### ${url}\n${snap.text}`
  }
  if (!corpus.trim()) {
    const snap = await readText(page)
    if (snap.text.trim()) {
      raw.pages.push({ url: safeUrl(page), title: snap.title, chars: snap.text.length })
      corpus = snap.text
    }
  }

  if (!corpus.trim()) {
    notFound.push({ kind: 'status', name: 'fafsa', reason: 'no readable text on any authenticated studentaid.gov page (session may be dead, or the SPA did not render)' })
    return {
      fields, awards, notFound, raw,
      fafsaStatus: null,
      domains: { fafsa_status: { complete: false }, aid_summary: { complete: false } },
    }
  }

  // 2) Deterministic, quote-anchored derivations.
  const stage = deriveFafsaStage(corpus)
  const sai = deriveSai(corpus)
  const pell = derivePellEligibility(corpus)
  raw.derived = { stage, sai, pell }

  if (stage) {
    log(`studentaid: FAFSA stage "${stage.stage}" evidenced by "${stage.evidence}"`)
  } else {
    // "Cannot read" is NOT "not started" — never default a lifecycle stage.
    notFound.push({ kind: 'status', name: 'fafsa_stage', reason: 'no FAFSA stage phrase found in the page text — stage left unchanged (never defaulted to not_started)' })
  }

  if (sai) {
    const band = saiBand(sai.value)
    if (band) fields.push({ sectionKey: 'education', field: 'efc_sai_band', value: band, label: 'Student Aid Index', source: 'studentaid:sai' })
  } else {
    notFound.push({ kind: 'field', name: 'efc_sai_band', reason: 'no Student Aid Index / EFC figure printed on the pages read' })
  }

  if (pell) {
    fields.push({ sectionKey: 'education', field: 'pell_grant_eligible', value: pell.eligible, label: 'Pell Grant eligible', source: 'studentaid:pell' })
  } else {
    notFound.push({ kind: 'field', name: 'pell_grant_eligible', reason: 'page did not state Pell eligibility (never inferred from the SAI — the federal formula also depends on enrollment intensity and cost of attendance)' })
  }

  // 3) Federal aid actually OFFERED to this user, via the shared extractor +
  //    its fabrication guard (which rejects anything without user-specific
  //    award evidence — e.g. the generic "types of aid" explainer pages).
  const llm = await extractPortalDataWithLLM(page, { log, navCandidates: NAV })
  raw.llm = llm.raw
  const rejected = Array.isArray(llm.rejected) ? llm.rejected : []
  for (const a of llm.awards || []) {
    awards.push({
      title: a.title,
      amount: a.amount,
      amountDisplay: a.amountDisplay || null,
      status: a.status || null,
      sponsor: a.sponsor || 'U.S. Department of Education',
      sourceUrl: a.sourceUrl || safeUrl(page),
    })
  }
  for (const f of llm.fields || []) {
    // Only accept model fields we did not already derive deterministically —
    // a quote-anchored local derivation always wins over an extraction.
    if (fields.some((x) => x.sectionKey === f.sectionKey && x.field === f.field)) continue
    fields.push(f)
  }
  for (const reason of llm.notFound || []) notFound.push({ kind: 'llm', name: 'extraction', reason })

  // 4) Completeness certification. A domain is complete only when we actually
  //    read the fact — never merely because the run finished.
  const domains = {
    fafsa_status: { complete: Boolean(stage), evidence: stage?.evidence || null },
    aid_summary: { complete: Boolean(sai) || awards.length > 0, awards: awards.length },
  }

  log(`studentaid read complete: ${fields.length} fields, ${awards.length} awards (${rejected.length} rejected), ${notFound.length} notFound`)
  return {
    fields,
    awards,
    notFound,
    rejected,
    raw,
    fafsaStatus: stage ? { stage: stage.stage, evidence: stage.evidence } : null,
    domains,
  }
}

/**
 * WRITE: refused, permanently and by design.
 *
 * Submitting, correcting, or signing a FAFSA is a federal filing the student
 * (and, for a dependent student, a parent) must make personally. An agent
 * filling that form — even "staged, not submitted" as the MTSU connector does
 * for an outside-scholarship report — is not a capability this product should
 * hold. The refusal is the contract: it returns an honest skip so the run
 * summary states plainly that nothing was pushed.
 */
export async function write(page, ctx = {}, data = {}) {
  const log = ctx.log || (() => {})
  log('studentaid: write refused by design (federal aid filings are never agent-submitted)')
  return {
    written: [],
    skipped: [{
      target: 'fafsa',
      reason: 'refused_by_design: GrantFlow never fills, corrects, signs, or submits a FAFSA. Federal aid filings must be made by the student (and parent, if dependent) at studentaid.gov. This connector is read-only.',
    }],
  }
}

// An FSA-ID login can be stored under a login.gov/ED SSO host; claim it when the
// account or label points at federal student aid.
const FSA_LABEL_RE = /\b(fafsa|fsa id|federal student aid|studentaid)\b/i

/** @param {{ host?:string, username?:string, label?:string }} ctx */
export function matchesCredential({ host, username = null, label = null } = {}) {
  const h = normalizeHost(host)
  if (h && hostMatch.test(h)) return true
  return FSA_LABEL_RE.test(`${username || ''} ${label || ''}`)
}

export function matchesHost(host) {
  const h = normalizeHost(host)
  return !!h && hostMatch.test(h)
}

/**
 * Monotonic stage guard, exported for the orchestrator and tests: a portal read
 * may ADVANCE the FAFSA lifecycle but never silently REGRESS it. studentaid.gov
 * renders stale banners ("Submitted on …") alongside newer state, and a
 * regression would erase verification progress the student already recorded.
 * Returns true only when `next` is strictly further along than `current`.
 */
export function stageAdvances(current, next) {
  if (!isKnownStage(next)) return false
  if (!isKnownStage(current)) return true
  return stageIndex(next) > stageIndex(current)
}

/** @type {import('../types.js').PortalConnector} */
const connector = {
  id, label, hostMatch, requiresSession, supportsFullMerge, requiredReadDomains,
  matchesCredential, read, write,
}

export default connector
