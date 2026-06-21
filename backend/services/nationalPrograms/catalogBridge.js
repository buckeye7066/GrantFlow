/**
 * catalogBridge.js
 *
 * Bridges the "national programs" continuous crawler into GrantFlow's canonical
 * funding catalog (`funding_opportunities`).
 *
 * WHY THIS EXISTS
 * ---------------
 * The national-programs crawler historically persisted only into its own
 * `programs_client` / `programs_provider` tables. Those rows never reached the
 * Discover Grants / Funding Opportunities UI (canonical rule G3) and never
 * passed through the single mandatory reality gate + dedupe in
 * `opportunityInserter.js`. As a result the most important catalog-building
 * crawler produced data nobody could see, with no reality enforcement.
 *
 * This module is the single choke point that turns an accepted, real program
 * into an opportunity-shaped row and pushes it through the canonical inserter,
 * which enforces (mission rule #1):
 *   - real http(s) URL + placeholder rejection
 *   - loan / matching-funds rejection
 *   - expired / dead-link rejection
 *   - reality gate classification (kind + trust tier)
 *   - (source, source_id) + cross-source URL dedupe
 *
 * It NEVER fabricates data: a program with no real URL or no real sponsor is
 * dropped (with a logged reason), not patched up.
 */

import crypto from 'crypto'
import { isValidRealUrl } from '../crawlers/opportunityPolicy.js'
import { upsertFundingOpportunity } from '../opportunityInserter.js'

/** Stable cross-run fingerprint so the same program is not re-inserted every 6h. */
export function buildOpportunityFingerprint({ track, sponsor, url, title }) {
  const raw = [
    `track:${String(track || '').trim().toLowerCase()}`,
    `sponsor:${String(sponsor || '').trim().toLowerCase()}`,
    `url:${String(url || '').trim().toLowerCase()}`,
    `title:${String(title || '').trim().toLowerCase()}`,
  ].join('|')
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

function nonEmpty(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

/**
 * Map a normalized national-programs record (the `base` payload produced by
 * normalize.js, plus its track) into the opportunity shape expected by
 * `upsertFundingOpportunity`. Returns null when the record cannot become a real
 * opportunity (caller logs the reason).
 *
 * @returns {{ opportunity: object } | { reject: string }}
 */
export function programToOpportunity({ track, program, agent }) {
  if (!program || typeof program !== 'object') return { reject: 'no_program' }

  const url = nonEmpty(program.source_url)
  if (!url || !isValidRealUrl(url)) {
    return { reject: 'no_real_url' }
  }

  // A funder/sponsor is mandatory — "real sponsors only". Fall back to the
  // administering agency or the agent's declared jurisdiction owner, but never
  // invent one.
  const sponsor =
    nonEmpty(program.administering_agency) ||
    nonEmpty(agent?.administeringAgency) ||
    (program.jurisdiction === 'Federal' ? 'U.S. Federal Government' : null)
  if (!sponsor) {
    return { reject: 'no_sponsor' }
  }

  const title = nonEmpty(program.program_name)
  if (!title || /^unknown program$/i.test(title)) {
    return { reject: 'no_title' }
  }

  const isFederal = String(program.jurisdiction || '').toLowerCase() === 'federal'
  const fingerprint = buildOpportunityFingerprint({ track, sponsor, url, title })

  // Classify loans explicitly so the canonical reality gate rejects them
  // (loans-as-grants are never written to the catalog). We label rather than
  // silently drop, so the gate's reason is logged by the caller.
  const loanSignal = `${title} ${String(program.program_type || '')} ${String(program.covered_services || '')}`.toLowerCase()
  const isLoanType =
    /\bloan\b/.test(loanSignal) &&
    !/\b(loan\s+forgiveness|loan\s+repayment\s+assistance|grant)\b/.test(loanSignal)

  const eligibility = []
  if (nonEmpty(program.eligible_population)) eligibility.push(String(program.eligible_population).trim())

  const opportunity = {
    title,
    sponsor,
    description: nonEmpty(program.covered_services) || null,
    source: 'national_programs_crawler',
    // Stable id => upsert (not duplicate) on every 6h run.
    source_id: fingerprint,
    source_url: url,
    application_url: nonEmpty(program.application_method) && isValidRealUrl(program.application_method)
      ? program.application_method
      : null,
    record_origin: 'live_crawl',
    crawler_version: 'national_programs/1',
    is_national: isFederal,
    state: isFederal ? 'nationwide' : nonEmpty(program.state),
    opportunity_type: isLoanType ? 'loan' : track === 'PROVIDER' ? 'grant' : 'benefit',
    is_loan: isLoanType,
    eligibility_bullets: eligibility,
    categories: [program.program_type].filter(Boolean),
    keywords: [track === 'PROVIDER' ? 'provider' : 'benefit', program.program_type].filter(Boolean),
    // No fabricated verification — the inserter's verification gate owns this.
  }

  return { opportunity }
}

/**
 * Push a single normalized program into the canonical catalog. Reuses the
 * mandatory reality gate + dedupe in upsertFundingOpportunity. Loans, matching
 * funds, placeholders, dead links and expired direct rows are rejected there.
 *
 * @returns {Promise<{ inserted: boolean, skipped?: boolean, reason?: string }>}
 */
export async function bridgeProgramToCatalog({ db, track, program, agent }) {
  const mapped = programToOpportunity({ track, program, agent })
  if (mapped.reject) {
    return { inserted: false, skipped: true, reason: `bridge:${mapped.reject}` }
  }
  const result = await upsertFundingOpportunity(db, mapped.opportunity, {
    // Loans are rejected by default. Expired direct rows rejected by default.
    allowLoans: false,
    allowExpired: false,
  })
  return result
}

export default { bridgeProgramToCatalog, programToOpportunity, buildOpportunityFingerprint }
