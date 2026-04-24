/**
 * Shared integration types for Funding APIs.
 *
 * These objects are designed to be compatible with existing DB insertion logic:
 * `backend/services/opportunityInserter.js` (`upsertFundingOpportunity`).
 */

/**
 * @typedef {Object} FundingOpportunity
 * @property {string=} id - Optional dataset ID (NOT the DB primary key).
 * @property {string} title
 * @property {string|null=} sponsor
 * @property {string} source - e.g. "grants.gov", "simpler.grants.gov", "sam.gov", "nih.reporter"
 * @property {string} source_id - Stable ID within the source (string).
 * @property {string|null=} source_url
 * @property {string|null=} application_url
 * @property {string|null=} description
 * @property {number|null=} amount_min
 * @property {number|null=} amount_max
 * @property {string|null=} amount_description
 * @property {string|null=} deadline - ISO date string or source date string (stored as-is).
 * @property {string|null=} deadline_type - e.g. "fixed" | "rolling" | null
 * @property {boolean=} is_national
 * @property {string|null=} state
 * @property {Array<string>=} categories
 * @property {Array<string>=} keywords
 * @property {Array<string>=} eligibility_bullets
 * @property {string=} opportunity_type - e.g. "grant" | "contract" | "award"
 * @property {string=} type - OPPORTUNITY | PROGRAM | DIRECTORY (GrantFlow classification)
 * @property {string|null=} last_verified_at
 * @property {string=} record_origin - e.g. "funding_api"
 * @property {boolean=} requires_501c3
 * @property {boolean=} requires_match
 */

/**
 * @param {unknown} value
 * @returns {string|null}
 */
export function toTrimmedStringOrNull(value) {
  const v = typeof value === 'string' ? value.trim() : (value === null || value === undefined) ? '' : String(value).trim()
  return v ? v : null
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function toNumberOrNull(value) {
  if ((value === null || value === undefined) || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(n) ? n : null
}

