/**
 * reviewerAgent.js — last deterministic quality gate before an opportunity is
 * inserted or updated in `funding_opportunities`.
 *
 * Role (AutoGen Reviewer pattern): reject hallucinated, placeholder, or
 * obviously low-quality records that slipped past the policy + validator.
 *
 * Runs synchronously with zero network / LLM calls so it is cheap enough to
 * invoke on every upsert and reversible (returns a structured reason — never
 * mutates the opportunity).
 *
 * Contract:
 *   reviewOpportunity(opportunity) -> { ok: true, warnings: string[] }
 *                                   | { ok: false, reason: string, warnings: string[] }
 *
 * Every rejection reason is prefixed `reviewer:` so call sites can match the
 * existing `policy:` / `validation:` reason contract in
 * `upsertFundingOpportunity`.
 *
 * Design choices (mission-goals aligned):
 *  - NEVER hard-rejects for missing/null fields — that's the validator's job.
 *  - NEVER rejects on population / geographic mismatch (score concern, not
 *    integrity concern).
 *  - ONLY rejects on evidence the record is fake, broken, or guaranteed
 *    unusable (e.g. placeholder text, firm-deadline-in-past, impossible
 *    amounts, sponsor === title hallucination).
 *  - Directory-style resources always pass (they legitimately lack deadlines).
 */

// ── Placeholder / hallucination patterns ────────────────────────────────────
// Deliberately NARROWER than a naive prefix match. The canonical placeholder
// filter already lives in backend/services/shared/opportunityPolicy.js
// (`PLACEHOLDER_TEXT_PATTERNS` / `isPlaceholderOpportunity`) and runs BEFORE
// the reviewer. Duplicating a loose `^(test|sample|example)\b` match here
// broke the long-standing contract that legitimate titles like
// "Example Opportunity" flow through the inserter (see
// tests/unit/opportunityInserter.test.mjs). The reviewer's job is only to
// reject titles that are *entirely* a placeholder token or obvious LLM
// scaffolding — everything else is policy's or the validator's concern.
const PLACEHOLDER_TITLE_PATTERNS = [
  // Whole-title exact-token placeholders (case-insensitive, whitespace-tolerant).
  /^\s*(test|sample|example|placeholder|untitled|n\/?a|unknown|tbd|todo)\s*$/i,
  // Classic filler phrases that should never appear in a real program title.
  /\blorem ipsum\b/i,
  /\bthis is a (placeholder|sample|test|example)\b/i,
  // Bracket-only or ellipsis-only titles ("[needs title]", "...", "…").
  /^\s*\[[^\]]*\]\s*$/,
  /^\s*\.{2,}\s*$/,
  /^\s*…+\s*$/,
]

const HALLUCINATION_MARKERS = [
  // LLM refusal / apology phrases leaking into content
  /\bas an? (ai|large language model|language model)\b/i,
  /\bi (cannot|can't|am unable to|am not able to)\b.*\b(provide|generate|create)\b/i,
  /\bi'?m sorry\b.*\b(but|however)\b/i,
  // Fake citation patterns commonly produced by hallucination
  /\[citation needed\]/i,
  /\blorem ipsum\b/i,
  // Obvious AI output boilerplate
  /\bthis (is a |was a )?(fictional|hypothetical|made[- ]up) (opportunity|grant|program)\b/i,
]

const SUSPICIOUS_SPONSOR_PATTERNS = [
  /^(various|multiple|n\/?a|unknown|placeholder|anonymous)$/i,
  /^sponsor\s*tbd$/i,
]

// ── Limits ──────────────────────────────────────────────────────────────────
const MIN_TITLE_LEN = 4
const MAX_TITLE_LEN = 500
const MAX_DESCRIPTION_LEN = 100_000
const MAX_PLAUSIBLE_AMOUNT_USD = 100_000_000_000 // $100B — anything higher is a data bug

// A past deadline is only disqualifying when the record declares itself firm.
// Rolling / unknown / ongoing deadlines must never be disqualified here —
// that would violate the "avoid zero-result" mission goal.
const FIRM_DEADLINE_TYPES = new Set(['fixed', 'firm', 'deadline', 'due_date'])

function normStr(v) {
  return typeof v === 'string' ? v.trim() : (v === null || v === undefined) ? '' : String(v).trim()
}

function isDirectoryLike(opportunity) {
  const type = normStr(opportunity?.type).toUpperCase()
  if (type === 'DIRECTORY') return true
  const origin = normStr(opportunity?.record_origin).toLowerCase()
  if (origin.startsWith('directory')) return true
  const cats = Array.isArray(opportunity?.categories) ? opportunity.categories : []
  return cats.some((c) => /^directory\b/i.test(normStr(c)))
}

function parseDateMs(value) {
  if (!value) return null
  // Accept "YYYY-MM-DD" and "YYYY-MM-DDTHH:mm:ssZ"
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/**
 * @param {object} opportunity
 * @returns {{ ok: true, warnings: string[] } | { ok: false, reason: string, warnings: string[] }}
 */
export function reviewOpportunity(opportunity) {
  const warnings = []
  if (!opportunity || typeof opportunity !== 'object') {
    return { ok: false, reason: 'reviewer:missing_opportunity', warnings }
  }

  const title = normStr(opportunity.title)
  const sponsor = normStr(opportunity.sponsor)
  const description = normStr(opportunity.description)

  // 1. Title hygiene — placeholder check first so short tokens like "TBD"
  // produce the specific `placeholder_title` reason rather than the generic
  // `title_too_short` reason (better signal for downstream log triage).
  for (const rx of PLACEHOLDER_TITLE_PATTERNS) {
    if (rx.test(title)) {
      return { ok: false, reason: 'reviewer:placeholder_title', warnings }
    }
  }
  if (title.length < MIN_TITLE_LEN) {
    return { ok: false, reason: 'reviewer:title_too_short', warnings }
  }
  if (title.length > MAX_TITLE_LEN) {
    return { ok: false, reason: 'reviewer:title_too_long', warnings }
  }

  // 2. Hallucination markers anywhere in title/description/sponsor
  const combined = `${title}\n${sponsor}\n${description}`
  for (const rx of HALLUCINATION_MARKERS) {
    if (rx.test(combined)) {
      return { ok: false, reason: 'reviewer:hallucination_marker', warnings }
    }
  }

  // 3. Sponsor hygiene (soft — warning unless obvious placeholder)
  if (sponsor) {
    if (SUSPICIOUS_SPONSOR_PATTERNS.some((rx) => rx.test(sponsor))) {
      return { ok: false, reason: 'reviewer:placeholder_sponsor', warnings }
    }
    // Title === sponsor is a very common LLM hallucination shape. Only reject
    // when they're byte-identical AND the record lacks a description —
    // otherwise treat as a soft warning (NIH RePORTER awards legitimately
    // repeat the IC name in title-like contexts).
    if (sponsor.toLowerCase() === title.toLowerCase() && !description) {
      return { ok: false, reason: 'reviewer:title_equals_sponsor', warnings }
    }
    if (sponsor.toLowerCase() === title.toLowerCase()) {
      warnings.push('title_equals_sponsor')
    }
  }

  // 4. Description sanity (only when present — missing description is legal)
  if (description) {
    if (description.length > MAX_DESCRIPTION_LEN) {
      return { ok: false, reason: 'reviewer:description_too_long', warnings }
    }
    // Single repeated character / empty-looking content
    if (/^(.)\1{10,}$/.test(description)) {
      return { ok: false, reason: 'reviewer:description_degenerate', warnings }
    }
  }

  // 5. Amount realism
  const amountMin = typeof opportunity.amount_min === 'number' ? opportunity.amount_min : null
  const amountMax = typeof opportunity.amount_max === 'number' ? opportunity.amount_max : null
  if ((amountMin !== null && amountMin !== undefined) && amountMin < 0) {
    return { ok: false, reason: 'reviewer:negative_amount_min', warnings }
  }
  if ((amountMax !== null && amountMax !== undefined) && amountMax < 0) {
    return { ok: false, reason: 'reviewer:negative_amount_max', warnings }
  }
  if ((amountMax !== null && amountMax !== undefined) && amountMax > MAX_PLAUSIBLE_AMOUNT_USD) {
    return { ok: false, reason: 'reviewer:implausible_amount_max', warnings }
  }
  if ((amountMin !== null && amountMin !== undefined) && (amountMax !== null && amountMax !== undefined) && amountMin > amountMax) {
    // Swap is plausible (upstream bug); warn but accept so we don't lose recall.
    warnings.push('amount_min_gt_max')
  }

  // 6. Deadline realism — only reject firm deadlines definitively in the past.
  //    Rolling/unknown deadlines must never be excluded.
  if (!isDirectoryLike(opportunity)) {
    const deadlineType = normStr(opportunity.deadline_type).toLowerCase()
    if (FIRM_DEADLINE_TYPES.has(deadlineType)) {
      const deadlineMs = parseDateMs(opportunity.deadline)
      if ((deadlineMs !== null && deadlineMs !== undefined)) {
        const nowMs = Date.now()
        // Allow a 24-hour grace window for same-day deadlines and TZ drift.
        if (deadlineMs + 24 * 60 * 60 * 1000 < nowMs) {
          return { ok: false, reason: 'reviewer:firm_deadline_in_past', warnings }
        }
        // > 100 years in the future is almost certainly a parse error.
        if (deadlineMs - nowMs > 100 * 365 * 24 * 60 * 60 * 1000) {
          warnings.push('deadline_far_future')
        }
      }
    }
  }

  return { ok: true, warnings }
}

export default { reviewOpportunity }
