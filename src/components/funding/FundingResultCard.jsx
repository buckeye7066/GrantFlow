/**
 * FundingResultCard
 *
 * Phase 5 mission rule: every user-facing result page must use the SAME
 * card component, and every card must show:
 *   - Result type (direct grant, benefit, directory, school portal, referral)
 *   - Match score / confidence
 *   - Why it matched (matched_profile_facts from Phase 2 canonical decision)
 *   - Trust status (verified, broken, unverified) and source trust tier
 *   - Deadline / Amount / Eligibility
 *   - Next action
 *   - Source label
 *
 * The card is a pure presentation component. It accepts a `result` prop in
 * the canonical funding-result shape (see canonicalResultShape() in
 * ./canonicalResultShape.js). The shape is derived from what
 * computeMatchDecision() returns plus
 * the funding_opportunities columns added by Phase 1.
 *
 * Snapshot tests in src/components/funding/FundingResultCard.test.jsx
 * lock the visual contract for every result type.
 */

import React from 'react'
import PropTypes from 'prop-types'
import { humanizeMatchReason } from '@/utils/reasonText'
import { amountTextFallback } from '@/lib/amountDisplay'
import { scoreToMatchLabel } from '@/lib/matchDisplayThresholds'

// canonicalResultShape() lives in ./canonicalResultShape.js so this file
// can stay components-only (Vite Fast Refresh requirement).

const KIND_LABEL = {
  direct: 'Direct grant',
  benefit: 'Benefit / assistance program',
  directory: 'Directory / referral',
  referral: 'Referral',
  school_portal: 'School portal',
}

const TIER_LABEL = {
  official_api: 'Official API source',
  official_portal: 'Official portal',
  verified_directory: 'Verified directory',
  community_directory: 'Community directory',
  open_web: 'Open-web crawl',
  manual_curated: 'Manually curated',
}

const LINK_STATUS_LABEL = {
  verified: 'Link verified',
  unverified: 'Link not yet verified',
  broken: 'Link reported broken',
  redirect: 'Link redirected',
  unreachable: 'Link unreachable',
  // Backend verifier vocabulary (linkVerificationService stores ok/skipped).
  // toCanonicalResult normalizes these, but surfaces that hand a raw row to
  // the card must still render an honest label instead of the raw token.
  ok: 'Link verified',
  skipped: 'Link not yet verified',
}

// Statuses that mean "the verifier proved this link live".
const VERIFIED_LINK_STATUSES = new Set(['verified', 'ok'])

const NEXT_ACTION_LABEL = {
  apply: 'Open application',
  visit: 'Visit source page',
  contact: 'Contact program',
  search_directory: 'Search this directory',
  request_info: 'Request more info',
}

function formatAmount(min, max, description) {
  if (description) return description
  const n = (v) => (v === null || v === undefined ? null : Number(v))
  const lo = n(min)
  const hi = n(max)
  if (lo && hi && lo !== hi) return `$${lo.toLocaleString()} – $${hi.toLocaleString()}`
  if (hi) return `Up to $${hi.toLocaleString()}`
  if (lo) return `From $${lo.toLocaleString()}`
  return null
}

function formatDeadline(deadline, deadlineType) {
  if (!deadline && (deadlineType === 'rolling' || deadlineType === 'ongoing')) {
    return 'Rolling / ongoing'
  }
  if (!deadline) return 'No fixed deadline listed'
  try {
    const d = new Date(deadline)
    if (Number.isNaN(d.valueOf())) return String(deadline)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return String(deadline)
  }
}

// Turn an engine field id ('profile.applicant_type', 'education.highest_level')
// into plain language a first-time applicant can act on. Never shows the raw
// dotted internal path.
function humanizeUnknownField(field) {
  const leaf = String(field || '').split('.').pop() || ''
  const words = leaf.replace(/_/g, ' ').trim()
  if (!words) return 'A profile detail we could not read'
  return `Your ${words} — add it to your profile to confirm eligibility`
}

function pickAction(result) {
  if (result?.next_action) return result.next_action
  const kind = result?.kind || result?.opportunity_kind || 'direct'
  if (kind === 'directory' || kind === 'referral') return 'search_directory'
  if (kind === 'benefit') return 'visit'
  return 'apply'
}

export default function FundingResultCard({ result, onPrimaryAction, onSecondaryAction, className }) {
  if (!result) return null

  const kind = result.kind || result.opportunity_kind || 'direct'
  const tier = result.source_trust_tier || result.trust_tier || 'open_web'
  const linkStatus = result.link_status || 'unverified'
  const score = Number.isFinite(result.match_score) ? Math.round(result.match_score) : null
  const confidence = Number.isFinite(result.match_confidence)
    ? Math.round(result.match_confidence)
    : null
  const facts = Array.isArray(result.matched_profile_facts) ? result.matched_profile_facts : []
  const ineligibility = Array.isArray(result.ineligibility_reasons)
    ? result.ineligibility_reasons
    : []
  const unknownFacts = Array.isArray(result.missing_eligibility_fields)
    ? result.missing_eligibility_fields
    : []
  const hasApplicationUrl = Boolean(result.application_url || result.apply_url)
  const url = result.application_url || result.apply_url || result.source_url || result.url || null
  const action = hasApplicationUrl ? pickAction(result) : 'visit'

  const isBroken = linkStatus === 'broken' || linkStatus === 'unreachable'
  const isDirectory = kind === 'directory' || kind === 'referral'

  // Loan / matching-funds / expired warnings (Mission System 7, RC-15). These
  // caveats must be visible on the card so a user is never misled into treating
  // a loan or an expired deadline as free, currently-open grant money.
  const isLoan = result.is_loan === true || result.is_loan === 1
  const requiresMatch = result.requires_match === true || result.requires_match === 1
  const deadlineType = String(result.deadline_type || '').toLowerCase()
  const isExpired = (() => {
    if (deadlineType === 'rolling' || deadlineType === 'ongoing') return false
    if (!result.deadline) return false
    const d = new Date(result.deadline)
    if (Number.isNaN(d.getTime())) return false
    return d.getTime() < Date.now()
  })()

  return (
    <article
      data-testid="funding-result-card"
      data-kind={kind}
      data-link-status={linkStatus}
      data-trust-tier={tier}
      className={`rounded-xl border bg-white p-4 shadow-sm space-y-3 ${className || ''}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Three small chips that map 1:1 to the onboarding script's
              "opportunity type / source trust / link status" wording.
              Visible label prefixes keep narration aligned with what the
              viewer sees on screen. */}
          <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide">
            <span
              className="rounded bg-slate-100 px-2 py-0.5 text-slate-700"
              title="Opportunity type — direct grant, directory, school portal, or referral resource"
            >
              <span className="text-slate-500 normal-case">Type: </span>
              {KIND_LABEL[kind] ?? 'Opportunity'}
            </span>
            <span
              className="text-slate-600"
              title="Source trust tier — how authoritative the funder is (official API, official portal, verified directory, …)"
            >
              <span className="normal-case text-slate-500">Source trust: </span>
              {TIER_LABEL[tier] ?? tier}
            </span>
            <span
              className={
                isBroken
                  ? 'text-red-600'
                  : VERIFIED_LINK_STATUSES.has(linkStatus)
                    ? 'text-emerald-600'
                    : 'text-amber-600'
              }
              title={
                result.last_verified_at
                  ? `Link status — last checked ${new Date(result.last_verified_at).toLocaleDateString()}`
                  : 'Link status — whether GrantFlow has verified the application URL is live'
              }
            >
              <span className="normal-case text-slate-500">Link status: </span>
              {LINK_STATUS_LABEL[linkStatus] ?? linkStatus}
            </span>
          </div>
          <h3 className="mt-1 text-base font-semibold text-slate-900 truncate">
            {result.title || 'Untitled opportunity'}
          </h3>
          {result.sponsor && (
            <p className="text-sm text-slate-600 truncate">From {result.sponsor}</p>
          )}
        </div>
        {score !== null && (
          <div
            className="text-right"
            data-testid="funding-result-card-score"
            aria-label={`${scoreToMatchLabel(score)}; evidence score ${score}`}
            title={`${scoreToMatchLabel(score)} · evidence score ${score}`}
          >
            <div className="text-sm font-semibold text-slate-900">{scoreToMatchLabel(score)}</div>
            <div className="text-xs text-slate-500">
              evidence score {score}{confidence !== null ? ` · ${confidence}% conf` : ''}
            </div>
          </div>
        )}
      </header>

      {result.description && (
        <p className="text-sm text-slate-700 line-clamp-3">{result.description}</p>
      )}

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Deadline</dt>
          <dd className="text-slate-800">{formatDeadline(result.deadline, result.deadline_type)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Amount</dt>
          <dd className="text-slate-800">
            {formatAmount(result.amount_min, result.amount_max, result.amount_description) ||
              amountTextFallback(result) ||
              'Not stated'}
          </dd>
        </div>
        {result.eligibility_summary && (
          <div className="col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Eligibility
            </dt>
            <dd className="text-slate-800">{result.eligibility_summary}</dd>
          </div>
        )}
      </dl>

      {facts.length > 0 && (
        <section data-testid="funding-result-card-why">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Why this matched
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-slate-700 space-y-0.5">
            {facts.slice(0, 5).map((fact, i) => (
              <li key={i}>{humanizeMatchReason(fact)}</li>
            ))}
          </ul>
        </section>
      )}

      {unknownFacts.length > 0 && (
        <section data-testid="funding-result-card-unknown">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            We couldn&apos;t confirm
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-slate-600 space-y-0.5">
            {unknownFacts.slice(0, 4).map((field, i) => (
              <li key={i}>{humanizeUnknownField(field)}</li>
            ))}
          </ul>
        </section>
      )}

      {ineligibility.length > 0 && (
        <section
          data-testid="funding-result-card-ineligibility"
          className="rounded bg-amber-50 p-2"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
            Possible eligibility concerns
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-900 space-y-0.5">
            {ineligibility.slice(0, 4).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      {result.threshold_relaxed && (
        <p
          data-testid="funding-result-card-relaxed"
          className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800"
        >
          {result.relaxed_reason ||
            'Showing lower-confidence options because no strong matches were found.'}
        </p>
      )}

      {isDirectory && (
        <p className="text-xs text-slate-500">
          This is a {KIND_LABEL[kind].toLowerCase()}, not a direct grant. Use it to find local help
          near you.
        </p>
      )}

      {isBroken && (
        <p
          data-testid="funding-result-card-broken"
          className="rounded bg-red-50 px-2 py-1 text-xs text-red-700"
        >
          We couldn't reach this link recently. The program may still exist — try contacting the
          source directly.
        </p>
      )}

      {isLoan && (
        <p
          data-testid="funding-result-card-loan"
          className="rounded bg-orange-50 px-2 py-1 text-xs text-orange-800"
        >
          ⚠️ This is a loan — it must be repaid. It is not grant money.
        </p>
      )}

      {requiresMatch && (
        <p
          data-testid="funding-result-card-matching-funds"
          className="rounded bg-orange-50 px-2 py-1 text-xs text-orange-800"
        >
          ⚠️ Requires matching funds — you must contribute your own money to qualify.
        </p>
      )}

      {isExpired && (
        <p
          data-testid="funding-result-card-expired"
          className="rounded bg-red-50 px-2 py-1 text-xs text-red-700"
        >
          The deadline for this opportunity appears to have passed.
        </p>
      )}

      <footer className="flex items-center justify-between gap-2 pt-1">
        <div className="text-xs text-slate-500 truncate">
          Source: {result.source || 'unknown'}
        </div>
        <div className="flex items-center gap-2">
          {onSecondaryAction && (
            <button
              type="button"
              className="text-sm text-slate-600 hover:text-slate-900"
              onClick={() => onSecondaryAction(result)}
            >
              Save
            </button>
          )}
          {url && (
            <a
              data-testid="funding-result-card-action"
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={onPrimaryAction ? (e) => onPrimaryAction(e, result) : undefined}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              {NEXT_ACTION_LABEL[action]}
            </a>
          )}
        </div>
      </footer>
    </article>
  )
}

FundingResultCard.propTypes = {
  result: PropTypes.shape({
    id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    title: PropTypes.string,
    sponsor: PropTypes.string,
    description: PropTypes.string,
    application_url: PropTypes.string,
    apply_url: PropTypes.string,
    source_url: PropTypes.string,
    url: PropTypes.string,
    source: PropTypes.string,
    kind: PropTypes.string,
    opportunity_kind: PropTypes.string,
    source_trust_tier: PropTypes.string,
    trust_tier: PropTypes.string,
    link_status: PropTypes.string,
    deadline: PropTypes.string,
    deadline_type: PropTypes.string,
    amount_min: PropTypes.number,
    amount_max: PropTypes.number,
    amount_description: PropTypes.string,
    eligibility_summary: PropTypes.string,
    match_score: PropTypes.number,
    match_decision: PropTypes.string,
    match_confidence: PropTypes.number,
    matched_profile_facts: PropTypes.arrayOf(PropTypes.string),
    ineligibility_reasons: PropTypes.arrayOf(PropTypes.string),
    next_action: PropTypes.string,
    threshold_relaxed: PropTypes.bool,
    relaxed_reason: PropTypes.string,
  }),
  onPrimaryAction: PropTypes.func,
  onSecondaryAction: PropTypes.func,
  className: PropTypes.string,
}
